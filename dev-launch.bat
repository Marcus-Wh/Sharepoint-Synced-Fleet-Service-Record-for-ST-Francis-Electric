@echo off
REM Launches the app directly from source — no build, no install.
REM Edits to main.js / preload.js / index.html show up the next time
REM you run this script (or hit Ctrl+R inside the app to reload the
REM renderer for HTML/JS changes only).

cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo electron.exe not found. Running npm install first...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Make sure Node.js is installed.
    pause
    exit /b 1
  )
)

start "" "node_modules\electron\dist\electron.exe" .
