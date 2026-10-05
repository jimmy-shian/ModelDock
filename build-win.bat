@echo off
REM ChatDock 一鍵打包（Windows）：清除舊產物 → 安裝依賴 → 編譯安裝檔 → exe 複製到根目錄 → 清除中間產物
setlocal
chcp 65001 >nul
cd /d %~dp0

echo.
echo [1/4] 清除舊編譯產物...
if exist "ChatDock-*.exe" del /q "ChatDock-*.exe"
if exist "launcher\release" rmdir /s /q "launcher\release"
if exist "launcher\dist" rmdir /s /q "launcher\dist"
if exist "build" rmdir /s /q "build"
if exist "dist" rmdir /s /q "dist"
echo     已清除。

echo.
echo [2/4] 安裝依賴...
call bun install
if errorlevel 1 goto :fail
call bun install --cwd launcher
if errorlevel 1 goto :fail
echo     依賴完成。

echo.
echo [3/4] 打包 Windows 安裝檔（electron-builder, 需幾分鐘）...
call bun run --cwd launcher package:win
if errorlevel 1 goto :fail
echo     打包完成。

echo.
echo [4/4] 複製安裝檔到根目錄 + 清除中間產物...
set COPIED=0
for %%f in (launcher\release\ChatDock-*.exe) do (
  copy /y "%%f" "%~dp0" >nul
  echo     已複製：%%~nxf
  set COPIED=1
)
if "%COPIED%"=="0" (
  echo     找不到安裝檔，請檢查 launcher\release 內容。
  goto :fail
)
rmdir /s /q "launcher\release"
echo     中間產物已清除，根目錄只留安裝檔。
echo.
dir /b ChatDock-*.exe
echo.
echo 完成。雙擊根目錄的 ChatDock-*.exe 即可安裝使用。
pause
exit /b 0

:fail
echo.
echo 失敗，過程中斷（見上方錯誤訊息）。
pause
exit /b 1
