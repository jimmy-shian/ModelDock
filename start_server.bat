@echo off
REM ModelDock 桌面應用啟動器（端口 8765 統一閘道）
setlocal EnableDelayedExpansion
cd /d %~dp0

where bun >nul 2>&1
if not errorlevel 1 (
    echo [ModelDock] 透過 Bun 啟動桌面應用 (8765)...
    call bun start
    exit /b %errorlevel%
)

if exist "%LOCALAPPDATA%\Programs\ModelDock\ModelDock.exe" (
    echo [ModelDock] 啟動已安裝之 ModelDock 桌面應用...
    start "" "%LOCALAPPDATA%\Programs\ModelDock\ModelDock.exe"
    exit /b 0
)

for %%f in ("ModelDock-*-win-x64.exe") do (
    echo [ModelDock] 啟動已封裝之安裝程式 %%~nxf...
    start "" "%~dp0%%~nxf"
    exit /b 0
)

echo [ModelDock] 後備啟動：使用 Python 引擎啟動...
set "PYTHON_EXE=C:\Users\Administrator\venv\Scripts\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"
"%PYTHON_EXE%" run_server.py start
