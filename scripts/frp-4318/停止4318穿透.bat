@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0frpc4318.ps1" stop
echo Only the 4318 tunnel is stopped. The 8188 frpc keeps running.
if /i "%~1"=="silent" exit /b 0
pause
