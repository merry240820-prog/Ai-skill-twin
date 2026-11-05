import unittest
from dataclasses import dataclass
from datetime import datetime

from korail_bot.client import FatalError, NeedLogin, SoldOut
from korail_bot.config import Job, Passengers
from korail_bot.matcher import candidates
from korail_bot.runner import run


@dataclass
class T:
    train_no: str
    dep_time: str
    general: bool = False
    special: bool = False
    wait: bool = False
    arr_time: str = "120000"
    dep_name: str = "서울"
    arr_name: str = "부산"
    train_type_name: str = "KTX"

    def has_general_seat(self): return self.general
    def has_special_seat(self): return self.special
    def has_general_waiting_list(self): return self.wait


def job(**kw):
    base = dict(dep="서울", arr="부산", date="20261120",
                time_from="070000", time_to="100000", interval=5)
    base.update(kw)
    return Job(**base)


class FakeClient:
    def __init__(self, rounds, reserve_effects=()):
        self.rounds = list(rounds)          # 조회마다 반환할 결과(또는 예외)
        self.reserve_effects = list(reserve_effects)
        self.reserved, self.logins = [], 0

    def login(self):
        self.logins += 1

    def search(self, job):
        r = self.rounds.pop(0) if len(self.rounds) > 1 else self.rounds[0]
        if isinstance(r, Exception):
            raise r
        return r

    def reserve(self, train, job, waiting):
        eff = self.reserve_effects.pop(0) if self.reserve_effects else "RSV"
        if isinstance(eff, Exception):
            raise eff
        self.reserved.append((train.train_no, waiting))
        return eff


def quiet_run(j, c, **kw):
    sleeps = []
    res = run(j, c, log=lambda *_: None, sleep=sleeps.append, rand=lambda: 0.5, **kw)
    return res, sleeps


class MatcherTest(unittest.TestCase):
    def test_window_and_order(self):
        ts = [T("9", "090000", general=True), T("1", "060000", general=True),
              T("5", "080000", general=True), T("7", "110000", general=True)]
        self.assertEqual([t.train_no for t, _ in candidates(ts, job())], ["5", "9"])

    def test_seat_options(self):
        ts = [T("1", "080000", special=True), T("2", "090000", general=True)]
        self.assertEqual([t.train_no for t, _ in candidates(ts, job(seat="GENERAL_ONLY"))], ["2"])
        self.assertEqual([t.train_no for t, _ in candidates(ts, job(seat="SPECIAL_ONLY"))], ["1"])
        self.assertEqual(len(candidates(ts, job())), 2)

    def test_train_no_filter_ignores_leading_zeros(self):
        ts = [T("00101", "080000", general=True), T("00103", "090000", general=True)]
        self.assertEqual([t.train_no for t, _ in candidates(ts, job(train_nos=["103"]))], ["00103"])

    def test_waiting_comes_after_seats(self):
        ts = [T("1", "080000", wait=True), T("2", "090000", general=True)]
        self.assertEqual(candidates(ts, job()), [(ts[1], False)])
        self.assertEqual(candidates(ts, job(try_waiting=True)), [(ts[1], False), (ts[0], True)])


class RunnerTest(unittest.TestCase):
    def test_polls_until_seat_appears(self):
        c = FakeClient([[T("1", "080000")], [T("1", "080000")], [T("1", "080000", general=True)]])
        res, sleeps = quiet_run(job(), c)
        self.assertTrue(res.ok)
        self.assertEqual(res.attempts, 3)
        self.assertEqual(c.reserved, [("1", False)])
        self.assertEqual(sleeps, [5.0, 5.0])

    def test_sold_out_moves_to_next_candidate(self):
        c = FakeClient([[T("1", "080000", general=True), T("2", "090000", general=True)]],
                       reserve_effects=[SoldOut(), "RSV2"])
        res, _ = quiet_run(job(), c)
        self.assertEqual(res.reservation, "RSV2")
        self.assertEqual(c.reserved, [("2", False)])

    def test_relogin_on_session_expiry(self):
        c = FakeClient([NeedLogin(), [T("1", "080000", general=True)]])
        res, _ = quiet_run(job(), c)
        self.assertTrue(res.ok)
        self.assertEqual(c.logins, 1)

    def test_fatal_error_stops(self):
        c = FakeClient([[T("1", "080000", general=True)]], reserve_effects=[FatalError("중복 예약")])
        res, _ = quiet_run(job(), c)
        self.assertFalse(res.ok)
        self.assertIn("중복", res.reason)

    def test_network_error_backs_off(self):
        c = FakeClient([ConnectionError(), ConnectionError(), [T("1", "080000", general=True)]])
        res, sleeps = quiet_run(job(), c)
        self.assertTrue(res.ok)
        self.assertEqual(sleeps, [10, 20])

    def test_max_attempts(self):
        res, _ = quiet_run(job(max_attempts=3), FakeClient([[]]))
        self.assertFalse(res.ok)
        self.assertEqual(res.attempts, 3)

    def test_stop_at(self):
        res, _ = quiet_run(job(stop_at="2026-11-20 06:30"), FakeClient([[]]),
                           now=lambda: datetime(2026, 11, 20, 6, 30))
        self.assertFalse(res.ok)
        self.assertEqual(res.attempts, 0)

    def test_dry_run_does_not_reserve(self):
        c = FakeClient([[T("1", "080000", general=True)]])
        res, _ = quiet_run(job(), c, dry_run=True)
        self.assertTrue(res.ok)
        self.assertEqual(c.reserved, [])


class ConfigTest(unittest.TestCase):
    def test_example_config_loads(self):
        import os
        path = os.path.join(os.path.dirname(__file__), "..", "config.example.json")
        self.assertEqual(Job.load(path).passengers.adult, 1)

    def test_rejects_too_fast_interval(self):
        with self.assertRaises(ValueError):
            job(interval=1).validate()

    def test_rejects_bad_passengers(self):
        with self.assertRaises(ValueError):
            job(passengers=Passengers(adult=0)).validate()


if __name__ == "__main__":
    unittest.main()
