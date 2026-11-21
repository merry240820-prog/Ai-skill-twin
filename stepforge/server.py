"""StepForge 로컬 서버. `python server.py` 실행 후 브라우저에서 http://127.0.0.1:8765 접속."""
from __future__ import annotations

import os
import sys
import tempfile
import threading
import webbrowser

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from core import geometry as g  # noqa: E402
from core.document import Document  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
app = FastAPI(title="StepForge")
doc = Document()
doc.new()
lock = threading.Lock()  # OCCT 작업은 한 번에 하나씩


@app.exception_handler(g.GeometryError)
def _geom_error(_, exc: g.GeometryError):
    return JSONResponse({"error": str(exc)}, status_code=400)


def state() -> dict:
    done, redo = doc.history_labels()
    return {
        "name": doc.name,
        "revision": doc.revision,
        "history": done,
        "redo": redo,
        "bodies": [{"id": b.id, "name": b.name, "color": b.color, "visible": b.visible} for b in doc.bodies],
    }


# ---------------------------------------------------------------- 조회
@app.get("/api/state")
def get_state():
    return state()


@app.get("/api/mesh/{body_id}")
def get_mesh(body_id: int, quality: float = 1.0):
    with lock:
        return g.tessellate(doc.body(body_id).shape, quality)


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


@app.post("/api/new")
def new_doc():
    with lock:
        doc.new()
    return state()


def _out_name(ext: str) -> str:
    stem = doc.name.rsplit(".", 1)[0] if doc.name != "새 문서" else "model"
    return f"{stem}_edited.{ext}"


@app.get("/api/export/step")
def export_step(visible_only: bool = False):
    shapes = doc.visible_shapes() if visible_only else doc.all_shapes()
    if not shapes:
        raise g.GeometryError("저장할 바디가 없습니다")
    with lock:
        data = g.step_bytes(shapes)
    name = _out_name("step")
    return Response(data, media_type="application/step",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_q(name)}"})


@app.get("/api/export/stl")
def export_stl():
    if not doc.bodies:
        raise g.GeometryError("저장할 바디가 없습니다")
    fd, path = tempfile.mkstemp(suffix=".stl")
    os.close(fd)
    with lock:
        g.write_stl(doc.all_shapes(), path)
    with open(path, "rb") as f:
        data = f.read()
    os.remove(path)
    return Response(data, media_type="model/stl",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{_q(_out_name('stl'))}"})


def _q(s):
    from urllib.parse import quote
    return quote(s)


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
    """density 단위는 g/cm³ (화면 입력 기준)."""
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
        elif o.op == "props":
            doc.set_props(o.body, p.get("name"), p.get("color"), p.get("visible"))
        elif o.op == "undo":
            doc.undo()
        elif o.op == "redo":
            doc.redo()
        else:
            b = doc.body(o.body)
            s = b.shape
            if o.op == "translate":
                new, label = g.translate(s, p.get("dx", 0), p.get("dy", 0), p.get("dz", 0)), "이동"
            elif o.op == "rotate":
                new, label = g.rotate(s, p.get("axis", "z"), p.get("angle", 0)), "회전"
            elif o.op == "scale":
                if all(k in p for k in ("sx", "sy", "sz")) and not (p["sx"] == p["sy"] == p["sz"]):
                    new = g.scale_xyz(s, p["sx"], p["sy"], p["sz"])
                else:
                    new = g.scale(s, p.get("factor", p.get("sx", 1)))
                label = "크기 변경"
            elif o.op == "mirror":
                new, label = g.mirror(s, p.get("plane", "yz"), p.get("offset", 0)), "대칭"
            elif o.op == "fillet":
                new, label = g.fillet(s, o.edges, p["radius"]), f"필렛 R{p['radius']:g}"
            elif o.op == "chamfer":
                new, label = g.chamfer(s, o.edges, p["distance"]), f"챔퍼 C{p['distance']:g}"
            elif o.op == "hole":
                new = g.hole(s, o.faces[0], o.point, p["diameter"], p.get("depth", 0))
                label = f"구멍 Ø{p['diameter']:g}" + (f" 깊이 {p['depth']:g}" if p.get("depth") else " 관통")
            elif o.op == "push_pull":
                new, label = g.push_pull(s, o.faces[0], p["distance"]), f"면 밀기/당기기 {p['distance']:+g}"
            elif o.op == "shell":
                new, label = g.shell(s, o.faces, p["thickness"]), f"쉘 t{p['thickness']:g}"
            elif o.op == "delete_faces":
                new, label = g.delete_faces(s, o.faces), f"면 삭제 ×{len(o.faces)}"
            else:
                raise HTTPException(400, f"모르는 작업: {o.op}")
            doc.replace(b.id, new, f"{label}: {b.name}")
    return state()


# ---------------------------------------------------------------- 화면
app.mount("/static", StaticFiles(directory=os.path.join(HERE, "web")), name="static")


@app.get("/")
def index():
    return FileResponse(os.path.join(HERE, "web", "index.html"))


def main():
    import uvicorn
    port = int(os.environ.get("STEPFORGE_PORT", "8765"))
    if "--no-browser" not in sys.argv:
        threading.Timer(1.2, lambda: webbrowser.open(f"http://127.0.0.1:{port}")).start()
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="warning")


if __name__ == "__main__":
    main()
