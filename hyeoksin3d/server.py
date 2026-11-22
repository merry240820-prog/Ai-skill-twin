"""혁신3D 로컬 서버.

`python server.py` 를 실행하면 브라우저(가능하면 앱 창 모드)로 http://127.0.0.1:8765 가 열린다.
서버는 127.0.0.1 에만 열리므로 같은 PC 밖에서는 접속할 수 없다.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import webbrowser
from collections import OrderedDict
from urllib.parse import quote

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import geometry as g  # noqa: E402
from core import stepio  # noqa: E402
from core import assembly, drawing, fea, sketch  # noqa: E402
from core.geometry import make_compound  # noqa: E402
from core.document import Document  # noqa: E402

APP_NAME = "혁신3D"
VERSION = "0.6.0"
HERE = os.path.dirname(os.path.abspath(__file__))
app = FastAPI(title=APP_NAME, version=VERSION)
doc = Document()
doc.new()
lock = threading.Lock()  # OCCT 작업은 한 번에 하나씩
mesh_cache: OrderedDict = OrderedDict()  # (body id, rev, quality) -> 메시


@app.exception_handler(g.GeometryError)
def _geom_error(_, exc: g.GeometryError):
    return JSONResponse({"error": str(exc)}, status_code=400)


def state() -> dict:
    done, redo = doc.timeline()
    return {
        "app": APP_NAME, "version": VERSION,
        "name": doc.name, "revision": doc.revision,
        "history": done, "redo": redo,
        "bodies": [{"id": b.id, "rev": b.rev, "name": b.name, "color": b.color, "visible": b.visible, "fixed": b.fixed}
                   for b in doc.bodies],
        "mates": doc.mate_list(),
    }


# ---------------------------------------------------------------- 조회
@app.get("/api/state")
def get_state():
    return state()


@app.get("/api/mesh/{body_id}")
def get_mesh(body_id: int, quality: float = 1.0, rev: int = 0):
    with lock:
        b = doc.body(body_id)
        if rev and rev != b.rev:
            raise HTTPException(409, "형상이 바뀌었습니다 — 다시 불러오세요")
        key = (b.id, b.rev, quality)
        if key not in mesh_cache:
            mesh_cache[key] = g.tessellate(b.shape, quality)
            while len(mesh_cache) > 64:
                mesh_cache.popitem(last=False)
        mesh_cache.move_to_end(key)
        return JSONResponse(mesh_cache[key], headers={"Cache-Control": "private, max-age=31536000, immutable"})


# ---------------------------------------------------------------- 파일
async def _save_upload(file: UploadFile) -> str:
    name = file.filename or "model.step"
    if not name.lower().endswith((".step", ".stp")):
        raise g.GeometryError("STEP(.step, .stp) 파일만 열 수 있습니다")
    fd, path = tempfile.mkstemp(suffix=".step")
    with os.fdopen(fd, "wb") as f:
        f.write(await file.read())
    return path


@app.post("/api/open")
async def open_file(file: UploadFile = File(...)):
    path = await _save_upload(file)
    try:
        with lock:
            doc.open_step(path, file.filename)
    finally:
        os.remove(path)
    return state()


@app.post("/api/import")
async def import_file(file: UploadFile = File(...)):
    path = await _save_upload(file)
    try:
        with lock:
            doc.import_step(path, file.filename)
    finally:
        os.remove(path)
    return state()


@app.post("/api/sample")
def open_sample():
    with lock:
        doc.open_step(os.path.join(HERE, "samples", "bracket.step"), "bracket.step")
    return state()


@app.post("/api/new")
def new_doc():
    with lock:
        doc.new()
    return state()


def _out_name(ext: str) -> str:
    stem = doc.name.rsplit(".", 1)[0] if doc.name != "새 문서" else "model"
    return f"{stem}_edited.{ext}"


def _download(data: bytes, name: str, mime: str):
    return Response(data, media_type=mime,
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})


def _tmp_export(fn, suffix):
    fd, path = tempfile.mkstemp(suffix=suffix)
    os.close(fd)
    try:
        fn(path)
        with open(path, "rb") as f:
            return f.read()
    finally:
        os.remove(path)


@app.get("/api/export/step")
def export_step(visible_only: bool = False):
    parts = doc.parts(visible_only)
    if not parts:
        raise g.GeometryError("저장할 바디가 없습니다")
    with lock:
        data = _tmp_export(lambda p: stepio.write_step(parts, p), ".step")
    return _download(data, _out_name("step"), "application/step")


@app.get("/api/export/stl")
def export_stl():
    if not doc.bodies:
        raise g.GeometryError("저장할 바디가 없습니다")
    with lock:
        data = _tmp_export(lambda p: g.write_stl([b.shape for b in doc.bodies], p), ".stl")
    return _download(data, _out_name("stl"), "model/stl")


# ---------------------------------------------------------------- 측정
class Pick(BaseModel):
    body: int
    kind: str  # face | edge | vertex
    index: int


class MeasureReq(BaseModel):
    picks: list[Pick]


@app.post("/api/measure")
def measure(req: MeasureReq):
    with lock:
        if len(req.picks) == 1:
            p = req.picks[0]
            return {"single": g.describe(doc.body(p.body).shape, p.kind, p.index)}
        if len(req.picks) == 2:
            a, b = req.picks
            return {
                "a": g.describe(doc.body(a.body).shape, a.kind, a.index),
                "b": g.describe(doc.body(b.body).shape, b.kind, b.index),
                "pair": g.measure(doc.body(a.body).shape, a.kind, a.index,
                                  doc.body(b.body).shape, b.kind, b.index),
            }
    raise g.GeometryError("요소를 1~2개 선택하세요")


@app.get("/api/mass/{body_id}")
def mass(body_id: int, density: float = 7.85):
    """density 단위는 g/cm³."""
    with lock:
        return g.mass_properties(doc.body(body_id).shape, density * 1e-3)


# ---------------------------------------------------------------- 어셈블리 · 시뮬레이션
@app.get("/api/interference")
def interference():
    with lock:
        bodies = [(b.id, b.name, b.shape) for b in doc.bodies if b.visible]
    return {"hits": assembly.interference(bodies)}


@app.get("/api/materials")
def materials():
    return [{"key": k, "name": v[0], "E": v[1], "nu": v[2], "yield": v[3], "density": v[4]} for k, v in fea.MATERIALS.items()]


class SimReq(BaseModel):
    body: int
    fixed: list[int]
    loads: list[dict]
    material: dict
    density: str = "normal"


@app.post("/api/sim/static")
def simulate(req: SimReq):
    with lock:
        b = doc.body(req.body)
        shape, rev = b.shape, b.rev
    result = fea.static_analysis(shape, req.fixed, req.loads, req.material, req.density)  # 무거운 계산은 잠금 밖에서
    result["body"], result["rev"] = req.body, rev
    return result


# ---------------------------------------------------------------- 도면
class DrawReq(BaseModel):
    bodies: list[int] | None = None  # 비우면 보이는 바디 전부(조립도)
    sheet: str = "A3"
    scale: list[int] | None = None  # [분자, 분모], 비우면 자동
    views: list[str] = ["front", "top", "right", "iso"]
    hidden: bool = True


@app.post("/api/drawing")
def make_drawing(req: DrawReq):
    with lock:
        bodies = [b for b in doc.bodies if (b.id in req.bodies if req.bodies else b.visible)]
        if not bodies:
            raise g.GeometryError("도면으로 만들 바디가 없습니다")
        shape = bodies[0].shape if len(bodies) == 1 else make_compound([b.shape for b in bodies])
        names = [b.name for b in bodies]
    d = drawing.make_drawing(shape, req.sheet, tuple(req.scale) if req.scale else None, tuple(req.views), req.hidden)
    d["part"] = names[0] if len(names) == 1 else f"{doc.name.rsplit('.', 1)[0]} 조립도"
    d["date"] = drawing.today()
    return d


class SectionReq(BaseModel):
    bodies: list[int] | None = None
    parent: str
    orient: str  # 'h' | 'v'
    pos: float
    flip: bool = False
    spacing: float = 1.5  # 빗금 간격(모델 mm)
    label: str = "A"


@app.post("/api/drawing/section")
def drawing_section(req: SectionReq):
    with lock:
        bodies = [b for b in doc.bodies if (b.id in req.bodies if req.bodies else b.visible)]
        if not bodies:
            raise g.GeometryError("도면으로 만들 바디가 없습니다")
        shape = bodies[0].shape if len(bodies) == 1 else make_compound([b.shape for b in bodies])
    return drawing.section_view(shape, req.parent, req.orient, req.pos, req.flip, req.spacing, req.label)


class ExportReq(BaseModel):
    sheet: dict
    prims: list[dict]
    title: str = "drawing"


@app.post("/api/drawing/export/{fmt}")
def export_drawing(fmt: str, req: ExportReq):
    if fmt not in ("pdf", "dxf"):
        raise HTTPException(400, "pdf 또는 dxf")
    fn = drawing.export_pdf if fmt == "pdf" else drawing.export_dxf
    data = _tmp_export(lambda p: fn(req.model_dump(), p), "." + fmt)
    return _download(data, f"{req.title}.{fmt}", "application/pdf" if fmt == "pdf" else "image/vnd.dxf")


# ---------------------------------------------------------------- 스케치
class SketchPlaneReq(BaseModel):
    body: int | None = None
    face: int | None = None
    base: str | None = None  # 'xy' | 'xz' | 'yz'


@app.post("/api/sketch/plane")
def sketch_plane(req: SketchPlaneReq):
    with lock:
        if req.body is not None and req.face is not None:
            pl = sketch.plane_from_face(doc.body(req.body).shape, req.face)
            pl["body"] = req.body
            return pl
    return sketch.base_plane(req.base or "xy")


# ---------------------------------------------------------------- 부품 끌기(메이트를 지키며)
drag_state: dict = {}


def _trsf(m: list[float]):
    from OCP.gp import gp_Trsf
    t = gp_Trsf()
    t.SetValues(*m)  # 3×4 행 우선
    return t


def _mat(t) -> list[float]:
    return [t.Value(r, c) for r in (1, 2, 3) for c in (1, 2, 3, 4)]


class DragReq(BaseModel):
    body: int
    matrix: list[float]  # 끌기 시작 위치 기준 3×4 변환


def _drag_solve(req: DragReq):
    from OCP.TopLoc import TopLoc_Location
    start = drag_state.get("start")
    if not start or drag_state.get("body") != req.body or drag_state.get("rev") != doc.revision:
        start = {b.id: b.shape for b in doc.bodies}
        drag_state.update(start=start, body=req.body, rev=doc.revision)
    b = doc.body(req.body)
    if b.fixed:
        raise g.GeometryError(f"'{b.name}'은(는) 고정 부품입니다 — 고정을 해제하면 움직일 수 있습니다")
    shapes = dict(start)
    shapes[req.body] = start[req.body].Moved(TopLoc_Location(_trsf(req.matrix)))
    live = [m for m in doc.mates if m["ref"]["body"] in shapes and m["mov"]["body"] in shapes]
    if live:
        # 끄는 부품은 잠시 '기준'으로 두고 나머지를 맞춘 뒤, 끄는 부품 자신도 메이트에 맞춘다
        assembly.solve(live, shapes, {x.id for x in doc.bodies if x.fixed})
    out = {}
    for bid, sh in shapes.items():
        if sh is start[bid]:
            continue
        rel = sh.Location().Transformation().Multiplied(start[bid].Location().Transformation().Inverted())
        out[bid] = _mat(rel)
    return shapes, out


@app.post("/api/drag/preview")
def drag_preview(req: DragReq):
    with lock:
        _, out = _drag_solve(req)
    return {"moves": out}


@app.post("/api/drag/commit")
def drag_commit(req: DragReq):
    with lock:
        shapes, out = _drag_solve(req)
        for bid in out:
            doc.body(bid).set_shape(shapes[bid])
        drag_state.clear()
        doc.commit(f"부품 끌기 · {doc.body(req.body).name}", "move")
    return state()


# ---------------------------------------------------------------- 편집
class Op(BaseModel):
    op: str
    body: int | None = None
    tool: int | None = None
    kind: str | None = None
    faces: list[int] = []
    edges: list[int] = []
    point: list[float] | None = None
    params: dict = {}


def _shape_op(o: Op):
    """바디 하나의 형상을 바꾸는 작업 → (새 형상, 기록 이름, 종류)."""
    p, s = o.params, doc.body(o.body).shape
    if o.op == "translate":
        return g.translate(s, p.get("dx", 0), p.get("dy", 0), p.get("dz", 0)), "이동", "move"
    if o.op == "rotate":
        return g.rotate(s, p.get("axis", "z"), p.get("angle", 0)), f"회전 {p.get('angle', 0):g}°", "rotate"
    if o.op == "scale":
        sx, sy, sz = p.get("sx", 1), p.get("sy", 1), p.get("sz", 1)
        new = g.scale(s, sx) if sx == sy == sz else g.scale_xyz(s, sx, sy, sz)
        return new, "크기", "scale"
    if o.op == "mirror":
        return g.mirror(s, p.get("plane", "yz"), p.get("offset", 0)), "대칭", "mirror"
    if o.op == "fillet":
        return g.fillet(s, o.edges, p["radius"]), f"필렛 R{p['radius']:g}", "fillet"
    if o.op == "chamfer":
        return g.chamfer(s, o.edges, p["distance"]), f"챔퍼 C{p['distance']:g}", "chamfer"
    if o.op == "hole":
        new = g.hole(s, o.faces[0], o.point, p["diameter"], p.get("depth", 0))
        return new, f"구멍 Ø{p['diameter']:g}" + (f"×{p['depth']:g}" if p.get("depth") else " 관통"), "hole"
    if o.op == "push_pull":
        return g.push_pull(s, o.faces[0], p["distance"]), f"돌출/컷 {p['distance']:+g}", "extrude"
    if o.op == "offset_faces":
        d = p["distance"]
        return g.offset_faces(s, {f: d for f in o.faces}), f"면 이동 {d:+g}", "offset"
    if o.op == "set_diameter":
        return g.set_diameter(s, o.faces[0], p["diameter"]), f"지름 → Ø{p['diameter']:g}", "diameter"
    if o.op == "set_distance":
        return g.set_face_distance(s, o.faces[0], o.faces[1], p["distance"]), f"거리 → {p['distance']:g}", "distance"
    if o.op == "shell":
        return g.shell(s, o.faces, p["thickness"]), f"쉘 t{p['thickness']:g}", "shell"
    if o.op == "delete_faces":
        return g.delete_faces(s, o.faces), f"면 삭제 ×{len(o.faces)}", "delete_faces"
    raise HTTPException(400, f"모르는 작업: {o.op}")


@app.post("/api/op")
def operation(o: Op):
    p = o.params
    with lock:
        if o.op == "primitive":
            doc.add_primitive(o.kind, p)
        elif o.op == "boolean":
            doc.boolean(o.kind, o.body, o.tool, bool(p.get("keep_tool")))
        elif o.op == "delete_body":
            doc.delete_body(o.body)
        elif o.op == "copy_body":
            doc.copy_body(o.body, p.get("dx", 0), p.get("dy", 0), p.get("dz", 0))
        elif o.op == "pattern_linear":
            s = doc.body(o.body).shape
            copies = g.pattern_linear(s, int(p["count"]), p.get("dx", 0), p.get("dy", 0), p.get("dz", 0))
            doc.pattern(o.body, copies, bool(p.get("merge")), f"선형 패턴 ×{int(p['count'])}")
        elif o.op == "pattern_circular":
            s = doc.body(o.body).shape
            copies = g.pattern_circular(s, int(p["count"]), p.get("axis", "z"), p.get("angle", 360),
                                        [p.get("cx", 0), p.get("cy", 0), p.get("cz", 0)])
            doc.pattern(o.body, copies, bool(p.get("merge")), f"원형 패턴 ×{int(p['count'])}")
        elif o.op == "props":
            doc.set_props(o.body, p.get("name"), p.get("color"), p.get("visible"))
        elif o.op == "undo":
            doc.undo()
        elif o.op == "redo":
            doc.redo()
        elif o.op == "goto":
            doc.goto(int(p["index"]))
        elif o.op == "mate":
            a, b = p["ref"], p["mov"]
            doc.add_mate(o.kind, a, b, float(p.get("offset", 0)), bool(p.get("aligned")))
        elif o.op == "delete_mate":
            doc.delete_mate(int(p["id"]))
        elif o.op == "edit_mate":
            doc.edit_mate(int(p["id"]), p.get("offset"), p.get("aligned"))
        elif o.op == "fix":
            doc.set_fixed(o.body, bool(p.get("fixed", True)))
        elif o.op == "rebuild":
            doc.rebuild()
        elif o.op == "sketch_extrude":
            pl, ents = p["plane"], p["entities"]
            target = doc.body(o.body) if o.body is not None else None
            mode = p.get("mode", "boss")
            if target is None and mode != "new":
                mode = "new"
            new = sketch.extrude(target.shape if target else None, pl, ents, float(p.get("depth", 10)), mode,
                                 bool(p.get("reverse")), bool(p.get("through")), bool(p.get("both")))
            label = {"boss": "스케치 돌출", "cut": "스케치 컷", "new": "스케치 새 바디"}[mode]
            if mode == "new":
                from core.document import Body, PALETTE
                n = sum(1 for b in doc.bodies if b.name.startswith("스케치 바디")) + 1
                doc.bodies.append(Body(f"스케치 바디{n}", new, PALETTE[len(doc.bodies) % len(PALETTE)]))
                doc.commit(label, "sketch")
            else:
                doc.replace_shape(target.id, new, label, "sketch")
        else:
            new, label, kind = _shape_op(o)
            doc.replace_shape(o.body, new, label, kind)
    return state()


# ---------------------------------------------------------------- 화면
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "web")), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "web", "index.html"), headers={"Cache-Control": "no-cache"})


def _open_window(url: str):
    """Edge/Chrome이 있으면 주소창 없는 앱 창으로, 없으면 기본 브라우저로 연다."""
    candidates = [
        os.path.expandvars(r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"),
        os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
        os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        shutil.which("google-chrome") or "", shutil.which("chromium") or "", shutil.which("microsoft-edge") or "",
    ]
    for exe in candidates:
        if exe and os.path.isfile(exe):
            try:
                subprocess.Popen([exe, f"--app={url}", "--window-size=1500,920"])
                return
            except OSError:
                pass
    webbrowser.open(url)


def main():
    import uvicorn
    port = int(os.environ.get("HYEOKSIN3D_PORT", "8765"))
    url = f"http://127.0.0.1:{port}"
    print(f"{APP_NAME} {VERSION} — {url}  (종료: Ctrl+C)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, lambda: _open_window(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
