# ChatDock

把 ChatGPT 網頁版接進本機：內嵌登入頁＋自動丟資料 / 接回傳＋HTTP 埠，拿來做自動化。

```
你的腳本  ──POST /chat──▶  ChatDock（Electron 本地應用） ──▶  內嵌 ChatGPT 網頁
        ◀──{ reply }────                              ◀──
```

參考：https://github.com/miuuyy/codex-chatgpt-web（同樣內含瀏覽器，不依賴系統 Chrome，不用 Python）。
本專案只取上游的登入＋輸入內容＋接回傳做法做自動化，不做 MCP、不操作使用者檔案。

## 需求

- 一般使用：Windows 10/11，直接跑根目錄的 `ChatDock-*.exe` 安裝檔即可，免裝 Chrome、免裝 Python、免裝 Bun。
- 自行開發：需 [Bun](https://bun.sh/) 1.4+（`bun --version` 確認）。

## 快速開始（開發模式）

```bash
bun install --cwd launcher
bun start   # 開本地視窗：左邊控制面板，右邊就是 ChatGPT 登入頁
```

1. 在右邊內嵌頁登入 ChatGPT（看到輸入框就算登入）。
2. 左側狀態變 `[已登入]`（每 5 秒自動刷新）。
3. 在「對話測試」輸入 prompt 送出，或直接打 HTTP（見下）。

登入態留在應用的持久 partition，重開應用還在。身份驗證彈窗留在應用內，不跳外部瀏覽器。
右上 `?` 有使用說明視窗，每個端點都可一鍵複製；太陽圖示切換深色 / 淺色（內嵌頁跟著走）。

## 自動化 HTTP

應用開著，HTTP 就能用。預設 `http://127.0.0.1:8787`。

### `POST /chat`（原生）

送 prompt，拿回回覆。預設每次開新對話，`continue: true` 沿用上一輪。

```bash
curl -X POST http://127.0.0.1:8787/chat \
  -H "content-type: application/json" \
  -d '{"prompt":"用一句話介紹台灣"}'
```

```json
{
  "reply": "台灣是位於東亞的島嶼，以科技產業、美食與多元文化聞名。",
  "conversationUrl": "https://chatgpt.com/c/8f2a…",
  "durationMs": 6420
}
```

純文字 body 也行，方便 shell 管線：

```bash
curl -X POST http://127.0.0.1:8787/chat -H "content-type: text/plain" -d "1+1=?"
```

### `GET /health` / `GET /ready`

```bash
curl http://127.0.0.1:8787/health
```

```json
{ "ok": true, "browserStarted": true, "loggedIn": true, "pageUrl": "https://chatgpt.com/" }
```

`loggedIn` 是 `false` 就去應用右側登入頁登入。

### OpenAI 相容

`BaseURL = http://127.0.0.1:8787/v1`，`Model = gpt-web-port`，`API Key` 有設才需填。

```bash
curl -X POST http://127.0.0.1:8787/v1/chat/completions \
  -H "content-type: application/json" \
  -d '{"model":"gpt-web-port","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="not-needed")
print(c.chat.completions.create(model="gpt-web-port", messages=[{"role": "user", "content": "你好"}]).choices[0].message.content)
```

支援 `stream: true`（SSE 假串流：等整段回來再切塊送）。`temperature` / `max_tokens` 會接受但網頁版無法真正套用。

## 命令列（免視窗，舊路徑）

`src/` 是 Playwright＋系統 Chrome 的舊路徑，保留相容，正式請用 Electron 應用。

```bash
bun run src/cli.ts serve    # 純 HTTP 後端（瀏覽器開 http://127.0.0.1:8787/ 看 UI）
bun run src/cli.ts login    # 開真 Chrome 手動登入（登入後把 Chrome 完全關掉即完成）
bun run src/cli.ts ask "用一句話介紹台灣"
bun run src/cli.ts status   # 檢查登入狀態
bun run src/cli.ts logout   # 清除登入狀態
```

## 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `8787` | 監聽埠號 |
| `HOST` | `127.0.0.1` | 監聽位址。改 `0.0.0.0` 可讓區網其他裝置呼叫 |
| `API_KEY` | 無 | 設定後請求必須帶 `x-api-key`（或 `Authorization: Bearer`） |
| `TURN_TIMEOUT_MS` | `300000` | 單次問答逾時（毫秒） |

範例：

```bash
HOST=0.0.0.0 PORT=9000 API_KEY=my-secret bun start
```

以下只對舊 `src/` 路徑有效：`HEADLESS`、`CHROME_PATH`、`PROFILE_DIR`、`STORAGE_STATE`。

## 一鍵打包（Windows）

雙擊根目錄 `build-win.bat`，它會依序做完：

1. 清除舊編譯產物（根目錄舊安裝檔、`launcher/release`、殘留 `build/` `dist/`）
2. `bun install`（根＋launcher）
3. `electron-builder --win` 編譯安裝檔
4. 把 `ChatDock-*-win-*.exe` 複製到根目錄顯示，並刪掉 `launcher/release` 中間產物

結束後根目錄只留一個安裝檔，雙擊即安裝。手動等價指令：`bun run --cwd launcher package:win`（產物在 `launcher/release`）。

## 錯誤回應

| 狀態碼 | `error` | 原因 |
| --- | --- | --- |
| `400` | `bad_request` | body 沒帶 prompt |
| `401` | `unauthorized` | `API_KEY` 不符 |
| `401` | `not_logged_in` | 還沒登入 ChatGPT |
| `502` | `chatgpt_error` | 網頁操作失敗，詳情看 `message` |

## 注意

- 請求是排隊處理的，同一時間只跑一個問答，同時送多個會依序完成。
- ChatGPT 改了網頁結構就要更新 selector（Electron 版在 [`launcher/electron/automation.cjs`](launcher/electron/automation.cjs)，舊版在 [`src/chatgpt.ts`](src/chatgpt.ts)）。
- 設了 `HOST=0.0.0.0` 等於把你的 ChatGPT 帳號開在區網上，務必搭配 `API_KEY`。

## 專案結構

```
launcher/
  electron/
    main.cjs        應用主程式：視窗＋內嵌頁＋自動化＋HTTP
    automation.cjs  上游 selector＋頁面內執行的輸入/讀取/狀態 JS
    preload.cjs     面板與主程式的 IPC 橋
  renderer/         左側控制面板（狀態自動刷新＋說明視窗＋深淺色）
  package.json      Electron 應用＋electron-builder 打包設定
src/                舊路徑（Playwright＋系統 Chrome，保留相容）
  cli.ts            serve / login / ask / status / logout
  server.ts         HTTP API（原生＋OpenAI 相容＋Web UI）
  chatgpt.ts        Playwright 驅動 ChatGPT 網頁版
  config.ts         設定與 Chrome 路徑偵測
  openai.ts         OpenAI 相容轉接
  ui.ts             Web 版設定介面
build-win.bat       一鍵打包：清產物→編譯→exe 複製到根目錄
```

## 倉庫

https://github.com/jimmy-shian/ChatDock
