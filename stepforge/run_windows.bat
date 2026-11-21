@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .venv (
  echo [StepForge] 처음 실행: 필요한 프로그램을 설치합니다. 몇 분 걸립니다...
  py -3 -m venv .venv || python -m venv .venv
  .venv\Scripts\python -m pip install --upgrade pip
  .venv\Scripts\python -m pip install -r requirements.txt
)
.venv\Scripts\python server.py
pause
