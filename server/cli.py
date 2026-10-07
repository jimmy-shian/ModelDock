"""
Rich Command-Line Interface for Gemini Web to Local Bridge.
Supports: start, status, doctor, mcp, setup, chat, test.
"""

import sys
import os
import argparse
import asyncio
import httpx
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.panel import Panel

# Add root directory to path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from server.config import SERVER_HOST, SERVER_PORT, BASE_URL, VERSION
from server.antigravity.installer import install_antigravity_integration
from mcp_server import mcp
from server.doctor import run_doctor
from server.mcp.tools_system import get_workspace_status

console = Console()


def cmd_start(args):
    """Starts the Gemini Web to Local Bridge FastAPI server."""
    import uvicorn
    from server.bridge.ws_hub import setup_clean_logging
    setup_clean_logging()

    host = args.host or SERVER_HOST
    port = args.port or SERVER_PORT
    console.print(Panel.fit(
        f"[bold cyan]Gemini Web to Local Bridge v{VERSION}[/bold cyan]\n"
        f"API Base URL: [green]http://{host}:{port}/v1[/green]\n"
        f"Dashboard:    [blue]http://{host}:{port}[/blue]\n"
        f"WebSocket:    [yellow]ws://{host}:{port}/ws[/yellow]\n\n"
        f"[dim]Ready for Cline, Kilo, Antigravity, Cursor, and RooCode.[/dim]",
        title="Server Starting",
        border_style="blue",
    ))
    uvicorn.run("server.app:app", host=host, port=port, log_level="info")


def cmd_status(args):
    """Prints runtime status and health diagnostics."""
    status = get_workspace_status()
    doc = run_doctor()

    table = Table(title=f"Gemini Web Bridge System Status (v{VERSION})", border_style="cyan")
    table.add_column("Property", style="bold white")
    table.add_column("Value", style="green")

    for k, v in status.items():
        table.add_row(k, str(v))

    console.print(table)

    doc_table = Table(title="Health Diagnostics", border_style="green")
    doc_table.add_column("Check ID", style="bold white")
    doc_table.add_column("Status", style="cyan")
    doc_table.add_column("Message", style="white")

    for c in doc["checks"]:
        st = c["status"].upper()
        color = "green" if st == "OK" else ("yellow" if st == "WARNING" else "red")
        doc_table.add_row(c["id"], f"[{color}]{st}[/{color}]", c["message"])

    console.print(doc_table)


def cmd_doctor(args):
    """Runs complete diagnostics."""
    doc = run_doctor()
    console.print(Panel.fit(
        f"Overall Health: [bold {'green' if doc['overall_status']=='ok' else 'red'}]{doc['overall_status'].upper()}[/]\n"
        f"Workspace Root: [cyan]{doc['workspace_root']}[/cyan]\n"
        f"Available Models: [yellow]{', '.join(doc['available_models'])}[/yellow]",
        title="Gemini Web Bridge Doctor",
        border_style="cyan",
    ))

    table = Table(title="Diagnostic Checks", border_style="blue")
    table.add_column("ID", style="bold")
    table.add_column("Status", style="bold")
    table.add_column("Message")
    table.add_column("Detail", style="dim")

    for c in doc["checks"]:
        st = c["status"].upper()
        color = "green" if st == "OK" else ("yellow" if st == "WARNING" else "red")
        table.add_row(c["id"], f"[{color}]{st}[/{color}]", c["message"], c.get("detail", ""))

    console.print(table)


def cmd_mcp(args):
    """Runs the MCP Stdio Server (for Antigravity/Cline/Cursor)."""
    mcp.run()


def cmd_setup(args):
    """Installs or refreshes Google Antigravity integration."""
    console.print("[bold yellow]Installing Antigravity Integration...[/bold yellow]")
    res = install_antigravity_integration()
    console.print(Panel.fit(
        f"Project MCP: [green]{res['project_mcp_config']}[/green]\n"
        f"Skill:       [green]{res['skill_path']}[/green]\n"
        f"Rule:        [green]{res['rules_path']}[/green]\n"
        f"Global Reg:  [green]{res['global_installed']}[/green]",
        title="Antigravity Setup Completed",
        border_style="green",
    ))


async def _async_chat(prompt: str, model: str):
    url = f"{BASE_URL}/v1/chat/completions"
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "stream": True,
    }
    console.print(f"[bold cyan]Sending prompt to {model}...[/bold cyan]\n")
    async with httpx.AsyncClient(timeout=180.0) as client:
        try:
            async with client.stream("POST", url, json=payload) as response:
                if response.status_code != 200:
                    err_body = await response.aread()
                    console.print(f"[red]Error ({response.status_code}): {err_body.decode()}[/red]")
                    return
                async for line in response.aiter_lines():
                    if line.startswith("data: ") and "[DONE]" not in line:
                        import json
                        try:
                            data = json.loads(line[6:])
                            delta = data.get("choices", [{}])[0].get("delta", {})
                            if "reasoning_content" in delta and delta["reasoning_content"]:
                                console.print(f"[dim italic]{delta['reasoning_content']}[/dim italic]", end="")
                            if "content" in delta and delta["content"]:
                                console.print(delta["content"], end="")
                        except Exception:
                            pass
                console.print("\n")
        except Exception as e:
            console.print(f"[red]Connection error: {e}[/red]")


def cmd_chat(args):
    """Sends a single test prompt to the running bridge server."""
    prompt = args.prompt or "Hello, please write a quick Python hello world!"
    model = args.model or "gemini-web/flash"
    asyncio.run(_async_chat(prompt, model))


def main():
    parser = argparse.ArgumentParser(description=f"Gemini Web to Local Bridge CLI v{VERSION}")
    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # Start command
    p_start = subparsers.add_parser("start", help="Start the FastAPI bridge server")
    p_start.add_argument("--host", default=SERVER_HOST, help="Host to bind (default 127.0.0.1)")
    p_start.add_argument("--port", type=int, default=SERVER_PORT, help="Port to bind (default 8765)")
    p_start.set_defaults(func=cmd_start)

    # Status command
    p_status = subparsers.add_parser("status", help="Show system status and health")
    p_status.set_defaults(func=cmd_status)

    # Doctor command
    p_doctor = subparsers.add_parser("doctor", help="Run system diagnostics")
    p_doctor.set_defaults(func=cmd_doctor)

    # MCP command
    p_mcp = subparsers.add_parser("mcp", help="Run the stdio MCP server")
    p_mcp.set_defaults(func=cmd_mcp)

    # Setup command
    p_setup = subparsers.add_parser("setup", help="Install Antigravity rules and MCP config")
    p_setup.set_defaults(func=cmd_setup)

    # Chat command
    p_chat = subparsers.add_parser("chat", help="Send a test prompt")
    p_chat.add_argument("prompt", nargs="?", default="Hello from CLI", help="Prompt text")
    p_chat.add_argument("--model", default="gemini-web/flash", help="Model name")
    p_chat.set_defaults(func=cmd_chat)

    args = parser.parse_args()
    if hasattr(args, "func"):
        args.func(args)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
