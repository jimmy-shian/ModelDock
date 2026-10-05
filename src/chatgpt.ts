/**
 * v2 最小可用版：只做「登入 + 自動丟資料 + 接回傳」。
 * 參考 https://github.com/miuuyy/codex-chatgpt-web 的做法：
 *  - 登入：真 Chrome（spawn，不經 playwright 佔用）+ storageState 檔案保存
 *  - 自動化：每次用 storageState 開全新 context，不鎖 profile 目錄
 *  - 網址：https://chatgpt.com/?temporary-chat=true（預設不留紀錄，最穩）
 *  - selector：跟著上游更新（data-testid / lexical / data-turn-key）
 *  - 接回傳：assistant turn 數量先增加 → 最後一則文字連續 2 秒不變 → stop 鈕消失
 * 不做 MCP / 不操作使用者檔案。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";
import { atomicWriteFile, type AppConfig } from "./config";

// ---- 參考上游的網址與 selector（2026 年版 ChatGPT 網頁） ----
export const CHAT_URL = "https://chatgpt.com/?temporary-chat=true";

export const COMPOSER_SELECTOR = [
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

const SELECT_ALL_KEY = process.platform === "darwin" ? "Meta+A" : "Control+A";

export class NotLoggedInError extends Error {
  constructor() {
    super("還沒登入 ChatGPT。先執行 `bun run src/cli.ts login`（會開真 Chrome，登入後把 Chrome 完全關掉即可）。");
    this.name = "NotLoggedInError";
  }
}

export class ChatGptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatGptError";
  }
}

export interface AskOptions {
  continueConversation?: boolean;
  signal?: AbortSignal;
}

export interface AskResult {
  reply: string;
  conversationUrl: string;
  durationMs: number;
}

export interface LoginState {
  loggedIn: boolean;
  url: string;
}

function verifiedMarkerPath(storageStatePath: string): string {
  return `${storageStatePath}.verified.json`;
}

export function loginStateExists(config: AppConfig): boolean {
  if (!existsSync(config.storageStatePath)) return false;
  if (!existsSync(verifiedMarkerPath(config.storageStatePath))) return false;
  try {
    const marker = JSON.parse(readFileSync(verifiedMarkerPath(config.storageStatePath), "utf-8")) as {
      authenticated?: boolean;
    };
    return marker.authenticated === true;
  } catch {
    return false;
  }
}

function writeVerifiedMarker(storageStatePath: string): void {
  atomicWriteFile(
    verifiedMarkerPath(storageStatePath),
    JSON.stringify({ version: 1, authenticated: true, verifiedAt: new Date().toISOString() }) + "\n",
  );
}

async function firstVisible(page: Page, selector: string, timeoutMs: number): Promise<Locator | null> {
  try {
    const locator = page.locator(selector);
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    const count = await locator.count();
    for (let i = 0; i < count; i += 1) {
      const c = locator.nth(i);
      if (await c.isVisible().catch(() => false)) return c;
    }
    return count > 0 ? locator.first() : null;
  } catch {
    return null;
  }
}

async function countAssistantTurns(page: Page): Promise<number> {
  return page
    .evaluate(
      (sel) =>
        Array.from(document.querySelectorAll(sel)).filter((el) => el.getClientRects().length > 0).length,
      ASSISTANT_TURN_SELECTOR,
    )
    .catch(() => 0);
}

async function readLastAssistantText(page: Page): Promise<string> {
  return page.evaluate(
    ({ turnSel, mdSel, noiseSel }) => {
      const nodes = Array.from(document.querySelectorAll(turnSel)).filter(
        (el) => el.getClientRects().length > 0,
      );
      const last = nodes[nodes.length - 1];
      if (!last) return "";
      const root = last.querySelector(mdSel) || last;
      const clone = root.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(noiseSel).forEach((n) => n.remove());
      return ((clone as HTMLElement).innerText || "").replace(/\u00a0/g, " ").trim();
    },
    { turnSel: ASSISTANT_TURN_SELECTOR, mdSel: MARKDOWN_SELECTOR, noiseSel: CHROME_NOISE_SELECTOR },
  );
}

async function isGenerating(page: Page): Promise<boolean> {
  return page.evaluate((sel) =>
    Array.from(document.querySelectorAll(sel)).some((el) => {
      const btn = el as HTMLButtonElement;
      return el.getClientRects().length > 0 && !btn.disabled;
    }),
  STOP_BUTTON_SELECTOR,
  );
}

/** 自動化一律用 storageState 開全新 browser+context，不碰任何 profile 目錄 → 不會被鎖。 */
async function launchAutomation(config: AppConfig): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
  if (!existsSync(config.chromeExecutablePath)) {
    throw new ChatGptError(`找不到 Chrome：${config.chromeExecutablePath}，用 CHROME_PATH 指定路徑。`);
  }
  const hasState = existsSync(config.storageStatePath);
  const browser = await chromium.launch({
    executablePath: config.chromeExecutablePath,
    headless: config.headless,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=Translate,OptimizationHints",
    ],
  });
  const context = await browser.newContext({
    ...(hasState ? { storageState: config.storageStatePath } : {}),
    viewport: { width: 1440, height: 900 },
    locale: "zh-TW",
  });
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(60_000);
  const page = await context.newPage();
  return { browser, context, page };
}

export class ChatGptSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launching: Promise<Page> | null = null;
  private loginBusy = false;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly config: AppConfig) {}

  get isLoginBusy(): boolean {
    return this.loginBusy;
  }

  get started(): boolean {
    return this.page !== null && !this.page.isClosed();
  }

  /** 健康檢查：用 storageState 開一次、看輸入框在不在。 */
  async checkLogin(timeoutMs = 45_000): Promise<LoginState> {
    if (this.loginBusy) return { loggedIn: false, url: "" };
    const { browser, page } = await launchAutomation(this.config);
    try {
      await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      const composer = await firstVisible(page, COMPOSER_SELECTOR, timeoutMs);
      return { loggedIn: composer !== null, url: page.url() };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /**
   * 登入：開「真 Chrome」（spawn，不經 playwright），等使用者登入後「把 Chrome 完全關掉」，
   * 再用 playwright 讀一次該 loginProfile 驗證 + 存 storageState。
   * 登入期間自動化瀏覽器一定是關著的，兩邊 profile 完全不同 → 不會搶鎖、不會閃退。
   */
  async openLoginWindow(timeoutMs = 10 * 60_000): Promise<LoginState> {
    if (this.loginBusy) throw new ChatGptError("登入視窗已經開著，請完成目前的登入。");
    this.loginBusy = true;
    try {
      await this.close();
      if (!existsSync(this.config.chromeExecutablePath)) {
        throw new ChatGptError(`找不到 Chrome：${this.config.chromeExecutablePath}，請修正 CHROME_PATH。`);
      }
      mkdirSync(this.config.loginProfileDir, { recursive: true, mode: 0o700 });
      mkdirSync(dirname(this.config.storageStatePath), { recursive: true });

      const child = spawn(
        this.config.chromeExecutablePath,
        [
          `--user-data-dir=${this.config.loginProfileDir}`,
          "--new-window",
          "--disable-background-mode",
          "--no-first-run",
          "--no-default-browser-check",
          CHAT_URL,
        ],
        { stdio: "ignore", detached: false },
      );
      const exited = new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new ChatGptError("登入逾時（10 分鐘）。請把 Chrome 完全關掉後重試。")), timeoutMs);
        child.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once("exit", (code) => {
          clearTimeout(timer);
          resolve(code ?? 0);
        });
      });
      // 等使用者「完全關掉 Chrome」才算結束（分頁關掉不算，背景 Chrome 也要關）。
      await exited;

      // 用該 loginProfile 驗證一次 + 存檔。
      const context = await chromium.launchPersistentContext(this.config.loginProfileDir, {
        executablePath: this.config.chromeExecutablePath,
        headless: true,
        args: ["--no-first-run", "--no-default-browser-check", "--no-sandbox"],
      });
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const composer = await firstVisible(page, COMPOSER_SELECTOR, 60_000);
        if (!composer) {
          throw new ChatGptError("沒有偵測到登入完成（要看到輸入框才算）。請重開登入並確認已登入 ChatGPT。");
        }
        const state = await context.storageState();
        atomicWriteFile(this.config.storageStatePath, JSON.stringify(state) + "\n");
        writeVerifiedMarker(this.config.storageStatePath);
        return { loggedIn: true, url: page.url() };
      } finally {
        await context.close().catch(() => {});
      }
    } finally {
      this.loginBusy = false;
    }
  }

  /** 自動丟資料 + 接回傳。請求排隊，一次只跑一個分頁。 */
  async ask(prompt: string, options: AskOptions = {}): Promise<AskResult> {
    const task: Promise<AskResult> = this.queue.then(() => this.askOnce(prompt, options));
    // 排隊不斷鏈：失敗也讓下一個能跑。
    this.queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private async askOnce(prompt: string, options: AskOptions = {}): Promise<AskResult> {
    if (this.loginBusy) throw new ChatGptError("登入視窗開著，請先完成登入再問。");
    if (!existsSync(this.config.storageStatePath)) throw new NotLoggedInError();
    const startedAt = Date.now();
    const page = await this.openBrowser();

    const inChat = /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]+/i.test(page.url());
    if (!(options.continueConversation === true && inChat)) {
      await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    const composer = await firstVisible(page, COMPOSER_SELECTOR, 60_000);
    if (!composer) {
      await this.close();
      throw new NotLoggedInError();
    }

    await composer.click({ timeout: 15_000 });
    await composer.press(SELECT_ALL_KEY);
    await composer.press("Backspace");
    // Lexical 編輯器對 fill() 會漏字，用 insertText 最穩（跟上游同做法）。
    await page.keyboard.insertText(prompt);

    if (((await composer.textContent()) ?? "").trim().length === 0) {
      throw new ChatGptError("輸入框沒有收到文字，送出失敗。");
    }

    const before = await countAssistantTurns(page);
    await composer.press("Enter");

    // Enter 沒送出（變多行模式）→ 改按送出鈕（限定 composer 所在 form，避免誤按）。
    await page.waitForTimeout(1_500);
    if ((await countAssistantTurns(page)) === before) {
      const form = composer.locator("xpath=ancestor::form[1]");
      const send = form.locator(SEND_BUTTON_SELECTOR).filter({ visible: true }).first();
      if (await send.isVisible().catch(() => false)) {
        await send.click({ timeout: 10_000 }).catch(() => {});
      } else {
        const fallback = await firstVisible(page, SEND_BUTTON_SELECTOR, 5_000);
        if (fallback) await fallback.click({ timeout: 10_000 }).catch(() => {});
      }
    }

    const reply = await this.waitForReply(page, before, options.signal);
    return { reply, conversationUrl: page.url(), durationMs: Date.now() - startedAt };
  }

  async close(): Promise<void> {
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launching = null;
    await browser?.close().catch(() => {});
  }

  private async openBrowser(): Promise<Page> {
    if (this.loginBusy) throw new ChatGptError("登入視窗開著，請先完成登入。");
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  private async launch(): Promise<Page> {
    const { browser, context, page } = await launchAutomation(this.config);
    browser.on("disconnected", () => {
      if (this.browser === browser) {
        this.browser = null;
        this.context = null;
        this.page = null;
      }
    });
    this.browser = browser;
    this.context = context;
    this.page = page;
    return page;
  }

  /**
   * 接回傳：assistant turn 數量先增加 → 最後一則文字連續 2 秒不變 → stop 鈕消失。
   * 用數量先增加擋掉「沿用舊對話時拿到上一則」的誤判（跟舊版同邏輯，selector 已換新）。
   */
  private async waitForReply(page: Page, before: number, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.config.turnTimeoutMs;
    let lastText = "";
    let stableSince = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ChatGptError("請求已取消。");

      if ((await countAssistantTurns(page)) <= before) {
        lastText = "";
        stableSince = 0;
        await page.waitForTimeout(400);
        continue;
      }

      const text = await readLastAssistantText(page).catch(() => lastText);
      if (text && text !== lastText) {
        lastText = text;
        stableSince = 0;
      } else if (text && stableSince === 0) {
        stableSince = Date.now();
      }

      if (text && stableSince > 0 && Date.now() - stableSince >= 2_000) {
        if (!(await isGenerating(page).catch(() => false))) return text;
      }

      await page.waitForTimeout(500);
    }

    throw new ChatGptError(`等待回覆超過 ${Math.round(this.config.turnTimeoutMs / 1000)} 秒。可以調高 TURN_TIMEOUT_MS。`);
  }

  /** 登出：刪 storageState + 驗證檔。 */
  async logout(): Promise<void> {
    await this.close();
    rmSync(this.config.storageStatePath, { force: true });
    rmSync(verifiedMarkerPath(this.config.storageStatePath), { force: true });
  }
}
