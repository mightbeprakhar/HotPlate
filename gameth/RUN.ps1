<#
    HOTPLATE - one-click launcher for Windows PowerShell
    -----------------------------------------------------
    Serves this folder over http://localhost:8778 and opens the game in your
    default browser. Closing this window (or pressing Ctrl+C) stops the server.

    Usage, from the folder that contains this file:

        powershell -ExecutionPolicy Bypass -File .\RUN.ps1

    Why a server at all? The game also runs by double-clicking index.html.
    A local server is the safer option because some browsers refuse to load
    sibling <script> files from a file:// page. This avoids that entirely.

    No installation, no accounts, no internet connection required.
#>

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8778
$url  = "http://localhost:$port/index.html"

Write-Host ''
Write-Host '  HOTPLATE - a Hotelling location game' -ForegroundColor Yellow
Write-Host '  ------------------------------------' -ForegroundColor DarkGray

if (-not (Test-Path (Join-Path $root 'index.html'))) {
    Write-Host "  ERROR: index.html was not found in $root" -ForegroundColor Red
    Write-Host '  Keep RUN.ps1 in the same folder as index.html.' -ForegroundColor Red
    Read-Host '  Press Enter to close'
    exit 1
}

# Prefer Python (present on most machines and ships with http.server).
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { $py = Get-Command py -ErrorAction SilentlyContinue }

if ($py) {
    Write-Host "  Serving $root" -ForegroundColor DarkGray
    Write-Host "  Open:  $url" -ForegroundColor Cyan
    Write-Host '  Stop:  Ctrl+C in this window' -ForegroundColor DarkGray
    Write-Host ''
    Start-Process $url
    Push-Location $root
    try   { & $py.Source -m http.server $port }
    finally { Pop-Location }
    exit 0
}

# No Python: fall back to opening the file directly. This works in Chrome,
# Edge and Firefox for this project, but is less reliable in general.
Write-Host '  Python was not found on PATH.' -ForegroundColor Yellow
Write-Host '  Opening index.html directly instead (Ctrl+O in your browser).' -ForegroundColor Yellow
Write-Host ''
Start-Process (Join-Path $root 'index.html')
Write-Host '  If the board stays empty, install Python from python.org' -ForegroundColor DarkGray
Write-Host '  and run this script again.' -ForegroundColor DarkGray
Read-Host '  Press Enter to close'
