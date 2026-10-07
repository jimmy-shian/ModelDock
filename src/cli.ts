import { ChatGptSession } from "./chatgpt";
import { configDir, loadConfig } from "./config";
import { createServer } from "./server";

const HELP = `gpt-web-port v2（最小可用：登入 + 自動丟資料/接回傳）

用法：
  bun run src/cli.ts serve    啟動 HTTP 服務 + Web UI（預設）
  bun run src/cli.ts login    開真 Chrome 手動登入（登入後把 Chrome 完全關掉即完成）
  bun run src/cli.ts ask "…"  命令列問一次，不啟動服務
  bun run src/cli.ts status   檢查登入狀態
  bun run src/cli.ts logout   清除登入狀態

UI：
  http://127.0.0.1:8787/      設定介面（狀態/登入/測試）
  POST /chat                  原生：{ "prompt": "...", "continue": false }
  POST /v1/chat/completions   OpenAI 相容：{ "model": "gpt-web-port", "messages": [...] }
  GET  /v1/models             模型列表

環境變數：
  PORT              埠號，預設 8787
  HOST              監聽位址，預設 127.0.0.1
  API_KEY           設定後請求需帶 x-api-key（或 Authorization: Bearer）
  HEADLESS          0 會顯示瀏覽器視窗，預設 1
  CHROME_PATH       自訂 Chrome 路徑
  STORAGE_STATE     登入狀態檔路徑，預設 ~/.gpt-web-port/storageState.json
  TURN_TIMEOUT_MS   單次問答逾時，預設 300000
  OPEN_UI           設 1 啟動後自動開瀏覽器到 UI
`;

async function login(config = loadConfig()): Promise<void> {
  const session = new ChatGptSession(config);
  console.log("即將開啟真 Chrome 登入視窗。");
  console.log("步驟：1) 在 Chrome 完成 ChatGPT 登入 2) 確認看到輸入框 3) 把 Chrome「完全關掉」（右上 X，背景也要關）。");
  console.log(`登入狀態將存到：${config.storageStatePath}`);
  try {
    const state = await session.openLoginWindow();
    console.log(`登入完成：${state.url}`);
    console.log("接著執行 `bun run src/cli.ts serve` 啟動自動化服務。");
  } finally {
    await session.close();
  }
}

async function ask(config = loadConfig()): Promise<void> {
  const prompt = process.argv.slice(3).join(" ").trim();
  if (!prompt) throw new Error("請在指令後面加上要問的內容。");

  const session = new ChatGptSession(config);
  try {
    const result = await session.ask(prompt);
    console.log(result.reply);
  } finally {
    await session.close();
  }
}

async function status(config = loadConfig()): Promise<void> {
  const session = new ChatGptSession(config);
  try {
    const state = await session.checkLogin(30_000);
    console.log(state.loggedIn ? `已登入：${state.url}` : "未登入：請跑 `bun run src/cli.ts login`。");
    if (!state.loggedIn) process.exitCode = 1;
  } finally {
    await session.close();
  }
}

async function logout(config = loadConfig()): Promise<void> {
  const session = new ChatGptSession(config);
  await session.logout();
  console.log("已清除登入狀態。");
}

async function serve(config = loadConfig()): Promise<void> {
  const session = new ChatGptSession(config);
  let server: ReturnType<typeof createServer>;
  try {
    server = createServer(config, session);
  } catch (error) {
    console.error(`啟動失敗（${(error as Error).message}）：port ${config.port} 可能被舊服務佔用。`);
    process.exit(1);
  }

  const baseUrl = `http://${config.host}:${server.port}`;
  console.log(`服務已啟動：${baseUrl}`);
  console.log(`UI：${baseUrl}/`);
  console.log(`OpenAI BaseURL：${baseUrl}/v1`);
  console.log(`登入狀態檔：${config.storageStatePath}`);
  console.log("資料目錄設定在 " + configDir());

  if ((process.env.OPEN_UI ?? "").trim() === "1") {
    const cmd = process.platform === "win32"
      ? ["cmd", "/c", "start", "", baseUrl]
      : process.platform === "darwin"
        ? ["open", baseUrl]
        : ["xdg-open", baseUrl];
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"] });
  }

  const shutdown = async () => {
    console.log("\n關閉中…");
    server.stop();
    await session.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

const command = process.argv[2] ?? "serve";

try {
  switch (command) {
    case "serve": await serve(); break;
    case "login": await login(); break;
    case "ask": await ask(); break;
    case "status": await status(); break;
    case "logout": await logout(); break;
    case "help":
    case "--help":
    case "-h": console.log(HELP); break;
    default:
      console.error(`未知指令：${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
