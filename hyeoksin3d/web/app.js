import * as THREE from 'three';
import { OrbitControls } from '/static/vendor/OrbitControls.js';
import { icon, KIND_ICON } from '/static/icons.js';
import { createDrawing } from '/static/drawing.js';
import { createSketch } from '/static/sketch.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('hyeoksin3d.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('hyeoksin3d.' + k, JSON.stringify(v)); } catch { /* 저장 불가 환경 */ } },
};

// =============================================================== 서버 통신 · 알림
let pending = 0;
async function api(path, opts = {}) {
  pending++;
  const t = setTimeout(() => { if (pending) $('#busy').hidden = false; }, 180);
  try {
    const r = await fetch(path, opts);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.blob();
    if (!r.ok) throw new Error(data?.error || data?.detail || r.statusText);
    return data;
  } finally {
    clearTimeout(t);
    if (--pending === 0) $('#busy').hidden = true;
  }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function toast(msg, err = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (err ? ' err' : '');
  el.innerHTML = icon(err ? 'info' : 'check', 16) + `<span></span>`;
  el.querySelector('span').textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), err ? 4200 : 2200);
  setTimeout(() => el.remove(), err ? 4600 : 2600);
}
async function safe(fn) { try { return await fn(); } catch (e) { toast(e.message, true); } }

// =============================================================== 테마 · 단위
const media = matchMedia('(prefers-color-scheme: dark)');
let theme = store.get('theme', media.matches ? 'dark' : 'light');
function applyTheme() {
  document.documentElement.dataset.theme = theme;
  $('#btn-theme').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon', 18);
  COLORS.edge = theme === 'dark' ? 0x0b0d10 : 0x1f2937;
  grid.material.opacity = theme === 'dark' ? 0.18 : 0.35;
  views.forEach((v) => v.lines.material.color.setHex(COLORS.edge));
  drawCubeFaces();
}

let units = store.get('units', 'mm');
const U = () => (units === 'mm' ? 1 : 25.4);
const fmt = (x, d = 3) => {
  const v = Math.abs(x) < 1e-9 ? 0 : x;
  return v.toFixed(d).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
};
const L = (mm, d = 3) => `${fmt(mm / U(), d)} ${units}`;
const A = (mm2) => `${fmt(mm2 / U() ** 2, 2)} ${units}²`;
const V = (mm3) => `${fmt(mm3 / U() ** 3, 2)} ${units}³`;
const P3 = (v) => v.map((x) => fmt(x / U(), 3)).join(', ');
const D3 = (v) => v.map((x) => fmt(x, 4)).join(', ');

// =============================================================== 3D 장면
const vp = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x000000, 0);
renderer.localClippingEnabled = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.className = 'main';
vp.prepend(renderer.domElement);

const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(35, 1, 0.1, 1e6);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
[persp, ortho].forEach((c) => { c.up.set(0, 0, 1); c.position.set(200, -300, 200); });
let camera = store.get('ortho', false) ? ortho : persp;
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.18;
controls.zoomToCursor = true;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
renderer.domElement.addEventListener('pointerdown', (e) => {
  controls.mouseButtons.LEFT = e.altKey ? THREE.MOUSE.ROTATE : null;
  controls.mouseButtons.MIDDLE = e.ctrlKey ? THREE.MOUSE.PAN : e.shiftKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
}, true);

scene.add(new THREE.HemisphereLight(0xffffff, 0x6b7a8f, 1.5));
const key = new THREE.DirectionalLight(0xffffff, 1.9);
const fill = new THREE.DirectionalLight(0xdfe8ff, 0.6);
scene.add(key, fill);
const world = new THREE.Group();
const overlay = new THREE.Group();
scene.add(world, overlay);
const grid = new THREE.GridHelper(1, 20, 0x8892a0, 0xb0b8c4);
grid.rotation.x = Math.PI / 2;
grid.material.transparent = true;
grid.material.opacity = 0.35;
scene.add(grid);

const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
let sectionOn = false;
let showEdges = store.get('edges', true);
let wire = false;
let modelSize = 100;

function resize() {
  const w = vp.clientWidth, h = vp.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h);
  persp.aspect = w / h;
  persp.updateProjectionMatrix();
  const hh = (ortho.top - ortho.bottom) / 2 || 100;
  ortho.left = -hh * w / h; ortho.right = hh * w / h;
  ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(vp);

// =============================================================== 바디 표시(메시 캐시: id+rev)
let state = { bodies: [], history: [], redo: [] };
const views = new Map();
const meshCache = new Map();
const COLORS = { hover: 0xf59e0b, sel: 0x2563eb, edge: 0x1f2937, dim: 0xe8590c };

function makeBodyView(b, data) {
  const group = new THREE.Group();
  const pos = [], idx = [], triFace = [], faceTris = [];
  let base = 0;
  data.faces.forEach((f, fi) => {
    const start = idx.length / 3;
    for (const p of f.pos) pos.push(p);
    for (const i of f.idx) idx.push(i + base);
    for (let t = 0; t < f.idx.length / 3; t++) triFace.push(fi);
    faceTris.push([start, f.idx.length / 3]);
    base += f.pos.length / 3;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  const clip = sectionOn ? [sectionPlane] : [];
  const mat = new THREE.MeshStandardMaterial({
    color: b.color, metalness: 0.05, roughness: 0.5, side: THREE.DoubleSide, wireframe: wire,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: clip,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { body: b.id, kind: 'face' };

  const lp = [], segEdge = [];
  data.edges.forEach((pts, ei) => {
    for (let i = 0; i + 5 < pts.length; i += 3) {
      lp.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
      segEdge.push(ei);
    }
  });
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: COLORS.edge, clippingPlanes: clip, transparent: true, opacity: 0.85 }));
  lines.userData = { body: b.id, kind: 'edge' };
  lines.visible = showEdges;

  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));
  const points = new THREE.Points(pgeo, new THREE.PointsMaterial({ size: 1, visible: false }));
  points.userData = { body: b.id, kind: 'vertex' };

  group.add(mesh, lines, points);
  group.visible = b.visible;
  return { group, mesh, triFace, faceTris, lines, segEdge, points, data, rev: b.rev };
}

async function applyState(s, { fit = false } = {}) {
  state = s;
  const need = s.bodies.filter((b) => !meshCache.has(`${b.id}:${b.rev}`));
  const got = await Promise.all(need.map((b) => api(`/api/mesh/${b.id}?rev=${b.rev}`)));
  need.forEach((b, i) => meshCache.set(`${b.id}:${b.rev}`, got[i]));
  const alive = new Set(s.bodies.map((b) => b.id));
  views.forEach((v, id) => {
    const b = s.bodies.find((x) => x.id === id);
    if (!alive.has(id) || v.rev !== b.rev) { world.remove(v.group); disposeGroup(v.group); views.delete(id); }
  });
  s.bodies.forEach((b) => {
    let v = views.get(b.id);
    if (!v) { v = makeBodyView(b, meshCache.get(`${b.id}:${b.rev}`)); views.set(b.id, v); world.add(v.group); }
    v.group.visible = b.visible;
    v.mesh.material.color.set(b.color);
  });
  // 바뀐 형상의 선택은 무효
  selection = selection.filter((x) => views.get(x.body)?.rev === x.rev);
  redrawSelection();
  hideCtx();
  renderBrowser();
  renderTimeline();
  updateGrid();
  if (fit) fitView(false);
  if (!s.history.length || s.history.at(-1).kind === 'open' || s.history.at(-1).kind === 'new') { if (s.history.length <= 1) drawingMode.reset(); }
  activeTool?.refresh?.();
  $('#btn-undo').disabled = s.history.length <= 1;
  $('#btn-redo').disabled = !s.redo.length;
  $('#dirty').classList.toggle('on', s.history.length > 1 && !['open', 'new'].includes(s.history.at(-1).kind));
}

function disposeGroup(g) { g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); }); }

function worldBox() {
  const box = new THREE.Box3();
  views.forEach((v) => { if (v.group.visible) box.expandByObject(v.mesh); });
  return box;
}

function updateGrid() {
  const box = worldBox();
  if (box.isEmpty()) { grid.visible = false; return; }
  const size = box.getSize(new THREE.Vector3());
  modelSize = size.length() || 100;
  const step = 10 ** Math.floor(Math.log10(Math.max(size.x, size.y, 1) / 2));
  const span = Math.ceil((Math.max(size.x, size.y) * 1.6) / step) * step;
  const c = box.getCenter(new THREE.Vector3());
  grid.scale.setScalar(span);
  grid.position.set(Math.round(c.x / step) * step, Math.round(c.y / step) * step, box.min.z - modelSize * 0.002);
  grid.visible = true;
}

// =============================================================== 모델 브라우저
let selectedBody = null;
function renderBrowser() {
  $('#docname').textContent = state.name;
  document.title = `${state.name} — 혁신3D`;
  $('#body-count').textContent = state.bodies.length ? `${state.bodies.length}` : '';
  $('#empty-hint').hidden = state.bodies.length > 0;
  const ul = $('#bodies');
  ul.innerHTML = '';
  state.bodies.forEach((b) => {
    const li = document.createElement('li');
    li.className = (b.id === selectedBody ? 'sel ' : '') + (b.visible ? '' : 'hid');
    li.innerHTML = `<input type="color" class="sw" value="${b.color}" title="색상"><span class="nm" title="더블클릭해서 이름 바꾸기"></span>${b.fixed ? `<span class="tag" title="고정 부품 — 메이트로 움직이지 않음">${icon('pin', 12)}고정</span>` : ''}<button class="vis icon-btn small" title="보이기/숨기기">${icon(b.visible ? 'eye' : 'eyeOff', 16)}</button>`;
    $('.nm', li).textContent = b.name;
    li.onclick = (e) => {
      if (e.target.closest('.vis,.sw') || e.target.tagName === 'INPUT') return;
      if (selectedBody === b.id) return;
      selectedBody = b.id;
      // 목록을 다시 만들지 않고 표시만 바꾼다(다시 만들면 더블클릭 이름 바꾸기가 끊긴다)
      $$('#bodies li').forEach((x) => x.classList.toggle('sel', x === li));
      activeTool?.refresh?.();
    };
    $('.nm', li).ondblclick = () => {
      const inp = document.createElement('input');
      inp.value = b.name; inp.style.width = '100%';
      $('.nm', li).replaceWith(inp); inp.focus(); inp.select();
      const done = () => safe(async () => { if (inp.value && inp.value !== b.name) await applyState(await post('/api/op', { op: 'props', body: b.id, params: { name: inp.value } })); else renderBrowser(); });
      inp.onkeydown = (e) => { if (e.key === 'Enter') inp.blur(); if (e.key === 'Escape') { inp.value = b.name; inp.blur(); } };
      inp.onblur = done;
    };
    $('.vis', li).onclick = () => safe(async () => applyState(await post('/api/op', { op: 'props', body: b.id, params: { visible: !b.visible } })));
    $('.sw', li).oninput = (e) => views.get(b.id)?.mesh.material.color.set(e.target.value);
    $('.sw', li).onchange = (e) => safe(async () => applyState(await post('/api/op', { op: 'props', body: b.id, params: { color: e.target.value } })));
    li.onmouseenter = () => { const v = views.get(b.id); if (v) v.mesh.material.emissive.setHex(0x1d3b80); };
    li.onmouseleave = () => { const v = views.get(b.id); if (v) v.mesh.material.emissive.setHex(0); };
    ul.appendChild(li);
  });
  const mates = state.mates || [];
  $('#mates-head').hidden = !mates.length;
  $('#mate-count').textContent = mates.length || '';
  const ml = $('#mates');
  ml.innerHTML = '';
  mates.forEach((m) => {
    const li = document.createElement('li');
    li.className = m.ok ? '' : 'bad';
    li.innerHTML = `${icon('mate', 15)}<div class="mt"><b></b><small></small></div><button class="icon-btn small del" title="메이트 삭제">${icon('trash', 15)}</button>`;
    $('b', li).textContent = m.name + (m.type === 'distance' ? ` ${fmt(m.offset / U(), 3)}` : '') + (m.ok ? '' : ' · 오류');
    $('small', li).textContent = m.label;
    li.title = m.type === 'distance' ? '더블클릭: 거리 수정' : '더블클릭: 정렬 반전';
    li.ondblclick = () => safe(async () => {
      if (m.type === 'distance') {
        const v = prompt('메이트 거리', fmt(m.offset / U(), 4));
        if (v != null && v !== '') await runOp({ op: 'edit_mate', params: { id: m.id, offset: parseFloat(v) * U() } });
      } else await runOp({ op: 'edit_mate', params: { id: m.id, aligned: !m.aligned } });
    });
    li.onmouseenter = () => m.bodies.forEach((id) => views.get(id)?.mesh.material.emissive.setHex(0x1d3b80));
    li.onmouseleave = () => m.bodies.forEach((id) => views.get(id)?.mesh.material.emissive.setHex(0));
    $('.del', li).onclick = (e) => { e.stopPropagation(); safe(() => runOp({ op: 'delete_mate', params: { id: m.id } })); };
    ml.appendChild(li);
  });
}

// =============================================================== 타임라인
function renderTimeline() {
  const tl = $('#timeline');
  tl.innerHTML = '';
  const all = [...state.history.map((h) => ({ ...h, future: false })), ...state.redo.map((h) => ({ ...h, future: true }))];
  all.forEach((h, i) => {
    if (i) tl.insertAdjacentHTML('beforeend', `<span class="arrow">›</span>`);
    const b = document.createElement('button');
    const cur = i === state.history.length - 1;
    b.className = cur ? 'cur' : h.future ? 'future' : '';
    b.innerHTML = icon(KIND_ICON[h.kind] || 'body', 16) + '<span></span>';
    $('span', b).textContent = h.label;
    b.title = cur ? '현재 상태' : h.future ? '클릭하면 이 작업까지 다시 실행' : '클릭하면 이 시점으로 되돌아감';
    if (!cur) b.onclick = () => safe(async () => { await applyState(await post('/api/op', { op: 'goto', params: { index: i } })); toast(`타임라인 이동 · ${h.label}`); });
    tl.appendChild(b);
  });
  tl.scrollLeft = tl.scrollWidth;
}

// =============================================================== 선택
const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let hover = null;
let selection = [];
const hoverGroup = new THREE.Group(), selGroup = new THREE.Group();
overlay.add(hoverGroup, selGroup);
const filter = new Set(store.get('filter', ['face', 'edge', 'vertex']));

function pixelSize() {
  const h = renderer.domElement.clientHeight;
  return camera.isOrthographicCamera
    ? (camera.top - camera.bottom) / camera.zoom / h
    : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(controls.target) / h;
}

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const px = pixelSize();
  ray.params.Line.threshold = px * 5;
  ray.params.Points.threshold = px * 7;
  const allow = new Set((activeTool?.accept || ['face', 'edge', 'vertex']).filter((k) => filter.has(k)));
  const targets = [];
  views.forEach((v) => {
    if (!v.group.visible) return;
    targets.push(v.mesh);
    if (allow.has('edge') && showEdges) targets.push(v.lines);
    if (allow.has('vertex')) targets.push(v.points);
  });
  let hits = ray.intersectObjects(targets, false);
  if (sectionOn) hits = hits.filter((h) => sectionPlane.distanceToPoint(h.point) >= -1e-6);
  if (!hits.length) return null;
  const tol = Math.max(px * 6, modelSize * 0.002);
  const faceHit = hits.find((h) => h.object.userData.kind === 'face');
  const limit = (faceHit ? faceHit.distance : Infinity) + tol;
  hits = hits.filter((h) => h.distance <= limit && allow.has(h.object.userData.kind));
  if (!hits.length) return null;
  const near = hits[0].distance;
  const pref = { vertex: 0, edge: 1, face: 2 };
  hits = hits.filter((h) => h.distance - near < tol).sort((a, b) => pref[a.object.userData.kind] - pref[b.object.userData.kind]);
  const h = hits[0];
  const { body, kind } = h.object.userData;
  const v = views.get(body);
  const index = kind === 'face' ? v.triFace[h.faceIndex] : kind === 'edge' ? v.segEdge[Math.floor(h.index / 2)] : h.index;
  return { body, kind, index, rev: v.rev, point: h.point.toArray(), ftype: kind === 'face' ? v.data.faces[index].type : null, screen: [ev.clientX, ev.clientY] };
}

function highlight(group, item, color) {
  const v = views.get(item.body);
  if (!v) return;
  if (item.kind === 'face') {
    const [start, count] = v.faceTris[item.index];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', v.mesh.geometry.getAttribute('position'));
    g.setIndex(Array.from(v.mesh.geometry.index.array.slice(start * 3, (start + count) * 3)));
    group.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: v.mesh.material.clippingPlanes })));
  } else if (item.kind === 'edge') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v.data.edges[item.index], 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false, linewidth: 2 }));
    l.renderOrder = 5;
    group.add(l);
  } else {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(v.data.vertices.slice(item.index * 3, item.index * 3 + 3), 3));
    const pt = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 11, sizeAttenuation: false, depthTest: false }));
    pt.renderOrder = 6;
    group.add(pt);
  }
}

function clearGroup(g) { while (g.children.length) { const c = g.children.pop(); c.geometry?.dispose(); c.material?.dispose(); } }

const KNAME = { face: '면', edge: '모서리', vertex: '점' };
const FTYPE = { plane: '평면', cylinder: '원통면', sphere: '구면', cone: '원뿔면', surface: '곡면' };
const pickLabel = (s) => `${bodyName(s.body)} · ${s.kind === 'face' ? FTYPE[s.ftype] || '면' : KNAME[s.kind]} ${s.index + 1}`;

function redrawSelection() {
  clearGroup(selGroup);
  selection.forEach((s) => highlight(selGroup, s, COLORS.sel));
  $('#status-sel').textContent = selection.length ? `${selection.length}개 선택` : '';
}

function clearSelection() {
  selection = [];
  redrawSelection();
  clearDims();
  hideCtx();
  activeTool?.refresh?.();
}

const same = (a, b) => a.body === b.body && a.kind === b.kind && a.index === b.index;

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; hideCtx(); });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || e.altKey || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const hit = pick(e);
  if (!hit) { if (!activeTool?.onPick) clearSelection(); return; }
  if (activeTool?.onPick) { activeTool.onPick(hit); return; }
  selectedBody = hit.body;
  const i = selection.findIndex((s) => same(s, hit));
  const max = activeTool?.max ?? 2;
  if (i >= 0) selection.splice(i, 1);
  else {
    if (max === 1) selection = [];
    selection.push(hit);
    while (selection.length > max) selection.shift();
  }
  redrawSelection();
  renderBrowser();
  activeTool?.refresh?.();
  if (i < 0 && (!activeTool || activeTool === TOOLS.select)) showCtx(hit);
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const hit = pick(e);
  if (hover && hit && same(hover, hit)) return;
  hover = hit;
  clearGroup(hoverGroup);
  if (hit) highlight(hoverGroup, hit, COLORS.hover);
  renderer.domElement.style.cursor = hit ? 'pointer' : 'default';
});
renderer.domElement.addEventListener('pointerleave', () => { hover = null; clearGroup(hoverGroup); });
renderer.domElement.addEventListener('dblclick', () => fitView());
controls.addEventListener('start', hideCtx);

// =============================================================== 부품 끌기(솔리드웍스: 왼쪽 드래그 이동, Shift+드래그 회전)
let cdrag = null;
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.altKey || (activeTool && activeTool !== TOOLS.select && activeTool !== TOOLS.measure)) return;
  if (state.bodies.length < 2) return; // 부품이 여러 개(어셈블리)일 때만
  const hit = pick(e);
  if (!hit) return;
  const b = state.bodies.find((x) => x.id === hit.body);
  if (!b) return;
  const n = camera.getWorldDirection(new THREE.Vector3());
  const center = new THREE.Box3().setFromObject(views.get(b.id).mesh).getCenter(new THREE.Vector3());
  cdrag = { body: b.id, fixed: b.fixed, x: e.clientX, y: e.clientY, active: false, rotate: e.shiftKey,
    plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, new THREE.Vector3(...hit.point)), from: new THREE.Vector3(...hit.point),
    center, axis: n.clone().negate(), matrix: null, busy: false, queued: null };
});
function dragMatrix(e) {
  if (cdrag.rotate) {
    const ang = THREE.MathUtils.degToRad((e.clientX - cdrag.x) * 0.5);
    const m = new THREE.Matrix4().makeTranslation(cdrag.center.x, cdrag.center.y, cdrag.center.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(cdrag.axis, ang))
      .multiply(new THREE.Matrix4().makeTranslation(-cdrag.center.x, -cdrag.center.y, -cdrag.center.z));
    return m;
  }
  const r = renderer.domElement.getBoundingClientRect();
  ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
  const p = ray.ray.intersectPlane(cdrag.plane, new THREE.Vector3());
  if (!p) return null;
  const d = p.sub(cdrag.from);
  return new THREE.Matrix4().makeTranslation(d.x, d.y, d.z);
}
const rows = (m) => { const a = m.elements; return [a[0], a[4], a[8], a[12], a[1], a[5], a[9], a[13], a[2], a[6], a[10], a[14]]; };
function applyMoves(moves) {
  const none = !Object.keys(moves).length;
  views.forEach((v, id) => {
    if (none) { v.group.matrixAutoUpdate = true; v.group.updateMatrix(); return; }
    const m = moves[id];
    v.group.matrixAutoUpdate = false;
    v.group.matrix.identity();
    if (m) v.group.matrix.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], 0, 0, 0, 1);
    v.group.matrixWorldNeedsUpdate = true;
  });
}
async function sendPreview() {
  if (!cdrag || cdrag.busy || !cdrag.queued) return;
  cdrag.busy = true;
  const m = cdrag.queued;
  cdrag.queued = null;
  try {
    const r = await post('/api/drag/preview', { body: cdrag.body, matrix: m });
    if (cdrag?.active) applyMoves(r.moves);
  } catch (err) { toast(err.message, true); cdrag = null; applyMoves({}); controls.enabled = true; return; }
  if (cdrag) { cdrag.busy = false; if (cdrag.queued) sendPreview(); }
}
window.addEventListener('pointermove', (e) => {
  if (!cdrag) return;
  if (!cdrag.active) {
    if (Math.hypot(e.clientX - cdrag.x, e.clientY - cdrag.y) < 5) return;
    if (cdrag.fixed) { toast(`고정 부품은 끌 수 없습니다 — 어셈블리 › 고정/해제`, true); cdrag = null; return; }
    cdrag.active = true;
    controls.enabled = false;
    hideCtx();
    renderer.domElement.style.cursor = cdrag.rotate ? 'ew-resize' : 'grabbing';
  }
  const m = dragMatrix(e);
  if (!m) return;
  cdrag.matrix = rows(m);
  cdrag.queued = cdrag.matrix;
  sendPreview();
});
window.addEventListener('pointerup', () => {
  if (!cdrag) return;
  const d = cdrag;
  cdrag = null;
  controls.enabled = true;
  renderer.domElement.style.cursor = 'default';
  if (!d.active || !d.matrix) return;
  downAt = null; // 선택 클릭으로 처리하지 않음
  safe(async () => {
    const s = await post('/api/drag/commit', { body: d.body, matrix: d.matrix });
    await applyState(s);
  }).finally(() => applyMoves({}));
}, true);

// =============================================================== 상황별 툴바(선택 근처에 뜨는 버튼)
function showCtx(hit) {
  const items = [];
  const two = selection.length === 2 ? selection : null;
  if (two && two.every((s) => s.kind === 'face' && s.ftype === 'plane') && two[0].body === two[1].body) items.push('distance');
  if (hit.kind === 'face') {
    if (hit.ftype === 'cylinder') items.push('diameter');
    items.push('offset');
    if (hit.ftype === 'plane') items.push('sketch', 'push_pull', 'hole');
    items.push('delete_faces');
  } else if (hit.kind === 'edge') items.push('fillet', 'chamfer');
  items.push('measure');
  const bar = $('#ctxbar');
  bar.innerHTML = '';
  items.forEach((id) => {
    const c = CMD[id];
    const b = document.createElement('button');
    b.innerHTML = icon(c.icon, 18);
    b.title = c.name + (c.key ? ` (${c.key})` : '');
    b.onclick = () => { hideCtx(); runCmd(id); };
    bar.appendChild(b);
  });
  const r = vp.getBoundingClientRect();
  bar.hidden = false;
  const w = items.length * 34 + 8;
  bar.style.left = `${Math.min(Math.max(8, hit.screen[0] - r.left + 14), r.width - w - 8)}px`;
  bar.style.top = `${Math.min(Math.max(56, hit.screen[1] - r.top + 14), r.height - 56)}px`;
}
function hideCtx() { $('#ctxbar').hidden = true; }

// =============================================================== 치수선
const labels = [];
function clearDims() {
  overlay.children.filter((c) => c.userData.dim).forEach((c) => { overlay.remove(c); c.geometry?.dispose(); c.material?.dispose(); });
  labels.splice(0).forEach((l) => l.el.remove());
}
function drawDim(p1, p2, text) {
  const a = new THREE.Vector3(...p1), b = new THREE.Vector3(...p2);
  const g = new THREE.BufferGeometry().setFromPoints([a, b]);
  const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: COLORS.dim, dashSize: modelSize / 90, gapSize: modelSize / 180, depthTest: false }));
  line.computeLineDistances();
  line.renderOrder = 7;
  line.userData.dim = true;
  const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints([a, b]), new THREE.PointsMaterial({ color: COLORS.dim, size: 7, sizeAttenuation: false, depthTest: false }));
  dots.renderOrder = 7;
  dots.userData.dim = true;
  overlay.add(line, dots);
  const el = document.createElement('div');
  el.className = 'label3d';
  el.textContent = text;
  vp.appendChild(el);
  labels.push({ el, at: a.clone().add(b).multiplyScalar(0.5) });
}
function updateLabels() {
  const w = vp.clientWidth, h = vp.clientHeight;
  labels.forEach(({ el, at }) => {
    const p = at.clone().project(camera);
    el.style.left = `${(p.x + 1) / 2 * w}px`;
    el.style.top = `${(1 - p.y) / 2 * h}px`;
    el.style.display = p.z < 1 ? '' : 'none';
  });
}

// =============================================================== 보기(부드러운 카메라 이동)
let anim = null;
function animateTo(pos, target, up, zoom = null) {
  const from = { pos: camera.position.clone(), target: controls.target.clone(), up: camera.up.clone(), zoom: ortho.zoom };
  anim = { from, to: { pos, target, up, zoom: zoom ?? ortho.zoom }, t0: performance.now(), dur: 380 };
}
function stepAnim(now) {
  if (!anim) return;
  const k = Math.min(1, (now - anim.t0) / anim.dur);
  const e = 1 - (1 - k) ** 3;
  const { from, to } = anim;
  const pos = from.pos.clone().lerp(to.pos, e);
  const up = from.up.clone().lerp(to.up, e).normalize();
  [persp, ortho].forEach((c) => { c.position.copy(pos); c.up.copy(up); });
  controls.target.lerpVectors(from.target, to.target, e);
  ortho.zoom = from.zoom + (to.zoom - from.zoom) * e;
  ortho.updateProjectionMatrix();
  if (k === 1) anim = null;
}

function frame(dir, up, animate = true) {
  const box = worldBox();
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  const r = box.isEmpty() ? 50 : box.getSize(new THREE.Vector3()).length() / 2 || 50;
  const d = r / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2)) * 1.05;
  persp.near = r / 200; persp.far = r * 200; persp.updateProjectionMatrix();
  const asp = vp.clientWidth / vp.clientHeight || 1;
  ortho.top = r * 1.1; ortho.bottom = -r * 1.1; ortho.left = -r * 1.1 * asp; ortho.right = r * 1.1 * asp;
  ortho.updateProjectionMatrix();
  const pos = c.clone().addScaledVector(dir.clone().normalize(), d);
  if (animate) animateTo(pos, c, up, 1);
  else { [persp, ortho].forEach((cm) => { cm.position.copy(pos); cm.up.copy(up); }); controls.target.copy(c); ortho.zoom = 1; ortho.updateProjectionMatrix(); controls.update(); }
}
function fitView(animate = true) {
  const dir = camera.position.clone().sub(controls.target);
  if (dir.lengthSq() < 1e-9) dir.set(1, -1.3, 0.9);
  frame(dir, camera.up.clone(), animate);
}
const VIEWS = {
  front: { dir: [0, -1, 0], name: '정면', key: 'Ctrl+1' }, back: { dir: [0, 1, 0], name: '후면', key: 'Ctrl+2' },
  left: { dir: [-1, 0, 0], name: '좌측면', key: 'Ctrl+3' }, right: { dir: [1, 0, 0], name: '우측면', key: 'Ctrl+4' },
  top: { dir: [0, 0, 1], name: '윗면', key: 'Ctrl+5' }, bottom: { dir: [0, 0, -1], name: '아랫면', key: 'Ctrl+6' },
  iso: { dir: [1, -1.3, 0.9], name: '등각', key: 'Ctrl+7' },
};
function viewDir(d) {
  const dir = new THREE.Vector3(...d).normalize();
  const up = Math.abs(dir.z) > 0.999 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  frame(dir, up);
}
function setView(name) { viewDir(VIEWS[name].dir); }

function setProjection(isOrtho) {
  const next = isOrtho ? ortho : persp;
  if (next === camera) return;
  next.position.copy(camera.position);
  next.up.copy(camera.up);
  camera = next;
  controls.object = camera;
  store.set('ortho', isOrtho);
  fitView(false);
  renderHud();
}

function setSection(on, axis = 'z', offset = 0, flip = false) {
  sectionOn = on;
  const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[axis];
  sectionPlane.normal.set(...n).multiplyScalar(flip ? -1 : 1);
  sectionPlane.constant = flip ? -offset : offset;
  views.forEach((v) => {
    const clip = on ? [sectionPlane] : [];
    v.mesh.material.clippingPlanes = clip;
    v.lines.material.clippingPlanes = clip;
    v.mesh.material.needsUpdate = v.lines.material.needsUpdate = true;
  });
  renderHud();
}

// =============================================================== 뷰큐브
const cubeR = new THREE.WebGLRenderer({ alpha: true, antialias: true });
cubeR.setPixelRatio(Math.min(window.devicePixelRatio, 2));
cubeR.setSize(120, 120);
$('#viewcube').appendChild(cubeR.domElement);
const cubeScene = new THREE.Scene();
const cubeCam = new THREE.OrthographicCamera(-1.05, 1.05, 1.05, -1.05, 0.1, 10);
cubeScene.add(new THREE.HemisphereLight(0xffffff, 0x99a3b3, 2.4));
// Z가 위인 좌표계에 맞춰 상자를 X축으로 90° 눕힌다 → 재질 순서: +X −X +Z(윗면) −Z(아랫면) −Y(정면) +Y(후면)
const FACE_LABELS = ['우측', '좌측', '윗면', '아랫면', '정면', '후면'];
const cubeMats = FACE_LABELS.map(() => new THREE.MeshLambertMaterial({ color: 0xffffff }));
const cube = new THREE.Mesh(new THREE.BoxGeometry(1.15, 1.15, 1.15).rotateX(Math.PI / 2), cubeMats);
cubeScene.add(cube);
cubeScene.add(new THREE.LineSegments(new THREE.EdgesGeometry(cube.geometry), new THREE.LineBasicMaterial({ color: 0x8792a2 })));
const AX = [[0xdc2626, [1, 0, 0]], [0x16a34a, [0, 1, 0]], [0x2563eb, [0, 0, 1]]];
AX.forEach(([c, d]) => cubeScene.add(new THREE.ArrowHelper(new THREE.Vector3(...d), new THREE.Vector3(-0.58, -0.58, -0.58), 0.95, c, 0.16, 0.09)));
let cubeHover = -1;
function drawCubeFaces() {
  const dark = theme === 'dark';
  cubeMats.forEach((m, i) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const x = cv.getContext('2d');
    x.fillStyle = i === cubeHover ? (dark ? '#2f4677' : '#dbe6ff') : (dark ? '#2a2f38' : '#f3f5f8');
    x.fillRect(0, 0, 128, 128);
    x.fillStyle = dark ? '#d6dbe3' : '#374151';
    x.font = '600 30px "Pretendard","Malgun Gothic",sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(FACE_LABELS[i], 64, 66);
    m.map?.dispose();
    m.map = new THREE.CanvasTexture(cv);
    m.map.colorSpace = THREE.SRGBColorSpace;
    m.needsUpdate = true;
  });
}
const cubeRay = new THREE.Raycaster();
function cubeHit(e) {
  const r = cubeR.domElement.getBoundingClientRect();
  cubeRay.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cubeCam);
  return cubeRay.intersectObject(cube)[0];
}
cubeR.domElement.addEventListener('pointermove', (e) => {
  const h = cubeHit(e);
  const f = h ? Math.floor(h.faceIndex / 2) : -1;
  if (f !== cubeHover) { cubeHover = f; drawCubeFaces(); }
});
cubeR.domElement.addEventListener('pointerleave', () => { cubeHover = -1; drawCubeFaces(); });
cubeR.domElement.addEventListener('click', (e) => {
  const h = cubeHit(e);
  if (!h) return;
  // 모서리·꼭짓점 근처를 누르면 그 방향(대각선) 보기
  const p = h.point;
  const d = [p.x, p.y, p.z].map((v) => (Math.abs(v) > 0.38 ? Math.sign(v) : 0));
  viewDir(d);
});

// =============================================================== HUD(뷰포트 위 보기 도구)
function renderHud() {
  const vbtn = (name) => `<button data-view="${name}" title="${VIEWS[name].name} (${VIEWS[name].key})">${icon(name === 'iso' ? 'views' : 'box', 18)}</button>`;
  $('#hud-views').innerHTML = `<button data-act="fit" title="전체 보기 (F)">${icon('fit', 18)}</button>${vbtn('iso')}`;
  $('#hud-display').innerHTML = `
    <button data-act="shaded" class="${!wire ? 'on' : ''}" title="음영">${icon('shaded', 18)}</button>
    <button data-act="wire" class="${wire ? 'on' : ''}" title="와이어프레임">${icon('wire', 18)}</button>
    <button data-act="edges" class="${showEdges ? 'on' : ''}" title="모서리 표시">${icon('edges', 18)}</button>
    <button data-act="proj" title="${camera === ortho ? '평행 투영 → 원근' : '원근 투영 → 평행'}">${icon(camera === ortho ? 'ortho' : 'persp', 18)}</button>
    <button data-tool="section" class="${sectionOn ? 'on' : ''}" title="단면도">${icon('section', 18)}</button>`;
  $$('#hud [data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));
  $$('#hud [data-act]').forEach((b) => (b.onclick = () => ACT[b.dataset.act]()));
  $$('#hud [data-tool]').forEach((b) => (b.onclick = () => runCmd(b.dataset.tool)));
}
function renderFilter() {
  $('#filter').innerHTML = ['face', 'edge', 'vertex'].map((k) => `<button data-k="${k}" class="${filter.has(k) ? 'on' : ''}" title="${KNAME[k]} 선택 켜기/끄기">${icon(k, 14)}${KNAME[k]}</button>`).join('');
  $$('#filter button').forEach((b) => (b.onclick = () => {
    filter.has(b.dataset.k) ? filter.delete(b.dataset.k) : filter.add(b.dataset.k);
    store.set('filter', [...filter]);
    renderFilter();
  }));
}

// =============================================================== 속성 패널 도구
let activeTool = null;
const panelBody = $('#panel-body');

function bodyName(id) { return state.bodies.find((b) => b.id === id)?.name ?? '—'; }
function targetBody() { return selection[0]?.body ?? selectedBody ?? state.bodies[0]?.id; }

const field = (label, id, value, unit = 'mm', attrs = '') =>
  `<div class="row"><label for="${id}">${label}</label><div class="unit"><input id="${id}" type="number" step="any" value="${value}" ${attrs}><span>${unit}</span></div></div>`;
const select = (label, id, opts) => `<div class="row"><label for="${id}">${label}</label><select id="${id}">${opts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`;
const seg = (id, opts, cur) => `<div class="seg" id="${id}">${opts.map(([v, t]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${t}</button>`).join('')}</div>`;
const check = (label, id, on = false) => `<div class="row"><label for="${id}">${label}</label><input id="${id}" type="checkbox" ${on ? 'checked' : ''} style="justify-self:start"></div>`;
const num = (id) => { const v = parseFloat($('#' + id).value); if (!Number.isFinite(v)) throw new Error('숫자를 입력하세요'); return v; };
const val = (id) => $('#' + id).value;
const actions = (ok = '적용') => `<div class="btns"><button class="ok" id="ok">${icon('check', 16)}${ok}</button><button id="cancel">닫기</button></div><div class="err" id="err"></div>`;
const kv = (rows) => `<dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;

function picksBox(kind, hint) {
  const items = selection.filter((s) => !kind || s.kind === kind);
  return `<div class="picks ${items.length ? '' : 'active'}">${items.map((s) => `<div class="pk">${icon(s.kind, 14)}<span>${pickLabel(s)}</span></div>`).join('') || `<span class="none">${hint}</span>`}</div>`;
}
function segWire(id, onChange) {
  $$(`#${id} button`).forEach((b) => (b.onclick = () => { $$(`#${id} button`).forEach((x) => x.classList.toggle('on', x === b)); onChange?.(b.dataset.v); }));
}
const segVal = (id) => $(`#${id} .on`)?.dataset.v;
function bindOk(fn) {
  $('#ok')?.addEventListener('click', () => submit(fn));
  $('#cancel')?.addEventListener('click', () => setTool(null));
  $$('#panel-body input').forEach((i) => i.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(fn); }));
}
async function submit(fn) {
  const el = () => $('#err');
  try { if (el()) el().textContent = ''; await fn(); } catch (e) { if (el()) el().textContent = e.message; toast(e.message, true); }
}
async function runOp(payload, msg) {
  const s = await post('/api/op', payload);
  await applyState(s);
  toast(msg || s.history.at(-1).label);
}
// 입력값을 유지한 채 다시 그리기
function keepInputs(fn) {
  const saved = {};
  $$('#panel-body input, #panel-body select').forEach((i) => { if (i.id) saved[i.id] = i.type === 'checkbox' ? i.checked : i.value; });
  const segs = {};
  $$('#panel-body .seg').forEach((s) => { segs[s.id] = segVal(s.id); });
  fn();
  Object.entries(saved).forEach(([id, v]) => { const i = $('#' + id); if (i && !i.dataset.fresh) i.type === 'checkbox' ? (i.checked = v) : (i.value = v); });
  Object.entries(segs).forEach(([id, v]) => { const b = $(`#${id} [data-v="${v}"]`); if (b) b.click(); });
}

function infoRows(d) {
  const r = [['종류', d.type]];
  if (d.point) r.push(['좌표', P3(d.point)]);
  if (d.length != null) r.push(['길이', L(d.length)]);
  if (d.diameter != null) r.push(['지름', 'Ø' + L(d.diameter)], ['반지름', 'R' + L(d.radius)]);
  else if (d.radius != null) r.push(['반지름', 'R' + L(d.radius)]);
  if (d.area != null) r.push(['면적', A(d.area)]);
  if (d.center) r.push(['중심', P3(d.center)]);
  if (d.normal) r.push(['법선', D3(d.normal)]);
  if (d.axis) r.push(['축', D3(d.axis)]);
  if (d.start) r.push(['시작', P3(d.start)], ['끝', P3(d.end)]);
  if (d.half_angle != null) r.push(['반각', `${fmt(d.half_angle, 2)}°`]);
  return r;
}

const TOOLS = {
  select: {
    title: '선택', icon: 'info', max: 2,
    render() {
      if (selection.length) { TOOLS.measure.render.call(TOOLS.measure, true); return; }
      panelBody.innerHTML = `<p class="hint">면·모서리·점을 클릭하면 치수가 바로 나오고, 옆에 뜨는 버튼으로 곧장 편집할 수 있습니다.</p>
        <div class="sect">마우스</div><ul class="tips">
        <li><span>회전</span><span>가운데 드래그 · Alt+왼쪽</span></li><li><span>이동</span><span>Ctrl+가운데 · 오른쪽</span></li><li><span>확대(드래그)</span><span>Shift+가운데</span></li>
        <li><span>확대</span><span>휠 (커서 위치 기준)</span></li><li><span>전체 보기</span><span>F · 더블클릭</span></li></ul>
        <div class="sect">키보드 (솔리드웍스와 동일)</div><ul class="tips">
        <li><span>보기 방향 메뉴</span><span><kbd>Space</kbd></span></li>
        <li><span>정면·후면·좌·우·윗·아랫·등각</span><span><kbd>Ctrl 1</kbd>–<kbd>7</kbd></span></li>
        <li><span>면에 수직</span><span><kbd>Ctrl 8</kbd></span></li>
        <li><span>회전 15° / 90°</span><span><kbd>←↑→↓</kbd> <kbd>Shift</kbd></span></li>
        <li><span>회전(롤) / 이동</span><span><kbd>Alt ←→</kbd> <kbd>Ctrl ←→</kbd></span></li>
        <li><span>축소 / 확대</span><span><kbd>Z</kbd> <kbd>Shift Z</kbd></span></li>
        <li><span>전체 보기</span><span><kbd>F</kbd></span></li>
        <li><span>명령 검색</span><span><kbd>S</kbd></span></li>
        <li><span>마지막 명령 반복</span><span><kbd>Enter</kbd></span></li>
        <li><span>재생성</span><span><kbd>Ctrl B</kbd> <kbd>Ctrl Q</kbd></span></li>
        <li><span>복사 / 붙여넣기</span><span><kbd>Ctrl C</kbd> <kbd>Ctrl V</kbd></span></li>
        <li><span>새 문서 / 열기</span><span><kbd>Ctrl N</kbd> <kbd>Ctrl O</kbd></span></li>
        <li><span>취소 / 다시</span><span><kbd>Ctrl Z</kbd> <kbd>Ctrl Y</kbd></span></li>
        <li><span>저장</span><span><kbd>Ctrl S</kbd></span></li></ul>`;
    },
  },

  measure: {
    title: '측정', icon: 'measure', max: 2,
    render(fromSelect = false) {
      panelBody.innerHTML = (fromSelect ? '' : `<p class="hint">요소 1개: 크기 · 2개: 거리·각도. 값 옆 입력칸에 새 값을 넣으면 형상이 그 치수로 바뀝니다.</p>`) + `<div id="minfo"></div>`;
      this.fill();
    },
    async fill() {
      clearDims();
      const box = $('#minfo');
      if (!box) return;
      if (!selection.length) { box.innerHTML = picksBox(null, '측정할 요소를 클릭하세요'); return; }
      const sel = [...selection];
      try {
        const r = await post('/api/measure', { picks: sel.map(({ body, kind, index }) => ({ body, kind, index })) });
        if (r.single) {
          const d = r.single;
          let html = '';
          if (d.diameter != null && sel[0].kind === 'face' && d.type === '원통면') {
            html += `<div class="big"><span>지름</span><b>Ø${fmt(d.diameter / U(), 3)}</b></div><div class="edit-inline"><input id="newdia" type="number" step="any" value="${fmt(d.diameter / U(), 4)}"><button id="apply-dia">지름 변경</button></div>`;
          } else if (d.length != null) html += `<div class="big"><span>길이</span><b>${fmt(d.length / U(), 3)}</b></div>`;
          else if (d.area != null) html += `<div class="big"><span>면적</span><b>${fmt(d.area / U() ** 2, 2)}</b></div>`;
          box.innerHTML = html + kv(infoRows(d));
          $('#apply-dia')?.addEventListener('click', () => submit(() => runOp({ op: 'set_diameter', body: sel[0].body, faces: [sel[0].index], params: { diameter: num('newdia') * U() } })));
          $('#newdia')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#apply-dia').click(); });
          return;
        }
        const p = r.pair;
        const main = p.parallel_distance ?? p.center_distance ?? p.distance;
        const mainName = p.parallel_distance != null ? '평행 거리' : p.center_distance != null ? '중심 거리' : '최소 거리';
        const editable = p.parallel_distance != null && sel[0].body === sel[1].body && sel.every((s) => s.kind === 'face');
        let html = `<div class="big"><span>${mainName}</span><b>${fmt(main / U(), 3)}</b></div>`;
        if (editable) html += `<div class="edit-inline"><input id="newdist" type="number" step="any" value="${fmt(main / U(), 4)}"><button id="apply-dist" title="두 번째로 고른 면을 옮깁니다">거리 변경</button></div>`;
        const rows = [['최소 거리', L(p.distance)], ['dX', L(p.dx)], ['dY', L(p.dy)], ['dZ', L(p.dz)]];
        if (p.parallel_distance != null) rows.push(['평행 거리', L(p.parallel_distance)]);
        if (p.center_distance != null) rows.push(['중심 거리', L(p.center_distance)]);
        if (p.angle != null) rows.push(['각도', `${fmt(p.angle, 3)}°`]);
        box.innerHTML = html + kv(rows) + `<div class="sect">${pickLabel(sel[0])}</div>` + kv(infoRows(r.a)) + `<div class="sect">${pickLabel(sel[1])}</div>` + kv(infoRows(r.b));
        $('#apply-dist')?.addEventListener('click', () => submit(() => runOp({ op: 'set_distance', body: sel[1].body, faces: [sel[1].index, sel[0].index], params: { distance: num('newdist') * U() } })));
        $('#newdist')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#apply-dist').click(); });
        if (p.center_distance != null) drawDim(p.c1, p.c2, `${fmt(p.center_distance / U(), 2)}`);
        else if (p.distance > 1e-9) drawDim(p.p1, p.p2, `${fmt(p.distance / U(), 2)}`);
      } catch (e) { box.innerHTML = `<div class="err">${e.message}</div>`; }
    },
    refresh() { this.render(); },
  },

  mass: {
    title: '질량 특성', icon: 'mass', max: 1,
    render() {
      panelBody.innerHTML = `<div class="picks"><div class="pk">${icon('body', 14)}<b id="mb"></b></div></div>
        ${select('재질', 'mat', [['7.85', '강철 (7.85)'], ['2.70', '알루미늄 (2.70)'], ['8.96', '구리 (8.96)'], ['8.50', '황동 (8.50)'], ['4.43', '티타늄 (4.43)'], ['1.05', 'ABS (1.05)'], ['1.24', 'PLA (1.24)'], ['custom', '직접 입력']])}
        ${field('밀도', 'dens', 7.85, 'g/cm³')}<div id="mres"></div>`;
      $('#mat').onchange = () => { if (val('mat') !== 'custom') $('#dens').value = val('mat'); this.fill(); };
      $('#dens').onchange = () => { $('#mat').value = 'custom'; this.fill(); };
      this.fill();
    },
    async fill() {
      const id = targetBody();
      if (id == null) { $('#mres').innerHTML = '<p class="hint">바디가 없습니다.</p>'; return; }
      $('#mb').textContent = bodyName(id);
      const m = await api(`/api/mass/${id}?density=${num('dens')}`);
      $('#mres').innerHTML = `<div class="big"><span>질량</span><b>${fmt(m.mass, 2)} g</b></div>` + kv([
        ['부피', V(m.volume)], ['표면적', A(m.area)], ['무게중심', m.center ? P3(m.center) : '—'],
        ['크기 X', L(m.size[0], 2)], ['크기 Y', L(m.size[1], 2)], ['크기 Z', L(m.size[2], 2)],
        ['면 / 모서리', `${m.faces} / ${m.edges}`],
      ]);
    },
    refresh() { this.fill(); },
  },

  section: {
    title: '단면도', icon: 'section', max: 2,
    render() {
      panelBody.innerHTML = `<div class="sect">기준 평면</div>${seg('sax', [['z', 'XY'], ['y', 'XZ'], ['x', 'YZ']], 'z')}
        <div class="row" style="margin-top:12px"><label>위치</label><input id="sslide" type="range" min="0" max="1000" value="500"></div>
        ${field('좌표', 'soff', 0)}${check('방향 반전', 'sflip')}
        <div class="btns"><button id="soff-btn">${icon('close', 16)}단면 끄기</button></div>`;
      const upd = () => setSection(true, segVal('sax'), num('soff'), $('#sflip').checked);
      const slide = () => {
        const b = worldBox(), ax = segVal('sax');
        if (b.isEmpty()) return;
        $('#soff').value = fmt(b.min[ax] + (b.max[ax] - b.min[ax]) * $('#sslide').value / 1000, 3);
        upd();
      };
      segWire('sax', slide);
      $('#sslide').oninput = slide;
      $('#soff').oninput = () => { try { upd(); } catch { /* 입력 중 */ } };
      $('#sflip').onchange = upd;
      $('#soff-btn').onclick = () => { setSection(false); setTool(null); };
      slide();
    },
    refresh() { /* 선택은 단면에 영향 없음 */ },
  },

  primitive: {
    title: '기본 형상', icon: 'box', max: 0,
    render() {
      panelBody.innerHTML = seg('pk', [['box', '상자'], ['cylinder', '원통'], ['sphere', '구'], ['cone', '원뿔']], 'box') +
        `<div id="pf"></div><div class="sect">위치 (상자: 모서리 · 그 외: 아래 중심)</div>${field('X', 'px', 0)}${field('Y', 'py', 0)}${field('Z', 'pz', 0)}${actions('만들기')}`;
      const F = {
        box: field('가로 X', 'dx', 50) + field('세로 Y', 'dy', 30) + field('높이 Z', 'dz', 20),
        cylinder: field('지름', 'dia', 20) + field('높이', 'h', 30),
        sphere: field('지름', 'dia', 30),
        cone: field('아래 지름', 'd1', 30) + field('위 지름', 'd2', 0) + field('높이', 'h', 30),
      };
      const set = (k) => { $('#pf').innerHTML = F[k]; };
      segWire('pk', set);
      set('box');
      bindOk(async () => {
        const k = segVal('pk');
        const params = { x: num('px'), y: num('py'), z: num('pz') };
        if (k === 'box') Object.assign(params, { dx: num('dx'), dy: num('dy'), dz: num('dz') });
        if (k === 'cylinder') Object.assign(params, { r: num('dia') / 2, h: num('h') });
        if (k === 'sphere') Object.assign(params, { r: num('dia') / 2 });
        if (k === 'cone') Object.assign(params, { r1: num('d1') / 2, r2: num('d2') / 2, h: num('h') });
        await runOp({ op: 'primitive', kind: k, params });
        if (state.bodies.length === 1) fitView();
      });
    },
    refresh() {},
  },

  offset: faceTool('offset', '면 이동', 'offset', 30,
    '옮길 면을 고르세요(여러 개 가능). 평면은 평행 이동, 원통면은 반지름이 바뀌며 이웃 면이 자동으로 맞춰집니다.',
    () => field('거리 (+바깥)', 'dist', 2),
    (fs) => ({ op: 'offset_faces', body: fs[0].body, faces: fs.map((s) => s.index), params: { distance: num('dist') } })),

  diameter: faceTool('diameter', '지름 변경', 'diameter', 1, '구멍이나 축의 원통면을 고르세요.',
    () => field('새 지름', 'newd', selection[0]?.d ?? 10),
    (fs) => ({ op: 'set_diameter', body: fs[0].body, faces: [fs[0].index], params: { diameter: num('newd') } })),

  distance: {
    title: '거리 지정', icon: 'distance', accept: ['face'], max: 2,
    render() {
      panelBody.innerHTML = `<p class="hint">평행한 두 평면을 차례로 고르세요. <b>두 번째 면</b>이 움직입니다.</p>${picksBox('face', '기준 면 → 움직일 면')}${field('거리', 'dd', 10)}${actions()}`;
      bindOk(async () => {
        const fs = selection.filter((s) => s.kind === 'face');
        if (fs.length !== 2) throw new Error('평면 두 개를 고르세요');
        await runOp({ op: 'set_distance', body: fs[1].body, faces: [fs[1].index, fs[0].index], params: { distance: num('dd') } });
      });
    },
    refresh() { keepInputs(() => this.render()); },
  },

  push_pull: faceTool('push_pull', '돌출 / 컷', 'extrude', 1, '평면을 고르세요. + 는 면 모양 그대로 덧붙이고, − 는 파냅니다.',
    () => seg('ppdir', [['add', '돌출 +'], ['cut', '컷 −']], 'add') + field('거리', 'dist', 5, 'mm', 'min="0"'),
    (fs) => ({ op: 'push_pull', body: fs[0].body, faces: [fs[0].index], params: { distance: Math.abs(num('dist')) * (segVal('ppdir') === 'cut' ? -1 : 1) } })),

  hole: {
    title: '구멍', icon: 'hole', accept: ['face'], max: 1,
    render() {
      const p = selection[0]?.point ?? [0, 0, 0];
      panelBody.innerHTML = `<p class="hint">평면에서 구멍 낼 곳을 클릭하세요. 중심은 좌표로 정확히 맞출 수 있습니다.</p>${picksBox('face', '평면을 클릭하세요')}
        ${seg('htype', [['thru', '관통'], ['blind', '깊이 지정']], 'thru')}<div style="height:8px"></div>
        ${field('지름 Ø', 'hd', 6, 'mm', 'min="0"')}<div id="hdepth" hidden>${field('깊이', 'hdp', 10, 'mm', 'min="0"')}</div>
        <div class="sect">중심 좌표</div>${field('X', 'hx', fmt(p[0]), 'mm', 'data-fresh="1"')}${field('Y', 'hy', fmt(p[1]), 'mm', 'data-fresh="1"')}${field('Z', 'hz', fmt(p[2]), 'mm', 'data-fresh="1"')}${actions()}`;
      segWire('htype', (v) => { $('#hdepth').hidden = v !== 'blind'; });
      bindOk(async () => {
        const f = selection[0];
        if (!f) throw new Error('평면을 클릭하세요');
        await runOp({ op: 'hole', body: f.body, faces: [f.index], point: [num('hx'), num('hy'), num('hz')], params: { diameter: num('hd'), depth: segVal('htype') === 'blind' ? num('hdp') : 0 } });
      });
    },
    refresh() { keepInputs(() => this.render()); },
  },

  fillet: edgeTool('fillet', '필렛', 'fillet', '반지름 R', 'radius', 2),
  chamfer: edgeTool('chamfer', '챔퍼', 'chamfer', '거리 C', 'distance', 1),

  shell: {
    title: '쉘', icon: 'shell', accept: ['face'], max: 30,
    render() {
      panelBody.innerHTML = `<p class="hint">열어 둘 면을 고르세요. 고르지 않으면 닫힌 속 빈 형상이 됩니다.</p>${picksBox('face', '(열린 면 없음)')}${field('두께', 'th', 1.5, 'mm', 'min="0"')}${actions()}`;
      bindOk(async () => {
        const id = targetBody();
        if (id == null) throw new Error('바디가 없습니다');
        await runOp({ op: 'shell', body: id, faces: selection.filter((s) => s.kind === 'face' && s.body === id).map((s) => s.index), params: { thickness: num('th') } });
      });
    },
    refresh() { keepInputs(() => this.render()); },
  },

  delete_faces: faceTool('delete_faces', '면 삭제', 'deleteFace', 60,
    '지울 면(구멍 안쪽, 필렛, 챔퍼, 각인 등)을 고르세요. 주변 면을 늘려 자동으로 메웁니다.', () => '',
    (fs) => ({ op: 'delete_faces', body: fs[0].body, faces: fs.map((s) => s.index) }), '삭제'),

  boolean: {
    title: '결합', icon: 'union', max: 2,
    render() {
      const opts = state.bodies.map((b) => [b.id, b.name]);
      panelBody.innerHTML = seg('bop', [['union', '합치기'], ['cut', '빼기'], ['intersect', '교차']], 'union') + '<div style="height:8px"></div>' +
        select('대상', 'ba', opts) + select('도구', 'bb', opts) + check('도구 남기기', 'bk') +
        '<p class="hint">화면에서 대상 → 도구 순서로 클릭해도 됩니다.</p>' + actions();
      const ids = [...new Set(selection.map((s) => s.body))];
      if (ids[0] != null) $('#ba').value = ids[0];
      $('#bb').value = ids[1] ?? state.bodies.find((b) => b.id !== Number(val('ba')))?.id ?? '';
      bindOk(() => runOp({ op: 'boolean', kind: segVal('bop'), body: Number(val('ba')), tool: Number(val('bb')), params: { keep_tool: $('#bk').checked } }));
    },
    refresh() { const op = segVal('bop'); this.render(); $(`#bop [data-v="${op}"]`)?.click(); },
  },

  pattern: {
    title: '패턴', icon: 'pattern', max: 1,
    render() {
      panelBody.innerHTML = `<div class="picks"><div class="pk">${icon('body', 14)}<b>${bodyName(targetBody())}</b></div></div>` +
        seg('ptype', [['linear', '선형'], ['circular', '원형']], 'linear') + '<div id="pf"></div>' +
        field('개수(원본 포함)', 'pc', 4, '개', 'min="2" step="1"') + check('하나로 합치기', 'pm', true) + actions();
      const F = {
        linear: '<div class="sect">간격</div>' + field('X', 'pdx', 20) + field('Y', 'pdy', 0) + field('Z', 'pdz', 0),
        circular: '<div class="sect">회전축</div>' + seg('pax', [['z', 'Z'], ['x', 'X'], ['y', 'Y']], 'z') + field('전체 각도', 'pang', 360, '°') + field('중심 X', 'pcx', 0) + field('중심 Y', 'pcy', 0) + field('중심 Z', 'pcz', 0),
      };
      const set = (k) => { $('#pf').innerHTML = F[k]; if (k === 'circular') segWire('pax'); };
      segWire('ptype', set);
      set('linear');
      bindOk(async () => {
        const body = targetBody();
        const params = { count: Math.round(num('pc')), merge: $('#pm').checked };
        if (segVal('ptype') === 'linear') await runOp({ op: 'pattern_linear', body, params: { ...params, dx: num('pdx'), dy: num('pdy'), dz: num('pdz') } });
        else await runOp({ op: 'pattern_circular', body, params: { ...params, axis: segVal('pax'), angle: num('pang'), cx: num('pcx'), cy: num('pcy'), cz: num('pcz') } });
      });
    },
    refresh() { const b = $('#panel-body .picks b'); if (b) b.textContent = bodyName(targetBody()); },
  },

  translate: bodyTool('translate', '이동', 'move', () => field('dX', 'dx', 10) + field('dY', 'dy', 0) + field('dZ', 'dz', 0), () => ({ dx: num('dx'), dy: num('dy'), dz: num('dz') })),
  copy_body: bodyTool('copy_body', '복사', 'copy', () => field('dX', 'dx', 20) + field('dY', 'dy', 0) + field('dZ', 'dz', 0), () => ({ dx: num('dx'), dy: num('dy'), dz: num('dz') })),
  rotate: bodyTool('rotate', '회전', 'rotate', () => seg('ax', [['z', 'Z 축'], ['x', 'X 축'], ['y', 'Y 축']], 'z') + '<div style="height:8px"></div>' + field('각도', 'ang', 90, '°') + '<p class="hint">바디 중심을 기준으로 돌립니다.</p>', () => ({ axis: segVal('ax'), angle: num('ang') }), () => segWire('ax')),
  scale: bodyTool('scale', '크기', 'scale', () => check('균일 배율', 'uni', true) + field('X 배율', 'sx', 1, '×') + field('Y 배율', 'sy', 1, '×') + field('Z 배율', 'sz', 1, '×'),
    () => ($('#uni').checked ? { sx: num('sx'), sy: num('sx'), sz: num('sx') } : { sx: num('sx'), sy: num('sy'), sz: num('sz') }),
    () => { const t = () => ['sy', 'sz'].forEach((i) => { $('#' + i).disabled = $('#uni').checked; }); $('#uni').onchange = t; t(); }),
  mirror: bodyTool('mirror', '대칭', 'mirror', () => seg('mp', [['yz', 'YZ 면'], ['xz', 'XZ 면'], ['xy', 'XY 면']], 'yz') + '<div style="height:8px"></div>' + field('평면 위치', 'mo', 0), () => ({ plane: segVal('mp'), offset: num('mo') }), () => segWire('mp')),
};

function faceTool(id, title, ic, max, hint, fields, payload, okText = '적용') {
  return {
    title, icon: ic, accept: ['face'], max,
    render() {
      panelBody.innerHTML = `<p class="hint">${hint}</p>${picksBox('face', '면을 클릭하세요')}${fields()}${actions(okText)}`;
      $$('#panel-body .seg').forEach((s) => segWire(s.id));
      bindOk(async () => {
        const fs = selection.filter((s) => s.kind === 'face');
        if (!fs.length) throw new Error('면을 선택하세요');
        await runOp(payload(fs.filter((s) => s.body === fs[0].body)));
      });
      if (id === 'diameter') this.prefill();
    },
    async prefill() {
      const f = selection[0];
      if (!f || f.ftype !== 'cylinder') return;
      try {
        const r = await post('/api/measure', { picks: [{ body: f.body, kind: 'face', index: f.index }] });
        if ($('#newd')) $('#newd').value = fmt(r.single.diameter, 4);
      } catch { /* 무시 */ }
    },
    refresh() { keepInputs(() => this.render()); },
  };
}

function edgeTool(op, title, ic, label, key, def) {
  return {
    title, icon: ic, accept: ['edge'], max: 200,
    render() {
      panelBody.innerHTML = `<p class="hint">모서리를 클릭해 여러 개 고르세요(같은 바디).</p>${picksBox('edge', '모서리를 클릭하세요')}${field(label, 'ev', def, 'mm', 'min="0"')}${actions()}`;
      bindOk(async () => {
        const es = selection.filter((s) => s.kind === 'edge');
        if (!es.length) throw new Error('모서리를 선택하세요');
        await runOp({ op, body: es[0].body, edges: es.filter((s) => s.body === es[0].body).map((s) => s.index), params: { [key]: num('ev') } });
      });
    },
    refresh() { keepInputs(() => this.render()); },
  };
}

function bodyTool(op, title, ic, fields, params, after) {
  return {
    title, icon: ic, max: 1,
    render() {
      panelBody.innerHTML = `<div class="picks"><div class="pk">${icon('body', 14)}<b>${bodyName(targetBody())}</b></div></div><p class="hint">화면이나 모델 목록에서 대상 바디를 바꿀 수 있습니다.</p>${fields()}${actions()}`;
      after?.();
      bindOk(async () => {
        const target = targetBody();
        if (target == null) throw new Error('바디가 없습니다');
        await runOp({ op, body: target, params: params() });
      });
    },
    refresh() { const b = $('#panel-body .picks b'); if (b) b.textContent = bodyName(targetBody()); },
  };
}

function setTool(name) {
  activeTool?.leave?.();
  activeTool = TOOLS[name || 'select'];
  $$('[data-cmd]').forEach((b) => b.classList.toggle('on', b.dataset.cmd === name));
  if (activeTool.accept) selection = selection.filter((s) => activeTool.accept.includes(s.kind));
  if (activeTool.max !== undefined && selection.length > activeTool.max) selection = selection.slice(-activeTool.max);
  redrawSelection();
  clearDims();
  hideCtx();
  $('#panel-title').textContent = activeTool.title;
  $('#panel-icon').innerHTML = icon(activeTool.icon, 18);
  $('#panel-close').style.visibility = name ? 'visible' : 'hidden';
  activeTool.render();
  if (!activeTool.refresh) activeTool.refresh = () => activeTool.render();
  renderHud();
}
TOOLS.select.refresh = () => TOOLS.select.render();

// =============================================================== 어셈블리 · 시뮬레이션
const interfGroup = new THREE.Group(), simGroup = new THREE.Group(), resultGroup = new THREE.Group();
overlay.add(interfGroup, simGroup);
scene.add(resultGroup);

function suggestMate(sel) {
  if (sel.length < 2) return 'coincident';
  const round = (s) => s.ftype === 'cylinder' || s.kind === 'edge';
  return sel.every(round) ? 'concentric' : 'coincident';
}

function applyExplode() {
  const f = TOOLS.explode.factor || 0;
  const box = worldBox();
  const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  views.forEach((v) => {
    v.group.position.set(0, 0, 0);
    if (!f) return;
    const bc = new THREE.Box3().setFromObject(v.mesh).getCenter(new THREE.Vector3());
    const dir = bc.sub(c);
    if (dir.lengthSq() < 1e-9) dir.set(0, 0, 1).multiplyScalar(modelSize * 0.2);
    v.group.position.copy(dir.multiplyScalar(f * 1.2));
  });
}

// 응력·변위 색상표(파랑 → 청록 → 초록 → 노랑 → 빨강)
const CMAP = [[0.0, [0.12, 0.23, 0.86]], [0.25, [0.0, 0.72, 0.95]], [0.5, [0.18, 0.80, 0.25]], [0.75, [0.98, 0.85, 0.1]], [1.0, [0.90, 0.12, 0.10]]];
function cmap(t) {
  t = Math.min(1, Math.max(0, t));
  for (let i = 1; i < CMAP.length; i++) {
    if (t <= CMAP[i][0]) {
      const [t0, a] = CMAP[i - 1], [t1, b] = CMAP[i];
      const k = (t - t0) / (t1 - t0);
      return a.map((x, j) => x + (b[j] - x) * k);
    }
  }
  return CMAP.at(-1)[1];
}

function clearInterf() { clearGroup(interfGroup); }

Object.assign(TOOLS, {
  mate: {
    title: '메이트', icon: 'mate', accept: ['face', 'edge'], max: 2, type: 'coincident', userType: false,
    render() {
      if (!this.userType) this.type = suggestMate(selection);
      panelBody.innerHTML = `<p class="hint">두 부품에서 면(또는 원형 모서리)을 하나씩 고르세요. <b>두 번째로 고른 부품</b>이 움직이고, 고정 부품은 움직이지 않습니다.</p>
        ${picksBox(null, '① 기준 요소 → ② 움직일 요소')}
        ${seg('mtype', [['coincident', '일치'], ['distance', '거리'], ['concentric', '동심'], ['parallel', '평행'], ['perpendicular', '수직']], this.type)}
        <div id="moff" ${this.type === 'distance' ? '' : 'hidden'}>${field('거리', 'mdist', this.dist ?? 10)}</div>
        ${check('정렬 반전', 'malign', this.aligned)}<p class="hint">일치·거리는 기본으로 두 면이 마주 봅니다. 같은 방향을 보게 하려면 정렬 반전을 켜세요.</p>
        ${actions('메이트 추가')}`;
      segWire('mtype', (v) => { this.type = v; this.userType = true; $('#moff').hidden = v !== 'distance'; });
      $('#mdist').oninput = () => { this.dist = $('#mdist').value; };
      $('#malign').onchange = () => { this.aligned = $('#malign').checked; };
      bindOk(async () => {
        if (selection.length !== 2) throw new Error('요소 두 개를 고르세요');
        const [a, b] = selection;
        await runOp({ op: 'mate', kind: this.type, params: { ref: { body: a.body, kind: a.kind, index: a.index }, mov: { body: b.body, kind: b.kind, index: b.index }, offset: this.type === 'distance' ? num('mdist') : 0, aligned: $('#malign').checked } });
        selection = []; this.userType = false; redrawSelection(); this.render();
      });
    },
    refresh() { this.render(); },
  },

  interference: {
    title: '간섭 검사', icon: 'interfere', max: 0,
    render() {
      panelBody.innerHTML = `<p class="hint">보이는 부품끼리 서로 파고든 부피를 찾아 빨갛게 표시합니다.</p><div id="ires"></div>
        <div class="btns"><button class="ok" id="irun">${icon('interfere', 16)}다시 검사</button><button id="cancel">닫기</button></div>`;
      $('#irun').onclick = () => safe(() => this.run());
      $('#cancel').onclick = () => setTool(null);
      safe(() => this.run());
    },
    async run() {
      clearInterf();
      $('#ires').innerHTML = '<p class="hint">검사 중…</p>';
      const r = await api('/api/interference');
      if (!$('#ires')) return;
      if (!r.hits.length) { $('#ires').innerHTML = `<div class="big ok"><span>결과</span><b>간섭 없음</b></div>`; return; }
      r.hits.forEach((h) => {
        h.mesh.faces.forEach((f) => {
          if (!f.idx.length) return;
          const geo = new THREE.BufferGeometry();
          geo.setAttribute('position', new THREE.Float32BufferAttribute(f.pos, 3));
          geo.setIndex(f.idx);
          const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }));
          m.renderOrder = 8;
          interfGroup.add(m);
        });
      });
      views.forEach((v) => { v.mesh.material.transparent = true; v.mesh.material.opacity = 0.35; });
      $('#ires').innerHTML = `<div class="big bad"><span>간섭</span><b>${r.hits.length}곳</b></div>` +
        `<ul class="list">${r.hits.map((h) => `<li>${icon('interfere', 14)}<span>${h.a_name} ↔ ${h.b_name}</span><em>${V(h.volume)}</em></li>`).join('')}</ul>`;
    },
    leave() { clearInterf(); views.forEach((v) => { v.mesh.material.transparent = false; v.mesh.material.opacity = 1; }); },
    refresh() {},
  },

  explode: {
    title: '분해 보기', icon: 'explode', max: 0, factor: 0,
    render() {
      panelBody.innerHTML = `<p class="hint">부품을 어셈블리 중심에서 바깥으로 벌려 봅니다. 화면에만 적용되고 위치는 바뀌지 않습니다.</p>
        <div class="row"><label>분해 정도</label><input id="xf" type="range" min="0" max="100" value="${this.factor * 100}"></div>
        <div class="btns"><button id="cancel">닫기(원위치)</button></div>`;
      $('#xf').oninput = () => { this.factor = $('#xf').value / 100; applyExplode(); };
      $('#cancel').onclick = () => setTool(null);
    },
    leave() { this.factor = 0; applyExplode(); },
    refresh() { applyExplode(); },
  },

  simulate: {
    title: '정적 해석', icon: 'sim', accept: ['face'], max: 0,
    body: null, fixed: new Set(), load: new Set(), active: 'fixed', result: null, plot: 'vm', scale: 1, materials: null,
    async render() {
      if (!this.materials) this.materials = await api('/api/materials');
      if (this.body != null && !state.bodies.some((b) => b.id === this.body)) this.reset();
      if (this.body == null) this.body = targetBody() ?? null;
      const mats = this.materials.map((m) => [m.key, m.name]).concat([['custom', '직접 입력']]);
      const setBox = (key, title, hint) => {
        const items = [...this[key]];
        return `<div class="picks setbox ${key} ${this.active === key ? 'active' : ''}" data-set="${key}"><div class="sethead">${icon(key === 'fixed' ? 'pin' : 'stress', 14)}<b>${title}</b><span>${items.length ? `면 ${items.length}개` : hint}</span></div></div>`;
      };
      panelBody.innerHTML = `
        <div class="picks"><div class="pk">${icon('body', 14)}<b>${this.body != null ? bodyName(this.body) : '면을 클릭해 부품을 고르세요'}</b></div></div>
        <div class="sect">1 · 재질</div>${select('재질', 'smat', mats)}<div id="smat-custom" hidden>${field('탄성계수 E', 'sE', 210000, 'MPa')}${field('푸아송비', 'snu', 0.3, '')}${field('항복강도', 'sy', 275, 'MPa')}</div><div id="smat-info"></div>
        <div class="sect">2 · 고정(구속)</div>${setBox('fixed', '고정 면', '클릭해서 활성화 후 면 선택')}
        <div class="sect">3 · 외부 하중</div>${setBox('load', '하중 면', '클릭해서 활성화 후 면 선택')}
        ${seg('ltype', [['force', '힘 (N)'], ['pressure', '압력 (MPa)']], this.ltype || 'force')}<div style="height:6px"></div>
        ${field('크기', 'lval', this.lval ?? 1000, this.ltype === 'pressure' ? 'MPa' : 'N')}
        ${select('방향', 'ldir', [['normal', '면에 수직 (누름)'], ['-normal', '면에 수직 (당김)'], ['-z', '−Z (아래)'], ['z', '+Z'], ['-x', '−X'], ['x', '+X'], ['-y', '−Y'], ['y', '+Y']])}
        <div class="sect">4 · 메시</div>${seg('smesh', [['coarse', '거침'], ['normal', '보통'], ['fine', '세밀']], this.mesh || 'normal')}
        <div class="btns"><button class="ok" id="srun">${icon('sim', 16)}해석 실행</button><button id="cancel">닫기</button></div><div class="err" id="err"></div>
        <div id="sres"></div>`;
      $('#smat').value = this.mat || 'steel';
      if (this.ldir) $('#ldir').value = this.ldir;
      const matInfo = () => {
        const m = this.materials.find((x) => x.key === val('smat'));
        $('#smat-custom').hidden = !!m;
        $('#smat-info').innerHTML = m ? `<p class="hint">E ${m.E.toLocaleString()} MPa · ν ${m.nu} · 항복 ${m.yield} MPa · ${m.density} g/cm³</p>` : '';
        this.mat = val('smat');
      };
      $('#smat').onchange = matInfo; matInfo();
      segWire('ltype', (v) => { this.ltype = v; $('#lval').nextElementSibling.textContent = v === 'pressure' ? 'MPa' : 'N'; });
      segWire('smesh', (v) => { this.mesh = v; });
      $('#lval').oninput = () => { this.lval = $('#lval').value; };
      $('#ldir').onchange = () => { this.ldir = val('ldir'); };
      $$('.setbox').forEach((b) => (b.onclick = () => { this.active = b.dataset.set; this.render(); }));
      $('#srun').onclick = () => submit(() => this.run());
      $('#cancel').onclick = () => setTool(null);
      this.drawSets();
      if (this.result) this.showResult();
    },
    reset() { this.body = null; this.fixed.clear(); this.load.clear(); this.clearResult(); },
    onPick(hit) {
      if (hit.kind !== 'face') return;
      if (this.body != null && hit.body !== this.body) {
        if (this.fixed.size || this.load.size) { toast('한 부품 안에서만 면을 고를 수 있습니다 — 다른 부품을 해석하려면 닫았다 다시 여세요', true); return; }
      }
      this.body = hit.body;
      const set = this[this.active], other = this[this.active === 'fixed' ? 'load' : 'fixed'];
      set.has(hit.index) ? set.delete(hit.index) : (other.delete(hit.index), set.add(hit.index));
      this.clearResult();
      this.render();
    },
    drawSets() {
      clearGroup(simGroup);
      if (this.body == null) return;
      this.fixed.forEach((i) => highlight(simGroup, { body: this.body, kind: 'face', index: i }, 0x16a34a));
      this.load.forEach((i) => highlight(simGroup, { body: this.body, kind: 'face', index: i }, 0x9333ea));
    },
    material() {
      const m = this.materials.find((x) => x.key === val('smat'));
      return m ? { E: m.E, nu: m.nu, yield: m.yield } : { E: num('sE'), nu: num('snu'), yield: num('sy') };
    },
    async run() {
      if (this.body == null) throw new Error('해석할 부품의 면을 클릭하세요');
      if (!this.fixed.size) throw new Error('고정 면을 하나 이상 고르세요');
      if (!this.load.size) throw new Error('하중 면을 고르세요');
      $('#srun').disabled = true;
      $('#sres').innerHTML = '<p class="hint">메시 생성 · 해석 중… (보통 수 초)</p>';
      try {
        const t0 = performance.now();
        this.result = await post('/api/sim/static', {
          body: this.body, fixed: [...this.fixed], density: segVal('smesh'), material: this.material(),
          loads: [{ faces: [...this.load], type: segVal('ltype'), value: num('lval'), dir: val('ldir') }],
        });
        this.result.seconds = (performance.now() - t0) / 1000;
        this.scale = 1;
        this.showResult();
        toast(`해석 완료 · 최대 응력 ${fmt(this.result.max_vm, 2)} MPa`);
      } finally { if ($('#srun')) $('#srun').disabled = false; }
    },
    showResult() {
      const r = this.result;
      if (!r) return;
      const v = views.get(r.body);
      if (!v || v.rev !== r.rev) { this.clearResult(); return; }
      v.group.visible = false;
      clearGroup(simGroup);
      clearGroup(resultGroup);
      clearDims();
      const s = r.surface;
      const n = s.vm.length;
      const dmag = new Float32Array(n);
      for (let i = 0; i < n; i++) dmag[i] = Math.hypot(s.disp[i * 3], s.disp[i * 3 + 1], s.disp[i * 3 + 2]);
      const vals = this.plot === 'vm' ? s.vm : dmag;
      const max = this.plot === 'vm' ? r.max_vm : r.max_disp;
      const auto = r.max_disp > 0 ? modelSize * 0.06 / r.max_disp : 0;
      const k = auto * this.scale;
      const pos = new Float32Array(n * 3), col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < 3; j++) pos[i * 3 + j] = s.pos[i * 3 + j] + s.disp[i * 3 + j] * k;
        const c = cmap(max > 0 ? vals[i] / max : 0);
        col.set(c, i * 3);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geo.setIndex(s.idx);
      geo.computeVertexNormals();
      resultGroup.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, side: THREE.DoubleSide })));
      // 변형 전 윤곽(옅게)
      const ghost = new THREE.LineSegments(new THREE.BufferGeometry().copy(v.lines.geometry), new THREE.LineBasicMaterial({ color: 0x64748b, transparent: true, opacity: 0.35 }));
      resultGroup.add(ghost);
      const at = this.plot === 'vm' ? r.max_vm_at : r.max_disp_at;
      drawDim(at, at, this.plot === 'vm' ? `최대 ${fmt(r.max_vm, 2)} MPa` : `최대 ${L(r.max_disp, 4)}`);
      this.legend(max);
      const fos = r.fos;
      const cls = fos == null ? '' : fos < 1 ? 'bad' : fos < 1.5 ? 'warn' : 'ok';
      $('#sres').innerHTML = `<div class="sect">결과</div>
        ${fos != null ? `<div class="big ${cls}"><span>최소 안전계수</span><b>${fmt(fos, 2)}</b></div>` : ''}
        ${seg('splot', [['vm', '응력 (von Mises)'], ['disp', '변위']], this.plot)}
        <div class="row" style="margin-top:10px"><label>변형 배율</label><input id="sscale" type="range" min="0" max="300" value="${this.scale * 100}"></div>
        <p class="hint" id="sscale-t">실제 변형의 ${fmt(k, 1)}배로 과장해서 보여 줍니다</p>
        ${kv([['최대 응력', `${fmt(r.max_vm, 2)} MPa`], ['항복강도', r.yield ? `${r.yield} MPa` : '—'], ['최대 변위', L(r.max_disp, 4)],
        ['하중 합력', `${fmt(Math.hypot(...r.applied_force), 2)} N`], ['절점 / 요소', `${r.nodes.toLocaleString()} / ${r.elements.toLocaleString()}`], ['계산 시간', `${fmt(r.seconds, 1)} 초`]])}
        <p class="hint">${fos == null ? '' : fos < 1 ? '항복강도를 넘습니다 — 두께를 늘리거나 재질을 바꾸세요.' : fos < 1.5 ? '여유가 작습니다(안전계수 1.5 미만).' : '항복까지 충분한 여유가 있습니다.'} 고정 면 모서리의 응력 집중은 실제보다 크게 나올 수 있습니다.</p>
        <div class="btns"><button id="sclear">${icon('close', 16)}결과 지우기</button></div>`;
      segWire('splot', (p) => { this.plot = p; this.showResult(); });
      $('#sscale').oninput = () => { this.scale = $('#sscale').value / 100; this.showResult(); };
      $('#sclear').onclick = () => { this.clearResult(); this.render(); };
    },
    legend(max) {
      let el = $('#legend');
      if (!el) { el = document.createElement('div'); el.id = 'legend'; vp.appendChild(el); }
      const unit = this.plot === 'vm' ? 'MPa' : units;
      const scaleV = this.plot === 'vm' ? 1 : 1 / U();
      const ticks = [1, 0.8, 0.6, 0.4, 0.2, 0].map((t) => `<span>${fmt(max * t * scaleV, this.plot === 'vm' ? 1 : 4)}</span>`).join('');
      const stops = CMAP.map(([t, c]) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')}) ${(1 - t) * 100}%`).reverse().join(',');
      const y = this.plot === 'vm' && this.result.yield && this.result.yield < max ? `<i class="yield" style="top:${(1 - this.result.yield / max) * 100}%" title="항복강도"></i>` : '';
      el.innerHTML = `<b>${this.plot === 'vm' ? 'von Mises 응력' : '합 변위'} (${unit})</b><div class="lg"><div class="bar" style="background:linear-gradient(to bottom, ${CMAP.slice().reverse().map(([t, c]) => `rgb(${c.map((x) => Math.round(x * 255)).join(',')})`).join(',')})">${y}</div><div class="ticks">${ticks}</div></div>`;
      void stops;
    },
    clearResult() {
      this.result = null;
      clearGroup(resultGroup);
      clearDims();
      $('#legend')?.remove();
      views.forEach((v, id) => { v.group.visible = state.bodies.find((b) => b.id === id)?.visible ?? true; });
    },
    leave() { this.clearResult(); clearGroup(simGroup); },
    refresh() {
      // 형상이 바뀌면(실행 취소 등) 결과는 무효
      if (this.result && views.get(this.result.body)?.rev !== this.result.rev) { this.clearResult(); this.render(); return; }
      this.drawSets();
      if (this.result) views.get(this.result.body).group.visible = false;
    },
  },
});

// =============================================================== 솔리드웍스 방식 보기 조작
function orbitBy(axis, deg) {
  const off = camera.position.clone().sub(controls.target);
  const q = new THREE.Quaternion().setFromAxisAngle(axis.clone().normalize(), THREE.MathUtils.degToRad(deg));
  animateTo(controls.target.clone().add(off.applyQuaternion(q)), controls.target.clone(), camera.up.clone().applyQuaternion(q));
}
function screenAxes() {
  const dir = controls.target.clone().sub(camera.position).normalize();
  const right = dir.clone().cross(camera.up).normalize();
  const up = right.clone().cross(dir).normalize();
  return { dir, right, up };
}
function rollBy(deg) {
  const { dir } = screenAxes();
  const q = new THREE.Quaternion().setFromAxisAngle(dir, THREE.MathUtils.degToRad(deg));
  animateTo(camera.position.clone(), controls.target.clone(), camera.up.clone().applyQuaternion(q));
}
function panBy(dx, dy) {
  const { right, up } = screenAxes();
  const h = pixelSize() * renderer.domElement.clientHeight;
  const d = right.multiplyScalar(dx * h * 0.1).add(up.multiplyScalar(dy * h * 0.1));
  animateTo(camera.position.clone().add(d), controls.target.clone().add(d), camera.up.clone());
}
function zoomBy(f) {
  if (camera === ortho) { animateTo(camera.position.clone(), controls.target.clone(), camera.up.clone(), ortho.zoom * f); return; }
  const off = camera.position.clone().sub(controls.target).multiplyScalar(1 / f);
  animateTo(controls.target.clone().add(off), controls.target.clone(), camera.up.clone());
}
function normalTo() {
  const f = selection.find((s) => s.kind === 'face');
  if (!f) { toast('평면을 먼저 선택하세요 (Ctrl+8: 면에 수직으로 보기)', true); return; }
  const v = views.get(f.body);
  const fd = v.data.faces[f.index];
  const p = (i) => new THREE.Vector3(fd.pos[fd.idx[i] * 3], fd.pos[fd.idx[i] * 3 + 1], fd.pos[fd.idx[i] * 3 + 2]);
  const n = p(1).sub(p(0)).cross(p(2).sub(p(0))).normalize();
  viewDir(n.toArray());
}
function viewMenu(x, y) {
  let m = $('#viewmenu');
  if (!m) { m = document.createElement('div'); m.id = 'viewmenu'; document.body.appendChild(m); }
  const items = [...Object.entries(VIEWS).map(([k, v]) => [k, v.name, v.key]), ['normal', '면에 수직', 'Ctrl+8']];
  m.innerHTML = `<b>보기 방향</b>` + items.map(([k, n, key]) => `<button data-v="${k}">${icon(k === 'iso' ? 'views' : k === 'normal' ? 'face' : 'box', 16)}<span>${n}</span><kbd>${key}</kbd></button>`).join('');
  m.style.left = `${Math.min(x, innerWidth - 220)}px`;
  m.style.top = `${Math.min(y, innerHeight - 320)}px`;
  m.hidden = false;
  $$('button', m).forEach((b) => (b.onclick = () => { m.hidden = true; b.dataset.v === 'normal' ? normalTo() : setView(b.dataset.v); }));
  setTimeout(() => window.addEventListener('pointerdown', (e) => { if (!m.contains(e.target)) m.hidden = true; }, { once: true }), 0);
}

// =============================================================== 명령(리본 · 명령 검색 · 단축키가 공유)
const ACT = {
  new: () => safe(async () => { if (state.bodies.length && !confirm('새 문서를 만들까요? 저장하지 않은 변경은 사라집니다.')) return; await applyState(await post('/api/new', {}), { fit: true }); }),
  open: () => { fileMode = 'open'; $('#file').click(); },
  import: () => { fileMode = 'import'; $('#file').click(); },
  save: () => safe(() => download('/api/export/step', 'step')),
  stl: () => safe(() => download('/api/export/stl', 'stl')),
  png: () => {
    renderer.render(scene, camera);
    renderer.domElement.toBlob((b) => saveBlob(b, `${stem()}.png`), 'image/png');
  },
  sketch: () => safe(async () => {
    const f = selection.find((x) => x.kind === 'face' && x.ftype === 'plane');
    setTool(null);
    await sketchMode.open(f ? { body: f.body, face: f.index } : { base: 'xy' });
    if (!f) toast('평면을 고르지 않아 XY 기준면에 그립니다 — 부품 면에 그리려면 평면을 먼저 클릭하세요');
  }),
  drawing: () => safe(async () => {
    if (!state.bodies.some((b) => b.visible)) throw new Error('도면으로 만들 부품이 없습니다 — STEP을 먼저 여세요');
    setTool(null);
    await drawingMode.open();
  }),
  undo: () => safe(async () => { await applyState(await post('/api/op', { op: 'undo' })); toast('실행 취소'); }),
  redo: () => safe(async () => { await applyState(await post('/api/op', { op: 'redo' })); toast('다시 실행'); }),
  deleteBody: () => safe(async () => {
    const id = targetBody();
    if (id != null && confirm(`"${bodyName(id)}" 바디를 삭제할까요?`)) await runOp({ op: 'delete_body', body: id });
  }),
  fit: () => fitView(),
  shaded: () => { wire = false; views.forEach((v) => { v.mesh.material.wireframe = false; }); renderHud(); },
  wire: () => { wire = true; views.forEach((v) => { v.mesh.material.wireframe = true; }); renderHud(); },
  edges: () => { showEdges = !showEdges; store.set('edges', showEdges); views.forEach((v) => { v.lines.visible = showEdges; }); renderHud(); },
  proj: () => setProjection(camera !== ortho),
  theme: () => { theme = theme === 'dark' ? 'light' : 'dark'; store.set('theme', theme); applyTheme(); },
  units: () => { units = units === 'mm' ? 'in' : 'mm'; store.set('units', units); $('#btn-units').textContent = units; activeTool?.refresh?.(); toast(`표시 단위: ${units === 'mm' ? '밀리미터' : '인치'}`); },
  palette: () => openPalette(),
  fix: () => safe(async () => {
    const id = targetBody();
    if (id == null) return;
    const b = state.bodies.find((x) => x.id === id);
    await runOp({ op: 'fix', body: id, params: { fixed: !b.fixed } });
  }),
  rebuild: () => safe(() => runOp({ op: 'rebuild' }, '재생성 완료')),
  copyBody: () => { clip = targetBody(); if (clip != null) toast(`복사 · ${bodyName(clip)}`); },
  paste: () => safe(async () => { if (clip != null) await runOp({ op: 'copy_body', body: clip, params: { dx: modelSize * 0.1, dy: 0, dz: 0 } }); }),
};
let clip = null;
let lastCmd = null;

const CMD = {};
const RIBBON = [
  { tab: '파일', groups: [
    { name: '문서', items: [['new', '새 문서', 'new', null, ACT.new], ['open', '열기', 'open', 'Ctrl+O', ACT.open], ['import', '가져오기', 'import', null, ACT.import]] },
    { name: '내보내기', items: [['save', 'STEP 저장', 'save', 'Ctrl+S', ACT.save], ['stl', 'STL', 'stl', null, ACT.stl], ['png', '화면 PNG', 'image', null, ACT.png]] },
  ] },
  { tab: '직접 편집', groups: [
    { name: '스케치', items: [['sketch', '스케치', 'sketch', 'K', () => ACT.sketch()]] },
    { name: '면', items: [['offset', '면 이동', 'offset', 'O'], ['distance', '거리 지정', 'distance', 'D'], ['diameter', '지름 변경', 'diameter'], ['delete_faces', '면 삭제', 'deleteFace', 'Del']] },
    { name: '피처', items: [['push_pull', '돌출/컷', 'extrude', 'E'], ['hole', '구멍', 'hole', 'H'], ['fillet', '필렛', 'fillet', 'R'], ['chamfer', '챔퍼', 'chamfer', 'C'], ['shell', '쉘', 'shell']] },
    { name: '바디', items: [['primitive', '기본 형상', 'box'], ['boolean', '결합', 'union', 'B'], ['pattern', '패턴', 'pattern', 'P']] },
  ] },
  { tab: '배치', groups: [
    { name: '변환', items: [['translate', '이동', 'move', 'T'], ['rotate', '회전', 'rotate'], ['scale', '크기', 'scale'], ['mirror', '대칭', 'mirror']] },
    { name: '관리', items: [['copy_body', '복사', 'copy'], ['deleteBody', '바디 삭제', 'trash', null, ACT.deleteBody]] },
  ] },
  { tab: '어셈블리', groups: [
    { name: '구속', items: [['mate', '메이트', 'mate', 'Ctrl+M'], ['fix', '고정/해제', 'pin', null, () => ACT.fix()], ['rebuild', '재생성', 'rebuild', 'Ctrl+B', () => ACT.rebuild()]] },
    { name: '평가', items: [['interference', '간섭 검사', 'interfere'], ['explode', '분해 보기', 'explode']] },
  ] },
  { tab: '시뮬레이션', groups: [
    { name: '정적 해석', items: [['simulate', '응력 해석', 'sim']] },
  ] },
  { tab: '도면', groups: [
    { name: '2D 도면', items: [['drawing', '도면 만들기', 'drawing', 'Ctrl+D', () => ACT.drawing()]] },
  ] },
  { tab: '검사', groups: [
    { name: '측정', items: [['measure', '측정', 'measure', 'M'], ['mass', '질량 특성', 'mass'], ['section', '단면도', 'section', 'X']] },
  ] },
  { tab: '보기', groups: [
    { name: '방향', items: Object.entries(VIEWS).map(([k, v]) => [`view-${k}`, v.name, k === 'iso' ? 'views' : 'box', v.key, () => setView(k)]) },
    { name: '표시', items: [['fit', '전체 보기', 'fit', 'F', ACT.fit], ['wire', '와이어', 'wire', null, () => (wire ? ACT.shaded() : ACT.wire())], ['edges', '모서리', 'edges', null, ACT.edges], ['proj', '원근/평행', 'ortho', null, ACT.proj], ['units', 'mm / inch', 'measure', null, ACT.units]] },
  ] },
];
RIBBON.forEach((t) => t.groups.forEach((g) => g.items.forEach(([id, name, ic, key, fn]) => {
  CMD[id] = { id, name, icon: ic, key, group: `${t.tab} › ${g.name}`, fn };
})));

function runCmd(id) {
  const c = CMD[id];
  if (!c) return;
  if (!id.startsWith('view-') && !['undo', 'redo', 'fit'].includes(id)) lastCmd = id;
  if (c.fn) { c.fn(); return; }
  setTool(activeTool === TOOLS[id] ? null : id);
}

let tabIndex = store.get('tab', 1);
function renderRibbon() {
  $('#tabs').innerHTML = RIBBON.map((t, i) => `<button role="tab" data-i="${i}" class="${i === tabIndex ? 'on' : ''}">${t.tab}</button>`).join('');
  $$('#tabs button').forEach((b) => (b.onclick = () => { tabIndex = Number(b.dataset.i); store.set('tab', tabIndex); renderRibbon(); }));
  $('#groups').innerHTML = RIBBON[tabIndex].groups.map((g) => `<div class="rgroup"><div class="items">${g.items.map(([id, name, ic, key]) =>
    `<button class="cmd ${activeTool === TOOLS[id] ? 'on' : ''}" data-cmd="${id}" title="${name}${key ? ` (${key})` : ''}">${icon(ic, 22)}<span>${name}</span></button>`).join('')}</div><div class="gname">${g.name}</div></div>`).join('');
  $$('#groups [data-cmd]').forEach((b) => (b.onclick = () => runCmd(b.dataset.cmd)));
}

// =============================================================== 명령 검색
let palIdx = 0;
function openPalette() {
  $('#palette').hidden = false;
  const inp = $('#palette-input');
  inp.value = '';
  palIdx = 0;
  renderPalette();
  inp.focus();
}
function closePalette() { $('#palette').hidden = true; }
function paletteItems() {
  const q = $('#palette-input').value.trim().toLowerCase();
  const list = Object.values(CMD);
  return q ? list.filter((c) => (c.name + c.group + c.id).toLowerCase().includes(q)) : list;
}
function renderPalette() {
  const items = paletteItems();
  palIdx = Math.min(palIdx, Math.max(0, items.length - 1));
  $('#palette-list').innerHTML = items.map((c, i) => `<li data-id="${c.id}" class="${i === palIdx ? 'on' : ''}">${icon(c.icon, 18)}<span>${c.name}</span>${c.key ? `<kbd>${c.key}</kbd>` : ''}<span class="g">${c.group}</span></li>`).join('') || '<li>일치하는 명령이 없습니다</li>';
  $$('#palette-list li[data-id]').forEach((li) => (li.onclick = () => { closePalette(); runCmd(li.dataset.id); }));
  $('#palette-list li.on')?.scrollIntoView({ block: 'nearest' });
}
$('#palette-input').addEventListener('input', () => { palIdx = 0; renderPalette(); });
$('#palette-input').addEventListener('keydown', (e) => {
  const n = paletteItems().length;
  if (e.key === 'ArrowDown') { palIdx = (palIdx + 1) % n; renderPalette(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { palIdx = (palIdx - 1 + n) % n; renderPalette(); e.preventDefault(); }
  else if (e.key === 'Enter') { const c = paletteItems()[palIdx]; closePalette(); if (c) runCmd(c.id); }
  else if (e.key === 'Escape') closePalette();
});
$('#palette').addEventListener('click', (e) => { if (e.target.id === 'palette') closePalette(); });

// =============================================================== 파일
let fileMode = 'open';
const stem = () => { const s = (state.name || 'model').replace(/\.(step|stp)$/i, ''); return s === '새 문서' ? 'model' : s; };
async function uploadStep(file, mode) {
  const fd = new FormData();
  fd.append('file', file);
  const s = await api(`/api/${mode}`, { method: 'POST', body: fd });
  setTool(null);
  selection = [];
  await applyState(s, { fit: mode === 'open' });
  if (mode === 'open') { viewDir(VIEWS.iso.dir); }
  toast(`${mode === 'open' ? '열기' : '가져오기'} · ${file.name} · 바디 ${s.bodies.length}개`);
}
$('#file').onchange = () => {
  const f = $('#file').files[0];
  $('#file').value = '';
  if (f) safe(() => uploadStep(f, fileMode));
};
let dragDepth = 0;
vp.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; vp.classList.add('dragging'); });
vp.addEventListener('dragover', (e) => e.preventDefault());
vp.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; vp.classList.remove('dragging'); } });
vp.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  vp.classList.remove('dragging');
  const f = e.dataTransfer.files[0];
  if (f) safe(() => uploadStep(f, state.bodies.length && e.shiftKey ? 'import' : 'open'));
});
// 파일 저장: Windows 앱(pywebview)에서는 '다른 이름으로 저장' 창을, 브라우저에서는 다운로드를 쓴다
async function saveBlob(blob, name) {
  const bridge = window.pywebview?.api;
  if (bridge?.save_file) {
    const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.readAsDataURL(blob); });
    const where = await bridge.save_file(name, b64);
    if (where) toast(`저장 · ${where}`);
    return where;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`저장 · ${name}`);
  return name;
}
async function download(url, ext) {
  const blob = await api(url);
  const ok = await saveBlob(blob, `${stem()}_edited.${ext}`);
  if (ok && ext === 'step') $('#dirty').classList.remove('on');
}

const sketchMode = createSketch({
  post, toast, icon, fmt,
  onApply: (payload) => runOp(payload),
  onClose: () => { resize(); },
});

const drawingMode = createDrawing({
  api, post, toast, icon, fmt, saveBlob,
  getDocName: () => stem(),
  getRevision: () => state.revision,
  getBodyList: () => state.bodies.map((b) => ({ id: b.id, name: b.name })),
  onClose: () => { resize(); },
});

// =============================================================== 키보드(솔리드웍스 기본 단축키)
let lastMouse = [innerWidth / 2, innerHeight / 2];
window.addEventListener('pointermove', (e) => { lastMouse = [e.clientX, e.clientY]; });
window.addEventListener('keydown', (e) => {
  if (!$('#palette').hidden || drawingMode.isOpen() || sketchMode.isOpen()) return;
  if (e.target.matches('input, select, textarea')) { if (e.key === 'Escape') e.target.blur(); return; }
  const k = e.key.toLowerCase();
  const mod = e.ctrlKey || e.metaKey;
  const arrow = { arrowleft: [-1, 0], arrowright: [1, 0], arrowup: [0, 1], arrowdown: [0, -1] }[k];
  if (mod) {
    const views7 = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso'];
    if (/^[1-7]$/.test(k)) { e.preventDefault(); setView(views7[Number(k) - 1]); return; }
    if (k === '8') { e.preventDefault(); normalTo(); return; }
    if (arrow) { e.preventDefault(); panBy(-arrow[0], -arrow[1]); return; }
    const map = { z: () => (e.shiftKey ? ACT.redo() : ACT.undo()), y: ACT.redo, s: ACT.save, o: ACT.open, n: ACT.new, k: openPalette,
      b: ACT.rebuild, q: ACT.rebuild, d: ACT.drawing, r: () => { resize(); toast('화면 다시 그리기'); }, m: () => runCmd('mate'), c: ACT.copyBody, v: ACT.paste };
    if (map[k] && !(k === 'c' && window.getSelection()?.toString())) { e.preventDefault(); map[k](); }
    return;
  }
  if (arrow) {
    e.preventDefault();
    const deg = e.shiftKey ? 90 : 15;
    if (e.altKey) { rollBy(arrow[0] * deg); return; }
    const { right, up } = screenAxes();
    if (arrow[0]) orbitBy(up, -arrow[0] * deg); else orbitBy(right, arrow[1] * deg);
    return;
  }
  if (e.altKey) return;
  if (k === ' ') { e.preventDefault(); viewMenu(lastMouse[0], lastMouse[1]); return; }
  if (k === 'escape') { $('#viewmenu') && ($('#viewmenu').hidden = true); if (selection.length) clearSelection(); else setTool(null); return; }
  if (k === 'enter') { if (lastCmd) runCmd(lastCmd); return; }
  if (k === 's') { e.preventDefault(); openPalette(); return; }
  if (k === 'z') { zoomBy(e.shiftKey ? 1.25 : 0.8); return; }
  if (k === 'f') { fitView(); return; }
  if (k === 'delete') { if (selection.some((s) => s.kind === 'face')) runCmd('delete_faces'); return; }
  const c = Object.values(CMD).find((x) => x.key && x.key.length === 1 && x.key.toLowerCase() === k);
  if (c) runCmd(c.id);
});

// =============================================================== 시작
$('#logo').innerHTML = icon('logo', 22);
$('#btn-undo').innerHTML = icon('undo', 18);
$('#btn-redo').innerHTML = icon('redo', 18);
$('#btn-search span').outerHTML = icon('search', 16);
$('#btn-save span').outerHTML = icon('save', 16);
$('#panel-close').innerHTML = icon('close', 16);
$('#btn-units').textContent = units;
$('#btn-undo').onclick = ACT.undo;
$('#btn-redo').onclick = ACT.redo;
$('#btn-search').onclick = openPalette;
$('#btn-theme').onclick = ACT.theme;
$('#btn-save').onclick = ACT.save;
$('#btn-units').onclick = ACT.units;
$('#panel-close').onclick = () => setTool(null);
$('#btn-sample').onclick = () => safe(async () => { const s = await post('/api/sample', {}); await applyState(s, { fit: true }); viewDir(VIEWS.iso.dir); toast('예제 파일을 열었습니다'); });

function loop(now) {
  requestAnimationFrame(loop);
  stepAnim(now);
  controls.update();
  const dist = camera.position.distanceTo(controls.target);
  key.position.copy(camera.position).add(new THREE.Vector3(dist * 0.4, dist * 0.2, dist * 0.8));
  fill.position.copy(controls.target).sub(camera.position).add(controls.target);
  renderer.render(scene, camera);
  cubeCam.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(4);
  cubeCam.up.copy(camera.up);
  cubeCam.lookAt(0, 0, 0);
  cubeR.render(cubeScene, cubeCam);
  updateLabels();
}

applyTheme();
renderRibbon();
renderFilter();
resize();
setTool(null);
frame(new THREE.Vector3(...VIEWS.iso.dir), new THREE.Vector3(0, 0, 1), false);
requestAnimationFrame(loop);
safe(async () => applyState(await api('/api/state'), { fit: true }));

// 자동 테스트용 훅
window.__datum = {
  get state() { return state; }, get selection() { return selection; }, views, setTool, setView, runCmd,
  screenOf(body, kind, index) {
    const v = views.get(body);
    let p;
    if (kind === 'vertex') p = new THREE.Vector3(...v.data.vertices.slice(index * 3, index * 3 + 3));
    else if (kind === 'edge') { const e = v.data.edges[index]; const k = Math.floor(e.length / 6) * 3; p = new THREE.Vector3(e[k], e[k + 1], e[k + 2]); }
    const r = renderer.domElement.getBoundingClientRect();
    const toScreen = (q) => { q.project(camera); return [r.left + (q.x + 1) / 2 * r.width, r.top + (1 - q.y) / 2 * r.height]; };
    if (kind !== 'face') return toScreen(p);
    // 면: 실제로 보이는(클릭하면 그 면이 잡히는) 삼각형 중심을 찾는다
    const [s, n] = v.faceTris[index];
    const ix = v.mesh.geometry.index.array, pa = v.mesh.geometry.getAttribute('position');
    for (let t = s; t < s + n; t++) {
      const c = new THREE.Vector3();
      for (let j = 0; j < 3; j++) c.add(new THREE.Vector3().fromBufferAttribute(pa, ix[t * 3 + j]));
      const xy = toScreen(c.multiplyScalar(1 / 3));
      const h = pick({ clientX: xy[0], clientY: xy[1] });
      if (h && h.body === body && h.kind === 'face' && h.index === index) return xy;
    }
    return null;
  },
};
