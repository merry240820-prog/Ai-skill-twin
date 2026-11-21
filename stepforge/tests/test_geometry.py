import math
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from core import geometry as g  # noqa: E402
from core.document import Document  # noqa: E402


def box(dx=10, dy=20, dz=30):
    return g.make_primitive("box", {"dx": dx, "dy": dy, "dz": dz})


def find_face(shape, normal):
    for i in range(g.sub_map(shape, "face").Extent()):
        d = g.describe(shape, "face", i)
        if d["type"] == "평면" and all(abs(a - b) < 1e-6 for a, b in zip(d["normal"], normal)):
            return i
    raise AssertionError("face not found")


def test_step_roundtrip(tmp_path):
    p = tmp_path / "a.step"
    g.write_step([box(), g.make_primitive("cylinder", {"r": 5, "h": 10, "x": 50})], str(p))
    bodies = g.read_step(str(p))
    assert len(bodies) == 2
    assert g.mass_properties(bodies[0])["volume"] == pytest.approx(6000, rel=1e-6)


def test_tessellate_indices_match():
    s = box()
    m = g.tessellate(s)
    assert len(m["faces"]) == 6 and len(m["edges"]) == 12 and len(m["vertices"]) == 8 * 3
    assert all(len(f["idx"]) >= 6 for f in m["faces"])


def test_measure_parallel_faces_and_edge():
    s = box()
    top, bottom = find_face(s, [0, 0, 1]), find_face(s, [0, 0, -1])
    r = g.measure(s, "face", top, s, "face", bottom)
    assert r["distance"] == pytest.approx(30)
    assert r["parallel_distance"] == pytest.approx(30)
    assert r["angle"] == pytest.approx(180)
    lengths = sorted(g.describe(s, "edge", i)["length"] for i in range(12))
    assert lengths[0] == pytest.approx(10) and lengths[-1] == pytest.approx(30)


def test_hole_through_and_diameter():
    s = box(40, 40, 10)
    top = find_face(s, [0, 0, 1])
    h = g.hole(s, top, [20, 20, 10], 8)
    vol = g.mass_properties(h)["volume"]
    assert vol == pytest.approx(40 * 40 * 10 - math.pi * 16 * 10, rel=1e-4)
    cyl = [g.describe(h, "face", i) for i in range(g.sub_map(h, "face").Extent())]
    assert any(d["type"] == "원통면" and d["diameter"] == pytest.approx(8) for d in cyl)


def test_blind_hole_and_center_distance():
    s = box(40, 40, 10)
    top = find_face(s, [0, 0, 1])
    s = g.hole(s, top, [10, 20, 10], 6, depth=4)
    top = find_face(s, [0, 0, 1])
    s = g.hole(s, top, [30, 20, 10], 6, depth=4)
    assert g.mass_properties(s)["volume"] == pytest.approx(16000 - 2 * math.pi * 9 * 4, rel=1e-4)
    circles = [i for i in range(g.sub_map(s, "edge").Extent())
               if g.describe(s, "edge", i)["type"] == "원/호" and abs(g.describe(s, "edge", i)["center"][2] - 10) < 1e-6]
    r = g.measure(s, "edge", circles[0], s, "edge", circles[1])
    assert r["center_distance"] == pytest.approx(20)


def test_push_pull():
    s = box()
    top = find_face(s, [0, 0, 1])
    assert g.mass_properties(g.push_pull(s, top, 5))["volume"] == pytest.approx(10 * 20 * 35)
    assert g.mass_properties(g.push_pull(s, top, -5))["volume"] == pytest.approx(10 * 20 * 25)


def test_fillet_chamfer_shell():
    s = box()
    assert g.mass_properties(g.fillet(s, [0], 2))["volume"] < 6000
    assert g.mass_properties(g.chamfer(s, [0, 1], 1))["volume"] < 6000
    top = find_face(s, [0, 0, 1])
    sh = g.shell(s, [top], 1)
    assert g.mass_properties(sh)["volume"] == pytest.approx(6000 - 8 * 18 * 29, rel=1e-4)


def test_delete_faces_removes_hole():
    s = box(40, 40, 10)
    h = g.hole(s, find_face(s, [0, 0, 1]), [20, 20, 10], 8)
    cyl = [i for i in range(g.sub_map(h, "face").Extent()) if g.describe(h, "face", i)["type"] == "원통면"]
    healed = g.delete_faces(h, cyl)
    assert g.mass_properties(healed)["volume"] == pytest.approx(16000, rel=1e-5)


def test_booleans_and_transforms():
    a = box(10, 10, 10)
    b = g.translate(box(10, 10, 10), 5, 0, 0)
    assert g.mass_properties(g.boolean("union", a, b))["volume"] == pytest.approx(1500)
    assert g.mass_properties(g.boolean("cut", a, b))["volume"] == pytest.approx(500)
    assert g.mass_properties(g.boolean("intersect", a, b))["volume"] == pytest.approx(500)
    assert g.mass_properties(g.scale(a, 2))["volume"] == pytest.approx(8000)
    assert g.mass_properties(g.scale_xyz(a, 1, 2, 3))["volume"] == pytest.approx(6000, rel=1e-6)
    r = g.mass_properties(g.rotate(box(10, 20, 30), "z", 90))
    assert r["size"][0] == pytest.approx(20) and r["size"][1] == pytest.approx(10)
    m = g.mass_properties(g.mirror(a, "yz"))
    assert m["bbox_max"][0] == pytest.approx(0, abs=1e-6)


def test_document_undo_redo(tmp_path):
    d = Document()
    d.new()
    d.add_primitive("box", {"dx": 10, "dy": 10, "dz": 10})
    bid = d.bodies[0].id
    d.replace(bid, g.scale(d.bodies[0].shape, 2), "scale")
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(8000)
    d.undo()
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(1000)
    d.redo()
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(8000)
    d.undo(); d.undo()
    assert d.bodies == []
    with pytest.raises(g.GeometryError):
        d.undo()
