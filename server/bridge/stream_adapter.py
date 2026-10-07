"""
Stream Adapter for formatting SSE outputs for OpenAI Chat Completions
and Codex/Antigravity Responses API.
Modeled after codex-chatgpt-web/src/bridge.ts.
"""

import json
import re
import time
import uuid
import logging
from typing import AsyncGenerator, Dict, Any, Optional

from server.bridge.ws_hub import TurnEvent
from server.protocol import (
    ChatCompletionResponse,
    ChatCompletionResponseChoice,
    ChatMessage,
    ToolCall,
    FunctionCall,
)
from server.bridge.session_manager import SessionManager

from server.bridge.prompt_compiler import STANDARD_CODING_TOOLS

LOGGER = logging.getLogger("webchat2local.bridge")


def _is_canned_error_or_refusal(text: str) -> bool:
    """Detect Gemini Web canned error strings so they are never wrapped into attempt_completion."""
    t = (text or "").strip().lower()
    if not t:
        return True
    canned = [
        "sorry, something went wrong",
        "i encountered an error doing what you asked",
        "i seem to be encountering an error",
        "i'm having a hard time fulfilling your request",
        "an error occurred doing what you asked",
        "please try your request again",
    ]
    return any(c in t for c in canned)


_CONDUIT_RE = re.compile(r"\{[^{}]*\"conduit_(?:token|uuid)\"[^{}]*\}", re.IGNORECASE | re.DOTALL)


def _contains_conduit(s: str) -> bool:
    t = s or ""
    return '"conduit_token"' in t or '"conduit_uuid"' in t


def _sanitize_turn_text(s: str) -> str:
    """Strip ChatGPT conduit handshake plumbing so it never reaches the client.

    The conduit JSON ({"conduit_token":"eyJ..."}) is transport plumbing, never
    the assistant answer. It must be filtered at chunk-arrival time, not just
    at the end of the stream, otherwise the already-emitted deltas leak it to
    the dashboard / API client.
    """
    if not s:
        return s
    if not _contains_conduit(s):
        return s
    cleaned = _CONDUIT_RE.sub("", s)
    if _contains_conduit(cleaned):
        # Split-across-chunks fragment (e.g. '{"conduit_' + 'token":...}')
        # or otherwise unparseable plumbing: drop the whole chunk.
        return ""
    return cleaned


def _merge_text(full: str, inc: str) -> str:
    """Overlap-aware append of an incoming text fragment onto the accumulator.

    Browser turns arrive from two independent sources (network interceptor and
    DOM polling, sometimes two endpoints) with different baselines. A naive
    ``full + delta`` duplicates content whenever the same prefix is delivered
    twice (e.g. greeting ``"你好！😊"`` first, then the full answer
    ``"你好！😊 很高兴..."``). Always returns a string that starts with
    ``full`` so callers can diff ``merged[len(full):]`` for the delta to emit.
    """
    if not inc:
        return full
    if not full:
        return inc
    # The incoming fragment re-sends (part of) what we already have, glued
    # with separators or a continuation char, e.g. full="祝你有美好的一",
    # inc="\n\n       天         祝你有美好的一天". Split into the genuinely
    # new head (cont) and the re-send; keep cont, extend only past full.
    s_core = inc.strip()
    if len(full) >= 2 and s_core and full in s_core:
        idx = s_core.find(full)
        cont = s_core[:idx].strip()
        resend = s_core[idx:]
        if resend == full:
            return full + cont if cont else full
        if resend.startswith(full):
            ext = resend[len(full):]
            if not cont:
                return resend
            if not ext or ext in cont:
                return full + cont
            if cont in ext:
                return full + ext
            return full + cont + ext
    if full.endswith(inc):
        return full
    if inc.startswith(full):
        return inc
    # A second copy often carries HTML indentation leading whitespace
    # ("         祝你有美好一天"). Compare the stripped core too; only the
    # whitespace difference is then dropped, real indentation is preserved
    # by the fallthrough append below.
    core = inc.lstrip()
    if core and core != inc:
        if len(core) >= 4 and full.endswith(core):
            return full
        if core.startswith(full):
            return core
        if len(core) >= 4 and core in full:
            return full
    # Multi-char fragment already contained -> already delivered, drop it.
    # (Single chars are exempt: legit repeats like "哈哈哈" stream char by char.)
    if len(inc) >= 4 and inc in full:
        return full
    # Maximal tail/head overlap (e.g. whitespace-normalized resends).
    probe = core or inc
    maxk = min(len(probe), len(full))
    k = maxk
    while k >= 4 and not full.endswith(probe[:k]):
        k -= 1
    if k >= 4:
        return full + probe[k:]
    return full + inc


def _dedup_leading_repeat(text: str) -> str:
    """Collapse an internally duplicated cumulative text.

    The extension sometimes delivers a cumulative snapshot that already
    contains an earlier fragment: ``"祝你有美好\\n\\n         祝你有美好一天"``.
    A plain prefix check accepts it whole and the duplication survives.
    If HEAD + blank line(s) + REST and REST (stripped, strictly longer)
    starts with HEAD (or contains HEAD with len>=4), keep REST only.

    ChatGPT 免費版 (unauth HTML partial) 的 rebuild 拼接有時只有單個
    ``\\n`` (例如 ``"你好！\\n你好！很高兴..."``)，同樣視為重複拼接處理。
    合法的兩段文字 (REST 與 HEAD 無前綴關係) 不受影響。
    """
    t = text or ""
    for _ in range(2):
        # 注意：中間只吃 [ \t\xa0]*，內容行的前導空白必須留在 group(2)，
        # 否則「帶膠水的重發」會被誤判成乾淨重複。\xa0 來自 HTML &nbsp;
        # 縮排，\r?\n 兼容 CRLF。
        m = re.match(r"^(.+?)\r?\n[ \t\xa0]*\r?\n([\s\S]+)$", t, re.DOTALL)
        if m:
            head, rest = m.group(1).strip(), m.group(2)
            rest_stripped = rest.strip()
            if head and len(rest_stripped) >= len(head):
                if rest_stripped == head and rest == rest_stripped:
                    pass  # legit verbatim repeat without glue; preserve
                elif rest_stripped.startswith(head) or (len(head) >= 4 and head in rest_stripped):
                    t = rest.lstrip()
                    continue
                else:
                    break
            elif head:
                break
            else:
                break
        # 單換行拼接 (HTML rebuild 常見)：HEAD + \n + REST，
        # 僅當 REST 明確以 HEAD 開頭且更長時才折疊，避免誤傷正常換行。
        m1 = re.match(r"^(.+?)\r?\n[ \t\xa0]*([\s\S]+)$", t, re.DOTALL)
        if not m1:
            break
        head, rest = m1.group(1).strip(), m1.group(2)
        rest_stripped = rest.strip()
        if not head or len(head) < 2 or len(rest_stripped) <= len(head):
            break
        if rest_stripped.startswith(head):
            # 排除逐字重複的短句 (例如 "哈哈\n哈哈" 可能是刻意重複)：
            # 只有 REST 明顯更長 (多出 >=2 字元) 才視為拼接殘留。
            if len(rest_stripped) >= len(head) + 2:
                t = rest.lstrip()
            else:
                break
        else:
            break
    return t


def _is_transport_noise(text: str) -> bool:
    """Reject opaque Google transport strings accidentally selected as answers."""
    s = (text or "").strip()
    if not s:
        return False

    # ChatGPT "conduit" handshake JSON ({"conduit_token":"eyJ..."}) is transport
    # plumbing, never the assistant answer. Drop it so the fallback message is used.
    if _contains_conduit(s):
        return True

    if re.fullmatch(r"^(?:https?:)?//\S+", s, re.IGNORECASE):
        return True
    if re.fullmatch(r"^\s*//?\[?www\.\S+", s, re.IGNORECASE):
        return True
    if re.fullmatch(r"https?://(?:[a-zA-Z0-9-]+\.)*(?:google\.com|googleusercontent\.com|gstatic\.com)/\S+", s, re.IGNORECASE):
        return True
    if re.fullmatch(r"[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+", s):
        return True
    if re.fullmatch(r"(?:台灣|臺灣|香港|澳門|日本|美國|中國|Taiwan|Hong Kong|Japan|USA)[\u4e00-\u9fa5A-Za-z0-9\s,.-]{0,35}(?:縣|市|區|里|鄉|鎮|村|路|段|District|City|County|State|Township)", s):
        return True
    if re.search(r"根據您的\s*(?:IP|位置|過去活動)|依據您的位置|Based on your (?:IP|location)|From your IP", s, re.IGNORECASE):
        return True

    # If the text has spaces, multiple lines, CJK characters, or markdown headers, it's real output
    if "\n" in s or " " in s:
        if len(s.split()) > 1 or re.search(r"[\u3000\u3400-\u9fff\u3040-\u30ff]", s):
            return False

    if re.fullmatch(r"[A-Za-z0-9_-]{12,}", s):
        return True
    if re.fullmatch(r"[A-Fa-f0-9]{12,}", s):
        return True
    return False


async def stream_openai_completions(
    event_generator: AsyncGenerator[TurnEvent, None],
    model: str = "gemini-web/flash",
    req_id: Optional[str] = None,
    available_tool_names: Optional[list[str]] = None,
) -> AsyncGenerator[str, None]:
    """
    Generates OpenAI-compatible SSE events (POST /v1/chat/completions?stream=true).
    Supports both content streaming and reasoning_content (thinking process) streaming.
    """
    completion_id = req_id or f"chatcmpl-{uuid.uuid4().hex[:16]}"
    created_ts = int(time.time())

    # Initial chunk with role="assistant"
    initial_chunk = {
        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created_ts,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {"role": "assistant", "content": ""},
                "finish_reason": None,
            }
        ],
    }
    yield f"data: {json.dumps(initial_chunk, ensure_ascii=False)}\n\n"

    last_text = ""
    last_thought = ""
    full_text = ""
    emitted_text = ""
    tool_mode = False
    pending_tool_prefix = ""

    def split_tool_boundary(delta: str):
        """Return safe text before a tool marker, buffering split XML prefixes.

        Gemini can split `<tool_call>` across arbitrary transport chunks.  If
        we forward `<tool_` from one chunk before recognizing the marker in the
        next chunk, Kilo/Cline sees malformed XML instead of a structured
        tool_calls response.
        """
        nonlocal pending_tool_prefix, tool_mode
        if tool_mode:
            return ""

        combined = pending_tool_prefix + delta
        pending_tool_prefix = ""

        marker_tokens = [
            "<tool_call>", "<tool_call ", "Google Search", "```json", "```tool_code", "```python",
            "Action:", "call:", '{"command":', '{"name":', '{"tool":', '{"path":', '{"todos":',
            'name":', '"name":', '"command":'
        ]
        target_names = list(available_tool_names or [])
        for st in STANDARD_CODING_TOOLS:
            if st not in target_names:
                target_names.append(st)
        marker_tokens.extend(f"<{name}>" for name in target_names)
        marker_tokens.extend(f"<{name} " for name in target_names)

        positions = [(combined.find(token), token) for token in marker_tokens if combined.find(token) >= 0]
        if positions:
            pos, _ = min(positions, key=lambda item: item[0])
            tool_mode = True
            return combined[:pos]

        # Hold only a suffix which could be the beginning of a marker.  Keep
        # the longest possible prefix so normal text is still streamed.
        prefix_lengths = []
        for token in marker_tokens:
            for n in range(1, min(len(token), len(combined)) + 1):
                if combined.endswith(token[:n]):
                    prefix_lengths.append(n)
        if prefix_lengths:
            n = max(prefix_lengths)
            pending_tool_prefix = combined[-n:]
            return combined[:-n]
        return combined

    async for event in event_generator:
        if event.type == "error":
            err_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": f"\n\n[Error: {event.error}]"},
                        "finish_reason": "stop",
                    }
                ],
            }
            yield f"data: {json.dumps(err_chunk, ensure_ascii=False)}\n\n"
            break

        # 1. Stream Thinking/Reasoning deltas if present
        if event.thought_delta:
            thought_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": event.thought_delta},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(thought_chunk, ensure_ascii=False)}\n\n"
        elif event.thought and len(event.thought) > len(last_thought):
            diff = event.thought[len(last_thought):]
            last_thought = event.thought
            thought_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"reasoning_content": diff},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(thought_chunk, ensure_ascii=False)}\n\n"

        # 2. Stream content. Once a tool-call marker appears, hold the tool
        # payload back; the host client must receive structured tool_calls
        # rather than XML rendered as assistant text.
        # Sanitize conduit plumbing FIRST so it never accumulates or streams.
        # Merge overlap-aware: network + DOM deliver the same prefix twice.
        _ev_delta = _dedup_leading_repeat(_sanitize_turn_text(event.delta or ""))
        _ev_text = _dedup_leading_repeat(_sanitize_turn_text(event.text or ""))
        prev_len = len(full_text)
        if _ev_text:
            if len(_ev_text) >= len(full_text):
                full_text = _dedup_leading_repeat(_merge_text(full_text, _ev_text))
            elif not (full_text.endswith(_ev_text)
                      or (len(_ev_text) >= 4 and _ev_text in full_text)):
                pass  # stale snapshot from another element; ignore
            incoming_delta = full_text[prev_len:]
        elif _ev_delta:
            full_text = _dedup_leading_repeat(_merge_text(full_text, _ev_delta))
            incoming_delta = full_text[prev_len:]
        else:
            incoming_delta = ""

        if not tool_mode:
            # Tool/XML tags can be split across browser stream chunks.  Once
            # we see a partial opening tag, hold it until the complete model
            # output is available instead of leaking XML to the client.
            safe_delta = split_tool_boundary(incoming_delta)
        else:
            safe_delta = ""

        if safe_delta:
            emitted_text += safe_delta
            content_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": safe_delta},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"

        last_text = full_text

        if event.type == "done":
            # A marker prefix may have been buffered at the end of the stream.
            # It is intentionally not emitted: the complete tool payload is
            # converted to structured tool_calls below when possible.
            break

    # 最終保險：DONE 承載的 cumulative 快照本身可能已帶重複拼接。
    full_text = _dedup_leading_repeat(full_text)
    extracted_tools = SessionManager.extract_tool_calls(full_text, available_tool_names)

    if not extracted_tools and _is_transport_noise(full_text):
        full_text = ""
    finish_reason = "stop"
    if extracted_tools:
        finish_reason = "tool_calls"
        for index, tc in enumerate(extracted_tools):
            args_val = tc.get("arguments", {})
            if isinstance(args_val, dict):
                args_str = json.dumps(args_val, ensure_ascii=False)
            elif isinstance(args_val, str):
                args_str = args_val
            else:
                args_str = json.dumps(args_val, ensure_ascii=False)

            LOGGER.info("🔧 [TOOL CALL] %s(%s)", tc["name"], args_str[:120])

            tool_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": index,
                            "id": f"call_{uuid.uuid4().hex[:12]}",
                            "type": "function",
                            "function": {
                                "name": tc["name"],
                                "arguments": args_str,
                            },
                        }]
                    },
                    "finish_reason": None,
                }]
            }
            yield f"data: {json.dumps(tool_chunk, ensure_ascii=False)}\n\n"
    elif tool_mode and full_text and len(full_text) > len(emitted_text):
        # If tool mode suppressed text but no valid tools were extracted,
        # emit the suppressed text so no response is dropped.
        remaining = full_text[len(emitted_text):]
        if remaining:
            content_chunk = {
                "id": completion_id,
                "object": "chat.completion.chunk",
                "created": created_ts,
                "model": model,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": remaining},
                        "finish_reason": None,
                    }
                ],
            }
    # Guarantee: never end with both content and tool_calls empty
    if finish_reason == "stop" and not emitted_text.strip():
        fallback_msg = full_text.strip() if full_text.strip() else "I have received your request and am ready to assist. Please let me know how you'd like to proceed."
        content_chunk = {
            "id": completion_id,
            "object": "chat.completion.chunk",
            "created": created_ts,
            "model": model,
            "choices": [
                {
                    "index": 0,
                    "delta": {"content": fallback_msg},
                    "finish_reason": None,
                }
            ],
        }
        yield f"data: {json.dumps(content_chunk, ensure_ascii=False)}\n\n"
        emitted_text += fallback_msg

    LOGGER.info("✅ [DONE] 串流回應完成 | Model: %s | 輸出長度: %d | Finish: %s", model, len(full_text), finish_reason)

    # Final termination chunk
    final_chunk = {

        "id": completion_id,
        "object": "chat.completion.chunk",
        "created": created_ts,
        "model": model,
        "choices": [
            {
                "index": 0,
                "delta": {},
                "finish_reason": finish_reason,
            }
        ],
    }
    yield f"data: {json.dumps(final_chunk, ensure_ascii=False)}\n\n"
    yield "data: [DONE]\n\n"


async def stream_responses_api(
    event_generator: AsyncGenerator[TurnEvent, None],
    model: str = "gemini-web/flash",
    req_id: Optional[str] = None,
) -> AsyncGenerator[str, None]:
    """
    Generates Codex/Antigravity Responses API SSE stream (POST /v1/responses).
    """
    resp_id = req_id or f"resp_{uuid.uuid4().hex[:16]}"
    item_id = f"item_{uuid.uuid4().hex[:12]}"
    created_ts = int(time.time())

    # 1. response.created
    yield f"event: response.created\ndata: {json.dumps({'id': resp_id, 'model': model, 'status': 'in_progress', 'created_at': created_ts})}\n\n"

    # 2. response.output_item.added
    yield f"event: response.output_item.added\ndata: {json.dumps({'response_id': resp_id, 'output_index': 0, 'item': {'id': item_id, 'type': 'message', 'role': 'assistant', 'content': []}})}\n\n"

    last_text = ""
    last_thought = ""

    async for event in event_generator:
        if event.type == "error":
            yield f"event: response.failed\ndata: {json.dumps({'response_id': resp_id, 'error': {'type': 'bridge_error', 'message': event.error}})}\n\n"
            return

        # Thinking delta
        if event.thought_delta:
            yield f"event: response.reasoning.delta\ndata: {json.dumps({'response_id': resp_id, 'item_id': item_id, 'delta': event.thought_delta})}\n\n"
        elif event.thought and len(event.thought) > len(last_thought):
            diff = event.thought[len(last_thought):]
            last_thought = event.thought
            yield f"event: response.reasoning.delta\ndata: {json.dumps({'response_id': resp_id, 'item_id': item_id, 'delta': diff})}\n\n"

        # Text delta (conduit plumbing stripped first, overlap-merged)
        _ev_delta = _dedup_leading_repeat(_sanitize_turn_text(event.delta or ""))
        _ev_text = _dedup_leading_repeat(_sanitize_turn_text(event.text or ""))
        if _ev_delta and not _ev_text:
            prev = last_text
            last_text = _dedup_leading_repeat(_merge_text(last_text, _ev_delta))
            diff = last_text[len(prev):]
            if diff:
                yield f"event: response.text.delta\ndata: {json.dumps({'response_id': resp_id, 'item_id': item_id, 'delta': diff})}\n\n"
        elif _ev_text:
            if len(_ev_text) >= len(last_text):
                prev = last_text
                last_text = _dedup_leading_repeat(_merge_text(last_text, _ev_text))
                diff = last_text[len(prev):]
                if diff:
                    yield f"event: response.text.delta\ndata: {json.dumps({'response_id': resp_id, 'item_id': item_id, 'delta': diff})}\n\n"
            elif not (last_text.endswith(_ev_text)
                      or (len(_ev_text) >= 4 and _ev_text in last_text)):
                pass  # stale snapshot from another element; ignore

        if event.type == "done":
            break

    # 3. response.output_item.done
    yield f"event: response.output_item.done\ndata: {json.dumps({'response_id': resp_id, 'output_index': 0, 'item': {'id': item_id, 'type': 'message', 'role': 'assistant', 'status': 'completed', 'content': [{'type': 'text', 'text': last_text}]}})}\n\n"

    # 4. response.completed
    yield f"event: response.completed\ndata: {json.dumps({'id': resp_id, 'status': 'completed', 'model': model})}\n\n"


async def collect_complete_response(
    event_generator: AsyncGenerator[TurnEvent, None],
    model: str = "gemini-web/flash",
    available_tool_names: Optional[list[str]] = None,
) -> ChatCompletionResponse:
    """
    Consumes the turn stream and constructs a non-streaming ChatCompletionResponse.
    """
    full_text = ""
    full_thought = ""

    async for event in event_generator:
        LOGGER.debug(
            "COLLECT event | type=%s text_len=%d delta_len=%d thought_len=%d",
            event.type, len(event.text or ""), len(event.delta or ""),
            len(event.thought or ""),
        )
        if event.type == "error":
            full_text += f"\n[Error: {event.error}]"
            break
        _ev_text = _dedup_leading_repeat(_sanitize_turn_text(event.text or ""))
        _ev_delta = _dedup_leading_repeat(_sanitize_turn_text(event.delta or ""))
        if _ev_text:
            if len(_ev_text) >= len(full_text):
                full_text = _dedup_leading_repeat(_merge_text(full_text, _ev_text))
            elif not (full_text.endswith(_ev_text)
                      or (len(_ev_text) >= 4 and _ev_text in full_text)):
                pass  # stale snapshot from another element; ignore
        elif _ev_delta:
            full_text = _dedup_leading_repeat(_merge_text(full_text, _ev_delta))
        if event.thought:
            full_thought = event.thought
        elif event.thought_delta:
            full_thought += event.thought_delta
        if event.type == "done":
            break

    # Check for tool calls (final dedup: DONE snapshot itself may carry the join)
    full_text = _dedup_leading_repeat(full_text)
    extracted_tools = SessionManager.extract_tool_calls(full_text, available_tool_names)


    if not extracted_tools and _is_transport_noise(full_text):
        full_text = ""
    tool_calls = None
    if extracted_tools:
        tool_calls = []
        for tc in extracted_tools:
            args_json = json.dumps(tc.get("arguments", {}), ensure_ascii=False) if isinstance(tc.get("arguments"), dict) else str(tc.get("arguments", "{}"))
            LOGGER.info("🔧 [TOOL CALL] %s(%s)", tc["name"], args_json[:120])
            tool_calls.append(
                ToolCall(
                    function=FunctionCall(
                        name=tc["name"],
                        arguments=args_json,
                    )
                )
            )

    if not tool_calls and not full_text.strip():
        full_text = "I have received your request and am ready to assist. Please let me know how you'd like to proceed."

    LOGGER.info("✅ [DONE] 回應收集完成 | Model: %s | 輸出長度: %d | Finish: %s", model, len(full_text), "tool_calls" if tool_calls else "stop")


    msg = ChatMessage(
        role="assistant",
        content=None if tool_calls else full_text,
        reasoning_content=full_thought if full_thought else None,
        tool_calls=tool_calls,
    )

    return ChatCompletionResponse(
        model=model,
        choices=[ChatCompletionResponseChoice(index=0, message=msg, finish_reason="tool_calls" if tool_calls else "stop")],
        usage={
            "prompt_tokens": len(full_text.split()) // 2,
            "completion_tokens": len(full_text.split()),
            "total_tokens": (len(full_text.split()) // 2) + len(full_text.split()),
        },
    )
