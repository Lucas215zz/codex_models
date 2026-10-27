@echo off
chcp 65001 >nul
title Codex Model Router
cd /d %~dp0

rem --quiet: 由开机自启脚本调用，全隐藏运行，结束后不等待按键
set QUIET=
if /i "%~1"=="--quiet" set QUIET=1

rem 若 8788 已在监听（计划任务或上一实例已启动），避免重复启动报 EADDRINUSE
netstat -ano -p tcp | findstr /C:"LISTENING" | findstr /C:"127.0.0.1:8788 " >nul
if %errorlevel%==0 (
  if not defined QUIET echo [路由器已在运行] http://127.0.0.1:8788/__routes
  if not defined QUIET ping -n 4 127.0.0.1 >nul
  exit /b 0
)

where node >nul 2>nul
if %errorlevel%==0 (
  node server.mjs
) else (
  "C:\Program Files\nodejs\node.exe" server.mjs
)
echo.
echo [路由器已停止]
if not defined QUIET (
  echo 按任意键关闭窗口...
  pause >nul
)