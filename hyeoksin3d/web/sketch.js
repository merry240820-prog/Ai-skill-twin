// 혁신3D 스케치 — 평면 위 2D 그리기 → 돌출 추가 / 잘라내기 / 새 바디
// 좌표: 스케치 평면 mm(y 위쪽). 화면 = pan + (x·zoom, −y·zoom)

const KEY_TOOLS = { l: 'line', r: 'rect', c: 'circle', a: 'arc', s: 'select' };

export function createSketch(ctx) {
  const { post, toast, icon, fmt, onApply } = ctx;
  let host, svg, panel;
  let plane = null, ents = [], sel = null, tool = 'line', zoom = 4, pan = [0, 0];
  let pts = [], cursor = null, snapInfo = null, gridOn = true, showDims = true, uid = 1;
  let chainStart = null;
  let opts = { mode: 'boss', depth: 10, reverse: false, through: false, both: false };

  // ------------------------------------------------------------ 좌표
  const toScr = (p) => [pan[0] + p[0] * zoom, pan[1] - p[1] * zoom];
  const toSk = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left - pan[0]) / zoom, -(e.clientY - r.top - pan[1]) / zoom]; };
  const n = (x) => fmt(x, 3);
  const gridStep = () => [0.1, 0.5, 1, 2, 5, 10, 20, 50, 100, 200].find((s) => s * zoom >= 14) || 500;

  // ------------------------------------------------------------ 스냅
  function snapPoints() {
    const out = [[0, 0]];
    (plane?.reference.points || []).forEach((p) => out.push(p));
    ents.forEach((e) => {
      if (e.t === 'line') out.push(e.p.slice(0, 2), e.p.slice(2));
      if (e.t === 'rect') out.push([e.x, e.y], [e.x + e.w, e.y], [e.x + e.w, e.y + e.h], [e.x, e.y + e.h], [e.x + e.w / 2, e.y + e.h / 2]);
      if (e.t === 'circle') out.push(e.c);
      if (e.t === 'arc') { out.push(e.c); const [a, b] = arcEnds(e); out.push(a, b); }
    });
    pts.forEach((p) => out.push(p));
    return out;
  }
  function snap(q, base) {
    const tol = 9 / zoom;
    let best = null, bd = tol;
    for (const p of snapPoints()) {
      const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
      if (d < bd) { bd = d; best = p; }
    }
    if (best) { snapInfo = 'point'; return [...best]; }
    snapInfo = null;
    // 수평/수직 추정
    if (base) {
      const dx = q[0] - base[0], dy = q[1] - base[1];
      const ang = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
      if (Math.min(ang, 180 - ang) < 4) { q = [q[0], base[1]]; snapInfo = 'h'; }
      else if (Math.abs(ang - 90) < 4) { q = [base[0], q[1]]; snapInfo = 'v'; }
    }
    if (gridOn) {
      const s = gridStep();
      if (snapInfo !== 'v') q[0] = Math.round(q[0] / s) * s;
      if (snapInfo !== 'h') q[1] = Math.round(q[1] / s) * s;
    }
    return q;
  }
  function arcEnds(e) {
    const r = (a) => [e.c[0] + e.r * Math.cos(a * Math.PI / 180), e.c[1] + e.r * Math.sin(a * Math.PI / 180)];
    return [r(e.a0), r(e.a1)];
  }

  // ------------------------------------------------------------ 닫힌 윤곽 수(서버와 같은 규칙)
  function countLoops() {
    let k = ents.filter((e) => e.t === 'rect' || e.t === 'circle').length;
    const segs = ents.filter((e) => e.t === 'line' || e.t === 'arc').map((e) => (e.t === 'line' ? [e.p.slice(0, 2), e.p.slice(2)] : arcEnds(e)));
    const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`;
    const used = new Array(segs.length).fill(false);
    segs.forEach((s, i) => {
      if (used[i]) return;
      used[i] = true;
      const start = key(s[0]);
      let end = key(s[1]), grew = true;
      while (start !== end && grew) {
        grew = false;
        for (let j = 0; j < segs.length; j++) {
          if (used[j]) continue;
          const a = key(segs[j][0]), b = key(segs[j][1]);
          if (a === end || b === end) { used[j] = true; end = a === end ? b : a; grew = true; break; }
        }
      }
      if (start === end) k++;
    });
    return k;
  }

  // ------------------------------------------------------------ 그리기
  function dimLabels() {
    const out = [];
    if (!showDims) return out;
    ents.forEach((e) => {
      if (e.t === 'line') {
        const L = Math.hypot(e.p[2] - e.p[0], e.p[3] - e.p[1]);
        const m = toScr([(e.p[0] + e.p[2]) / 2, (e.p[1] + e.p[3]) / 2]);
        out.push({ id: e.id, k: 'len', x: m[0], y: m[1] - 8, s: n(L) });
      } else if (e.t === 'rect') {
        const b = toScr([e.x + e.w / 2, Math.min(e.y, e.y + e.h)]), r = toScr([Math.max(e.x, e.x + e.w), e.y + e.h / 2]);
        out.push({ id: e.id, k: 'w', x: b[0], y: b[1] + 16, s: n(Math.abs(e.w)) }, { id: e.id, k: 'h', x: r[0] + 22, y: r[1] + 4, s: n(Math.abs(e.h)) });
      } else if (e.t === 'circle') {
        const p = toScr([e.c[0] + e.r * 0.707, e.c[1] + e.r * 0.707]);
        out.push({ id: e.id, k: 'd', x: p[0] + 18, y: p[1] - 8, s: 'Ø' + n(e.r * 2) });
      } else if (e.t === 'arc') {
        const a = (e.a0 + ((e.a1 - e.a0 + 360) % 360) / 2) * Math.PI / 180;
        const p = toScr([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]);
        out.push({ id: e.id, k: 'r', x: p[0] + 14 * Math.cos(a), y: p[1] - 14 * Math.sin(a), s: 'R' + n(e.r) });
      }
    });
    return out;
  }

  function entSvg(e, cls) {
    if (e.t === 'line') { const a = toScr(e.p.slice(0, 2)), b = toScr(e.p.slice(2)); return `<line class="${cls}" data-id="${e.id}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"/>`; }
    if (e.t === 'rect') { const a = toScr([Math.min(e.x, e.x + e.w), Math.max(e.y, e.y + e.h)]); return `<rect class="${cls}" data-id="${e.id}" x="${a[0]}" y="${a[1]}" width="${Math.abs(e.w) * zoom}" height="${Math.abs(e.h) * zoom}"/>`; }
    if (e.t === 'circle') { const c = toScr(e.c); return `<circle class="${cls}" data-id="${e.id}" cx="${c[0]}" cy="${c[1]}" r="${e.r * zoom}"/>`; }
    if (e.t === 'arc') {
      const [a, b] = arcEnds(e).map(toScr);
      const ext = ((e.a1 - e.a0) % 360 + 360) % 360;
      return `<path class="${cls}" data-id="${e.id}" d="M${a[0]} ${a[1]}A${e.r * zoom} ${e.r * zoom} 0 ${ext > 180 ? 1 : 0} 0 ${b[0]} ${b[1]}"/>`;
    }
    return '';
  }

  function preview() {
    if (!cursor || !pts.length) return null;
    const a = pts[0], b = cursor;
    if (tool === 'line') return { t: 'line', p: [...pts.at(-1), ...b] };
    if (tool === 'rect') return { t: 'rect', x: a[0], y: a[1], w: b[0] - a[0], h: b[1] - a[1] };
    if (tool === 'circle') return { t: 'circle', c: a, r: Math.hypot(b[0] - a[0], b[1] - a[1]) };
    if (tool === 'arc') {
      if (pts.length === 1) return { t: 'line', p: [...a, ...b] };
      const r = Math.hypot(pts[1][0] - a[0], pts[1][1] - a[1]);
      return { t: 'arc', c: a, r, a0: Math.atan2(pts[1][1] - a[1], pts[1][0] - a[0]) * 180 / Math.PI, a1: Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI };
    }
    return null;
  }
  function previewText(p) {
    if (!p) return '';
    if (p.t === 'line') { const L = Math.hypot(p.p[2] - p.p[0], p.p[3] - p.p[1]); const ang = Math.atan2(p.p[3] - p.p[1], p.p[2] - p.p[0]) * 180 / Math.PI; return `${n(L)} mm · ${fmt(ang, 1)}°`; }
    if (p.t === 'rect') return `${n(Math.abs(p.w))} × ${n(Math.abs(p.h))}`;
    if (p.t === 'circle') return `Ø${n(p.r * 2)}`;
    if (p.t === 'arc') return `R${n(p.r)} · ${fmt(((p.a1 - p.a0) % 360 + 360) % 360, 1)}°`;
    return '';
  }

  function render() {
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const W = r.width, H = r.height;
    const out = [];
    // 격자
    const s = gridStep();
    const x0 = Math.floor(-pan[0] / zoom / s) * s, x1 = (W - pan[0]) / zoom;
    const y1 = pan[1] / zoom, y0 = -(H - pan[1]) / zoom;
    for (let x = x0; x <= x1; x += s) { const X = pan[0] + x * zoom; out.push(`<line class="${Math.abs(Math.round(x / s) % 5) === 0 ? 'g2' : 'g1'}" x1="${X}" y1="0" x2="${X}" y2="${H}"/>`); }
    for (let y = Math.floor(y0 / s) * s; y <= y1; y += s) { const Y = pan[1] - y * zoom; out.push(`<line class="${Math.abs(Math.round(y / s) % 5) === 0 ? 'g2' : 'g1'}" x1="0" y1="${Y}" x2="${W}" y2="${Y}"/>`); }
    const o = toScr([0, 0]);
    out.push(`<line class="ax-x" x1="${o[0]}" y1="${o[1]}" x2="${o[0] + 40}" y2="${o[1]}"/><line class="ax-y" x1="${o[0]}" y1="${o[1]}" x2="${o[0]}" y2="${o[1] - 40}"/><circle class="org" cx="${o[0]}" cy="${o[1]}" r="3"/>`);
    // 참조(면 윤곽)
    (plane?.reference.polys || []).forEach((p) => { const q = []; for (let k = 0; k < p.length; k += 2) q.push(toScr([p[k], p[k + 1]]).join(',')); out.push(`<polyline class="ref" points="${q.join(' ')}"/>`); });
    ents.forEach((e) => out.push(entSvg(e, e.id === sel ? 'ent sel' : 'ent')));
    const pv = preview();
    if (pv) out.push(entSvg(pv, 'ent pv'));
    pts.forEach((p) => { const q = toScr(p); out.push(`<circle class="pick" cx="${q[0]}" cy="${q[1]}" r="3"/>`); });
    if (cursor && tool !== 'select') {
      const q = toScr(cursor);
      out.push(`<circle class="${snapInfo === 'point' ? 'snap on' : 'snap'}" cx="${q[0]}" cy="${q[1]}" r="${snapInfo === 'point' ? 6 : 3}"/>`);
      if (snapInfo === 'h' || snapInfo === 'v') out.push(`<text class="infer" x="${q[0] + 10}" y="${q[1] + 18}">${snapInfo === 'h' ? '수평' : '수직'}</text>`);
      const t = previewText(pv);
      if (t) out.push(`<text class="live" x="${q[0] + 14}" y="${q[1] - 12}">${t}</text>`);
    }
    dimLabels().forEach((d) => out.push(`<text class="dim" data-id="${d.id}" data-k="${d.k}" x="${d.x}" y="${d.y}" text-anchor="middle">${d.s}</text>`));
    svg.innerHTML = out.join('');
    host.querySelector('#sk-loops').textContent = `닫힌 윤곽 ${countLoops()}개 · 요소 ${ents.length}개`;
  }

  // ------------------------------------------------------------ 입력
  function hitEnt(e) {
    const q = toSk(e), tol = 7 / zoom;
    let best = null, bd = tol;
    const dSeg = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1; const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L)); return Math.hypot(q[0] - a[0] - t * dx, q[1] - a[1] - t * dy); };
    ents.forEach((en) => {
      let d = Infinity;
      if (en.t === 'line') d = dSeg(en.p.slice(0, 2), en.p.slice(2));
      if (en.t === 'rect') { const c = [[en.x, en.y], [en.x + en.w, en.y], [en.x + en.w, en.y + en.h], [en.x, en.y + en.h]]; d = Math.min(...c.map((p, i) => dSeg(p, c[(i + 1) % 4]))); }
      if (en.t === 'circle' || en.t === 'arc') d = Math.abs(Math.hypot(q[0] - en.c[0], q[1] - en.c[1]) - en.r);
      if (d < bd) { bd = d; best = en; }
    });
    return best;
  }

  function add(e) { e.id = `e${uid++}`; ents.push(e); sel = e.id; updateProps(); }

  function onDown(e) {
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) { drag = { x: e.clientX, y: e.clientY, pan: [...pan] }; e.preventDefault(); return; }
    if (e.button !== 0) return;
    const dimEl = e.target.closest('text.dim');
    if (dimEl && tool === 'select') { editDim(dimEl.dataset.id, dimEl.dataset.k); return; }
    if (tool === 'select') { const h = hitEnt(e); sel = h?.id ?? null; updateProps(); render(); return; }
    const q = snap(toSk(e), pts.at(-1));
    if (tool === 'line') {
      if (!pts.length) { pts = [q]; chainStart = q; render(); return; }
      const last = pts.at(-1);
      if (Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-9) return;
      add({ t: 'line', p: [...last, ...q] });
      if (chainStart && Math.hypot(q[0] - chainStart[0], q[1] - chainStart[1]) < 1e-9) { pts = []; chainStart = null; toast('윤곽이 닫혔습니다'); }
      else pts = [q];
    } else if (tool === 'rect') {
      if (!pts.length) pts = [q];
      else { const a = pts[0]; if (Math.abs(q[0] - a[0]) > 1e-9 && Math.abs(q[1] - a[1]) > 1e-9) add({ t: 'rect', x: Math.min(a[0], q[0]), y: Math.min(a[1], q[1]), w: Math.abs(q[0] - a[0]), h: Math.abs(q[1] - a[1]) }); pts = []; }
    } else if (tool === 'circle') {
      if (!pts.length) pts = [q];
      else { const r = Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]); if (r > 1e-9) add({ t: 'circle', c: pts[0], r }); pts = []; }
    } else if (tool === 'arc') {
      if (pts.length < 2) { if (!pts.length || Math.hypot(q[0] - pts[0][0], q[1] - pts[0][1]) > 1e-9) pts.push(q); }
      else { const pv = preview(); if (pv.r > 1e-9) add(pv); pts = []; }
    }
    render();
  }
  let drag = null;
  function onMove(e) {
    if (drag) { pan = [drag.pan[0] + e.clientX - drag.x, drag.pan[1] + e.clientY - drag.y]; render(); return; }
    if (tool === 'select') return;
    let base = pts.at(-1);
    if (tool === 'arc' && pts.length === 2) {
      // 호 끝점은 반지름 위로
      const c = pts[0], r = Math.hypot(pts[1][0] - c[0], pts[1][1] - c[1]);
      const q = toSk(e); const a = Math.atan2(q[1] - c[1], q[0] - c[0]);
      cursor = [c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)];
      snapInfo = null;
      render();
      return;
    }
    if (tool === 'rect' || tool === 'circle') base = null;
    cursor = snap(toSk(e), base);
    render();
  }
  function onWheel(e) {
    e.preventDefault();
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
    const nz = Math.min(400, Math.max(0.05, zoom * Math.exp(-e.deltaY * 0.0015)));
    pan = [mx - (mx - pan[0]) * (nz / zoom), my - (my - pan[1]) * (nz / zoom)];
    zoom = nz;
    render();
  }

  function editDim(id, k) {
    const e = ents.find((x) => x.id === id);
    if (!e) return;
    const cur = { len: () => Math.hypot(e.p[2] - e.p[0], e.p[3] - e.p[1]), w: () => e.w, h: () => e.h, d: () => e.r * 2, r: () => e.r }[k]();
    const v = parseFloat(prompt({ len: '선 길이', w: '가로', h: '세로', d: '지름', r: '반지름' }[k] + ' (mm)', n(cur)));
    if (!Number.isFinite(v) || v <= 0) return;
    if (k === 'len') { const L = cur || 1; const old = e.p.slice(2); e.p[2] = e.p[0] + (e.p[2] - e.p[0]) * v / L; e.p[3] = e.p[1] + (e.p[3] - e.p[1]) * v / L; reconnect(e, old, e.p.slice(2)); }
    if (k === 'w') e.w = v;
    if (k === 'h') e.h = v;
    if (k === 'd') e.r = v / 2;
    if (k === 'r') e.r = v;
    sel = id; updateProps(); render();
  }
  // 선 길이를 바꾸면 그 끝점에 붙어 있던 다음 선의 시작점도 따라간다(윤곽 유지)
  function reconnect(e, from, to) {
    const same = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
    ents.forEach((o) => {
      if (o === e || o.t !== 'line') return;
      if (same(o.p.slice(0, 2), from)) { o.p[0] = to[0]; o.p[1] = to[1]; }
      if (same(o.p.slice(2), from)) { o.p[2] = to[0]; o.p[3] = to[1]; }
    });
  }

  // ------------------------------------------------------------ 패널
  function updateProps() {
    const box = host.querySelector('#sk-props');
    const e = ents.find((x) => x.id === sel);
    if (!e) { box.innerHTML = '<p class="hint">요소를 클릭하면 좌표·크기를 숫자로 고칠 수 있습니다. 치수 숫자를 클릭해도 됩니다.</p>'; return; }
    const f = (label, key, val) => `<div class="row"><label>${label}</label><div class="unit"><input data-k="${key}" type="number" step="any" value="${n(val)}"><span>mm</span></div></div>`;
    let html = '';
    if (e.t === 'line') html = f('시작 X', 'x1', e.p[0]) + f('시작 Y', 'y1', e.p[1]) + f('끝 X', 'x2', e.p[2]) + f('끝 Y', 'y2', e.p[3]);
    if (e.t === 'rect') html = f('X', 'x', e.x) + f('Y', 'y', e.y) + f('가로', 'w', e.w) + f('세로', 'h', e.h);
    if (e.t === 'circle') html = f('중심 X', 'cx', e.c[0]) + f('중심 Y', 'cy', e.c[1]) + f('지름', 'd', e.r * 2);
    if (e.t === 'arc') html = f('중심 X', 'cx', e.c[0]) + f('중심 Y', 'cy', e.c[1]) + f('반지름', 'r', e.r) + f('시작각(°)', 'a0', e.a0) + f('끝각(°)', 'a1', e.a1);
    box.innerHTML = `<div class="picks"><div class="pk">${icon('edge', 14)}<b>${{ line: '선', rect: '사각형', circle: '원', arc: '호' }[e.t]}</b></div></div>${html}<div class="btns"><button id="sk-del">${icon('trash', 16)}삭제</button></div>`;
    box.querySelectorAll('input').forEach((i) => (i.onchange = () => {
      const v = parseFloat(i.value);
      if (!Number.isFinite(v)) return;
      const k = i.dataset.k;
      if (e.t === 'line') {
        const end = k === 'x1' || k === 'y1' ? 0 : 2;
        const old = e.p.slice(end, end + 2);
        e.p[{ x1: 0, y1: 1, x2: 2, y2: 3 }[k]] = v;
        reconnect(e, old, e.p.slice(end, end + 2));
      }
      if (e.t === 'rect') e[k] = v;
      if (e.t === 'circle') { if (k === 'cx') e.c[0] = v; if (k === 'cy') e.c[1] = v; if (k === 'd') e.r = v / 2; }
      if (e.t === 'arc') { if (k === 'cx') e.c[0] = v; else if (k === 'cy') e.c[1] = v; else e[k] = v; }
      render();
    }));
    box.querySelector('#sk-del').onclick = () => { ents = ents.filter((x) => x.id !== e.id); sel = null; updateProps(); render(); };
  }

  function setTool(t) {
    tool = t; pts = []; chainStart = null; cursor = null;
    host.querySelectorAll('[data-sktool]').forEach((b) => b.classList.toggle('on', b.dataset.sktool === t));
    const hint = { select: '요소를 클릭해 고르고, 치수 숫자를 클릭해 값을 바꿉니다. Delete로 지웁니다.', line: '클릭할 때마다 선이 이어집니다. 시작점을 다시 클릭하면 닫히고, Esc로 끝냅니다.', rect: '두 모서리를 클릭하세요.', circle: '중심 → 반지름 위치를 클릭하세요.', arc: '중심 → 시작점 → 끝점(반시계 방향)을 클릭하세요.' }[t];
    host.querySelector('#sk-hint').textContent = hint;
    svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    render();
  }

  function fit() {
    const r = svg.getBoundingClientRect();
    const xs = [0], ys = [0];
    (plane?.reference.polys || []).forEach((p) => { for (let k = 0; k < p.length; k += 2) { xs.push(p[k]); ys.push(p[k + 1]); } });
    ents.forEach((e) => { if (e.t === 'line') { xs.push(e.p[0], e.p[2]); ys.push(e.p[1], e.p[3]); } if (e.t === 'rect') { xs.push(e.x, e.x + e.w); ys.push(e.y, e.y + e.h); } if (e.c) { xs.push(e.c[0] - e.r, e.c[0] + e.r); ys.push(e.c[1] - e.r, e.c[1] + e.r); } });
    const w = Math.max(...xs) - Math.min(...xs) || 100, h = Math.max(...ys) - Math.min(...ys) || 100;
    zoom = Math.min((r.width - 120) / w, (r.height - 120) / h);
    pan = [r.width / 2 - (Math.min(...xs) + w / 2) * zoom, r.height / 2 + (Math.min(...ys) + h / 2) * zoom];
    render();
  }

  function onKey(e) {
    if (!host || host.hidden) return;
    if (e.target.matches('input, select, textarea')) {
      if (e.key === 'Enter' && e.target.closest('#sketch')) { e.preventDefault(); e.target.blur(); apply(); }
      return;
    }
    const k = e.key.toLowerCase();
    e.stopPropagation();
    if (k === 'escape') { if (pts.length) { pts = []; chainStart = null; render(); } else if (tool !== 'select') setTool('select'); else close(); return; }
    if ((k === 'delete' || k === 'backspace') && sel) { ents = ents.filter((x) => x.id !== sel); sel = null; updateProps(); render(); return; }
    if (k === 'f') { fit(); return; }
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); ents.pop(); sel = null; updateProps(); render(); return; }
    if (k === 'enter') { apply(); return; }
    if (KEY_TOOLS[k] && !e.ctrlKey) setTool(KEY_TOOLS[k]);
  }

  function buildUI() {
    host = document.createElement('section');
    host.id = 'sketch';
    host.innerHTML = `
      <div class="d-canvas"><div class="d-toolbar">
        <button data-sktool="select" title="선택 (S)">${icon('select', 18)}<span>선택</span></button>
        <button data-sktool="line" title="선 (L)">${icon('edge', 18)}<span>선</span></button>
        <button data-sktool="rect" title="사각형 (R)">${icon('rect', 18)}<span>사각형</span></button>
        <button data-sktool="circle" title="원 (C)">${icon('circle', 18)}<span>원</span></button>
        <button data-sktool="arc" title="호 (A)">${icon('arc', 18)}<span>호</span></button>
        <i></i><button id="sk-grid" title="격자 스냅">${icon('edges', 18)}<span>격자</span></button>
        <button id="sk-dims" title="치수 표시">${icon('distance', 18)}<span>치수</span></button>
        <button id="sk-fit" title="맞춤 (F)">${icon('fit', 18)}</button>
      </div><svg id="sk-svg"></svg><p class="d-hint" id="sk-hint"></p></div>
      <aside class="d-panel">
        <div class="pane-head">${icon('sketch', 18)}<span>스케치</span><button class="ghost icon-btn small" id="sk-close" title="취소">${icon('close', 16)}</button></div>
        <div class="d-body">
          <p class="hint" id="sk-where"></p>
          <div id="sk-base" class="row"><label>기준면</label><select id="sk-plane"><option value="xy">XY (윗면)</option><option value="xz">XZ (정면)</option><option value="yz">YZ (우측면)</option></select></div>
          <p class="hint" id="sk-loops"></p>
          <div class="sect">선택한 요소</div><div id="sk-props"></div>
          <div class="sect">돌출</div>
          <div class="seg" id="sk-mode"><button data-v="boss">돌출 추가</button><button data-v="cut">잘라내기</button><button data-v="new">새 바디</button></div>
          <div class="row" style="margin-top:8px"><label>깊이</label><div class="unit"><input id="sk-depth" type="number" step="any" value="10"><span>mm</span></div></div>
          <div class="checks"><label><input type="checkbox" id="sk-rev"> 반대 방향</label><label><input type="checkbox" id="sk-both"> 양방향(중간면)</label><label><input type="checkbox" id="sk-thru"> 관통(컷)</label></div>
          <div class="btns"><button class="ok" id="sk-apply">${icon('check', 16)}적용 (Enter)</button><button id="sk-cancel">취소</button></div>
          <div class="err" id="sk-err"></div>
          <p class="hint">닫힌 윤곽 안의 윤곽은 구멍이 됩니다. 단축키: L 선 · R 사각형 · C 원 · A 호 · S 선택 · Ctrl+Z 되돌리기</p>
        </div>
      </aside>`;
    document.querySelector('main').appendChild(host);
    svg = host.querySelector('#sk-svg');
    panel = host.querySelector('.d-panel');
    svg.addEventListener('pointerdown', onDown);
    svg.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', () => { drag = null; });
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    svg.addEventListener('dblclick', () => { if (tool === 'line') { pts = []; chainStart = null; render(); } });
    window.addEventListener('keydown', onKey, true);
    new ResizeObserver(() => { if (!host.hidden) render(); }).observe(svg);
    host.querySelectorAll('[data-sktool]').forEach((b) => (b.onclick = () => setTool(b.dataset.sktool)));
    host.querySelector('#sk-grid').onclick = (e) => { gridOn = !gridOn; e.currentTarget.classList.toggle('on', gridOn); };
    host.querySelector('#sk-dims').onclick = (e) => { showDims = !showDims; e.currentTarget.classList.toggle('on', showDims); render(); };
    host.querySelector('#sk-fit').onclick = fit;
    host.querySelector('#sk-close').onclick = close;
    host.querySelector('#sk-cancel').onclick = close;
    host.querySelector('#sk-apply').onclick = apply;
    host.querySelector('#sk-plane').onchange = async (e) => { plane = await post('/api/sketch/plane', { base: e.target.value }); fit(); };
    host.querySelectorAll('#sk-mode button').forEach((b) => (b.onclick = () => setMode(b.dataset.v)));
  }
  function setMode(m) {
    opts.mode = m;
    host.querySelectorAll('#sk-mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
    host.querySelector('#sk-thru').disabled = m !== 'cut';
  }

  async function apply() {
    const err = host.querySelector('#sk-err');
    err.textContent = '';
    try {
      if (!ents.length) throw new Error('스케치가 비어 있습니다');
      const body = opts.mode === 'new' ? null : plane.body ?? null;
      if (body == null && opts.mode !== 'new') throw new Error('기준면 스케치는 새 바디로만 만들 수 있습니다');
      await onApply({
        op: 'sketch_extrude', body,
        params: { plane, entities: ents.map(({ id, ...e }) => e), depth: parseFloat(host.querySelector('#sk-depth').value), mode: opts.mode,
          reverse: host.querySelector('#sk-rev').checked, both: host.querySelector('#sk-both').checked, through: host.querySelector('#sk-thru').checked },
      });
      close();
    } catch (e) { err.textContent = e.message; toast(e.message, true); }
  }

  async function open(src) {
    if (!host) buildUI();
    plane = await post('/api/sketch/plane', src);
    ents = []; sel = null; pts = [];
    host.hidden = false;
    document.body.classList.add('drawing-mode');
    const onFace = plane.body != null;
    host.querySelector('#sk-base').hidden = onFace;
    host.querySelector('#sk-where').textContent = onFace ? '선택한 면 위의 스케치입니다(회색 선 = 면 윤곽, 빨강·초록 = 원점 X·Y).' : '기준면 위의 스케치입니다. 결과는 새 바디가 됩니다.';
    setMode(onFace ? 'boss' : 'new');
    host.querySelector('#sk-mode [data-v=boss]').disabled = !onFace;
    host.querySelector('#sk-mode [data-v=cut]').disabled = !onFace;
    host.querySelector('#sk-grid').classList.toggle('on', gridOn);
    host.querySelector('#sk-dims').classList.toggle('on', showDims);
    updateProps();
    setTool('rect');
    requestAnimationFrame(fit);
  }
  function close() {
    if (!host) return;
    host.hidden = true;
    document.body.classList.remove('drawing-mode');
    ctx.onClose?.();
  }
  window.__sk = () => ({ plane, ents });
  return { open, close, isOpen: () => host && !host.hidden };
}
