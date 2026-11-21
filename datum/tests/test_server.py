import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from fastapi.testclient import TestClient  # noqa: E402

import server  # noqa: E402


@pytest.fixture()
def client():
    c = TestClient(server.app)
    c.post("/api/sample")
    return c


def _face(c, body, pred):
    n = len(c.get(f"/api/mesh/{body}").json()["faces"])
    for i in range(n):
        d = c.post("/api/measure", json={"picks": [{"body": body, "kind": "face", "index": i}]}).json()["single"]
        if pred(d):
            return i
    raise AssertionError("face not found")


def test_drag_respects_concentric_mate(client):
    c = client
    base, pin = [b["id"] for b in c.get("/api/state").json()["bodies"]]
    hole = _face(c, base, lambda d: d["type"] == "원통면" and abs(d["diameter"] - 10) < 1e-6)
    side = _face(c, pin, lambda d: d["type"] == "원통면" and abs(d["diameter"] - 9.8) < 1e-6)
    r = c.post("/api/op", json={"op": "mate", "kind": "concentric", "params": {"ref": {"body": base, "kind": "face", "index": hole}, "mov": {"body": pin, "kind": "face", "index": side}}}).json()
    assert r["mates"][0]["ok"]
    # 옆으로 끌면(축에 수직) 다시 축에 붙어 거의 안 움직이고, 축 방향(Z)으로 끌면 그대로 움직인다
    side_move = c.post("/api/drag/preview", json={"body": pin, "matrix": [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]}).json()["moves"]
    assert abs(side_move.get(str(pin), [0] * 12)[3]) < 1e-6
    up = c.post("/api/drag/preview", json={"body": pin, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 15]}).json()["moves"][str(pin)]
    assert up[11] == pytest.approx(15)
    c.post("/api/drag/commit", json={"body": pin, "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 15]})
    m = c.get(f"/api/mass/{pin}").json()
    assert m["center"][0] == pytest.approx(40, abs=1e-6) and m["center"][1] == pytest.approx(25, abs=1e-6)


def test_sketch_and_section_endpoints(client):
    c = client
    base = c.get("/api/state").json()["bodies"][0]["id"]
    top = _face(c, base, lambda d: d["type"] == "평면" and d["normal"] == [0, 0, 1] and abs(d["center"][2] - 12) < 1e-6)
    pl = c.post("/api/sketch/plane", json={"body": base, "face": top}).json()
    assert pl["reference"]["polys"]
    v0 = c.get(f"/api/mass/{base}").json()["volume"]
    r = c.post("/api/op", json={"op": "sketch_extrude", "body": base, "params": {"plane": pl, "entities": [{"t": "rect", "x": 2, "y": 2, "w": 6, "h": 4}], "depth": 3, "mode": "boss"}})
    assert r.status_code == 200
    assert c.get(f"/api/mass/{base}").json()["volume"] == pytest.approx(v0 + 72, rel=1e-6)
    sec = c.post("/api/drawing/section", json={"parent": "top", "orient": "h", "pos": 25, "label": "A"}).json()
    assert sec["name"] == "단면 A-A" and sec["hatch"] and sec["bbox"][3] > sec["bbox"][1]
