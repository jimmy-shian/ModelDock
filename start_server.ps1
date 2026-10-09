# ModelDock PowerShell Launcher (Port 8765 Unified Gateway)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "ModelDock Unified Gateway"

Set-Location -LiteralPath $PSScriptRoot

Write-Host "[ModelDock] Starting ModelDock AI Workstation on http://127.0.0.1:8765..." -ForegroundColor Cyan

if (Get-Command bun -ErrorAction SilentlyContinue) {
    Write-Host "[ModelDock] Launching via Bun..." -ForegroundColor Green
    & bun start
    exit $LASTEXITCODE
}

$installedApp = "$env:LOCALAPPDATA\Programs\ModelDock\ModelDock.exe"
if (Test-Path $installedApp) {
    Write-Host "[ModelDock] Launching installed ModelDock application..." -ForegroundColor Green
    Start-Process $installedApp
    exit 0
}

$packagedExe = Get-ChildItem -Path "$PSScriptRoot\ModelDock-*-win-x64.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if ($packagedExe) {
    Write-Host "[ModelDock] Launching installer $($packagedExe.Name)..." -ForegroundColor Green
    Start-Process $packagedExe.FullName
    exit 0
}

$pythonExe = "C:\Users\Administrator\venv\Scripts\python.exe"
if (-not (Test-Path $pythonExe)) { $pythonExe = "python" }

Write-Host "[ModelDock] Launching Python backend directly on 8765..." -ForegroundColor Yellow
& $pythonExe run_server.py start
