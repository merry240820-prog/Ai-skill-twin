"""예약 성공/실패 알림. 텔레그램은 환경변수가 있을 때만 사용."""
from __future__ import annotations

import os
import sys


def _bell() -> None:
    sys.stdout.write("\a")
    sys.stdout.flush()


def telegram(text: str) -> bool:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_CHAT_ID")
    if not (token and chat):
        return False
    try:
        import requests
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data={"chat_id": chat, "text": text},
            timeout=10,
        )
        return r.ok
    except Exception as e:  # 알림 실패가 예약 결과를 망치면 안 됨
        print(f"[알림] 텔레그램 전송 실패: {e}", file=sys.stderr)
        return False


def notify(text: str) -> None:
    print(text)
    _bell()
    telegram(text)
