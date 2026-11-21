@echo off
chcp 65001 >nul
rem Datum을 내 PC에서 직접 빌드할 때 사용 (보통은 GitHub에서 만든 설치 파일을 쓰면 됩니다)
cd /d "%~dp0"
if not exist .venv ( py -3.12 -m venv .venv || python -m venv .venv )
.venv\Scripts\python -m pip install --upgrade pip
.venv\Scripts\python -m pip install -r requirements.txt -r requirements-windows.txt
.venv\Scripts\pyinstaller --noconfirm --clean packaging\datum.spec || goto :err
start /wait "" dist\Datum\Datum.exe --selftest selftest.txt
type selftest.txt
if exist "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" ( "%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" packaging\datum.iss )
echo.
echo 완료: dist\Datum\Datum.exe  (설치 파일: packaging\Output)
pause
exit /b 0
:err
echo 빌드 실패
pause
exit /b 1
