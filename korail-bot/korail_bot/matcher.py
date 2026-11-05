"""조회 결과에서 예약할 열차를 고르는 순수 로직 (네트워크 없음)."""
from __future__ import annotations

from .config import Job


def in_window(train, job: Job) -> bool:
    return job.time_from <= train.dep_time <= job.time_to


def seat_available(train, seat: str) -> bool:
    general = train.has_general_seat()
    special = train.has_special_seat()
    if seat == "GENERAL_ONLY":
        return general
    if seat == "SPECIAL_ONLY":
        return special
    return general or special


def waiting_available(train, seat: str) -> bool:
    # 코레일 예약대기는 일반실만 지원
    return seat != "SPECIAL_ONLY" and train.has_general_waiting_list()


def candidates(trains, job: Job) -> list[tuple[object, bool]]:
    """예약 시도할 (열차, 예약대기여부) 목록. 출발 시각 순, 좌석 우선."""
    wanted = set(job.train_nos)
    pool = [
        t for t in trains
        if in_window(t, job) and (not wanted or t.train_no.lstrip("0") in
                                  {n.lstrip("0") for n in wanted})
    ]
    pool.sort(key=lambda t: t.dep_time)

    seats = [(t, False) for t in pool if seat_available(t, job.seat)]
    waits = []
    if job.try_waiting:
        waits = [(t, True) for t in pool
                 if not seat_available(t, job.seat) and waiting_available(t, job.seat)]
    return seats + waits
