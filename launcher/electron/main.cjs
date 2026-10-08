// gpt-web-port 桌面應用主程式（參考 miuuyy/codex-chatgpt-web 的 launcher 概念，最小化）。
// - 內含瀏覽器（Electron persistent partition），免裝系統 Chrome、免 Python。
// - 左邊控制面板，右邊內嵌 ChatGPT 登入頁（同一個 partition，登入態共用）。
// - 自動化（丟資料/接回傳）直接驅動內嵌頁面，不開外部瀏覽器。
// - 照樣開 HTTP（POST /chat、OpenAI 相容），舊腳本不用改。
const { app, BrowserWindow, WebContentsView, ipcMain, session, nativeTheme, Tray, Menu, nativeImage } = require("electron");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const auto = require("./automation.cjs");

const WORKSPACE_ROOT = path.resolve(__dirname, "..", "..");
const PARTITION = "persist:gpt-web-port";
const PANEL_WIDTH = 420;

const PROVIDER_URLS = {
  chatgpt: () => currentChatUrl(),
  gemini: () => "https://gemini.google.com/",
  deepseek: () => "https://chat.deepseek.com/",
};
let activeProvider = "chatgpt";

const HOST = (process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787) || 8787;
const API_KEY = (process.env.API_KEY || "").trim();
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 300000) || 300000;
// 送出確認相關閾值：Enter 後等送出證據；送出後等開始產生；產生中指示燈亮卻零文字的最大容忍。
const SUBMIT_GRACE_MS = 8000;
const ACCEPT_TIMEOUT_MS = 45000;
const STALL_EMPTY_MS = 60000;

// 合而為一：8787 收到直連系模型轉給 Python 8765（單向；webchat/gpt 留本地，
// 避免與 8765 的通用兜底互轉迴圈）。8765 那側的反向（ChatGPT->Electron）
// 由 server/bridge/transport.py 負責。
const PYTHON_BRIDGE_URL = (process.env.PYTHON_BRIDGE_URL || "").trim()
  || `http://127.0.0.1:${(process.env.W2L_PORT || "8765").trim() || "8765"}`;

function shouldForwardToPython(model) {
  const m = String(model || "").trim().toLowerCase();
  return m.startsWith("gemini-") || m.startsWith("deepseek");
}

async function forwardToPythonBridge(req, res, body) {
  const ctrl = new AbortController();
  req.on("close", () => ctrl.abort());
  try {
    const r = await fetch(`${PYTHON_BRIDGE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const ct = r.headers.get("content-type") || "application/json";
    if (ct.includes("text/event-stream")) {
      res.writeHead(r.status, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
        "access-control-allow-origin": "*",
      });
      const reader = r.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } catch {}
      try { res.end(); } catch {}
      return;
    }
    const text = await r.text();
    res.writeHead(r.status, {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "content-length": Buffer.byteLength(text),
    });
    res.end(text);
  } catch (e) {
    return sendJson(res, { error: { message: `Python 直連橋（${PYTHON_BRIDGE_URL}）連線失敗：${(e && e.message) || e}。請確認 8765 有啟動且 Token/Cookie 已設定。`, type: "server_error" } }, 502);
  }
}

// 內嵌 ChatGPT 頁跟系統外觀走：宣告深色，頁面即為暗色（ChatGPT 外觀須為「系統」）
nativeTheme.themeSource = "dark";
// Windows 工作列分組：沒有 AppUserModelId 會跟 Electron 預設混在一起、圖示錯亂。
try { if (process.platform === "win32") app.setAppUserModelId("dev.modeldock.app"); } catch {}

let mainWin = null;
let panelView = null;
// 三供應商各一個常駐 WebContentsView：切換只做 show/hide，不再每次 loadURL（解決切換卡頓）。
// ChatGPT 負責問答自動化；Gemini/DeepSeek 負責登入態 + Cookie/Token 擷取。
let chatViews = {}; // provider -> WebContentsView
let chatReadyMap = {}; // provider -> Promise
let chatView = null; // 指向當前 active provider 的 view（相容舊變數名）
let loginVisible = true;
// 對話紀錄模式：true = 無痕 temporary-chat（預設，不留紀錄）；false = 一般（保留紀錄）
let temporaryChat = process.env.TEMPORARY_CHAT !== "0";
function currentChatUrl() {
  return temporaryChat ? auto.CHAT_URL : "https://chatgpt.com/";
}

// ---------- 全自動本地憑證擷取（免擴充套件核心） ----------
// 打包版 __dirname 在 resources/app 內，寫檔路徑跟 Python 8765 讀的源碼目錄
// 會錯開，所以抓到後除了寫檔，還會直推一份給 8765（免重啟、免對路徑）。
function pushToPythonBridge(apiPath, payload) {
  // fire-and-forget：8765 沒開就跳過，不擋主流程。
  try {
    fetch(`http://127.0.0.1:8765${apiPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      if (r.ok) console.log(`[modeldock] 已直推憑證到 8765 ${apiPath}`);
      else console.log(`[modeldock] 直推 8765 ${apiPath} 失敗: HTTP ${r.status}`);
    }).catch(() => {});
  } catch {}
}

async function harvestGeminiCookies() {
  try {
    const ses = session.fromPartition(PARTITION);
    const cookies = await ses.cookies.get({ domain: ".google.com" });
    let psid = "";
    let psidts = "";
    for (const c of cookies) {
      if (c.name === "__Secure-1PSID") psid = c.value;
      if (c.name === "__Secure-1PSIDTS") psidts = c.value;
    }
    if (psid) {
      const targetFile = path.join(WORKSPACE_ROOT, "gemini_cookies.json");
      let current = {};
      try { if (fs.existsSync(targetFile)) current = JSON.parse(fs.readFileSync(targetFile, "utf-8")); } catch {}
      if (current["1psid"] !== psid || current["1psidts"] !== psidts) {
        fs.writeFileSync(targetFile, JSON.stringify({ "1psid": psid, "1psidts": psidts }, null, 2), "utf-8");
        console.log("[modeldock] 自動同步 gemini_cookies.json 成功！");
      }
      pushToPythonBridge("/v1/cookies", { "1psid": psid, "1psidts": psidts, source: "modeldock-auto" });
      return { ok: true, synced: true, psid: !!psid, psidts: !!psidts };
    }
  } catch (err) {
    console.error("[modeldock] 擷取 Gemini Cookie 錯誤:", err);
  }
  return { ok: false };
}

async function ensureBackgroundProviderView(provider) {
  // 背景常駐：沒建就建，沒載入就在背景載入，不動 activeProvider / 版面。
  // 讓縮到托盤、停在別的分頁時也能抓到憑證。
  try {
    const view = ensureProviderView(provider);
    if (!view) return null;
    const cur = view.webContents.getURL() || "";
    if (!cur || cur === "about:blank") {
      try {
        const want = PROVIDER_URLS[provider] ? PROVIDER_URLS[provider]() : "";
        if (want) view.webContents.loadURL(want).catch(() => {});
      } catch {}
    }
    return view;
  } catch {
    return null;
  }
}

async function harvestDeepSeekToken() {
  try {
    // 改為背景常駐抓取：不在該頁籤、縮到托盤也要能抓。
    // chatViews.deepseek 沒建過就先在背景建+載入，本輪先 warm-up，下一輪interval再讀。
    let dsView = chatViews.deepseek || (activeProvider === "deepseek" ? chatView : null);
    if (!dsView) {
      dsView = await ensureBackgroundProviderView("deepseek");
      if (!dsView) return { ok: false };
    }
    const url = dsView.webContents.getURL() || "";
    if (!url.includes("deepseek.com")) {
      // 背景暖機：觸發載入但不切換右側顯示，下一次 harvest 再讀 token。
      try {
        if (!url || url === "about:blank") {
          dsView.webContents.loadURL("https://chat.deepseek.com/").catch(() => {});
        }
      } catch {}
      return { ok: false, warming: true };
    }
    if (url.includes("deepseek.com")) {
      const token = await runJS(dsView, `(function(){
        try {
          const raw = localStorage.getItem("userToken");
          if (!raw) return null;
          const parsed = JSON.parse(raw);
          return (parsed && parsed.value) || raw;
        } catch(e) {
          return localStorage.getItem("userToken");
        }
      })()`);
      if (token && typeof token === "string" && token.length > 10) {
        const targetFile = path.join(WORKSPACE_ROOT, "deepseek_token.json");
        let prev = "";
        try { prev = JSON.parse(fs.readFileSync(targetFile, "utf-8")).token || ""; } catch {}
        if (prev !== token) {
          try {
            fs.writeFileSync(targetFile, JSON.stringify({ "token": token }, null, 2), "utf-8");
            console.log("[modeldock] 自動同步 deepseek_token.json 成功！");
          } catch (e) {
            // 打包版寫 resources 內可能失敗也沒關係，直推 8765 才是重點。
            console.log("[modeldock] 寫檔失敗，改直推 8765:", String((e && e.message) || e));
          }
        }
        // 關鍵：不管寫檔成功與否都直推給 Python 8765（路徑錯開也不怕）。
        pushToPythonBridge("/v1/deepseek/token", { token });
        return { ok: true, synced: true };
      } else {
        console.log("[modeldock] DeepSeek 背景頁已載入但讀不到 userToken（可能還沒登入或還在載入）:", url);
      }
    }
  } catch (err) {
    console.error("[modeldock] 擷取 DeepSeek Token 錯誤:", err);
  }
  return { ok: false };
}

async function harvestAllCredentials() {
  await harvestGeminiCookies();
  await harvestDeepSeekToken();
}
let queue = Promise.resolve();
let tray = null;
let quitting = false; // 只有從托盤選單「結束」或 CmdQ 才真正退出
let hideNotified = false;

// 同一個應用只跑一份：重複啟動時把舊視窗叫出來，避免 PORT 衝突。
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
}

function showMainWindow() {
  if (!mainWin) return;
  if (!mainWin.isVisible()) mainWin.show();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.focus();
}

function windowIconPath() {
  // Windows 工作列/捷徑必須吃 .ico，否則會退回 Electron 預設圖。
  // build/icon.ico 由 electron-builder 打包（files 含 build/**），dev 模式則退回 tray.png。
  const ico = path.join(__dirname, "..", "build", "icon.ico");
  const png = path.join(__dirname, "tray.png");
  try { if (process.platform === "win32" && fs.existsSync(ico)) return ico; } catch {}
  return png;
}

function createTray() {
  if (tray) return;
  try {
    let icon = nativeImage.createFromPath(path.join(__dirname, "tray.png"));
    if (!icon.isEmpty() && process.platform === "win32") {
      // Windows tray 建議 16x16；32px 原圖直接塞會糊或被縮放異常。
      try { icon = icon.resize({ width: 16, height: 16, quality: "best" }); } catch {}
    }
    tray = new Tray(icon.isEmpty() ? windowIconPath() : icon);
  } catch {
    return; // 沒有圖示就不建托盤，不影響主流程
  }
  tray.setToolTip("ModelDock（HTTP 服務中，關閉視窗會收到托盤繼續跑）");
  const menu = Menu.buildFromTemplate([
    { label: "開啟 ModelDock", click: () => showMainWindow() },
    { type: "separator" },
    {
      label: "結束", click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.on("click", () => {
    if (mainWin && mainWin.isVisible()) mainWin.hide();
    else showMainWindow();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runJS(view, js) {
  return view.webContents.executeJavaScript(js, true).catch(() => null);
}

function activeChatView() {
  return chatView || chatViews[activeProvider] || null;
}

function layoutViews() {
  if (!mainWin || !panelView) return;
  const active = activeChatView();
  if (!active) return;
  const { width, height } = mainWin.getContentBounds();
  if (loginVisible) {
    const pw = Math.min(PANEL_WIDTH, width);
    panelView.setBounds({ x: 0, y: 0, width: pw, height });
    panelView.setVisible(true);
    // 只有 active 的 browser view 佔右側，其餘完全隱藏（不觸發重排/重載）。
    for (const [name, view] of Object.entries(chatViews)) {
      if (name === activeProvider) {
        view.setBounds({ x: pw, y: 0, width: Math.max(0, width - pw), height });
        view.setVisible(true);
      } else {
        view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
        view.setVisible(false);
      }
    }
  } else {
    panelView.setBounds({ x: 0, y: 0, width, height });
    panelView.setVisible(true);
    for (const view of Object.values(chatViews)) {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
      view.setVisible(false);
    }
  }
}

function ensureProviderView(provider) {
  // 已建立就直接回傳（不重建、不重載）；呼叫端只在「從未載入」時 loadURL。
  if (chatViews[provider]) return chatViews[provider];
  const view = new WebContentsView({
    webPreferences: { partition: PARTITION },
  });
  if (provider === "chatgpt") view.setBackgroundColor("#212121");
  mainWin.contentView.addChildView(view);
  chatReadyMap[provider] = new Promise((resolve) => {
    view.webContents.once("did-finish-load", () => resolve());
  });
  view.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
  view.webContents.on("did-finish-load", () => { harvestAllCredentials(); });
  // 掛載後立刻隱藏，交給 layoutViews 決定是否顯示（避免閃爍）。
  view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
  view.setVisible(false);
  chatViews[provider] = view;
  return view;
}

async function ensureChatLoaded() {
  const gptView = chatViews.chatgpt || activeChatView();
  if (!gptView) return false;
  const url = gptView.webContents.getURL();
  if (!/^https:\/\/chatgpt\.com\//.test(url)) {
    gptView.webContents.loadURL(currentChatUrl());
    await chatReadyMap.chatgpt;
  }
  // 等 composer 出現（最多 60 秒）
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ok = await runJS(gptView, auto.probeComposerJS());
    if (ok) return true;
    await sleep(500);
  }
  // 超時：印出診斷（哪個 selector 命中、可見輸入框數），方便判斷是改版還是真未載入
  try {
    const detail = await runJS(gptView, auto.findComposerJS());
    console.log("[modeldock] composer 探測超時，診斷:", JSON.stringify(detail));
  } catch {}
  return false;
}

async function checkLogin() {
  try {
    await harvestAllCredentials();
    const gptView = chatViews.chatgpt || null;
    const url = activeChatView() ? activeChatView().webContents.getURL() : "";
    let composer = false;
    let sessionAuth = null;
    // ChatGPT 登入態只看 chatgpt view（即使右側正顯示 Gemini/DeepSeek 也不受影響）。
    // composer 出現即視為可用：已登入是一般/無痕對話，未登入 session 則是訪客模式（也可送）。
    if (gptView) {
      try {
        const gUrl = gptView.webContents.getURL() || "";
        if (/^https:\/\/chatgpt\.com\//.test(gUrl)) {
          composer = (await runJS(gptView, auto.probeComposerJS())) === true;
          sessionAuth = await runJS(gptView, auto.checkAuthSessionJS());
        }
      } catch {}
    }

    const geminiPath = path.join(WORKSPACE_ROOT, "gemini_cookies.json");
    let hasGemini = false;
    try {
      if (fs.existsSync(geminiPath)) {
        const g = JSON.parse(fs.readFileSync(geminiPath, "utf-8"));
        hasGemini = Boolean(g["1psid"]);
      }
    } catch {}

    const dsPath = path.join(WORKSPACE_ROOT, "deepseek_token.json");
    let hasDeepSeek = false;
    try {
      if (fs.existsSync(dsPath)) {
        const d = JSON.parse(fs.readFileSync(dsPath, "utf-8"));
        hasDeepSeek = Boolean(d.token || d.userToken);
      }
    } catch {}

    return {
      loggedIn: composer === true,
      chatgpt: composer === true,
      gemini: hasGemini,
      deepseek: hasDeepSeek,
      activeProvider,
      url,
      sessionAuth,
      loginVisible,
      temporaryChat,
    };
  } catch (e) {
    return { loggedIn: false, url: "", error: String((e && e.message) || e) };
  }
}

async function askOnce(prompt, options = {}) {
  const startedAt = Date.now();
  const signal = options.signal;
  // 問答永遠走 chatgpt 常駐 view，不受右側正在看哪一頁影響。
  const gptView = chatViews.chatgpt || activeChatView();
  if (!gptView) throw new Error("瀏覽器尚未就緒。");
  await ensureChatLoaded();

  const inChat = /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]+/i.test(gptView.webContents.getURL() || "");
  if (!(options.continueConversation === true && inChat)) {
    // 已在 temporary/normal 首頁就不再重載（避免每次問答都整頁 reload 卡頓）。
    const cur = gptView.webContents.getURL() || "";
    const want = currentChatUrl();
    const samePage = (temporaryChat && cur.startsWith("https://chatgpt.com/?temporary-chat"))
      || (!temporaryChat && (cur === "https://chatgpt.com/" || cur.startsWith("https://chatgpt.com/?temporary-chat")));
    if (!samePage && !/^https:\/\/chatgpt\.com\/c\/[0-9a-f-]+/i.test(cur)) {
      gptView.webContents.loadURL(want);
    } else if (!/^https:\/\/chatgpt\.com\//.test(cur)) {
      gptView.webContents.loadURL(want);
    }
    const ok = await ensureChatLoaded();
    if (!ok) {
      const e = new Error("找不到 ChatGPT 輸入框（頁面可能還在載入、改版或被登出）。請先在右側完成登入看到輸入框，或按左側「重整內嵌頁」後重試。");
      e.code = "not_logged_in";
      throw e;
    }
  } else {
    const ok = await ensureChatLoaded();
    if (!ok) {
      const e = new Error("找不到 ChatGPT 輸入框，請按左側「重整內嵌頁」後重試。");
      e.code = "not_logged_in";
      throw e;
    }
  }

  // 1) 輸入內容（Lexical 用 execCommand insertText，跟上游同做法）
  const insertJS = `(function(){const sels=${JSON.stringify(auto.COMPOSER_SELECTOR)};const prompt=${JSON.stringify(prompt)};const el=document.querySelectorAll(sels);let t=null;for(const e of el){if(e.getClientRects().length>0){t=e;break;}}if(!t)return "no-composer";t.focus();try{document.execCommand("selectAll",false,null);}catch{}try{if(t.tagName==="TEXTAREA"){t.value="";}else{t.textContent="";}}catch{}let ok=false;try{ok=document.execCommand("insertText",false,prompt);}catch{}if(!ok){try{if(t.isContentEditable){document.execCommand("insertText",false,prompt);}else{t.value=prompt;t.dispatchEvent(new Event("input",{bubbles:true}));}}catch{}}const cur=(t.textContent||t.value||"").trim().length;return cur>0?"ok":"empty";})()`;
  const inserted = await runJS(gptView, insertJS);
  if (inserted !== "ok") {
    throw new Error(inserted === "empty" ? "輸入框沒有收到文字，送出失敗（可按「重整內嵌頁」後重試）。" : "找不到輸入框（可能被登出或頁面改版，可按「重整內嵌頁」後重試）。");
  }

  const before = (await runJS(gptView, auto.countAssistantJS())) ?? 0;

  // 送出證據：assistant 數量增加、產生中指示燈出現、或輸入框被清空（任一即算送出成功）。
  async function submitEvidence() {
    const count = (await runJS(gptView, auto.countAssistantJS())) ?? 0;
    if (count > before) return true;
    const generating = await runJS(gptView, auto.isGeneratingJS());
    if (generating) return true;
    const composer = await runJS(gptView, auto.composerTextJS());
    if (composer === "empty") return true;
    return false;
  }
  async function waitEvidence(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await submitEvidence()) return true;
      await sleep(400);
    }
    return submitEvidence();
  }

  // 2) 送出：先 Enter，等送出證據；沒證據且輸入框還有字、也沒在產生，才按送出鈕。
  //    （已在產生時絕對不再碰按鈕，避免誤按停止鈕把剛送出的對話暫停。）
  const enterJS = `(function(){const sels=${JSON.stringify(auto.COMPOSER_SELECTOR)};const els=document.querySelectorAll(sels);let t=null;for(const e of els){if(e.getClientRects().length>0){t=e;break;}}if(!t)return false;t.focus();const ev=(type)=>t.dispatchEvent(new KeyboardEvent(type,{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));ev("keydown");ev("keypress");ev("keyup");return true;})()`;
  await runJS(gptView, enterJS);
  let submitted = await waitEvidence(SUBMIT_GRACE_MS);
  if (!submitted) {
    const composer = await runJS(gptView, auto.composerTextJS());
    const generating = await runJS(gptView, auto.isGeneratingJS());
    if (composer === "has-text" && !generating) {
      const clickJS = `(function(){const csels=${JSON.stringify(auto.COMPOSER_SELECTOR)};const ssels=${JSON.stringify(auto.SEND_BUTTON_SELECTOR)};const els=document.querySelectorAll(csels);let t=null;for(const e of els){if(e.getClientRects().length>0){t=e;break;}}if(!t)return false;const form=t.closest("form");const scope=form||document;const btns=scope.querySelectorAll(ssels);for(const b of btns){if(b.getClientRects().length>0&&!b.disabled){b.click();return true;}}return false;})()`;
      await runJS(gptView, clickJS);
      submitted = await waitEvidence(SUBMIT_GRACE_MS);
    } else if (composer === "empty" || generating) {
      submitted = true;
    }
  }
  if (!submitted) {
    const e = new Error("送出沒有被 ChatGPT 接受（輸入框還有字、也沒開始產生），請確認頁面狀態後重試。");
    e.code = "submit_not_accepted";
    throw e;
  }
  const submittedAt = Date.now();

  // 3) 接回傳：數量先增加 → 最後一則連續 2 秒不變 → stop 消失。
  //    另有兩道 fail-fast：送出後 45 秒還沒動靜、產生中指示燈亮著卻 60 秒零文字，都直接報錯不再空等。
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  const acceptDeadline = submittedAt + ACCEPT_TIMEOUT_MS;
  let lastText = "";
  let stableSince = 0;
  let emptyStallSince = 0;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error("請求已取消。");
    const count = (await runJS(gptView, auto.countAssistantJS())) ?? 0;
    const text = (await runJS(gptView, auto.readLastAssistantJS())) || "";
    const accepted = count > before || text.length > 0;
    if (!accepted) {
      if (Date.now() > acceptDeadline) {
        const e = new Error("送出後 45 秒仍沒有開始產生回覆，對話可能沒有真的跑起來，請重試。");
        e.code = "submit_stalled";
        throw e;
      }
      await sleep(400);
      continue;
    }
    if (!text) {
      const generating = await runJS(gptView, auto.isGeneratingJS());
      if (generating) {
        if (emptyStallSince === 0) emptyStallSince = Date.now();
        else if (Date.now() - emptyStallSince >= STALL_EMPTY_MS) {
          const e = new Error("ChatGPT 顯示產生中但 60 秒沒有任何文字（疑似被暫停），已停止等待，請重試。");
          e.code = "submit_stalled";
          throw e;
        }
      } else if (Date.now() > acceptDeadline) {
        const e = new Error("送出後 45 秒仍沒有開始產生回覆，對話可能沒有真的跑起來，請重試。");
        e.code = "submit_stalled";
        throw e;
      }
      await sleep(500);
      continue;
    }
    emptyStallSince = 0;
    if (text !== lastText) {
      lastText = text;
      stableSince = 0;
    } else if (stableSince === 0) {
      stableSince = Date.now();
    }
    if (stableSince > 0 && Date.now() - stableSince >= 2000) {
      const generating = await runJS(gptView, auto.isGeneratingJS());
      if (!generating) {
        return { reply: text, conversationUrl: gptView.webContents.getURL(), durationMs: Date.now() - startedAt };
      }
    }
    await sleep(500);
  }
  throw new Error(`等待回覆超過 ${Math.round(TURN_TIMEOUT_MS / 1000)} 秒。可以調高 TURN_TIMEOUT_MS。`);
}

function ask(prompt, options = {}) {
  const task = queue.then(() => askOnce(prompt, options));
  queue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

// ---------- HTTP（跟 bun 版同合約，舊腳本不用改） ----------
function authorized(req) {
  if (!API_KEY) return true;
  const h = req.headers["x-api-key"] || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (h === API_KEY) return true;
  try {
    const u = new URL(req.url, "http://x");
    return u.searchParams.get("key") === API_KEY;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4 * 1024 * 1024) reject(new Error("body 太大"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function sendJson(res, obj, status = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function messagesToPrompt(messages) {
  const texts = (messages || []).map((m) => {
    const c = m && m.content;
    if (typeof c === "string") return c.trim();
    if (Array.isArray(c)) {
      return c
        .map((p) => {
          if (typeof p === "string") return p;
          if (p && typeof p === "object") return p.text || p.content || "";
          return "";
        })
        .join("\n")
        .trim();
    }
    return "";
  });
  return texts.filter(Boolean).join("\n\n");
}

function startHttp() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || "/", "http://x");
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, x-api-key",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && u.pathname === "/ready") {
      return sendJson(res, { ok: true, service: "gpt-web-port", app: "electron" });
    }
    if (!authorized(req)) {
      return sendJson(res, { error: "unauthorized", message: "需要正確的 x-api-key。" }, 401);
    }
    if (req.method === "GET" && u.pathname === "/health") {
      const s = await checkLogin();
      return sendJson(res, {
        ok: true,
        browserStarted: Object.keys(chatViews).length > 0,
        loggedIn: s.loggedIn,
        pageUrl: s.url,
        sessionAuth: s.sessionAuth || null,
        loginVisible,
        temporaryChat,
      });
    }
    if (req.method === "GET" && (u.pathname === "/v1/models" || u.pathname === "/models")) {
      const now = Math.floor(Date.now() / 1000);
      const local = [
        { id: "gpt-web-port", object: "model", created: now, owned_by: "chatgpt-web" },
        { id: "chatgpt-web", object: "model", created: now, owned_by: "chatgpt-web" },
      ];
      // 合而為一：把 8765 的直連模型併進來，8787 一個口全吃。8765 沒開就只回本地。
      try {
        const r = await fetch(`${PYTHON_BRIDGE_URL}/v1/models`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          const j = await r.json();
          const seen = new Set(local.map((m) => m.id));
          for (const m of (j.data || [])) {
            if (m && m.id && !seen.has(m.id)) {
              local.push(m);
              seen.add(m.id);
            }
          }
        }
      } catch {}
      return sendJson(res, {
        object: "list",
        data: local,
      });
    }
    if (req.method === "POST" && (u.pathname === "/v1/chat/completions" || u.pathname === "/v1/completions" || u.pathname === "/chat/completions")) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, { error: { message: "JSON 格式錯誤。", type: "invalid_request_error" } }, 400);
      }
      const model = (body && body.model) || "gpt-web-port";
      // 合而為一：直連系轉 Python 8765；其餘（gpt/chatgpt/webchat/空）走本地內嵌。
      if (shouldForwardToPython(model)) {
        return forwardToPythonBridge(req, res, body);
      }
      const stream = body.stream === true;
      const cont = body.continue === true || body.continueConversation === true;
      let prompt = "";
      if (Array.isArray(body.messages)) prompt = messagesToPrompt(body.messages);
      else if (typeof body.prompt === "string") prompt = body.prompt;
      else if (typeof body.input === "string") prompt = body.input;
      if (!prompt.trim()) return sendJson(res, { error: { message: "缺少 messages。", type: "invalid_request_error" } }, 400);
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      try {
        const r = await ask(prompt, { continueConversation: cont, signal: ctrl.signal });
        if (stream) {
          const id = `chatcmpl-web-${Date.now().toString(36)}`;
          const created = Math.floor(Date.now() / 1000);
          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
          });
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`);
          const size = 24;
          for (let i = 0; i < r.reply.length; i += size) {
            const piece = r.reply.slice(i, i + size);
            res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant", content: piece }, finish_reason: null }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
          res.end();
          return;
        }
        return sendJson(res, {
          id: `chatcmpl-web-${Date.now().toString(36)}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content: r.reply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (e && e.code === "not_logged_in") return sendJson(res, { error: { message: msg, type: "authentication_error" } }, 401);
        return sendJson(res, { error: { message: msg, type: "server_error" } }, 502);
      }
    }
    if (req.method === "POST" && (u.pathname === "/chat" || u.pathname === "/")) {
      let prompt = "";
      let cont = false;
      const ct = req.headers["content-type"] || "";
      const raw = await readBody(req);
      if (ct.includes("application/json")) {
        try {
          const b = raw ? JSON.parse(raw) : {};
          if (typeof b === "string") prompt = b;
          else {
            prompt = b.prompt || b.message || b.input || b.text || b.q || "";
            cont = b.continue === true || b.continueConversation === true;
          }
        } catch {
          return sendJson(res, { error: "bad_request", message: "JSON 格式錯誤。" }, 400);
        }
      } else {
        prompt = raw;
        cont = req.headers["x-continue"] === "1";
      }
      if (!String(prompt).trim()) return sendJson(res, { error: "bad_request", message: "缺少 prompt。" }, 400);
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      try {
        const r = await ask(String(prompt), { continueConversation: cont, signal: ctrl.signal });
        return sendJson(res, { reply: r.reply, conversationUrl: r.conversationUrl, durationMs: r.durationMs });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (e && e.code === "not_logged_in") return sendJson(res, { error: "not_logged_in", message: msg }, 401);
        return sendJson(res, { error: "chatgpt_error", message: msg }, 502);
      }
    }
    return sendJson(res, { error: "not_found", message: `沒有這個路徑：${req.method} ${u.pathname}` }, 404);
  });
  server.listen(PORT, HOST, () => {
    console.log(`[modeldock] http://${HOST}:${PORT}（Electron 內含瀏覽器，免 Chrome/Python）`);
  });
  return server;
}

// ---------- 視窗 ----------
async function createWindow() {
  mainWin = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    title: "ModelDock",
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
    icon: windowIconPath(),
  });

  // 確保同一個持久 partition（登入態跟上游一樣留在應用裡）
  session.fromPartition(PARTITION, { cache: true });

  panelView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  mainWin.contentView.addChildView(panelView);
  await panelView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  // ChatGPT 常駐 view 先建（問答通道）；Gemini/DeepSeek 背景常駐預建，
  // 縮到托盤、停在別的分頁時也能自動同步 Cookie/Token。
  chatView = ensureProviderView("chatgpt");
  chatViews.chatgpt = chatView;
  await chatView.webContents.loadURL(currentChatUrl());
  // 背景暖機：不影響右側顯示，失敗也不擋主視窗。
  try { ensureBackgroundProviderView("gemini"); } catch {}
  try { ensureBackgroundProviderView("deepseek"); } catch {}

  layoutViews();
  mainWin.on("resize", layoutViews);

  // 單一切換按鈕：顯示 / 隱藏登入頁（同一個按鈕切換，不再要兩個）
  ipcMain.handle("show-panel", async () => {
    loginVisible = false;
    layoutViews();
    return { ok: true, loginVisible };
  });
  ipcMain.handle("show-login", async () => {
    loginVisible = true;
    layoutViews();
    return { ok: true, loginVisible };
  });
  ipcMain.handle("toggle-login", async () => {
    loginVisible = !loginVisible;
    layoutViews();
    return { ok: true, loginVisible };
  });
  // 對話紀錄模式：無痕 temporary vs 一般保留紀錄（記住為預設，下次問答/開新對話生效）
  // GPT：登入後仍預設走 temporary-chat 無痕（不留紀錄）；切一般才保留。
  // Gemini：官方無免登入（一定要 Google 登入）；DeepSeek：一定要登入取 userToken。
  ipcMain.handle("set-temporary-chat", async (_e, temporary) => {
    temporaryChat = temporary !== false;
    return { ok: true, temporaryChat };
  });
  ipcMain.handle("login-status", checkLogin);
  // 路徑自動抓取：MCP 一句話設定用。每個人安裝位置不同，前端不再寫死絕對路徑。
  ipcMain.handle("get-paths", async () => {
    const serverScript = path.join(WORKSPACE_ROOT, "mcp_server.py");
    return {
      workspaceRoot: WORKSPACE_ROOT,
      serverScript,
      pythonExe: process.execPath || "python",
    };
  });
  // 左側面板主題切換時，同步內嵌頁的 prefers-color-scheme
  ipcMain.handle("set-theme", async (_e, t) => {
    nativeTheme.themeSource = t === "light" ? "light" : "dark";
    return { ok: true };
  });
  ipcMain.handle("ask", async (_e, payload) => {
    return ask(String((payload && payload.prompt) || ""), {
      continueConversation: !!(payload && payload.continueConversation),
    });
  });
  ipcMain.handle("new-chat", async () => {
    const gptView = chatViews.chatgpt || activeChatView();
    if (gptView) await gptView.webContents.loadURL(currentChatUrl());
    return { ok: true };
  });
  // 內嵌頁卡住/改版導致找不到輸入框時：強制重載當前頁（保留登入態，同 partition）
  ipcMain.handle("reload-browser-tab", async () => {
    const view = activeChatView();
    if (!view) return { ok: false, error: "no view" };
    try {
      view.webContents.reload();
      return { ok: true, activeProvider };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  // 診斷：回報 composer 探測明細（哪個 selector 命中、可見框數）
  ipcMain.handle("debug-composer", async () => {
    const gptView = chatViews.chatgpt || activeChatView();
    if (!gptView) return { ok: false, error: "no view" };
    try {
      const detail = await runJS(gptView, auto.findComposerJS());
      return { ok: true, url: gptView.webContents.getURL(), detail };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 多模型切換：常駐 view，命中已載入頁就不重載（解決 3 頁切換卡頓）。
  ipcMain.handle("switch-browser-tab", async (_e, provider) => {
    if (PROVIDER_URLS[provider]) {
      activeProvider = provider;
      const view = ensureProviderView(provider);
      chatView = view;
      try {
        const targetUrl = PROVIDER_URLS[provider]();
        const cur = view.webContents.getURL() || "";
        // 同域就不重載：例如已在 gemini.google.com 就直接顯示，秒切。
        const sameSite = (provider === "chatgpt" && /^https:\/\/chatgpt\.com\//.test(cur))
          || (provider === "gemini" && /^https:\/\/gemini\.google\.com\//.test(cur))
          || (provider === "deepseek" && /^https:\/\/chat\.deepseek\.com\//.test(cur));
        if (!sameSite && !cur) await view.webContents.loadURL(targetUrl);
        else if (!sameSite && cur === "about:blank") await view.webContents.loadURL(targetUrl);
      } catch {}
      layoutViews();
      return { ok: true, activeProvider };
    }
    return { ok: false, error: "unknown provider" };
  });
  ipcMain.handle("sync-gemini-cookies", async () => {
    return harvestGeminiCookies();
  });
  ipcMain.handle("sync-deepseek-token", async () => {
    return harvestDeepSeekToken();
  });

  // 頁面載入完成時與背景定時器自動擷取憑證（Gemini 走 session cookie，不依賴特定 view）
  setInterval(harvestAllCredentials, 25000);

  // 按 X 不結束：收到托盤繼續跑 HTTP，這樣沒開視窗也能送出。
  mainWin.on("close", (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWin.hide();
    if (tray && !hideNotified) {
      hideNotified = true;
      tray.displayBalloon({
        title: "ModelDock 還在跑",
        content: "已收到右下角托盤，HTTP 照常服務；要完全結束請按托盤「結束」。",
      });
    }
  });
  mainWin.on("closed", () => {
    mainWin = null;
  });

  createTray();
}

app.on("before-quit", () => {
  quitting = true;
});

app.on("second-instance", () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  await createWindow();
  startHttp();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
