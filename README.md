# ModelDock

<p align="center">
  <strong>Multi-model AI 桌面工作站 · ChatGPT + Gemini + DeepSeek 全本機免外掛自動化</strong><br>
  OpenDesign 雙主題面板 · 內嵌多分頁瀏覽器 · 自動 Cookie / Token 萃取 · OpenAI 相容 API · 專用 MCP 分析套件
</p>

---

## 💡 為什麼需要 ModelDock？

以往使用網頁版 AI（ChatGPT、Google Gemini、DeepSeek）串接本機工具或 Coding Agent（如 Cursor、Claude Desktop、Cline、Antigravity）時，常面臨兩大痛點：
1. **Cookie 過期需手動複製**：Chrome / Edge 127+ 的 App-Bound Encryption (ABE) 導致外部程式無法直接解密瀏覽器 Cookie，使用者必須不斷依賴瀏覽器擴充套件手動點擊「匯出」。
2. **多平台各自分散**：ChatGPT 需要一組腳本、Gemini 需要另一套 Bridge、DeepSeek 還要額外解 PoW 算力驗證。

**ModelDock 的解決方案：**
* **內建 Electron 專屬獨立容器**：內嵌獨立的 Chromium 分頁（[ChatGPT] [Gemini] [DeepSeek]），在應用內完成登入後，**Electron 本身即擁有解密權限，自動在背景監聽、擷取並更新 `gemini_cookies.json` 與 `deepseek_token.json`**，徹底終結手動更新與擴充套件依賴！
* **雙通道支援**：
  * **ChatGPT**：精確 DOM 自動化輸入、即時送出驗證、防卡死機制與無痕對話。
  * **Gemini**：直接透過 RPC 進行串流生成，支援 Google 搜尋 Grounding、多模態圖片分析與思考鏈（Thinking）。
  * **DeepSeek**：本地 WASM 執行 Keccak-256 PoW 解題，實現極速直連。
* **雙通訊協議**：
  * 標準 **OpenAI 相容 HTTP 伺服器**（`/v1/chat/completions`）。
  * 完整 **MCP Server (Model Context Protocol)**，供 Cursor、Antigravity、Claude Desktop 調用。

---

## 🎨 介面設計（OpenDesign 規範）

* **雙主題色彩**：深色模式採用 Zinc / Obsidian 極致暗黑，淺色模式採用高易讀 Slate 淨白。
* **左右雙欄分工**：
  * **左側 420px 操控台**：包含三模型即時連線燈號、內嵌分頁快速切換按鈕、端點一鍵複製卡、模型下拉選單與對話測試區。
  * **右側可收合瀏覽器**：自由切換 ChatGPT / Gemini / DeepSeek 官方登入頁，可一鍵隱藏純留控制台。
* **微互動體驗**：所有設定、端點與程式碼均支援一鍵複製與非阻塞 Toast 回饋。

---

## 🚀 快速開始

### 1. 桌面開發模式
需安裝 [Bun](https://bun.sh/) 1.4+：

```bash
# 安裝依賴
bun install
bun install --cwd launcher

# 啟動桌面應用
bun start
```

### 2. 登入三平台（只需一次）
1. 在右側內嵌瀏覽器分別切換分頁：`ChatGPT`、`Gemini`、`DeepSeek`。
2. 在各官網完成帳號登入。
3. ModelDock 會在背景自動將憑證持久保存，即使重開電腦也無需重複登入！

---

## 🌐 API 呼叫指南

服務啟動後，本機即可透過標準 HTTP 存取：

### OpenAI 相容端點 (`/v1/chat/completions`)

```bash
curl -X POST http://127.0.0.1:8765/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemini-web/flash",
    "messages": [
      {"role": "user", "content": "用一句話介紹台灣"}
    ]
  }'
```

### 可用模型一覽

| Model ID | Provider | 特色與後端機制 |
| :--- | :--- | :--- |
| `gemini-web/flash` (預設) | Google Gemini | Cookie 直連 RPC，速度極快，支援視覺與聯網 |
| `chatgpt-web/auto` | OpenAI ChatGPT | Electron 頁面 DOM 自動化，防暫停與送出驗證 |
| `deepseek-web/chat` | DeepSeek | 本機 WASM PoW 算力解題直連 (V3) |
| `deepseek-web/reasoner-search` | DeepSeek | 深度推理 + 實時聯網搜尋直連 (R1) |
| `webchat/auto` | 自動路由 | 根據當前已連線的平台自動分派 |

---

## 🛠️ MCP Server 設定 (Antigravity / Cursor / Claude)

在您的 MCP 設定檔（例如 `claude_desktop_config.json` 或 `cursor_mcp.json`）中加入：

```json
{
  "mcpServers": {
    "modeldock": {
      "command": "C:\\Users\\Administrator\\venv\\Scripts\\python.exe",
      "args": ["C:\\Users\\Administrator\\Desktop\\html_test\\ModelDock\\mcp_server.py"]
    }
  }
}
```

可使用的專屬分析工具：
* `webchat_analyze_code`：多檔案高階架構分析與程式碼審查。
* `webchat_ask`：調用深度思考進行演算法複雜度諮詢。
* `webchat_multimodal_inspect`：傳遞本機截圖進行 UI 樣式與視覺排版診斷。
* `webchat_web_search`：結合 Google 即時搜尋最新文檔與 API。

---

## 📦 Windows 一鍵打包

雙擊執行根目錄的 `build-win.bat`：
1. 自動清除舊產物與快取。
2. 編譯 Electron 安裝程式。
3. 產出 `ModelDock-*-win-*.exe` 獨立安裝檔。

---

## 🧪 測試與驗證

ModelDock 具備 102 項單元測試，完整覆蓋 MCP 協定、WASM PoW 解題、串流配接與沙箱安全：

```powershell
& "C:\Users\Administrator\venv\Scripts\python.exe" -m pytest tests -q
```

---

## 📄 License
MIT License.
