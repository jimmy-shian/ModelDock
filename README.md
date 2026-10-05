# gpt-web-port

把 ChatGPT 網頁版包成一個本機 HTTP 埠。丟 prompt 進去，拿回 GPT 回覆，用來做自動化複製貼上。

```
你的腳本  ──POST /chat──▶  這個服務  ──▶  ChatGPT 網頁版（Playwright 驅動你已登入的本機 Chrome）
        ◀──{ reply }────             ◀──
```

## 需求

- [Bun](https://bun.sh) 1.4
- 本機已安裝 Google Chrome（不需要另外下載瀏覽器）

## 安裝

```bash
bun install
```

## 第一次使用：登入 ChatGPT

```bash
bun run src/cli.ts login
```

會開一個 Chrome 視窗，手動登入 ChatGPT。登入狀態存在 `~/.gpt-web-port/profile`，之後不用再登一次。

## 啟動服務

```bash
bun run src/cli.ts serve
```

預設監聽 `http://127.0.0.1:8787`。

## API

### `POST /chat`

送 prompt，拿回回覆。預設每次都開新對話。

```bash
curl -X POST http://127.0.0.1:8787/chat \
  -H "content-type: application/json" \
  -d '{"prompt":"用一句話介紹台灣"}'
```

```json
{
  "reply": "台灣是一座位於東亞的島嶼國家，以科技產業、美食與多元文化聞名。",
  "conversationUrl": "https://chatgpt.com/c/8f2a…",
  "durationMs": 6420
}
```

想沿用上一輪對話，把 `continue` 設成 `true`：

```bash
curl -X POST http://127.0.0.1:8787/chat \
  -H "content-type: application/json" \
  -d '{"prompt":"再短一點","continue":true}'
```

純文字 body 也行，方便 shell 管線：

```bash
curl -X POST http://127.0.0.1:8787/chat -H "content-type: text/plain" -d "1+1=?"
```

只想要純文字回覆：

```bash
curl -s -X POST http://127.0.0.1:8787/chat \
  -H "content-type: application/json" -d '{"prompt":"哈囉"}' | jq -r .reply
```

### `GET /health`

```bash
curl http://127.0.0.1:8787/health
```

```json
{ "ok": true, "browserStarted": true, "loggedIn": true, "pageUrl": "https://chatgpt.com/" }
```

`loggedIn` 是 `false` 就跑一次 `bun run src/cli.ts login`。

## 命令列直接問

不開服務，直接問一次：

```bash
bun run src/cli.ts ask "用一句話介紹台灣"
```

## 環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `8787` | 監聽埠號 |
| `HOST` | `127.0.0.1` | 監聽位址。改成 `0.0.0.0` 可讓區網其他裝置呼叫 |
| `API_KEY` | 無 | 設定後請求必須帶 `x-api-key` |
| `HEADLESS` | `1` | 設 `0` 會顯示瀏覽器視窗，方便看它卡在哪 |
| `CHROME_PATH` | 自動偵測 | 自訂 Chrome 路徑 |
| `PROFILE_DIR` | `~/.gpt-web-port/profile` | 登入狀態存放位置 |
| `TURN_TIMEOUT_MS` | `300000` | 單次問答逾時 |

範例：讓區網內其他裝置可以呼叫，並且加上金鑰。

```bash
HOST=0.0.0.0 PORT=9000 API_KEY=my-secret bun run src/cli.ts serve
```

## 錯誤回應

| 狀態碼 | `error` | 原因 |
| --- | --- | --- |
| `400` | `bad_request` | body 沒帶 prompt |
| `401` | `unauthorized` | `API_KEY` 不符 |
| `401` | `not_logged_in` | 還沒登入 ChatGPT |
| `502` | `chatgpt_error` | 網頁操作失敗，詳情看 `message` |

## 注意

- 請求是排隊處理的，同一時間只跑一個 ChatGPT 分頁，同時送多個會依序完成。
- ChatGPT 改了網頁結構就要更新 [`src/chatgpt.ts`](src/chatgpt.ts) 裡的 selector。
- 設了 `HOST=0.0.0.0` 等於把你的 ChatGPT 帳號開在區網上，務必搭配 `API_KEY`。

## 專案結構

```
src/
  cli.ts      命令列入口：serve / login / ask
  server.ts   HTTP API
  chatgpt.ts  Playwright 驅動 ChatGPT 網頁版
  config.ts   設定與 Chrome 路徑偵測
```
