#!/usr/bin/env bash
# macOS / Linux 실행 스크립트
cd "$(dirname "$0")"
if [ ! -d .venv ]; then
  echo "[혁신3D] 처음 실행: 필요한 프로그램을 설치합니다..."
  python3 -m venv .venv
  .venv/bin/pip install --upgrade pip
  .venv/bin/pip install -r requirements.txt
fi
.venv/bin/python server.py "$@"
