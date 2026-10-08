// ModelDock 桌面應用主程式（ChatGPT + Gemini + DeepSeek 全本機免外掛自動化）
// - 統一 8765 連接埠：捨棄 8787，ModelDock 作為本機統一閘道（提供 OpenAI 相容、/chat、Web 儀表板）。
// - 內含瀏覽器（Electron persistent partition），本地直接登入並自動背景更新 Cookie / Token。
// - 內嵌自動驅動（ChatGPT）+ 背景直連引擎（Gemini/DeepSeek 經內部 Python Worker）。
// - 擴充套件完全可有可無：無外掛亦可 100% 獨立運行。
const { app, BrowserWindow, WebContentsView, ipcMain, session, nativeTheme, Tray, Menu, nativeImage } = require("electron");
const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const { spawn, execSync } = require("node:child_process");
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
const PORT = Number(process.env.PORT || 8765) || 8765;
const INTERNAL_PYTHON_PORT = Number(process.env.INTERNAL_PYTHON_PORT || 8766) || 8766;
const API_KEY = (process.env.API_KEY || "").trim();
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 300000) || 300000;
// 送出確認相關閾值：Enter 後等送出證據；送出後等開始產生；產生中指示燈亮卻零文字的最大容忍。
const SUBMIT_GRACE_MS = 8000;
const ACCEPT_TIMEOUT_MS = 45000;
const STALL_EMPTY_MS = 60000;

// 內部 Python 直連 Worker 網址（預設 port 8766，避免與 ModelDock 外部 8765 衝突）
const PYTHON_BRIDGE_URL = (process.env.PYTHON_BRIDGE_URL || "").trim()
  || `http://127.0.0.1:${INTERNAL_PYTHON_PORT}`;

let pythonProcess = null;

function findPythonExe() {
  const candidates = [
    process.env.PYTHON_EXE,
    "C:\\Users\\Administrator\\venv\\Scripts\\python.exe",
    path.join(WORKSPACE_ROOT, "venv", "Scripts", "python.exe"),
    path.join(WORKSPACE_ROOT, ".venv", "Scripts", "python.exe"),
    "python",
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return "python";
}

async function isPythonBridgeAlive() {
  try {
    const r = await fetch(`${PYTHON_BRIDGE_URL}/v1/status`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensurePythonWorker() {
  if (await isPythonBridgeAlive()) {
    console.log(`[modeldock] Python 直連 Worker 已在 ${PYTHON_BRIDGE_URL} 運行中。`);
    return;
  }
  const pythonExe = findPythonExe();
  const scriptPath = path.join(WORKSPACE_ROOT, "run_server.py");
  if (!fs.existsSync(scriptPath)) {
    console.log(`[modeldock] run_server.py 不存在於 ${scriptPath}，略過自動啟動 Python。`);
    return;
  }

  console.log(`[modeldock] 正在後台啟動 Python Worker (port ${INTERNAL_PYTHON_PORT})... [${pythonExe}]`);
  try {
    pythonProcess = spawn(pythonExe, [scriptPath, "start", "--port", String(INTERNAL_PYTHON_PORT)], {
      cwd: WORKSPACE_ROOT,
      env: { ...process.env, W2L_PORT: String(INTERNAL_PYTHON_PORT) },
      stdio: "ignore",
      windowsHide: true,
    });
    pythonProcess.on("exit", (code) => {
      console.log(`[modeldock] Python Worker 進程結束 (code: ${code})`);
      pythonProcess = null;
    });
  } catch (err) {
    console.error("[modeldock] 啟動 Python Worker 失敗:", err);
  }
}

function stopPythonWorker() {
  if (pythonProcess) {
    console.log("[modeldock] 正在關閉後台 Python Worker...");
    try {
      if (process.platform === "win32") {
        try { execSync(`taskkill /pid ${pythonProcess.pid} /T /F`, { stdio: "ignore" }); } catch {}
      } else {
        pythonProcess.kill("SIGTERM");
      }
    } catch {}
    pythonProcess = null;
  }
}

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
// 抓到憑證後除寫入本地工作區 JSON，亦同步直推內部 Python Worker（免重啟、免手動複製）。
function pushToPythonBridge(apiPath, payload) {
  // fire-and-forget：Python Worker 尚未就緒時不阻塞主流程。
  try {
    fetch(`${PYTHON_BRIDGE_URL}${apiPath}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      if (r.ok) console.log(`[modeldock] 已同步憑證到 Python Worker (${PYTHON_BRIDGE_URL}) ${apiPath}`);
      else console.log(`[modeldock] 同步 Python Worker ${apiPath} 失敗: HTTP ${r.status}`);
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
        "access-control-allow-headers": "content-type, authorization, x-api-key, x-continue, x-model",
      });
      res.end();
      return;
    }

    // 1) Web Dashboard 靜態資源（讓使用者也能直接用外部瀏覽器開啟 8765 儀表板）
    if (req.method === "GET") {
      if (u.pathname === "/" || u.pathname === "/index.html" || u.pathname === "/ui") {
        const accept = req.headers["accept"] || "";
        if (u.pathname === "/" && !accept.includes("text/html") && accept.includes("application/json")) {
          return sendJson(res, {
            service: "modeldock",
            port: PORT,
            endpoints: {
              "POST /chat": "純文字 /chat，最穩無 JSON 引號問題",
              "POST /v1/chat/completions": "OpenAI 相容端點",
              "GET /v1/models": "模型列表",
              "GET /health": "健康狀態",
            },
          });
        }
        const htmlPath = path.join(__dirname, "..", "renderer", "index.html");
        try {
          const content = fs.readFileSync(htmlPath, "utf-8");
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(content);
          return;
        } catch {}
      }
      if (u.pathname === "/styles.css") {
        const cssPath = path.join(__dirname, "..", "renderer", "styles.css");
        try {
          const content = fs.readFileSync(cssPath, "utf-8");
          res.writeHead(200, { "content-type": "text/css; charset=utf-8" });
          res.end(content);
          return;
        } catch {}
      }
      if (u.pathname === "/renderer.js") {
        const jsPath = path.join(__dirname, "..", "renderer", "renderer.js");
        try {
          const content = fs.readFileSync(jsPath, "utf-8");
          res.writeHead(200, { "content-type": "application/javascript; charset=utf-8" });
          res.end(content);
          return;
        } catch {}
      }
    }

    if (req.method === "GET" && u.pathname === "/ready") {
      return sendJson(res, { ok: true, service: "modeldock", app: "electron", port: PORT });
    }
    if (!authorized(req)) {
      return sendJson(res, { error: "unauthorized", message: "需要正確的 x-api-key。" }, 401);
    }

    // 2) 伺服器健康診斷
    if (req.method === "GET" && (u.pathname === "/health" || u.pathname === "/v1/status")) {
      const s = await checkLogin();
      let pythonStatus = null;
      try {
        const pr = await fetch(`${PYTHON_BRIDGE_URL}/v1/status`, { signal: AbortSignal.timeout(1500) });
        if (pr.ok) pythonStatus = await pr.json();
      } catch {}
      const hasGemini = fs.existsSync(path.join(WORKSPACE_ROOT, "gemini_cookies.json"));
      const hasDeepSeek = fs.existsSync(path.join(WORKSPACE_ROOT, "deepseek_token.json"));
      return sendJson(res, {
        ok: true,
        port: PORT,
        browserStarted: Object.keys(chatViews).length > 0,
        loggedIn: s.loggedIn,
        chatgpt: s.chatgpt,
        gemini: hasGemini || (pythonStatus && pythonStatus.direct_configured),
        gemini_direct: hasGemini || (pythonStatus && pythonStatus.direct_configured),
        deepseek: hasDeepSeek || (pythonStatus && pythonStatus.deepseek_configured),
        deepseek_direct: hasDeepSeek || (pythonStatus && pythonStatus.deepseek_configured),
        pageUrl: s.url,
        sessionAuth: s.sessionAuth || null,
        loginVisible,
        temporaryChat,
        python_bridge: !!pythonStatus,
        python_port: INTERNAL_PYTHON_PORT,
      });
    }

    // 3) 模型列表（合併 ChatGPT 與內部 Python Gemini / DeepSeek 模型）
    if (req.method === "GET" && (u.pathname === "/v1/models" || u.pathname === "/models")) {
      const now = Math.floor(Date.now() / 1000);
      const local = [
        { id: "gemini-web/flash", object: "model", created: now, owned_by: "gemini-web" },
        { id: "gemini-web/pro", object: "model", created: now, owned_by: "gemini-web" },
        { id: "gemini-web/flash-thinking", object: "model", created: now, owned_by: "gemini-web" },
        { id: "chatgpt-web/auto", object: "model", created: now, owned_by: "chatgpt-web" },
        { id: "deepseek-web/chat", object: "model", created: now, owned_by: "deepseek-web" },
        { id: "deepseek-web/reasoner-search", object: "model", created: now, owned_by: "deepseek-web" },
        { id: "gpt-web-port", object: "model", created: now, owned_by: "chatgpt-web" },
        { id: "chatgpt-web", object: "model", created: now, owned_by: "chatgpt-web" },
        { id: "webchat/auto", object: "model", created: now, owned_by: "modeldock" },
      ];
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

    // 4) OpenAI 相容聊天端點
    if (req.method === "POST" && (u.pathname === "/v1/chat/completions" || u.pathname === "/v1/completions" || u.pathname === "/chat/completions")) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, { error: { message: "JSON 格式錯誤。", type: "invalid_request_error" } }, 400);
      }
      const model = (body && body.model) || "webchat/auto";
      // 直連系轉給內部 Python Worker
      if (shouldForwardToPython(model)) {
        return forwardToPythonBridge(req, res, body);
      }
      if (model === "webchat/auto" || model === "auto") {
        const hasGemini = fs.existsSync(path.join(WORKSPACE_ROOT, "gemini_cookies.json"));
        const hasDeepSeek = fs.existsSync(path.join(WORKSPACE_ROOT, "deepseek_token.json"));
        if (hasGemini || hasDeepSeek) {
          return forwardToPythonBridge(req, res, body);
        }
      }

      // ChatGPT 系走 Electron 本地內嵌自動化
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

    // 5) 純文字與簡易 POST /chat 對話測試（無引號問題，支援所有模型）
    if (req.method === "POST" && (u.pathname === "/chat" || u.pathname === "/")) {
      let prompt = "";
      let cont = false;
      let model = "";
      const ct = req.headers["content-type"] || "";
      const raw = await readBody(req);
      if (ct.includes("application/json")) {
        try {
          const b = raw ? JSON.parse(raw) : {};
          if (typeof b === "string") prompt = b;
          else {
            prompt = b.prompt || b.message || b.input || b.text || b.q || "";
            cont = b.continue === true || b.continueConversation === true;
            model = b.model || "";
          }
        } catch {
          return sendJson(res, { error: "bad_request", message: "JSON 格式錯誤。" }, 400);
        }
      } else {
        prompt = raw;
        cont = req.headers["x-continue"] === "1";
        model = req.headers["x-model"] || "";
      }
      if (!String(prompt).trim()) return sendJson(res, { error: "bad_request", message: "缺少 prompt。" }, 400);

      const targetModel = model || (activeProvider === "gemini" ? "gemini-web/flash" : (activeProvider === "deepseek" ? "deepseek-web/chat" : "chatgpt-web/auto"));
      if (shouldForwardToPython(targetModel)) {
        return forwardToPythonBridge(req, res, {
          model: targetModel,
          messages: [{ role: "user", content: String(prompt) }],
          stream: false,
        });
      }

      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      try {
        const r = await ask(String(prompt), { continueConversation: cont, signal: ctrl.signal });
        if (!ct.includes("application/json") && req.headers["accept"]?.includes("text/plain")) {
          res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
          res.end(r.reply);
          return;
        }
        return sendJson(res, { reply: r.reply, model: targetModel, conversationUrl: r.conversationUrl, durationMs: r.durationMs });
      } catch (e) {
        const msg = (e && e.message) || String(e);
        if (e && e.code === "not_logged_in") return sendJson(res, { error: "not_logged_in", message: msg }, 401);
        return sendJson(res, { error: "chatgpt_error", message: msg }, 502);
      }
    }

    // 6) 憑證熱同步端點（擴充套件或外部工具推送）
    if (req.method === "POST" && u.pathname === "/v1/cookies") {
      let b;
      try { b = JSON.parse(await readBody(req)); } catch { return sendJson(res, { error: "bad json" }, 400); }
      const targetFile = path.join(WORKSPACE_ROOT, "gemini_cookies.json");
      try { fs.writeFileSync(targetFile, JSON.stringify(b, null, 2), "utf-8"); } catch {}
      pushToPythonBridge("/v1/cookies", b);
      return sendJson(res, { ok: true, synced: true });
    }

    if (req.method === "POST" && u.pathname === "/v1/deepseek/token") {
      let b;
      try { b = JSON.parse(await readBody(req)); } catch { return sendJson(res, { error: "bad json" }, 400); }
      const targetFile = path.join(WORKSPACE_ROOT, "deepseek_token.json");
      try { fs.writeFileSync(targetFile, JSON.stringify(b, null, 2), "utf-8"); } catch {}
      pushToPythonBridge("/v1/deepseek/token", b);
      return sendJson(res, { ok: true, synced: true });
    }

    // 7) Antigravity / Codex responses 相容轉發
    if (req.method === "POST" && u.pathname === "/v1/responses") {
      let b;
      try { b = JSON.parse(await readBody(req)); } catch { return sendJson(res, { error: "bad json" }, 400); }
      const ctrl = new AbortController();
      req.on("close", () => ctrl.abort());
      try {
        const r = await fetch(`${PYTHON_BRIDGE_URL}/v1/responses`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(b),
          signal: ctrl.signal,
        });
        const ct = r.headers.get("content-type") || "application/json";
        if (ct.includes("text/event-stream")) {
          res.writeHead(r.status, { "content-type": ct, "cache-control": "no-cache", connection: "keep-alive", "access-control-allow-origin": "*" });
          const reader = r.body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
          res.end();
          return;
        }
        const text = await r.text();
        res.writeHead(r.status, { "content-type": ct, "access-control-allow-origin": "*" });
        res.end(text);
        return;
      } catch (e) {
        return sendJson(res, { error: String(e) }, 502);
      }
    }

    return sendJson(res, { error: "not_found", message: `沒有這個路徑：${req.method} ${u.pathname}` }, 404);
  });

  // 8) WebSocket 升級代理（若使用者有裝 Chrome 擴充套件連線 ws://127.0.0.1:8765/ws，無縫轉接內部 Python）
  server.on("upgrade", (req, socket, head) => {
    const u = new URL(req.url || "/", "http://x");
    if (u.pathname === "/ws") {
      const targetSocket = net.connect(INTERNAL_PYTHON_PORT, HOST, () => {
        targetSocket.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          targetSocket.write(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}\r\n`);
        }
        targetSocket.write("\r\n");
        if (head && head.length > 0) targetSocket.write(head);
        socket.pipe(targetSocket);
        targetSocket.pipe(socket);
      });
      targetSocket.on("error", () => socket.destroy());
      socket.on("error", () => targetSocket.destroy());
    } else {
      socket.destroy();
    }
  });

  server.listen(PORT, HOST, () => {
    console.log(`[modeldock] 統一閘道已啟動於 http://${HOST}:${PORT}（OpenAI 相容 + Web 儀表板 + 免外掛登入）`);
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

  // 立即註冊所有 IPC 處理器，確保前端渲染載入時能即刻調用
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
  ipcMain.handle("set-temporary-chat", async (_e, temporary) => {
    temporaryChat = temporary !== false;
    return { ok: true, temporaryChat };
  });
  ipcMain.handle("login-status", checkLogin);
  ipcMain.handle("get-paths", async () => {
    const serverScript = path.join(WORKSPACE_ROOT, "mcp_server.py");
    return {
      workspaceRoot: WORKSPACE_ROOT,
      serverScript,
      pythonExe: findPythonExe(),
    };
  });
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
  ipcMain.handle("switch-browser-tab", async (_e, provider) => {
    if (PROVIDER_URLS[provider]) {
      activeProvider = provider;
      const view = ensureProviderView(provider);
      chatView = view;
      try {
        const targetUrl = PROVIDER_URLS[provider]();
        const cur = view.webContents.getURL() || "";
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

  await panelView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

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
        content: "已收到右下角托盤，HTTP 8765 照常服務；要完全結束請按托盤「結束」。",
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
  stopPythonWorker();
});

process.on("exit", () => {
  stopPythonWorker();
});

app.on("second-instance", () => {
  showMainWindow();
});

app.whenReady().then(async () => {
  await ensurePythonWorker();
  await createWindow();
  startHttp();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
