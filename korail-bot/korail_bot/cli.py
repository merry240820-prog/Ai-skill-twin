"""명령줄 진입점: python -m korail_bot ..."""
from __future__ import annotations

import argparse
import getpass
import os
import sys

from .config import MIN_INTERVAL, SEAT_OPTIONS, TRAIN_TYPES, Job, Passengers
from .notify import notify
from .runner import describe, run


def _hhmm(v: str) -> str:
    v = v.replace(":", "")
    if len(v) == 4:
        v += "00"
    if len(v) != 6 or not v.isdigit():
        raise argparse.ArgumentTypeError("시각은 HH:MM 형식")
    return v


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="korail_bot",
        description="코레일 빈자리를 감시하다가 조건에 맞는 좌석이 나오면 자동으로 예약합니다. "
                    "결제는 하지 않으며, 예약 후 코레일톡 앱에서 기한 내 결제해야 합니다.",
    )
    p.add_argument("--config", help="JSON 설정 파일 (지정 시 아래 옵션 대신 사용)")
    p.add_argument("--dep", help="출발역 (예: 서울)")
    p.add_argument("--arr", help="도착역 (예: 부산)")
    p.add_argument("--date", help="출발일 yyyyMMdd")
    p.add_argument("--from", dest="time_from", type=_hhmm, default="000000",
                   help="이 시각 이후 출발 (HH:MM)")
    p.add_argument("--to", dest="time_to", type=_hhmm, default="235959",
                   help="이 시각 이전 출발 (HH:MM)")
    p.add_argument("--train-type", choices=TRAIN_TYPES, default="ALL")
    p.add_argument("--train-no", action="append", default=[],
                   help="특정 열차 번호만 (여러 번 지정 가능)")
    p.add_argument("--seat", choices=SEAT_OPTIONS, default="GENERAL_FIRST")
    p.add_argument("--adult", type=int, default=1)
    p.add_argument("--child", type=int, default=0)
    p.add_argument("--senior", type=int, default=0)
    p.add_argument("--toddler", type=int, default=0)
    p.add_argument("--waiting", action="store_true", help="좌석 없으면 예약대기 신청")
    p.add_argument("--interval", type=float, default=5.0,
                   help=f"조회 간격 초 (최소 {MIN_INTERVAL})")
    p.add_argument("--max-attempts", type=int, default=0, help="0 = 무제한")
    p.add_argument("--stop-at", help="이 시각에 중지 'yyyy-MM-dd HH:mm'")
    p.add_argument("--dry-run", action="store_true",
                   help="예약하지 않고 빈자리 발견까지만 확인")
    return p


def job_from_args(a) -> Job:
    if a.config:
        return Job.load(a.config)
    missing = [n for n in ("dep", "arr", "date") if not getattr(a, n)]
    if missing:
        raise ValueError("필수 옵션 누락: " + ", ".join("--" + m for m in missing))
    job = Job(
        dep=a.dep, arr=a.arr, date=a.date,
        time_from=a.time_from, time_to=a.time_to,
        train_type=a.train_type, train_nos=a.train_no, seat=a.seat,
        passengers=Passengers(a.adult, a.child, a.senior, a.toddler),
        try_waiting=a.waiting, interval=a.interval,
        max_attempts=a.max_attempts, stop_at=a.stop_at,
    )
    job.validate()
    return job


def credentials() -> tuple[str, str]:
    kid = os.environ.get("KORAIL_ID") or input("코레일 회원번호/이메일/휴대폰: ").strip()
    kpw = os.environ.get("KORAIL_PW") or getpass.getpass("비밀번호: ")
    return kid, kpw


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    try:
        job = job_from_args(args)
    except (ValueError, OSError) as e:
        print(f"설정 오류:\n{e}", file=sys.stderr)
        return 2

    from .client import FatalError, KorailClient

    client = KorailClient(*credentials())
    try:
        who = client.login()
    except FatalError as e:
        print(e, file=sys.stderr)
        return 1
    print(f"로그인: {who}")
    print(f"감시 시작: {job.dep}→{job.arr} {job.date} "
          f"{job.time_from[:2]}:{job.time_from[2:4]}~{job.time_to[:2]}:{job.time_to[2:4]} "
          f"{job.seat} {job.passengers.total()}명 (Ctrl+C 로 중지)")

    try:
        res = run(job, client, dry_run=args.dry_run)
    except KeyboardInterrupt:
        print("\n사용자가 중지했습니다.")
        return 130

    if res.ok and res.reason == "dry-run":
        notify(f"[코레일] 빈자리 발견 (dry-run): {describe(res.train)}")
        return 0
    if res.ok:
        kind = "예약대기 신청" if res.waiting else "예약 완료"
        notify(f"[코레일] {kind}! {describe(res.train)}\n"
               f"{res.reservation}\n"
               "※ 결제 기한 내에 코레일톡 앱에서 결제하지 않으면 자동 취소됩니다.")
        return 0
    notify(f"[코레일] 예약 실패: {res.reason} (시도 {res.attempts}회)")
    return 1


if __name__ == "__main__":
    sys.exit(main())
