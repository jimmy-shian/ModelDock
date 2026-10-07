"""
Protocol schemas and data structures for OpenAI Chat Completions,
Codex/Antigravity Responses API, and Browser WebSocket bridging.
"""

from typing import List, Dict, Any, Optional, Union, Literal
from pydantic import BaseModel, Field, ConfigDict
import time
import uuid


# ==========================================
# OpenAI Chat Completions Protocol Models
# ==========================================

class FunctionCall(BaseModel):
    name: str
    arguments: Union[str, Dict[str, Any], Any] = "{}"


class ToolCall(BaseModel):
    id: str = Field(default_factory=lambda: f"call_{uuid.uuid4().hex[:12]}")
    type: Literal["function"] = "function"
    function: FunctionCall


class ChatMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: str  # "system", "user", "assistant", "tool", "function", "developer"
    content: Optional[Union[str, List[Any], Dict[str, Any]]] = ""
    name: Optional[str] = None
    reasoning_content: Optional[str] = None
    tool_calls: Optional[List[Union[ToolCall, Dict[str, Any]]]] = None
    tool_call_id: Optional[str] = None


class ChatCompletionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str = "gemini-web/flash"
    messages: List[ChatMessage]
    stream: Optional[bool] = False
    temperature: Optional[float] = 0.7
    max_tokens: Optional[int] = None
    tools: Optional[List[Dict[str, Any]]] = None
    tool_choice: Optional[Union[str, Dict[str, Any]]] = None


class ChatCompletionResponseChoice(BaseModel):
    index: int = 0
    message: ChatMessage
    finish_reason: Optional[str] = "stop"


class ChatCompletionResponse(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex}")
    object: str = "chat.completion"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[ChatCompletionResponseChoice]
    usage: Dict[str, int] = Field(default_factory=lambda: {
        "prompt_tokens": 0,
        "completion_tokens": 0,
        "total_tokens": 0
    })


class ChatCompletionChunkDelta(BaseModel):
    role: Optional[str] = None
    content: Optional[str] = None
    reasoning_content: Optional[str] = None
    tool_calls: Optional[List[Dict[str, Any]]] = None


class ChatCompletionChunkChoice(BaseModel):
    index: int = 0
    delta: ChatCompletionChunkDelta
    finish_reason: Optional[str] = None


class ChatCompletionChunk(BaseModel):
    id: str = Field(default_factory=lambda: f"chatcmpl-{uuid.uuid4().hex}")
    object: str = "chat.completion.chunk"
    created: int = Field(default_factory=lambda: int(time.time()))
    model: str
    choices: List[ChatCompletionChunkChoice]


# ==========================================
# Responses API (Codex/Antigravity) Models
# ==========================================

class ResponsesRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str = "gemini-web/flash"
    input: Union[str, List[Any], Dict[str, Any]]
    stream: Optional[bool] = True
    tools: Optional[List[Dict[str, Any]]] = None


# ==========================================
# WebSocket Bridge Protocols
# ==========================================

class WSIncomingMessage(BaseModel):
    type: str  # "ready", "chunk", "done", "error", "pong", "status"
    turn_id: Optional[str] = None
    text: Optional[str] = None
    delta: Optional[str] = None
    thought: Optional[str] = None
    thought_delta: Optional[str] = None
    is_generating: Optional[bool] = False
    error: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None


class WSOutgoingMessage(BaseModel):
    type: str  # "submit_prompt", "ping", "stop", "status_query"
    turn_id: Optional[str] = None
    prompt: Optional[str] = None
    model: Optional[str] = None
    options: Optional[Dict[str, Any]] = None


# ==========================================
# Multimodal Helper Utilities
# ==========================================

def extract_images_from_messages(messages: List[ChatMessage]) -> List[Any]:
    """
    Extracts base64 or remote URL images from ChatMessage content lists.
    Returns a list of io.BytesIO objects with a .name attribute suitable for gemini_webapi file upload.
    """
    import base64
    import io

    files: List[Any] = []
    img_idx = 0
    for msg in messages:
        if isinstance(msg.content, list):
            for part in msg.content:
                if isinstance(part, dict):
                    p_type = part.get("type", "")
                    if p_type in ("image_url", "image"):
                        img_data = part.get("image_url", {})
                        url = img_data.get("url", "") if isinstance(img_data, dict) else str(img_data or "")
                        if not url and "url" in part:
                            url = str(part.get("url", ""))

                        if url.startswith("data:image/"):
                            try:
                                header, encoded = url.split(",", 1)
                                ext = ".png"
                                if "image/jpeg" in header or "image/jpg" in header:
                                    ext = ".jpg"
                                elif "image/webp" in header:
                                    ext = ".webp"
                                elif "image/gif" in header:
                                    ext = ".gif"

                                raw_bytes = base64.b64decode(encoded)
                                buf = io.BytesIO(raw_bytes)
                                buf.name = f"input_image_{img_idx}{ext}"
                                files.append(buf)
                                img_idx += 1
                            except Exception:
                                pass
                        elif url.startswith(("http://", "https://")):
                            try:
                                import httpx
                                resp = httpx.get(url, timeout=15)
                                if resp.status_code == 200:
                                    buf = io.BytesIO(resp.content)
                                    buf.name = f"input_image_{img_idx}.png"
                                    files.append(buf)
                                    img_idx += 1
                            except Exception:
                                pass
    return files

