// Datum 도면 편집기 — 투상도 + 치수 + 표제란 → PDF / DXF / SVG
// 좌표: 용지 mm, y 아래쪽(SVG와 같음). 뷰 엔티티는 모델 mm(y 위쪽)이며 (ox + x·s, oy − y·s)로 용지에 놓인다.

const TEXT_H = 3.5; // 치수 문자 높이(mm)
const ARROW = [3, 0.9]; // 화살표 길이, 반폭(mm)
const EXT_GAP = 1, EXT_OVER = 2;
const STYLE = {
  thick: 'stroke:var(--d-ink);stroke-width:0.5;fill:none',
  thin: 'stroke:var(--d-ink);stroke-width:0.25;fill:none',
  hidden: 'stroke:var(--d-ink);stroke-width:0.25;fill:none;stroke-dasharray:3 1.5',
  center: 'stroke:var(--d-center);stroke-width:0.18;fill:none;stroke-dasharray:8 1.5 1 1.5',
  dim: 'stroke:var(--d-dim);stroke-width:0.25;fill:none',
  border: 'stroke:var(--d-ink);stroke-width:0.7;fill:none',
};
const TITLE_FIELDS = [
  ['part', '도면명'], ['number', '도번'], ['material', '재질'], ['author', '작성'], ['company', '소속 / 비고'],
];

export function createDrawing(ctx) {
  const { api, post, toast, icon, fmt, saveBlob, getDocName, onClose } = ctx;
  let D = null; // { sheet, scale, views, dims, title, notes }
  let host = null, svg = null, panel = null;
  let zoom = 1, pan = [0, 0];
  let tool = 'select';
  let sel = null; // 선택된 치수/노트 id
  let pending = []; // 선형 치수 작성 중 고른 점 [{view, p}]
  let hoverSnap = null;
  let drag = null;
  let opts = { sheet: 'A3', scale: null, views: ['front', 'top', 'right', 'iso'], hidden: true };
  let uid = 1;

  // ------------------------------------------------------------ 좌표 변환
  const V = (id) => D.views.find((v) => v.id === id);
  const toSheet = (v, p) => [v.ox + p[0] * v.scale, v.oy - p[1] * v.scale];
  const fromSheet = (v, q) => [(q[0] - v.ox) / v.scale, (v.oy - q[1]) / v.scale];
  const num = (x) => fmt(x, 2);

  // ------------------------------------------------------------ 기본 요소 만들기(화면·PDF·DXF가 모두 이것을 쓴다)
  function prims() {
    const out = [];
    const { w: W, h: H, margin: M, title_w: TW, title_h: TH } = D.sheet;
    // 윤곽선
    out.push({ t: 'poly', p: [M, M, W - M, M, W - M, H - M, M, H - M, M, M], s: 'border' });
    // 뷰
    D.views.forEach((v) => {
      const s = v.scale;
      const emit = (e, st) => {
        if (e.t === 'line') out.push({ t: 'line', p: [...toSheet(v, e.p.slice(0, 2)), ...toSheet(v, e.p.slice(2))], s: st, view: v.id });
        else if (e.t === 'circle') out.push({ t: 'circle', c: toSheet(v, e.c), r: e.r * s, s: st, view: v.id });
        else if (e.t === 'arc') out.push({ t: 'arc', c: toSheet(v, e.c), r: e.r * s, a0: e.a0, a1: e.a1, s: st, view: v.id });
        else if (e.t === 'poly') { const p = []; for (let k = 0; k < e.p.length; k += 2) p.push(...toSheet(v, [e.p[k], e.p[k + 1]])); out.push({ t: 'poly', p, s: st, view: v.id }); }
      };
      if (D.hidden !== false) v.hidden.forEach((e) => emit(e, 'hidden'));
      v.visible.forEach((e) => emit(e, 'thick'));
      // 원의 중심선
      if (v.id !== 'iso') v.visible.filter((e) => e.t === 'circle').forEach((e) => {
        const [cx, cy] = toSheet(v, e.c), r = e.r * s + 2;
        out.push({ t: 'line', p: [cx - r, cy, cx + r, cy], s: 'center' }, { t: 'line', p: [cx, cy - r, cx, cy + r], s: 'center' });
      });
      if (v.id === 'iso') {
        const b = v.bbox;
        const [lx, ly] = toSheet(v, [(b[0] + b[2]) / 2, b[1]]);
        out.push({ t: 'text', x: lx, y: ly + 7, str: v.name, h: 3, a: 'middle', s: 'thin' });
      }
    });
    // 치수
    D.dims.forEach((d) => dimPrims(d).forEach((p) => out.push({ ...p, dim: d.id })));
    (D.notes || []).forEach((n) => out.push({ t: 'text', x: n.x, y: n.y, str: n.text, h: n.h || 3.5, a: 'start', s: 'thin', note: n.id }));
    // 표제란
    titleBlock(out, W - M - TW, H - M - TH, TW, TH);
    return out;
  }

  function scaleText(s) {
    const best = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100]].find(([a, b]) => Math.abs(a / b - s) < 1e-6);
    return best ? `${best[0]}:${best[1]}` : `1:${fmt(1 / s, 2)}`;
  }

  function titleBlock(out, x, y, w, h) {
    const T = D.title;
    const L = (x1, y1, x2, y2, s = 'thin') => out.push({ t: 'line', p: [x1, y1, x2, y2], s });
    out.push({ t: 'poly', p: [x, y, x + w, y, x + w, y + h, x, y + h, x, y], s: 'border' });
    const rows = [y + 11, y + 22, y + 33];
    rows.forEach((ry) => L(x, ry, x + w, ry));
    const c1 = x + 24, c2 = x + 90, c3 = x + 114;
    L(c1, y, c1, y + h); L(c2, y + 11, c2, y + h); L(c3, y + 11, c3, y + h);
    const label = (tx, ty, s) => out.push({ t: 'text', x: tx, y: ty, str: s, h: 2.5, a: 'start', s: 'thin' });
    const value = (tx, ty, s, hh = 3.5) => out.push({ t: 'text', x: tx, y: ty, str: s || '', h: hh, a: 'start', s: 'thin' });
    label(x + 2, y + 7, '도면명'); value(c1 + 3, y + 8, T.part, 4.5);
    label(x + 2, y + 18, '도번'); value(c1 + 3, y + 18.5, T.number);
    label(c2 + 2, y + 18, '척도'); value(c3 + 3, y + 18.5, scaleText(D.scale[0] / D.scale[1]));
    label(x + 2, y + 29, '재질'); value(c1 + 3, y + 29.5, T.material);
    label(c2 + 2, y + 29, '투상법'); value(c3 + 3, y + 29.5, '3각법');
    label(x + 2, y + 40, '작성'); value(c1 + 3, y + 40.5, `${T.author || ''}  ${T.date || ''}`);
    label(c2 + 2, y + 40, '단위'); value(c3 + 3, y + 40.5, 'mm');
    // 3각법 기호(원뿔대)
    const sx = x + w - 34, sy = y + 22.5;
    out.push({ t: 'poly', p: [sx, sy - 3, sx + 9, sy - 5, sx + 9, sy + 5, sx, sy + 3, sx, sy - 3], s: 'thin' });
    out.push({ t: 'circle', c: [sx + 20, sy], r: 5, s: 'thin' }, { t: 'circle', c: [sx + 20, sy], r: 3, s: 'thin' });
    value(c3 + 3, y + 8, T.company, 3);
    out.push({ t: 'text', x: x + w - 2, y: y + h + 4.5, str: 'Datum', h: 2.2, a: 'end', s: 'thin' });
  }

  function arrow(tip, dir) { // dir: 화살표가 가리키는 방향(단위벡터)
    const [l, wdt] = ARROW;
    const bx = tip[0] - dir[0] * l, by = tip[1] - dir[1] * l;
    return { t: 'poly', p: [tip[0], tip[1], bx - dir[1] * wdt, by + dir[0] * wdt, bx + dir[1] * wdt, by - dir[0] * wdt, tip[0], tip[1]], s: 'dim', fill: true };
  }

  function dimValue(d) {
    if (d.type === 'dia') return d.r * 2;
    if (d.type === 'rad') return d.r;
    if (d.type === 'h') return Math.abs(d.p2[0] - d.p1[0]);
    if (d.type === 'v') return Math.abs(d.p2[1] - d.p1[1]);
    return Math.hypot(d.p2[0] - d.p1[0], d.p2[1] - d.p1[1]);
  }
  function dimText(d) {
    const v = num(dimValue(d));
    let s = d.type === 'dia' ? `Ø${v}` : d.type === 'rad' ? `R${v}` : v;
    if (d.count > 1) s = `${d.count}×${s}`;
    if (d.text) s = d.text.replace('<>', s);
    return s;
  }

  function dimPrims(d) {
    const v = V(d.view);
    if (!v) return [];
    const out = [];
    const txt = dimText(d);
    const tw = txt.length * TEXT_H * 0.62;
    if (d.type === 'dia' || d.type === 'rad') {
      const a = (d.angle * Math.PI) / 180;
      const u = [Math.cos(a), -Math.sin(a)]; // 용지 좌표(y 아래)
      const c = toSheet(v, d.c);
      const R = d.r * v.scale;
      const tip = [c[0] + u[0] * R, c[1] + u[1] * R];
      const elbow = [c[0] + u[0] * (R + (d.len ?? 9)), c[1] + u[1] * (R + (d.len ?? 9))];
      const sgn = u[0] >= 0 ? 1 : -1;
      const end = [elbow[0] + sgn * (tw + 2), elbow[1]];
      out.push({ t: 'line', p: [...tip, ...elbow], s: 'dim' }, { t: 'line', p: [...elbow, ...end], s: 'dim' }, arrow(tip, [-u[0], -u[1]]));
      out.push({ t: 'text', x: (elbow[0] + end[0]) / 2, y: elbow[1] - 1, str: txt, h: TEXT_H, a: 'middle', s: 'dim' });
      return out;
    }
    const P1 = toSheet(v, d.p1), P2 = toSheet(v, d.p2);
    let A, B, n; // 치수선 양 끝, 치수선 방향
    if (d.type === 'h') {
      const y = P1[1] - d.offset;
      A = [P1[0], y]; B = [P2[0], y]; n = [1, 0];
      const ext = (P) => { const s = Math.sign(y - P[1]) || 1; out.push({ t: 'line', p: [P[0], P[1] + s * EXT_GAP, P[0], y + s * EXT_OVER], s: 'dim' }); };
      ext(P1); ext(P2);
    } else if (d.type === 'v') {
      const x = P1[0] + d.offset;
      A = [x, P1[1]]; B = [x, P2[1]]; n = [0, 1];
      const ext = (P) => { const s = Math.sign(x - P[0]) || 1; out.push({ t: 'line', p: [P[0] + s * EXT_GAP, P[1], x + s * EXT_OVER, P[1]], s: 'dim' }); };
      ext(P1); ext(P2);
    } else { // aligned
      const L = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) || 1;
      const t = [(P2[0] - P1[0]) / L, (P2[1] - P1[1]) / L], p = [t[1], -t[0]];
      A = [P1[0] + p[0] * d.offset, P1[1] + p[1] * d.offset]; B = [P2[0] + p[0] * d.offset, P2[1] + p[1] * d.offset]; n = t;
      [[P1, A], [P2, B]].forEach(([P, Q]) => out.push({ t: 'line', p: [P[0] + p[0] * EXT_GAP * Math.sign(d.offset), P[1] + p[1] * EXT_GAP * Math.sign(d.offset), Q[0] + p[0] * EXT_OVER * Math.sign(d.offset), Q[1] + p[1] * EXT_OVER * Math.sign(d.offset)], s: 'dim' }));
    }
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
    const dir = len ? [(B[0] - A[0]) / len, (B[1] - A[1]) / len] : n;
    if (len > ARROW[0] * 2 + 1) {
      out.push({ t: 'line', p: [...A, ...B], s: 'dim' }, arrow(A, [-dir[0], -dir[1]]), arrow(B, dir));
    } else { // 좁으면 화살표를 바깥으로
      out.push({ t: 'line', p: [A[0] - dir[0] * 6, A[1] - dir[1] * 6, B[0] + dir[0] * 6, B[1] + dir[1] * 6], s: 'dim' }, arrow(A, dir), arrow(B, [-dir[0], -dir[1]]));
    }
    let rot = (Math.atan2(dir[1], dir[0]) * 180) / Math.PI;
    if (rot > 90.01 || rot < -89.99) rot += 180;
    const mid = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
    // 문자는 치수선 위(읽는 방향 기준)에
    const up = [Math.sin((rot * Math.PI) / 180), -Math.cos((rot * Math.PI) / 180)];
    out.push({ t: 'text', x: mid[0] + up[0] * 1, y: mid[1] + up[1] * 1, str: txt, h: TEXT_H, a: 'middle', rot, s: 'dim' });
    return out;
  }

  // ------------------------------------------------------------ SVG
  function svgOf(list, interactive = true) {
    const parts = [];
    let cur = null;
    const open = (key) => { if (cur !== key) { if (cur !== null) parts.push('</g>'); parts.push(key ? `<g class="dimg${key === sel ? ' sel' : ''}" data-id="${key}">` : '<g>'); cur = key; } };
    for (const p of list) {
      open(interactive ? (p.dim || p.note || '') : '');
      const st = STYLE[p.s] || STYLE.thin;
      if (p.t === 'line') parts.push(`<line x1="${p.p[0]}" y1="${p.p[1]}" x2="${p.p[2]}" y2="${p.p[3]}" style="${st}"/>`);
      else if (p.t === 'poly') {
        const pts = []; for (let k = 0; k < p.p.length; k += 2) pts.push(`${p.p[k]},${p.p[k + 1]}`);
        parts.push(p.fill ? `<polygon points="${pts.join(' ')}" style="fill:var(--d-dim);stroke:none"/>` : `<polyline points="${pts.join(' ')}" style="${st}"/>`);
      } else if (p.t === 'circle') parts.push(`<circle cx="${p.c[0]}" cy="${p.c[1]}" r="${p.r}" style="${st}"/>`);
      else if (p.t === 'arc') {
        const a0 = (p.a0 * Math.PI) / 180, a1 = (p.a1 * Math.PI) / 180;
        const ext = (((p.a1 - p.a0) % 360) + 360) % 360 || 360;
        const x0 = p.c[0] + p.r * Math.cos(a0), y0 = p.c[1] - p.r * Math.sin(a0);
        const x1 = p.c[0] + p.r * Math.cos(a1), y1 = p.c[1] - p.r * Math.sin(a1);
        parts.push(`<path d="M${x0} ${y0}A${p.r} ${p.r} 0 ${ext > 180 ? 1 : 0} 0 ${x1} ${y1}" style="${st}"/>`);
      } else if (p.t === 'text') {
        const esc = String(p.str).replace(/&/g, '&amp;').replace(/</g, '&lt;');
        const fill = p.s === 'dim' ? 'var(--d-dim)' : 'var(--d-ink)';
        parts.push(`<text x="${p.x}" y="${p.y}" font-size="${p.h * 1.25}" text-anchor="${p.a || 'middle'}" fill="${fill}" ${p.rot ? `transform="rotate(${p.rot} ${p.x} ${p.y})"` : ''}>${esc}</text>`);
      }
    }
    if (cur !== null) parts.push('</g>');
    return parts.join('');
  }

  function render() {
    if (!D) return;
    const { w, h } = D.sheet;
    const overlay = [];
    if (hoverSnap) overlay.push(`<circle cx="${hoverSnap.q[0]}" cy="${hoverSnap.q[1]}" r="1.4" class="snap"/>`);
    pending.forEach((pp) => { const q = toSheet(V(pp.view), pp.p); overlay.push(`<circle cx="${q[0]}" cy="${q[1]}" r="1.4" class="snap picked"/>`); });
    if (preview) overlay.push(svgOf(dimPrims(preview), false).replace(/var\(--d-dim\)/g, 'var(--accent)'));
    svg.innerHTML = `<g transform="translate(${pan[0]} ${pan[1]}) scale(${zoom})"><rect x="0" y="0" width="${w}" height="${h}" class="paper"/>${svgOf(prims())}<g class="ov">${overlay.join('')}</g></g>`;
  }
  let preview = null;

  function fit() {
    const r = svg.getBoundingClientRect();
    const { w, h } = D.sheet;
    zoom = Math.min((r.width - 40) / w, (r.height - 40) / h);
    pan = [(r.width - w * zoom) / 2, (r.height - h * zoom) / 2];
    render();
  }

  // ------------------------------------------------------------ 입력
  const toPaper = (e) => { const r = svg.getBoundingClientRect(); return [(e.clientX - r.left - pan[0]) / zoom, (e.clientY - r.top - pan[1]) / zoom]; };

  function nearestSnap(q, onlyView = null) {
    let best = null, bd = 3.5 / Math.max(zoom / 3, 0.6);
    D.views.forEach((v) => {
      if (v.id === 'iso' || (onlyView && v.id !== onlyView)) return;
      v.snaps.forEach((p) => {
        const s = toSheet(v, p);
        const d = Math.hypot(s[0] - q[0], s[1] - q[1]);
        if (d < bd) { bd = d; best = { view: v.id, p, q: s }; }
      });
    });
    return best;
  }
  function nearestCircle(q) {
    let best = null, bd = 2.5;
    D.views.forEach((v) => {
      if (v.id === 'iso') return;
      v.visible.forEach((e) => {
        if (e.t !== 'circle' && e.t !== 'arc') return;
        const c = toSheet(v, e.c);
        const d = Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - e.r * v.scale);
        if (d < bd) { bd = d; best = { view: v.id, e }; }
      });
    });
    return best;
  }

  function linearFromMouse(a, b, q) {
    const v = V(a.view);
    const P1 = toSheet(v, a.p), P2 = toSheet(v, b.p);
    const mx = (P1[0] + P2[0]) / 2, my = (P1[1] + P2[1]) / 2;
    const dx = Math.abs(P2[0] - P1[0]), dy = Math.abs(P2[1] - P1[1]);
    // 솔리드웍스 스마트 치수처럼: 마우스를 위·아래로 빼면 수평, 좌·우로 빼면 수직 치수
    const horizontal = dy < 1e-6 ? true : dx < 1e-6 ? false : Math.abs(q[1] - my) > Math.abs(q[0] - mx);
    if (horizontal) return { view: a.view, type: 'h', p1: a.p, p2: b.p, offset: P1[1] - q[1] };
    return { view: a.view, type: 'v', p1: a.p, p2: b.p, offset: q[0] - P1[0] };
  }

  function onMove(e) {
    const q = toPaper(e);
    if (drag) {
      if (drag.pan) { pan = [drag.pan[0] + e.clientX - drag.x, drag.pan[1] + e.clientY - drag.y]; render(); return; }
      const d = D.dims.find((x) => x.id === drag.id);
      if (d) {
        const v = V(d.view);
        if (d.type === 'h') d.offset = toSheet(v, d.p1)[1] - q[1];
        else if (d.type === 'v') d.offset = q[0] - toSheet(v, d.p1)[0];
        else if (d.type === 'aligned') {
          const P1 = toSheet(v, d.p1), P2 = toSheet(v, d.p2), L = Math.hypot(P2[0] - P1[0], P2[1] - P1[1]) || 1;
          d.offset = ((q[0] - P1[0]) * (P2[1] - P1[1]) / L) - ((q[1] - P1[1]) * (P2[0] - P1[0]) / L);
        } else {
          const c = toSheet(v, d.c);
          d.angle = (Math.atan2(-(q[1] - c[1]), q[0] - c[0]) * 180) / Math.PI;
          d.len = Math.max(3, Math.hypot(q[0] - c[0], q[1] - c[1]) - d.r * v.scale);
        }
      }
      const n = (D.notes || []).find((x) => x.id === drag.id);
      if (n) { n.x = q[0] - drag.dx; n.y = q[1] - drag.dy; }
      render();
      return;
    }
    if (tool === 'linear') {
      hoverSnap = nearestSnap(q, pending[0]?.view);
      preview = pending.length === 2 ? linearFromMouse(pending[0], pending[1], q) : null;
      render();
    } else if (tool === 'radial') {
      const c = nearestCircle(q);
      hoverSnap = c ? { q: toSheet(V(c.view), c.e.c) } : null;
      render();
    }
  }

  function onDown(e) {
    if (e.button === 1 || e.button === 2 || (e.button === 0 && e.altKey)) {
      drag = { pan: [...pan], x: e.clientX, y: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    const q = toPaper(e);
    if (tool === 'select') {
      const g = e.target.closest('.dimg');
      sel = g ? g.dataset.id : null;
      if (sel) {
        const n = (D.notes || []).find((x) => x.id === sel);
        drag = { id: sel, dx: n ? q[0] - n.x : 0, dy: n ? q[1] - n.y : 0 };
      }
      render();
      updatePanel();
      return;
    }
    if (tool === 'linear') {
      if (pending.length === 2) {
        const d = linearFromMouse(pending[0], pending[1], q);
        if (dimValue(d) > 1e-9) { d.id = `u${uid++}`; D.dims.push(d); sel = d.id; }
        pending = []; preview = null; render(); updatePanel();
        return;
      }
      const s = nearestSnap(q, pending[0]?.view);
      if (!s) { toast('선의 끝점이나 원 중심을 클릭하세요(주황 표시가 뜨는 곳)', true); return; }
      if (pending.length === 1 && Math.hypot(s.p[0] - pending[0].p[0], s.p[1] - pending[0].p[1]) < 1e-6) return;
      pending.push(s);
      render();
      return;
    }
    if (tool === 'radial') {
      const c = nearestCircle(q);
      if (!c) { toast('원이나 호의 테두리를 클릭하세요', true); return; }
      const cs = toSheet(V(c.view), c.e.c);
      const d = { id: `u${uid++}`, view: c.view, type: c.e.t === 'circle' ? 'dia' : 'rad', c: c.e.c, r: c.e.r, angle: (Math.atan2(-(q[1] - cs[1]), q[0] - cs[0]) * 180) / Math.PI, count: 1 };
      D.dims.push(d); sel = d.id; render(); updatePanel();
      return;
    }
    if (tool === 'note') {
      const text = prompt('주기(노트) 내용', '일반 공차: KS B ISO 2768-m');
      if (text) { D.notes.push({ id: `n${uid++}`, x: q[0], y: q[1], text }); render(); }
      setTool('select');
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    const f = Math.exp(-e.deltaY * 0.0015);
    const nz = Math.min(40, Math.max(0.3, zoom * f));
    pan = [mx - (mx - pan[0]) * (nz / zoom), my - (my - pan[1]) * (nz / zoom)];
    zoom = nz;
    render();
  }

  function onDbl(e) {
    const g = e.target.closest('.dimg');
    if (!g) return;
    const d = D.dims.find((x) => x.id === g.dataset.id);
    if (d) {
      const t = prompt('치수 문자 — <> 자리에 측정값이 들어갑니다 (예: <> ±0.1, (<>), <> H7)', d.text || '<>');
      if (t != null) { d.text = t.trim() === '<>' ? '' : t; render(); }
      return;
    }
    const n = (D.notes || []).find((x) => x.id === g.dataset.id);
    if (n) { const t = prompt('주기(노트) 내용', n.text); if (t) { n.text = t; render(); } }
  }

  function onKey(e) {
    if (!host || host.hidden || e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if ((k === 'delete' || k === 'backspace') && sel) { D.dims = D.dims.filter((d) => d.id !== sel); D.notes = D.notes.filter((n) => n.id !== sel); sel = null; render(); updatePanel(); e.preventDefault(); }
    else if (k === 'escape') { if (pending.length || tool !== 'select') { pending = []; preview = null; setTool('select'); } else if (sel) { sel = null; render(); updatePanel(); } }
    else if (k === 'f') fit();
    else if (k === 'd') setTool('linear');
    else if ((e.ctrlKey || e.metaKey) && k === 'p') { e.preventDefault(); exportAs('pdf'); }
    else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); exportAs('pdf'); }
    e.stopPropagation();
  }

  // ------------------------------------------------------------ 패널
  function setTool(t) {
    tool = t; pending = []; preview = null; hoverSnap = null;
    host.querySelectorAll('[data-dtool]').forEach((b) => b.classList.toggle('on', b.dataset.dtool === t));
    svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    const hint = { select: '치수를 끌어 위치를 옮기고, 더블클릭으로 문자(공차 등)를 고칩니다. Delete로 지웁니다.',
      linear: '두 점(선 끝점·원 중심)을 차례로 클릭 → 마우스를 위·아래로 빼면 수평, 좌·우로 빼면 수직 치수 → 클릭해서 놓기', radial: '원이나 호의 테두리를 클릭하면 지름(Ø)·반지름(R) 치수가 붙습니다.', note: '주기를 넣을 곳을 클릭하세요.' }[t];
    host.querySelector('#d-hint').textContent = hint;
    render();
  }

  function updatePanel() {
    const box = panel.querySelector('#d-sel');
    const d = D.dims.find((x) => x.id === sel);
    box.innerHTML = d ? `<div class="picks"><div class="pk">${icon('distance', 14)}<b>${dimText(d)}</b><span style="margin-left:auto;color:var(--ink-3)">${{ h: '수평', v: '수직', aligned: '평행', dia: '지름', rad: '반지름' }[d.type]}</span></div></div>` : '';
  }

  function buildUI() {
    host = document.createElement('section');
    host.id = 'drawing';
    host.innerHTML = `
      <div class="d-canvas"><div class="d-toolbar">
        <button data-dtool="select" title="선택·이동 (Esc)">${icon('select', 18)}<span>선택</span></button>
        <button data-dtool="linear" title="스마트 치수 (D)">${icon('distance', 18)}<span>치수</span></button>
        <button data-dtool="radial" title="지름·반지름">${icon('diameter', 18)}<span>Ø / R</span></button>
        <button data-dtool="note" title="주기">${icon('note', 18)}<span>주기</span></button>
        <i></i><button id="d-fit" title="용지 맞춤 (F)">${icon('fit', 18)}</button>
      </div><svg id="d-svg" xmlns="http://www.w3.org/2000/svg"></svg><p id="d-hint" class="d-hint"></p></div>
      <aside class="d-panel">
        <div class="pane-head">${icon('drawing', 18)}<span>도면</span><button class="ghost icon-btn small" id="d-close" title="3D로 돌아가기">${icon('close', 16)}</button></div>
        <div class="d-body">
          <div class="sect">대상</div>
          <div class="row"><label>부품</label><select id="d-target"></select></div>
          <div class="sect">용지 · 척도</div>
          <div class="row"><label>용지</label><select id="d-sheet">${['A4', 'A3', 'A2', 'A1'].map((s) => `<option>${s}</option>`).join('')}</select></div>
          <div class="row"><label>척도</label><select id="d-scale"><option value="">자동</option>${['10:1', '5:1', '2:1', '1:1', '1:2', '1:5', '1:10', '1:20', '1:50'].map((s) => `<option>${s}</option>`).join('')}</select></div>
          <div class="sect">투상도 (3각법)</div>
          <div class="checks">${[['front', '정면도'], ['top', '평면도'], ['right', '우측면도'], ['iso', '등각도']].map(([k, n]) => `<label><input type="checkbox" data-view="${k}" ${opts.views.includes(k) ? 'checked' : ''}> ${n}</label>`).join('')}
            <label><input type="checkbox" id="d-hidden" ${opts.hidden ? 'checked' : ''}> 숨은선</label></div>
          <div class="btns" style="margin-top:8px"><button id="d-regen">${icon('rebuild', 16)}다시 배치</button><button id="d-auto">${icon('distance', 16)}자동 치수</button></div>
          <div class="sect">표제란</div>
          ${TITLE_FIELDS.map(([k, n]) => `<div class="row"><label>${n}</label><input data-title="${k}"></div>`).join('')}
          <div class="row"><label>날짜</label><input data-title="date"></div>
          <div class="sect">선택</div><div id="d-sel"><p class="hint">치수를 클릭하면 여기에 나옵니다.</p></div>
          <div class="sect">내보내기</div>
          <div class="btns"><button class="ok" id="d-pdf">${icon('save', 16)}PDF</button><button id="d-dxf">${icon('stl', 16)}DXF</button><button id="d-svgx">SVG</button></div>
          <p class="hint">PDF는 인쇄용, DXF는 AutoCAD 등에서 열 수 있습니다(레이어: 외형선·숨은선·중심선·치수·문자).</p>
        </div>
      </aside>`;
    document.querySelector('main').appendChild(host);
    host.querySelector('#d-sheet').value = opts.sheet;
    svg = host.querySelector('#d-svg');
    panel = host.querySelector('.d-panel');
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerdown', onDown);
    window.addEventListener('pointerup', () => { drag = null; });
    svg.addEventListener('wheel', onWheel, { passive: false });
    svg.addEventListener('dblclick', onDbl);
    svg.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', onKey, true);
    new ResizeObserver(() => { if (D && !host.hidden) render(); }).observe(svg);
    host.querySelectorAll('[data-dtool]').forEach((b) => (b.onclick = () => setTool(b.dataset.dtool)));
    host.querySelector('#d-fit').onclick = fit;
    host.querySelector('#d-close').onclick = close;
    host.querySelector('#d-regen').onclick = () => regenerate(false);
    host.querySelector('#d-auto').onclick = () => regenerate(true);
    host.querySelector('#d-target').onchange = () => { D && (D.title.part = ''); regenerate(true).then(() => { D.title.part = D.part; host.querySelector('[data-title=part]').value = D.part; render(); }); };
    host.querySelector('#d-pdf').onclick = () => exportAs('pdf');
    host.querySelector('#d-dxf').onclick = () => exportAs('dxf');
    host.querySelector('#d-svgx').onclick = () => exportAs('svg');
    host.querySelectorAll('[data-title]').forEach((i) => (i.oninput = () => { D.title[i.dataset.title] = i.value; render(); }));
  }

  // ------------------------------------------------------------ 만들기 · 내보내기
  function readOpts() {
    opts.sheet = host.querySelector('#d-sheet').value;
    const sc = host.querySelector('#d-scale').value;
    opts.scale = sc ? sc.split(':').map(Number) : null;
    opts.views = [...host.querySelectorAll('[data-view]')].filter((c) => c.checked).map((c) => c.dataset.view);
    opts.hidden = host.querySelector('#d-hidden').checked;
  }

  async function regenerate(resetAuto) {
    readOpts();
    if (!opts.views.length) { toast('투상도를 하나 이상 고르세요', true); return; }
    const keep = D ? D.dims.filter((d) => d.id.startsWith('u') && opts.views.includes(d.view)) : [];
    const autoKept = D && !resetAuto ? D.dims.filter((d) => d.id.startsWith('a') && opts.views.includes(d.view)) : null;
    const title = D?.title, notes = D?.notes || [];
    const nd = await post('/api/drawing', { sheet: opts.sheet, scale: opts.scale, views: opts.views, hidden: opts.hidden, bodies: host.querySelector('#d-target').value ? [Number(host.querySelector('#d-target').value)] : null });
    // 치수는 모델 좌표로 저장되어 있어 척도·배치가 바뀌어도 그대로 쓸 수 있다
    nd.dims = [...(autoKept && autoKept.length ? autoKept : nd.dims), ...keep];
    nd.title = title || { part: nd.part, number: `DT-${nd.date.replaceAll('-', '')}-01`, material: '', author: '', company: '', date: nd.date };
    nd.notes = notes;
    nd.hidden = opts.hidden;
    nd._rev = ctx.getRevision();
    D = nd;
    host.querySelector('#d-sheet').value = D.sheet.name;
    host.querySelectorAll('[data-title]').forEach((i) => { i.value = D.title[i.dataset.title] || ''; });
    sel = null;
    updatePanel();
    fit();
    toast(`도면 · ${D.sheet.name} · 척도 ${D.scale[0]}:${D.scale[1]} · 치수 ${D.dims.length}개`);
  }

  async function exportAs(fmtName) {
    const stem = (D.title.part || getDocName() || 'drawing').replace(/[\\/:*?"<>|]/g, '_');
    if (fmtName === 'svg') {
      const { w, h } = D.sheet;
      const css = ':root{--d-ink:#000;--d-dim:#000;--d-center:#000}';
      const body = svgOf(prims(), false);
      const text = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" viewBox="0 0 ${w} ${h}" font-family="Malgun Gothic, sans-serif"><style>${css}</style><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;
      await saveBlob(new Blob([text], { type: 'image/svg+xml' }), `${stem}.svg`);
      return;
    }
    const blob = await api(`/api/drawing/export/${fmtName}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sheet: D.sheet, prims: prims().map(({ dim, note, view, ...p }) => p), title: stem }) });
    await saveBlob(blob, `${stem}.${fmtName}`);
  }

  async function open() {
    if (!host) buildUI();
    host.hidden = false;
    document.body.classList.add('drawing-mode');
    setTool('select');
    const t = host.querySelector('#d-target');
    const list = ctx.getBodyList();
    const cur = t.value;
    t.innerHTML = `<option value="">보이는 부품 전체${list.length > 1 ? ' (조립도)' : ''}</option>` + list.map((b) => `<option value="${b.id}">${b.name.replace(/</g, '&lt;')}</option>`).join('');
    t.value = list.some((b) => String(b.id) === cur) ? cur : '';
    if (!D) await regenerate(true);
    else if (D._rev !== ctx.getRevision()) await regenerate(false);
    else fit();
  }
  function close() {
    host.hidden = true;
    document.body.classList.remove('drawing-mode');
    onClose?.();
  }
  window.__dr = () => D;
  return { open, close, isOpen: () => host && !host.hidden, reset: () => { D = null; }, _state: () => D, _prims: () => prims() };
}
