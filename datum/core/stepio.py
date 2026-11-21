"""STEP 입출력(XDE) — 부품 이름과 색상, 조립 위치를 보존한다.

솔리드웍스 등에서 내보낸 STEP의 부품 이름·색을 읽고, 저장할 때 다시 써 넣는다.
조립품은 각 부품을 실제 위치로 옮긴 바디 목록으로 펼친다.
"""
from __future__ import annotations

from OCP.IFSelect import IFSelect_RetDone
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.STEPCAFControl import STEPCAFControl_Reader, STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDF import TDF_Label
from OCP.TDocStd import TDocStd_Document
from OCP.TopAbs import TopAbs_SHELL, TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.TopLoc import TopLoc_Location
from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool
from OCP.collections import Sequence_TDF_Label

from .geometry import GeometryError


def _doc():
    return TDocStd_Document(TCollection_ExtendedString("XmlOcaf"))


def _hex(c: Quantity_Color) -> str:
    # STEP 색은 선형 RGB로 저장되는 경우가 많지만, 대부분의 CAD는 그대로 sRGB 값처럼 쓴다
    return "#" + "".join(f"{max(0, min(255, round(v * 255))):02x}" for v in (c.Red(), c.Green(), c.Blue()))


def _rgb(hex_: str) -> Quantity_Color:
    h = hex_.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return Quantity_Color(r, g, b, Quantity_TOC_RGB)


def _name(lab: TDF_Label) -> str | None:
    attr = TDataStd_Name()
    if lab.FindAttribute(TDataStd_Name.GetID_s(), attr):
        n = attr.Get().ToExtString().strip()
        return n or None
    return None


def _color(ct, lab, shape) -> str | None:
    c = Quantity_Color()
    for t in (XCAFDoc_ColorGen, XCAFDoc_ColorSurf):
        if ct.GetColor_s(lab, t, c) or ct.GetColor(shape, t, c):
            return _hex(c)
    return None


def _solids(shape):
    out = []
    for kind in (TopAbs_SOLID, TopAbs_SHELL):
        exp = TopExp_Explorer(shape, kind)
        while exp.More():
            out.append(exp.Current())
            exp.Next()
        if out:
            return out
    return [shape]


def read_step(path: str) -> list[dict]:
    """[{name, shape, color}] — 조립품은 부품마다 하나씩 펼친다."""
    doc = _doc()
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    if reader.ReadFile(path) != IFSelect_RetDone or not reader.Transfer(doc):
        raise GeometryError("STEP 파일을 읽을 수 없습니다")
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    parts: list[dict] = []

    def walk(lab, loc: TopLoc_Location, inherited_color, inherited_name):
        ref = TDF_Label()
        if st.IsReference_s(lab) and st.GetReferredShape_s(lab, ref):
            inst_loc = st.GetLocation_s(lab)
            color = _color(ct, lab, st.GetShape_s(lab)) or inherited_color
            walk(ref, loc.Multiplied(inst_loc), color, _name(ref) or _name(lab) or inherited_name)
            return
        shape = st.GetShape_s(lab)
        color = _color(ct, lab, shape) or inherited_color
        name = _name(lab) or inherited_name
        if st.IsAssembly_s(lab):
            comps = Sequence_TDF_Label()
            st.GetComponents_s(lab, comps, False)
            for i in range(1, comps.Length() + 1):
                walk(comps.Value(i), loc, color, name)
            return
        solids = _solids(shape)
        for k, s in enumerate(solids):
            parts.append({
                "name": (name or "Part") + (f"-{k + 1}" if len(solids) > 1 else ""),
                "shape": s.Moved(loc) if not loc.IsIdentity() else s,
                "color": _color(ct, lab, s) or color,
            })

    free = Sequence_TDF_Label()
    st.GetFreeShapes(free)
    for i in range(1, free.Length() + 1):
        walk(free.Value(i), TopLoc_Location(), None, None)
    if not parts:
        raise GeometryError("STEP 파일에 형상이 없습니다")
    return parts


def write_step(parts: list[dict], path: str) -> None:
    """parts = [{name, shape, color}] — 이름과 색을 함께 저장한다."""
    Interface_Static.SetCVal_s("write.step.unit", "MM")
    Interface_Static.SetCVal_s("write.step.schema", "AP214IS")
    doc = _doc()
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    for p in parts:
        lab = st.AddShape(p["shape"], False)
        TDataStd_Name.Set_s(lab, TCollection_ExtendedString(p["name"], True))
        if p.get("color"):
            ct.SetColor(lab, _rgb(p["color"]), XCAFDoc_ColorGen)
    writer = STEPCAFControl_Writer()
    writer.SetColorMode(True)
    writer.SetNameMode(True)
    if not writer.Transfer(doc, STEPControl_AsIs) or writer.Write(path) != IFSelect_RetDone:
        raise GeometryError("STEP 파일을 저장하지 못했습니다")
