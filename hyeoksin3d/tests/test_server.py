"""서버 엔드포인트 함수를 HTTP 없이 직접 호출해서 검사한다(추가 테스트 패키지 불필요)."""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import server  # noqa: E402
from core import geometry as g  # noqa: E402


@pytest.fixture()
def st():
    server.drag_state.clear()
    return server.open_sample()


def _face(body, pred):
    shape = server.doc.body(body).shape
    for i in range(g.sub_map(shape, "face").Extent()):
        if pred(g.describe(shape, "face", i)):
            return i
    raise AssertionError("face not found")


def _drag(body, m):
    return server.DragReq(body=body, matrix=m)


def test_drag_respects_concentric_mate(st):
    base, pin = [b["id"] for b in st["bodies"]]
    hole = _face(base, lambda d: d["type"] == "원통면" and abs(d["diameter"] - 10) < 1e-6)
    side = _face(pin, lambda d: d["type"] == "원통면" and abs(d["diameter"] - 9.8) < 1e-6)
    r = server.operation(server.Op(op="mate", kind="concentric", params={
        "ref": {"body": base, "kind": "face", "index": hole}, "mov": {"body": pin, "kind": "face", "index": side}}))
    assert r["mates"][0]["ok"]
    # 옆으로 끌면(축에 수직) 다시 축에 붙어 거의 안 움직이고, 축 방향(Z)으로 끌면 그대로 움직인다
    side_move = server.drag_preview(_drag(pin, [1, 0, 0, 20, 0, 1, 0, 0, 0, 0, 1, 0]))["moves"]
    assert abs(side_move.get(pin, [0] * 12)[3]) < 1e-6
    up = server.drag_preview(_drag(pin, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 15]))["moves"][pin]
    assert up[11] == pytest.approx(15)
    server.drag_commit(_drag(pin, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 15]))
    m = server.mass(pin)
    assert m["center"][0] == pytest.approx(40, abs=1e-6) and m["center"][1] == pytest.approx(25, abs=1e-6)
    with pytest.raises(g.GeometryError):  # 고정 부품은 끌 수 없다
        server.drag_preview(_drag(base, [1, 0, 0, 5, 0, 1, 0, 0, 0, 0, 1, 0]))


def test_sketch_and_section_endpoints(st):
    base = st["bodies"][0]["id"]
    top = _face(base, lambda d: d["type"] == "평면" and d["normal"] == [0, 0, 1] and abs(d["center"][2] - 12) < 1e-6)
    pl = server.sketch_plane(server.SketchPlaneReq(body=base, face=top))
    assert pl["reference"]["polys"]
    v0 = server.mass(base)["volume"]
    server.operation(server.Op(op="sketch_extrude", body=base, params={
        "plane": pl, "entities": [{"t": "rect", "x": 2, "y": 2, "w": 6, "h": 4}], "depth": 3, "mode": "boss"}))
    assert server.mass(base)["volume"] == pytest.approx(v0 + 72, rel=1e-6)
    sec = server.drawing_section(server.SectionReq(parent="top", orient="h", pos=25, label="A"))
    assert sec["name"] == "단면 A-A" and sec["hatch"] and sec["bbox"][3] > sec["bbox"][1]
