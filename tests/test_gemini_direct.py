import json

from server.browser.gemini_direct import _extract_text_from_chunk


def _frame(response):
    payload = json.dumps(response, ensure_ascii=False, separators=(",", ":"))
    record = [["wrb.fr", None, payload]]
    return json.dumps(record, ensure_ascii=False, separators=(",", ":"))


def test_extracts_model_text_from_double_encoded_wrb_frame():
    response = [
        None,
        ["c_test", "r_test"],
        None,
        None,
        [
            ["rc_test", ["GEMINI_DIRECT_OK"], None],
            ["location", ["Taiwan Changhua City"], None],
            None,
            None,
            "3.7 Flash",
            True,
            [[[1004, "Longer"], [1001, "Try again"], [1003, "Personalize"]]],
        ],
    ]
    assert _extract_text_from_chunk(_frame(response)) == "GEMINI_DIRECT_OK"


def test_ignores_ui_metadata_when_no_response_chunk_is_available():
    response = [
        None,
        ["c_test", "r_test"],
        None,
        None,
        [
            ["location", ["Taiwan Changhua City"], None],
            ["ui", ["Personalize"], None],
            None,
            None,
            "3.7 Flash",
        ],
    ]
    assert _extract_text_from_chunk(_frame(response)) == ""


def test_extracts_tool_call_from_raw_stream():
    raw = '<tool_call>\n{"name": "execute_command", "arguments": {"command": "ls"}}\n</tool_call>'
    assert _extract_text_from_chunk(raw) == raw


def test_extracts_streaming_tool_call_without_closing_tag():
    raw = '<tool_call>\n{"name": "execute_command", "arguments": {"command": "ls"}}'
    assert _extract_text_from_chunk(raw) == raw


def test_json_lines_frames_are_parsed():
    from server.browser.gemini_direct import _extract_stream_frames
    line1 = json.dumps(["wrb.fr", None, "{}"])
    line2 = json.dumps(["wrb.fr", None, "{}"])
    roots = list(_extract_stream_frames(line1 + "\n" + line2))
    assert len(roots) == 2
    assert roots[0][0] == "wrb.fr"
    assert roots[1][0] == "wrb.fr"


def test_save_and_load_domain_accurate_cookies_and_preserve_on_psidts_rotate(tmp_path, monkeypatch):
    from server.browser import gemini_direct as gd

    cookie_path = tmp_path / "gemini_cookies.json"
    monkeypatch.setattr(gd, "_cookie_file", lambda: cookie_path)
    monkeypatch.delenv("GEMINI_1PSID", raising=False)
    monkeypatch.delenv("GEMINI_1PSIDTS", raising=False)

    raw_cookies = [
        {"name": "OSID", "value": "osid-val", "domain": "gemini.google.com", "path": "/", "secure": True},
        {"name": "__Secure-1PSID", "value": "psid-1", "domain": ".google.com", "path": "/", "secure": True},
        {"name": "__Secure-1PSIDTS", "value": "ts-1", "domain": ".google.com", "path": "/", "secure": True},
        {"name": "__Host-GAPS", "value": "ignore-me", "domain": "accounts.google.com", "path": "/", "secure": True},
    ]
    assert gd.save_cookies("psid-1", "ts-1", cookies=raw_cookies) is True

    loaded = gd.load_cookies()
    assert loaded["1psid"] == "psid-1"
    assert loaded["1psidts"] == "ts-1"
    names = {(c["domain"], c["name"]) for c in loaded["cookies"]}
    assert ("gemini.google.com", "OSID") in names
    assert (".google.com", "__Secure-1PSID") in names
    assert all(c["domain"] != "accounts.google.com" for c in loaded["cookies"])

    # Rotating PSIDTS must preserve OSID and update __Secure-1PSIDTS inside cookies list
    assert gd.update_psidts("ts-2", client_psid="psid-1") is True
    reloaded = gd.load_cookies()
    assert reloaded["1psidts"] == "ts-2"
    osid = next((c for c in reloaded["cookies"] if c["name"] == "OSID"), None)
    ts_entry = next((c for c in reloaded["cookies"] if c["name"] == "__Secure-1PSIDTS"), None)
    assert osid is not None and osid["domain"] == "gemini.google.com"
    assert ts_entry is not None and ts_entry["value"] == "ts-2"


def test_guard_rejects_accounts_google_signin_redirect():
    import importlib
    from types import SimpleNamespace
    from server.browser.gemini_direct import _install_gemini_webapi_guards

    gat = importlib.import_module("gemini_webapi.utils.get_access_token")
    _install_gemini_webapi_guards()
    fake_signin = SimpleNamespace(
        url="https://accounts.google.com/v3/signin/identifier?continue=https://gemini.google.com/app",
        text='"SNlM0e":"fake-token","cfb2h":"boq_identityfrontendauthuiserver_20261119.04_p0","FdrFJe":"-123"',
    )
    assert gat._extract_payload(fake_signin) is None

    fake_gemini = SimpleNamespace(
        url="https://gemini.google.com/app",
        text='"SNlM0e":"real-token","cfb2h":"boq_gemini-web-uiserver_20261120.16_p0","FdrFJe":"-456"',
    )
    payload = gat._extract_payload(fake_gemini)
    assert payload is not None
    assert payload[0] == "real-token"


def test_guard_prevents_deadlock_when_init_rpc_fails(monkeypatch):
    import asyncio
    from types import SimpleNamespace
    from gemini_webapi import GeminiClient
    from gemini_webapi.exceptions import APIError
    from server.browser.gemini_direct import _install_gemini_webapi_guards

    _install_gemini_webapi_guards()

    async def _run():
        client = GeminiClient("fake-psid", "fake-ts")

        class _FakeLive:
            cookies = {}
            timeout = 30
            async def post(self, *args, **kwargs):
                return SimpleNamespace(status_code=400, text="", http_version=2)
            async def close(self):
                pass

        async def _fake_get_access_token(**kwargs):
            return SimpleNamespace(
                access_token="tok",
                build_label="boq_gemini-web-uiserver_20261120.16_p0",
                session_id="123",
                language="en",
                push_id="pid",
                client=_FakeLive(),
                cookie_source="Base Cookies",
            )

        import gemini_webapi.client as gw_client
        monkeypatch.setattr(gw_client, "get_access_token", _fake_get_access_token)

        # Without the guard, this hangs forever in self-deadlock on client._lock.
        # With the guard, it must fail immediately with APIError.
        try:
            await asyncio.wait_for(client.init(timeout=10, auto_refresh=False), timeout=3.0)
            assert False, "Expected APIError"
        except APIError as e:
            assert "400" in str(e)

    asyncio.run(_run())
