// gpt-web-port 桌面應用主程式（參考 miuuyy/codex-chatgpt-web 的 launcher 概念，最小化）。
// - 內含瀏覽器（Electron persistent partition），免裝系統 Chrome、免 Python。
// - 左邊控制面板，右邊內嵌 ChatGPT 登入頁（同一個 partition，登入態共用）。
// - 自動化（丟資料/接回傳）直接驅動內嵌頁面，不開外部瀏覽器。
// - 照樣開 HTTP（POST /chat、OpenAI 相容），舊腳本不用改。
const { app, BrowserWindow, WebContentsView, ipcMain, session, nativeTheme } = require("electron");
const http = require("node:http");
const path = require("node:path");
const auto = require("./automation.cjs");

const PARTITION = "persist:gpt-web-port";
const PANEL_WIDTH = 420;

const HOST = (process.env.HOST || "127.0.0.1").trim() || "127.0.0.1";
const PORT = Number(process.env.PORT || 8787) || 8787;
const API_KEY = (process.env.API_KEY || "").trim();
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 300000) || 300000;

// 內嵌 ChatGPT 頁跟系統外觀走：宣告深色，頁面即為暗色（ChatGPT 外觀須為「系統」）
nativeTheme.themeSource = "dark";

let mainWin = null;
let panelView = null;
let chatView = null;
let chatReady = null; // 內嵌頁首次載入完成的 promise
let loginVisible = true;
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runJS(view, js) {
  return view.webContents.executeJavaScript(js, true).catch(() => null);
}

function layoutViews() {
  if (!mainWin || !panelView || !chatView) return;
  const { width, height } = mainWin.getContentBounds();
  if (loginVisible) {
    panelView.setBounds({ x: 0, y: 0, width: Math.min(PANEL_WIDTH, width), height });
    panelView.setVisible(true);
    chatView.setBounds({ x: Math.min(PANEL_WIDTH, width), y: 0, width: Math.max(0, width - Math.min(PANEL_WIDTH, width)), height });
    chatView.setVisible(true);
  } else {
    panelView.setBounds({ x: 0, y: 0, width, height });
    panelView.setVisible(true);
    chatView.setBounds({ x: 0, y: 0, width: 0, height: 0 });
    chatView.setVisible(false);
  }
}

async function ensureChatLoaded() {
  const url = chatView.webContents.getURL();
  if (!/^https:\/\/chatgpt\.com\//.test(url)) {
    chatView.webContents.loadURL(auto.CHAT_URL);
    await chatReady;
  }
  // 等 composer 出現（最多 60 秒）
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const ok = await runJS(chatView, auto.probeComposerJS());
    if (ok) return true;
    await sleep(500);
  }
  return false;
}

async function checkLogin() {
  try {
    const url = chatView.webContents.getURL();
    const composer = await runJS(chatView, auto.probeComposerJS());
    let sessionAuth = null;
    if (/^https:\/\/chatgpt\.com\//.test(url)) {
      sessionAuth = await runJS(chatView, auto.checkAuthSessionJS());
    }
    return { loggedIn: composer === true, url, sessionAuth };
  } catch (e) {
    return { loggedIn: false, url: "", error: String((e && e.message) || e) };
  }
}

async function askOnce(prompt, options = {}) {
  const startedAt = Date.now();
  const signal = options.signal;
  await ensureChatLoaded();

  const inChat = /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]+/i.test(chatView.webContents.getURL() || "");
  if (!(options.continueConversation === true && inChat)) {
    chatView.webContents.loadURL(auto.CHAT_URL);
    const ok = await ensureChatLoaded();
    if (!ok) {
      const e = new Error("還沒登入 ChatGPT。請在右邊內嵌頁面完成登入（看到輸入框才算）。");
      e.code = "not_logged_in";
      throw e;
    }
  } else {
    const ok = await ensureChatLoaded();
    if (!ok) {
      const e = new Error("還沒登入 ChatGPT。");
      e.code = "not_logged_in";
      throw e;
    }
  }

  // 1) 輸入內容（Lexical 用 execCommand insertText，跟上游同做法）
  const insertJS = `(function(){const sels=${JSON.stringify(auto.COMPOSER_SELECTOR)};const prompt=${JSON.stringify(prompt)};const el=document.querySelectorAll(sels);let t=null;for(const e of el){if(e.getClientRects().length>0){t=e;break;}}if(!t)return "no-composer";t.focus();try{document.execCommand("selectAll",false,null);}catch{}try{if(t.tagName==="TEXTAREA"){t.value="";}else{t.textContent="";}}catch{}let ok=false;try{ok=document.execCommand("insertText",false,prompt);}catch{}if(!ok){try{if(t.isContentEditable){document.execCommand("insertText",false,prompt);}else{t.value=prompt;t.dispatchEvent(new Event("input",{bubbles:true}));}}catch{}}const cur=(t.textContent||t.value||"").trim().length;return cur>0?"ok":"empty";})()`;
  const inserted = await runJS(chatView, insertJS);
  if (inserted !== "ok") {
    throw new Error(inserted === "empty" ? "輸入框沒有收到文字，送出失敗。" : "找不到輸入框（可能被登出）。");
  }

  const before = (await runJS(chatView, auto.countAssistantJS())) ?? 0;

  // 2) 送出：先 Enter，1.5 秒沒動靜改按送出鈕（限定 composer 所在 form）
  const enterJS = `(function(){const sels=${JSON.stringify(auto.COMPOSER_SELECTOR)};const els=document.querySelectorAll(sels);let t=null;for(const e of els){if(e.getClientRects().length>0){t=e;break;}}if(!t)return false;t.focus();const ev=(type)=>t.dispatchEvent(new KeyboardEvent(type,{key:"Enter",code:"Enter",keyCode:13,which:13,bubbles:true,cancelable:true}));ev("keydown");ev("keypress");ev("keyup");return true;})()`;
  await runJS(chatView, enterJS);
  await sleep(1500);
  const mid = (await runJS(chatView, auto.countAssistantJS())) ?? before;
  if (mid === before) {
    const clickJS = `(function(){const csels=${JSON.stringify(auto.COMPOSER_SELECTOR)};const ssels=${JSON.stringify(auto.SEND_BUTTON_SELECTOR)};const els=document.querySelectorAll(csels);let t=null;for(const e of els){if(e.getClientRects().length>0){t=e;break;}}if(!t)return false;const form=t.closest("form");const scope=form||document;const btns=scope.querySelectorAll(ssels);for(const b of btns){if(b.getClientRects().length>0&&!b.disabled){b.click();return true;}}return false;})()`;
    await runJS(chatView, clickJS);
  }

  // 3) 接回傳：數量先增加 → 最後一則連續 2 秒不變 → stop 消失
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let lastText = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (signal && signal.aborted) throw new Error("請求已取消。");
    const count = (await runJS(chatView, auto.countAssistantJS())) ?? 0;
    if (count <= before) {
      lastText = "";
      stableSince = 0;
      await sleep(400);
      continue;
    }
    const text = (await runJS(chatView, auto.readLastAssistantJS())) || lastText;
    if (text && text !== lastText) {
      lastText = text;
      stableSince = 0;
    } else if (text && stableSince === 0) {
      stableSince = Date.now();
    }
    if (text && stableSince > 0 && Date.now() - stableSince >= 2000) {
      const generating = await runJS(chatView, auto.isGeneratingJS());
      if (!generating) {
        return { reply: text, conversationUrl: chatView.webContents.getURL(), durationMs: Date.now() - startedAt };
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
        browserStarted: !!chatView,
        loggedIn: s.loggedIn,
        pageUrl: s.url,
        sessionAuth: s.sessionAuth || null,
        loginVisible,
      });
    }
    if (req.method === "GET" && u.pathname === "/v1/models") {
      const now = Math.floor(Date.now() / 1000);
      return sendJson(res, {
        object: "list",
        data: [{ id: "gpt-web-port", object: "model", created: now, owned_by: "chatgpt-web" }],
      });
    }
    if (req.method === "POST" && (u.pathname === "/v1/chat/completions" || u.pathname === "/chat/completions")) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, { error: { message: "JSON 格式錯誤。", type: "invalid_request_error" } }, 400);
      }
      const model = (body && body.model) || "gpt-web-port";
      const stream = body.stream === true;
      const cont = body.continue === true || body.continueConversation === true;
      let prompt = "";
      if (Array.isArray(body.messages)) prompt = messagesToPrompt(body.messages);
      else if (typeof body.prompt === "string") prompt = body.prompt;
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
    console.log(`[chatdock] http://${HOST}:${PORT}（Electron 內含瀏覽器，免 Chrome/Python）`);
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
    title: "ChatDock",
    autoHideMenuBar: true,
    backgroundColor: "#09090b",
  });

  // 確保同一個持久 partition（登入態跟上游一樣留在應用裡）
  session.fromPartition(PARTITION, { cache: true });

  panelView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, "preload.cjs") },
  });
  mainWin.contentView.addChildView(panelView);
  await panelView.webContents.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  chatView = new WebContentsView({
    webPreferences: { partition: PARTITION },
  });
  chatView.setBackgroundColor("#212121"); // ChatGPT 暗色底，載入過程不閃白
  mainWin.contentView.addChildView(chatView);
  chatReady = new Promise((resolve) => {
    chatView.webContents.once("did-finish-load", () => resolve());
  });
  // 身份提供者 popup 留在應用內（跟上游一樣，不跳外部瀏覽器）
  chatView.webContents.setWindowOpenHandler(() => ({ action: "allow" }));
  await chatView.webContents.loadURL(auto.CHAT_URL);

  layoutViews();
  mainWin.on("resize", layoutViews);

  // 頂部選單：切換內嵌登入頁顯示
  ipcMain.handle("show-panel", async () => {
    loginVisible = false;
    layoutViews();
    return { ok: true };
  });
  ipcMain.handle("show-login", async () => {
    loginVisible = true;
    layoutViews();
    try {
      const url = chatView.webContents.getURL();
      if (!/^https:\/\/chatgpt\.com\//.test(url)) await chatView.webContents.loadURL(auto.CHAT_URL);
    } catch {}
    return { ok: true };
  });
  ipcMain.handle("login-status", checkLogin);
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
    await chatView.webContents.loadURL(auto.CHAT_URL);
    return { ok: true };
  });

  mainWin.on("closed", () => {
    mainWin = null;
  });
}

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
