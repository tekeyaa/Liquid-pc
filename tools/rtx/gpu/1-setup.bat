@echo off
chcp 65001 >nul
cd /d "%~dp0"
where ffmpeg >nul 2>nul || (echo Нет ffmpeg. Выполни в терминале: winget install Gyan.FFmpeg — потом закрой окно и запусти этот файл снова. & pause & exit /b 1)
if not exist .venv\Scripts\python.exe (where py >nul 2>nul && py -3 -m venv .venv || python -m venv .venv)
if not exist .venv\Scripts\python.exe (echo Нет Python. Поставь Python 3.12 с python.org, отметь Add python.exe to PATH. & pause & exit /b 1)
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
.venv\Scripts\python -m pip install numpy pillow
.venv\Scripts\python -c "import torch;print('Видеокарта:', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'НЕ ВИДНА - см. README')"
pause
