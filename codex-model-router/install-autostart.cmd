@echo off
chcp 65001 >nul
setlocal
set "TASKNAME=%~1"
if "%TASKNAME%"=="" set "TASKNAME=CodexModelRouter"

echo 正在设置开机自启（登录时自动启动 Codex 模型路由器）...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-autostart.ps1" -TaskName "%TASKNAME%"
if errorlevel 1 (
  echo.
  echo [失败] 计划任务注册失败，请把上面的报错发给我。
  pause
  exit /b 1
)
echo.
pause