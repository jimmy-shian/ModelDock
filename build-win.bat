@echo off
REM ModelDock one-click build (Windows, Plan-A desktop app)
REM Steps: env check - clean - install deps - typecheck - package - collect exe
REM Output: ModelDock-*-win-*.exe (NSIS installer)
setlocal EnableDelayedExpansion
chcp 65001 >nul
cd /d %~dp0

echo.
echo ============================================================
echo  ModelDock Desktop App Auto Build [Plan-A]
echo ============================================================
echo  Output: ModelDock-*-win-*.exe (NSIS installer)
echo.

REM ---- [0/5] env check ----
echo [0/5] Checking environment...
where bun >nul 2>&1
if errorlevel 1 (
  echo [ERROR] bun not found. Install Bun 1.4+ from https://bun.sh/ then retry.
  pause
  exit /b 1
)
echo     bun found:
call bun --version
if not exist "launcher\package.json" (
  echo [ERROR] launcher\package.json not found. Run in project root.
  pause
  exit /b 1
)
if not exist "launcher\electron\main.cjs" (
  echo [ERROR] launcher\electron\main.cjs not found. Project incomplete.
  pause
  exit /b 1
)
echo     Env OK.

REM ---- [1/5] clean ----
echo.
echo [1/5] Cleaning old build outputs...
if exist "ModelDock-*.exe" del /q "ModelDock-*.exe" 2>nul
if exist "ChatDock-*.exe" del /q "ChatDock-*.exe" 2>nul
if exist "launcher\release" rmdir /s /q "launcher\release" 2>nul
if exist "launcher\dist" rmdir /s /q "launcher\dist" 2>nul
if exist "build" rmdir /s /q "build" 2>nul
if exist "dist" rmdir /s /q "dist" 2>nul
echo     Cleaned.

REM ---- [2/5] install deps ----
echo.
echo [2/5] Installing dependencies...
call bun install
if errorlevel 1 goto :fail
call bun install --cwd launcher
if errorlevel 1 goto :fail
echo     Deps done.

REM ---- [3/5] typecheck ----
echo.
echo [3/5] Typecheck...
call bun run --cwd launcher typecheck
if errorlevel 1 (
  echo [WARN] typecheck failed. Press any key to continue, Ctrl+C to abort...
  pause >nul
)
echo     Check done.

REM ---- [4/5] package ----
echo.
echo [4/5] Packaging Windows installer (electron-builder, takes minutes)...
call bun run --cwd launcher package:win
if errorlevel 1 goto :fail
echo     Packaged.

REM ---- [5/5] collect ----
echo.
echo [5/5] Copying installer to project root...
if not exist "launcher\release" (
  echo     launcher\release not found. Check build log above.
  goto :fail
)
set COPIED=0
for %%f in (launcher\release\ModelDock-*.exe) do (
  copy /y "%%f" "%~dp0" >nul
  echo     Copied: %%~nxf
  set COPIED=1
)
if "!COPIED!"=="0" (
  echo     Installer not found. Contents of launcher\release:
  dir /b "launcher\release" 2>nul
  goto :fail
)
del /q "launcher\release\*.blockmap" 2>nul
del /q "launcher\release\*.yml" 2>nul
rmdir /s /q "launcher\release"
echo     Temp files removed. Only installer kept in root.
echo.
echo ============================================================
echo  BUILD SUCCESS
echo ============================================================
dir /b ModelDock-*.exe
echo.
echo Done. Double-click ModelDock-*.exe to install.
echo First run: login once in each tab [ChatGPT] [Gemini] [DeepSeek].
pause
exit /b 0

:fail
echo.
echo ============================================================
echo  BUILD FAILED - see error above.
echo ============================================================
pause
exit /b 1
