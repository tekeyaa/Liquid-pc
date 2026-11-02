@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p SRC=Перетащи сюда папку с видео и нажми Enter: 
set /p NAME=Имя данных, например video или anime [video]: 
if "%NAME%"=="" set NAME=video
.venv\Scripts\python prep_video.py %SRC% %NAME%.npz --clips 800
pause
