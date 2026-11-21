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
    d.replace_shape(bid, g.scale(d.bodies[0].shape, 2), "scale", "scale")
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(8000)
    d.undo()
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(1000)
    d.redo()
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(8000)
    d.undo(); d.undo()
    assert d.bodies == []
    with pytest.raises(g.GeometryError):
        d.undo()


def test_offset_face_and_set_distance():
    s = box(40, 40, 10)
    top = find_face(s, [0, 0, 1])
    r = g.offset_faces(s, {top: 5})
    assert g.mass_properties(r)["size"][2] == pytest.approx(15)
    bottom = find_face(s, [0, 0, -1])
    r = g.set_face_distance(s, top, bottom, 25)
    assert g.mass_properties(r)["size"][2] == pytest.approx(25)
    r = g.set_face_distance(s, top, bottom, 4)
    assert g.mass_properties(r)["size"][2] == pytest.approx(4)


def test_set_hole_and_boss_diameter():
    s = box(40, 40, 10)
    h = g.hole(s, find_face(s, [0, 0, 1]), [20, 20, 10], 8)
    cyl = [i for i in range(g.sub_map(h, "face").Extent()) if g.describe(h, "face", i)["type"] == "원통면"][0]
    for d in (12, 5):
        r = g.set_diameter(h, cyl, d)
        assert g.mass_properties(r)["volume"] == pytest.approx(16000 - math.pi * (d / 2) ** 2 * 10, rel=1e-4)
    c = g.make_primitive("cylinder", {"r": 10, "h": 20})
    side = [i for i in range(g.sub_map(c, "face").Extent()) if g.describe(c, "face", i)["type"] == "원통면"][0]
    r = g.set_diameter(c, side, 30)
    assert g.mass_properties(r)["volume"] == pytest.approx(math.pi * 225 * 20, rel=1e-4)


def test_patterns():
    b = box(5, 5, 5)
    assert len(g.pattern_linear(b, 4, 10, 0, 0)) == 3
    copies = g.pattern_circular(b, 6, "z", 360, [0, 0, 0])
    assert len(copies) == 5
    assert g.mass_properties(copies[2])["center"][0] == pytest.approx(-2.5, abs=1e-6)


def test_step_names_and_colors_roundtrip(tmp_path):
    from core import stepio
    p = tmp_path / "c.step"
    stepio.write_step([
        {"name": "베이스 플레이트", "shape": box(), "color": "#ff0000"},
        {"name": "Pin", "shape": g.translate(g.make_primitive("cylinder", {"r": 2, "h": 9}), 50, 0, 0), "color": "#0080ff"},
    ], str(p))
    parts = stepio.read_step(str(p))
    assert [x["name"] for x in parts] == ["베이스 플레이트", "Pin"]
    assert [x["color"] for x in parts] == ["#ff0000", "#0080ff"]
    assert g.mass_properties(parts[1]["shape"])["center"][0] == pytest.approx(50)


def test_read_assembly_with_locations(tmp_path):
    from OCP.STEPCAFControl import STEPCAFControl_Writer
    from OCP.STEPControl import STEPControl_AsIs
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TopLoc import TopLoc_Location
    from OCP.XCAFDoc import XCAFDoc_DocumentTool
    from OCP.gp import gp_Trsf, gp_Vec
    from core import stepio

    doc = stepio._doc()
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    part = st.AddShape(box(10, 10, 10), False)
    TDataStd_Name.Set_s(part, TCollection_ExtendedString("Cube", True))
    asm = st.NewShape()
    TDataStd_Name.Set_s(asm, TCollection_ExtendedString("ASM", True))
    for x in (0, 100):
        t = gp_Trsf()
        t.SetTranslation(gp_Vec(x, 0, 0))
        st.AddComponent(asm, part, TopLoc_Location(t))
    st.UpdateAssemblies()
    w = STEPCAFControl_Writer()
    w.Transfer(doc, STEPControl_AsIs)
    p = str(tmp_path / "asm.step")
    w.Write(p)
    parts = stepio.read_step(p)
    assert [x["name"] for x in parts] == ["Cube", "Cube"]
    xs = sorted(g.mass_properties(x["shape"])["center"][0] for x in parts)
    assert xs == [pytest.approx(5), pytest.approx(105)]


def test_document_goto_timeline():
    d = Document()
    d.new()
    d.add_primitive("box", {"dx": 10, "dy": 10, "dz": 10})
    bid = d.bodies[0].id
    rev0 = d.bodies[0].rev
    d.replace_shape(bid, g.scale(d.bodies[0].shape, 2), "크기", "scale")
    d.replace_shape(bid, g.scale(d.bodies[0].shape, 2), "크기", "scale")
    assert d.bodies[0].rev != rev0
    d.goto(1)
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(1000)
    assert d.bodies[0].rev == rev0
    assert len(d.undone) == 2
    d.goto(3)
    assert g.mass_properties(d.bodies[0].shape)["volume"] == pytest.approx(64000)
