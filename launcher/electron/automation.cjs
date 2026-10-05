// 與 src/chatgpt.ts 同步的上游 selector（參考 miuuyy/codex-chatgpt-web）
// 這裡只包「在頁面裡跑的 JS 字串」，給 main.cjs 的 executeJavaScript 用。
const CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

const COMPOSER_SELECTOR = [
  '[data-testid="prompt-textarea"]',
  "#prompt-textarea",
  '[contenteditable="true"][data-lexical-editor="true"]',
  'form[data-chatgpt-composer] [data-composer-markdown][contenteditable="true"][role="textbox"]',
].join(", ");

const SEND_BUTTON_SELECTOR = '[data-testid="send-button"], button[type="submit"]';

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
  countAssistantJS: () => fnSource(__countAssistant, { __ASSISTANT_SEL: ASSISTANT_TURN_SELECTOR }),
  readLastAssistantJS: () =>
    fnSource(__readLastAssistant, {
      __ASSISTANT_SEL: ASSISTANT_TURN_SELECTOR,
      __MARKDOWN_SEL: MARKDOWN_SELECTOR,
      __NOISE_SEL: CHROME_NOISE_SELECTOR,
    }),
  isGeneratingJS: () => fnSource(__isGenerating, { __STOP_SEL: STOP_BUTTON_SELECTOR }),
  checkAuthSessionJS: () => `(${__checkAuthSession.toString()})()`,
};
