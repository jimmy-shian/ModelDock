"""
Dedicated WebChat (Gemini & ChatGPT) Analysis Tools for Model Context Protocol (MCP).
Allows external primary AI models (Claude 3.7, GPT-4o, DeepSeek, etc.) in Cline, Kilo,
Cursor, and Antigravity to harness WebChat's massive context, thinking process,
multimodal perception, and live web search grounding as specialized sub-tools.
"""

import os
import io
import mimetypes
from typing import List, Optional, Dict, Any

from server.browser.gemini_direct import direct_engine, is_configured as direct_is_configured
from server.browser.deepseek_direct import (
    deepseek_engine,
    is_configured as deepseek_is_configured,
)
from server.bridge.ws_hub import hub


def _is_deepseek_target(model: str) -> bool:
    m = (model or "").strip().lower()
    return "deepseek" in m


async def _execute_analysis(
    prompt: str,
    model: str = "webchat/auto",
    files: Optional[list] = None,
) -> Dict[str, Any]:
    """
    Executes an analysis turn using the unified transport (ChatGPT or Gemini).
    Falls back gracefully between direct cookie engine and browser extension WebSocket hub.
    """
    # 1. If ChatGPT is explicitly targeted or ChatGPT extension is connected
    is_chatgpt_target = (
        "chatgpt" in model.lower()
        or (hub.is_connected and hub.browser_info.get("platform") == "chatgpt")
        and "deepseek" not in model.lower()
    )
    if is_chatgpt_target:
        if not hub.is_connected:
            raise RuntimeError("ChatGPT 擴充套件尚未連線。請在 Chrome 或 Edge 開啟 https://chatgpt.com/。")
        accumulated_text = ""
        accumulated_thought = ""
        async for event in hub.execute_turn(prompt=prompt, model=model, is_new_session=True):
            if event.type == "error":
                raise RuntimeError(event.error)
            if event.text:
                accumulated_text = event.text
            elif event.delta:
                accumulated_text += event.delta
            if event.thought:
                accumulated_thought = event.thought
            elif event.thought_delta:
                accumulated_thought += event.thought_delta
        return {
            "text": accumulated_text,
            "thought": accumulated_thought,
            "citations": [],
            "model": "chatgpt-web",
            "provider": "ChatGPT",
        }

    # 2. DeepSeek direct engine (userToken + PoW, no browser tab needed)
    if _is_deepseek_target(model):
        try:
            res = await deepseek_engine.generate_analysis(prompt=prompt, model=model, files=files)
            res["provider"] = "DeepSeek"
            return res
        except Exception as e:
            if not hub.is_connected and not direct_is_configured():
                raise e
            # Fall through to extension hub if DeepSeek direct failed but a
            # browser tab is available (parity with the Gemini path below).
            if not hub.is_connected:
                raise e

    # 3. Try Gemini direct engine if configured (or mocked in tests)
    try:
        res = await direct_engine.generate_analysis(prompt=prompt, model=model, files=files)
        res["provider"] = "Gemini"
        return res
    except Exception as e:
        if not hub.is_connected:
            # If direct failed and hub is also not connected, re-raise direct error
            raise e

    # 4. Fallback to browser extension hub (Gemini or whatever is open)
    if hub.is_connected:
        accumulated_text = ""
        accumulated_thought = ""
        async for event in hub.execute_turn(prompt=prompt, model=model, is_new_session=True):
            if event.type == "error":
                raise RuntimeError(event.error)
            if event.text:
                accumulated_text = event.text
            elif event.delta:
                accumulated_text += event.delta
            if event.thought:
                accumulated_thought = event.thought
            elif event.thought_delta:
                accumulated_thought += event.thought_delta
        platform_label = str(hub.browser_info.get("platform", "WebChat")).capitalize()
        return {
            "text": accumulated_text,
            "thought": accumulated_thought,
            "citations": [],
            "model": hub.browser_info.get("model_name", model),
            "provider": platform_label,
        }

    raise RuntimeError(
        "瀏覽器擴充套件未連線 (請開啟 https://chatgpt.com 或 https://gemini.google.com)，"
        "且未配置本機 Gemini Cookie / DeepSeek Token。"
    )


async def analyze_code(
    files: Optional[List[str]] = None,
    code_snippet: Optional[str] = None,
    instructions: str = "Perform an in-depth code review, identify potential bugs, architectural flaws, security issues, and propose concrete improvements.",
    model: str = "webchat/auto",
) -> str:
    """
    Analyzes local source files or raw code snippets using WebChat's context window.

    Args:
        files: List of file paths to inspect and analyze (relative or absolute).
        code_snippet: Optional raw code, diff, or log text to analyze alongside or instead of files.
        instructions: Specific review directives or questions about the code.
        model: Model or route to use ('webchat/auto', 'chatgpt-web/auto', 'gemini-web/flash').
    """
    file_blocks = []
    if files:
        for fpath in files:
            path_str = str(fpath).strip()
            if not path_str:
                continue
            if not os.path.exists(path_str):
                file_blocks.append(f"### File: `{path_str}`\n[Warning: File does not exist or cannot be accessed]")
                continue

            try:
                with open(path_str, "r", encoding="utf-8", errors="replace") as f:
                    file_content = f.read()
                file_blocks.append(f"### File: `{path_str}` ({len(file_content):,} chars)\n```\n{file_content}\n```")
            except Exception as err:
                file_blocks.append(f"### File: `{path_str}`\n[Read Error: {err}]")

    prompt_parts = [
        "## TASK DIRECTIVE",
        instructions.strip(),
        "",
        "## CODE CONTEXT FOR ANALYSIS",
    ]

    if file_blocks:
        prompt_parts.extend(file_blocks)
    if code_snippet and code_snippet.strip():
        prompt_parts.append(f"### Additional Code / Diff Snippet:\n```\n{code_snippet.strip()}\n```")

    if not file_blocks and not (code_snippet and code_snippet.strip()):
        return "[Error]: Please provide at least one valid file path in 'files' or code in 'code_snippet' to analyze."

    full_prompt = "\n".join(prompt_parts)

    try:
        res = await _execute_analysis(prompt=full_prompt, model=model)
        provider = res.get("provider", "Gemini")
        output = []
        if res.get("thought"):
            output.append(f"### [{provider} Reasoning / 思考過程]\n{res['thought']}\n")
        output.append(f"### [{provider} Code Review / 代碼審查報告]\n{res.get('text', '')}")
        return "\n".join(output)
    except Exception as e:
        return f"[WebChat Analysis Error]: {e}"


async def ask_gemini(
    prompt: str,
    model: str = "webchat/auto",
) -> str:
    """
    Consults WebChat for general problem solving, complex architecture questions, or deep reasoning.

    Args:
        prompt: The query or reasoning prompt to send to WebChat.
        model: Model to use ('webchat/auto', 'gemini-web/flash', 'chatgpt-web/auto').
    """
    clean_prompt = prompt.strip()
    if not clean_prompt:
        return "[Error]: Prompt cannot be empty."

    try:
        res = await _execute_analysis(prompt=clean_prompt, model=model)
        provider = res.get("provider", "Gemini")
        output = []
        if res.get("thought"):
            output.append(f"### [{provider} Reasoning / 思考過程]\n{res['thought']}\n")
        output.append(f"### [{provider} Response / 回應]\n{res.get('text', '')}")
        if res.get("citations"):
            output.append("\n### [Sources / 參考來源]\n" + "\n".join(f"- {c}" for c in res["citations"]))
        return "\n".join(output)
    except Exception as e:
        return f"[WebChat Ask Error]: {e}"


async def inspect_image(
    image_path: str,
    prompt: str = "Analyze this image, screenshot, or UI mockup. Identify UI components, visual bugs, styling defects, or text contents.",
    model: str = "gemini-web/flash",
) -> str:
    """
    Inspects a local image or screenshot using WebChat's multimodal capabilities.

    Args:
        image_path: Absolute or relative path to the image file (PNG, JPG, WEBP, GIF).
        prompt: Specific question or inspection instructions for the image.
        model: Model to use (defaults to 'gemini-web/flash' for quick vision analysis).
    """
    if not os.path.exists(image_path):
        return f"[Error]: Image file '{image_path}' not found on local filesystem."

    try:
        with open(image_path, "rb") as f:
            raw_bytes = f.read()

        bio = io.BytesIO(raw_bytes)
        ext = os.path.splitext(image_path)[1].lower()
        mime_type, _ = mimetypes.guess_type(image_path)
        bio.name = f"image{ext or '.png'}"
        bio.content_type = mime_type or "image/png"

        res = await _execute_analysis(
            prompt=prompt.strip(),
            model=model,
            files=[bio],
        )
        provider = res.get("provider", "Gemini")
        output = []
        if res.get("thought"):
            output.append(f"### [{provider} Vision Reasoning / 視覺思考過程]\n{res['thought']}\n")
        output.append(f"### [{provider} Vision Analysis / 視覺分析結果]\n{res.get('text', '')}")
        return "\n".join(output)
    except Exception as e:
        return f"[WebChat Vision Error]: {e}"


async def web_search(
    query: str,
    instructions: Optional[str] = None,
) -> str:
    """
    Searches the live web using search grounding for up-to-date technical docs.

    Args:
        query: The search keywords or error message to query.
        instructions: Optional specific focus or formatting instructions.
    """
    search_prompt = (
        f"Please perform a real-time web search for the following query and provide an accurate, up-to-date technical summary:\n\n"
        f"Query: {query.strip()}\n\n"
        f"{('Instructions: ' + instructions.strip()) if instructions else ''}"
    )

    try:
        res = await _execute_analysis(prompt=search_prompt, model="gemini-web/flash")
        provider = res.get("provider", "Gemini")
        output = [f"### [{provider} Web Search Results / 即時檢索結果]\n{res.get('text', '')}"]
        if res.get("citations"):
            output.append("\n### [Citations / 參考資料連結]\n" + "\n".join(f"- {c}" for c in res["citations"]))
        return "\n".join(output)
    except Exception as e:
        return f"[WebChat Search Error]: {e}"
