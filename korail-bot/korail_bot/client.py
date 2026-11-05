"""korail2 라이브러리를 감싸는 어댑터.

코레일이 앱 API를 바꾸면 이 파일만 고치면 되도록 나머지 코드는
`search()` / `reserve()` / `login()` 세 메서드에만 의존한다.
"""
from __future__ import annotations

from datetime import datetime, timedelta

from .config import Job


class SoldOut(Exception):
    """시도한 사이에 좌석이 팔림 — 계속 감시."""


class NeedLogin(Exception):
    """세션 만료 — 재로그인 후 재시도."""


class FatalError(Exception):
    """계속해도 의미 없는 오류 (로그인 실패, 중복 예약 등)."""


class KorailClient:
    def __init__(self, korail_id: str, korail_pw: str):
        try:
            import korail2  # noqa: F401
        except ImportError as e:  # pragma: no cover
            raise SystemExit("korail2 가 필요합니다: pip install -r requirements.txt") from e
        self._k = korail2
        self._id, self._pw = korail_id, korail_pw
        self._api = None

    # ---- 인증 -------------------------------------------------------
    def login(self) -> str:
        k = self._k
        try:
            self._api = k.Korail(self._id, self._pw, auto_login=False)
            ok = self._api.login()
        except k.KorailError as e:
            raise FatalError(f"로그인 실패: {e}") from e
        if not ok:
            raise FatalError("로그인 실패: 아이디/비밀번호를 확인하세요")
        return getattr(self._api, "name", None) or self._id

    # ---- 조회 -------------------------------------------------------
    def _passengers(self, job: Job):
        k, p = self._k, job.passengers
        out = []
        if p.adult:
            out.append(k.AdultPassenger(p.adult))
        if p.child:
            out.append(k.ChildPassenger(p.child))
        if p.senior:
            out.append(k.SeniorPassenger(p.senior))
        if p.toddler:
            out.append(k.ToddlerPassenger(p.toddler))
        return out

    def _train_type(self, job: Job):
        t = self._k.TrainType
        return {
            "ALL": t.ALL, "KTX": t.KTX, "ITX": t.ITX_CHEONGCHUN,
            "SAEMAEUL": t.SAEMAEUL, "MUGUNGHWA": t.MUGUNGHWA,
        }[job.train_type]

    def search(self, job: Job) -> list:
        """time_from ~ time_to 사이 열차를 매진 포함해 모두 가져온다."""
        k = self._k
        trains, seen = [], set()
        cursor = job.time_from
        for _ in range(10):  # 한 번 조회에 약 10편 — 하루치도 10회면 충분
            try:
                batch = self._api.search_train(
                    job.dep, job.arr, job.date, cursor,
                    train_type=self._train_type(job),
                    passengers=self._passengers(job),
                    include_no_seats=True,
                    include_waiting_list=True,
                )
            except k.NoResultsError:
                break
            except k.NeedToLoginError as e:
                raise NeedLogin() from e
            except k.KorailError as e:
                if "로그인" in str(e):
                    raise NeedLogin() from e
                raise
            new = [t for t in batch if (t.train_no, t.dep_time) not in seen]
            if not new:
                break
            for t in new:
                seen.add((t.train_no, t.dep_time))
            trains.extend(new)
            last = new[-1].dep_time
            if last >= job.time_to:
                break
            nxt = datetime.strptime(last, "%H%M%S") + timedelta(minutes=1)
            if nxt.day != 1:  # 자정 넘김
                break
            cursor = nxt.strftime("%H%M%S")
        return trains

    # ---- 예약 -------------------------------------------------------
    def reserve(self, train, job: Job, waiting: bool):
        k = self._k
        try:
            return self._api.reserve(
                train,
                passengers=self._passengers(job),
                option=getattr(k.ReserveOption, job.seat),
                try_waiting=waiting,
            )
        except k.SoldOutError as e:
            raise SoldOut() from e
        except k.NeedToLoginError as e:
            raise NeedLogin() from e
        except k.KorailError as e:
            msg = str(e)
            if "매진" in msg or "잔여석" in msg:
                raise SoldOut() from e
            if "로그인" in msg:
                raise NeedLogin() from e
            # 중복 예약, 1인 예약 한도 초과 등은 반복해도 실패
            raise FatalError(f"예약 실패: {msg}") from e
