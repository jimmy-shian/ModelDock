# ModelDock 技術架構文件

> ModelDock：Multi-model AI 桌面工作站 · ChatGPT + Gemini + DeepSeek 全本機免外掛自動化與統一網關。

---

## 1. 雙層端口架構與系統總覽 (8765 vs 8766)

ModelDock 採用「**外部統一閘道 + 內部專用引擎**」的雙層分工架構：

```text
       本地客戶端 / AI Coding Agent
 (Cline / Kilo / Cursor / Antigravity / Write_Novel / curl)
                     │
                     ▼ HTTP / SSE 請求 (唯一入口)
 ┌──────────────────────────────────────────────────────────────┐
 │ 【外部統一閘道】ModelDock Electron Desktop App (端口 8765)      │
 │ ├─ /v1/chat/completions  OpenAI 相容標準接口                  │
 │ ├─ /chat                 最穩純文字對話接口                  │
 │ ├─ /v1/models            整合三方可用模型清單                 │
 │ ├─ /v1/status, /health   伺服器狀態與登入健康診斷             │
 │ ├─ Web 儀表板 UI         OpenDesign 深淺雙色操控台            │
 │ ├─ 內嵌瀏覽器 (Chromium)  ChatGPT / Gemini / DeepSeek 獨立容器 │
 │ ├─ ChatGPT 自動化        DOM MutationObserver 輸入與生成      │
 │ └─ 憑證自動萃取器         背景定時萃取 Cookie / Token          │
 └──────────────────────────────┬───────────────────────────────┘
                                │
          ┌─────────────────────┴─────────────────────┐
          │ (若請求為 ChatGPT)                         │ (若請求為 Gemini 或 DeepSeek)
          ▼                                           ▼
   Electron 內嵌 DOM 自動化                    內部轉發 (Loopback Forward)
  (直接操作 ChatGPT Webview)                          │
                                                      ▼
                       ┌──────────────────────────────────────────────┐
                       │ 【內部輔助工作進程】Python Worker (端口 8766)  │
                       │ ├─ run_server.py start --port 8766           │
                       │ ├─ Gemini Web 直連 (StreamGenerate RPC)      │
                       │ ├─ DeepSeek Web 直連 (WASM Keccak-256 PoW)   │
                       │ ├─ MCP Server (Stdio: mcp_server.py)         │
                       │ └─ 憑證接收端 (/v1/cookies, /v1/token)        │
                       └──────────────────────────────────────────────┘
```

---

## 2. 為什麼有兩種端口？8765 與 8766 一樣嗎？

### 兩者**完全不一樣**，職責分工如下：

| 項目 | 端口 8765（對外唯一閘道） | 端口 8766（內部 Python Worker） |
| :--- | :--- | :--- |
| **執行主體** | ModelDock 桌面主程式 (Electron) | 背景 Python 守護行程 (`run_server.py`) |
| **對象** | **所有外部呼叫者** (IDE / Agent / 終端) | **僅供 ModelDock Electron 內部調用** |
| **功能職責** | 統一路由、桌面 GUI、內嵌瀏覽器、ChatGPT 自動化、憑證自動同步 | Gemini RPC 直連、DeepSeek PoW 解題直連、MCP 分析工具 |
| **是否直接暴露** | **是**（外部呼叫請唯一對齊 `8765`） | **否**（退居幕後，由 Electron 在背景自動拉起與守護） |

### 為什麼需要分開為 8765 與 8766？
1. **避免端口衝突 (`EADDRINUSE`)**：
   Electron（桌面 GUI 網關）與 Python（直連運算引擎）在同一部電腦上同時監聽同一端口會拋出衝突例外。
2. **單一端點體驗**：
   外部使用者與 AI 工具無須記住多個端口，永遠統一呼叫 `http://127.0.0.1:8765/v1`。
3. **內部智慧轉發**：
   - 請求若為 `chatgpt-*`：Electron 直接在內嵌頁面操控完成。
   - 請求若為 `gemini-*` 或 `deepseek-*`：Electron 自動將請求轉發至內部 `127.0.0.1:8766`，完成後再串流返回給客戶端。
   - 若 Python Worker 異常斷線，8765 轉發層會即時自動重新喚醒 8766。

---

## 3. 打包與部署架構 (`build-win.bat`)

ModelDock 支援一鍵打包為 Windows NSIS 安裝檔（`ModelDock-*-win-x64.exe`）：

1. **打包配置 (`launcher/package.json`)**：
   透過 `extraFiles` 將以下核心後端檔案複製至安裝根目錄（與 `ModelDock.exe` 同級）：
   - `server/**`（Python 後端服務核心模組）
   - `run_server.py`（Python Worker 入口）
   - `mcp_server.py`（MCP Server 分析工具入口）
   - `desktop_app.py`、`setup_antigravity.py`
   - `gemini_cookies.example.json`、`deepseek_token.example.json`、`mcp_configs/`
2. **路徑動態適配 (`getWorkspaceRoot`)**：
   - 在開發環境下，指向原始碼專案根目錄。
   - 在已打包環境下，自動鎖定 `ModelDock.exe` 所在目錄，確保 `run_server.py` 能被可靠定位並自動啟動。
3. **啟動引導優先順序 (`start_server.bat` / `start_server.ps1`)**：
   - 優先順序 1：本機有 Bun 1.4+ 則執行 `bun start`（原始碼開發模式）。
   - 優先順序 2：若本機已安裝 ModelDock，優先啟動 `%LOCALAPPDATA%\Programs\ModelDock\ModelDock.exe`。
   - 優先順序 3：若存在安裝檔 `ModelDock-*-win-x64.exe` 則啟動安裝程式。
   - 優先順序 4：無 Electron 環境時，退回純 Python 後端獨立運作。
