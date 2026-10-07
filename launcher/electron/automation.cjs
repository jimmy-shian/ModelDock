// 與 src/chatgpt.ts 同步的上游 selector（參考 miuuyy/codex-chatgpt-web）
// 這裡只包「在頁面裡跑的 JS 字串」，給 main.cjs 的 executeJavaScript 用。
const CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
  // 訪客/未登入首頁與改版兜底：由精確到寬鬆，最後兩個是通用備援
  'div[contenteditable="true"][role="textbox"]',
  'textarea[placeholder]',
  'div[contenteditable="true"]',
].join(", ");

const SEND_BUTTON_SELECTOR = [
  '[data-testid="send-button"]',
  'button[type="submit"]',
  'button[aria-label*="Send"]',
  'button[aria-label*="傳送"]',
  'form[data-chatgpt-composer] button[type="button"]',
].join(", ");

const STOP_BUTTON_SELECTOR =
  '[data-testid="stop-button"], form[data-chatgpt-composer] button[type="button"][aria-label="Stop"]';

const ASSISTANT_TURN_SELECTOR = [
  '[data-testid^="conversation-turn-"][data-turn="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"][data-message-author-role="assistant"]:not([data-turn-key] *)',
  '[data-testid^="conversation-turn-"]:has([data-message-author-role="assistant"]):not([data-turn-key] *)',
  '[data-turn-key]:has([data-conversation-role="assistant"], [data-chatgpt-agent-turn-start])',
].join(", ");

const MARKDOWN_SELECTOR = [
  "[data-message-author-role='assistant'] .markdown",
  ".markdown",
  ".prose",
  "[data-markdown-text-style='assistant-message']",
].join(", ");

const CHROME_NOISE_SELECTOR = [
  "button",
  "[role='button']",
  "svg",
  ".copy-button",
  "[class*='copy-code']",
  "[data-testid='copy']",
].join(", ");

// ---- 在頁面內執行的函式本體（用 .toString() 塞進 executeJavaScript） ----
function __probeComposer() {
  const sels = __COMPOSER_SEL.split("|||");
  for (const sel of sels) {
    const els = Array.from(document.querySelectorAll(sel)).filter(
      (el) => el.getClientRects().length > 0,
    );
    if (els.length > 0) return true;
  }
  return false;
}

// 診斷用：回報哪個 selector 命中、可見輸入框數量、頁面概況（URL 由主程式另取）。
function __findComposer() {
  const sels = __COMPOSER_SEL.split("|||");
  const hits = [];
  for (const sel of sels) {
    let n = 0;
    try {
      n = Array.from(document.querySelectorAll(sel)).filter(
        (el) => el.getClientRects().length > 0,
      ).length;
    } catch (e) { n = -1; }
    hits.push({ sel, n });
  }
  const editables = Array.from(document.querySelectorAll('[contenteditable="true"]')).filter(
    (el) => el.getClientRects().length > 0,
  ).length;
  const textareas = Array.from(document.querySelectorAll("textarea")).filter(
    (el) => el.getClientRects().length > 0,
  ).length;
  const loginBtn = !!document.querySelector('button[data-testid*="login"], a[href*="auth/login"]');
  return {
    found: hits.some((h) => h.n > 0),
    hits,
    editables,
    textareas,
    title: document.title || "",
  };
}

function __countAssistant() {
  return Array.from(document.querySelectorAll(__ASSISTANT_SEL)).filter(
    (el) => el.getClientRects().length > 0,
  ).length;
}

function __readLastAssistant() {
  const nodes = Array.from(document.querySelectorAll(__ASSISTANT_SEL)).filter(
    (el) => el.getClientRects().length > 0,
  );
  const last = nodes[nodes.length - 1];
  if (!last) return "";
  const root = last.querySelector(__MARKDOWN_SEL) || last;
  const clone = root.cloneNode(true);
  clone.querySelectorAll(__NOISE_SEL).forEach((n) => n.remove());
  return ((clone.innerText || "").replace(/\u00a0/g, " ") || "").trim();
}

function __isGenerating() {
  return Array.from(document.querySelectorAll(__STOP_SEL)).some((el) => {
    const btn = el;
    return el.getClientRects().length > 0 && !btn.disabled;
  });
}

function __composerText() {
  const sels = __COMPOSER_SEL.split("|||");
  for (const sel of sels) {
    const els = Array.from(document.querySelectorAll(sel)).filter(
      (el) => el.getClientRects().length > 0,
    );
    if (els.length > 0) {
      const t = els[0];
      return ((t.textContent || t.value || "").trim().length > 0) ? "has-text" : "empty";
    }
  }
  return "no-composer";
}

function __checkAuthSession() {
  return fetch("/api/auth/session", {
    credentials: "include",
    cache: "no-store",
    redirect: "error",
    headers: { accept: "application/json" },
  })
    .then((r) => {
      if (r.status === 401) return { authenticated: false };
      if (!r.ok) return { authenticated: false, http: r.status };
      return r
        .json()
        .then((p) => {
          const u = p && p.user;
          const ok =
            !!u &&
            typeof u === "object" &&
            Object.keys(u).length > 0 &&
            (p.error === undefined || p.error === null || p.error === "");
          return { authenticated: !!ok };
        })
        .catch(() => ({ authenticated: false, badJson: true }));
    })
    .catch(() => ({ authenticated: false, fetchFail: true }));
}

// 把上面的函式轉成可執行的 JS 字串（含 selector 常數注入）
function fnSource(fn, inject) {
  let src = `(${fn.toString()})()`;
  for (const [k, v] of Object.entries(inject || {})) {
    src = src.split(k).join(JSON.stringify(v));
  }
  return src;
}

module.exports = {
  CHAT_URL,
  COMPOSER_SELECTOR,
  SEND_BUTTON_SELECTOR,
  STOP_BUTTON_SELECTOR,
  ASSISTANT_TURN_SELECTOR,
  MARKDOWN_SELECTOR,
  probeComposerJS: () =>
    fnSource(__probeComposer, { __COMPOSER_SEL: COMPOSER_SELECTOR.split(", ").join("|||") }),
  findComposerJS: () =>
    fnSource(__findComposer, { __COMPOSER_SEL: COMPOSER_SELECTOR.split(", ").join("|||") }),
  countAssistantJS: () => fnSource(__countAssistant, { __ASSISTANT_SEL: ASSISTANT_TURN_SELECTOR }),
  readLastAssistantJS: () =>
    fnSource(__readLastAssistant, {
      __ASSISTANT_SEL: ASSISTANT_TURN_SELECTOR,
      __MARKDOWN_SEL: MARKDOWN_SELECTOR,
      __NOISE_SEL: CHROME_NOISE_SELECTOR,
    }),
  isGeneratingJS: () => fnSource(__isGenerating, { __STOP_SEL: STOP_BUTTON_SELECTOR }),
  composerTextJS: () =>
    fnSource(__composerText, { __COMPOSER_SEL: COMPOSER_SELECTOR.split(", ").join("|||") }),
  checkAuthSessionJS: () => `(${__checkAuthSession.toString()})()`,
};
