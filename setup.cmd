@echo off
chcp 65001 >nul
cd /d %~dp0
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [ERROR] Node.js not found. Please install it from https://nodejs.org first, then run this again.
  pause
  exit /b 1
)
node setup.mjs
echo.
pause
