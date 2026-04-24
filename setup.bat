@echo off
echo ============================================================
echo  SF Service Record - Setup
echo ============================================================
echo.

where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo ERROR: Node.js not found.
  echo Download and install from https://nodejs.org  (LTS version)
  echo Then re-run this script.
  pause
  exit /b 1
)

echo Node.js found. Installing dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
  echo ERROR: npm install failed.
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  Setup complete!
echo.
echo  TO RUN:   npm start
echo  TO BUILD installer (.exe):   npm run build
echo    (installer will be in the 'dist' folder)
echo ============================================================
echo.
pause
