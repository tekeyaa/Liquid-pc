@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv\Scripts\python.exe (echo Сначала запусти 1-setup.bat & pause & exit /b 1)
set /p NET=Какую сеть учить: pro, lite или anime [pro]: 
if "%NET%"=="" set NET=pro
.venv\Scripts\python train_gpu.py --net %NET%
pause
