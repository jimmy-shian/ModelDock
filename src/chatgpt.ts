import { existsSync, mkdirSync } from "node:fs";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { type AppConfig } from "./config";

const CHAT_URL = "https://chatgpt.com/";

/** ChatGPT 輸入框。依序嘗試，命中第一個可見的。 */
const COMPOSER_SELECTOR = [
  "#prompt-textarea",
  "div[contenteditable='true'][id='prompt-textarea']",
  "form[data-chatgpt-composer] div[contenteditable='true']",
  "form[data-chatgpt-composer] textarea",
].join(", ");

const SEND_BUTTON_SELECTOR = [
  "button[data-testid='send-button']",
  "form[data-chatgpt-composer] button[aria-label='Send message']",
  "form[data-chatgpt-composer] button[aria-label='Send prompt']",
].join(", ");

/** 串流中會出現的停止按鈕；消失代表產生結束。 */
const STOP_BUTTON_SELECTOR = [
  "button[data-testid='stop-button']",
  "button[aria-label='Stop generating']",
  "button[aria-label='Stop streaming']",
].join(", ");

const ASSISTANT_SELECTOR = [
  "[data-message-author-role='assistant']",
  "article[data-message-author-role='assistant']",
].join(", ");

const MARKDOWN_SELECTOR = [
  ".markdown",
  ".prose",
  "[data-markdown-text-style='assistant-message']",
].join(", ");

/** 讀回覆時要丟掉的介面雜訊。 */
const CHROME_SELECTOR = [
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
    super("還沒登入 ChatGPT。先執行 `bun run src/cli.ts login` 完成登入。");
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
  /** true = 沿用目前這則對話繼續問；false = 開新對話。 */
  continueConversation?: boolean;
  /** 中斷目前的作答。 */
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

async function firstVisible(scope: Page, selector: string, timeoutMs: number): Promise<Locator | null> {
  try {
    const locator = scope.locator(selector);
    await locator.first().waitFor({ state: "visible", timeout: timeoutMs });
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return count > 0 ? locator.first() : null;
  } catch {
    return null;
  }
}

/** 頁面上可見的 assistant 訊息數量。 */
async function countAssistantMessages(page: Page): Promise<number> {
  return page
    .evaluate(
      selector => Array.from(document.querySelectorAll(selector))
        .filter(element => element.getClientRects().length > 0).length,
      ASSISTANT_SELECTOR,
    )
    .catch(() => 0);
}

/**
 * 讀取最後一則 assistant 回覆的文字。
 * 優先取 markdown 內容根節點，去掉按鈕等介面元素後用 innerText 取得可讀文字。
 */
async function readLastAssistantText(page: Page): Promise<string> {
  return page.evaluate(
    ({ assistantSelector, markdownSelector, chromeSelector }) => {
      const nodes = Array.from(document.querySelectorAll(assistantSelector))
        .filter(element => element.getClientRects().length > 0);
      const last = nodes[nodes.length - 1];
      if (!last) return "";

      const root = last.querySelector(markdownSelector) || last;
      const clone = root.cloneNode(true) as HTMLElement;
      clone.querySelectorAll(chromeSelector).forEach(node => node.remove());
      return (clone.innerText || "").replace(/\u00a0/g, " ").trim();
    },
    {
      assistantSelector: ASSISTANT_SELECTOR,
      markdownSelector: MARKDOWN_SELECTOR,
      chromeSelector: CHROME_SELECTOR,
    },
  );
}

/** true = ChatGPT 還在產生回覆。 */
async function isGenerating(page: Page): Promise<boolean> {
  return page.evaluate(
    selector => Array.from(document.querySelectorAll(selector)).some(element => {
      const button = element as HTMLButtonElement;
      return element.getClientRects().length > 0 && !button.disabled;
    }),
    STOP_BUTTON_SELECTOR,
  );
}

/**
 * 單一持久化瀏覽器工作階段。共用一個分頁，所有請求排隊序列化。
 */
export class ChatGptSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private launching: Promise<Page> | null = null;

  constructor(private readonly config: AppConfig) {}

  get started(): boolean {
    return this.page !== null && !this.page.isClosed();
  }

  /** 測試登入狀態：導到 ChatGPT 首頁後看輸入框有沒有出現。 */
  async checkLogin(timeoutMs = 45_000): Promise<LoginState> {
    const page = await this.openBrowser();
    await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const composer = await firstVisible(page, COMPOSER_SELECTOR, timeoutMs);
    return { loggedIn: composer !== null, url: page.url() };
  }

  /** 只檢查目前頁面，不重新導頁。手動登入流程用這個，才不會一直重載。 */
  async probeLogin(timeoutMs = 5_000): Promise<LoginState> {
    const page = await this.openBrowser();
    const composer = await firstVisible(page, COMPOSER_SELECTOR, timeoutMs);
    return { loggedIn: composer !== null, url: page.url() };
  }

  async ask(prompt: string, options: AskOptions = {}): Promise<AskResult> {
    const startedAt = Date.now();
    const page = await this.openBrowser();

    const inChat = /^https:\/\/chatgpt\.com\/c\/[0-9a-f-]+/i.test(page.url());
    if (!(options.continueConversation === true && inChat)) {
      await page.goto(CHAT_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    const composer = await firstVisible(page, COMPOSER_SELECTOR, 60_000);
    if (!composer) throw new NotLoggedInError();

    await composer.click({ timeout: 15_000 });
    await composer.press(SELECT_ALL_KEY);
    await composer.press("Backspace");
    // ChatGPT 的 Lexical 編輯器對 fill() 的多行輸入會漏字，Input.insertText 才完整。
    await page.keyboard.insertText(prompt);

    if (((await composer.textContent()) ?? "").trim().length === 0) {
      throw new ChatGptError("輸入框沒有收到文字，送出失敗。");
    }

    const before = await countAssistantMessages(page);
    await composer.press("Enter");

    // Enter 沒送出時（例如輸入框變成多行模式），改按送出鈕。
    await page.waitForTimeout(1_500);
    if (await countAssistantMessages(page) === before) {
      const send = await firstVisible(page, SEND_BUTTON_SELECTOR, 5_000);
      if (send) await send.click({ timeout: 10_000 }).catch(() => {});
    }

    const reply = await this.waitForReply(page, before, options.signal);
    return { reply, conversationUrl: page.url(), durationMs: Date.now() - startedAt };
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.page = null;
    this.launching = null;
    await context?.close().catch(() => {});
  }

  private async openBrowser(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;
    if (!this.launching) {
      this.launching = this.launch().finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  private async launch(): Promise<Page> {
    if (!existsSync(this.config.chromeExecutablePath)) {
      throw new ChatGptError(`找不到 Chrome：${this.config.chromeExecutablePath}，用 CHROME_PATH 指定路徑。`);
    }
    mkdirSync(this.config.profileDir, { recursive: true });

    const context = await chromium.launchPersistentContext(this.config.profileDir, {
      executablePath: this.config.chromeExecutablePath,
      headless: this.config.headless,
      viewport: { width: 1440, height: 900 },
      args: [
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-blink-features=AutomationControlled",
        "--disable-features=Translate,OptimizationHints",
      ],
    });
    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(60_000);
    context.on("close", () => {
      this.page = null;
      this.context = null;
    });

    const page = context.pages()[0] ?? await context.newPage();
    this.context = context;
    this.page = page;
    return page;
  }

  /**
   * 輪詢到新一則 assistant 回覆完成為止。
   * 完成條件：assistant 訊息數量先增加、最後一則文字連續 2 秒沒再變動、停止鈕消失。
   * 數量必須先增加，否則沿用舊對話時會把上一則回覆當成本次答案。
   */
  private async waitForReply(page: Page, before: number, signal?: AbortSignal): Promise<string> {
    const deadline = Date.now() + this.config.turnTimeoutMs;
    let lastText = "";
    let stableSince = 0;

    while (Date.now() < deadline) {
      if (signal?.aborted) throw new ChatGptError("請求已取消。");

      if (await countAssistantMessages(page) <= before) {
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
        if (!await isGenerating(page).catch(() => false)) return text;
      }

      await page.waitForTimeout(500);
    }

    throw new ChatGptError(
      `等待回覆超過 ${Math.round(this.config.turnTimeoutMs / 1000)} 秒。可以調高 TURN_TIMEOUT_MS。`,
    );
  }
}
