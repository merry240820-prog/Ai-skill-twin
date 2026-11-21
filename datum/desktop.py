"""Datum Windows 데스크톱 실행 파일의 진입점.

- 내 PC 안에서만 도는 서버(127.0.0.1, 빈 포트)를 띄우고, Windows 11에 기본 포함된
  Edge WebView2로 브라우저 없이 독립된 프로그램 창을 연다.
- 저장은 Windows '다른 이름으로 저장' 창으로 한다.
- `Datum.exe 파일.step` 처럼 STEP 파일을 넘기면(탐색기에서 더블클릭) 바로 연다.
- `Datum.exe --selftest 결과.txt` 는 창 없이 핵심 기능을 점검하고 종료한다(빌드 검증용).
"""
from __future__ import annotations

import base64
import os
import socket
import sys
import threading
import time
import traceback

APP = "Datum"


def _data_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    d = os.path.join(base, APP)
    os.makedirs(d, exist_ok=True)
    return d


def _setup_stdio():
    # 창 모드 exe에는 콘솔이 없어 stdout/stderr가 None이다 → 로그 파일로 보낸다
    if sys.stdout is None or sys.stderr is None:
        f = open(os.path.join(_data_dir(), "datum.log"), "a", encoding="utf-8", buffering=1)
        sys.stdout = sys.stdout or f
        sys.stderr = sys.stderr or f


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _serve(port: int):
    import uvicorn

    import server
    cfg = uvicorn.Config(server.app, host="127.0.0.1", port=port, log_level="warning", log_config=None, access_log=False)
    srv = uvicorn.Server(cfg)
    threading.Thread(target=srv.run, daemon=True).start()
    for _ in range(300):
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return srv
        except OSError:
            time.sleep(0.05)
    raise RuntimeError("내부 서버가 시작되지 않았습니다")


class Bridge:
    """화면(JavaScript)에서 window.pywebview.api.* 로 부르는 Windows 기능."""

    def __init__(self):
        self.window = None

    def save_file(self, name: str, b64: str):
        import webview
        ext = os.path.splitext(name)[1].lower()
        kinds = {".step": "STEP 파일 (*.step;*.stp)", ".stl": "STL 파일 (*.stl)", ".pdf": "PDF 문서 (*.pdf)",
                 ".dxf": "DXF 도면 (*.dxf)", ".svg": "SVG 그림 (*.svg)", ".png": "PNG 그림 (*.png)"}
        types = (kinds.get(ext, "모든 파일 (*.*)"), "모든 파일 (*.*)")
        mode = webview.FileDialog.SAVE if hasattr(webview, "FileDialog") else webview.SAVE_DIALOG
        res = self.window.create_file_dialog(mode, save_filename=name, file_types=types)
        if not res:
            return None
        path = res if isinstance(res, str) else res[0]
        if ext and not path.lower().endswith(ext):
            path += ext
        with open(path, "wb") as f:
            f.write(base64.b64decode(b64))
        return path


def selftest(out_path: str) -> int:
    """창 없이 엔진 전체를 점검한다. 성공하면 0."""
    lines = []
    ok = True

    def check(name, fn):
        nonlocal ok
        t = time.time()
        try:
            msg = fn()
            lines.append(f"OK   {name} ({time.time() - t:.1f}s) {msg or ''}")
        except Exception:
            ok = False
            lines.append(f"FAIL {name}\n{traceback.format_exc()}")

    import tempfile
    tmp = tempfile.mkdtemp()
    state = {}

    def geom():
        from core import geometry as g
        s = g.make_primitive("box", {"dx": 100, "dy": 10, "dz": 10})
        state["s"] = s
        top = [i for i in range(6) if g.describe(s, "face", i)["normal"] == [0, 0, 1]][0]
        h = g.hole(s, top, [50, 5, 10], 4)
        return f"volume={g.mass_properties(h)['volume']:.2f}"

    def step():
        from core import stepio
        p = os.path.join(tmp, "t.step")
        stepio.write_step([{"name": "시험 부품", "shape": state["s"], "color": "#ff8800"}], p)
        parts = stepio.read_step(p)
        assert parts[0]["name"] == "시험 부품", parts[0]["name"]
        return parts[0]["color"]

    def fea_():
        from core import fea
        from core import geometry as g
        s = state["s"]
        fx = [i for i in range(6) if g.describe(s, "face", i)["normal"] == [-1, 0, 0]][0]
        tip = [i for i in range(6) if g.describe(s, "face", i)["normal"] == [1, 0, 0]][0]
        r = fea.static_analysis(s, [fx], [{"faces": [tip], "type": "force", "value": 100, "dir": "-z"}], {"E": 210000, "nu": 0.3, "yield": 275}, "coarse")
        assert abs(r["max_disp"] - 0.1905) / 0.1905 < 0.03, r["max_disp"]
        return f"disp={r['max_disp']:.4f}mm (이론 0.1905)"

    def draw():
        from core import drawing
        d = drawing.make_drawing(state["s"], "A3")
        prims = {"sheet": d["sheet"], "prims": [{"t": "line", "p": [10, 10, 50, 10], "s": "thick"},
                                                {"t": "text", "x": 30, "y": 30, "str": "Ø10 도면", "h": 3.5, "a": "middle", "s": "dim"}]}
        drawing.export_pdf(prims, os.path.join(tmp, "a.pdf"))
        drawing.export_dxf(prims, os.path.join(tmp, "a.dxf"))
        return f"views={len(d['views'])} dims={len(d['dims'])} font={drawing._font_path()}"

    def srv():
        import json
        import urllib.request
        port = _free_port()
        _serve(port)
        st = json.loads(urllib.request.urlopen(f"http://127.0.0.1:{port}/api/state", timeout=10).read())
        js = urllib.request.urlopen(f"http://127.0.0.1:{port}/static/app.js", timeout=10).read()
        assert st["app"] == APP and len(js) > 1000
        return f"version={st['version']}"

    def gui():
        import webview  # noqa: F401
        return "pywebview import ok"

    for name, fn in [("형상 엔진", geom), ("STEP 입출력", step), ("응력 해석", fea_), ("도면", draw), ("내부 서버", srv), ("창(WebView2)", gui)]:
        check(name, fn)
    lines.append("RESULT " + ("PASS" if ok else "FAIL"))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return 0 if ok else 1


def main():
    _setup_stdio()
    here = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
    os.chdir(here)
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.path.join(_data_dir(), "selftest.txt")
        sys.exit(selftest(out))

    import webview

    port = _free_port()
    _serve(port)
    # 탐색기에서 STEP 파일로 연 경우
    for arg in sys.argv[1:]:
        if arg.lower().endswith((".step", ".stp")) and os.path.isfile(arg):
            import server
            with server.lock:
                server.doc.open_step(arg, os.path.basename(arg))
            break

    bridge = Bridge()
    try:
        webview.settings["ALLOW_DOWNLOADS"] = True
    except Exception:
        pass
    win = webview.create_window(APP, f"http://127.0.0.1:{port}/", js_api=bridge, width=1500, height=930,
                                min_size=(1100, 700), background_color="#F3F4F6", text_select=False)
    bridge.window = win
    webview.start(gui="edgechromium" if sys.platform == "win32" else None, private_mode=False,
                  storage_path=os.path.join(_data_dir(), "webview"))


if __name__ == "__main__":
    main()
