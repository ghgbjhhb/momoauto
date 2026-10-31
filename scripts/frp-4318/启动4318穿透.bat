@echo off
cd /d "%~dp0"
set "LAUNCHED=0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0frpc4318.ps1" check
if errorlevel 1 set "LAUNCHED=1"
if "%LAUNCHED%"=="1" wscript "%~dp0run-4318-hidden.vbs"
if "%LAUNCHED%"=="1" ping -n 4 127.0.0.1 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0frpc4318.ps1" status
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0frpc4318.ps1" probe
echo Entry: https://hkcn2-1.5913286.cc:14318  (log: frpc-4318.log)
if /i "%~1"=="silent" exit /b 0
pause
