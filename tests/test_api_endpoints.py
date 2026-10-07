"""
FastAPI Endpoints Unit Test Suite.
Tests /v1/models, /v1/health, /v1/status, /v1/doctor, /v1/logs, /v1/transport,
and /v1/chat/completions.
"""

import sys
import pytest
from pathlib import Path
from fastapi.testclient import TestClient

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.app import app
from server.bridge.ws_hub import hub, TurnEvent
from server.bridge import transport as transport_mod

client = TestClient(app)


def test_get_models_endpoint():
    resp = client.get("/v1/models")
    assert resp.status_code == 200
    data = resp.json()
    assert data["object"] == "list"
    model_ids = [m["id"] for m in data["data"]]
    assert "gemini-web/flash" in model_ids
    assert "chatgpt-web/auto" in model_ids
    assert "deepseek-web/chat" in model_ids


def test_get_health_endpoint():
    resp = client.get("/v1/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "browser_connected" in data
    assert "direct_configured" in data
    assert "transport_mode" in data
    assert "accepting_turns" in data


def test_get_status_endpoint():
    resp = client.get("/v1/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "browser_connected" in data
    assert "transport" in data
    assert "workspace" in data
    assert "doctor" in data


def test_get_doctor_endpoint():
    resp = client.get("/v1/doctor")
    assert resp.status_code == 200
    data = resp.json()
    assert "overall_status" in data
    assert "checks" in data


def test_get_logs_endpoint():
    resp = client.get("/v1/logs")
    assert resp.status_code == 200
    data = resp.json()
    assert "logs" in data


def test_get_transport_endpoint():
    resp = client.get("/v1/transport")
    assert resp.status_code == 200
    data = resp.json()
    assert data["mode"] in ("auto", "direct", "extension")
    assert "valid_modes" in data
    assert "direct_configured" in data
    assert "browser_connected" in data


def test_set_transport_mode():
    original = transport_mod.get_mode()
    try:
        resp = client.post("/v1/transport", json={"mode": "direct"})
        assert resp.status_code == 200
        data = resp.json()
        assert data["mode"] == "direct"
    finally:
        transport_mod.set_mode(original)


def test_set_transport_invalid_mode(monkeypatch):
    def bad_set(m):
        raise ValueError("Invalid transport mode")
    monkeypatch.setattr("server.app.set_mode", bad_set)
    resp = client.post("/v1/transport", json={"mode": "bogus"})
    assert resp.status_code == 400


def test_chat_completions_disconnected_error(monkeypatch):
    """When no transport is available, return HTTP 503."""
    def no_transport(prompt, model):
        raise transport_mod.TransportUnavailable(
            "Gemini Web 瀏覽器擴充套件未連線，且沒有可用的 cookie 直連設定。"
        )
    monkeypatch.setattr("server.app.resolve_turn", no_transport)
    payload = {
        "model": "gemini-web/pro",
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": False,
    }
    resp = client.post("/v1/chat/completions", json=payload)
    assert resp.status_code == 503
    assert "未連線" in resp.json()["detail"]


def test_chat_completions_uses_unified_transport(monkeypatch):
    """The unified dispatcher is the single source of truth for transport."""
    calls = []

    def fake_resolve(prompt, model):
        calls.append(model)

        async def gen():
            yield TurnEvent(event_type="delta", text="unified answer", delta="unified answer")
            yield TurnEvent(event_type="done", text="unified answer")

        return gen(), "direct"

    monkeypatch.setattr("server.app.resolve_turn", fake_resolve)
    resp = client.post("/v1/chat/completions", json={
        "model": "gemini-web/pro",
        "messages": [{"role": "user", "content": "Hello"}],
        "stream": False,
    })
    assert resp.status_code == 200
    assert resp.json()["choices"][0]["message"]["content"] == "unified answer"
    assert calls == ["gemini-web/pro"]


def test_dashboard_root():
    resp = client.get("/")
    assert resp.status_code == 200


def test_mcp_tunnel_call_endpoint():
    resp = client.post("/v1/mcp/call", json={
        "tool": "read_file",
        "arguments": {"path": "README.md", "limit": 10}
    })
    assert resp.status_code == 200
    data = resp.json()
    assert data.get("status") == "success"
    assert "content" in data

# ======================================================================
# End-to-End WebSocket Hub Synthetic Turn Tests
# ======================================================================

"""
End-to-end synthetic turn execution test simulating WebSocket extension protocol.
"""

import sys
import asyncio
import json
import pytest
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.bridge.ws_hub import hub, BrowserWebSocketHub


class MockWebSocket:
    def __init__(self):
        self.sent_messages = []

    async def accept(self):
        pass

    async def send_text(self, text: str):
        self.sent_messages.append(text)


@pytest.mark.asyncio
async def test_end_to_end_synthetic_turn():
    test_hub = BrowserWebSocketHub()
    mock_ws = MockWebSocket()

    # 1. Register mock connection
    await test_hub.register_connection(mock_ws)
    assert test_hub.is_connected is True

    # Send ready status
    await test_hub.handle_incoming_message({
        "type": "ready",
        "meta": {"url": "https://gemini.google.com/app", "model": "Google Gemini 2.5 Pro"}
    })
    assert test_hub.browser_info["model_name"] == "Google Gemini 2.5 Pro"

    # 2. Start turn in background
    async def run_turn():
        events = []
        async for ev in test_hub.execute_turn(prompt="What is 2+2?", model="gemini-web/pro", timeout_sec=5):
            events.append(ev)
        return events

    turn_task = asyncio.create_task(run_turn())
    await asyncio.sleep(0.05)

    # 3. Verify outgoing prompt submission
    assert len(mock_ws.sent_messages) > 0
    outgoing_msg = json.loads(mock_ws.sent_messages[-1])
    assert outgoing_msg["type"] == "submit_prompt"
    turn_id = outgoing_msg["turn_id"]
    assert "What is 2+2?" in outgoing_msg["prompt"]

    # 4. Simulate streamed chunks from extension
    await test_hub.handle_incoming_message({
        "type": "chunk",
        "turn_id": turn_id,
        "text": "",
        "delta": "",
        "thought": "Calculating addition",
        "thought_delta": "Calculating addition"
    })

    await test_hub.handle_incoming_message({
        "type": "chunk",
        "turn_id": turn_id,
        "text": "2 + 2 = 4",
        "delta": "2 + 2 = 4",
        "thought": "Calculating addition",
        "thought_delta": ""
    })

    # 5. Simulate done
    await test_hub.handle_incoming_message({
        "type": "done",
        "turn_id": turn_id,
        "text": "2 + 2 = 4",
        "thought": "Calculating addition"
    })

    # 6. Verify result
    events = await turn_task
    assert len(events) >= 2
    assert events[0].thought == "Calculating addition"
    assert events[-1].type == "done"
    assert events[-1].text == "2 + 2 = 4"
