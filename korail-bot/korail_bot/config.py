"""예매 작업 설정."""
from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from datetime import datetime

# 서버 부담과 계정 차단을 막기 위한 최소 조회 간격(초)
MIN_INTERVAL = 3.0

SEAT_OPTIONS = ("GENERAL_FIRST", "GENERAL_ONLY", "SPECIAL_FIRST", "SPECIAL_ONLY")
TRAIN_TYPES = ("ALL", "KTX", "ITX", "SAEMAEUL", "MUGUNGHWA")


@dataclass
class Passengers:
    adult: int = 1
    child: int = 0
    senior: int = 0
    toddler: int = 0

    def total(self) -> int:
        return self.adult + self.child + self.senior + self.toddler


@dataclass
class Job:
    dep: str                       # 출발역 (예: "서울")
    arr: str                       # 도착역 (예: "부산")
    date: str                      # yyyyMMdd
    time_from: str = "000000"      # 이 시각 이후 출발 (hhmmss)
    time_to: str = "235959"        # 이 시각 이전 출발 (hhmmss)
    train_type: str = "ALL"
    train_nos: list[str] = field(default_factory=list)  # 비어 있으면 모든 열차
    seat: str = "GENERAL_FIRST"
    passengers: Passengers = field(default_factory=Passengers)
    try_waiting: bool = False      # 좌석이 없으면 예약대기 신청
    interval: float = 5.0          # 조회 간격(초)
    max_attempts: int = 0          # 0 = 무제한
    stop_at: str | None = None     # "yyyy-MM-dd HH:mm" 에 도달하면 중지

    def validate(self) -> None:
        errors = []
        try:
            datetime.strptime(self.date, "%Y%m%d")
        except ValueError:
            errors.append(f"날짜 형식 오류: {self.date!r} (yyyyMMdd)")
        for name in ("time_from", "time_to"):
            v = getattr(self, name)
            if len(v) != 6 or not v.isdigit():
                errors.append(f"{name} 형식 오류: {v!r} (hhmmss)")
        if self.time_from > self.time_to:
            errors.append("time_from 이 time_to 보다 늦습니다")
        if self.seat not in SEAT_OPTIONS:
            errors.append(f"seat 는 {SEAT_OPTIONS} 중 하나")
        if self.train_type not in TRAIN_TYPES:
            errors.append(f"train_type 은 {TRAIN_TYPES} 중 하나")
        if not 1 <= self.passengers.total() <= 9:
            errors.append("승객 수는 1~9명")
        if self.interval < MIN_INTERVAL:
            errors.append(f"interval 은 {MIN_INTERVAL}초 이상이어야 합니다")
        if self.stop_at:
            try:
                datetime.strptime(self.stop_at, "%Y-%m-%d %H:%M")
            except ValueError:
                errors.append(f"stop_at 형식 오류: {self.stop_at!r} (yyyy-MM-dd HH:mm)")
        if errors:
            raise ValueError("\n".join(errors))

    @classmethod
    def from_dict(cls, d: dict) -> "Job":
        d = dict(d)
        d["passengers"] = Passengers(**d.get("passengers", {}))
        d["train_nos"] = [str(n) for n in d.get("train_nos", [])]
        job = cls(**d)
        job.validate()
        return job

    @classmethod
    def load(cls, path: str) -> "Job":
        with open(path, encoding="utf-8") as f:
            return cls.from_dict(json.load(f))

    def to_dict(self) -> dict:
        return asdict(self)
