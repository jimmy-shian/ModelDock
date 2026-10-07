import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  /** 監聽位址。 */
  host: string;
  /** 監聽埠號。 */
  port: number;
  /** 系統 Chrome 路徑。 */
  chromeExecutablePath: string;
  /**
   * 登入狀態檔（storageState JSON）。
   * 參考 miuuyy/codex-chatgpt-web：自動化只用 storageState，不佔用 profile 目錄，
   * 登入才用真 Chrome + 獨立 loginProfile，從此不再有「profile 被鎖住閃退」。
   */
  storageStatePath: string;
  /** 登入用的真 Chrome 暫存 profile（手動登入時才用，平時無 playwright 佔用）。 */
  loginProfileDir: string;
  /** 舊版 profileDir（相容保留，v2 已不再用於自動化）。 */
  profileDir: string;
  /** true = 背景執行；false = 開實體瀏覽器視窗。 */
  headless: boolean;
  /** 單次問答逾時毫秒數。 */
  turnTimeoutMs: number;
  /** 設定後，所有請求都要帶 `x-api-key`。 */
  apiKey?: string;
}

/** UI 可編輯的欄位（寫入檔案，重啟或即時生效）。 */
export interface SettingsPatch {
  host?: string;
  port?: number;
  headless?: boolean;
  turnTimeoutSec?: number;
  profileDir?: string;
  storageStatePath?: string;
  chromeExecutablePath?: string;
  apiKey?: string;
}

export interface SettingsView extends SettingsPatch {
  turnTimeoutMs: number;
  needsRestartFields: string[];
}

/** 專案資料根目錄，預設 `~/.gpt-web-port`。 */
export function configDir(): string {
  return process.env.GPT_WEB_PORT_HOME?.trim() || join(homedir(), ".gpt-web-port");
}

export function configFilePath(): string {
  return join(configDir(), "config.json");
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

function readFileConfig(): Record<string, unknown> {
  try {
    const path = configFilePath();
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, unknown>;
    return {};
  } catch {
    return {};
  }
}

export function loadConfig(): AppConfig {
  const file = readFileConfig();
  const fileStr = (key: string): string | undefined => {
    const value = file[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  const fileInt = (key: string): number | undefined => {
    const value = file[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
    return undefined;
  };
  const fileBool = (key: string): boolean | undefined => {
    const value = file[key];
    if (typeof value === "boolean") return value;
    return undefined;
  };

  const envApiKey = process.env.API_KEY?.trim();
  const fileApiKey = fileStr("apiKey");

  const dir = configDir();
  return {
    host: process.env.HOST?.trim() || fileStr("host") || "127.0.0.1",
    port: envInt(process.env.PORT, fileInt("port") ?? 8787),
    chromeExecutablePath: process.env.CHROME_PATH?.trim() || fileStr("chromeExecutablePath") || defaultChromeExecutable(),
    storageStatePath:
      process.env.STORAGE_STATE?.trim() || fileStr("storageStatePath") || join(dir, "storageState.json"),
    loginProfileDir:
      process.env.LOGIN_PROFILE_DIR?.trim() || fileStr("loginProfileDir") || join(dir, "login-profile"),
    profileDir:
      process.env.PROFILE_DIR?.trim() || fileStr("profileDir") || join(dir, "profile"),
    headless: process.env.HEADLESS !== undefined && process.env.HEADLESS.trim() !== ""
      ? envFlag(process.env.HEADLESS, true)
      : (fileBool("headless") ?? true),
    turnTimeoutMs: envInt(process.env.TURN_TIMEOUT_MS, fileInt("turnTimeoutMs") ?? 300_000),
    ...(envApiKey ? { apiKey: envApiKey } : fileApiKey ? { apiKey: fileApiKey } : {}),
  };
}

/** 把 UI 的設定寫進檔案。回傳合併後的新 config（未自動套用到 runtime，要再呼叫 applySettings）。 */
export function saveSettings(patch: SettingsPatch): AppConfig {
  const dir = configDir();
  mkdirSync(dir, { recursive: true });
  const path = configFilePath();
  const current = readFileConfig();

  const next: Record<string, unknown> = { ...current };
  if (patch.host !== undefined) next.host = patch.host.trim() || "127.0.0.1";
  if (patch.port !== undefined && Number.isFinite(patch.port)) next.port = Math.floor(patch.port);
  if (patch.headless !== undefined) next.headless = patch.headless;
  if (patch.turnTimeoutSec !== undefined && Number.isFinite(patch.turnTimeoutSec)) {
    next.turnTimeoutMs = Math.max(10, Math.floor(patch.turnTimeoutSec)) * 1000;
  }
  if (patch.profileDir !== undefined && patch.profileDir.trim()) next.profileDir = patch.profileDir.trim();
  if (patch.storageStatePath !== undefined && patch.storageStatePath.trim()) {
    next.storageStatePath = patch.storageStatePath.trim();
  }
  if (patch.chromeExecutablePath !== undefined && patch.chromeExecutablePath.trim()) {
    next.chromeExecutablePath = patch.chromeExecutablePath.trim();
  }
  if (patch.apiKey !== undefined) {
    const trimmed = patch.apiKey.trim();
    if (trimmed) next.apiKey = trimmed;
    else delete next.apiKey;
  }

  writeFileSync(path, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return loadConfig();
}

/** 把存檔後的 config 套用到正在跑的 server（免重啟能套的直接套）。 */
export function applySettings(runtime: AppConfig, fresh: AppConfig): { needsRestart: string[] } {
  const needsRestart: string[] = [];

  // 即時生效
  runtime.turnTimeoutMs = fresh.turnTimeoutMs;
  runtime.apiKey = fresh.apiKey;

  // 需重啟 server 或 session 才生效
  if (runtime.host !== fresh.host) {
    runtime.host = fresh.host;
    needsRestart.push("HOST（需重啟服務）");
  }
  if (runtime.port !== fresh.port) {
    runtime.port = fresh.port;
    needsRestart.push("PORT（需重啟服務）");
  }
  if (runtime.headless !== fresh.headless) {
    runtime.headless = fresh.headless;
    needsRestart.push("HEADLESS（需重啟瀏覽器分頁，下次問答自動生效，建議重啟服務）");
  }
  if (runtime.profileDir !== fresh.profileDir) {
    runtime.profileDir = fresh.profileDir;
    needsRestart.push("PROFILE_DIR（舊版相容欄，v2 已不用，需重啟）");
  }
  if (runtime.storageStatePath !== fresh.storageStatePath) {
    runtime.storageStatePath = fresh.storageStatePath;
    needsRestart.push("STORAGE_STATE（需重啟服務）");
  }
  if (runtime.chromeExecutablePath !== fresh.chromeExecutablePath) {
    runtime.chromeExecutablePath = fresh.chromeExecutablePath;
    needsRestart.push("CHROME_PATH（需重啟服務）");
  }

  return { needsRestart };
}

/** 原子寫檔（參考 miuuyy：先寫 tmp 再 rename，避免登入狀態寫一半）。 */
export function atomicWriteFile(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

export function toSettingsView(config: AppConfig): SettingsView {
  return {
    host: config.host,
    port: config.port,
    headless: config.headless,
    turnTimeoutSec: Math.round(config.turnTimeoutMs / 1000),
    profileDir: config.profileDir,
    chromeExecutablePath: config.chromeExecutablePath,
    apiKey: config.apiKey ?? "",
    turnTimeoutMs: config.turnTimeoutMs,
    needsRestartFields: ["host", "port", "profileDir", "chromeExecutablePath"],
  };
}
