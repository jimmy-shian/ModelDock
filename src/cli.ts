import { ChatGptSession } from "./chatgpt";
import { configDir, loadConfig } from "./config";
import { createServer } from "./server";

const HELP = `gpt-web-port

用法：
  bun run src/cli.ts serve    啟動 HTTP 服務（預設）
  bun run src/cli.ts login    開瀏覽器手動登入 ChatGPT
  bun run src/cli.ts ask "…"  命令列問一次，不啟動服務

環境變數：
  PORT              埠號，預設 8787
  HOST              監聽位址，預設 127.0.0.1
  API_KEY           設定後請求需帶 x-api-key
  HEADLESS          0 會顯示瀏覽器視窗，預設 1
  CHROME_PATH       自訂 Chrome 路徑
  PROFILE_DIR       自訂瀏覽器 profile 目錄
  TURN_TIMEOUT_MS   單次問答逾時，預設 300000
`;

async function login(config = loadConfig()): Promise<void> {
  const session = new ChatGptSession({ ...config, headless: false });
  console.log(`開啟 Chrome 視窗，請完成登入。profile：${config.profileDir}`);
  try {
    await session.checkLogin(60_000);
    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
      const state = await session.probeLogin(2_000).catch(() => ({ loggedIn: false, url: "" }));
      if (state.loggedIn) {
        console.log("登入完成，可以關掉視窗。接著執行 `bun run src/cli.ts serve`。");
        return;
      }
      await Bun.sleep(2_000);
    }
    throw new Error("5 分鐘內沒有偵測到登入完成。");
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

async function serve(config = loadConfig()): Promise<void> {
  const session = new ChatGptSession(config);
  const server = createServer(config, session);

  console.log(`服務已啟動：http://${config.host}:${server.port}`);
  console.log(`profile：${config.profileDir}`);
  console.log("資料目錄設定在 " + configDir());

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
