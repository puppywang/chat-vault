@echo off
rem ChatVault launcher: start serve (minimized) if not already running, then open the UI.
rem Pure ASCII on purpose (cmd.exe code-page safe).
setlocal
cd /d "%~dp0"
set "PORT=8377"

netstat -ano | findstr /C:":%PORT% " | findstr /C:"LISTENING" >nul 2>&1
if %errorlevel%==0 goto :open

where node >nul 2>&1
if not %errorlevel%==0 (
  echo [ChatVault] node not found in PATH. Install Node.js ^>= 22.5 first.
  pause
  exit /b 1
)

echo [ChatVault] starting on port %PORT% ...
start "ChatVault" /min cmd /c "node src/cli.js serve --port %PORT%"
timeout /t 2 /nobreak >nul

:open
rem arg "nobrowser" (autostart shortcut) suppresses opening the UI on login
if /i not "%~1"=="nobrowser" start "" http://localhost:%PORT%/
endlocal
