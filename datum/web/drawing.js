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
  let placing = null, sectionHover = null, detailDraft = null, selView = null;
  let aopt = { secOrient: 'h', secFlip: false, factor: 2, gdt: 'position', tol: '0.05', dia: true, mod: '', datums: ['A', 'B', ''], datum: 'A', ra: 'Ra 1.6', machined: true };

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
    extraViewPrims(out);
    refPrims(out);
    // 치수
    D.dims.forEach((d) => dimPrims(d).forEach((p) => out.push({ ...p, dim: d.id })));
    (D.notes || []).forEach((n) => annoPrims(n).forEach((p) => out.push(p)));

    // 표제란
    titleBlock(out, W - M - TW, H - M - TH, TW, TH);
    return out;
  }

  function scaleText(s) {
    const best = [[10, 1], [5, 1], [2, 1], [1, 1], [1, 2], [1, 5], [1, 10], [1, 20], [1, 50], [1, 100]].find(([a, b]) => Math.abs(a / b - s) < 1e-6);
    return best ? `${best[0]}:${best[1]}` : s >= 1 ? `${fmt(s, 2)}:1` : `1:${fmt(1 / s, 2)}`;
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

  // ============================================================ 단면도 · 상세도 · 기하 공차 (v0.5)
  const GDT = [
    ['straightness', '진직도'], ['flatness', '평면도'], ['circularity', '진원도'], ['cylindricity', '원통도'],
    ['profile_line', '선의 윤곽도'], ['profile_surface', '면의 윤곽도'], ['parallelism', '평행도'], ['perpendicularity', '직각도'],
    ['angularity', '경사도'], ['position', '위치도'], ['concentricity', '동심도'], ['symmetry', '대칭도'],
    ['circular_runout', '원주 흔들림'], ['total_runout', '온 흔들림'],
  ];
  // 기호를 선·원으로 직접 그린다(글꼴에 없는 기호도 PDF·DXF에 똑같이 나오게). 중심 (x, y), 크기 s
  function glyph(type, x, y, s = 2.4) {
    const o = [];
    const L = (x1, y1, x2, y2) => o.push({ t: 'line', p: [x + x1 * s, y + y1 * s, x + x2 * s, y + y2 * s], s: 'thin' });
    const C = (cx, cy, r) => o.push({ t: 'circle', c: [x + cx * s, y + cy * s], r: r * s, s: 'thin' });
    const A = (cx, cy, r, a0, a1) => o.push({ t: 'arc', c: [x + cx * s, y + cy * s], r: r * s, a0, a1, s: 'thin' });
    const arrowHead = (tx, ty, dx, dy) => { const l = 0.55, w = 0.22; const bx = tx - dx * l, by = ty - dy * l; o.push({ t: 'poly', p: [x + tx * s, y + ty * s, x + (bx - dy * w) * s, y + (by + dx * w) * s, x + (bx + dy * w) * s, y + (by - dx * w) * s, x + tx * s, y + ty * s], s: 'thin', fill: true, ink: true }); };
    switch (type) {
      case 'straightness': L(-1, 0, 1, 0); break;
      case 'flatness': L(-0.7, 0.45, 1, 0.45); L(1, 0.45, 0.7, -0.45); L(0.7, -0.45, -1, -0.45); L(-1, -0.45, -0.7, 0.45); break;
      case 'circularity': C(0, 0, 0.85); break;
      case 'cylindricity': C(0, 0, 0.6); L(-0.55, 0.9, -0.15, -0.9); L(0.15, 0.9, 0.55, -0.9); break;
      case 'profile_line': A(0, 0.35, 0.85, 0, 180); break;
      case 'profile_surface': A(0, 0.35, 0.85, 0, 180); L(-0.85, 0.35, 0.85, 0.35); break;
      case 'parallelism': L(-0.75, 0.8, -0.15, -0.8); L(0.15, 0.8, 0.75, -0.8); break;
      case 'perpendicularity': L(0, -0.85, 0, 0.75); L(-0.85, 0.75, 0.85, 0.75); break;
      case 'angularity': L(-0.9, 0.75, 0.9, 0.75); L(-0.9, 0.75, 0.6, -0.75); break;
      case 'position': C(0, 0, 0.6); L(-1, 0, 1, 0); L(0, -1, 0, 1); break;
      case 'concentricity': C(0, 0, 0.45); C(0, 0, 0.85); break;
      case 'symmetry': L(-0.9, -0.5, 0.9, -0.5); L(-0.6, 0, 0.6, 0); L(-0.9, 0.5, 0.9, 0.5); break;
      case 'circular_runout': L(-0.6, 0.8, 0.5, -0.6); arrowHead(0.6, -0.75, 0.6, -0.8); break;
      case 'total_runout': L(-0.9, 0.8, 0.5, 0.8); L(-0.9, 0.8, -0.3, -0.6); L(0.5, 0.8, 1.1, -0.6); arrowHead(-0.25, -0.75, 0.42, -0.9); arrowHead(1.15, -0.75, 0.42, -0.9); break;
      default: break;
    }
    return o;
  }
  const TW = (str, h = 3.5) => String(str).length * h * 0.62;

  function annoTarget(n) { if (!n.target) return null; const v = V(n.target.view); return v ? toSheet(v, n.target.p) : null; }

  function annoPrims(n) {
    const out = [];
    const tgt = annoTarget(n);
    const leader = (from, filled) => {
      if (!tgt) return;
      out.push({ t: 'line', p: [...from, ...tgt], s: 'thin' });
      const dx = tgt[0] - from[0], dy = tgt[1] - from[1], L = Math.hypot(dx, dy) || 1, u = [dx / L, dy / L];
      if (filled === 'triangle') {
        const w = 1.7, h = 2.9, b = [tgt[0] - u[0] * h, tgt[1] - u[1] * h];
        out.push({ t: 'poly', p: [tgt[0] - u[1] * w, tgt[1] + u[0] * w, tgt[0] + u[1] * w, tgt[1] - u[0] * w, b[0], b[1], tgt[0] - u[1] * w, tgt[1] + u[0] * w], s: 'thin', fill: true, ink: true });
      } else out.push(arrowInk(tgt, u));
    };
    if (n.kind === 'fcf') {
      const H = 7, x0 = n.x, y0 = n.y;
      const tol = `${n.dia ? 'Ø' : ''}${n.tol}`;
      const modW = n.mod ? 5 : 0;
      const cells = [8, Math.max(10, TW(tol) + 4 + modW), ...n.datums.filter(Boolean).map((d) => Math.max(7, TW(d) + 3))];
      const W = cells.reduce((a, b) => a + b, 0);
      out.push({ t: 'poly', p: [x0, y0, x0 + W, y0, x0 + W, y0 + H, x0, y0 + H, x0, y0], s: 'thin' });
      let cx = x0;
      cells.forEach((w, i) => { if (i) out.push({ t: 'line', p: [cx, y0, cx, y0 + H], s: 'thin' }); cx += w; });
      glyph(n.type, x0 + 4, y0 + H / 2).forEach((p) => out.push(p));
      out.push({ t: 'text', x: x0 + 8 + (cells[1] - modW) / 2, y: y0 + H / 2 + 1.3, str: tol, h: 3.5, a: 'middle', s: 'thin' });
      if (n.mod) {
        const mx = x0 + 8 + cells[1] - modW / 2 - 1.5;
        out.push({ t: 'circle', c: [mx, y0 + H / 2], r: 1.9, s: 'thin' }, { t: 'text', x: mx, y: y0 + H / 2 + 0.95, str: n.mod, h: 2.4, a: 'middle', s: 'thin' });
      }
      let dx = x0 + 8 + cells[1];
      n.datums.filter(Boolean).forEach((d, i) => { const w = cells[2 + i]; out.push({ t: 'text', x: dx + w / 2, y: y0 + H / 2 + 1.3, str: d, h: 3.5, a: 'middle', s: 'thin' }); dx += w; });
      if (tgt) leader(tgt[0] > x0 + W ? [x0 + W, y0 + H / 2] : [x0, y0 + H / 2]);
    } else if (n.kind === 'datum') {
      const S = 7;
      out.push({ t: 'poly', p: [n.x, n.y, n.x + S, n.y, n.x + S, n.y + S, n.x, n.y + S, n.x, n.y], s: 'thin' });
      out.push({ t: 'text', x: n.x + S / 2, y: n.y + S / 2 + 1.3, str: n.letter, h: 3.5, a: 'middle', s: 'thin' });
      if (tgt) leader(tgt[1] > n.y + S ? [n.x + S / 2, n.y + S] : tgt[1] < n.y ? [n.x + S / 2, n.y] : tgt[0] > n.x ? [n.x + S, n.y + S / 2] : [n.x, n.y + S / 2], 'triangle');
    } else if (n.kind === 'rough') {
      const [x, y] = tgt || [n.x, n.y];
      const tw = TW(n.text, 3) + 2;
      out.push({ t: 'line', p: [x, y, x - 2.6, y - 4.5], s: 'thin' }, { t: 'line', p: [x, y, x + 5.2, y - 9], s: 'thin' },
        { t: 'line', p: [x + 5.2, y - 9, x + 5.2 + tw, y - 9], s: 'thin' });
      if (n.machined !== false) out.push({ t: 'line', p: [x - 2.6, y - 4.5, x + 2.6, y - 4.5], s: 'thin' });
      out.push({ t: 'text', x: x + 5.2 + tw / 2, y: y - 10, str: n.text, h: 3, a: 'middle', s: 'thin' });
    } else {
      out.push({ t: 'text', x: n.x, y: n.y, str: n.text, h: n.h || 3.5, a: 'start', s: 'thin' });
    }
    return out.map((p) => ({ ...p, note: n.id }));
  }
  function annoPreview(out) {
    void out;
  }
  function hoverPrims(out) {
    if (sectionHover) {
      const v = V(sectionHover.view);
      const [bx0, by0, bx1, by1] = v.bbox, e = 6 / v.scale;
      const a = sectionHover.orient === 'h' ? [bx0 - e, sectionHover.pos] : [sectionHover.pos, by0 - e];
      const b = sectionHover.orient === 'h' ? [bx1 + e, sectionHover.pos] : [sectionHover.pos, by1 + e];
      out.push({ t: 'line', p: [...toSheet(v, a), ...toSheet(v, b)], s: 'center' });
    }
    if (detailDraft && detailDraft.r > 0) {
      const v = V(detailDraft.view);
      out.push({ t: 'circle', c: toSheet(v, detailDraft.center), r: detailDraft.r * v.scale, s: 'thin' });
    }
  }
  function arrowInk(tip, dir) { const a = arrow(tip, dir); a.ink = true; a.s = 'thin'; return a; }

  // 부모 뷰의 절단선(굵은 끝 + 화살표 + 문자)과 상세 원
  function refPrims(out) {
    D.views.forEach((sv) => {
      const pv = V(sv.parent);
      if (!pv) return;
      if (sv.kind === 'section') {
        const [bx0, by0, bx1, by1] = pv.bbox;
        const ext = 6 / pv.scale;
        const { orient, pos, flip } = sv.cut;
        const a = orient === 'h' ? [bx0 - ext, pos] : [pos, by0 - ext], b = orient === 'h' ? [bx1 + ext, pos] : [pos, by1 + ext];
        const A = toSheet(pv, a), B = toSheet(pv, b);
        out.push({ t: 'line', p: [...A, ...B], s: 'center' });
        const L = Math.hypot(B[0] - A[0], B[1] - A[1]), u = [(B[0] - A[0]) / L, (B[1] - A[1]) / L];
        out.push({ t: 'line', p: [...A, A[0] + u[0] * 6, A[1] + u[1] * 6], s: 'thick' }, { t: 'line', p: [B[0] - u[0] * 6, B[1] - u[1] * 6, ...B], s: 'thick' });
        // 화살표: 보는 방향(관찰자 → 부품) = −look. 수평선: look = 부모 위(+y) → 용지에서 아래(+)
        const sgn = flip ? -1 : 1;
        const dir = orient === 'h' ? [0, sgn] : [-sgn, 0];
        [A, B].forEach((P) => {
          const tail = [P[0] - dir[0] * 7, P[1] - dir[1] * 7];
          out.push({ t: 'line', p: [...tail, ...P], s: 'thin' }, arrowInk(P, dir));
          out.push({ t: 'text', x: tail[0] - dir[0] * 2.5 + (orient === 'h' ? 0 : 0), y: tail[1] - dir[1] * 2.5 + 1.5, str: sv.label, h: 5, a: 'middle', s: 'thin' });
        });
      } else if (sv.kind === 'detail') {
        const c = toSheet(pv, sv.center), r = sv.radius * pv.scale;
        out.push({ t: 'circle', c, r, s: 'thin' });
        out.push({ t: 'text', x: c[0] + r * 0.75 + 3, y: c[1] - r * 0.75 - 1, str: sv.label, h: 5, a: 'start', s: 'thin' });
      }
    });
  }
  function extraViewPrims(out) {
    D.views.forEach((v) => {
      if (v.hatch) v.hatch.forEach((e) => out.push({ t: 'line', p: [...toSheet(v, e.p.slice(0, 2)), ...toSheet(v, e.p.slice(2))], s: 'thin', view: v.id }));
      if (v.kind === 'detail') out.push({ t: 'circle', c: toSheet(v, v.center), r: v.radius * v.scale, s: 'thin', view: v.id });
      if (v.kind === 'section' || v.kind === 'detail') {
        const [x0, y0, x1] = v.bbox;
        const [lx, ly] = toSheet(v, [(x0 + x1) / 2, y0]);
        const pv = V(v.parent);
        const sc = pv && v.kind === 'detail' ? ` (${scaleText(v.scale)})` : '';
        out.push({ t: 'text', x: lx, y: ly + 8, str: `${v.name}${sc}`, h: 3.5, a: 'middle', s: 'thin' });
      }
    });
  }

  // ---------- 상세도: 부모 뷰를 원으로 잘라 확대
  function clipSeg(a, b, c, r) {
    const d = [b[0] - a[0], b[1] - a[1]], f = [a[0] - c[0], a[1] - c[1]];
    const A = d[0] * d[0] + d[1] * d[1], B = 2 * (f[0] * d[0] + f[1] * d[1]), C = f[0] * f[0] + f[1] * f[1] - r * r;
    if (A < 1e-18) return null;
    const disc = B * B - 4 * A * C;
    if (disc <= 0) return null;
    const s = Math.sqrt(disc);
    const t0 = Math.max(0, (-B - s) / (2 * A)), t1 = Math.min(1, (-B + s) / (2 * A));
    if (t1 <= t0) return null;
    return [a[0] + d[0] * t0, a[1] + d[1] * t0, a[0] + d[0] * t1, a[1] + d[1] * t1];
  }
  function toPolyPts(e) {
    if (e.t === 'poly') { const o = []; for (let k = 0; k < e.p.length; k += 2) o.push([e.p[k], e.p[k + 1]]); return o; }
    const a0 = e.t === 'circle' ? 0 : e.a0, ext = e.t === 'circle' ? 360 : (((e.a1 - e.a0) % 360) + 360) % 360 || 360;
    const N = Math.max(12, Math.ceil(ext / 5)), o = [];
    for (let k = 0; k <= N; k++) { const a = (a0 + ext * k / N) * Math.PI / 180; o.push([e.c[0] + e.r * Math.cos(a), e.c[1] + e.r * Math.sin(a)]); }
    return o;
  }
  function clipEnts(list, c, r) {
    const out = [];
    list.forEach((e) => {
      if (e.t === 'line') { const s = clipSeg(e.p.slice(0, 2), e.p.slice(2), c, r); if (s) out.push({ t: 'line', p: s }); return; }
      if (e.t === 'circle' && Math.hypot(e.c[0] - c[0], e.c[1] - c[1]) + e.r <= r) { out.push(e); return; }
      if ((e.t === 'circle' || e.t === 'arc') && Math.hypot(e.c[0] - c[0], e.c[1] - c[1]) - e.r >= r) return;
      const P = toPolyPts(e);
      for (let k = 0; k + 1 < P.length; k++) { const s = clipSeg(P[k], P[k + 1], c, r); if (s) out.push({ t: 'line', p: s }); }
    });
    return out;
  }
  function makeDetail(parent, center, radius, factor, label) {
    const vis = clipEnts(parent.visible, center, radius), hid = clipEnts(parent.hidden || [], center, radius);
    const snaps = [];
    vis.forEach((e) => { if (e.t === 'line') snaps.push(e.p.slice(0, 2), e.p.slice(2)); if (e.t === 'circle') snaps.push(e.c); });
    return { id: `det${label}`, kind: 'detail', name: `상세 ${label}`, label, parent: parent.id, center, radius, factor,
      visible: vis, hidden: hid, snaps, bbox: [center[0] - radius, center[1] - radius, center[0] + radius, center[1] + radius], scale: parent.scale * factor, ox: 0, oy: 0 };
  }
  function nextLabel() {
    const used = new Set(D.views.map((v) => v.label).filter(Boolean));
    return 'ABCDEFGHJKLMNPRSTUVWXYZ'.split('').find((l) => !used.has(l)) || 'Z';
  }
  function viewAt(q, pad = 3) {
    return [...D.views].reverse().find((v) => {
      const [x0, y0, x1, y1] = v.bbox, a = toSheet(v, [x0, y1]), b = toSheet(v, [x1, y0]);
      return q[0] >= a[0] - pad && q[0] <= b[0] + pad && q[1] >= a[1] - pad && q[1] <= b[1] + pad;
    });
  }
  // 선 위 아무 점(지시선 끝)
  function nearestOnGeometry(q) {
    const s = nearestSnap(q);
    if (s) return { view: s.view, p: s.p, q: s.q };
    let best = null, bd = 2.5;
    D.views.forEach((v) => {
      if (v.id === 'iso') return;
      v.visible.forEach((e) => {
        const P = e.t === 'line' ? [e.p.slice(0, 2), e.p.slice(2)] : toPolyPts(e);
        for (let k = 0; k + 1 < P.length; k++) {
          const a = toSheet(v, P[k]), b = toSheet(v, P[k + 1]);
          const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
          const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / L));
          const pq = [a[0] + t * dx, a[1] + t * dy], d = Math.hypot(pq[0] - q[0], pq[1] - q[1]);
          if (d < bd) { bd = d; best = { view: v.id, p: fromSheet(v, pq), q: pq }; }
        }
      });
    });
    return best;
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
        parts.push(p.fill ? `<polygon points="${pts.join(' ')}" style="fill:${p.ink ? 'var(--d-ink)' : 'var(--d-dim)'};stroke:none"/>` : `<polyline points="${pts.join(' ')}" style="${st}"/>`);
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
    const hp = []; hoverPrims(hp);
    if (hp.length) overlay.push(svgOf(hp, false).replace(/var\(--d-(ink|center)\)/g, 'var(--accent)'));
    if (selView) { const v = V(selView); if (v) { const [x0, y0, x1, y1] = v.bbox, a = toSheet(v, [x0, y1]), b = toSheet(v, [x1, y0]); overlay.push(`<rect class="vsel" x="${a[0] - 3}" y="${a[1] - 3}" width="${b[0] - a[0] + 6}" height="${b[1] - a[1] + 6}"/>`); } }
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
      if (drag.view) { const v = V(drag.view); v.ox = drag.ox + q[0] - drag.q[0]; v.oy = drag.oy + q[1] - drag.q[1]; }
      render();
      return;
    }
    if (placing) {
      if (placing.view) { const v = placing.view, [x0, y0, x1, y1] = v.bbox; v.ox = q[0] - (x0 + x1) / 2 * v.scale; v.oy = q[1] + (y0 + y1) / 2 * v.scale; }
      if (placing.note) { placing.note.x = q[0]; placing.note.y = q[1]; }
      render();
      return;
    }
    if (tool === 'section') {
      const v = viewAt(q, 0);
      sectionHover = v && !v.kind && v.id !== 'iso' ? { view: v.id, orient: aopt.secOrient, pos: fromSheet(v, q)[aopt.secOrient === 'h' ? 1 : 0] } : null;
      if (sectionHover) { const sn = nearestSnap(q, v.id); if (sn) sectionHover.pos = sn.p[aopt.secOrient === 'h' ? 1 : 0]; }
      render();
      return;
    }
    if (tool === 'detail' && detailDraft) {
      const v = V(detailDraft.view), m = fromSheet(v, q);
      detailDraft.r = Math.hypot(m[0] - detailDraft.center[0], m[1] - detailDraft.center[1]);
      render();
      return;
    }
    if (tool === 'gdt' || tool === 'datum' || tool === 'rough') {
      const t = nearestOnGeometry(q);
      hoverSnap = t ? { q: t.q } : null;
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
    if (placing) { placing = null; setTool('select'); render(); return; }
    if (tool === 'select') {
      const g = e.target.closest('.dimg');
      sel = g ? g.dataset.id : null;
      selView = null;
      if (sel) {
        const n = (D.notes || []).find((x) => x.id === sel);
        drag = { id: sel, dx: n ? q[0] - n.x : 0, dy: n ? q[1] - n.y : 0 };
      } else {
        const v = viewAt(q);
        if (v) { selView = v.id; drag = { view: v.id, q, ox: v.ox, oy: v.oy }; }
      }
      render();
      updatePanel();
      return;
    }
    if (tool === 'section') {
      if (!sectionHover) { toast('정면·평면·측면도 위를 클릭하세요(절단선이 따라다니는 곳)', true); return; }
      const h = sectionHover, pv = V(h.view), label = nextLabel();
      sectionHover = null;
      post('/api/drawing/section', { bodies: target(), parent: h.view, orient: h.orient, pos: h.pos, flip: aopt.secFlip, spacing: 2.5 / pv.scale, label })
        .then((v) => { v.scale = pv.scale; D.views.push(v); placing = { view: v }; selView = null; onMove(e); toast(`단면 ${label}-${label} — 놓을 곳을 클릭하세요`); })
        .catch((err) => toast(err.message, true));
      return;
    }
    if (tool === 'detail') {
      if (!detailDraft) {
        const v = viewAt(q, 0);
        if (!v || v.id === 'iso') { toast('확대할 곳(뷰 안)을 클릭하세요', true); return; }
        detailDraft = { view: v.id, center: fromSheet(v, q), r: 0 };
        return;
      }
      if (detailDraft.r <= 0) return;
      const dv = makeDetail(V(detailDraft.view), detailDraft.center, detailDraft.r, aopt.factor, nextLabel());
      detailDraft = null;
      D.views.push(dv);
      placing = { view: dv };
      onMove(e);
      toast(`${dv.name} — 놓을 곳을 클릭하세요`);
      return;
    }
    if (tool === 'gdt' || tool === 'datum' || tool === 'rough') {
      const t = nearestOnGeometry(q);
      const tg = t ? { view: t.view, p: t.p } : null;
      let n;
      if (tool === 'rough') {
        n = { id: `n${uid++}`, kind: 'rough', target: tg, x: q[0], y: q[1], text: aopt.ra, machined: aopt.machined };
        D.notes.push(n); sel = n.id; render(); return;
      }
      if (tool === 'gdt') n = { id: `n${uid++}`, kind: 'fcf', target: tg, x: q[0] + 8, y: q[1] - 16, type: aopt.gdt, tol: aopt.tol, dia: aopt.dia, mod: aopt.mod, datums: [...aopt.datums] };
      else { n = { id: `n${uid++}`, kind: 'datum', target: tg, x: q[0] - 3.5, y: q[1] - 16, letter: aopt.datum }; aopt.datum = String.fromCharCode(aopt.datum.charCodeAt(0) + 1); }
      D.notes.push(n);
      sel = n.id;
      placing = { note: n };
      render();
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

  function removeView(id) {
    const gone = new Set([id, ...D.views.filter((v) => v.parent === id).map((v) => v.id)]);
    D.views = D.views.filter((v) => !gone.has(v.id));
    D.dims = D.dims.filter((d) => !gone.has(d.view));
    D.notes = D.notes.filter((n) => !n.target || !gone.has(n.target.view));
    selView = null;
    render();
  }
  const target = () => (host.querySelector('#d-target').value ? [Number(host.querySelector('#d-target').value)] : null);

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
    else if ((k === 'delete' || k === 'backspace') && selView && V(selView)?.kind) { removeView(selView); e.preventDefault(); }
    else if (k === 'escape' && placing) { if (placing.view) removeView(placing.view.id); if (placing.note) D.notes = D.notes.filter((n) => n !== placing.note); placing = null; setTool('select'); }
    else if (k === 'escape') { if (pending.length || tool !== 'select') { pending = []; preview = null; setTool('select'); } else if (sel) { sel = null; render(); updatePanel(); } }
    else if (k === 'f') fit();
    else if (k === 'd') setTool('linear');
    else if ((e.ctrlKey || e.metaKey) && k === 'p') { e.preventDefault(); exportAs('pdf'); }
    else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); exportAs('pdf'); }
    e.stopPropagation();
  }

  // ------------------------------------------------------------ 패널
  function setTool(t) {
    tool = t; pending = []; preview = null; hoverSnap = null; sectionHover = null; detailDraft = null;
    host.querySelectorAll('[data-dtool]').forEach((b) => b.classList.toggle('on', b.dataset.dtool === t));
    svg.style.cursor = t === 'select' ? 'default' : 'crosshair';
    const hint = { select: '치수를 끌어 위치를 옮기고, 더블클릭으로 문자(공차 등)를 고칩니다. Delete로 지웁니다.',
      section: '부모 뷰 위에서 절단선 위치를 클릭 → 생긴 단면도를 놓을 곳을 클릭합니다. (아래에서 수평/수직·방향)',
      detail: '확대할 곳의 중심을 클릭 → 마우스로 원 크기를 정해 클릭 → 상세도를 놓을 곳을 클릭합니다.',
      gdt: '지시할 선(또는 점)을 클릭 → 기입틀을 놓을 곳을 클릭합니다. 선 밖을 클릭하면 지시선 없이 놓입니다.',
      datum: '데이텀으로 정할 선을 클릭 → 데이텀 상자를 놓을 곳을 클릭합니다.',
      rough: '표면 거칠기를 표시할 선 위를 클릭합니다.',
      linear: '두 점(선 끝점·원 중심)을 차례로 클릭 → 마우스를 위·아래로 빼면 수평, 좌·우로 빼면 수직 치수 → 클릭해서 놓기', radial: '원이나 호의 테두리를 클릭하면 지름(Ø)·반지름(R) 치수가 붙습니다.', note: '주기를 넣을 곳을 클릭하세요.' }[t];
    host.querySelector('#d-hint').textContent = hint;
    annoForm();
    render();
  }

  function annoForm() {
    const box = host.querySelector('#d-anno');
    const chk = (id, label, on) => `<label><input type="checkbox" id="${id}" ${on ? 'checked' : ''}> ${label}</label>`;
    const inp = (id, label, v, w = '') => `<div class="row"><label>${label}</label><input id="${id}" value="${v}" ${w}></div>`;
    let html = '';
    if (tool === 'section') html = `<div class="seg" id="a-sec">${[['h', '수평 절단'], ['v', '수직 절단']].map(([v, n]) => `<button data-v="${v}" class="${aopt.secOrient === v ? 'on' : ''}">${n}</button>`).join('')}</div><div class="checks" style="margin-top:8px">${chk('a-flip', '보는 방향 반전', aopt.secFlip)}</div>`;
    if (tool === 'detail') html = `<div class="row"><label>확대 배율</label><select id="a-factor">${[2, 3, 4, 5, 10].map((f) => `<option value="${f}" ${f === aopt.factor ? 'selected' : ''}>${f}배</option>`).join('')}</select></div>`;
    if (tool === 'gdt') html = `<div class="gdt-grid">${GDT.map(([k, n]) => `<button data-g="${k}" class="${aopt.gdt === k ? 'on' : ''}" title="${n}"><svg viewBox="-4 -4 8 8" width="22" height="22">${svgOf(glyph(k, 0, 0, 3), false).replace(/var\(--d-ink\)/g, 'currentColor')}</svg></button>`).join('')}</div>
      <p class="hint" id="a-gname">${GDT.find(([k]) => k === aopt.gdt)[1]}</p>
      ${inp('a-tol', '공차값', aopt.tol)}<div class="checks">${chk('a-dia', '지름 공차역 Ø', aopt.dia)}</div>
      <div class="row"><label>재료 조건</label><select id="a-mod"><option value="">없음</option><option value="M" ${aopt.mod === 'M' ? 'selected' : ''}>최대 실체 Ⓜ</option><option value="L" ${aopt.mod === 'L' ? 'selected' : ''}>최소 실체 Ⓛ</option></select></div>
      <div class="row"><label>데이텀</label><div class="dat3">${[0, 1, 2].map((i) => `<input data-dat="${i}" value="${aopt.datums[i]}" maxlength="3">`).join('')}</div></div>`;
    if (tool === 'datum') html = inp('a-letter', '데이텀 문자', aopt.datum, 'maxlength="2"');
    if (tool === 'rough') html = inp('a-ra', '거칠기', aopt.ra) + `<div class="checks">${chk('a-mach', '제거 가공 필요', aopt.machined)}</div>`;
    box.innerHTML = html ? `<div class="sect">옵션</div>${html}` : '';
    box.querySelectorAll('#a-sec button').forEach((b) => (b.onclick = () => { aopt.secOrient = b.dataset.v; annoForm(); }));
    box.querySelector('#a-flip')?.addEventListener('change', (e) => { aopt.secFlip = e.target.checked; });
    box.querySelector('#a-factor')?.addEventListener('change', (e) => { aopt.factor = Number(e.target.value); });
    box.querySelectorAll('[data-g]').forEach((b) => (b.onclick = () => { aopt.gdt = b.dataset.g; annoForm(); }));
    box.querySelector('#a-tol')?.addEventListener('input', (e) => { aopt.tol = e.target.value; });
    box.querySelector('#a-dia')?.addEventListener('change', (e) => { aopt.dia = e.target.checked; });
    box.querySelector('#a-mod')?.addEventListener('change', (e) => { aopt.mod = e.target.value; });
    box.querySelectorAll('[data-dat]').forEach((i) => (i.oninput = () => { aopt.datums[Number(i.dataset.dat)] = i.value.toUpperCase(); }));
    box.querySelector('#a-letter')?.addEventListener('input', (e) => { aopt.datum = e.target.value.toUpperCase(); });
    box.querySelector('#a-ra')?.addEventListener('input', (e) => { aopt.ra = e.target.value; });
    box.querySelector('#a-mach')?.addEventListener('change', (e) => { aopt.machined = e.target.checked; });
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
        <i></i><button data-dtool="section" title="단면도">${icon('section2', 18)}<span>단면</span></button>
        <button data-dtool="detail" title="상세도">${icon('detail', 18)}<span>상세</span></button>
        <i></i><button data-dtool="gdt" title="기하 공차">${icon('gdt', 18)}<span>기하공차</span></button>
        <button data-dtool="datum" title="데이텀">${icon('datum', 18)}<span>데이텀</span></button>
        <button data-dtool="rough" title="표면 거칠기">${icon('rough', 18)}<span>거칠기</span></button>
        <i></i><button id="d-fit" title="용지 맞춤 (F)">${icon('fit', 18)}</button>
      </div><svg id="d-svg" xmlns="http://www.w3.org/2000/svg"></svg><p id="d-hint" class="d-hint"></p></div>
      <aside class="d-panel">
        <div class="pane-head">${icon('drawing', 18)}<span>도면</span><button class="ghost icon-btn small" id="d-close" title="3D로 돌아가기">${icon('close', 16)}</button></div>
        <div class="d-body">
          <div id="d-anno"></div>
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
    const extras = D ? D.views.filter((v) => v.kind) : [];
    const keepIds = new Set([...opts.views, ...extras.map((v) => v.id)]);
    const keep = D ? D.dims.filter((d) => d.id.startsWith('u') && keepIds.has(d.view)) : [];
    const autoKept = D && !resetAuto ? D.dims.filter((d) => d.id.startsWith('a') && opts.views.includes(d.view)) : null;
    const title = D?.title, notes = D?.notes || [];
    const nd = await post('/api/drawing', { sheet: opts.sheet, scale: opts.scale, views: opts.views, hidden: opts.hidden, bodies: host.querySelector('#d-target').value ? [Number(host.querySelector('#d-target').value)] : null });
    // 치수는 모델 좌표로 저장되어 있어 척도·배치가 바뀌어도 그대로 쓸 수 있다
    nd.dims = [...(autoKept && autoKept.length ? autoKept : nd.dims), ...keep];
    nd.title = title || { part: nd.part, number: `DT-${nd.date.replaceAll('-', '')}-01`, material: '', author: '', company: '', date: nd.date };
    nd.notes = notes;
    // 단면도·상세도는 위치를 유지한 채 새 형상·척도로 다시 만든다
    for (const ex of extras) {
      const parent = nd.views.find((v) => v.id === ex.parent);
      if (!parent) continue;
      if (ex.kind === 'section') {
        try {
          const v = await post('/api/drawing/section', { bodies: target(), parent: ex.parent, orient: ex.cut.orient, pos: ex.cut.pos, flip: ex.cut.flip, spacing: 2.5 / parent.scale, label: ex.label });
          Object.assign(v, { scale: parent.scale, ox: ex.ox, oy: ex.oy });
          nd.views.push(v);
        } catch { /* 절단선이 더 이상 부품을 지나지 않으면 생략 */ }
      } else {
        const v = makeDetail(parent, ex.center, ex.radius, ex.factor, ex.label);
        Object.assign(v, { ox: ex.ox, oy: ex.oy });
        nd.views.push(v);
      }
    }
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
