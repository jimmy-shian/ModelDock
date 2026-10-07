"""
FastAPI Application for Gemini Web to Local Bridge.
Exposes OpenAI Chat Completions, Codex/Antigravity Responses API, WebSocket hub, and Web Dashboard.
Modeled after codex-chatgpt-web/src/server.ts.
"""

import os
from pathlib import Path
from typing import Optional, List, Any, Dict
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import StreamingResponse, JSONResponse, FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from server.config import MODEL_CATALOG, BASE_URL, VERSION
from server.protocol import ChatCompletionRequest, ResponsesRequest
from server.bridge.ws_hub import hub
from server.bridge.transport import (
    resolve_turn,
    get_mode,
    set_mode,
    transport_snapshot,
    TransportUnavailable,
)
from server.bridge.session_manager import SessionManager
from server.bridge.stream_adapter import (
    stream_openai_completions,
    stream_responses_api,
    collect_complete_response,
)
from server.browser.gemini_direct import (
    is_configured as direct_is_configured,
    save_cookies,
    load_cookies,
)
from server.browser.deepseek_direct import (
    is_configured as deepseek_is_configured,
    save_token as save_deepseek_token,
    load_token as load_deepseek_token,
)
from server.doctor import run_doctor
from server.mcp.tools_system import get_workspace_status
from server.bridge.ws_hub import setup_clean_logging

import logging

LOGGER = logging.getLogger("webchat2local.bridge")
setup_clean_logging()


app = FastAPI(
    title="Gemini Web to Local Bridge",
    description="Bridge Google Gemini Web to local development environments, MCP, and Google Antigravity.",
    version=VERSION,
)

# Enable CORS for all local tools and browser extension
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATIC_DIR = Path(__file__).parent / "static"


# ==========================================
# Shared Turn Dispatch (single source of truth)
# ==========================================

def _dispatch_turn(
    prompt: str,
    model: str,
    is_new_session: bool = True,
    session_id: Optional[str] = None,
    is_continuation: bool = False,
    files: Optional[list] = None,
):
    """
    Resolve a prompt into a turn generator via the unified transport
    dispatcher. Raises HTTPException(503) when no transport is available.
    Returns (turn_generator, transport_name).
    """
    try:
        try:
            return resolve_turn(
                prompt=prompt,
                model=model,
                is_new_session=is_new_session,
                session_id=session_id,
                is_continuation=is_continuation,
                files=files,
            )
        except TypeError:
            try:
                return resolve_turn(prompt=prompt, model=model, is_new_session=is_new_session)
            except TypeError:
                return resolve_turn(prompt=prompt, model=model)
    except TransportUnavailable as e:
        raise HTTPException(status_code=503, detail=str(e))



# ==========================================
# OpenAI & Responses API Endpoints
# ==========================================

@app.get("/v1/models")
@app.get("/models")
async def list_models():
    """Lists supported Gemini Web models."""
    return {"object": "list", "data": MODEL_CATALOG}


@app.post("/v1/chat/completions")
@app.post("/chat/completions")
async def chat_completions(req: ChatCompletionRequest):
    """
    OpenAI-compatible Chat Completions API endpoint.
    Supports real-time SSE streaming (stream=true) with reasoning_content deltas,
    and structured JSON return (stream=false).

    The transport (direct cookie HTTP vs browser extension WebSocket) is chosen
    by the unified dispatcher; see /v1/transport for runtime selection.
    """
    num_msgs = len(req.messages)
    num_tools = len(req.tools) if req.tools else 0
    is_continuation = SessionManager.is_continuation_turn(req.messages)
    is_new_session = not is_continuation
    session_id = SessionManager.get_conversation_fingerprint(req.messages)

    from server.protocol import extract_images_from_messages
    extracted_files = extract_images_from_messages(req.messages)

    from server.bridge.transport import get_mode
    current_mode = get_mode()
    for_stateful = (current_mode == "direct" or (current_mode == "auto" and direct_is_configured()))
    for_browser = (current_mode == "extension" or (current_mode == "auto" and hub.is_connected and not direct_is_configured()))

    LOGGER.info(
        "📥 [REQ] ChatCompletion 請求 | Model: %s | 訊息數: %d | 工具數: %d | Stream: %s | 會話: %s | SessionID: %s | 附加圖片: %d",
        req.model, num_msgs, num_tools, req.stream, "接續輪次" if is_continuation else "全新任務", session_id[:8], len(extracted_files),
    )

    # 1. Compile multi-turn messages into Gemini prompt (incremental for active stateful session)
    compiled = SessionManager.compile_rich_prompt(
        messages=req.messages,
        tools=req.tools,
        for_browser_session=for_browser,
        for_stateful_session=for_stateful,
    )
    compiled_prompt = compiled.text

    tool_names = []
    for tool in req.tools or []:
        fn = tool.get("function", tool) if isinstance(tool, dict) else {}
        if isinstance(fn, dict) and fn.get("name"):
            tool_names.append(str(fn["name"]))

    # 2. Dispatch turn through the shared transport resolver.
    turn_generator, transport_name = _dispatch_turn(
        prompt=compiled_prompt,
        model=req.model,
        is_new_session=is_new_session,
        session_id=session_id,
        is_continuation=is_continuation,
        files=extracted_files,
    )
    LOGGER.info("🚀 [SEND] 發送至 Gemini | 傳輸: %s | Prompt長度: %d | 新會話: %s", transport_name, len(compiled_prompt), is_new_session)


    if req.stream:
        return StreamingResponse(
            stream_openai_completions(
                turn_generator,
                model=req.model,
                available_tool_names=tool_names,
            ),
            media_type="text/event-stream; charset=utf-8",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
                "X-W2L-Transport": transport_name,
            },
        )
    else:
        resp = await collect_complete_response(
            turn_generator,
            model=req.model,
            available_tool_names=tool_names,
        )
        return resp.model_dump()


@app.post("/v1/responses")
@app.post("/responses")
async def responses_api(req: ResponsesRequest):
    """
    Codex & Google Antigravity Responses API endpoint with SSE streaming.
    """
    if isinstance(req.input, str):
        prompt_text = SessionManager.compile_prompt(messages=[{"role": "user", "content": req.input}], tools=req.tools)
    elif isinstance(req.input, list):
        normalized = []
        for item in req.input:
            if isinstance(item, dict) and item.get("role"):
                normalized.append(item)
            elif isinstance(item, str):
                normalized.append({"role": "user", "content": item})
            else:
                normalized.append({"role": "user", "content": str(item)})
        prompt_text = SessionManager.compile_prompt(messages=normalized, tools=req.tools)
    else:
        prompt_text = SessionManager.compile_prompt(messages=[{"role": "user", "content": str(req.input)}], tools=req.tools)

    turn_generator, transport_name = _dispatch_turn(prompt_text, req.model)

    return StreamingResponse(
        stream_responses_api(turn_generator, model=req.model),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-W2L-Transport": transport_name,
        },
    )


@app.post("/v1/mcp/call")
@app.post("/v1/tunnel/call")
async def mcp_tunnel_call(payload: dict):
    """
    Direct HTTP endpoint for MCP tool execution from extension or external agents.
    """
    tool_name = payload.get("tool") or payload.get("name") or ""
    tool_args = payload.get("arguments") or payload.get("args") or {}
    if not tool_name:
        raise HTTPException(status_code=400, detail="Missing tool name.")

    from server.mcp import execute_mcp_tool
    res = execute_mcp_tool(tool_name, tool_args)
    return res


@app.post("/v1/cookies")
async def save_cookies_endpoint(payload: dict):
    """
    Persist the __Secure-1PSID / __Secure-1PSIDTS cookies sent by the browser
    extension, so the direct (cookie-based) Gemini path can use them.

    The background service worker calls this automatically whenever Google
    rotates the session cookie; the popup button and dashboard use the same
    endpoint manually.
    """
    one_psid = str(payload.get("1psid", "") or payload.get("__Secure-1PSID", "")).strip()
    one_psidts = str(payload.get("1psidts", "") or payload.get("__Secure-1PSIDTS", "")).strip()
    source = str(payload.get("source", "manual") or "manual")
    reason = str(payload.get("reason", "") or "")

    if not one_psid:
        raise HTTPException(status_code=400, detail="1psid is required.")

    current = load_cookies()
    if current.get("1psid") == one_psid and current.get("1psidts") == one_psidts:
        return {"status": "ok", "configured": True, "message": "Cookies unchanged"}

    if not save_cookies(one_psid, one_psidts):
        raise HTTPException(status_code=500, detail="Failed to write gemini_cookies.json.")

    # Hot-reload the direct Gemini engine so updated cookies take effect immediately
    try:
        from server.browser.gemini_direct import reload_client
        await reload_client()
    except Exception as e:
        LOGGER.warning("Direct client hot-reload warning: %s", e)


    hub.logs.log(
        "INFO", "COOKIES",
        f"Cookies updated (source={source}" + (f", reason={reason}" if reason else "") + ")",
    )

    return {"status": "ok", "configured": direct_is_configured()}



@app.post("/v1/deepseek/token")
async def save_deepseek_token_endpoint(payload: dict):
    """
    Persist the DeepSeek userToken for the direct (Token + PoW) path.

    取得方式：登入 https://chat.deepseek.com/a/chat/ 後，在 DevTools Console 執行
      copy(JSON.parse(localStorage.getItem("userToken")).value)
    再 POST {"token": "<貼上>"} 到此端點（或寫入 deepseek_token.json /
    環境變數 DEEPSEEK_TOKEN）。
    """
    raw = str(
        payload.get("token", "")
        or payload.get("userToken", "")
        or payload.get("user_token", "")
        or payload.get("value", "")
    ).strip()
    if not raw:
        raise HTTPException(status_code=400, detail="token is required.")
    # Allow "Bearer xxx" and localStorage JSON blob; normalize for comparison.
    from server.browser.deepseek_direct import _normalize_token
    normalized = _normalize_token(raw)
    current = load_deepseek_token()
    if current.get("token") == normalized:
        return {"status": "ok", "configured": True, "message": "Token unchanged"}

    cookies = str(payload.get("cookies", "") or "").strip()
    session_id = str(payload.get("session_id", "") or "").strip()
    if not save_deepseek_token(normalized, session_id=session_id, cookies=cookies):
        raise HTTPException(status_code=500, detail="Failed to write deepseek_token.json.")

    hub.logs.log("INFO", "DEEPSEEK", "DeepSeek userToken updated via /v1/deepseek/token")
    return {"status": "ok", "configured": deepseek_is_configured()}



# ==========================================
# Transport Mode (direct vs extension selection)
# ==========================================

@app.get("/v1/transport")
async def get_transport():
    """Current transport selection state for the dashboard."""
    return transport_snapshot()


@app.post("/v1/transport")
async def set_transport(payload: dict):
    """
    Select the transport mode at runtime:
      - "auto"      : direct-first when cookies are configured, extension fallback
      - "direct"    : force the cookie path (no browser tab needed)
      - "extension" : force the browser extension path (Gemini tab must be open)
    """
    mode = str(payload.get("mode", "") or "")
    try:
        set_mode(mode)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    hub.logs.log("INFO", "TRANSPORT", f"Transport mode set to '{mode}'")
    return transport_snapshot()


# ==========================================
# Diagnostics, Status & Management
# ==========================================

@app.get("/v1/health")
@app.get("/health")
@app.get("/healthz")
async def health_check():
    return {
        "status": "ok",
        "service": "gemini-web-to-local",
        "version": VERSION,
        "browser_connected": hub.is_connected,
        "direct_configured": direct_is_configured(),
        "deepseek_configured": deepseek_is_configured(),
        "transport_mode": get_mode(),
        "bridge_url": BASE_URL,
        "accepting_turns": not hub.is_draining,
    }


@app.get("/v1/status")
@app.get("/status")
async def system_status():
    status = hub.get_status()
    status["transport"] = transport_snapshot()
    status["workspace"] = get_workspace_status()
    status["doctor"] = run_doctor()
    return status


@app.get("/v1/doctor")
async def get_doctor_report():
    return run_doctor()


@app.get("/v1/logs")
@app.get("/logs")
async def get_logs(limit: int = 100):
    return {"logs": hub.logs.get_logs(limit=limit)}


@app.post("/v1/drain")
async def drain_server(enable: bool = True):
    hub.is_draining = enable
    hub.logs.log("INFO", "SERVER", f"Server drain mode set to {enable}")
    return {"status": "ok", "draining": hub.is_draining, "active_turns": 1 if hub.active_turn_id else 0}


@app.post("/v1/reset")
@app.post("/reset")
async def reset_server_state():
    """Force cancel any running turns, broadcast reset to extension, and clear locks."""
    await hub.reset_all_turns()
    return {"status": "ok", "message": "Browser state and turn locks have been reset."}


@app.post("/v1/dev/turn")
async def dev_synthetic_turn(payload: dict):
    """Synthetic prompt tester for the web dashboard (uses the active transport)."""
    prompt = payload.get("prompt", "")
    model = payload.get("model", "gemini-web/flash")
    if not prompt:
        raise HTTPException(status_code=400, detail="Prompt is required.")

    turn_gen, transport_name = _dispatch_turn(prompt, model)
    return StreamingResponse(
        stream_openai_completions(turn_gen, model=model),
        media_type="text/event-stream",
        headers={"X-W2L-Transport": transport_name},
    )


# ==========================================
# Browser Extension WebSocket Connection
# ==========================================

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await hub.register_connection(websocket)
    try:
        while True:
            raw_msg = await websocket.receive_text()
            try:
                import json
                data = json.loads(raw_msg)
                await hub.handle_incoming_message(data, websocket)
            except Exception as e:
                hub.logs.log("ERROR", "WS", f"Error parsing incoming WS message: {e}")
    except WebSocketDisconnect:
        hub.unregister_connection(websocket)
    except Exception as e:
        hub.unregister_connection(websocket)
        hub.logs.log("WARN", "WS", f"WebSocket exception: {e}")


# ==========================================
# Dashboard & Static Assets
# ==========================================

@app.get("/")
async def serve_dashboard():
    index_file = STATIC_DIR / "index.html"
    if index_file.exists():
        return FileResponse(index_file)
    return {"message": f"Gemini Web to Local Bridge API Running (v{VERSION}). Open /v1/status for diagnostics."}


if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")