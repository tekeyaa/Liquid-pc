@echo off
chcp 65001 >nul
cd /d "%~dp0"
set /p NET=Какую сеть учить: pro, lite или anime [pro]: 
if "%NET%"=="" set NET=pro
set /p DATA=Файлы данных через пробел [video.npz]: 
if "%DATA%"=="" set DATA=video.npz
.venv\Scripts\python train_gpu.py --net %NET% --data %DATA%
pause
