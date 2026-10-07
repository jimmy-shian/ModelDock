"""
Direct DeepSeek Web client using userToken (Bearer) + per-message PoW.

This module mirrors server/browser/gemini_direct.py but targets
https://chat.deepseek.com/a/chat/ (api/v0) instead of gemini.google.com.

Protocol (reverse-engineered, see repo docs):
  1. Auth: `userToken` from chat.deepseek.com LocalStorage
     (`JSON.parse(localStorage.getItem("userToken")).value`)
     sent as `Authorization: Bearer <token>`. Token lives ~24h.
  2. PoW: before every POST /api/v0/chat/completion, fetch
     POST /api/v0/chat/create_pow_challenge {"target_path": "/api/v0/chat/completion"}
     -> data.biz_data.challenge {algorithm, challenge, salt, difficulty,
        expire_at, signature, target_path}.
     Find nonce `answer` in [0, difficulty] such that
        Keccak-256(f"{salt}_{expire_at}_{answer}") == challenge (hex),
     then send header `x-ds-pow-response: base64(json({algorithm, challenge,
        salt, answer, signature, target_path}))`.
  3. Session: POST /api/v0/chat_session/create -> data.biz_data.id
     (no PoW needed). Multi-turn via parent_message_id chaining.
  4. Completion: POST /api/v0/chat/completion SSE (JSON-patch stream)
     {chat_session_id, parent_message_id, prompt, ref_file_ids: [],
      thinking_enabled, search_enabled} (+ optional client_stream_id).

Token sources (checked in order):
  1. Environment variable DEEPSEEK_TOKEN
  2. JSON file at <workspace>/deepseek_token.json with keys
     "token" / "userToken" / "user_token" (also accepts "session_id")
  3. Environment variable DEEPSEEK_COOKIES / "cookies" field for WAF
     (optional, best-effort `aws-waf-token` passthrough).

Security note: userToken is equivalent to your logged-in DeepSeek session.
Keep it out of version control (.gitignore already excludes
deepseek_token.json after this change).
"""

import os
import re
import json
import base64
import time
import uuid
import asyncio
import logging
from pathlib import Path
from typing import AsyncGenerator, Optional, Dict, Any, List, Tuple

from server.bridge.ws_hub import TurnEvent
from server.config import get_workspace_root

LOGGER = logging.getLogger("webchat2local.deepseek")

BASE_URL = "https://chat.deepseek.com"
API_BASE = "https://chat.deepseek.com/api/v0"
POW_URL = f"{API_BASE}/chat/create_pow_challenge"
SESSION_CREATE_URL = f"{API_BASE}/chat_session/create"
COMPLETION_URL = f"{API_BASE}/chat/completion"
POW_TARGET_PATH = "/api/v0/chat/completion"

DEFAULT_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/132.0.0.0 Safari/537.36"
)

try:  # optional acceleration: pre-built WASM solver package
    from deepseek_pow import Challenge as _DSPChallenge  # type: ignore
    from deepseek_pow import registry as _dsp_registry  # type: ignore
    HAS_DSPOW = True
except Exception:
    HAS_DSPOW = False

try:
    from Crypto.Hash import keccak as _keccak_mod  # pycryptodome (C-accelerated)
    HAS_KECCAK = True
except Exception:
    HAS_KECCAK = False


class DeepSeekDirectError(Exception):
    """Raised when the direct DeepSeek client cannot proceed."""


# ==========================================
# Token storage
# ==========================================

def _token_file() -> Path:
    return get_workspace_root() / "deepseek_token.json"


def save_token(token: str, session_id: str = "", cookies: str = "") -> bool:
    """Persist the DeepSeek userToken to deepseek_token.json."""
    try:
        token = (token or "").strip()
        if not token:
            return False
        # Allow pasting "Bearer xxx" or raw localStorage JSON blob.
        token = _normalize_token(token)
        data: Dict[str, Any] = {"token": token}
        if session_id:
            data["session_id"] = session_id.strip()
        if cookies:
            data["cookies"] = cookies
        else:
            # Preserve existing cookies field if present.
            try:
                prev = json.loads(_token_file().read_text(encoding="utf-8"))
                if isinstance(prev, dict) and prev.get("cookies"):
                    data["cookies"] = prev["cookies"]
            except Exception:
                pass
        _token_file().write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def _normalize_token(raw: str) -> str:
    raw = (raw or "").strip().strip('"').strip("'")
    if not raw:
        return ""
    # "Bearer xxx" -> "xxx"
    if raw.lower().startswith("bearer "):
        return raw[7:].strip()
    # localStorage blob {"value": "xxx", ...} -> "xxx"
    if raw.startswith("{"):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                for key in ("value", "token", "userToken", "user_token"):
                    if obj.get(key):
                        return str(obj[key]).strip()
        except Exception:
            pass
    return raw


def load_token() -> Dict[str, str]:
    """Resolve DeepSeek userToken / cookies."""
    token = os.getenv("DEEPSEEK_TOKEN", "").strip()
    cookies = os.getenv("DEEPSEEK_COOKIES", "").strip()
    session_id = ""

    if not token:
        path = _token_file()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                token = str(
                    data.get("token", "")
                    or data.get("userToken", "")
                    or data.get("user_token", "")
                    or data.get("value", "")
                )
                session_id = str(data.get("session_id", "") or "")
                if not cookies:
                    cookies = str(data.get("cookies", "") or "")
            except (json.JSONDecodeError, OSError, AttributeError):
                token = ""

    token = _normalize_token(token)
    return {"token": token, "session_id": session_id.strip(), "cookies": cookies.strip()}


def is_configured() -> bool:
    """True when a DeepSeek userToken is available for direct calls."""
    return bool(load_token().get("token"))


# ==========================================
# HTTP headers
# ==========================================

def _base_headers(token: str, pow_response: str = "", cookies: str = "") -> Dict[str, str]:
    headers: Dict[str, str] = {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "authorization": f"Bearer {token}",
        "content-type": "application/json",
        "origin": BASE_URL,
        "referer": f"{BASE_URL}/",
        "user-agent": DEFAULT_UA,
        "x-app-version": "20241129.1",
        "x-client-locale": "en_US",
        "x-client-platform": "web",
        "x-client-version": "1.0.0-always",
    }
    if pow_response:
        headers["x-ds-pow-response"] = pow_response
    if cookies:
        headers["cookie"] = cookies
    return headers


# ==========================================
# Proof-of-Work
# ==========================================

def _keccak256_hex(data: bytes) -> str:
    """Keccak-256 hex (NOT NIST SHA3-256). Requires pycryptodome."""
    if HAS_KECCAK:
        k = _keccak_mod.new(digest_bits=256)
        k.update(data)
        return k.hexdigest()
    # Last-resort fallback (different padding, usually WRONG for DeepSeek,
    # but keeps the solver importable without pycryptodome).
    import hashlib
    return hashlib.sha3_256(data).hexdigest()


def solve_pow_answer_sync(challenge: Dict[str, Any]) -> int:
    """
    Find nonce `answer` in [0, difficulty] such that
    Keccak-256(f"{salt}_{expire_at}_{nonce}") == challenge.
    Pure-Python loop over C-accelerated keccak; ~1-3s for difficulty 144k.
    """
    try:
        salt = str(challenge["salt"])
        expire_at = int(challenge["expire_at"])
        expected = str(challenge["challenge"]).lower()
        difficulty = int(challenge.get("difficulty", 144000))
    except (KeyError, TypeError, ValueError) as e:
        raise DeepSeekDirectError(f"PoW challenge 格式異常: {e}")

    if not HAS_KECCAK:
        LOGGER.warning("⚠️ [DEEPSEEK PoW] 未安裝 pycryptodome Keccak，將以 sha3_256 嘗試（可能無效）")

    prefix = f"{salt}_{expire_at}_".encode("utf-8")
    for nonce in range(difficulty + 1):
        digest = _keccak256_hex(prefix + str(nonce).encode("utf-8"))
        if digest == expected:
            return nonce
    raise DeepSeekDirectError(f"PoW 求解失敗（difficulty={difficulty} 內無解）")


def encode_pow_response(challenge: Dict[str, Any], answer: int) -> str:
    """Pack {algorithm, challenge, salt, answer, signature, target_path} as base64 JSON."""
    payload = {
        "algorithm": challenge.get("algorithm", "DeepSeekHashV1"),
        "challenge": challenge.get("challenge", ""),
        "salt": challenge.get("salt", ""),
        "answer": int(answer),
        "signature": challenge.get("signature", ""),
        "target_path": challenge.get("target_path", POW_TARGET_PATH),
    }
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    return base64.b64encode(raw.encode("utf-8")).decode("utf-8")


async def solve_pow_response(challenge: Dict[str, Any]) -> str:
    """Solve a PoW challenge dict -> x-ds-pow-response header value (non-blocking)."""
    # 1. Prefer pre-built WASM solver package if installed.
    if HAS_DSPOW:
        def _via_package() -> str:
            ch = _DSPChallenge(
                algorithm=str(challenge.get("algorithm", "DeepSeekHashV1")),
                challenge=str(challenge.get("challenge", "")),
                salt=str(challenge.get("salt", "")),
                difficulty=int(challenge.get("difficulty", 144000)),
                expire_at=int(challenge.get("expire_at", 0)),
                signature=str(challenge.get("signature", "")),
            )
            algo = getattr(ch, "algorithm", "DeepSeekHashV1")
            solver = _dsp_registry.get(algo)
            sol = solver.solve(ch)
            answer = int(getattr(sol, "answer", 0))
            return encode_pow_response(challenge, answer)

        try:
            return await asyncio.to_thread(_via_package)
        except Exception as e:
            LOGGER.warning("⚠️ [DEEPSEEK PoW] deepseek-pow 求解失敗，改用 WASM: %s", e)

    # 2. Official WASM solver (same module the browser runs).
    def _via_wasm() -> str:
        from server.browser.deepseek_wasm_pow import get_solver
        solver = get_solver()
        if solver is None:
            raise RuntimeError("WASM solver unavailable")
        return encode_pow_response(challenge, int(solver.solve(challenge)))

    try:
        return await asyncio.to_thread(_via_wasm)
    except Exception as e:
        LOGGER.warning("⚠️ [DEEPSEEK PoW] WASM 求解失敗，改用內建 keccak: %s", e)

    answer = await asyncio.to_thread(solve_pow_answer_sync, challenge)
    return encode_pow_response(challenge, answer)


# ==========================================
# SSE (JSON-patch) parsing
# ==========================================

_THINK_TYPES = {"THINK", "THINKING", "REASONING", "REASONER"}


def _frag_deltas(frag: Any) -> Tuple[str, str, str]:
    """Return (content_delta, thinking_delta, frag_type) for one fragment dict."""
    if not isinstance(frag, dict):
        return ("", "", "")
    content = frag.get("content", "")
    if not isinstance(content, str) or not content:
        return ("", "", str(frag.get("type", "") or ""))
    ftype = str(frag.get("type", "") or "").upper()
    if ftype in _THINK_TYPES:
        return ("", content, ftype)
    return (content, "", ftype)


def _parse_patch_object(obj: Any, state: Dict[str, Any]) -> Tuple[str, str]:
    """
    Apply one decoded SSE JSON object to the streaming state.
    Returns (content_delta, thinking_delta).
    State keys: frag_types[List[str]], parent_message_id, response_message_id.
    """
    if isinstance(obj, str):
        return ("", "")
    if not isinstance(obj, dict):
        return ("", "")

    content_out: List[str] = []
    thinking_out: List[str] = []

    # Message IDs for multi-turn chaining.
    for key in ("response_message_id", "responseMessageId", "message_id"):
        if obj.get(key):
            state["parent_message_id"] = str(obj[key])
    if isinstance(obj.get("v"), dict) and obj["v"].get("response_message_id"):
        state["parent_message_id"] = str(obj["v"]["response_message_id"])

    # Case 1: full snapshot {"v": {"response": {"fragments": [...]}}}
    v = obj.get("v")
    if isinstance(v, dict) and isinstance(v.get("response"), dict):
        frags = v["response"].get("fragments", [])
        if isinstance(frags, list):
            for frag in frags:
                c, t, ftype = _frag_deltas(frag)
                if c:
                    content_out.append(c)
                if t:
                    thinking_out.append(t)
                if ftype or c or t:
                    state.setdefault("frag_types", []).append(ftype)
            if content_out or thinking_out:
                return ("".join(content_out), "".join(thinking_out))

    # Case 2: JSON-patch {"p": ..., "o": "APPEND", "v": ...}
    # NOTE: the "o" verb is sometimes absent (e.g. {"p":"response/fragments/-1/content","v":" km"}).
    # Any string "v" on a content path is an append.
    p = str(obj.get("p", "") or "")
    o = str(obj.get("o", "") or "").upper()
    vv = obj.get("v")
    if p and o in ("APPEND", "SET", "REPLACE", "ADD", ""):
        # New fragments appended to the list.
        if "fragments" in p and isinstance(vv, list):
            for frag in vv:
                c, t, ftype = _frag_deltas(frag)
                if c:
                    content_out.append(c)
                if t:
                    thinking_out.append(t)
                state.setdefault("frag_types", []).append(ftype)
            return ("".join(content_out), "".join(thinking_out))
        # Incremental text appended to one fragment's content.
        if "content" in p and isinstance(vv, str) and vv:
            idx = _fragment_index_from_path(p, state)
            ftype = ""
            frag_types = state.get("frag_types", [])
            if 0 <= idx < len(frag_types):
                ftype = frag_types[idx]
            if ftype in _THINK_TYPES:
                return ("", vv)
            return (vv, "")

    # Case 2b: bare incremental text {"v": " some text"} with no path.
    # It continues the CURRENT (last) fragment: THINK-fragment -> thinking,
    # otherwise content. (Verified: think tokens stream as bare-v until the
    # RESPONSE fragment is appended, then the answer streams as bare-v.)
    if not p and isinstance(obj.get("v"), str) and obj.get("v"):
        frag_types = state.get("frag_types", [])
        last_type = frag_types[-1] if frag_types else ""
        if last_type in _THINK_TYPES:
            return ("", obj["v"])
        return (obj["v"], "")

    # Case 3: fallback — recursively collect any fragment-like dicts.
    # (Covers minor upstream field renames without breaking the stream.)
    found_c: List[str] = []
    found_t: List[str] = []
    stack: List[Any] = [obj]
    while stack:
        cur = stack.pop()
        if isinstance(cur, dict):
            if isinstance(cur.get("content"), str) and cur.get("content") and "type" in cur:
                c, t, _ = _frag_deltas(cur)
                if c:
                    found_c.append(c)
                if t:
                    found_t.append(t)
            else:
                stack.extend(cur.values())
        elif isinstance(cur, list):
            stack.extend(cur)
    # Only use the fallback when the structured cases above found nothing
    # and the object is not a patch envelope (to avoid double counting).
    if (found_c or found_t) and not p:
        return ("".join(reversed(found_c)), "".join(reversed(found_t)))

    return ("", "")


def _fragment_index_from_path(p: str, state: Dict[str, Any]) -> int:
    """
    Extract fragment index from paths like
    "response/fragments/0/content" or "response/fragments/-1/content".
    -1 means "last fragment".
    """
    m = re.search(r"fragments/(-?\d+)", p)
    if not m:
        frag_types = state.get("frag_types", [])
        return max(len(frag_types) - 1, 0)
    idx = int(m.group(1))
    if idx < 0:
        frag_types = state.get("frag_types", [])
        return max(len(frag_types) + idx, 0)
    return idx


def parse_sse_line(line: str, state: Dict[str, Any]) -> Tuple[str, str, bool]:
    """
    Parse one raw SSE line. Returns (content_delta, thinking_delta, is_done).
    Mutates `state` (fragment types + parent_message_id).
    """
    t = (line or "").strip()
    if not t or t.startswith(":"):
        return ("", "", False)
    if t.startswith("data:"):
        t = t[5:].strip()
    if t == "[DONE]":
        return ("", "", True)
    try:
        obj = json.loads(t)
    except (json.JSONDecodeError, ValueError):
        return ("", "", False)
    c, th = _parse_patch_object(obj, state)
    return (c, th, False)


# ==========================================
# HTTP layer (curl_cffi first, httpx fallback)
# ==========================================

def _has_curl_cffi() -> bool:
    try:
        import curl_cffi.requests  # noqa: F401
        return True
    except Exception:
        return False


async def _post_json(url: str, headers: Dict[str, str], payload: Dict[str, Any],
                     cookies: str = "", timeout: float = 30.0) -> Dict[str, Any]:
    """POST JSON -> parsed dict. Raises DeepSeekDirectError on auth/HTTP errors."""
    if _has_curl_cffi():
        from curl_cffi.requests import AsyncSession
        async with AsyncSession() as sess:
            resp = await sess.post(
                url, headers=headers, json=payload,
                cookies=_parse_cookies(cookies) if cookies else None,
                impersonate="chrome120", timeout=timeout,
            )
            status = int(getattr(resp, "status_code", 0) or 0)
            text = getattr(resp, "text", "") or ""
            return _check_json_response(url, status, text)

    import httpx
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        r = await client.post(url, headers=headers, json=payload,
                              cookies=_parse_cookies(cookies) if cookies else None)
        return _check_json_response(url, r.status_code, r.text)


def _check_json_response(url: str, status: int, text: str) -> Dict[str, Any]:
    if status == 401:
        raise DeepSeekDirectError(
            "DeepSeek Token 已過期或無效 (401)。請重新登入 chat.deepseek.com，"
            "從 LocalStorage 複製新的 userToken 到 deepseek_token.json。"
        )
    if status == 429:
        raise DeepSeekDirectError("DeepSeek 限流 (429)，請稍後再試（免費版併發上限約 2）。")
    if status == 403 and ("waf" in text.lower() or "challenge" in text.lower()):
        raise DeepSeekDirectError(
            "DeepSeek WAF 攔截 (403)。請用已登入的瀏覽器開啟一次 "
            "https://chat.deepseek.com/a/chat/ 後重試，或設定 DEEPSEEK_COOKIES。"
        )
    if status != 200:
        raise DeepSeekDirectError(f"DeepSeek 請求失敗 ({status}): {text[:300]}")
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        raise DeepSeekDirectError(f"DeepSeek 回應非 JSON: {text[:300]}")
    if isinstance(data, dict) and "code" in data and data.get("code") not in (0, None):
        raise DeepSeekDirectError(
            f"DeepSeek API 錯誤 code={data.get('code')} msg={data.get('msg', '')}"[:500]
        )
    return data if isinstance(data, dict) else {"data": data}


def _parse_cookies(raw: str) -> Dict[str, str]:
    out: Dict[str, str] = {}
    for part in (raw or "").split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        k, _, vv = part.partition("=")
        k, vv = k.strip(), vv.strip()
        if k:
            out[k] = vv
    return out


async def _stream_completion(url: str, headers: Dict[str, str], payload: Dict[str, Any],
                             cookies: str, timeout: float,
                             state: Dict[str, Any]):
    """
    Yield (content_delta, thinking_delta) tuples from the SSE completion stream.
    Backend: curl_cffi stream when available (Chrome TLS fingerprint),
    otherwise httpx streaming.
    """
    if _has_curl_cffi():
        from curl_cffi.requests import AsyncSession
        async with AsyncSession() as sess:
            async with sess.stream(
                "POST", url, headers={**headers, "accept": "text/event-stream"},
                json=payload,
                cookies=_parse_cookies(cookies) if cookies else None,
                impersonate="chrome120", timeout=timeout,
            ) as resp:
                status = int(getattr(resp, "status_code", 0) or 0)
                if status == 401:
                    raise DeepSeekDirectError("DeepSeek Token 已過期或無效 (401)。")
                if status == 429:
                    raise DeepSeekDirectError("DeepSeek 限流 (429)，請稍後再試。")
                if status != 200:
                    try:
                        body = getattr(resp, "text", "") or ""
                    except Exception:
                        body = ""
                    raise DeepSeekDirectError(f"DeepSeek completion 失敗 ({status}): {body[:300]}")
                async for line in resp.aiter_lines():
                    if isinstance(line, bytes):
                        try:
                            line = line.decode("utf-8")
                        except Exception:
                            continue
                    c, th, done = parse_sse_line(line, state)
                    if done:
                        break
                    if c or th:
                        yield c, th
        return

    import httpx
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        async with client.stream(
            "POST", url, headers={**headers, "accept": "text/event-stream"},
            json=payload, cookies=_parse_cookies(cookies) if cookies else None,
        ) as resp:
            if resp.status_code == 401:
                raise DeepSeekDirectError("DeepSeek Token 已過期或無效 (401)。")
            if resp.status_code == 429:
                raise DeepSeekDirectError("DeepSeek 限流 (429)，請稍後再試。")
            if resp.status_code != 200:
                body = (await resp.aread()).decode("utf-8", errors="replace")[:300]
                raise DeepSeekDirectError(f"DeepSeek completion 失敗 ({resp.status_code}): {body}")
            async for line in resp.aiter_lines():
                c, th, done = parse_sse_line(line, state)
                if done:
                    break
                if c or th:
                    yield c, th


# ==========================================
# Engine
# ==========================================

def resolve_flags(model: str) -> Tuple[bool, bool]:
    """Map a model id to (thinking_enabled, search_enabled)."""
    m = (model or "").strip().lower()
    if "reasoner-search" in m or "r1-search" in m or ("reason" in m and "search" in m):
        return (True, True)
    if "search" in m:
        return (False, True)
    if any(k in m for k in ("reasoner", "reason", "r1", "think", "pro", "expert",
                            "r4", "auto", "deepseek")):
        # NOTE: plain "deepseek-web/chat" / "deepseek-chat" / "deepseek-v3"
        # are explicitly non-thinking below.
        if m in ("deepseek-web/chat", "deepseek-chat", "deepseek-v3",
                 "deepseek-web-chat", "deepseek-default"):
            return (False, False)
        return (True, False)
    return (False, False)


class DirectDeepSeekEngine:
    """
    Stateful DeepSeek Web engine.
    Keeps chat_session_id + parent_message_id per local session fingerprint,
    mirroring DirectGeminiEngine's session map.
    """

    def __init__(self):
        self._sessions: Dict[str, Dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    def _cleanup_stale_sessions(self, max_idle_sec: float = 7200):
        now = time.time()
        stale = [sid for sid, ent in self._sessions.items()
                 if now - float(ent.get("last_active", 0)) > max_idle_sec]
        for sid in stale:
            self._sessions.pop(sid, None)

    async def _get_pow_header(self, token: str, cookies: str) -> str:
        data = await _post_json(
            POW_URL, _base_headers(token, cookies=cookies),
            {"target_path": POW_TARGET_PATH}, cookies=cookies, timeout=30.0,
        )
        try:
            challenge = data["data"]["biz_data"]["challenge"]
        except (KeyError, TypeError):
            raise DeepSeekDirectError(f"PoW challenge 回應格式異常: {str(data)[:300]}")
        return await solve_pow_response(challenge)

    async def _ensure_chat_session(self, token: str, cookies: str,
                                   local_sid: Optional[str]) -> Tuple[str, Optional[str]]:
        """Return (chat_session_id, parent_message_id) for this local session."""
        if local_sid and local_sid in self._sessions:
            ent = self._sessions[local_sid]
            return str(ent["chat_session_id"]), ent.get("parent_message_id")

        data = await _post_json(
            SESSION_CREATE_URL, _base_headers(token, cookies=cookies),
            {}, cookies=cookies, timeout=30.0,
        )
        try:
            chat_sid = str(data["data"]["biz_data"]["id"])
        except (KeyError, TypeError):
            raise DeepSeekDirectError(f"建立 DeepSeek 會話失敗: {str(data)[:300]}")
        if local_sid:
            async with self._lock:
                self._sessions[local_sid] = {
                    "chat_session_id": chat_sid,
                    "parent_message_id": None,
                    "last_active": time.time(),
                }
        return chat_sid, None

    async def stream_generate(
        self,
        prompt: str,
        model: str = "deepseek-web/auto",
        session_id: Optional[str] = None,
        is_continuation: bool = False,
        files: Optional[List[Any]] = None,
        timeout_sec: int = 180,
    ) -> AsyncGenerator[TurnEvent, None]:
        clean_prompt = (prompt or "").strip() or "Proceed with the next step."
        if files:
            LOGGER.warning("⚠️ [DEEPSEEK] 暫不支援圖片/檔案上傳，本輪僅送出文字。")

        creds = load_token()
        if not creds.get("token"):
            yield TurnEvent(event_type="error", error=(
                "未設定 DeepSeek Token。\n請登入 https://chat.deepseek.com/a/chat/，"
                "在 DevTools Console 執行 copy(JSON.parse(localStorage.getItem(\"userToken\")).value)，"
                "貼到 deepseek_token.json {\"token\": \"...\"} 或環境變數 DEEPSEEK_TOKEN。"
            ))
            return

        token, cookies = creds["token"], creds.get("cookies", "")
        self._cleanup_stale_sessions()
        thinking_enabled, search_enabled = resolve_flags(model)

        try:
            pow_header = await self._get_pow_header(token, cookies)
        except Exception as e:
            yield TurnEvent(event_type="error", error=f"DeepSeek PoW 失敗: {e}")
            return

        local_sid = session_id if (session_id and is_continuation) else (session_id or f"adhoc-{uuid.uuid4().hex[:8]}")
        try:
            chat_sid, parent_id = await self._ensure_chat_session(token, cookies, local_sid)
            # Non-continuation with an existing local_sid starts a FRESH remote
            # session so a new task never inherits an old thread.
            if session_id and not is_continuation and session_id in self._sessions:
                async with self._lock:
                    self._sessions.pop(session_id, None)
                chat_sid, parent_id = await self._ensure_chat_session(token, cookies, local_sid)
        except Exception as e:
            yield TurnEvent(event_type="error", error=f"DeepSeek 會話建立失敗: {e}")
            return

        payload: Dict[str, Any] = {
            "chat_session_id": chat_sid,
            "parent_message_id": parent_id,
            "prompt": clean_prompt,
            "ref_file_ids": [],
            "thinking_enabled": thinking_enabled,
            "search_enabled": search_enabled,
            # NOTE: no client_stream_id — DeepSeek rejects unknown formats
            # (422 "Invalid client stream id format"); omitting works.
        }
        headers = _base_headers(token, pow_response=pow_header, cookies=cookies)
        state: Dict[str, Any] = {"frag_types": [], "parent_message_id": parent_id}

        LOGGER.info(
            "🚀 [DEEPSEEK SEND] Model: %s | Thinking: %s Search: %s | Prompt: %d chars | Session: %s",
            model, thinking_enabled, search_enabled, len(clean_prompt), local_sid[:8],
        )

        acc_text: List[str] = []
        acc_think: List[str] = []
        try:
            async for c_delta, t_delta in _stream_completion(
                COMPLETION_URL, headers, payload, cookies, float(timeout_sec), state,
            ):
                if t_delta:
                    acc_think.append(t_delta)
                    yield TurnEvent(event_type="thought_delta", thought_delta=t_delta,
                                    thought="".join(acc_think))
                if c_delta:
                    acc_text.append(c_delta)
                    yield TurnEvent(event_type="delta", text="".join(acc_text), delta=c_delta)

            final_text = "".join(acc_text).strip()
            if not final_text:
                yield TurnEvent(event_type="error", error="DeepSeek 直連未回傳任何文字回應。")
                return

            # Persist chaining IDs for the next continuation turn.
            if local_sid:
                async with self._lock:
                    self._sessions[local_sid] = {
                        "chat_session_id": chat_sid,
                        "parent_message_id": state.get("parent_message_id") or parent_id,
                        "last_active": time.time(),
                    }

            LOGGER.info("✅ [DEEPSEEK DONE] 輸出 %d chars | 思考 %d chars", len(final_text), len("".join(acc_think)))
            yield TurnEvent(event_type="done", text=final_text, thought="".join(acc_think).strip())
        except Exception as e:
            LOGGER.error("❌ [DEEPSEEK ERROR] %s", e)
            if local_sid and local_sid.startswith("adhoc-"):
                self._sessions.pop(local_sid, None)
            yield TurnEvent(event_type="error", error=f"DeepSeek 生成錯誤: {e}")

    async def generate_analysis(
        self,
        prompt: str,
        model: str = "deepseek-web/auto",
        files: Optional[List[Any]] = None,
    ) -> Dict[str, Any]:
        clean_prompt = (prompt or "").strip()
        acc_text: List[str] = []
        acc_think: List[str] = []
        async for ev in self.stream_generate(prompt=clean_prompt, model=model, files=files):
            if ev.type == "error":
                raise DeepSeekDirectError(ev.error or "DeepSeek 生成錯誤")
            if ev.thought_delta:
                acc_think.append(ev.thought_delta)
            elif ev.thought and not acc_think:
                acc_think.append(ev.thought)
            if ev.delta:
                acc_text.append(ev.delta)
            elif ev.text and ev.type == "done" and not acc_text:
                acc_text.append(ev.text)
        thinking_enabled, search_enabled = resolve_flags(model)
        return {
            "text": "".join(acc_text).strip(),
            "thought": "".join(acc_think).strip(),
            "citations": [],
            "model": model,
            "thinking_enabled": thinking_enabled,
            "search_enabled": search_enabled,
        }


# Singleton (mirrors gemini_direct.direct_engine)
deepseek_engine = DirectDeepSeekEngine()


def stream_generate(
    prompt: str,
    model: str = "deepseek-web/auto",
    session_id: Optional[str] = None,
    is_continuation: bool = False,
    files: Optional[List[Any]] = None,
    timeout_sec: int = 180,
) -> AsyncGenerator[TurnEvent, None]:
    """Public entry point for direct DeepSeek stream generation."""
    return deepseek_engine.stream_generate(
        prompt=prompt, model=model, session_id=session_id,
        is_continuation=is_continuation, files=files, timeout_sec=timeout_sec,
    )
