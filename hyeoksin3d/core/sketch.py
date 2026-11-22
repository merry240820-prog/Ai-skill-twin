"""스케치 → 돌출/컷 (솔리드웍스 '스케치 + 돌출 보스/베이스 · 돌출 컷'에 해당).

스케치 평면: 선택한 평면(또는 XY·XZ·YZ 기준면). 평면 좌표계는
  원점 = 세계 원점을 평면에 투영한 점, X = 세계 X축(평면에 투영, 안 되면 Y축), Y = N × X.
엔티티(평면 좌표 mm):
  {"t":"line","p":[x1,y1,x2,y2]}  {"t":"arc","c":[x,y],"r":r,"a0":도,"a1":도}(반시계)
  {"t":"rect","x":x,"y":y,"w":w,"h":h}  {"t":"circle","c":[x,y],"r":r}
선과 호는 끝점이 이어지면 닫힌 윤곽으로 묶는다. 다른 윤곽 안에 들어간 윤곽은 구멍이 된다(짝수/홀수 규칙).
"""
from __future__ import annotations

import math

from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakeWire
from OCP.BRepClass import BRepClass_FaceClassifier
from OCP.BRepPrimAPI import BRepPrimAPI_MakePrism
from OCP.GC import GC_MakeArcOfCircle, GC_MakeSegment
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Plane
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
from OCP.TopAbs import TopAbs_IN, TopAbs_ON
from OCP.gp import gp_Ax2, gp_Circ, gp_Dir, gp_Pnt, gp_Vec

from . import geometry as g

TOL = 1e-6
BASE = {"xy": ((0, 0, 1), (1, 0, 0)), "xz": ((0, -1, 0), (1, 0, 0)), "yz": ((1, 0, 0), (0, 1, 0))}


# ------------------------------------------------------------------ 평면
def _plane(origin, n, x):
    n = gp_Dir(*n)
    xv = gp_Vec(*x)
    xv = xv.Subtracted(gp_Vec(n).Multiplied(xv.Dot(gp_Vec(n))))
    if xv.Magnitude() < 1e-9:
        xv = gp_Vec(0, 1, 0).Subtracted(gp_Vec(n).Multiplied(gp_Vec(0, 1, 0).Dot(gp_Vec(n))))
    xd = gp_Dir(xv)
    yd = n.Crossed(xd)
    # 원점: 세계 원점을 평면에 투영한 점 = n·(c·n)
    d = sum(origin[i] * (n.X(), n.Y(), n.Z())[i] for i in range(3))
    o = gp_Pnt(n.X() * d, n.Y() * d, n.Z() * d)
    return {"origin": [o.X(), o.Y(), o.Z()], "n": [n.X(), n.Y(), n.Z()], "x": [xd.X(), xd.Y(), xd.Z()], "y": [yd.X(), yd.Y(), yd.Z()]}


def _to2d(pl, p):
    o = pl["origin"]
    v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
    return [round(sum(v[i] * pl["x"][i] for i in range(3)), 6), round(sum(v[i] * pl["y"][i] for i in range(3)), 6)]


def _to3d(pl, q):
    o, x, y = pl["origin"], pl["x"], pl["y"]
    return gp_Pnt(*(o[i] + q[0] * x[i] + q[1] * y[i] for i in range(3)))


def plane_from_face(shape, face_id):
    face = g.sub_shape(shape, "face", face_id)
    if BRepAdaptor_Surface(face).GetType() != GeomAbs_Plane:
        raise g.GeometryError("스케치는 평면 위에만 그릴 수 있습니다")
    n = g.face_normal(face)
    c = g.describe(shape, "face", face_id)["center"]
    x = (1, 0, 0) if abs(n.X()) < 0.9 else (0, 1, 0)
    pl = _plane(c, (n.X(), n.Y(), n.Z()), x)
    pl["reference"] = _outline(pl, face)
    return pl


def base_plane(name):
    n, x = BASE[name]
    pl = _plane((0, 0, 0), n, x)
    pl["reference"] = {"polys": [], "circles": [], "points": [[0, 0]]}
    return pl


def _outline(pl, face):
    """면의 모서리를 스케치 평면 2D로(참조선·스냅점)."""
    from OCP.TopAbs import TopAbs_EDGE
    from OCP.TopExp import TopExp_Explorer
    polys, circles, points = [], [], [[0, 0]]
    exp = TopExp_Explorer(face, TopAbs_EDGE)
    while exp.More():
        e = g._cast["Edge"](exp.Current())
        c = BRepAdaptor_Curve(e)
        a, b = c.FirstParameter(), c.LastParameter()
        if c.GetType() == GeomAbs_Circle:
            circ = c.Circle()
            circles.append({"c": _to2d(pl, [circ.Location().X(), circ.Location().Y(), circ.Location().Z()]), "r": round(circ.Radius(), 6)})
        try:
            disc = GCPnts_TangentialDeflection(c, 0.2, 0.05)
            pts = []
            for k in range(1, disc.NbPoints() + 1):
                p = disc.Value(k)
                pts += _to2d(pl, [p.X(), p.Y(), p.Z()])
            polys.append(pts)
            points += [pts[:2], pts[-2:]]
        except Exception:
            pass
        exp.Next()
    for ci in circles:
        points.append(ci["c"])
    return {"polys": polys, "circles": circles, "points": points}


# ------------------------------------------------------------------ 윤곽
def _edge(pl, ent):
    if ent["t"] == "line":
        x1, y1, x2, y2 = ent["p"]
        if math.hypot(x2 - x1, y2 - y1) < TOL:
            return None
        return BRepBuilderAPI_MakeEdge(GC_MakeSegment(_to3d(pl, [x1, y1]), _to3d(pl, [x2, y2])).Value()).Edge()
    if ent["t"] == "arc":
        (cx, cy), r = ent["c"], ent["r"]
        a0, a1 = math.radians(ent["a0"]), math.radians(ent["a1"])
        if a1 <= a0:
            a1 += 2 * math.pi
        am = (a0 + a1) / 2
        p = lambda a: _to3d(pl, [cx + r * math.cos(a), cy + r * math.sin(a)])  # noqa: E731
        return BRepBuilderAPI_MakeEdge(GC_MakeArcOfCircle(p(a0), p(am), p(a1)).Value()).Edge()
    return None


def _ends(ent):
    if ent["t"] == "line":
        return ent["p"][:2], ent["p"][2:]
    (cx, cy), r = ent["c"], ent["r"]
    a0, a1 = math.radians(ent["a0"]), math.radians(ent["a1"])
    return [cx + r * math.cos(a0), cy + r * math.sin(a0)], [cx + r * math.cos(a1), cy + r * math.sin(a1)]


def _loops(entities):
    """선·호를 끝점으로 이어 닫힌 고리 목록으로. 사각형·원은 그대로 고리 하나."""
    loops = []
    for e in entities:
        if e["t"] == "rect":
            x, y, w, h = e["x"], e["y"], e["w"], e["h"]
            if abs(w) < TOL or abs(h) < TOL:
                continue
            pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
            loops.append([{"t": "line", "p": pts[k] + pts[(k + 1) % 4]} for k in range(4)])
        elif e["t"] == "circle" and e["r"] > TOL:
            loops.append([e])
    segs = [e for e in entities if e["t"] in ("line", "arc")]
    used = [False] * len(segs)
    key = lambda p: (round(p[0], 4), round(p[1], 4))  # noqa: E731
    for i, s in enumerate(segs):
        if used[i]:
            continue
        used[i] = True
        chain = [s]
        start, end = (key(p) for p in _ends(s))
        progress = True
        while start != end and progress:
            progress = False
            for j, t in enumerate(segs):
                if used[j]:
                    continue
                a, b = (key(p) for p in _ends(t))
                if a == end or b == end:
                    used[j] = True
                    chain.append(t)
                    end = b if a == end else a
                    progress = True
                    break
        if start == end:
            loops.append(chain)
    return loops


def _face(pl, loop):
    if len(loop) == 1 and loop[0]["t"] == "circle":
        (cx, cy), r = loop[0]["c"], loop[0]["r"]
        circ = gp_Circ(gp_Ax2(_to3d(pl, [cx, cy]), gp_Dir(*pl["n"]), gp_Dir(*pl["x"])), r)
        wire = BRepBuilderAPI_MakeWire(BRepBuilderAPI_MakeEdge(circ).Edge()).Wire()
        return BRepBuilderAPI_MakeFace(wire, True).Face(), [cx + r, cy]
    mk = BRepBuilderAPI_MakeWire()
    for e in loop:
        ed = _edge(pl, e)
        if ed is not None:
            mk.Add(ed)
    if not mk.IsDone():
        raise g.GeometryError("스케치 윤곽이 끊어져 있습니다 — 선 끝점이 정확히 이어지게 그리세요")
    f = BRepBuilderAPI_MakeFace(mk.Wire(), True)
    if not f.IsDone():
        raise g.GeometryError("스케치 윤곽으로 면을 만들 수 없습니다(꼬인 윤곽?)")
    return f.Face(), _ends(loop[0])[0]


def _area(face):
    p = GProp_GProps()
    BRepGProp.SurfaceProperties_s(face, p)
    return p.Mass()


def regions(pl, entities):
    """닫힌 윤곽들 → (더할 면들, 뺄 면들). 바깥 윤곽 안에 들어간 윤곽은 구멍."""
    loops = _loops(entities)
    if not loops:
        raise g.GeometryError("닫힌 윤곽이 없습니다 — 사각형·원을 그리거나 선을 끝까지 이어 닫으세요")
    faces = [_face(pl, lp) for lp in loops]
    faces.sort(key=lambda fp: -_area(fp[0]))
    add, sub = [], []
    for i, (f, pt) in enumerate(faces):
        depth = 0
        for j in range(i):
            cls = BRepClass_FaceClassifier(faces[j][0], _to3d(pl, pt), 1e-6)
            if cls.State() in (TopAbs_IN, TopAbs_ON) and _area(faces[j][0]) > _area(f) + 1e-9:
                depth += 1
        (sub if depth % 2 else add).append(f)
    return add, sub


def extrude(target, pl, entities, depth: float, mode: str = "boss", reverse: bool = False,
            through: bool = False, both: bool = False):
    """mode: boss(덧붙임) · cut(잘라냄) · new(새 바디). 반환: 새 형상."""
    if depth <= 0 and not through:
        raise g.GeometryError("깊이를 입력하세요")
    add, sub = regions(pl, entities)
    n = gp_Vec(*pl["n"])
    if mode == "cut":
        n = n.Reversed()  # 컷은 기본으로 면 안쪽으로
    if reverse:
        n = n.Reversed()
    if through:
        if target is None:
            raise g.GeometryError("관통은 기존 바디가 있어야 합니다")
        lo, hi = g.bbox(target)
        depth = math.dist(lo, hi) * 2 + 10
        both = True if mode == "cut" and not reverse else both

    def prism(face):
        if both:
            from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
            from OCP.gp import gp_Trsf
            t = gp_Trsf()
            t.SetTranslation(n.Multiplied(-depth / 2 if not through else -depth))
            moved = BRepBuilderAPI_Transform(face, t, True).Shape()
            return BRepPrimAPI_MakePrism(moved, n.Multiplied(depth if not through else depth * 2)).Shape()
        return BRepPrimAPI_MakePrism(face, n.Multiplied(depth)).Shape()

    tool = None
    for f in add:
        p = prism(f)
        tool = p if tool is None else g.boolean("union", tool, p)
    for f in sub:
        tool = g.boolean("cut", tool, prism(f))
    if mode == "new" or target is None:
        return tool
    return g.boolean("union" if mode == "boss" else "cut", target, tool)


__all__ = ["plane_from_face", "base_plane", "regions", "extrude"]
