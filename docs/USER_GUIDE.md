# ModelDock 使用說明書 (User Guide)

> 將 **ChatGPT**、**Google Gemini**、**DeepSeek** 網頁版轉為標準本機 OpenAI 相容 API (`http://127.0.0.1:8765/v1`)，供 Cline、Cursor、Antigravity、Claude Desktop、Write_Novel、Aider 等本地工具直接調用。

---

## 1. 快速開始

### 1.1 一鍵啟動

```powershell
# 方式 A：雙擊執行
start_server.bat

# 方式 B：PowerShell 腳本
.\start_server.ps1

# 方式 C：開發模式 (需 Bun 1.4+)
bun start
```

啟動後：
- 桌面開啟 ModelDock 應用視窗（左側控制台，右側內嵌瀏覽器）。
- 統一閘道自動監聽於 `http://127.0.0.1:8765`。
- 背景自動拉起 Python Worker (`8766`) 支援 Gemini RPC 與 DeepSeek PoW。

### 1.2 登入三平台（只需登入一次，免安裝擴充套件）

1. 在 ModelDock 右側分頁切換至：
   - **ChatGPT**：直接使用或登入個人帳號。
   - **Gemini**：登入 Google 帳號一次，系統自動在背景擷取並持久化 Cookies。
   - **DeepSeek**：登入 DeepSeek 帳號一次，系統自動在背景擷取 Token。
2. 憑證自動在背景同步，無需手動複製貼上。

---

## 2. 外部客戶端連線指南 (統一端口 8765)

所有外部客戶端、IDE、腳本統一對齊端口 **8765**：

### 2.1 OpenAI 相容設定
- **Base URL**：`http://127.0.0.1:8765/v1`
- **API Key**：`sk-local`（或任意字串）
- **預設模型**：`gemini-web/flash`

### 2.2 可用模型清單
| 模型 ID | 特色 |
| :--- | :--- |
| `gemini-web/flash` | 速度極快、支援多模態與聯網 Grounding（預設） |
| `gemini-web/pro` | 超大上下文、深度程式碼與架構審查 |
| `gemini-web/flash-thinking` | 深度思考鏈 (Chain-of-Thought) 推理 |
| `chatgpt-web/auto` | ChatGPT 頁面 DOM 自動化 |
| `deepseek-web/chat` | DeepSeek-V3 本機 WASM PoW 直連 |
| `deepseek-web/reasoner-search` | DeepSeek-R1 深度推理 + 聯網搜尋 |
| `webchat/auto` | 根據目前已連線平台自動路由 |

---

## 3. MCP Server 專用分析工具設定

打開 ModelDock 視窗，右上角點擊「？」即可直接複製專屬 MCP 設定或貼給 AI 自動註冊：

```text
ModelDock 已安裝在本機，MCP 伺服器入口是「mcp_server.py」。請你自動偵測本機 Python，把 mcp_server.py 以 stdio 方式註冊為名為 modeldock 的 MCP server。
```
