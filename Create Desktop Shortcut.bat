@echo off
REM Thin wrapper around "Create Desktop Shortcut.vbs" — the VBScript does
REM the actual work via native WScript.Shell. We launch with wscript.exe
REM (not cscript) so the user only sees friendly dialog boxes, no console.

start "" wscript.exe "%~dp0Create Desktop Shortcut.vbs"
