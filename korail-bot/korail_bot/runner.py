"""조회 → 매칭 → 예약 반복 루프."""
from __future__ import annotations

import random
import time
from dataclasses import dataclass
from datetime import datetime

from .client import FatalError, NeedLogin, SoldOut
from .config import Job
from .matcher import candidates

MAX_BACKOFF = 300.0     # 연속 오류 시 최대 대기(초)
MAX_RELOGIN = 5         # 연속 재로그인 허용 횟수


@dataclass
class Result:
    ok: bool
    attempts: int
    reservation: object = None
    train: object = None
    waiting: bool = False
    reason: str = ""


def _fmt(t: str) -> str:
    return f"{t[:2]}:{t[2:4]}"


def describe(train) -> str:
    name = getattr(train, "train_type_name", "") or "열차"
    return (f"{name} {train.train_no} {getattr(train, 'dep_name', '')}→"
            f"{getattr(train, 'arr_name', '')} {_fmt(train.dep_time)}~{_fmt(train.arr_time)}")


def run(job: Job, client, *, log=print, sleep=time.sleep, now=datetime.now,
        rand=random.random, dry_run: bool = False) -> Result:
    stop_at = datetime.strptime(job.stop_at, "%Y-%m-%d %H:%M") if job.stop_at else None
    attempts = errors = relogins = 0

    def wait(base: float) -> None:
        # ±20% 흔들어 일정한 간격의 기계적 요청을 피한다
        sleep(base * (0.8 + 0.4 * rand()))

    while True:
        if job.max_attempts and attempts >= job.max_attempts:
            return Result(False, attempts, reason="최대 시도 횟수 도달")
        if stop_at and now() >= stop_at:
            return Result(False, attempts, reason="종료 시각 도달")
        attempts += 1

        try:
            trains = client.search(job)
            errors = 0
            picks = candidates(trains, job)
            if not picks:
                log(f"[{attempts}] 조건에 맞는 빈자리 없음 (조회 {len(trains)}편)")
            for train, waiting in picks:
                kind = "예약대기" if waiting else "좌석"
                if dry_run:
                    log(f"[{attempts}] (dry-run) {kind} 발견: {describe(train)}")
                    return Result(True, attempts, train=train, waiting=waiting,
                                  reason="dry-run")
                log(f"[{attempts}] {kind} 발견 → 예약 시도: {describe(train)}")
                try:
                    rsv = client.reserve(train, job, waiting)
                except SoldOut:
                    log("    └ 그 사이에 매진됨, 다음 후보로")
                    continue
                return Result(True, attempts, reservation=rsv, train=train, waiting=waiting)
            relogins = 0
        except NeedLogin:
            relogins += 1
            if relogins > MAX_RELOGIN:
                return Result(False, attempts, reason="재로그인 반복 실패")
            log("세션 만료 → 재로그인")
            client.login()
            continue
        except FatalError as e:
            return Result(False, attempts, reason=str(e))
        except Exception as e:  # 네트워크 오류 등: 지수 백오프
            errors += 1
            delay = min(job.interval * (2 ** errors), MAX_BACKOFF)
            log(f"[{attempts}] 오류: {e!r} → {delay:.0f}초 후 재시도")
            sleep(delay)
            continue

        wait(job.interval)
