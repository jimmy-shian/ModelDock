"""
Gemini Web Model Catalog & Routing Specifications.
Modeled after codex-chatgpt-web model-catalog.ts and chatgpt-web-models.ts.
Provides context limits, tokenizer budgets, reasoning support, and slug mapping.
"""

from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field


class GeminiWebModelRoute(BaseModel):
    id: str
    slug: str
    display_name: str
    backend_mode: str  # "flash" (sole Gemini backend)
    description: str
    context_window: int = 32_768  # 32K token safe limit for Gemini Web browser transport
    max_output_tokens: int = 8_192
    compaction_reserve_ratio: float = 0.10
    supports_thinking: bool = True
    supports_tools: bool = True
    supports_vision: bool = True
    is_default: bool = False


# Supported model definitions.
# NOTE: Gemini is intentionally a single route (gemini-web/flash). Every other
# Gemini name ever advertised (pro / ultra / thinking / auto / version aliases)
# resolves to this route via the default fallback in resolve_model_route.
AVAILABLE_GEMINI_WEB_ROUTES: List[GeminiWebModelRoute] = [
    GeminiWebModelRoute(
        id="gemini-web/flash",
        slug="gemini-web/flash",
        display_name="Gemini Web - Flash",
        backend_mode="flash",
        description="Gemini Web model (direct: gemini-flash backend, verified working).",
        context_window=32_768,
        max_output_tokens=8_192,
        supports_thinking=False,
        is_default=True,
    ),
    GeminiWebModelRoute(
        id="chatgpt-web/auto",
        slug="chatgpt-web/auto",
        display_name="ChatGPT Web",
        backend_mode="auto",
        description="ChatGPT Web model (extension tab: uses whatever model the page currently has selected).",
        context_window=16_384,
        max_output_tokens=8_192,
        supports_thinking=False,
        is_default=False,
    ),
    GeminiWebModelRoute(
        id="webchat/auto",
        slug="webchat/auto",
        display_name="WebChat - Auto",
        backend_mode="auto",
        description="Universal WebChat route (automatically dispatches to active connected platform).",
        context_window=32_768,
        max_output_tokens=8_192,
        supports_thinking=False,
        is_default=False,
    ),
    GeminiWebModelRoute(
        id="deepseek-web/chat",
        slug="deepseek-web/chat",
        display_name="DeepSeek Web - Chat (V3)",
        backend_mode="deepseek-chat",
        description="DeepSeek Web直連高速對話（thinking_enabled=false）。需設定 DeepSeek userToken。",
        context_window=32_768,
        max_output_tokens=8_192,
        supports_thinking=False,
        is_default=False,
    ),
    # NOTE: deepseek-web/search is intentionally NOT advertised (no option),
    # but search stays fully supported in the engine: any model id containing
    # "search" gets search_enabled=true via resolve_flags() in
    # server/browser/deepseek_direct.py. Re-add a route here to advertise it.
    GeminiWebModelRoute(
        id="deepseek-web/reasoner-search",
        slug="deepseek-web/reasoner-search",
        display_name="DeepSeek Web - Reasoner+Search",
        backend_mode="deepseek-reasoner-search",
        description="DeepSeek Web直連推理+聯網（thinking+search）。需設定 DeepSeek userToken。",
        context_window=32_768,
        max_output_tokens=8_192,
        supports_thinking=True,
        is_default=False,
    ),
    GeminiWebModelRoute(
        id="deepseek-web/auto",
        slug="deepseek-web/auto",
        display_name="DeepSeek Web - Auto (R1 reasoning)",
        backend_mode="deepseek-auto",
        description="DeepSeek Web直連自動（預設推理開）。需設定 DeepSeek userToken。",
        context_window=32_768,
        max_output_tokens=8_192,
        supports_thinking=True,
        is_default=False,
    ),
]

# Alias map: one short alias per canonical route. Anything else falls back
# to the default route in resolve_model_route (transport + flags still honor
# the requested name, so old names keep working without being advertised).
MODEL_ALIAS_MAP: Dict[str, str] = {
    "deepseek-chat": "deepseek-web/chat",
    "deepseek": "deepseek-web/auto",
    "deepseek-reasoner": "deepseek-web/auto",
    "deepseek-r1-search": "deepseek-web/reasoner-search",
    "webchat": "webchat/auto",
    "webchat/auto": "webchat/auto",
}


def resolve_model_route(model_id: Optional[str]) -> GeminiWebModelRoute:
    """
    Resolves any requested model string (including aliases) to a canonical GeminiWebModelRoute.
    Defaults to gemini-web/flash (verified working) if unknown.
    """
    if not model_id:
        return next(r for r in AVAILABLE_GEMINI_WEB_ROUTES if r.is_default)

    norm_id = model_id.strip().lower()
    # Check alias map
    if norm_id in MODEL_ALIAS_MAP:
        norm_id = MODEL_ALIAS_MAP[norm_id]

    for route in AVAILABLE_GEMINI_WEB_ROUTES:
        if route.id == norm_id or route.slug == norm_id or route.backend_mode == norm_id:
            return route

    # Return default flash route
    return next(r for r in AVAILABLE_GEMINI_WEB_ROUTES if r.is_default)


def get_openai_model_catalog() -> List[Dict[str, Any]]:
    """
    Formats the model catalog into the standard OpenAI /v1/models response structure.
    """
    catalog = []
    for route in AVAILABLE_GEMINI_WEB_ROUTES:
        catalog.append({
            "id": route.id,
            "object": "model",
            "created": 1740000000,
            "owned_by": "gemini-web",
            "permission": [],
            "root": route.id,
            "parent": None,
            "display_name": route.display_name,
            "description": route.description,
            "context_window": route.context_window,
            "max_output_tokens": route.max_output_tokens,
            "supports_thinking": route.supports_thinking,
            "supports_tools": route.supports_tools,
            "pricing": {"prompt": "0", "completion": "0"},
        })

    # Add standard aliases
    for alias, target in MODEL_ALIAS_MAP.items():
        if not any(m["id"] == alias for m in catalog):
            target_route = resolve_model_route(target)
            catalog.append({
                "id": alias,
                "object": "model",
                "created": 1740000000,
                "owned_by": "gemini-web",
                "permission": [],
                "root": target_route.id,
                "parent": target_route.id,
                "display_name": f"{alias} (-> {target_route.display_name})",
                "description": f"Alias routing to {target_route.id}",
                "context_window": target_route.context_window,
                "max_output_tokens": target_route.max_output_tokens,
                "supports_thinking": target_route.supports_thinking,
                "supports_tools": target_route.supports_tools,
                "pricing": {"prompt": "0", "completion": "0"},
            })

    return catalog
