# ModelDock 使用指南 (HOW TO USE)

本指南詳細說明如何將 **ModelDock** 作為本地 **統一 AI 桌面工作站**、**專用分析 MCP 伺服器 (Model Context Protocol)** 或 **OpenAI 相容 API (端口 8765)** 使用。

---

## 📌 核心架構理念：為什麼使用 ModelDock？

在實際使用 Cline、Cursor、Kilo Code 等 AI Coding Agent 時，若將網頁端直接當作主模型，常面臨 Cookie 時常過期、需頻繁開外部擴充套件匯出、多平台端口混亂（8787/8765 分散）等問題。

**ModelDock 的統一整理解決方案：**
- **單一 8765 統一閘道**：全面捨棄 8787 端口，外部程式、IDE、curl 測試全面對齊 `http://127.0.0.1:8765/v1`。
- **免裝擴充套件，本地自動抓取憑證**：內建 Chromium 容器分頁，直接在應用內登入 Google Gemini、DeepSeek 或 ChatGPT，系統自動在背景監聽、擷取並即時同步 `gemini_cookies.json` 與 `deepseek_token.json`！瀏覽器擴充套件改為純可選（可有可無）。
- **本地直連 Web 測試**：應用左側控制面板內建「對話測試」，點擊即可直接向 Gemini、ChatGPT、DeepSeek 等發送測試請求。
- **專用 MCP 分析伺服器**：主力 Agent（如 Claude 3.7 / GPT-4o）可透過 MCP 呼叫 Gemini 的超長上下文進行多檔案審查、截圖排錯與聯網檢索。

---

## ⚡ 1. 前置準備 (3 分鐘完成)

### 1.1 環境需求
- 系統：Windows
- Python 虛擬環境：`C:\Users\Administrator\venv\Scripts\python.exe` (或 Python 3.10+)
- 運行環境：[Bun](https://bun.sh/) 1.4+ (或直接執行封裝版 exe)

### 1.2 登入與憑證獲取（本地直接登入，免裝外掛）
1. 啟動 ModelDock 應用：
   ```powershell
   bun start
   # 或雙擊 start_server.bat
   ```
2. 在 ModelDock 右側內嵌瀏覽器分頁分別切換：
   - **Gemini**：登入 Google 帳號一次，ModelDock 自動在背景萃取 `__Secure-1PSID` 並儲存至 `gemini_cookies.json`。
   - **DeepSeek**：登入 DeepSeek 帳號一次，自動萃取 `userToken` 並儲存至 `deepseek_token.json`。
   - **ChatGPT**：登入一次或直接以訪客無痕模式使用。
3. （可選）若您偏好使用外部日常 Chrome / Edge 瀏覽器，仍可在 `chrome://extensions` 載入 `extension/`，它會自動連上 `ws://127.0.0.1:8765/ws`，但**完全不是必須的**。

### 1.3 驗證環境
在終端機執行自我診斷：
```powershell
& "C:\Users\Administrator\venv\Scripts\python.exe" mcp_server.py --doctor
```
看到 `[*] Gemini Cookie Configured: True` 即代表準備就緒！

---

## 🛠️ 2. 各客戶端 MCP 一鍵配置

專案已於 `mcp_configs/` 內建範本，可直接複製：

### 2.1 Cline / Roo Code (VS Code 擴充套件)
在 VS Code 中開啟 Cline 設定 (齒輪) → **MCP Servers** → **Edit MCP Settings** (`cline_mcp_settings.json`)：
```json
{
  "mcpServers": {
    "modeldock-analyzer": {
      "command": "C:\\Users\\Administrator\\venv\\Scripts\\python.exe",
      "args": [
        "C:\\Users\\Administrator\\Desktop\\html_test\\ModelDock\\mcp_server.py"
      ],
      "env": {
        "W2L_WORKSPACE": "${workspaceFolder}"
      },
      "autoApprove": [
        "webchat_analyze_code",
        "webchat_ask",
        "webchat_multimodal_inspect",
        "webchat_web_search"
      ]
    }
  }
}
```

### 2.2 Kilo Code
在 Kilo Code 的 MCP 設定面板中新增伺服器：
- **Server Name**: `modeldock-analyzer`
- **Command**: `C:\Users\Administrator\venv\Scripts\python.exe`
- **Args**: `C:\Users\Administrator\Desktop\html_test\ModelDock\mcp_server.py`
- 或直接匯入 `mcp_configs/kilo_mcp_settings.json`。

### 2.3 Cursor IDE
開啟 `~/.cursor/mcp.json` 或 Cursor Settings → Features → MCP：
```json
{
  "mcpServers": {
    "modeldock-analyzer": {
      "command": "C:\\Users\\Administrator\\venv\\Scripts\\python.exe",
      "args": [
        "C:\\Users\\Administrator\\Desktop\\html_test\\ModelDock\\mcp_server.py"
      ],
      "env": {
        "W2L_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

### 2.4 Claude Desktop
開啟 `%APPDATA%\Claude\claude_desktop_config.json`：
```json
{
  "mcpServers": {
    "modeldock-analyzer": {
      "command": "C:\\Users\\Administrator\\venv\\Scripts\\python.exe",
      "args": [
        "C:\\Users\\Administrator\\Desktop\\html_test\\ModelDock\\mcp_server.py"
      ],
      "env": {
        "W2L_WORKSPACE": "C:\\Users\\Administrator\\Desktop\\html_test\\ModelDock"
      }
    }
  }
}
```

---

## 💡 3. 如何在對話中調用 MCP 工具？

掛載完成後，你的主模型（Claude / GPT-4o 等）會自動感知並呼叫下列工具：

### 3.1 程式碼深層審查 (`webchat_analyze_code`)
- **使用時機**：需要一次性審查多個大型檔案、尋找競態條件 (Race Condition)、邏輯漏洞或架構重構建議。
- **範例提問**：
  > 「請幫我調用 `webchat_analyze_code` 分析 `server/browser/gemini_direct.py` 和 `server/mcp/gemini_analysis_tools.py`，找出任何可能導致死鎖或未捕捉異常的漏洞。」

### 3.2 深度思考諮詢 (`webchat_ask`)
- **使用時機**：複雜演算法設計、架構選型、推導問題。
- **範例提問**：
  > 「請調用 `webchat_ask`，以 Thinking 模式深入推導如何在 Windows 上實現無損記憶體日誌與防溢位環狀緩衝區的最佳架構。」

### 3.3 本機圖片/截圖排錯 (`webchat_multimodal_inspect`)
- **使用時機**：UI 畫面走樣、排版重疊、截圖錯誤分析。
- **範例提問**：
  > 「請用 `webchat_multimodal_inspect` 分析這張截圖 `tests/fixtures/error_ui.png`，指出按鈕錯位的原因。」

### 3.4 即時聯網搜尋 (`webchat_web_search`)
- **使用時機**：查詢最新釋出的套件 API 規格、最新修補版本或官方文件。
- **範例提問**：
  > 「請調用 `webchat_web_search` 搜尋 MCP Python SDK 最新 tools 註冊語法。」

---

## 🌐 4. OpenAI 相容 HTTP 網關 (統一端口 8765)

ModelDock 啟動後，本機即可透過標準 HTTP 存取（端口統一為 **8765**，已徹底廢除 8787）：

- **Base URL**: `http://127.0.0.1:8765/v1`
- **Dashboard Web 儀表板**: `http://127.0.0.1:8765`
- **可用模型**:
  - `gemini-web/flash` (預設，直連極速)
  - `gemini-web/pro` (長上下文 / 推理)
  - `gemini-web/flash-thinking` (深度思考)
  - `chatgpt-web/auto` (內嵌 ChatGPT 自動化)
  - `deepseek-web/chat` (DeepSeek V3 直連)
  - `deepseek-web/reasoner-search` (DeepSeek R1 直連)
  - `webchat/auto` (全自動調度)

### 快速測試範例：

```powershell
# 1. 最穩（純文字 /chat，無 JSON 引號轉義問題）：
curl.exe -X POST http://127.0.0.1:8765/chat -H "Content-Type: text/plain" --data-binary "你好"

# 2. OpenAI 相容端點：
curl.exe -X POST http://127.0.0.1:8765/v1/chat/completions -H "Content-Type: application/json" --data "{\"model\":\"gemini-web/flash\",\"messages\":[{\"role\":\"user\",\"content\":\"你好\"}]}"
```

---

## ❓ 5. 常見問題與排除 (FAQ)

### Q: 提示 `Cookie not found or invalid`？
**解法**：在 ModelDock 應用中點擊右側內嵌分頁「Gemini」，登入一次 Google 帳號，ModelDock 會在背景自動擷取並儲存到 `gemini_cookies.json`。

### Q: 擴充套件需要安裝嗎？
**解法**：完全不需要。ModelDock 已內建獨立瀏覽器容器與自動憑證同步機制。擴充套件為可選項目，只有當你想把現有 Chrome 標籤頁當作橋接時才需要使用。

### Q: 如何執行全套自動化測試？
```powershell
& "C:\Users\Administrator\venv\Scripts\python.exe" -m pytest tests -s
```
