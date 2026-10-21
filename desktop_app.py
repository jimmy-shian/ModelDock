"""
Desktop background application for Gemini Web to Local Bridge.
Features:
  - System Tray icon (pystray) with 0 disk wear.
  - Runs FastAPI Uvicorn server in a daemon thread.
  - One-click tray menu actions (Dashboard, Antigravity setup, clipboard copy).
"""

import sys
import os
import threading
import time
import webbrowser
import logging
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent))

# When launched via pythonw.exe (windowless), sys.stdout/sys.stderr are None.
# Redirect them to devnull so print()/logging never crash without a console.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w", encoding="utf-8")

import uvicorn
from PIL import Image, ImageDraw
import pystray

from server.config import SERVER_HOST, SERVER_PORT, BASE_URL
from server.antigravity.installer import install_antigravity_integration


def create_tray_icon_image():
    """Loads the official ModelDock icon (64x64) if available; falls back to a drawn placeholder."""
    here = Path(__file__).resolve().parent
    candidates = [
        here / "launcher" / "build" / "icon.png",
        here / "icon.png",
        here.parent / "app.asar" / "build" / "icon.png",
    ]
    for candidate in candidates:
        if candidate.is_file():
            try:
                img = Image.open(candidate).convert("RGBA").resize((64, 64), Image.LANCZOS)
                mask = Image.new("L", (64, 64), 0)
                ImageDraw.Draw(mask).rounded_rectangle((0, 0, 63, 63), radius=14, fill=255)
                img.putalpha(mask)
                return img
            except Exception:
                pass  # fall through to placeholder
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    
    # Outer circle
    draw.ellipse((4, 4, 60, 60), fill="#2563eb", outline="#60a5fa", width=2)
    # Inner decorative arc
    draw.arc((12, 12, 52, 52), start=45, end=315, fill="#ffffff", width=4)
    # Center dot
    draw.ellipse((28, 28, 36, 36), fill="#ffffff")
    return image


def start_uvicorn():
    """Starts Uvicorn server in daemon thread."""
    from server.bridge.ws_hub import setup_clean_logging
    setup_clean_logging()

    config = uvicorn.Config(
        "server.app:app",
        host=SERVER_HOST,
        port=SERVER_PORT,
        log_level="info",
        access_log=True,
        log_config=None,
    )
    server = uvicorn.Server(config)
    server.run()


def open_dashboard(icon, item):
    webbrowser.open(f"http://{SERVER_HOST}:{SERVER_PORT}")


def run_antigravity_setup(icon, item):
    res = install_antigravity_integration()
    icon.notify("Google Antigravity MCP 設定已成功更新！", title="Gemini Web Bridge")


def copy_api_endpoint(icon, item):
    try:
        import pyperclip
        pyperclip.copy(f"{BASE_URL}/v1")
        icon.notify(f"API 端點已複製: {BASE_URL}/v1", title="Gemini Web Bridge")
    except Exception:
        pass


def exit_action(icon, item):
    global _shutting_down
    _shutting_down = True
    icon.stop()
    os._exit(0)


# ---- Restart / auto-restart (tray) ----
_server_thread = None
_tray_icon = None
_auto_restart = True
_shutting_down = False


def _launch_server_thread():
    """(Re)start the Uvicorn daemon thread. Returns the new thread."""
    global _server_thread
    _server_thread = threading.Thread(target=start_uvicorn, daemon=True)
    _server_thread.start()
    return _server_thread


def restart_server(icon, item):
    """Manual restart: spawn a fresh process, then terminate this one."""
    try:
        import subprocess
        script = str(Path(__file__).resolve())
        subprocess.Popen([sys.executable, script])
        if icon:
            try:
                icon.notify("正在重新啟動伺服器…", title="Gemini Web Bridge")
            except Exception:
                pass
            icon.stop()
    except Exception as e:
        try:
            if icon:
                icon.notify(f"重啟失敗：{e}", title="Gemini Web Bridge")
        except Exception:
            pass
        return
    global _shutting_down
    _shutting_down = True
    time.sleep(0.5)
    os._exit(0)


def toggle_auto_restart(icon, item):
    global _auto_restart
    _auto_restart = not _auto_restart
    try:
        if icon:
            icon.notify(
                "自動重啟已開啟：伺服器崩潰時會自動拉起。" if _auto_restart
                else "自動重啟已關閉：伺服器崩潰時不再自動拉起。",
                title="Gemini Web Bridge",
            )
    except Exception:
        pass
    # Force tray menu refresh so the checkmark updates.
    try:
        if icon:
            icon.update_menu()
    except Exception:
        pass


def is_auto_restart_enabled(item):
    return bool(_auto_restart)


def _auto_restart_watchdog():
    """Background watchdog: if Uvicorn thread dies, relaunch it."""
    while True:
        time.sleep(5)
        if _shutting_down:
            return
        try:
            t = _server_thread
            if t is not None and not t.is_alive() and _auto_restart and not _shutting_down:
                print("[WebChat2Local] Uvicorn thread died; auto-restarting…")
                _launch_server_thread()
                try:
                    if _tray_icon:
                        _tray_icon.notify("伺服器意外停止，已自動重啟。", title="Gemini Web Bridge")
                except Exception:
                    pass
        except Exception:
            continue


def is_server_already_running() -> bool:
    """Returns True if the local server port is already bound (duplicate launch)."""
    import socket
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(0.5)
            return sock.connect_ex((SERVER_HOST, SERVER_PORT)) == 0
    except Exception:
        return False


def main():
    global _tray_icon
    # Duplicate-launch guard: if the server is already up, just open the
    # dashboard instead of creating a second (dead) tray icon.
    if is_server_already_running():
        print("[WebChat2Local] Server already running; opening dashboard.")
        webbrowser.open(f"http://{SERVER_HOST}:{SERVER_PORT}")
        return

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
        datefmt="%H:%M:%S",
    )
    print("[WebChat2Local] ==================================================")
    print(f"[WebChat2Local] Gemini Web Bridge -> {BASE_URL}")
    print(f"[WebChat2Local] Python executable: {sys.executable}")
    print("[WebChat2Local] Browser extension events and turn traffic will be logged below.")
    print("[WebChat2Local] ==================================================")
    
    # 1. Start Uvicorn in background thread (+ watchdog for auto-restart)
    _launch_server_thread()
    threading.Thread(target=_auto_restart_watchdog, daemon=True).start()

    # 2. Wait briefly and open browser
    time.sleep(1.2)
    webbrowser.open(f"http://{SERVER_HOST}:{SERVER_PORT}")

    # 3. Create Tray menu
    menu = pystray.Menu(
        pystray.MenuItem("開啟儀表板 (Dashboard)", open_dashboard, default=True),
        pystray.MenuItem("重啟服務 (Restart)", restart_server),
        pystray.MenuItem("Antigravity 一鍵設定", run_antigravity_setup),
        pystray.MenuItem("複製 API 端點 (Base URL)", copy_api_endpoint),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(
            "自動重啟 (Auto-restart)",
            toggle_auto_restart,
            checked=is_auto_restart_enabled,
        ),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("結束 (Exit)", exit_action),
    )
    
    icon_image = create_tray_icon_image()
    icon = pystray.Icon(
        "GeminiWeb2Local",
        icon_image,
        "Gemini Web to Local Bridge",
        menu
    )
    _tray_icon = icon
    
    # 4. Run tray icon in main thread
    icon.run()


if __name__ == "__main__":
    main()
