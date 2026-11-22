"""혁신3D Windows 데스크톱 실행 파일의 진입점.

- 내 PC 안에서만 도는 서버(127.0.0.1, 빈 포트)를 띄우고, Windows 11에 기본 포함된
  Edge WebView2로 브라우저 없이 독립된 프로그램 창을 연다.
- 저장은 Windows '다른 이름으로 저장' 창으로 한다.
- `Hyeoksin3D.exe 파일.step` 처럼 STEP 파일을 넘기면(탐색기에서 더블클릭) 바로 연다.
- `Hyeoksin3D.exe --selftest 결과.txt` 는 창 없이 핵심 기능을 점검하고 종료한다(빌드 검증용).
"""
from __future__ import annotations

import base64
import os
import socket
import sys
import threading
import time
import traceback

APP = "혁신3D"
APP_ID = "Hyeoksin3D"


def _data_dir() -> str:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~/.local/share")
    d = os.path.join(base, APP_ID)
    os.makedirs(d, exist_ok=True)
    return d


def _setup_stdio():
    # 창 모드 exe에는 콘솔이 없어 stdout/stderr가 None이다 → 로그 파일로 보낸다
    if sys.stdout is None or sys.stderr is None:
        f = open(os.path.join(_data_dir(), "hyeoksin3d.log"), "a", encoding="utf-8", buffering=1)
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

    def sketch_():
        from core import geometry as g
        from core import sketch
        s = state["s"]
        top = [i for i in range(6) if g.describe(s, "face", i)["normal"] == [0, 0, 1]][0]
        pl = sketch.plane_from_face(s, top)
        r = sketch.extrude(s, pl, [{"t": "rect", "x": 10, "y": 2, "w": 20, "h": 6}, {"t": "circle", "c": [20, 5], "r": 2}], 5, "boss")
        add = g.mass_properties(r)["volume"] - g.mass_properties(s)["volume"]
        assert abs(add - (120 - 3.14159265 * 4) * 5) < 1e-3, add
        return f"추가 부피={add:.2f}"

    def section_():
        from core import drawing
        v = drawing.section_view(state["s"], "front", "v", 50, False, 1.0, "A")
        assert v["hatch"], "해칭 없음"
        return f"해칭 {len(v['hatch'])}선"

    def mate_():
        from core import assembly
        from core import geometry as g
        a = g.make_primitive("box", {"dx": 20, "dy": 20, "dz": 5})
        b = g.translate(g.make_primitive("box", {"dx": 5, "dy": 5, "dz": 5}), 50, 50, 50)
        fa = [i for i in range(6) if g.describe(a, "face", i)["normal"] == [0, 0, 1]][0]
        fb = [i for i in range(6) if g.describe(b, "face", i)["normal"] == [0, 0, -1]][0]
        shapes = {1: a, 2: b}
        res = assembly.solve([{"id": 1, "type": "coincident", "ref": {"body": 1, "kind": "face", "index": fa}, "mov": {"body": 2, "kind": "face", "index": fb}}], shapes, {1})
        assert max(res.values()) < 1e-6
        return f"z={g.mass_properties(shapes[2])['bbox_min'][2]:.3f}"

    for name, fn in [("형상 엔진", geom), ("STEP 입출력", step), ("응력 해석", fea_), ("도면", draw), ("스케치 돌출", sketch_),
                     ("단면도", section_), ("메이트", mate_), ("내부 서버", srv), ("창(WebView2)", gui)]:
        check(name, fn)
    lines.append("RESULT " + ("PASS" if ok else "FAIL"))
    with open(out_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return 0 if ok else 1


# 실제 창(WebView2) 안에서 돌리는 점검 시나리오. 결과는 window.__gt 에 남긴다.
GUI_JS = r"""
(async () => {
  const R = [], errs = [];
  window.addEventListener('error', (e) => errs.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errs.push(String(e.reason)));
  const ok = (name, cond, info = '') => R.push([cond ? 'OK  ' : 'FAIL', name, String(info)]);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 30000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (f()) return true; } catch (e) {} await sleep(100); } return false; };
  try {
    const cv = document.querySelector('canvas.main');
    ok('WebGL 3D 캔버스', cv && (cv.getContext('webgl2') || cv.getContext('webgl')), navigator.userAgent.match(/Edg\/[\d.]+/)?.[0] || '');
    ok('Windows 저장 창 연결', !!(window.pywebview && window.pywebview.api && window.pywebview.api.save_file));
    ok('이름 표시', document.querySelector('.brand b').textContent.includes('혁신3D'));
    document.querySelector('#btn-sample').click();
    ok('예제 열기', await until(() => window.__datum.views.size === 2));
    await sleep(1500);
    // 화면에 실제로 모델이 그려졌는지(배경과 다른 화소 비율)
    const img = new Image(); img.src = cv.toDataURL('image/png'); await img.decode();
    const c2 = document.createElement('canvas'); c2.width = 200; c2.height = 120;
    const g2 = c2.getContext('2d'); g2.drawImage(img, 0, 0, 200, 120);
    const d = g2.getImageData(0, 0, 200, 120).data; let filled = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200 && Math.abs(d[i] - d[i + 2]) + Math.abs(d[i + 1] - d[i + 2]) < 60 && d[i] < 200) filled++;
    ok('3D 모델 그려짐', filled > 600, `${filled} 화소`);
    window.__datum.runCmd('mass');
    ok('질량 특성', await until(() => document.querySelector('#mres')?.textContent.includes('g'), 20000), document.querySelector('#mres')?.textContent.slice(0, 40));
    window.__datum.setTool(null);
    window.__datum.runCmd('sketch');
    ok('스케치 창', await until(() => !document.querySelector('#sketch').hidden && document.querySelector('#sk-svg').childElementCount > 10));
    document.querySelector('#sk-close').click();
    window.__datum.runCmd('drawing');
    ok('도면 만들기', await until(() => document.querySelectorAll('#d-svg line').length > 100, 60000), `${document.querySelectorAll('#d-svg line').length} 선`);
    const prims = window.__drPrims();
    const r = await fetch('/api/drawing/export/pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet: window.__dr().sheet, prims: prims.map(({ dim, note, view, ...p }) => p), title: 't' }) });
    const pdf = new Uint8Array(await r.arrayBuffer());
    ok('도면 PDF 생성', r.ok && pdf[0] === 0x25 && pdf[1] === 0x50, `${pdf.length} 바이트`);
    document.querySelector('#d-close').click();
  } catch (e) { errs.push('시나리오 오류: ' + e.message); }
  ok('화면 오류 없음', errs.length === 0, errs.join(' | '));
  window.__gt = R;
})();
"""


def guitest(out_path: str) -> int:
    """실제 프로그램 창을 띄워 화면까지 점검한다(빌드 서버에서 사용)."""
    import json

    import webview
    port = _free_port()
    _serve(port)
    res = {"lines": ["FAIL 창이 열리지 않았습니다"], "code": 1}
    win = webview.create_window(APP, f"http://127.0.0.1:{port}/", js_api=Bridge(), width=1400, height=900)

    def run():
        try:
            t0 = time.time()
            while time.time() - t0 < 90:
                try:
                    if win.evaluate_js("!!(window.__datum && window.__datum.state && document.querySelector('canvas.main'))"):
                        break
                except Exception:
                    pass
                time.sleep(0.5)
            else:
                res["lines"] = ["FAIL 화면이 90초 안에 뜨지 않았습니다"]
                return
            win.evaluate_js(GUI_JS)
            t0 = time.time()
            while time.time() - t0 < 300:
                raw = win.evaluate_js("window.__gt ? JSON.stringify(window.__gt) : ''")
                if raw:
                    rows = json.loads(raw)
                    res["lines"] = [f"{a} {b} {c}".rstrip() for a, b, c in rows]
                    res["code"] = 0 if all(a.startswith("OK") for a, _, _ in rows) else 1
                    return
                time.sleep(1)
            res["lines"] = ["FAIL 점검이 5분 안에 끝나지 않았습니다"]
        except Exception:
            res["lines"] = ["FAIL " + traceback.format_exc()]
        finally:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("\n".join(res["lines"] + ["RESULT " + ("PASS" if res["code"] == 0 else "FAIL")]) + "\n")
            win.destroy()

    webview.start(run, gui="edgechromium" if sys.platform == "win32" else None, private_mode=True)
    return res["code"]


def main():
    _setup_stdio()
    here = os.path.dirname(os.path.abspath(sys.executable if getattr(sys, "frozen", False) else __file__))
    os.chdir(here)
    if "--selftest" in sys.argv:
        i = sys.argv.index("--selftest")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.path.join(_data_dir(), "selftest.txt")
        sys.exit(selftest(out))
    if "--guitest" in sys.argv:
        i = sys.argv.index("--guitest")
        out = sys.argv[i + 1] if len(sys.argv) > i + 1 else os.path.join(_data_dir(), "guitest.txt")
        sys.exit(guitest(out))

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
