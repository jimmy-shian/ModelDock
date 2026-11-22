"""
Direct Gemini Web client using Google account cookies (__Secure-1PSID).

This module bypasses the browser extension entirely by calling Gemini's
internal StreamGenerate RPC directly over HTTPS. It is the "cookie / access id"
path the user asked for: you supply your Google session cookies and the bridge
talks to gemini.google.com without needing a Chrome/Edge tab open.

Cookie sources (checked in order):
  1. Environment variables GEMINI_1PSID / GEMINI_1PSIDTS
  2. A JSON file at <workspace>/gemini_cookies.json with keys "1psid" / "1psidts"
  3. Auto-fetch from local Edge/Chrome profile (Playwright, handles App-Bound Encryption)

Security note: these cookies are equivalent to your logged-in Google session.
Keep them out of version control (the project .gitignore already excludes
credential-like files; add gemini_cookies.json if it is not already ignored).
"""

import os
import re
import json
import asyncio
import time
import uuid
import codecs
import logging
from pathlib import Path
from typing import AsyncGenerator, Optional, Dict, Any, List
from urllib.parse import urlparse

from curl_cffi.requests import Cookies as CurlCookies
from gemini_webapi import GeminiClient
from gemini_webapi.exceptions import GeminiError, APIError, TimeoutError
from gemini_webapi.constants import AccountStatus
from gemini_webapi.utils import clear_cookies_cache

from server.bridge.ws_hub import TurnEvent
from server.config import get_workspace_root
from server.browser.cookie_auto import auto_fetch_cookies

LOGGER = logging.getLogger("webchat2local.bridge")

_INITIALIZING_CLIENTS: set[int] = set()
_GUARDS_INSTALLED: bool = False
_CLIENT_INIT_TIMEOUT_SEC: float = float(os.getenv("GEMINI_INIT_TIMEOUT_SEC", "45") or 45)


def _install_gemini_webapi_guards() -> None:
    """
    Idempotent runtime compatibility guards for gemini-webapi 2.1.1 bugs (#381/#382):
      1. Reject GET /app responses redirected away from gemini.google.com (e.g.
         accounts.google.com sign-in page, whose HTML still carries SNlM0e/cfb2h).
      2. Prevent recursive self-deadlock on GeminiClient._lock when _init_rpc()
         hits a non-200 _batch_execute response and @running retries client.init().
    Safe no-op when upstream already provides _initializing.
    """
    global _GUARDS_INSTALLED
    if _GUARDS_INSTALLED:
        return

    try:
        import importlib
        _gat_mod = importlib.import_module("gemini_webapi.utils.get_access_token")

        orig_extract = _gat_mod._extract_payload
        if not getattr(orig_extract, "_w2l_guarded", False):
            def _guarded_extract_payload(response):
                host = (urlparse(str(getattr(response, "url", "") or "")).hostname or "").lower()
                if host and host != "gemini.google.com":
                    LOGGER.debug(
                        "🛡️ [DIRECT] 拒絕非 gemini.google.com 回應（重導向至 %s）", host
                    )
                    return None
                payload = orig_extract(response)
                if payload and isinstance(payload[1], str) and payload[1].startswith("boq_identity"):
                    LOGGER.debug("🛡️ [DIRECT] 拒絕登入頁 build_label (%s)", payload[1])
                    return None
                return payload

            _guarded_extract_payload._w2l_guarded = True
            _gat_mod._extract_payload = _guarded_extract_payload
    except Exception as e:
        LOGGER.debug("安裝 get_access_token 守衛略過: %s", e)

    try:
        orig_init = GeminiClient.init
        orig_batch = GeminiClient._batch_execute
        raw_batch = getattr(orig_batch, "__wrapped__", None)

        if (
            raw_batch is not None
            and "_initializing" not in getattr(GeminiClient, "__slots__", ())
            and not getattr(orig_init, "_w2l_guarded", False)
        ):
            async def _guarded_init(self, *args, **kwargs):
                cid = id(self)
                _INITIALIZING_CLIENTS.add(cid)
                try:
                    return await orig_init(self, *args, **kwargs)
                finally:
                    _INITIALIZING_CLIENTS.discard(cid)

            async def _guarded_batch_execute(self, *args, **kwargs):
                if id(self) in _INITIALIZING_CLIENTS:
                    kwargs["close_on_error"] = False
                    return await raw_batch(self, *args, **kwargs)
                return await orig_batch(self, *args, **kwargs)

            _guarded_init._w2l_guarded = True
            _guarded_batch_execute._w2l_guarded = True
            GeminiClient.init = _guarded_init
            GeminiClient._batch_execute = _guarded_batch_execute
    except Exception as e:
        LOGGER.debug("安裝 GeminiClient 防死鎖守衛略過: %s", e)

    _GUARDS_INSTALLED = True


def _is_allowed_cookie_domain(domain: str) -> bool:
    d = (domain or "").strip().lstrip(".").lower()
    if not d:
        return True
    if d == "accounts.google.com" or d.endswith(".accounts.google.com"):
        return False
    return d == "google.com" or d.endswith(".google.com")


def _normalize_cookie_list(raw_cookies: Any) -> List[Dict[str, Any]]:
    """
    Normalize a list of domain-aware cookie dicts for storage & CurlCookies jar building.
    Preserves exact domain/path/secure/expires so host cookies like gemini.google.com OSID
    and .google.com SID/1PSID/1PSIDTS/1PSIDCC stay intact.
    """
    if not isinstance(raw_cookies, list):
        return []
    dedup: Dict[tuple, Dict[str, Any]] = {}
    for item in raw_cookies:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name", "") or "").strip()
        value = str(item.get("value", "") or "").strip()
        if not name or not value:
            continue
        domain = str(item.get("domain", ".google.com") or ".google.com").strip()
        if not _is_allowed_cookie_domain(domain):
            continue
        path = str(item.get("path", "/") or "/").strip() or "/"
        secure = bool(item.get("secure", True))
        exp = item.get("expires")
        if exp is None:
            exp = item.get("expirationDate")
        entry: Dict[str, Any] = {
            "name": name,
            "value": value,
            "domain": domain,
            "path": path,
            "secure": secure,
        }
        if isinstance(exp, (int, float)) and exp > 0:
            entry["expires"] = exp
        dedup[(domain, path, name)] = entry
    return [dedup[k] for k in sorted(dedup.keys())]


def cookies_signature(data: Dict[str, Any]) -> tuple:
    """Stable comparable signature for (1psid, 1psidts, normalized cookie list)."""
    norm = _normalize_cookie_list(data.get("cookies"))
    return (
        str(data.get("1psid", "") or "").strip(),
        str(data.get("1psidts", "") or "").strip(),
        tuple((c["domain"], c["path"], c["name"], c["value"]) for c in norm),
    )


def _build_cookie_jar(cookies_data: Dict[str, Any]) -> CurlCookies:
    """Build a domain-accurate curl_cffi Cookies jar from stored Gemini cookies."""
    jar = CurlCookies()
    now = time.time()
    for c in _normalize_cookie_list(cookies_data.get("cookies")):
        exp = c.get("expires")
        if isinstance(exp, (int, float)) and exp < now:
            continue
        jar.set(
            c["name"],
            c["value"],
            domain=c["domain"],
            path=c["path"],
            secure=c.get("secure", True),
        )
    psid = str(cookies_data.get("1psid", "") or "").strip()
    psidts = str(cookies_data.get("1psidts", "") or "").strip()
    if psid:
        jar.set("__Secure-1PSID", psid, domain=".google.com", path="/", secure=True)
    if psidts:
        jar.set("__Secure-1PSIDTS", psidts, domain=".google.com", path="/", secure=True)
    return jar


class GeminiDirectError(Exception):
    """Raised when the direct Gemini client cannot proceed."""


def _cookie_file() -> Path:
    return get_workspace_root() / "gemini_cookies.json"


def save_cookies(
    one_psid: str,
    one_psidts: str = "",
    cookies: Optional[List[Dict[str, Any]]] = None,
) -> bool:
    """
    Persist the __Secure-1PSID / __Secure-1PSIDTS cookies (and optional full
    domain-accurate cookie list) to gemini_cookies.json.
    Returns True on success.
    """
    try:
        data: Dict[str, Any] = {
            "1psid": one_psid.strip(),
            "1psidts": one_psidts.strip(),
        }
        norm_cookies = _normalize_cookie_list(cookies)
        if norm_cookies:
            data["cookies"] = norm_cookies
        _cookie_file().write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def update_psidts(new_psidts: str, client_psid: str = "") -> bool:
    """
    Persist a rotated __Secure-1PSIDTS value while keeping the stored 1PSID
    and any domain-accurate cookies list.

    Lineage guard: when the caller's session PSID is known, only write if the
    file holds the SAME 1PSID. This prevents one stale in-memory session from
    grafting its PSIDTS onto another (fresher) session's PSID, a combination
    Google rejects with UNAUTHENTICATED for all new clients.
    """
    new_psidts = (new_psidts or "").strip()
    if not new_psidts:
        return False
    current = load_cookies()
    if current.get("1psidts") == new_psidts:
        return False  # unchanged
    psid = current.get("1psid", "")
    if not psid:
        return False
    if client_psid and client_psid.strip() != psid:
        LOGGER.warning(
            "🛡️ [DIRECT] 拒絕寫入 PSIDTS：來源會話與檔案會話不同（防混種寫入）。"
        )
        return False
    existing_cookies = _normalize_cookie_list(current.get("cookies"))
    if existing_cookies:
        updated_in_list = False
        for item in existing_cookies:
            if item["name"] == "__Secure-1PSIDTS":
                item["value"] = new_psidts
                updated_in_list = True
        if not updated_in_list:
            existing_cookies.append(
                {
                    "name": "__Secure-1PSIDTS",
                    "value": new_psidts,
                    "domain": ".google.com",
                    "path": "/",
                    "secure": True,
                }
            )
    return save_cookies(psid, new_psidts, cookies=existing_cookies or None)


def load_cookies() -> Dict[str, Any]:
    """
    Resolve the __Secure-1PSID / __Secure-1PSIDTS cookies (and optional full
    domain-accurate cookie list).
    """
    one_psid = os.getenv("GEMINI_1PSID", "")
    one_psidts = os.getenv("GEMINI_1PSIDTS", "")
    cookie_list: List[Dict[str, Any]] = []

    if not one_psid:
        path = _cookie_file()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    cookie_list = _normalize_cookie_list(data)
                elif isinstance(data, dict):
                    one_psid = str(data.get("1psid", "") or data.get("__Secure-1PSID", ""))
                    one_psidts = str(data.get("1psidts", "") or data.get("__Secure-1PSIDTS", ""))
                    cookie_list = _normalize_cookie_list(data.get("cookies"))
                if cookie_list and not one_psid:
                    one_psid = next((c["value"] for c in cookie_list if c["name"] == "__Secure-1PSID"), "")
                if cookie_list and not one_psidts:
                    one_psidts = next((c["value"] for c in cookie_list if c["name"] == "__Secure-1PSIDTS"), "")
            except (json.JSONDecodeError, OSError):
                one_psid = ""
                cookie_list = []

    if not one_psid:
        try:
            auto = auto_fetch_cookies()
            one_psid = auto.get("1psid", "")
            one_psidts = auto.get("1psidts", "")
        except Exception:
            one_psid = ""

    return {
        "1psid": one_psid.strip(),
        "1psidts": one_psidts.strip(),
        "cookies": cookie_list,
    }


def is_configured() -> bool:
    """True when a __Secure-1PSID cookie is available for direct calls."""
    return bool(load_cookies().get("1psid"))


class DirectGeminiEngine:
    """
    Stateful Direct Gemini Engine using gemini_webapi.
    Manages client authentication, background cookie synchronization,
    and active ChatSessions mapped to conversation fingerprints.
    """

    def __init__(self):
        self._client: Optional[GeminiClient] = None
        self._client_lock = asyncio.Lock()
        self._sessions: Dict[str, Any] = {}  # session_id -> ChatSession
        self._session_last_active: Dict[str, float] = {}
        self._clear_cache_before_init: bool = False

    async def get_client(self) -> GeminiClient:
        _install_gemini_webapi_guards()
        async with self._client_lock:
            if (
                self._client is not None
                and getattr(self._client, "_running", True)
                and getattr(self._client, "healthy", True)
            ):
                return self._client

            cookies = load_cookies()
            if not cookies.get("1psid"):
                # Try auto-extracting from browser
                try:
                    from gemini_webapi.utils import load_browser_cookies
                    b_dict = load_browser_cookies(domain_name=".google.com")
                    for b_name, c_list in b_dict.items():
                        psid = next((c["value"] for c in c_list if c.get("name") == "__Secure-1PSID"), "")
                        psidts = next((c["value"] for c in c_list if c.get("name") == "__Secure-1PSIDTS"), "")
                        if psid:
                            save_cookies(psid, psidts, cookies=c_list)
                            cookies = load_cookies()
                            LOGGER.info("🔑 [DIRECT] 成功從 %s 自動提取 Gemini Cookies！", b_name.capitalize())
                            break
                except Exception as e:
                    LOGGER.debug("自動從瀏覽器提取 Cookie 失敗: %s", e)

            if not cookies.get("1psid"):
                raise GeminiDirectError(
                    "未設定 Gemini Cookie (__Secure-1PSID)。\n"
                    "請在 ModelDock 的 Gemini 分頁登入，或透過擴充套件同步 Cookie，\n"
                    "或手動建立 gemini_cookies.json：{\"1psid\": \"...\", \"1psidts\": \"...\"}。"
                )

            cookie_jar = _build_cookie_jar(cookies)
            # When full domain-accurate cookies are supplied (e.g. Electron harvest with OSID/SID),
            # clear gemini_webapi's temp cache first so an older/incomplete cache entry with the same
            # 1PSID+1PSIDTS cannot shadow base_jar and cause get_access_token to skip Base Cookies.
            if self._clear_cache_before_init or bool(cookies.get("cookies")):
                clear_cookies_cache(cookie_jar)
                self._clear_cache_before_init = False

            LOGGER.info(
                "🔑 [DIRECT] 初始化 GeminiClient (使用 gemini_webapi | cookies=%d)...",
                len(cookies.get("cookies") or []) or (2 if cookies.get("1psidts") else 1),
            )
            client = GeminiClient(
                cookies["1psid"],
                cookies.get("1psidts", ""),
            )
            # Supply domain-accurate cookie jar (preserves gemini.google.com OSID + .google.com SID/PSID)
            client._cookies = cookie_jar

            try:
                await asyncio.wait_for(
                    client.init(timeout=180, auto_refresh=True, watchdog_timeout=180),
                    timeout=_CLIENT_INIT_TIMEOUT_SEC,
                )
            except asyncio.TimeoutError as e:
                LOGGER.error("❌ [DIRECT] GeminiClient 初始化逾時 (%.0fs)", _CLIENT_INIT_TIMEOUT_SEC)
                try:
                    await client.close()
                except Exception:
                    pass
                clear_cookies_cache(cookie_jar)
                raise GeminiDirectError(
                    f"GeminiClient 初始化逾時（{_CLIENT_INIT_TIMEOUT_SEC:.0f}s）。"
                    "請檢查網路連線或在 ModelDock 的 Gemini 分頁重新登入。"
                ) from e
            except Exception as e:
                LOGGER.error("❌ [DIRECT] GeminiClient 初始化失敗: %s", e)
                try:
                    await client.close()
                except Exception:
                    pass
                clear_cookies_cache(cookie_jar)
                raise GeminiDirectError(
                    f"GeminiClient 初始化失敗（{e}）。"
                    "若 Cookie 已過期或被導向登入頁，請在 ModelDock 的 Gemini 分頁重新登入後重試。"
                ) from e

            cookie_source = getattr(client, "_cookie_source", "")
            account_status = getattr(client, "account_status", AccountStatus.AVAILABLE)
            if cookie_source == "Guest" or account_status == AccountStatus.UNAUTHENTICATED:
                LOGGER.error(
                    "❌ [DIRECT] Gemini 認證失敗（source=%s, status=%s），已清除快取。",
                    cookie_source,
                    getattr(account_status, "name", account_status),
                )
                try:
                    await client.close()
                except Exception:
                    pass
                clear_cookies_cache(cookie_jar)
                raise GeminiDirectError(
                    "Gemini Cookie 已失效或未通過驗證（退回 Guest / UNAUTHENTICATED）。"
                    "請在 ModelDock 的 Gemini 分頁重新登入以更新完整 Cookie。"
                )

            # Auto persist rotated cookies if updated (same-session lineage only)
            if client.cookies.get("__Secure-1PSIDTS") and client.cookies.get("__Secure-1PSIDTS") != cookies.get("1psidts"):
                update_psidts(
                    client.cookies["__Secure-1PSIDTS"],
                    client_psid=str(client.cookies.get("__Secure-1PSID", "") or cookies.get("1psid", "")),
                )

            LOGGER.info(
                "✅ [DIRECT] GeminiClient 初始化成功 (source=%s | models=%d)",
                cookie_source or "unknown",
                len(client.list_models()) if hasattr(client, "list_models") else 0,
            )
            self._client = client
            return self._client

    async def reload_client(self):
        """Hot-reload the client when new cookies arrive."""
        async with self._client_lock:
            if self._client is not None:
                try:
                    await self._client.close()
                except Exception:
                    pass
                self._client = None
            self._clear_cache_before_init = True
            self._sessions.clear()
            self._session_last_active.clear()
            LOGGER.info("🔄 [DIRECT] GeminiClient 已重載。")


    def _resolve_model_name(self, client: GeminiClient, requested_model: str) -> Optional[str]:
        # Google renames web models server-side without notice
        # (e.g. "gemini-flash" -> "gemini-自動"). Any hardcoded id goes stale
        # and gemini_webapi raises ValueError("Unknown model name...").
        # Strategy: try to resolve the requested name against the live per-account
        # registry; on any failure return None so Google uses the account default
        # instead of sending a dead model header. Never raise here.
        try:
            if requested_model and hasattr(client, "resolve_model"):
                try:
                    resolved = client.resolve_model(requested_model)
                    name = getattr(resolved, "model_name", None)
                    if name:
                        return name
                except Exception:
                    pass
            # Fallback: first available model from the live registry.
            try:
                models = client.list_models() if hasattr(client, "list_models") else None
                if models:
                    for m in models:
                        if getattr(m, "is_available", True):
                            mname = getattr(m, "model_name", None)
                            if mname:
                                return mname
                    first = getattr(models[0], "model_name", None)
                    if first:
                        return first
            except Exception:
                pass
        except Exception:
            pass
        return None

    def _cleanup_stale_sessions(self, max_idle_sec: float = 7200):
        now = time.time()
        stale = [sid for sid, last in self._session_last_active.items() if now - last > max_idle_sec]
        for sid in stale:
            self._sessions.pop(sid, None)
            self._session_last_active.pop(sid, None)

    async def stream_generate(
        self,
        prompt: str,
        model: str = "gemini-web/flash",
        session_id: Optional[str] = None,
        is_continuation: bool = False,
        files: Optional[List[Any]] = None,
        timeout_sec: int = 180,
    ) -> AsyncGenerator[TurnEvent, None]:
        """
        Send prompt to Gemini Web using stateful ChatSessions.
        Yields TurnEvents (thought_delta, delta, done, error).
        """
        clean_prompt = prompt.strip()
        if not clean_prompt:
            clean_prompt = "Proceed with the next step."

        try:
            client = await self.get_client()
        except Exception as e:
            yield TurnEvent(event_type="error", error=f"GeminiClient 初始化失敗: {e}")
            return

        self._cleanup_stale_sessions()

        resolved_model = self._resolve_model_name(client, model)
        extended_thinking = False  # think removed: single Flash route, no thought streaming

        chat = None
        if session_id and is_continuation and session_id in self._sessions:
            chat = self._sessions[session_id]
            LOGGER.info("🔄 [DIRECT CHAT] 接續既有 Gemini 會話 (CID: %s | Session: %s)", getattr(chat, "cid", "unknown"), session_id[:8])
        else:
            chat = client.start_chat(model=resolved_model)
            if session_id:
                self._sessions[session_id] = chat
            LOGGER.info("🆕 [DIRECT CHAT] 建立全新 Gemini 會話 (CID: %s | Session: %s)", getattr(chat, "cid", "new"), (session_id or "adhoc")[:8])

        if session_id:
            self._session_last_active[session_id] = time.time()

        accumulated_text = ""
        last_chunk = None

        try:
            LOGGER.info(
                "🚀 [DIRECT SEND] 發送請求至 Gemini | Model: %s | Prompt長度: %d | 附加檔案數: %d",
                model, len(clean_prompt), len(files) if files else 0
            )
            async for chunk in chat.send_message_stream(
                prompt=clean_prompt,
                files=files,
                extended_thinking=extended_thinking,
            ):
                last_chunk = chunk
                if chunk.thoughts_delta:
                    yield TurnEvent(
                        event_type="thought_delta",
                        thought_delta=chunk.thoughts_delta,
                        thought=chunk.thoughts,
                    )
                if chunk.text_delta:
                    accumulated_text = chunk.text
                    yield TurnEvent(
                        event_type="delta",
                        text=chunk.text,
                        delta=chunk.text_delta,
                    )

            final_text = (last_chunk.text if last_chunk else accumulated_text).strip()

            # If generated images were returned by Gemini
            if last_chunk and getattr(last_chunk, "images", None):
                img_markdowns = [f"![image]({img.url})" for img in last_chunk.images if getattr(img, "url", None)]
                if img_markdowns:
                    final_text += "\n\n" + "\n".join(img_markdowns)

            if not final_text:
                yield TurnEvent(event_type="error", error="Gemini 直連未回傳任何文字回應。")
                return

            LOGGER.info("✅ [DIRECT DONE] Gemini 直連回應完成 | 輸出長度: %d", len(final_text))
            yield TurnEvent(event_type="done", text=final_text)

        except Exception as e:
            LOGGER.error("❌ [DIRECT ERROR] Gemini 生成異常: %s", e)
            # If session broke on Google's end, evict it so the next turn starts fresh
            if session_id:
                self._sessions.pop(session_id, None)
            yield TurnEvent(event_type="error", error=f"Gemini 生成錯誤: {e}")

    async def generate_analysis(
        self,
        prompt: str,
        model: str = "gemini-web/flash",
        files: Optional[List[Any]] = None,
    ) -> Dict[str, Any]:
        """
        Direct analysis call for MCP tools.
        Returns dict with:
          - text: final response markdown
          - thought: thinking process
          - citations: citations list
          - model: resolved model
        """
        clean_prompt = prompt.strip()
        client = await self.get_client()
        resolved_model = self._resolve_model_name(client, model)
        extended_thinking = False  # think removed: single Flash route, no thought streaming

        chat = client.start_chat(model=resolved_model)
        accumulated_text = ""
        accumulated_thought = ""
        last_chunk = None

        async for chunk in chat.send_message_stream(
            prompt=clean_prompt,
            files=files,
            extended_thinking=extended_thinking,
        ):
            last_chunk = chunk
            if chunk.thoughts:
                accumulated_thought = chunk.thoughts
            if chunk.text:
                accumulated_text = chunk.text

        final_text = ((last_chunk.text if last_chunk else accumulated_text) or "").strip()
        final_thought = ((last_chunk.thoughts if last_chunk else accumulated_thought) or "").strip()

        if last_chunk and getattr(last_chunk, "images", None):
            img_markdowns = [f"![image]({img.url})" for img in last_chunk.images if getattr(img, "url", None)]
            if img_markdowns:
                final_text += "\n\n" + "\n".join(img_markdowns)

        citations = []
        if last_chunk and getattr(last_chunk, "citations", None):
            citations = [str(c) for c in last_chunk.citations]

        return {
            "text": final_text,
            "thought": final_thought,
            "citations": citations,
            "model": resolved_model or "gemini-default",
        }


# Singleton instance
direct_engine = DirectGeminiEngine()



async def reload_client():
    """Hot reload client."""
    await direct_engine.reload_client()


def stream_generate(
    prompt: str,
    model: str = "gemini-web/flash",
    session_id: Optional[str] = None,
    is_continuation: bool = False,
    files: Optional[List[Any]] = None,
    timeout_sec: int = 180,
) -> AsyncGenerator[TurnEvent, None]:
    """
    Public entry point for direct stream generation.
    """
    return direct_engine.stream_generate(
        prompt=prompt,
        model=model,
        session_id=session_id,
        is_continuation=is_continuation,
        files=files,
        timeout_sec=timeout_sec,
    )


# ==========================================
# Legacy frame & stream chunk extraction helpers
# ==========================================

def _extract_stream_frames(raw: str):
    """Yield JSON roots from Gemini's XSSI/length-prefixed stream or JSON lines."""
    clean = re.sub(r"^\)\]\}'\s*", "", raw)
    json_line_roots = []
    for line in clean.split("\n"):
        t = line.strip()
        if not t:
            continue
        try:
            json_line_roots.append(json.loads(t))
        except json.JSONDecodeError:
            break
    if json_line_roots:
        for root in json_line_roots:
            yield root
        return

    try:
        yield json.loads(clean)
        return
    except json.JSONDecodeError:
        pass

    pos = 0
    while pos < len(clean):
        while pos < len(clean) and clean[pos].isspace():
            pos += 1
        start = pos
        while pos < len(clean) and clean[pos].isdigit():
            pos += 1
        if start == pos or pos >= len(clean) or clean[pos] != "\n":
            break
        length = int(clean[start:pos])
        pos += 1
        frame = clean[pos:pos + length]
        if len(frame) < length:
            break
        pos += length
        try:
            yield json.loads(frame)
        except json.JSONDecodeError:
            continue


def _extract_text_from_chunk(raw: str) -> str:
    """Extract assistant answer or tool calls from raw chunk."""
    trimmed = raw.strip()
    if not trimmed:
        return ""
    if trimmed.startswith("<tool_call>") or trimmed.startswith("<tool_call ") or (not trimmed.startswith(("[", ")]}'", "{")) and "<" in trimmed):
        return trimmed

    def decode_nested(value):
        current = value
        for _ in range(4):
            if not isinstance(current, str):
                return current
            try:
                current = json.loads(current)
            except (TypeError, json.JSONDecodeError):
                return current
        return current

    roots = list(_extract_stream_frames(raw))
    expanded = []
    for root in roots:
        expanded.append(root)
        records = []
        if isinstance(root, list) and root and isinstance(root[0], list):
            records = root
        elif isinstance(root, list) and len(root) >= 3 and root[0] == "wrb.fr":
            records = [root]
        for record in records:
            if isinstance(record, list) and len(record) >= 3 and record[0] == "wrb.fr":
                nested = decode_nested(record[2])
                if nested is not record[2]:
                    expanded.append(nested)

    for root in expanded:
        try:
            response_groups = root[4]
            for group in response_groups:
                if isinstance(group, list) and len(group) >= 2 and isinstance(group[0], str) and group[0].startswith("rc_"):
                    texts = group[1]
                    if isinstance(texts, list) and texts and all(isinstance(x, str) for x in texts):
                        return "".join(texts).strip()
        except (IndexError, TypeError):
            pass
    return ""


