"""
Antigravity Integration Installer.
Automatically configures MCP servers, custom skills, and rules for Google Antigravity.
"""

import os
import sys
import json
from pathlib import Path
from typing import Dict, Any

from server.config import get_workspace_root, BASE_URL


def install_antigravity_integration() -> Dict[str, Any]:
    """
    Installs and updates Antigravity project configuration in .agents/
    and global MCP settings.
    """
    workspace = get_workspace_root()
    agents_dir = workspace / ".agents"
    skills_dir = agents_dir / "skills" / "gemini-bridge"
    rules_dir = agents_dir / "rules"

    # 1. Create directories
    skills_dir.mkdir(parents=True, exist_ok=True)
    rules_dir.mkdir(parents=True, exist_ok=True)

    # 2. Write .agents/mcp_config.json
    python_exe = sys.executable
    server_script = str(workspace / "mcp_server.py")
    mcp_config = {
        "mcpServers": {
            "gemini-web-bridge": {
                "command": python_exe,
                "args": [server_script],
                "env": {
                    "W2L_WORKSPACE": str(workspace)
                }
            }
        }
    }

    mcp_config_path = agents_dir / "mcp_config.json"
    mcp_config_path.write_text(json.dumps(mcp_config, indent=2, ensure_ascii=False), encoding="utf-8")

    # 3. Write .agents/skills/gemini-bridge/SKILL.md
    skill_content = f"""---
name: gemini-bridge
description: Connects to the local Gemini Web Bridge and MCP Tools (Filesystem, Shell, Grep, Doctor).
---

# Gemini Web Bridge for Antigravity

This skill enables Antigravity to interact with the local **Gemini Web Bridge** and local development MCP tools.

## Features
- **Local API Gateway**: `{BASE_URL}/v1` (OpenAI & Responses API)
- **Local Model Routing**: `gemini-web/flash`
- **MCP Toolset**: Standard sandboxed filesystem, powershell execution, grep code search, and diagnostic tools.

## How to use MCP Tools
When interacting with the workspace, use the tools provided by the `gemini-web-bridge` MCP server:
- `read_file`: Inspect file contents
- `write_file` / `edit_file`: Safely modify or create files
- `list_dir` / `find_files`: Discover directory layout
- `grep_search`: Find text across files
- `run_command`: Execute PowerShell commands
"""
    (skills_dir / "SKILL.md").write_text(skill_content, encoding="utf-8")

    # 4. Write .agents/rules/gemini_rules.md
    rule_content = f"""---
trigger: always_on
---

# Gemini Web Bridge & Antigravity Guidelines

- **Python Virtual Environment**: Always use `{python_exe}` on Windows.
- **Local API Gateway**: The Gemini Web bridge is available at `{BASE_URL}/v1`.
- **MCP Server**: Registered as `gemini-web-bridge` in `.agents/mcp_config.json`.
"""
    (rules_dir / "gemini_rules.md").write_text(rule_content, encoding="utf-8")

    # 5. Also check ~/.gemini/antigravity/ or ~/.gemini/config/ for global MCP registration
    user_home = Path.home()
    global_gemini_dir = user_home / ".gemini"
    global_installed = False

    if global_gemini_dir.exists():
        global_mcp_path = global_gemini_dir / "antigravity" / "mcp_config.json"
        try:
            global_mcp_path.parent.mkdir(parents=True, exist_ok=True)
            existing_cfg = {}
            if global_mcp_path.exists():
                try:
                    existing_cfg = json.loads(global_mcp_path.read_text(encoding="utf-8"))
                except Exception:
                    existing_cfg = {}
            if "mcpServers" not in existing_cfg:
                existing_cfg["mcpServers"] = {}
            existing_cfg["mcpServers"]["gemini-web-bridge"] = mcp_config["mcpServers"]["gemini-web-bridge"]
            global_mcp_path.write_text(json.dumps(existing_cfg, indent=2, ensure_ascii=False), encoding="utf-8")
            global_installed = True
        except Exception:
            pass

    return {
        "status": "success",
        "project_mcp_config": str(mcp_config_path),
        "skill_path": str(skills_dir / "SKILL.md"),
        "rules_path": str(rules_dir / "gemini_rules.md"),
        "global_installed": global_installed,
    }


if __name__ == "__main__":
    result = install_antigravity_integration()
    print("Antigravity Integration installed successfully:")
    print(json.dumps(result, indent=2, ensure_ascii=False))
