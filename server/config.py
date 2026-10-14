"""
Configuration module for Gemini-Web-to-Local Bridge.
Manages server ports, security policies, workspace root, and model catalog.
"""

import os
from pathlib import Path
from typing import Dict, Any, List

from server.model_catalog import (
    AVAILABLE_GEMINI_WEB_ROUTES,
    MODEL_ALIAS_MAP,
    get_openai_model_catalog,
    resolve_model_route,
)

# Server configuration
SERVER_HOST = os.getenv("W2L_HOST", "127.0.0.1")
SERVER_PORT = int(os.getenv("W2L_PORT", "8765"))
BASE_URL = f"http://{SERVER_HOST}:{SERVER_PORT}"
VERSION = "2.5.1"

# Security & Workspace
def get_workspace_root() -> Path:
    """Returns the current active workspace root."""
    return Path(os.getenv("W2L_WORKSPACE", os.getcwd())).resolve()

# Ignored patterns for file operations to protect project integrity
IGNORED_DIRS = {
    ".git", "node_modules", ".venv", "venv", "__pycache__",
    ".pytest_cache", ".idea", ".vscode", "dist", "build"
}
IGNORED_FILES = {
    ".env", ".env.local", "credentials.json", "id_rsa", "id_ed25519"
}
IGNORED_EXTENSIONS = {".pem", ".key", ".pfx", ".p12"}

# Export model catalog
MODEL_CATALOG: List[Dict[str, Any]] = get_openai_model_catalog()

# Timeouts & Limits (in seconds)
DEFAULT_BROWSER_TIMEOUT = int(os.getenv("W2L_BROWSER_TIMEOUT", "180"))
DEFAULT_COMMAND_TIMEOUT = int(os.getenv("W2L_COMMAND_TIMEOUT", "60"))
WEBSOCKET_HEARTBEAT_INTERVAL = 10
MAX_IN_MEMORY_LOGS = 1000

# Direct (cookie-based) Gemini access.
#   - W2L_DIRECT_FALLBACK=1  -> enable fallback (default on)
#   - W2L_DIRECT_FALLBACK=0  -> disable fallback, require the extension
DIRECT_FALLBACK_ENABLED = os.getenv("W2L_DIRECT_FALLBACK", "1") not in ("0", "false", "False")
# Default to direct connection mode (免開分頁，以 gemini_webapi 直連為核心預設)
DIRECT_ONLY = os.getenv("W2L_DIRECT_ONLY", "0") not in ("0", "false", "False")

