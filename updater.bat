@echo off
REM SF Service Record - NSIS update launcher
REM Arg: %1 = path to the Setup .exe (already copied to %TEMP% by the app)
REM
REM This script is launched from %TEMP% after the app calls app.quit(). The
REM wait below gives Windows a moment to release file locks on the running
REM exe so the installer can replace it. The NSIS assisted installer upgrades
REM in place and relaunches the app itself (runAfterFinish), so we only need
REM to start it.

setlocal
set "INSTALLER=%~1"

if "%INSTALLER%"=="" goto :usage
if not exist "%INSTALLER%" goto :noinstaller

REM Wait for the app process to fully release files
timeout /t 3 /nobreak >nul

REM Launch the installer (assisted wizard; relaunches the app when finished)
start "" "%INSTALLER%"

endlocal
exit /b 0

:usage
echo Usage: updater.bat ^<installer-exe^>
exit /b 1
:noinstaller
echo Installer not found: %INSTALLER%
exit /b 1
