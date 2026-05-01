@echo off
REM SF Service Record - in-place updater
REM Args: %1 = source release folder (on OneDrive)
REM       %2 = install folder (e.g. C:\Users\<user>\service-record-app)
REM
REM This script is copied to %TEMP% before being launched, so the install
REM folder is fully unlocked while we copy. The Electron app must have
REM already called app.quit() before this runs; the timeout below gives
REM Windows a moment to release file locks on electron.exe.

setlocal
set "SRC=%~1"
set "DEST=%~2"

if "%SRC%"=="" goto :usage
if "%DEST%"=="" goto :usage
if not exist "%SRC%\"  goto :nosrc
if not exist "%DEST%\" goto :nodest

REM Wait for the app process to fully release files
timeout /t 3 /nobreak >nul

REM /E    copy subfolders incl. empty ones
REM /R:8  retry up to 8 times on locked files
REM /W:2  wait 2s between retries
REM /XO   only overwrite if source is newer (skips identical files)
REM /NFL /NDL /NJH /NJS  quiet output
robocopy "%SRC%" "%DEST%" /E /R:8 /W:2 /XO /NFL /NDL /NJH /NJS >nul

REM Robocopy exit codes 0-7 are success; 8+ are real errors
if errorlevel 8 goto :copyfail

REM Relaunch the app via electron.exe (same way the desktop shortcut does)
start "" "%DEST%\node_modules\electron\dist\electron.exe" "%DEST%"
endlocal
exit /b 0

:usage
echo Usage: updater.bat ^<source-folder^> ^<install-folder^>
exit /b 1
:nosrc
echo Source folder not found: %SRC%
exit /b 1
:nodest
echo Install folder not found: %DEST%
exit /b 1
:copyfail
echo Update copy failed. The app was not modified.
exit /b 1
