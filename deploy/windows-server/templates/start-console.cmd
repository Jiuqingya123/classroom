@echo off
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo [!] 未找到 .env，请先以管理员身份运行 install.ps1 完成初始化。
  pause
  exit /b 1
)

if not exist "data" mkdir "data"
if not exist "logs" mkdir "logs"

echo ============================================
echo  ClassRoom Server - console mode
echo  Health: http://127.0.0.1:8090/healthz
echo  Press Ctrl+C to stop.
echo ============================================
echo.

".\node\node.exe" ".\app\server.mjs"
set EXITCODE=%errorlevel%

echo.
echo Server exited with code %EXITCODE%.
pause
exit /b %EXITCODE%
