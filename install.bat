@echo off
chcp 65001 >nul
title Liquid — установка и обновление
cd /d "%~dp0"
echo.
echo   Liquid browser — установка / обновление
echo   =======================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [!] Не найден Node.js. Поставь LTS с https://nodejs.org и запусти этот файл ещё раз.
  pause
  exit /b 1
)
echo [1/5] Закрываю Liquid, если открыт...
taskkill /im Liquid.exe /f >nul 2>nul
timeout /t 1 /nobreak >nul

echo [2/5] Ставлю свежий движок Electron (пару минут)...
call npm install --no-fund --no-audit --save-dev electron@latest electron-builder@latest
if errorlevel 1 goto fail

echo.
echo [3/5] Проверяю xray-core для VPN...
call node scripts\get-xray.js
if not exist bin\xray.exe goto fail

echo.
echo [4/5] Собираю браузер...
if exist dist rmdir /s /q dist
call npx electron-builder --win dir
if errorlevel 1 goto fail

echo [5/5] Устанавливаю в папку Liquid и создаю ярлык на рабочем столе...
robocopy "dist\win-unpacked" "Liquid" /MIR /NFL /NDL /NJH /NJS /NP >nul
if %errorlevel% geq 8 goto fail
if exist "Liquid.exe" del /q "Liquid.exe"
powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\Liquid.lnk'); $s.TargetPath='%~dp0Liquid\Liquid.exe'; $s.WorkingDirectory='%~dp0Liquid'; $s.IconLocation='%~dp0icon.ico'; $s.Save()"

echo.
echo   Готово! Запускай Liquid с ярлыка на рабочем столе.
start "" "Liquid\Liquid.exe"
timeout /t 3 >nul
exit /b 0

:fail
echo.
echo [!] Что-то пошло не так — смотри ошибку выше. Старая версия браузера (если была) осталась на месте.
pause
exit /b 1
