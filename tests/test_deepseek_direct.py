"""
Unit tests for DeepSeek direct (userToken + PoW) engine.
No live network: PoW uses tiny crafted challenges, HTTP is monkeypatched.
"""

import sys
import json
import base64
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.browser import deepseek_direct as ds
from server.browser.deepseek_direct import (
    _normalize_token,
    encode_pow_response,
    solve_pow_answer_sync,
    parse_sse_line,
    resolve_flags,
    save_token,
    load_token,
    is_configured,
)


def test_normalize_bearer_prefix():
    assert _normalize_token("Bearer abc123") == "abc123"
    assert _normalize_token("bearer xyz") == "xyz"


def test_normalize_localstorage_blob():
    blob = json.dumps({"value": "tok_hello", "expires": 123})
    assert _normalize_token(blob) == "tok_hello"


def test_normalize_raw_passthrough():
    assert _normalize_token("  rawtoken  ") == "rawtoken"


def test_token_save_load_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setenv("W2L_WORKSPACE", str(tmp_path))
    assert save_token("Bearer mytesttoken") is True
    creds = load_token()
    assert creds["token"] == "mytesttoken"
    assert is_configured() is True


def test_token_missing_means_not_configured(tmp_path, monkeypatch):
    monkeypatch.setenv("W2L_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("DEEPSEEK_TOKEN", raising=False)
    assert is_configured() is False


def test_encode_pow_response_roundtrip():
    ch = {
        "algorithm": "DeepSeekHashV1",
        "challenge": "ab" * 32,
        "salt": "salty",
        "signature": "sig",
        "target_path": "/api/v0/chat/completion",
    }
    enc = encode_pow_response(ch, 42)
    obj = json.loads(base64.b64decode(enc).decode("utf-8"))
    assert obj["answer"] == 42
    assert obj["salt"] == "salty"
    assert obj["algorithm"] == "DeepSeekHashV1"


def _craft_challenge(answer: int, difficulty: int = 50):
    """Build a challenge whose valid nonce is exactly `answer`."""
    from Crypto.Hash import keccak
    salt = "testsalt"
    expire_at = 1780000000000
    k = keccak.new(digest_bits=256)
    k.update(f"{salt}_{expire_at}_{answer}".encode("utf-8"))
    return {
        "algorithm": "DeepSeekHashV1",
        "challenge": k.hexdigest(),
        "salt": salt,
        "difficulty": difficulty,
        "expire_at": expire_at,
        "signature": "testsig",
        "target_path": "/api/v0/chat/completion",
    }


def test_solve_pow_small_challenge():
    ch = _craft_challenge(answer=7, difficulty=50)
    assert solve_pow_answer_sync(ch) == 7


def test_resolve_flags():
    assert resolve_flags("deepseek-web/chat") == (False, False)
    assert resolve_flags("deepseek-chat") == (False, False)
    assert resolve_flags("deepseek-web/reasoner") == (True, False)
    assert resolve_flags("deepseek-r1") == (True, False)
    assert resolve_flags("deepseek-web/search") == (False, True)
    assert resolve_flags("deepseek-web/reasoner-search") == (True, True)
    assert resolve_flags("deepseek-web/auto") == (True, False)


def test_parse_initial_fragments():
    state: dict = {"frag_types": []}
    line = 'data: {"v": {"response": {"fragments": [{"content": "Hello", "type": "RESPONSE"}]}}}'
    c, t, done = parse_sse_line(line, state)
    assert done is False
    assert c == "Hello"
    assert t == ""
    assert state["frag_types"] == ["RESPONSE"]


def test_parse_think_fragment():
    state: dict = {"frag_types": []}
    line = 'data: {"v": {"response": {"fragments": [{"content": "let me think", "type": "THINK"}]}}}'
    c, t, done = parse_sse_line(line, state)
    assert c == ""
    assert t == "let me think"


def test_parse_append_new_fragment():
    state: dict = {"frag_types": ["RESPONSE"]}
    line = 'data: {"p": "response/fragments", "o": "APPEND", "v": [{"content": " world", "type": "RESPONSE"}]}'
    c, t, done = parse_sse_line(line, state)
    assert c == " world"
    assert len(state["frag_types"]) == 2


def test_parse_content_append_routes_by_type():
    state: dict = {"frag_types": ["THINK", "RESPONSE"]}
    c1, t1, _ = parse_sse_line(
        'data: {"p": "response/fragments/0/content", "o": "APPEND", "v": "hmm"}', state)
    assert c1 == "" and t1 == "hmm"
    c2, t2, _ = parse_sse_line(
        'data: {"p": "response/fragments/1/content", "o": "APPEND", "v": "hi"}', state)
    assert c2 == "hi" and t2 == ""


def test_parse_message_ids_and_done():
    state: dict = {"frag_types": []}
    c, t, done = parse_sse_line('data: {"response_message_id": "msg-123"}', state)
    assert state["parent_message_id"] == "msg-123"
    assert done is False
    _, _, done2 = parse_sse_line("data: [DONE]", state)
    assert done2 is True
    c3, t3, d3 = parse_sse_line(": keep-alive", state)
    assert (c3, t3, d3) == ("", "", False)


@pytest.mark.asyncio
async def test_stream_generate_missing_token_yields_error(monkeypatch, tmp_path):
    monkeypatch.setenv("W2L_WORKSPACE", str(tmp_path))
    monkeypatch.delenv("DEEPSEEK_TOKEN", raising=False)
    engine = ds.DirectDeepSeekEngine()
    evs = [e async for e in engine.stream_generate(prompt="hi", model="deepseek-web/chat")]
    assert evs and evs[-1].type == "error"
    assert "Token" in (evs[-1].error or "")


@pytest.mark.asyncio
async def test_generate_analysis_collects_deltas(monkeypatch, tmp_path):
    monkeypatch.setenv("W2L_WORKSPACE", str(tmp_path))
    monkeypatch.setenv("DEEPSEEK_TOKEN", "dummy")
    engine = ds.DirectDeepSeekEngine()

    async def fake_stream(**kwargs):
        from server.bridge.ws_hub import TurnEvent
        yield TurnEvent(event_type="thought_delta", thought_delta="thinking...")
        yield TurnEvent(event_type="delta", text="final answer", delta="final answer")
        yield TurnEvent(event_type="done", text="final answer", thought="thinking...")

    monkeypatch.setattr(engine, "stream_generate", fake_stream)
    res = await engine.generate_analysis(prompt="hello", model="deepseek-web/reasoner")
    assert res["text"] == "final answer"
    assert "thinking" in res["thought"]
    assert res["model"] == "deepseek-web/reasoner"


@pytest.mark.asyncio
async def test_mcp_routes_deepseek_to_deepseek_engine():
    from server.mcp import gemini_analysis_tools as gat
    from server.bridge.ws_hub import hub
    hub.active_connections.clear()
    fake = {"text": "ds answer", "thought": "ds thought",
            "citations": [], "model": "deepseek-web/reasoner"}
    with patch.object(gat.deepseek_engine, "generate_analysis",
                       new=AsyncMock(return_value=dict(fake))) as m:
        out = await gat.ask_gemini(prompt="hi", model="deepseek-web/reasoner")
        assert "ds answer" in out
        assert "DeepSeek" in out
        m.assert_called_once()


def test_transport_routes_deepseek_direct(monkeypatch):
    from server.bridge import transport as tmod
    from server.bridge.ws_hub import hub
    hub.active_connections.clear()
    hub.connection_platforms.clear()
    monkeypatch.setattr(tmod, "deepseek_is_configured", lambda: True)
    orig = tmod.get_mode()
    tmod.set_mode("auto")
    try:
        async def fake_ds(prompt="", model="", session_id=None,
                          is_continuation=False, files=None):
            if False:
                yield
        monkeypatch.setattr(tmod, "deepseek_stream_generate", fake_ds)
        gen, name = tmod.resolve_turn(prompt="hi", model="deepseek-web/reasoner")
        assert name == "deepseek-direct"
    finally:
        tmod.set_mode(orig)
        hub.active_connections.clear()
        hub.connection_platforms.clear()


def test_transport_deepseek_missing_token_raises(monkeypatch):
    from server.bridge import transport as tmod
    from server.bridge.ws_hub import hub
    hub.active_connections.clear()
    monkeypatch.setattr(tmod, "deepseek_is_configured", lambda: False)
    with pytest.raises(tmod.TransportUnavailable):
        tmod.resolve_turn(prompt="hi", model="deepseek-web/chat")


def test_model_catalog_has_deepseek():
    from server.model_catalog import AVAILABLE_GEMINI_WEB_ROUTES, resolve_model_route
    ids = [r.id for r in AVAILABLE_GEMINI_WEB_ROUTES]
    for expected in ("deepseek-web/chat", "deepseek-web/reasoner-search", "deepseek-web/auto"):
        assert expected in ids
    assert resolve_model_route("deepseek-reasoner").id == "deepseek-web/auto"
    assert resolve_model_route("deepseek-chat").id == "deepseek-web/chat"
