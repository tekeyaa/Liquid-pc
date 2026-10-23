@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist node_modules\electron (
  echo Сначала запусти install.bat
  pause
  exit /b 1
)
start "" /b npx electron .
