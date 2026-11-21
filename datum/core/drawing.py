"""2D 도면 — 3D 형상에서 투상도를 만들고 치수를 자동으로 붙인다(솔리드웍스 '모델 → 도면'에 해당).

- 투상: OpenCascade HLR(은선 제거). 외형선(보이는 선)과 숨은선을 따로 낸다.
- 배치: KS(제3각법) — 정면도 아래 왼쪽, 평면도는 정면도 위, 우측면도는 정면도 오른쪽, 등각도는 오른쪽 위.
- 척도: 용지에 들어가는 가장 큰 표준 척도를 자동 선택.
- 자동 치수: 전체 크기(가로·높이·깊이), 구멍 지름(같은 지름은 n×Ø), 구멍 중심 위치(기준 모서리에서).
- 출력: 화면(SVG)이 그린 기본 요소(선·원·호·문자)를 받아 PDF(reportlab)와 DXF(ezdxf)로 저장.

좌표: 각 뷰의 엔티티는 '모델 mm'의 2D 투상 좌표(y 위쪽). 용지 좌표는 mm, y 아래쪽(SVG와 같음).
"""
from __future__ import annotations

import math
import os
from datetime import date

from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Line
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.TopAbs import TopAbs_EDGE
from OCP.TopExp import TopExp_Explorer
from OCP.gp import gp_Ax2, gp_Dir, gp_Pnt

from . import geometry as g

SHEETS = {"A4": (297, 210), "A3": (420, 297), "A2": (594, 420), "A1": (841, 594)}
SCALES = [(10, 1), (5, 1), (2, 1), (1, 1), (1, 2), (1, 5), (1, 10), (1, 20), (1, 50), (1, 100)]

# 뷰 이름: (보는 방향 N — 관찰자 쪽, 화면 오른쪽 X)
VIEWS = {
    "front": ("정면도", (0, -1, 0), (1, 0, 0)),
    "top": ("평면도", (0, 0, 1), (1, 0, 0)),
    "right": ("우측면도", (1, 0, 0), (0, 1, 0)),
    "left": ("좌측면도", (-1, 0, 0), (0, -1, 0)),
    "bottom": ("저면도", (0, 0, -1), (1, 0, 0)),
    "back": ("배면도", (0, 1, 0), (-1, 0, 0)),
    "iso": ("등각도", (1, -1, 1), (1, 1, 0)),
}
MARGIN = 10.0
TITLE_W, TITLE_H = 180.0, 44.0


# ------------------------------------------------------------------ 투상
def _edges(shape):
    out = []
    if shape is None or shape.IsNull():
        return out
    exp = TopExp_Explorer(shape, TopAbs_EDGE)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def _r(v):
    return round(v, 4)


def _edge_entities(edge, defl):
    """투상된 2D 모서리 → 엔티티. 직선은 line, 원/호는 circle/arc, 나머지는 꺾은선."""
    from OCP.TopoDS import TopoDS
    e = TopoDS.Edge(edge) if hasattr(TopoDS, "Edge") else TopoDS.Edge_s(edge)
    c = BRepAdaptor_Curve(e)
    t = c.GetType()
    a, b = c.FirstParameter(), c.LastParameter()
    if t == GeomAbs_Line:
        p, q = c.Value(a), c.Value(b)
        if math.hypot(q.X() - p.X(), q.Y() - p.Y()) < 1e-6:
            return []
        return [{"t": "line", "p": [_r(p.X()), _r(p.Y()), _r(q.X()), _r(q.Y())]}]
    if t == GeomAbs_Circle:
        circ = c.Circle()
        ax = circ.Axis().Direction()
        if abs(abs(ax.Z()) - 1) < 1e-6:  # 투상면에 정면으로 보이는 원
            ctr = circ.Location()
            r = circ.Radius()
            if b - a >= 2 * math.pi - 1e-6:
                return [{"t": "circle", "c": [_r(ctr.X()), _r(ctr.Y())], "r": _r(r)}]
            p0, p1 = c.Value(a), c.Value(b)
            ang = lambda p: math.degrees(math.atan2(p.Y() - ctr.Y(), p.X() - ctr.X()))  # noqa: E731
            a0, a1 = ang(p0), ang(p1)
            # 곡선 방향이 시계 방향이면 호의 시작/끝을 바꿔 항상 반시계로
            mid = c.Value((a + b) / 2)
            am = ang(mid)
            span = (a1 - a0) % 360
            if (am - a0) % 360 > span:
                a0, a1 = a1, a0
            return [{"t": "arc", "c": [_r(ctr.X()), _r(ctr.Y())], "r": _r(r), "a0": _r(a0), "a1": _r(a1)}]
    try:
        disc = GCPnts_TangentialDeflection(c, 0.15, defl)
        pts = []
        for k in range(1, disc.NbPoints() + 1):
            p = disc.Value(k)
            pts += [_r(p.X()), _r(p.Y())]
        return [{"t": "poly", "p": pts}] if len(pts) >= 4 else []
    except Exception:
        return []


def project(shape, view: str, hidden: bool = True) -> dict:
    name, n, x = VIEWS[view]
    algo = HLRBRep_Algo()
    algo.Add(shape)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*n), gp_Dir(*x))))
    algo.Update()
    algo.Hide()
    h = HLRBRep_HLRToShape(algo)
    lo, hi = g.bbox(shape)
    defl = max(math.dist(lo, hi) * 0.0015, 1e-3)
    vis, hid = [], []
    for s in (h.VCompound(), h.OutLineVCompound(), h.Rg1LineVCompound() if view == "iso" else None):
        for e in _edges(s):
            vis += _edge_entities(e, defl)
    if hidden and view != "iso":
        for s in (h.HCompound(), h.OutLineHCompound()):
            for e in _edges(s):
                hid += _edge_entities(e, defl)
    xs, ys = [], []
    for ent in vis:
        xs_, ys_ = _ent_extent(ent)
        xs += xs_
        ys += ys_
    if not xs:
        xs, ys = [0, 1], [0, 1]
    snaps = []
    for ent in vis + hid:
        if ent["t"] == "line":
            snaps += [ent["p"][:2], ent["p"][2:]]
        elif ent["t"] in ("circle", "arc"):
            snaps.append(ent["c"])
            if ent["t"] == "arc":
                for a in (ent["a0"], ent["a1"]):
                    snaps.append([_r(ent["c"][0] + ent["r"] * math.cos(math.radians(a))), _r(ent["c"][1] + ent["r"] * math.sin(math.radians(a)))])
        elif ent["t"] == "poly":
            snaps += [ent["p"][:2], ent["p"][-2:]]
    uniq = {}
    for p in snaps:
        uniq[(round(p[0], 3), round(p[1], 3))] = p
    return {"id": view, "name": name, "visible": vis, "hidden": hid, "snaps": list(uniq.values()),
            "bbox": [min(xs), min(ys), max(xs), max(ys)]}


def _ent_extent(ent):
    if ent["t"] == "line":
        return [ent["p"][0], ent["p"][2]], [ent["p"][1], ent["p"][3]]
    if ent["t"] in ("circle", "arc"):
        (cx, cy), r = ent["c"], ent["r"]
        return [cx - r, cx + r], [cy - r, cy + r]
    return ent["p"][0::2], ent["p"][1::2]


# ------------------------------------------------------------------ 배치 · 척도
def _fit_scale(need_w, need_h, avail_w, avail_h):
    for num, den in SCALES:
        s = num / den
        if need_w * s <= avail_w and need_h * s <= avail_h:
            return num, den
    return SCALES[-1]


def _clearance(dims, view, kind, sign):
    """뷰 주변에 치수가 차지할 여백(용지 mm)."""
    offs = [d["offset"] * sign for d in dims if d["view"] == view and d["type"] == kind and d["offset"] * sign > 0]
    return (max(offs) + 7) if offs else 4


def layout(views: dict, sheet: str, scale=None, dims=()):
    W, H = SHEETS[sheet]
    f, t, r, i = (views.get(k) for k in ("front", "top", "right", "iso"))
    size = lambda v: (v["bbox"][2] - v["bbox"][0], v["bbox"][3] - v["bbox"][1]) if v else (0, 0)  # noqa: E731
    fw, fh = size(f)
    tw, th = size(t)
    rw, rh = size(r)
    iw, ih = size(i)
    # 치수가 들어갈 여백
    left = max(_clearance(dims, "front", "v", -1), _clearance(dims, "top", "v", -1))
    top_e = _clearance(dims, "top", "h", 1) if t else _clearance(dims, "front", "h", 1)
    mid = max(_clearance(dims, "top", "h", -1), _clearance(dims, "front", "h", 1)) + 4 if t else 0
    right_t = _clearance(dims, "top", "v", 1) if t else 0
    gap_fr = max(_clearance(dims, "front", "v", 1), 14) if r else 0
    fixed_w = left + gap_fr + 8
    fixed_h = top_e + mid + TITLE_H + 6
    avail_w = W - 2 * MARGIN - fixed_w
    avail_h = H - 2 * MARGIN - fixed_h
    if scale:
        num, den = scale
    else:
        num, den = _fit_scale(max(fw, tw) + rw, fh + th, avail_w, avail_h)
        # 평면도 오른쪽 치수가 우측면도 칸보다 넓으면 한 단계 줄인다
        k = SCALES.index((num, den))
        while k + 1 < len(SCALES) and max(fw, tw) * num / den + max(right_t, gap_fr + rw * num / den) > W - 2 * MARGIN - left - 8:
            k += 1
            num, den = SCALES[k]
    s = num / den
    used_h = top_e + th * s + mid + fh * s
    spare = max(0.0, (H - 2 * MARGIN - TITLE_H - 6) - used_h)
    x0 = MARGIN + left
    col1_w = max(fw, tw) * s
    y_top = MARGIN + top_e + spare / 2
    placed = {}

    def put(v, cx, cy):
        if not v:
            return
        bx0, by0, bx1, by1 = v["bbox"]
        v["ox"] = cx - (bx0 + bx1) / 2 * s  # 용지 좌표 = (ox + x·s, oy − y·s)
        v["oy"] = cy + (by0 + by1) / 2 * s
        v["scale"] = s
        placed[v["id"]] = v

    fcx = x0 + col1_w / 2
    if t:
        put(t, fcx, y_top + th * s / 2)
        fcy = y_top + th * s + mid + fh * s / 2
    else:
        fcy = y_top + fh * s / 2
    put(f, fcx, fcy)
    if r:
        put(r, x0 + col1_w + gap_fr + rw * s / 2, fcy)
    if i:
        # 등각도는 남는 오른쪽 위 공간에, 들어가는 만큼(최대 같은 척도)
        right_x = x0 + col1_w + max(right_t, (gap_fr + rw * s) if r else 0) + 10
        space_w = W - MARGIN - 6 - right_x
        top_y = MARGIN + 6
        space_h = (H - MARGIN - TITLE_H - 14) - top_y
        if space_w > 25 and space_h > 25:
            si = min(s, space_w * 0.9 / max(iw, 1e-9), space_h * 0.85 / max(ih, 1e-9))
            cx, cy = right_x + space_w / 2, top_y + space_h / 2
        else:
            si = min(s * 0.5, (TITLE_W - 10) / max(iw, 1e-9))
            cx, cy = W - MARGIN - TITLE_W / 2, H - MARGIN - TITLE_H - 6 - ih * si / 2 - 8
        i["scale"] = si
        bx0, by0, bx1, by1 = i["bbox"]
        i["ox"] = cx - (bx0 + bx1) / 2 * si
        i["oy"] = cy + (by0 + by1) / 2 * si
        placed["iso"] = i
    return placed, (num, den)


# ------------------------------------------------------------------ 자동 치수
def _circles(v):
    return [e for e in v["visible"] if e["t"] == "circle"]


def auto_dimensions(views: dict) -> list[dict]:
    dims = []
    nid = [0]

    def add(**d):
        nid[0] += 1
        d["id"] = f"a{nid[0]}"
        dims.append(d)

    f, t, r = views.get("front"), views.get("top"), views.get("right")
    if f:
        x0, y0, x1, y1 = f["bbox"]
        add(view="front", type="h", p1=[x0, y0], p2=[x1, y0], offset=-12)
        add(view="front", type="v", p1=[x0, y0], p2=[x0, y1], offset=-12)
    if t:
        x0, y0, x1, y1 = t["bbox"]
        add(view="top", type="v", p1=[x0, y0], p2=[x0, y1], offset=-12)
    elif r:
        x0, y0, x1, y1 = r["bbox"]
        add(view="right", type="h", p1=[x0, y0], p2=[x1, y0], offset=-12)

    # 구멍·원: 정면으로 보이는 원이 가장 많은 뷰 하나에서만 지름과 위치를 넣는다(중복 치수 방지)
    best = max((v for v in (t, f, r) if v), key=lambda v: len(_circles(v)), default=None)
    if best and _circles(best):
        circles = _circles(best)
        groups: dict = {}
        for c in circles:
            groups.setdefault(round(c["r"], 3), []).append(c)
        bx0, by0, bx1, by1 = best["bbox"]
        k = 0
        for rr, cs in sorted(groups.items(), key=lambda kv: -kv[0]):
            c = max(cs, key=lambda c: (c["c"][0], c["c"][1]))
            add(view=best["id"], type="dia", c=c["c"], r=rr, angle=45 + 30 * (k % 3), count=len(cs))
            k += 1
        arcs = [e for e in best["visible"] if e["t"] == "arc"]
        agroups: dict = {}
        for a in arcs:
            agroups.setdefault(round(a["r"], 3), []).append(a)
        for rr, as_ in agroups.items():
            a = max(as_, key=lambda e: e["c"][0] - e["c"][1])  # 오른쪽 아래 것(다른 치수와 덜 겹침)
            mid = math.radians((a["a0"] + ((a["a1"] - a["a0"]) % 360) / 2))
            add(view=best["id"], type="rad", c=a["c"], r=rr, angle=math.degrees(mid), count=len(as_))
        # 위치: 원 중심의 서로 다른 x, y 좌표를 왼쪽/아래 모서리 기준으로 (외곽 원 자체는 제외)
        inner = [c for c in circles if not (abs(c["r"] * 2 - (bx1 - bx0)) < 1e-3 and abs(c["r"] * 2 - (by1 - by0)) < 1e-3)]
        xs = sorted({round(c["c"][0], 3) for c in inner if bx0 + 1e-6 < c["c"][0] < bx1 - 1e-6})
        ys = sorted({round(c["c"][1], 3) for c in inner if by0 + 1e-6 < c["c"][1] < by1 - 1e-6})
        for j, x in enumerate(xs[:6]):
            add(view=best["id"], type="h", p1=[bx0, by1], p2=[x, by1], offset=9 + 7 * j)
        for j, y in enumerate(ys[:6]):
            add(view=best["id"], type="v", p1=[bx1, by0], p2=[bx1, y], offset=9 + 7 * j)
    return dims


def make_drawing(shape, sheet: str = "A3", scale=None, views=("front", "top", "right", "iso"), hidden: bool = True) -> dict:
    if sheet not in SHEETS:
        raise g.GeometryError("용지 크기를 확인하세요")
    projected = {v: project(shape, v, hidden) for v in views}
    dims = auto_dimensions(projected)  # 치수는 모델 좌표라 배치 전에 만들 수 있고, 배치가 그 여백을 확보한다
    placed, (num, den) = layout(projected, sheet, scale, dims)
    W, H = SHEETS[sheet]
    return {
        "sheet": {"name": sheet, "w": W, "h": H, "margin": MARGIN, "title_w": TITLE_W, "title_h": TITLE_H},
        "scale": [num, den],
        "views": list(placed.values()),
        "dims": [d for d in dims if d["view"] in placed],
    }


# ------------------------------------------------------------------ 내보내기
def _font_path():
    for p in [
        os.path.expandvars(r"%WINDIR%\Fonts\malgun.ttf"),
        "C:/Windows/Fonts/malgun.ttf",
        "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
        "/System/Library/Fonts/AppleSDGothicNeo.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    ]:
        if os.path.isfile(p):
            return p
    return None


LINE_W = {"thick": 0.5, "thin": 0.25, "hidden": 0.25, "center": 0.18, "border": 0.7}


def export_pdf(doc: dict, path: str):
    """doc = {sheet:{w,h}, prims:[...]} — prims는 화면이 그린 그대로(용지 mm, y 아래쪽)."""
    from reportlab.lib.units import mm
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.pdfgen import canvas

    W, H = doc["sheet"]["w"], doc["sheet"]["h"]
    font = "Helvetica"
    fp = _font_path()
    if fp:
        try:
            pdfmetrics.registerFont(TTFont("KFont", fp, subfontIndex=0))
            font = "KFont"
        except Exception:
            pass
    c = canvas.Canvas(path, pagesize=(W * mm, H * mm))
    c.setTitle(doc.get("title", "Datum drawing"))
    c.setCreator("Datum")
    Y = lambda y: (H - y) * mm  # noqa: E731
    for p in doc["prims"]:
        st = p.get("s", "thin")
        c.setLineWidth(LINE_W.get(st, 0.25) * mm)
        c.setStrokeColorRGB(0, 0, 0)
        c.setFillColorRGB(0, 0, 0)
        c.setDash({"hidden": [3 * mm, 1.5 * mm], "center": [8 * mm, 1.5 * mm, 1 * mm, 1.5 * mm]}.get(st, []), 0)
        t = p["t"]
        if t == "line":
            x1, y1, x2, y2 = p["p"]
            c.line(x1 * mm, Y(y1), x2 * mm, Y(y2))
        elif t == "poly":
            pts = p["p"]
            path_ = c.beginPath()
            path_.moveTo(pts[0] * mm, Y(pts[1]))
            for k in range(2, len(pts), 2):
                path_.lineTo(pts[k] * mm, Y(pts[k + 1]))
            if p.get("fill"):
                path_.close()
                c.drawPath(path_, stroke=0, fill=1)
            else:
                c.drawPath(path_, stroke=1, fill=0)
        elif t == "circle":
            c.circle(p["c"][0] * mm, Y(p["c"][1]), p["r"] * mm, stroke=1, fill=0)
        elif t == "arc":
            # 호 각도는 y 위쪽 기준(반시계)으로 주어진다 — PDF 좌표계와 같다
            cx, cy, r = p["c"][0], p["c"][1], p["r"]
            extent = (p["a1"] - p["a0"]) % 360 or 360
            c.arc((cx - r) * mm, Y(cy) - r * mm, (cx + r) * mm, Y(cy) + r * mm, p["a0"], extent)
        elif t == "text":
            c.setDash([], 0)
            size = p.get("h", 3.5)
            c.saveState()
            c.translate(p["x"] * mm, Y(p["y"]))
            c.rotate(-p.get("rot", 0))
            c.setFont(font, size * mm * 1.25)
            anchor = p.get("a", "middle")
            draw = {"start": c.drawString, "middle": c.drawCentredString, "end": c.drawRightString}[anchor]
            draw(0, 0, p["str"])
            c.restoreState()
    c.showPage()
    c.save()


def export_dxf(doc: dict, path: str):
    import ezdxf

    W, H = doc["sheet"]["w"], doc["sheet"]["h"]
    d = ezdxf.new("R2010", setup=True)
    d.units = ezdxf.units.MM
    d.header["$MEASUREMENT"] = 1
    for name, color, lt, lw in [("외형선", 7, "CONTINUOUS", 50), ("숨은선", 8, "DASHED", 25), ("중심선", 1, "CENTER", 18),
                                ("치수", 3, "CONTINUOUS", 25), ("윤곽", 7, "CONTINUOUS", 70), ("문자", 7, "CONTINUOUS", 25)]:
        if name not in d.layers:
            d.layers.add(name, color=color, linetype=lt if lt in d.linetypes else "CONTINUOUS", lineweight=lw)
    if "KFont" not in d.styles:
        d.styles.add("KFont", font="malgun.ttf")
    msp = d.modelspace()
    layer = {"thick": "외형선", "hidden": "숨은선", "center": "중심선", "dim": "치수", "border": "윤곽", "thin": "치수"}
    Y = lambda y: H - y  # noqa: E731
    for p in doc["prims"]:
        at = {"layer": layer.get(p.get("s", "thin"), "치수")}
        if p.get("layer"):
            at["layer"] = p["layer"]
        t = p["t"]
        if t == "line":
            x1, y1, x2, y2 = p["p"]
            msp.add_line((x1, Y(y1)), (x2, Y(y2)), dxfattribs=at)
        elif t == "poly":
            pts = [(p["p"][k], Y(p["p"][k + 1])) for k in range(0, len(p["p"]), 2)]
            if p.get("fill") and len(pts) == 3:
                msp.add_solid([pts[0], pts[1], pts[2], pts[2]], dxfattribs=at)
            else:
                msp.add_lwpolyline(pts, close=bool(p.get("fill")), dxfattribs=at)
        elif t == "circle":
            msp.add_circle((p["c"][0], Y(p["c"][1])), p["r"], dxfattribs=at)
        elif t == "arc":
            msp.add_arc((p["c"][0], Y(p["c"][1])), p["r"], p["a0"], p["a1"], dxfattribs=at)
        elif t == "text":
            at["layer"] = "문자" if p.get("s") != "dim" else "치수"
            at["style"] = "KFont"
            at["height"] = p.get("h", 3.5)
            at["rotation"] = -p.get("rot", 0)
            txt = msp.add_text(p["str"], dxfattribs=at)
            from ezdxf.enums import TextEntityAlignment
            al = {"start": TextEntityAlignment.LEFT, "middle": TextEntityAlignment.CENTER, "end": TextEntityAlignment.RIGHT}[p.get("a", "middle")]
            txt.set_placement((p["x"], Y(p["y"])), align=al)
    d.saveas(path)


def today():
    return date.today().isoformat()


# ------------------------------------------------------------------ 단면도
def _frame(view: str):
    _, n, x = VIEWS[view]
    n, x = gp_Dir(*n), gp_Dir(*x)
    y = n.Crossed(x)
    return n, x, y


def _hatch(loops, spacing, angle=45.0):
    """다각형 고리들(짝수/홀수 규칙) 안을 빗금으로 채운 선분 목록."""
    a = math.radians(angle)
    ca, sa = math.cos(a), math.sin(a)
    rot = [[(px * ca + py * sa, -px * sa + py * ca) for px, py in lp] for lp in loops]
    ys = [p[1] for lp in rot for p in lp]
    if not ys:
        return []
    out = []
    k0, k1 = math.floor(min(ys) / spacing), math.ceil(max(ys) / spacing)
    for k in range(k0, k1 + 1):
        yy = k * spacing + spacing * 0.5
        xs = []
        for lp in rot:
            for i in range(len(lp)):
                (x1, y1), (x2, y2) = lp[i], lp[(i + 1) % len(lp)]
                if (y1 <= yy < y2) or (y2 <= yy < y1):
                    xs.append(x1 + (yy - y1) * (x2 - x1) / (y2 - y1))
        xs.sort()
        for j in range(0, len(xs) - 1, 2):
            p, q = (xs[j], yy), (xs[j + 1], yy)
            back = lambda u: (u[0] * ca - u[1] * sa, u[0] * sa + u[1] * ca)  # noqa: E731
            P, Q = back(p), back(q)
            out.append({"t": "line", "p": [_r(P[0]), _r(P[1]), _r(Q[0]), _r(Q[1])]})
    return out


def section_view(shape, parent: str, orient: str, pos: float, flip: bool, spacing: float, label: str = "A") -> dict:
    """부모 뷰 위의 절단선(orient 'h'=수평선 y=pos, 'v'=수직선 x=pos)으로 자른 단면도.

    화살표 방향(보는 쪽)은 flip으로 바꾼다. 결과 좌표는 단면도 자체의 2D 투상 좌표.
    """
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeHalfSpace
    from OCP.gp import gp_Pln

    if parent not in ("front", "top", "right", "left", "bottom", "back"):
        raise g.GeometryError("단면은 정면·평면·측면도에서만 만들 수 있습니다")
    pn, px, py = _frame(parent)
    # 절단면: 수평선이면 법선 = 부모 Y, 수직선이면 법선 = 부모 X
    cut_n = py if orient == "h" else px
    sign = -1 if flip else 1
    look = gp_Dir(cut_n.X() * sign, cut_n.Y() * sign, cut_n.Z() * sign)  # 단면도의 관찰자 방향
    origin = gp_Pnt(cut_n.X() * pos, cut_n.Y() * pos, cut_n.Z() * pos)
    # 관찰자 반대편(look의 반대쪽) 부분만 남긴다
    far = gp_Pnt(origin.X() - look.X() * 1e5, origin.Y() - look.Y() * 1e5, origin.Z() - look.Z() * 1e5)
    half = BRepPrimAPI_MakeHalfSpace(BRepBuilderAPI_MakeFace(gp_Pln(origin, look)).Face(), far).Solid()
    op = BRepAlgoAPI_Common(shape, half)
    op.Build()
    if not op.IsDone() or g.mass_properties(op.Shape())["volume"] < 1e-9:
        raise g.GeometryError("절단선이 부품을 지나지 않습니다")
    cut = op.Shape()
    # 단면도는 똑바로 선 모양으로: 화면 위 = 세계 Z(관찰 방향과 평행하면 Y), 화면 X = 위 × 관찰 방향
    up = gp_Dir(0, 0, 1) if abs(look.Z()) < 0.99 else gp_Dir(0, 1, 0)
    sx = up.Crossed(look)
    name = f"단면 {label}-{label}"
    VIEWS["_sec"] = (name, (look.X(), look.Y(), look.Z()), (sx.X(), sx.Y(), sx.Z()))
    v = project(cut, "_sec", hidden=False)
    del VIEWS["_sec"]
    # 절단면 위의 면들 → 빗금
    sy = look.Crossed(sx)
    loops = []
    exp_faces = g.sub_map(cut, "face")
    for i in range(exp_faces.Extent()):
        d = g.describe(cut, "face", i)
        if d["type"] != "평면":
            continue
        nn = d["normal"]
        if abs(abs(nn[0] * look.X() + nn[1] * look.Y() + nn[2] * look.Z()) - 1) > 1e-6:
            continue
        c = d["center"]
        if abs((c[0] - origin.X()) * look.X() + (c[1] - origin.Y()) * look.Y() + (c[2] - origin.Z()) * look.Z()) > 1e-5:
            continue
        face = g.sub_shape(cut, "face", i)
        from OCP.TopAbs import TopAbs_REVERSED, TopAbs_WIRE
        from OCP.TopExp import TopExp_Explorer
        from OCP.BRepTools import BRepTools_WireExplorer
        we = TopExp_Explorer(face, TopAbs_WIRE)
        while we.More():
            wire = we.Current()
            pts = []
            wx = BRepTools_WireExplorer(g._cast_wire(wire))
            while wx.More():
                c_ = BRepAdaptor_Curve(wx.Current())
                disc = GCPnts_TangentialDeflection(c_, 0.1, max(spacing * 0.05, 1e-3))
                seq = [disc.Value(k) for k in range(1, disc.NbPoints() + 1)]
                if wx.Current().Orientation() == TopAbs_REVERSED:
                    seq.reverse()
                for p in seq[:-1]:
                    pts.append((p.X() * sx.X() + p.Y() * sx.Y() + p.Z() * sx.Z(), p.X() * sy.X() + p.Y() * sy.Y() + p.Z() * sy.Z()))
                wx.Next()
            if len(pts) >= 3:
                loops.append(pts)
            we.Next()
    v["hatch"] = _hatch(loops, spacing) if loops else []
    v["id"] = f"sec{label}"
    v["name"] = name
    v["kind"] = "section"
    v["label"] = label
    v["parent"] = parent
    v["cut"] = {"orient": orient, "pos": pos, "flip": flip}
    return v
