"""Datum 로컬 서버.

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
from core.document import Document  # noqa: E402

APP_NAME = "Datum"
VERSION = "0.2.0"
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
        "bodies": [{"id": b.id, "rev": b.rev, "name": b.name, "color": b.color, "visible": b.visible}
                   for b in doc.bodies],
    }


# ---------------------------------------------------------------- 조회
@app.get("/api/state")
def get_state():
    return state()


@app.get("/api/mesh/{body_id}")
def get_mesh(body_id: int, quality: float = 1.0):
    with lock:
        b = doc.body(body_id)
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
    port = int(os.environ.get("DATUM_PORT", "8765"))
    url = f"http://127.0.0.1:{port}"
    print(f"{APP_NAME} {VERSION} — {url}  (종료: Ctrl+C)")
    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, lambda: _open_window(url)).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
