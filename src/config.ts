import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  /** 監聽位址。 */
  host: string;
  /** 監聽埠號。 */
  port: number;
  /** 系統 Chrome 路徑。 */
  chromeExecutablePath: string;
  /** 持久化瀏覽器 profile，ChatGPT 登入狀態存在這裡。 */
  profileDir: string;
  /** true = 背景執行；false = 開實體瀏覽器視窗。 */
  headless: boolean;
  /** 單次問答逾時毫秒數。 */
  turnTimeoutMs: number;
  /** 設定後，所有請求都要帶 `x-api-key`。 */
  apiKey?: string;
}

/** 專案資料根目錄，預設 `~/.gpt-web-port`。 */
export function configDir(): string {
  return process.env.GPT_WEB_PORT_HOME?.trim() || join(homedir(), ".gpt-web-port");
}

export function defaultChromeExecutable(): string {
  const override = process.env.CHROME_PATH?.trim();
  if (override) return override;

  if (process.platform === "win32") {
    const bases = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA];
    for (const base of bases) {
      if (!base) continue;
      const candidate = join(base, "Google", "Chrome", "Application", "chrome.exe");
      if (existsSync(candidate)) return candidate;
    }
    return join("C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe");
  }

  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }

  for (const candidate of ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"]) {
    if (existsSync(candidate)) return candidate;
  }
  return "/usr/bin/google-chrome";
}

function envFlag(value: string | undefined, fallback: boolean): boolean {
  const raw = value?.trim().toLowerCase();
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function envInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function loadConfig(): AppConfig {
  return {
    host: process.env.HOST?.trim() || "127.0.0.1",
    port: envInt(process.env.PORT, 8787),
    chromeExecutablePath: defaultChromeExecutable(),
    profileDir: process.env.PROFILE_DIR?.trim() || join(configDir(), "profile"),
    headless: envFlag(process.env.HEADLESS, true),
    turnTimeoutMs: envInt(process.env.TURN_TIMEOUT_MS, 300_000),
    ...(process.env.API_KEY?.trim() ? { apiKey: process.env.API_KEY.trim() } : {}),
  };
}
