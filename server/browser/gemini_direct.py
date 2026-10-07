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

from gemini_webapi import GeminiClient
from gemini_webapi.exceptions import GeminiError, APIError, TimeoutError
from gemini_webapi.constants import AccountStatus

from server.bridge.ws_hub import TurnEvent
from server.config import get_workspace_root
from server.browser.cookie_auto import auto_fetch_cookies

LOGGER = logging.getLogger("webchat2local.bridge")


class GeminiDirectError(Exception):
    """Raised when the direct Gemini client cannot proceed."""


def _cookie_file() -> Path:
    return get_workspace_root() / "gemini_cookies.json"


def save_cookies(one_psid: str, one_psidts: str = "") -> bool:
    """
    Persist the __Secure-1PSID / __Secure-1PSIDTS cookies to gemini_cookies.json.
    Returns True on success.
    """
    try:
        data = {"1psid": one_psid.strip(), "1psidts": one_psidts.strip()}
        _cookie_file().write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return True
    except OSError:
        return False


def update_psidts(new_psidts: str, client_psid: str = "") -> bool:
    """
    Persist a rotated __Secure-1PSIDTS value while keeping the stored 1PSID.

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
    return save_cookies(psid, new_psidts)


def load_cookies() -> Dict[str, str]:
    """
    Resolve the __Secure-1PSID / __Secure-1PSIDTS cookies.
    """
    one_psid = os.getenv("GEMINI_1PSID", "")
    one_psidts = os.getenv("GEMINI_1PSIDTS", "")

    if not one_psid:
        path = _cookie_file()
        if path.exists():
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                one_psid = str(data.get("1psid", "") or data.get("__Secure-1PSID", ""))
                one_psidts = str(data.get("1psidts", "") or data.get("__Secure-1PSIDTS", ""))
            except (json.JSONDecodeError, OSError):
                one_psid = ""

    if not one_psid:
        try:
            auto = auto_fetch_cookies()
            one_psid = auto.get("1psid", "")
            one_psidts = auto.get("1psidts", "")
        except Exception:
            one_psid = ""

    return {"1psid": one_psid.strip(), "1psidts": one_psidts.strip()}


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

    async def get_client(self) -> GeminiClient:
        async with self._client_lock:
            if self._client is not None and getattr(self._client, "healthy", True):
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
                            save_cookies(psid, psidts)
                            cookies = load_cookies()
                            LOGGER.info("🔑 [DIRECT] 成功從 %s 自動提取 Gemini Cookies！", b_name.capitalize())
                            break
                except Exception as e:
                    LOGGER.debug("自動從瀏覽器提取 Cookie 失敗: %s", e)

            if not cookies.get("1psid"):
                raise GeminiDirectError(
                    "未設定 Gemini Cookie (__Secure-1PSID)。\n"
                    "請在 Chrome 或 Edge 開啟 gemini.google.com 登入，並在擴充套件點擊「自動抓取 Cookie」，\n"
                    "或手動建立 gemini_cookies.json：{\"1psid\": \"...\", \"1psidts\": \"...\"}。"
                )

            LOGGER.info("🔑 [DIRECT] 初始化 GeminiClient (使用 gemini_webapi)...")
            client = GeminiClient(
                cookies["1psid"],
                cookies.get("1psidts", ""),
                auto_refresh=True,
            )

            try:
                await client.init(timeout=180, auto_refresh=True, watchdog_timeout=180)
            except Exception as e:
                LOGGER.warning("⚠️ [DIRECT] GeminiClient 初始化警告: %s", e)

            # Auto persist rotated cookies if updated (same-session lineage only)
            if client.cookies.get("__Secure-1PSIDTS") and client.cookies.get("__Secure-1PSIDTS") != cookies.get("1psidts"):
                update_psidts(
                    client.cookies["__Secure-1PSIDTS"],
                    client_psid=str(client.cookies.get("__Secure-1PSID", "") or cookies.get("1psid", "")),
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
            LOGGER.info("🔄 [DIRECT] GeminiClient 已重載。")


    def _resolve_model_name(self, client: GeminiClient, requested_model: str) -> Optional[str]:
        # Single-model build: everything resolves to gemini-flash.
        # If client status is not AVAILABLE (e.g. UNAUTHENTICATED or limited tier),
        # passing model string causes gemini_webapi to reject with GeminiError.
        # Passing None allows Google to use the account's default model safely!
        if getattr(client, "account_status", None) != AccountStatus.AVAILABLE:
            return None
        return "gemini-flash"

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


