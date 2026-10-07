"""
WebSocket connection hub and real-time event router for Gemini Web extension.
Provides zero-disk-wear in-memory circular logging, async turn dispatching,
and graceful connection draining.
"""

import asyncio
import collections
import json
import time
import uuid
import gc
import logging
from typing import Dict, Any, Optional, AsyncGenerator, Set
from fastapi import WebSocket, WebSocketDisconnect

from server.config import DEFAULT_BROWSER_TIMEOUT, WEBSOCKET_HEARTBEAT_INTERVAL, MAX_IN_MEMORY_LOGS

LOGGER = logging.getLogger("webchat2local.bridge")
LOG_FILE = str((__import__("pathlib").Path(__file__).resolve().parents[2] / "webchat2local.local.log"))
if not any(isinstance(h, logging.FileHandler) and getattr(h, "baseFilename", "") == LOG_FILE for h in LOGGER.handlers):
    _fh = logging.FileHandler(LOG_FILE, encoding="utf-8")
    _fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    LOGGER.addHandler(_fh)
LOGGER.setLevel(logging.INFO)


class EndpointFilter(logging.Filter):
    """Filters out high-frequency polling requests from console logs."""
    EXCLUDE_PATHS = (
        "/v1/status", "/status",
        "/v1/logs", "/logs",
        "/v1/transport",
        "/v1/health", "/health", "/healthz",
        "/static/", "/favicon.ico",
    )

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        if "GET " in msg and any(path in msg for path in self.EXCLUDE_PATHS):
            return False
        return True


def setup_clean_logging():
    """Configures clean logging and silences polling noise."""
    uvicorn_access = logging.getLogger("uvicorn.access")
    if not any(isinstance(f, EndpointFilter) for f in uvicorn_access.filters):
        uvicorn_access.addFilter(EndpointFilter())

    root_logger = logging.getLogger()
    if not any(isinstance(f, EndpointFilter) for f in root_logger.filters):
        root_logger.addFilter(EndpointFilter())


setup_clean_logging()


class TurnEvent:
    def __init__(
        self,
        event_type: str,  # "delta", "thought_delta", "done", "error"
        text: Optional[str] = None,
        delta: Optional[str] = None,
        thought: Optional[str] = None,
        thought_delta: Optional[str] = None,
        error: Optional[str] = None,
        meta: Optional[Dict[str, Any]] = None,
    ):
        self.type = event_type
        self.text = text or ""
        self.delta = delta or ""
        self.thought = thought or ""
        self.thought_delta = thought_delta or ""
        self.error = error
        self.meta = meta or {}
        self.timestamp = time.time()


class InMemoryLogBuffer:
    """Zero-SSD-wear in-memory circular log buffer."""
    def __init__(self, maxlen: int = MAX_IN_MEMORY_LOGS):
        self._logs = collections.deque(maxlen=maxlen)

    def log(self, level: str, source: str, message: str, details: Optional[Dict[str, Any]] = None):
        entry = {
            "id": uuid.uuid4().hex[:8],
            "time": time.strftime("%H:%M:%S"),
            "timestamp": time.time(),
            "level": level.upper(),
            "source": source,
            "message": message,
            "details": details or {},
        }
        self._logs.append(entry)

    def get_logs(self, limit: int = 100):
        return list(self._logs)[-limit:]

    def clear(self):
        self._logs.clear()


class BrowserWebSocketHub:
    def __init__(self):
        self.active_connections: Set[WebSocket] = set()
        # Per-tab platform tracking ("gemini" / "chatgpt") so submit_prompt
        # can be routed to the correct tab instead of blindly broadcast to all.
        self.connection_platforms: Dict[Any, str] = {}
        self.browser_info: Dict[str, Any] = {
            "connected": False,
            "page_url": None,
            "model_name": None,
            "last_seen": 0,
        }
        self.active_turn_id: Optional[str] = None
        self.turn_queues: Dict[str, asyncio.Queue[TurnEvent]] = {}
        self.global_turn_lock = asyncio.Lock()
        self.logs = InMemoryLogBuffer(maxlen=MAX_IN_MEMORY_LOGS)
        self.is_draining = False

    @property
    def is_connected(self) -> bool:
        return len(self.active_connections) > 0

    def connected_platforms(self) -> Dict[str, int]:
        """Per-tab platform census ({"chatgpt": n, "gemini": m, ...}).

        browser_info only keeps the LAST reporter's platform, so with both a
        Gemini tab and a ChatGPT tab open it flips back and forth. Routing and
        the dashboard must use this per-tab view instead.
        """
        counts: Dict[str, int] = {}
        for ws in list(self.active_connections):
            p = str(self.connection_platforms.get(ws) or "unknown").lower()
            if p not in ("gemini", "chatgpt"):
                p = "unknown"
            counts[p] = counts.get(p, 0) + 1
        return counts

    def get_status(self) -> Dict[str, Any]:
        return {
            "browser_connected": self.is_connected,
            "active_tabs": len(self.active_connections),
            "platforms": self.connected_platforms(),
            "browser_info": self.browser_info,
            "active_turn": self.active_turn_id,
            "has_active_turn": self.active_turn_id is not None,
            "is_draining": self.is_draining,
        }

    async def register_connection(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.add(websocket)
        self.connection_platforms.setdefault(websocket, "unknown")
        self.browser_info["connected"] = True
        self.browser_info["last_seen"] = time.time()
        self.logs.log("INFO", "HUB", "Gemini Web extension connected via WebSocket.")
        LOGGER.info("🟢 [WS] 擴充套件已連線 (現有標籤頁數: %d)", len(self.active_connections))

    def unregister_connection(self, websocket: WebSocket):
        self.active_connections.discard(websocket)
        self.connection_platforms.pop(websocket, None)
        if not self.active_connections:
            self.browser_info["connected"] = False
            self.logs.log("WARN", "HUB", "Gemini Web extension disconnected (0 tabs active).")
        else:
            self.logs.log("WARN", "HUB", "Extension tab disconnected "
                          f"({len(self.active_connections)} tabs remain).")
        if self.active_turn_id:
            self.logs.log("WARN", "TURN",
                          f"Disconnect during active {self.active_turn_id} "
                          f"({len(self.active_connections)} tabs remain).")
        LOGGER.info("🔴 [WS] 擴充套件中斷 (剩餘標籤頁數: %d)", len(self.active_connections))

    def _platform_of(self, websocket: Any) -> str:
        """Best-effort platform lookup for a connection (URL first, registry second)."""
        url = ""
        try:
            url = str(getattr(websocket, "url", {}).path or "")
        except Exception:
            pass
        # WebSocket URL doesn't carry the origin page; rely on the registry.
        return self.connection_platforms.get(websocket) or "unknown"

    async def broadcast(self, message: Dict[str, Any], platform: Optional[str] = None):
        """Sends a JSON message to extension tabs.

        When `platform` is given, only tabs whose registered platform matches
        receive the message (falling back to all tabs if none matched). This
        prevents cross-platform races when both a Gemini tab and a ChatGPT tab
        are connected at the same time.
        """
        payload = json.dumps(message, ensure_ascii=False)
        targets = list(self.active_connections)
        if platform:
            matched = [ws for ws in targets if self.connection_platforms.get(ws) == platform]
            if matched:
                targets = matched
        dead = []
        for ws in targets:
            try:
                await ws.send_text(payload)
            except Exception:
                dead.append(ws)
        for d in dead:
            self.unregister_connection(d)

    async def handle_incoming_message(self, data: Dict[str, Any], websocket: Any = None):
        """Routes incoming messages from the browser extension."""
        msg_type = data.get("type")
        turn_id = data.get("turn_id")
        self.browser_info["last_seen"] = time.time()
        LOGGER.debug(
            "RX browser | type=%s turn=%s text_len=%d delta_len=%d thought_len=%d model=%s keys=%s",
            msg_type, turn_id or "-", len(str(data.get("text", ""))),
            len(str(data.get("delta", ""))), len(str(data.get("thought", ""))),
            self.browser_info.get("model_name") or "-", ",".join(sorted(data.keys())),
        )

        if msg_type in ("ready", "status"):
            meta = data.get("meta", {})
            url = str(meta.get("url", ""))
            plat = meta.get("platform")
            if not plat:
                plat = "chatgpt" if "chatgpt" in url else "gemini"
            # Remember which tab reported this platform so turns can be routed.
            if websocket is not None:
                self.connection_platforms[websocket] = plat
            self.browser_info.update({
                "connected": True,
                "page_url": url or None,
                "platform": plat,
                "model_name": meta.get("model", "WebChat Web"),
                "last_seen": time.time(),
            })
            self.logs.log("DEBUG", "BROWSER", f"Browser status update: {self.browser_info.get('model_name')} ({plat})")
            return

        if msg_type == "pong":
            return

        if msg_type == "debug":
            # 擴充套件回報的抓取證據（URL / content-type / 首字），直接進
            # /v1/logs 與 webchat2local.local.log，回答「GPT 網頁到底回什麼」。
            scope = str(data.get("scope", "capture") or "capture")[:24]
            text = str(data.get("text", "") or "")[:300]
            self.logs.log("DEBUG", "CAPTURE", f"[{scope}] {text}")
            LOGGER.info("🔍 [CAPTURE %s] %s", scope, text[:280])
            return

        if msg_type == "call_mcp_tool":
            call_id = data.get("call_id") or uuid.uuid4().hex[:8]
            tool_name = data.get("tool") or data.get("name") or ""
            tool_args = data.get("arguments") or {}
            LOGGER.info("🔧 [TUNNEL MCP] 收到瀏覽器擴充套件調用本地工具: %s(%s)", tool_name, str(tool_args)[:100])
            from server.mcp import execute_mcp_tool
            res = execute_mcp_tool(tool_name, tool_args)
            await self.broadcast({
                "type": "mcp_tool_result",
                "call_id": call_id,
                "tool": tool_name,
                "result": res,
            })
            LOGGER.info("✅ [TUNNEL MCP] 本地工具執行完成: %s | Status: %s", tool_name, res.get("status", "done"))
            return

        # File-log every turn event received from the browser so failures are
        # diagnosable from webchat2local.local.log (in-memory log is volatile).
        if msg_type in ("chunk", "done", "error") and turn_id:
            LOGGER.info(
                "📥 [WS RX] %s | Turn: %s | text_len=%d | error=%s",
                msg_type,
                turn_id,
                len(str(data.get("text", ""))),
                str(data.get("error") or "-")[:160],
            )

        # Handle active turn streaming events
        if turn_id and turn_id in self.turn_queues:
            queue = self.turn_queues[turn_id]

            if msg_type == "chunk":
                delta = data.get("delta", "")
                text = data.get("text", "")
                thought_delta = data.get("thought_delta", "")
                thought = data.get("thought", "")
                event = TurnEvent(
                    event_type="delta",
                    text=text,
                    delta=delta,
                    thought=thought,
                    thought_delta=thought_delta,
                )
                await queue.put(event)

            elif msg_type == "done":
                text = data.get("text", "")
                thought = data.get("thought", "")
                event = TurnEvent(
                    event_type="done",
                    text=text,
                    thought=thought,
                )
                await queue.put(event)
                self.logs.log("INFO", "TURN", f"Turn {turn_id} completed successfully.")

            elif msg_type == "error":
                err_msg = data.get("error", "Unknown browser error")
                event = TurnEvent(
                    event_type="error",
                    error=err_msg,
                )
                await queue.put(event)
                self.logs.log("ERROR", "TURN", f"Turn {turn_id} failed: {err_msg}")

    async def execute_turn(
        self,
        prompt: str,
        model: str = "gemini-web/flash",
        timeout_sec: int = DEFAULT_BROWSER_TIMEOUT,
        is_new_session: bool = True,
        platform: Optional[str] = None,
    ) -> AsyncGenerator[TurnEvent, None]:
        """
        Executes a prompt turn on Gemini Web and streams back incremental TurnEvents.
        """
        if self.is_draining:
            yield TurnEvent(
                event_type="error",
                error="Server is currently draining/shutting down. New turns rejected.",
            )
            return

        if not self.is_connected:
            self.logs.log("ERROR", "TURN", "Rejected turn: Gemini Web extension is not connected.")
            yield TurnEvent(
                event_type="error",
                error="Gemini Web extension is not connected. Please open https://gemini.google.com in Chrome or Edge.",
            )
            return

        turn_id = f"turn_{uuid.uuid4().hex[:12]}"
        queue: asyncio.Queue[TurnEvent] = asyncio.Queue()

        async with self.global_turn_lock:
            self.active_turn_id = turn_id
            self.turn_queues[turn_id] = queue
            session_tag = "新會話" if is_new_session else "接續會話"
            self.logs.log("INFO", "TURN", f"Starting turn {turn_id} ({session_tag}, model={model}, prompt_len={len(prompt)})")
            LOGGER.info("🚀 [WS SEND] 發送至擴充套件 | Turn: %s (%s) | Model: %s | Prompt長度: %d", turn_id, session_tag, model, len(prompt))

            try:
                # Route the turn to the tab whose platform matches the model,
                # so a concurrently open Gemini tab never races a ChatGPT turn.
                # An explicit platform (e.g. resolved for the generic
                # webchat/auto route) wins over the model-name heuristic.
                if platform in ("chatgpt", "gemini"):
                    target_platform = platform
                else:
                    target_platform = "chatgpt" if "chatgpt" in (model or "").lower() else "gemini"
                await self.broadcast({
                    "type": "submit_prompt",
                    "turn_id": turn_id,
                    "prompt": prompt,
                    "model": model,
                    "is_new_session": is_new_session,
                }, platform=target_platform)

                start_time = time.time()
                accumulated_text = ""
                accumulated_thought = ""
                # 快照回合開始時的連線：若這些連線全滅（分頁重載），即使有
                # 新連線進來，原頁面上下文也已銷毀，不可能再回傳，必須速敗。
                start_conns = set(self.active_connections)

                while True:
                    remaining_timeout = timeout_sec - (time.time() - start_time)
                    if remaining_timeout <= 0:
                        self.logs.log("ERROR", "TURN", f"Turn {turn_id} timed out after {timeout_sec}s.")
                        LOGGER.error(
                            "⏱️ [WS TIMEOUT] Turn %s 等待 %ds 逾時 | 累積輸出: %d chars | 可能原因：分頁於回合中重新載入或未回傳任何事件",
                            turn_id, timeout_sec, len(accumulated_text),
                        )
                        yield TurnEvent(event_type="error", error=f"Gemini Web response timed out ({timeout_sec}s).")
                        break

                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=min(remaining_timeout, 5.0))
                    except asyncio.TimeoutError:
                        if not self.is_connected:
                            yield TurnEvent(event_type="error", error="Browser extension disconnected during generation.")
                            break
                        if start_conns and not (start_conns & self.active_connections):
                            self.logs.log("ERROR", "TURN",
                                          f"Turn {turn_id} failed: page reloaded during generation.")
                            LOGGER.error("🔄 [WS RELOAD] Turn %s 執行中分頁重新載入，原頁面上下文已銷毀", turn_id)
                            yield TurnEvent(
                                event_type="error",
                                error="頁面在回合執行中重新載入（原分頁上下文已銷毀），請重送一次。",
                            )
                            break
                        continue

                    if event.type == "delta":
                        accumulated_text = event.text or (accumulated_text + event.delta)
                        accumulated_thought = event.thought or (accumulated_thought + event.thought_delta)
                        yield event

                    elif event.type == "done":
                        if event.text:
                            accumulated_text = event.text
                        if event.thought:
                            accumulated_thought = event.thought
                        yield event
                        LOGGER.info("✅ [WS DONE] 擴充套件回應完成 | Turn: %s | 輸出長度: %d | 耗時: %.2fs", turn_id, len(accumulated_text), (time.time() - start_time))
                        break

                    elif event.type == "error":
                        yield event
                        LOGGER.error("❌ [WS ERROR] 擴充套件回應失敗 | Turn: %s | 錯誤: %s | 耗時: %.2fs", turn_id, event.error, (time.time() - start_time))
                        break

            finally:
                self.turn_queues.pop(turn_id, None)
                if self.active_turn_id == turn_id:
                    self.active_turn_id = None
                gc.collect()

    async def reset_all_turns(self):
        """Force cancel any running turns, broadcast reset to extension, and clear locks."""
        self.active_turn_id = None
        for tid, q in list(self.turn_queues.items()):
            await q.put(TurnEvent(event_type="error", error="Turn aborted by reset command."))
        self.turn_queues.clear()
        await self.broadcast({"type": "reset"})
        self.logs.log("WARN", "HUB", "All browser turns and locks force reset.")


# Global WebSocket Hub instance
hub = BrowserWebSocketHub()
