"""어셈블리: 메이트(구속)와 간섭 검사.

메이트는 '움직이는 부품'을 강체 변환해서 '기준 부품'에 맞춘다. 변환은 TopLoc_Location(Moved)으로만 적용하므로
면·모서리 번호가 바뀌지 않아, 메이트가 참조하는 면을 계속 찾을 수 있다.

종류(솔리드웍스 표준 메이트):
- coincident 일치: 평면-평면 마주 보게 맞붙임 (aligned=True면 같은 방향)
- distance  거리: 평면-평면 평행 + 간격
- concentric 동심: 원통-원통(또는 원 모서리) 축 일치
- parallel  평행: 평면-평면 방향만 맞춤
- perpendicular 수직: 평면-평면 직각
"""
from __future__ import annotations

import math

from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cylinder, GeomAbs_Plane
from OCP.TopLoc import TopLoc_Location
from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec

from . import geometry as g

MATE_NAMES = {"coincident": "일치", "distance": "거리", "concentric": "동심", "parallel": "평행", "perpendicular": "수직"}


def _plane(shape, kind, index):
    if kind != "face":
        raise g.GeometryError("평면을 고르세요")
    f = g.sub_shape(shape, "face", index)
    if BRepAdaptor_Surface(f).GetType() != GeomAbs_Plane:
        raise g.GeometryError("평면을 고르세요")
    c = g.describe(shape, "face", index)["center"]
    return gp_Pnt(*c), gp_Vec(g.face_normal(f))


def _axis(shape, kind, index):
    s = g.sub_shape(shape, kind, index)
    if kind == "face":
        srf = BRepAdaptor_Surface(s)
        if srf.GetType() == GeomAbs_Cylinder:
            ax = srf.Cylinder().Axis()
            return ax.Location(), gp_Vec(ax.Direction())
    if kind == "edge":
        c = BRepAdaptor_Curve(s)
        if c.GetType() == GeomAbs_Circle:
            ax = c.Circle().Axis()
            return ax.Location(), gp_Vec(ax.Direction())
    raise g.GeometryError("원통면이나 원형 모서리를 고르세요")


def _rotation(a: gp_Vec, b: gp_Vec, about: gp_Pnt) -> gp_Trsf:
    """방향 a를 b로 돌리는 회전(about 점 기준)."""
    a, b = a.Normalized(), b.Normalized()
    t = gp_Trsf()
    dot = max(-1.0, min(1.0, a.Dot(b)))
    if dot > 1 - 1e-12:
        return t
    axis = a.Crossed(b)
    if axis.Magnitude() < 1e-9:  # 정반대: a에 수직인 아무 축
        axis = a.Crossed(gp_Vec(1, 0, 0))
        if axis.Magnitude() < 1e-6:
            axis = a.Crossed(gp_Vec(0, 1, 0))
    t.SetRotation(gp_Ax1(about, gp_Dir(axis)), math.acos(dot))
    return t


def _move(shape, t: gp_Trsf):
    return shape.Moved(TopLoc_Location(t))


def solve_one(mate: dict, ref_shape, mov_shape):
    """메이트 하나를 만족하도록 mov_shape를 옮긴 새 형상과 잔차(mm)를 돌려준다."""
    k = mate["type"]
    ra, ma = mate["ref"], mate["mov"]
    if k in ("coincident", "distance", "parallel", "perpendicular"):
        rp, rn = _plane(ref_shape, ra["kind"], ra["index"])
        mp, mn = _plane(mov_shape, ma["kind"], ma["index"])
        if k == "perpendicular":
            # mn을 rn에 수직이 되도록 최소 회전
            proj = mn.Subtracted(rn.Multiplied(mn.Dot(rn)))
            if proj.Magnitude() < 1e-9:
                proj = rn.Crossed(gp_Vec(1, 0, 0)) if abs(rn.X()) < 0.9 else rn.Crossed(gp_Vec(0, 1, 0))
            target = proj
        else:
            aligned = bool(mate.get("aligned"))
            if k == "parallel":
                aligned = mn.Dot(rn) >= 0
            target = rn if aligned else rn.Reversed()
        rot = _rotation(mn, target, mp)
        shape = _move(mov_shape, rot)
        if k in ("parallel", "perpendicular"):
            mp2, mn2 = _plane(shape, ma["kind"], ma["index"])
            return shape, mn2.Normalized().Crossed(target.Normalized()).Magnitude()
        mp2, _ = _plane(shape, ma["kind"], ma["index"])
        offset = float(mate.get("offset", 0)) if k == "distance" else 0.0
        n = rn.Normalized()
        cur = gp_Vec(rp, mp2).Dot(n)
        tr = gp_Trsf()
        tr.SetTranslation(n.Multiplied(offset - cur))
        shape = _move(shape, tr)
        mp3, _ = _plane(shape, ma["kind"], ma["index"])
        return shape, abs(gp_Vec(rp, mp3).Dot(n) - offset)
    if k == "concentric":
        rp, rd = _axis(ref_shape, ra["kind"], ra["index"])
        mp, md = _axis(mov_shape, ma["kind"], ma["index"])
        target = rd if (mate.get("aligned") or md.Dot(rd) >= 0) else rd.Reversed()
        shape = _move(mov_shape, _rotation(md, target, mp))
        mp2, _ = _axis(shape, ma["kind"], ma["index"])
        v = gp_Vec(rp, mp2)
        n = rd.Normalized()
        perp = v.Subtracted(n.Multiplied(v.Dot(n)))
        tr = gp_Trsf()
        tr.SetTranslation(perp.Reversed())
        shape = _move(shape, tr)
        mp3, _ = _axis(shape, ma["kind"], ma["index"])
        v = gp_Vec(rp, mp3)
        return shape, v.Subtracted(n.Multiplied(v.Dot(n))).Magnitude()
    raise g.GeometryError(f"모르는 메이트: {k}")


def solve(mates: list[dict], shapes: dict, fixed: set, passes: int = 40, tol: float = 1e-7):
    """모든 메이트를 반복 적용(가우스-자이델 방식). shapes: body id → 형상, 제자리 갱신.

    반환: 메이트 id → 잔차(0이면 만족). 잔차가 남으면 메이트끼리 충돌(과구속)한다는 뜻이다.
    """
    residual = {}
    for _ in range(passes):
        for m in mates:
            ref, mov = m["ref"]["body"], m["mov"]["body"]
            if ref in fixed and mov in fixed:
                continue
            mm = {**m, "ref": m["mov"], "mov": m["ref"]} if mov in fixed else m
            try:
                new, _ = solve_one(mm, shapes[mm["ref"]["body"]], shapes[mm["mov"]["body"]])
                shapes[mm["mov"]["body"]] = new
            except g.GeometryError:
                pass
        residual = {m["id"]: _current_residual(m, shapes) for m in mates}
        if not residual or max(residual.values()) < tol:
            break
    return residual


def _current_residual(m, shapes):
    try:
        ref, mov = shapes[m["ref"]["body"]], shapes[m["mov"]["body"]]
        k = m["type"]
        if k == "concentric":
            rp, rd = _axis(ref, m["ref"]["kind"], m["ref"]["index"])
            mp, md = _axis(mov, m["mov"]["kind"], m["mov"]["index"])
            n = rd.Normalized()
            v = gp_Vec(rp, mp)
            return v.Subtracted(n.Multiplied(v.Dot(n))).Magnitude() + md.Normalized().Crossed(n).Magnitude()
        rp, rn = _plane(ref, m["ref"]["kind"], m["ref"]["index"])
        mp, mn = _plane(mov, m["mov"]["kind"], m["mov"]["index"])
        rn, mn = rn.Normalized(), mn.Normalized()
        if k == "perpendicular":
            return abs(rn.Dot(mn))
        if k == "parallel":
            return rn.Crossed(mn).Magnitude()
        want = rn if m.get("aligned") else rn.Reversed()
        ang = mn.Subtracted(want).Magnitude()
        off = float(m.get("offset", 0)) if k == "distance" else 0.0
        return ang + abs(gp_Vec(rp, mp).Dot(rn) - off)
    except g.GeometryError:
        return float("inf")


def interference(bodies: list[tuple[int, str, object]]):
    """[(id, name, shape)] → 겹치는 쌍 목록과 겹친 부피."""
    out = []
    boxes = [(i, n, s, g.bbox(s)) for i, n, s in bodies]
    for a in range(len(boxes)):
        for b in range(a + 1, len(boxes)):
            ia, na, sa, (la, ha) = boxes[a]
            ib, nb, sb, (lb, hb) = boxes[b]
            if any(ha[k] < lb[k] or hb[k] < la[k] for k in range(3)):
                continue
            op = BRepAlgoAPI_Common(sa, sb)
            op.Build()
            if not op.IsDone():
                continue
            vol = g.mass_properties(op.Shape())["volume"]
            if vol > 1e-6:
                out.append({"a": ia, "b": ib, "a_name": na, "b_name": nb, "volume": vol,
                            "mesh": g.tessellate(op.Shape(), 0.6)})
    return out
