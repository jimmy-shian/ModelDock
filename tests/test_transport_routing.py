"""
Regression tests for per-tab transport routing.

Covers the reported bug: webchat/auto in auto mode ignored the open tabs
(direct-first whenever cookies exist, even with only a ChatGPT tab open),
and chatgpt-web/* checked only browser_info["platform"] (last-reporter-wins),
mis-firing when both a Gemini tab and a ChatGPT tab were connected.
"""

import sys
import asyncio
import types
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

# --- Stub gemini_webapi (not installed in this env) before importing transport.
_fake = types.ModuleType("gemini_webapi")


class _FakeClient:
    pass


_fake.GeminiClient = _FakeClient
_fake_exc = types.ModuleType("gemini_webapi.exceptions")


class GeminiError(Exception):
    pass


class APIError(GeminiError):
    pass


class TimeoutError(GeminiError):
    pass


_fake_exc.GeminiError = GeminiError
_fake_exc.APIError = APIError
_fake_exc.TimeoutError = TimeoutError
_fake_const = types.ModuleType("gemini_webapi.constants")


class AccountStatus:
    pass


_fake_const.AccountStatus = AccountStatus
sys.modules.setdefault("gemini_webapi", _fake)
sys.modules.setdefault("gemini_webapi.exceptions", _fake_exc)
sys.modules.setdefault("gemini_webapi.constants", _fake_const)

import pytest

from server.bridge import transport as tmod
from server.bridge.ws_hub import hub


def _reset_hub():
    hub.active_connections.clear()
    hub.connection_platforms.clear()
    hub.turn_queues.clear()
    hub.active_turn_id = None
    hub.is_draining = False
    hub.browser_info.update(
        {"connected": False, "page_url": None, "platform": None,
         "model_name": None, "last_seen": 0}
    )


def _add_tab(platform: str):
    conn = object()
    hub.active_connections.add(conn)
    hub.connection_platforms[conn] = platform
    hub.browser_info.update({"connected": True, "platform": platform})
    return conn


@pytest.fixture
def cleanthings(monkeypatch):
    _reset_hub()
    calls = []
    directs = []

    def fake_execute_turn(prompt="", model="", timeout_sec=180,
                          is_new_session=True, platform=None):
        calls.append({"prompt": prompt, "model": model,
                      "is_new_session": is_new_session, "platform": platform})

        async def _gen():
            if False:
                yield

        return _gen()

    def fake_direct(prompt="", model="", session_id=None,
                    is_continuation=False, files=None):
        directs.append({"model": model})

        async def _gen():
            if False:
                yield

        return _gen()

    monkeypatch.setattr(hub, "execute_turn", fake_execute_turn)
    monkeypatch.setattr(tmod, "direct_stream_generate", fake_direct)
    orig_mode = tmod.get_mode()
    yield {"calls": calls, "directs": directs}
    _reset_hub()
    tmod.set_mode(orig_mode)


def test_generic_auto_chatgpt_only_tab_prefers_extension(cleanthings, monkeypatch):
    """webchat/auto + auto mode + cookies + only ChatGPT tab -> extension/chatgpt."""
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: True)
    tmod.set_mode("auto")
    _add_tab("chatgpt")

    gen, name = tmod.resolve_turn(prompt="hi", model="webchat/auto")

    assert name == "extension"
    assert cleanthings["calls"] and cleanthings["calls"][0]["platform"] == "chatgpt"
    assert not cleanthings["directs"]


def test_generic_auto_gemini_only_tab_keeps_direct_first(cleanthings, monkeypatch):
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: True)
    tmod.set_mode("auto")
    _add_tab("gemini")

    _, name = tmod.resolve_turn(prompt="hi", model="webchat/auto")

    assert name == "direct"
    assert cleanthings["directs"]


def test_generic_auto_no_direct_chatgpt_tab(cleanthings, monkeypatch):
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: False)
    tmod.set_mode("auto")
    _add_tab("chatgpt")

    _, name = tmod.resolve_turn(prompt="hi", model="webchat/auto")

    assert name == "extension"
    assert cleanthings["calls"][0]["platform"] == "chatgpt"


def test_chatgpt_model_both_tabs_routes_chatgpt(cleanthings, monkeypatch):
    """Both tabs open, last reporter is gemini -> must still route chatgpt."""
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: True)
    tmod.set_mode("auto")
    _add_tab("chatgpt")
    _add_tab("gemini")  # last-writer-wins trap for browser_info
    assert hub.browser_info["platform"] == "gemini"

    _, name = tmod.resolve_turn(prompt="hi", model="chatgpt-web/auto")

    assert name == "extension"
    assert cleanthings["calls"][0]["platform"] == "chatgpt"


def test_chatgpt_model_gemini_only_raises(cleanthings, monkeypatch):
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: True)
    monkeypatch.setattr(tmod, "_electron_reachable", lambda timeout=0.5: False)
    tmod.set_mode("auto")
    _add_tab("gemini")

    with pytest.raises(tmod.TransportUnavailable):
        tmod.resolve_turn(prompt="hi", model="chatgpt-web/auto")


def test_chatgpt_model_no_connection_raises(cleanthings, monkeypatch):
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: False)
    monkeypatch.setattr(tmod, "_electron_reachable", lambda timeout=0.5: False)
    tmod.set_mode("auto")

    with pytest.raises(tmod.TransportUnavailable):
        tmod.resolve_turn(prompt="hi", model="chatgpt-web/gpt-4o")


def test_chatgpt_model_falls_back_to_electron_app(cleanthings, monkeypatch):
    """無擴充套件但 Electron 在線 -> electron-app 轉發，不再 503。"""
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: False)
    monkeypatch.setattr(tmod, "_electron_reachable", lambda timeout=0.5: True)
    tmod.set_mode("auto")

    _, name = tmod.resolve_turn(prompt="hi", model="chatgpt-web/auto")

    assert name == "electron-app"
    assert not cleanthings["calls"]


def test_gpt_web_port_alias_routes_electron_app(cleanthings, monkeypatch):
    """Electron 側模型名 (gpt-web-port) 打到 8765 也視為 ChatGPT 轉發。"""
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: False)
    monkeypatch.setattr(tmod, "_electron_reachable", lambda timeout=0.5: True)
    tmod.set_mode("auto")

    _, name = tmod.resolve_turn(prompt="hi", model="gpt-web-port")

    assert name == "electron-app"


def test_generic_extension_mode_single_tab_platform(cleanthings, monkeypatch):
    monkeypatch.setattr(tmod, "direct_is_configured", lambda: False)
    tmod.set_mode("extension")
    _add_tab("chatgpt")

    _, name = tmod.resolve_turn(prompt="hi", model="webchat/auto")

    assert name == "extension"
    assert cleanthings["calls"][0]["platform"] == "chatgpt"


def test_connected_platforms_census(cleanthings):
    _add_tab("chatgpt")
    _add_tab("gemini")
    _add_tab("gemini")

    assert hub.connected_platforms() == {"chatgpt": 1, "gemini": 2}
    assert hub.get_status()["platforms"] == {"chatgpt": 1, "gemini": 2}


@pytest.mark.asyncio
async def test_midturn_reload_fails_fast():
    """Original tab gone mid-turn (reload) -> fast reload error, not 180s hang."""
    from server.bridge.ws_hub import BrowserWebSocketHub

    class FakeWS:
        def __init__(self):
            self.sent = []

        async def accept(self):
            pass

        async def send_text(self, s):
            self.sent.append(s)

    t = BrowserWebSocketHub()
    old, new = FakeWS(), FakeWS()
    await t.register_connection(old)

    async def run():
        evs = []
        async for ev in t.execute_turn(
            prompt="hi", model="chatgpt-web/auto",
            timeout_sec=60, platform="chatgpt",
        ):
            evs.append(ev)
        return evs

    task = asyncio.create_task(run())
    await asyncio.sleep(0.3)
    assert t.active_turn_id is not None
    t.unregister_connection(old)  # reload kills the original context
    await t.register_connection(new)  # fresh context knows nothing

    evs = await asyncio.wait_for(task, timeout=20)
    assert evs and evs[-1].type == "error"
    assert "重新載入" in (evs[-1].error or "")
