"""OpenCascade(OCP) 기반 형상 처리 함수 모음.

모든 길이 단위는 mm, 각도는 도(degree)이다.
각 함수는 입력 형상을 바꾸지 않고 새 형상을 돌려준다(불변) — 그래서 실행 취소가 쉽다.
"""
from __future__ import annotations

import math
import os
import tempfile

from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import (
    BRepAlgoAPI_Common,
    BRepAlgoAPI_Cut,
    BRepAlgoAPI_Defeaturing,
    BRepAlgoAPI_Fuse,
)
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import (
    BRepBuilderAPI_GTransform,
    BRepBuilderAPI_MakeVertex,
    BRepBuilderAPI_Transform,
)
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
from OCP.BRepGProp import BRepGProp, BRepGProp_Face
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.BRepOffsetAPI import BRepOffsetAPI_MakeThickSolid
from OCP.BRepPrimAPI import (
    BRepPrimAPI_MakeBox,
    BRepPrimAPI_MakeCone,
    BRepPrimAPI_MakeCylinder,
    BRepPrimAPI_MakePrism,
    BRepPrimAPI_MakeSphere,
)
from OCP.Bnd import Bnd_Box
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane, GeomAbs_Sphere
from OCP.GProp import GProp_GProps
from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
from OCP.StlAPI import StlAPI_Writer
from OCP.ShapeUpgrade import ShapeUpgrade_UnifySameDomain
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SHELL, TopAbs_SOLID, TopAbs_VERTEX
from OCP.TopExp import TopExp, TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.collections import IndexedMap_TopoDS_Shape_TopTools_ShapeMapHasher as TopTools_IndexedMapOfShape
from OCP.collections import List_TopoDS_Shape as TopTools_ListOfShape
from OCP.TopoDS import TopoDS, TopoDS_Compound, TopoDS_Shape
from OCP.BRep import BRep_Builder
from OCP.gp import gp_Ax1, gp_Ax2, gp_Dir, gp_GTrsf, gp_Pnt, gp_Trsf, gp_Vec


# OCP 7.x는 TopoDS.Face_s, 8.x는 TopoDS.Face — 두 버전 모두 지원
_cast = {k: getattr(TopoDS, k, None) or getattr(TopoDS, k + "_s") for k in ("Face", "Edge", "Vertex")}


class GeometryError(Exception):
    """사용자에게 보여줄 수 있는 형상 오류."""


# ---------------------------------------------------------------- 하위 요소 접근

_KIND = {"face": TopAbs_FACE, "edge": TopAbs_EDGE, "vertex": TopAbs_VERTEX}


def sub_map(shape: TopoDS_Shape, kind: str) -> TopTools_IndexedMapOfShape:
    m = TopTools_IndexedMapOfShape()
    TopExp.MapShapes_s(shape, _KIND[kind], m)
    return m


def sub_shape(shape: TopoDS_Shape, kind: str, index: int):
    """index는 0부터. 면/모서리/꼭짓점을 실제 타입으로 돌려준다."""
    m = sub_map(shape, kind)
    if index < 0 or index >= m.Extent():
        raise GeometryError(f"{kind} #{index} 가 없습니다")
    s = m.FindKey(index + 1)
    return {"face": _cast["Face"], "edge": _cast["Edge"], "vertex": _cast["Vertex"]}[kind](s)


def _pt(p: gp_Pnt) -> list[float]:
    return [round(p.X(), 6), round(p.Y(), 6), round(p.Z(), 6)]


def _dir(d) -> list[float]:
    return [round(d.X(), 6), round(d.Y(), 6), round(d.Z(), 6)]


# ---------------------------------------------------------------- STEP 입출력

def read_step(path: str) -> list[TopoDS_Shape]:
    """STEP 파일을 읽어 바디(솔리드) 목록으로 돌려준다."""
    reader = STEPControl_Reader()
    if reader.ReadFile(path) != IFSelect_RetDone:
        raise GeometryError("STEP 파일을 읽을 수 없습니다")
    reader.TransferRoots()
    shape = reader.OneShape()
    if shape.IsNull():
        raise GeometryError("STEP 파일에 형상이 없습니다")
    bodies = _explode(shape, TopAbs_SOLID)
    if not bodies:
        bodies = _explode(shape, TopAbs_SHELL)
    return bodies or [shape]


def _explode(shape, kind) -> list[TopoDS_Shape]:
    out = []
    exp = TopExp_Explorer(shape, kind)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def make_compound(shapes) -> TopoDS_Compound:
    comp = TopoDS_Compound()
    b = BRep_Builder()
    b.MakeCompound(comp)
    for s in shapes:
        b.Add(comp, s)
    return comp


def write_step(shapes, path: str) -> None:
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    writer = STEPControl_Writer()
    writer.Transfer(make_compound(shapes), STEPControl_AsIs)
    if writer.Write(path) != IFSelect_RetDone:
        raise GeometryError("STEP 파일을 저장하지 못했습니다")


def write_stl(shapes, path: str) -> None:
    comp = make_compound(shapes)
    BRepMesh_IncrementalMesh(comp, 0.05, False, 0.3, True)
    w = StlAPI_Writer()
    w.ASCIIMode = False
    if not w.Write(comp, path):
        raise GeometryError("STL 파일을 저장하지 못했습니다")


def step_bytes(shapes) -> bytes:
    fd, path = tempfile.mkstemp(suffix=".step")
    os.close(fd)
    try:
        write_step(shapes, path)
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.remove(path)


# ---------------------------------------------------------------- 화면 표시용 메시

def bbox(shape) -> tuple[list[float], list[float]]:
    box = Bnd_Box()
    BRepBndLib.AddOptimal_s(shape, box, False, False)
    if box.IsVoid():
        return [0, 0, 0], [0, 0, 0]
    a, b = box.CornerMin(), box.CornerMax()
    return [a.X(), a.Y(), a.Z()], [b.X(), b.Y(), b.Z()]


def tessellate(shape, quality: float = 1.0) -> dict:
    """면별 삼각형, 모서리별 선, 꼭짓점 좌표를 만든다. 인덱스는 sub_shape와 같다."""
    lo, hi = bbox(shape)
    diag = math.dist(lo, hi) or 1.0
    lin = max(diag * 0.0015 / quality, 1e-3)
    BRepMesh_IncrementalMesh(shape, lin, False, 0.35 / quality, True)

    faces = []
    fmap = sub_map(shape, "face")
    for i in range(fmap.Extent()):
        face = _cast["Face"](fmap.FindKey(i + 1))
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face, loc)
        if tri is None:
            faces.append({"pos": [], "idx": []})
            continue
        trsf = loc.Transformation()
        pos = []
        for n in range(1, tri.NbNodes() + 1):
            p = tri.Node(n).Transformed(trsf)
            pos += [p.X(), p.Y(), p.Z()]
        rev = face.Orientation() == TopAbs_REVERSED
        idx = []
        for t in range(1, tri.NbTriangles() + 1):
            a, b, c = tri.Triangle(t).Get()
            idx += [a - 1, c - 1, b - 1] if rev else [a - 1, b - 1, c - 1]
        faces.append({"pos": pos, "idx": idx})

    edges = []
    emap = sub_map(shape, "edge")
    for i in range(emap.Extent()):
        edge = _cast["Edge"](emap.FindKey(i + 1))
        if BRep_Tool.Degenerated_s(edge):
            edges.append([])
            continue
        try:
            curve = BRepAdaptor_Curve(edge)
            disc = GCPnts_TangentialDeflection(curve, 0.2, lin)
            pts = []
            for k in range(1, disc.NbPoints() + 1):
                p = disc.Value(k)
                pts += [p.X(), p.Y(), p.Z()]
            edges.append(pts)
        except Exception:  # 비정상 모서리는 그리지 않는다
            edges.append([])

    vmap = sub_map(shape, "vertex")
    verts = []
    for i in range(vmap.Extent()):
        verts += _pt(BRep_Tool.Pnt_s(_cast["Vertex"](vmap.FindKey(i + 1))))

    return {"faces": faces, "edges": edges, "vertices": verts, "bbox": [lo, hi]}


# ---------------------------------------------------------------- 측정

def describe(shape, kind: str, index: int) -> dict:
    """선택한 요소 하나의 정보(솔리드웍스 측정 도구의 단일 선택 결과와 같은 항목)."""
    s = sub_shape(shape, kind, index)
    if kind == "vertex":
        return {"type": "점", "point": _pt(BRep_Tool.Pnt_s(s))}
    if kind == "edge":
        props = GProp_GProps()
        BRepGProp.LinearProperties_s(s, props)
        c = BRepAdaptor_Curve(s)
        info = {"type": "모서리", "length": props.Mass()}
        t = c.GetType()
        if t == GeomAbs_Line:
            info["type"] = "직선 모서리"
            info["start"] = _pt(c.Value(c.FirstParameter()))
            info["end"] = _pt(c.Value(c.LastParameter()))
        elif t == GeomAbs_Circle:
            circ = c.Circle()
            info.update(type="원/호", radius=circ.Radius(), diameter=2 * circ.Radius(),
                        center=_pt(circ.Location()), axis=_dir(circ.Axis().Direction()))
        return info
    # face
    props = GProp_GProps()
    BRepGProp.SurfaceProperties_s(s, props)
    srf = BRepAdaptor_Surface(s)
    t = srf.GetType()
    info = {"type": "면", "area": props.Mass(), "center": _pt(props.CentreOfMass())}
    if t == GeomAbs_Plane:
        info.update(type="평면", normal=_dir(face_normal(s)))
    elif t == GeomAbs_Cylinder:
        cyl = srf.Cylinder()
        info.update(type="원통면", radius=cyl.Radius(), diameter=2 * cyl.Radius(),
                    axis=_dir(cyl.Axis().Direction()), axis_point=_pt(cyl.Location()))
    elif t == GeomAbs_Sphere:
        sph = srf.Sphere()
        info.update(type="구면", radius=sph.Radius(), center=_pt(sph.Location()))
    elif t == GeomAbs_Cone:
        cone = srf.Cone()
        info.update(type="원뿔면", half_angle=math.degrees(cone.SemiAngle()))
    else:
        info["type"] = "곡면"
    return info


def face_normal(face) -> gp_Dir:
    """면 중심에서의 바깥쪽 법선."""
    srf = BRepAdaptor_Surface(face)
    u = (srf.FirstUParameter() + srf.LastUParameter()) / 2
    v = (srf.FirstVParameter() + srf.LastVParameter()) / 2
    p = gp_Pnt()
    n = gp_Vec()
    BRepGProp_Face(face).Normal(u, v, p, n)
    if n.Magnitude() < 1e-12:
        raise GeometryError("법선을 구할 수 없는 면입니다")
    return gp_Dir(n)


def _center_of(shape, kind, index):
    """원/원통이면 중심축 위 점, 아니면 None."""
    d = describe(shape, kind, index)
    return d.get("center") if d.get("type") in ("원/호", "구면") else None


def _direction_of(shape, kind, index):
    s = sub_shape(shape, kind, index)
    if kind == "face":
        srf = BRepAdaptor_Surface(s)
        if srf.GetType() == GeomAbs_Plane:
            return face_normal(s), "normal"
        if srf.GetType() == GeomAbs_Cylinder:
            return srf.Cylinder().Axis().Direction(), "axis"
    if kind == "edge":
        c = BRepAdaptor_Curve(s)
        if c.GetType() == GeomAbs_Line:
            return c.Line().Direction(), "line"
        if c.GetType() == GeomAbs_Circle:
            return c.Circle().Axis().Direction(), "axis"
    return None, None


def measure(shape_a, kind_a, index_a, shape_b, kind_b, index_b) -> dict:
    """두 요소 사이의 측정: 최소 거리, dX/dY/dZ, 중심 거리, 각도, 평행 거리."""
    a = sub_shape(shape_a, kind_a, index_a)
    b = sub_shape(shape_b, kind_b, index_b)
    dist = BRepExtrema_DistShapeShape(a, b)
    if not dist.IsDone():
        raise GeometryError("거리를 계산할 수 없습니다")
    pa, pb = dist.PointOnShape1(1), dist.PointOnShape2(1)
    out = {
        "distance": dist.Value(),
        "p1": _pt(pa), "p2": _pt(pb),
        "dx": abs(pb.X() - pa.X()), "dy": abs(pb.Y() - pa.Y()), "dz": abs(pb.Z() - pa.Z()),
    }
    ca, cb = _center_of(shape_a, kind_a, index_a), _center_of(shape_b, kind_b, index_b)
    if ca and cb:
        out["center_distance"] = math.dist(ca, cb)
        out["c1"], out["c2"] = ca, cb
    da, ta = _direction_of(shape_a, kind_a, index_a)
    db, tb = _direction_of(shape_b, kind_b, index_b)
    if da is not None and db is not None:
        ang = math.degrees(da.Angle(db))
        if ta != "normal" or tb != "normal":  # 축/선은 방향 부호가 없다
            ang = min(ang, 180 - ang)
        if (ta == "normal") != (tb == "normal"):
            ang = 90 - ang  # 평면과 선/축 사이 각도(평행 = 0°)
        out["angle"] = ang
        # 평행한 두 평면 사이 거리
        if ta == tb == "normal" and (ang < 1e-6 or abs(ang - 180) < 1e-6):
            pa0 = describe(shape_a, kind_a, index_a)["center"]
            pb0 = describe(shape_b, kind_b, index_b)["center"]
            v = gp_Vec(gp_Pnt(*pa0), gp_Pnt(*pb0))
            out["parallel_distance"] = abs(v.Dot(gp_Vec(da)))
    return out


def mass_properties(shape, density: float = 7.85e-3) -> dict:
    """부피(mm³), 표면적(mm²), 질량(g, 기본 밀도는 강철 7.85 g/cm³), 무게중심, 크기."""
    vp = GProp_GProps()
    BRepGProp.VolumeProperties_s(shape, vp)
    sp = GProp_GProps()
    BRepGProp.SurfaceProperties_s(shape, sp)
    lo, hi = bbox(shape)
    vol = vp.Mass()
    return {
        "volume": vol,
        "area": sp.Mass(),
        "mass": vol * density,
        "density": density,
        "center": _pt(vp.CentreOfMass()) if vol > 1e-12 else None,
        "bbox_min": lo, "bbox_max": hi,
        "size": [hi[i] - lo[i] for i in range(3)],
        "faces": sub_map(shape, "face").Extent(),
        "edges": sub_map(shape, "edge").Extent(),
    }


# ---------------------------------------------------------------- 만들기(기본 형상)

def make_primitive(kind: str, p: dict) -> TopoDS_Shape:
    x, y, z = p.get("x", 0), p.get("y", 0), p.get("z", 0)
    origin = gp_Pnt(x, y, z)
    if kind == "box":
        return BRepPrimAPI_MakeBox(origin, p["dx"], p["dy"], p["dz"]).Shape()
    ax = gp_Ax2(origin, gp_Dir(0, 0, 1))
    if kind == "cylinder":
        return BRepPrimAPI_MakeCylinder(ax, p["r"], p["h"]).Shape()
    if kind == "sphere":
        return BRepPrimAPI_MakeSphere(origin, p["r"]).Shape()
    if kind == "cone":
        return BRepPrimAPI_MakeCone(ax, p["r1"], p["r2"], p["h"]).Shape()
    raise GeometryError(f"모르는 형상: {kind}")


# ---------------------------------------------------------------- 변환

def _apply(shape, trsf: gp_Trsf):
    return BRepBuilderAPI_Transform(shape, trsf, True).Shape()


def translate(shape, dx, dy, dz):
    t = gp_Trsf()
    t.SetTranslation(gp_Vec(dx, dy, dz))
    return _apply(shape, t)


def rotate(shape, axis: str, angle_deg: float, center=None):
    if center is None:
        lo, hi = bbox(shape)
        center = [(lo[i] + hi[i]) / 2 for i in range(3)]
    d = {"x": gp_Dir(1, 0, 0), "y": gp_Dir(0, 1, 0), "z": gp_Dir(0, 0, 1)}[axis]
    t = gp_Trsf()
    t.SetRotation(gp_Ax1(gp_Pnt(*center), d), math.radians(angle_deg))
    return _apply(shape, t)


def scale(shape, factor: float, center=None):
    if factor <= 0:
        raise GeometryError("배율은 0보다 커야 합니다")
    if center is None:
        lo, hi = bbox(shape)
        center = [(lo[i] + hi[i]) / 2 for i in range(3)]
    t = gp_Trsf()
    t.SetScale(gp_Pnt(*center), factor)
    return _apply(shape, t)


def scale_xyz(shape, sx, sy, sz):
    """축별 배율(비균일). 원은 타원이 되므로 결과는 B-스플라인 곡면이 될 수 있다."""
    if min(sx, sy, sz) <= 0:
        raise GeometryError("배율은 0보다 커야 합니다")
    g = gp_GTrsf()
    g.SetValue(1, 1, sx)
    g.SetValue(2, 2, sy)
    g.SetValue(3, 3, sz)
    return BRepBuilderAPI_GTransform(shape, g, True).Shape()


def mirror(shape, plane: str, offset: float = 0.0):
    n = {"yz": gp_Dir(1, 0, 0), "xz": gp_Dir(0, 1, 0), "xy": gp_Dir(0, 0, 1)}[plane]
    p = gp_Pnt(n.X() * offset, n.Y() * offset, n.Z() * offset)
    t = gp_Trsf()
    t.SetMirror(gp_Ax2(p, n))
    return _apply(shape, t)


# ---------------------------------------------------------------- 불리언

def _check(op, what):
    op.Build()
    if not op.IsDone() or (hasattr(op, "HasErrors") and op.HasErrors()):
        raise GeometryError(f"{what}에 실패했습니다")
    res = op.Shape()
    if res.IsNull():
        raise GeometryError(f"{what} 결과가 비어 있습니다")
    return res


def _unify(shape):
    """같은 곡면 위에 쪼개진 면/모서리를 하나로 합친다(불리언 후 정리)."""
    try:
        u = ShapeUpgrade_UnifySameDomain(shape, True, True, True)
        u.Build()
        return u.Shape()
    except Exception:
        return shape


def _single(shape):
    """결과가 솔리드 1개뿐인 컴파운드라면 그 솔리드만 꺼낸다."""
    shape = _unify(shape)
    solids = _explode(shape, TopAbs_SOLID)
    return solids[0] if len(solids) == 1 else shape


def boolean(op: str, a, b):
    cls = {"union": BRepAlgoAPI_Fuse, "cut": BRepAlgoAPI_Cut, "intersect": BRepAlgoAPI_Common}[op]
    name = {"union": "합치기", "cut": "빼기", "intersect": "교차"}[op]
    algo = cls(a, b)
    if op == "union":
        algo.SimplifyResult()
    return _single(_check(algo, name))


# ---------------------------------------------------------------- 피처(필렛, 챔퍼, 구멍, 돌출, 쉘, 면 삭제)

def fillet(shape, edge_ids: list[int], radius: float):
    if radius <= 0:
        raise GeometryError("반지름은 0보다 커야 합니다")
    mk = BRepFilletAPI_MakeFillet(shape)
    for i in edge_ids:
        mk.Add(radius, sub_shape(shape, "edge", i))
    try:
        return _check(mk, "필렛")
    except Exception as e:
        raise GeometryError("필렛에 실패했습니다 — 반지름이 너무 큰지 확인하세요") from e


def chamfer(shape, edge_ids: list[int], distance: float):
    if distance <= 0:
        raise GeometryError("거리는 0보다 커야 합니다")
    mk = BRepFilletAPI_MakeChamfer(shape)
    for i in edge_ids:
        mk.Add(distance, sub_shape(shape, "edge", i))
    try:
        return _check(mk, "챔퍼")
    except Exception as e:
        raise GeometryError("챔퍼에 실패했습니다 — 거리가 너무 큰지 확인하세요") from e


def _planar_face(shape, face_id):
    face = sub_shape(shape, "face", face_id)
    if BRepAdaptor_Surface(face).GetType() != GeomAbs_Plane:
        raise GeometryError("평면을 선택하세요")
    return face


def hole(shape, face_id: int, point, diameter: float, depth: float = 0.0):
    """평면 위 지정점에 원형 구멍. depth=0 이면 관통."""
    if diameter <= 0:
        raise GeometryError("지름은 0보다 커야 합니다")
    face = _planar_face(shape, face_id)
    n = face_normal(face)
    # 클릭한 점을 면 위로 정확히 투영
    proj = BRepExtrema_DistShapeShape(face, BRepBuilderAPI_MakeVertex(gp_Pnt(*point)).Vertex())
    proj.Perform()
    p = proj.PointOnShape1(1)
    lo, hi = bbox(shape)
    length = depth if depth > 0 else math.dist(lo, hi) * 2 + 1
    eps = 1e-3
    start = gp_Pnt(p.X() + n.X() * eps, p.Y() + n.Y() * eps, p.Z() + n.Z() * eps)
    ax = gp_Ax2(start, gp_Dir(-n.X(), -n.Y(), -n.Z()))
    tool = BRepPrimAPI_MakeCylinder(ax, diameter / 2, length + eps).Shape()
    return _single(_check(BRepAlgoAPI_Cut(shape, tool), "구멍"))


def push_pull(shape, face_id: int, distance: float):
    """평면을 법선 방향으로 밀거나(+, 돌출) 당긴다(-, 잘라내기)."""
    if abs(distance) < 1e-9:
        raise GeometryError("거리를 입력하세요")
    face = _planar_face(shape, face_id)
    n = face_normal(face)
    vec = gp_Vec(n).Multiplied(distance)
    prism = BRepPrimAPI_MakePrism(face, vec).Shape()
    if distance > 0:
        algo = BRepAlgoAPI_Fuse(shape, prism)
        algo.SimplifyResult()
        return _single(_check(algo, "돌출"))
    return _single(_check(BRepAlgoAPI_Cut(shape, prism), "잘라내기"))


def shell(shape, face_ids: list[int], thickness: float):
    """선택한 면을 열고 두께 thickness로 속을 비운다."""
    if thickness <= 0:
        raise GeometryError("두께는 0보다 커야 합니다")
    faces = TopTools_ListOfShape()
    for i in face_ids:
        faces.Append(sub_shape(shape, "face", i))
    mk = BRepOffsetAPI_MakeThickSolid()
    mk.MakeThickSolidByJoin(shape, faces, -thickness, 1e-3)
    try:
        return _check(mk, "쉘")
    except Exception as e:
        raise GeometryError("쉘에 실패했습니다 — 두께를 줄여 보세요") from e


def delete_faces(shape, face_ids: list[int]):
    """면을 지우고 주변 면을 늘려 메운다(구멍/필렛/챔퍼 제거). STEP 수정의 핵심."""
    algo = BRepAlgoAPI_Defeaturing()
    algo.SetShape(shape)
    for i in face_ids:
        algo.AddFaceToRemove(sub_shape(shape, "face", i))
    algo.SetRunParallel(True)
    algo.Build()
    if not algo.IsDone() or (hasattr(algo, "HasErrors") and algo.HasErrors()):
        raise GeometryError("면 삭제에 실패했습니다 — 주변 면으로 메울 수 없는 면입니다")
    return _single(algo.Shape())
