import * as THREE from 'three';
import { OrbitControls } from '/static/vendor/OrbitControls.js';

// =============================================================== 서버 통신
const $ = (s) => document.querySelector(s);
const busy = $('#busy');

async function api(path, opts = {}) {
  busy.hidden = false;
  try {
    const r = await fetch(path, opts);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.blob();
    if (!r.ok) throw new Error((data && data.error) || (data && data.detail) || r.statusText);
    return data;
  } finally { busy.hidden = true; }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function status(msg, err = false) {
  const el = $('#status-msg');
  el.textContent = msg;
  el.classList.toggle('err', err);
}

// =============================================================== 3D 장면
const vp = $('#viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
vp.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const persp = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
const ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -1e6, 1e6);
let camera = persp;
camera.up.set(0, 0, 1); ortho.up.set(0, 0, 1);
persp.position.set(200, -300, 200);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.15;
controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
// 솔리드웍스처럼: 가운데 버튼 회전, Ctrl+가운데 이동, 휠 확대. 왼쪽 드래그(Alt)도 회전.
renderer.domElement.addEventListener('pointerdown', (e) => {
  controls.mouseButtons.LEFT = e.altKey ? THREE.MOUSE.ROTATE : null;
  controls.mouseButtons.MIDDLE = e.ctrlKey ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
}, true);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
scene.add(sun);
const world = new THREE.Group();
scene.add(world);
const overlay = new THREE.Group();
scene.add(overlay);

const sectionPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), 0);
let sectionOn = false;
let showEdges = true;
let wire = false;

function resize() {
  const w = vp.clientWidth, h = vp.clientHeight;
  renderer.setSize(w, h);
  persp.aspect = w / h; persp.updateProjectionMatrix();
  const hh = (ortho.top - ortho.bottom) / 2 || 100;
  ortho.left = -hh * w / h; ortho.right = hh * w / h; ortho.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(vp);

// 좌표축 표시(왼쪽 아래)
const triad = new THREE.WebGLRenderer({ alpha: true, antialias: true });
triad.setSize(90, 90); triad.setPixelRatio(window.devicePixelRatio);
$('#triad').appendChild(triad.domElement);
const triadScene = new THREE.Scene();
const triadCam = new THREE.OrthographicCamera(-1.4, 1.4, 1.4, -1.4, -10, 10);
triadCam.up.set(0, 0, 1);
[[0xd64545, [1, 0, 0], 'X'], [0x3aa655, [0, 1, 0], 'Y'], [0x3b7be0, [0, 0, 1], 'Z']].forEach(([c, d, n]) => {
  triadScene.add(new THREE.ArrowHelper(new THREE.Vector3(...d), new THREE.Vector3(), 1, c, 0.3, 0.18));
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#' + c.toString(16).padStart(6, '0');
  ctx.font = 'bold 44px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(n, 32, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv) }));
  sp.position.set(...d.map((v) => v * 1.3)); sp.scale.setScalar(0.45); triadScene.add(sp);
});

// =============================================================== 바디 표시
let state = { bodies: [], history: [], redo: [] };
const views = new Map(); // body id -> { group, mesh, triFace, faceTris, lines, segEdge, points, data, color }
let modelSize = 100;

const COLORS = { hover: 0xffa630, sel: 0x1a73e8, edge: 0x1d2733 };

function makeBodyView(b, data) {
  const group = new THREE.Group();
  group.userData.body = b.id;
  // 면: 하나의 메시로 합치고 삼각형마다 면 번호를 기록한다
  const pos = [], idx = [], triFace = [], faceTris = [];
  let base = 0;
  data.faces.forEach((f, fi) => {
    const start = idx.length / 3;
    for (let i = 0; i < f.pos.length; i++) pos.push(f.pos[i]);
    for (let i = 0; i < f.idx.length; i++) idx.push(f.idx[i] + base);
    for (let t = 0; t < f.idx.length / 3; t++) triFace.push(fi);
    faceTris.push([start, f.idx.length / 3]);
    base += f.pos.length / 3;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: b.color, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, wireframe: wire,
    clippingPlanes: sectionOn ? [sectionPlane] : [],
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData = { body: b.id, kind: 'face' };
  group.add(mesh);

  // 모서리
  const lp = [], segEdge = [];
  data.edges.forEach((pts, ei) => {
    for (let i = 0; i + 5 < pts.length; i += 3) {
      lp.push(pts[i], pts[i + 1], pts[i + 2], pts[i + 3], pts[i + 4], pts[i + 5]);
      segEdge.push(ei);
    }
  });
  const lgeo = new THREE.BufferGeometry();
  lgeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
  const lines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({ color: COLORS.edge, clippingPlanes: mat.clippingPlanes }));
  lines.userData = { body: b.id, kind: 'edge' };
  lines.visible = showEdges;
  group.add(lines);

  // 꼭짓점(선택용, 평소엔 거의 안 보이게)
  const pgeo = new THREE.BufferGeometry();
  pgeo.setAttribute('position', new THREE.Float32BufferAttribute(data.vertices, 3));
  const points = new THREE.Points(pgeo, new THREE.PointsMaterial({ color: COLORS.edge, size: 4, sizeAttenuation: false, transparent: true, opacity: 0.0 }));
  points.userData = { body: b.id, kind: 'vertex' };
  group.add(points);

  group.visible = b.visible;
  return { group, mesh, triFace, faceTris, lines, segEdge, points, data, color: b.color };
}

async function applyState(s, { fit = false } = {}) {
  state = s;
  clearSelection(false);
  // 형상이 바뀌었을 수 있으므로 모든 바디를 새로 받는다(작업은 수가 적어 충분히 빠르다)
  const meshes = await Promise.all(s.bodies.map((b) => api(`/api/mesh/${b.id}`)));
  views.forEach((v) => { world.remove(v.group); disposeGroup(v.group); });
  views.clear();
  s.bodies.forEach((b, i) => {
    const v = makeBodyView(b, meshes[i]);
    views.set(b.id, v);
    world.add(v.group);
  });
  renderTree();
  const box = worldBox();
  if (!box.isEmpty()) modelSize = box.getSize(new THREE.Vector3()).length() || 100;
  if (fit) fitView();
  activeTool?.refresh?.();
}

function disposeGroup(g) {
  g.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
}

function worldBox() {
  const box = new THREE.Box3();
  views.forEach((v) => { if (v.group.visible) box.expandByObject(v.mesh); });
  return box;
}

// =============================================================== 트리(바디 + 작업 기록)
let selectedBody = null;

function renderTree() {
  $('#docname').textContent = state.name;
  const ul = $('#bodies');
  ul.innerHTML = '';
  state.bodies.forEach((b) => {
    const li = document.createElement('li');
    li.className = (b.id === selectedBody ? 'sel ' : '') + (b.visible ? '' : 'hid');
    li.innerHTML = `<input type="color" class="sw" value="${b.color}" title="색상"><span class="nm" title="더블클릭: 이름 변경"></span><button class="eye" title="보이기/숨기기">${b.visible ? '👁' : '◌'}</button>`;
    li.querySelector('.nm').textContent = b.name;
    li.onclick = (e) => {
      if (e.target.closest('.eye,.sw')) return;
      selectedBody = b.id; renderTree(); activeTool?.refresh?.();
      status(`바디 선택: ${b.name}`);
    };
    li.querySelector('.nm').ondblclick = async () => {
      const name = prompt('바디 이름', b.name);
      if (name) applyState(await post('/api/op', { op: 'props', body: b.id, params: { name } }));
    };
    li.querySelector('.eye').onclick = async () => applyState(await post('/api/op', { op: 'props', body: b.id, params: { visible: !b.visible } }));
    li.querySelector('.sw').onchange = async (e) => applyState(await post('/api/op', { op: 'props', body: b.id, params: { color: e.target.value } }));
    ul.appendChild(li);
  });
  const ol = $('#history');
  ol.innerHTML = '';
  state.history.forEach((h, i) => {
    const li = document.createElement('li');
    li.textContent = h;
    if (i === state.history.length - 1) li.className = 'last';
    ol.appendChild(li);
  });
  state.redo.forEach((h) => {
    const li = document.createElement('li');
    li.textContent = h; li.className = 'redo';
    ol.appendChild(li);
  });
}

// =============================================================== 선택(면/모서리/점)
const ray = new THREE.Raycaster();
const mouse = new THREE.Vector2();
let hover = null;
let selection = []; // {body, kind, index, point:[x,y,z]}
const hoverGroup = new THREE.Group(), selGroup = new THREE.Group();
overlay.add(hoverGroup, selGroup);

function filters() {
  return new Set([...document.querySelectorAll('#filter input:checked')].map((i) => i.value));
}

function pick(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  mouse.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  const px = (camera.isOrthographicCamera ? (camera.top - camera.bottom) / camera.zoom : 2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * camera.position.distanceTo(controls.target)) / r.height;
  ray.params.Line.threshold = px * 5;
  ray.params.Points.threshold = px * 7;
  const allow = activeTool?.accept ? new Set(activeTool.accept.filter((k) => filters().has(k))) : filters();
  const targets = [];
  views.forEach((v) => {
    if (!v.group.visible) return;
    targets.push(v.mesh); // 면은 항상 검사해서 가려진 모서리/점이 잡히지 않게 한다
    if (allow.has('edge') && showEdges) targets.push(v.lines);
    if (allow.has('vertex')) targets.push(v.points);
  });
  let hits = ray.intersectObjects(targets, false);
  if (sectionOn) hits = hits.filter((h) => sectionPlane.distanceToPoint(h.point) >= 0);
  if (!hits.length) return null;
  const tol = modelSize * 0.01;
  const faceHit = hits.find((h) => h.object.userData.kind === 'face');
  const limit = (faceHit ? faceHit.distance : Infinity) + tol;
  hits = hits.filter((h) => h.distance <= limit && allow.has(h.object.userData.kind));
  if (!hits.length) return null;
  // 가까운 것 중에서 점 > 모서리 > 면 순으로 우선
  const near = hits[0].distance;
  const pref = { vertex: 0, edge: 1, face: 2 };
  hits = hits.filter((h) => h.distance - near < tol).sort((a, b) => pref[a.object.userData.kind] - pref[b.object.userData.kind]);
  const h = hits[0];
  const { body, kind } = h.object.userData;
  const v = views.get(body);
  let index;
  if (kind === 'face') index = v.triFace[h.faceIndex];
  else if (kind === 'edge') index = v.segEdge[Math.floor(h.index / 2)];
  else index = h.index;
  // 면 선택 시에는 실제 클릭 위치를, 그 외엔 교차점을 기록
  return { body, kind, index, point: h.point.toArray() };
}

function highlight(group, item, color) {
  const v = views.get(item.body);
  if (!v) return;
  if (item.kind === 'face') {
    const [start, count] = v.faceTris[item.index];
    const src = v.mesh.geometry;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.getAttribute('position'));
    g.setIndex(Array.from(src.index.array.slice(start * 3, (start + count) * 3)));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }));
    group.add(m);
  } else if (item.kind === 'edge') {
    const pts = v.data.edges[item.index];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 5;
    group.add(l);
  } else {
    const p = v.data.vertices.slice(item.index * 3, item.index * 3 + 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    const pt = new THREE.Points(g, new THREE.PointsMaterial({ color, size: 10, sizeAttenuation: false, depthTest: false }));
    pt.renderOrder = 6;
    group.add(pt);
  }
}

function clearGroup(g) { while (g.children.length) { const c = g.children.pop(); c.geometry?.dispose(); c.material?.dispose(); } }

function redrawSelection() {
  clearGroup(selGroup);
  selection.forEach((s) => highlight(selGroup, s, COLORS.sel));
  const names = { face: '면', edge: '모서리', vertex: '점' };
  $('#status-sel').textContent = selection.length ? `선택: ${selection.map((s) => `${names[s.kind]}#${s.index + 1}`).join(', ')}` : '';
}

function clearSelection(refresh = true) {
  selection = [];
  redrawSelection();
  clearMeasureGraphics();
  if (refresh) activeTool?.refresh?.();
}

function same(a, b) { return a.body === b.body && a.kind === b.kind && a.index === b.index; }

let downAt = null;
renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || e.altKey || !downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 4) return;
  const hit = pick(e);
  if (!hit) { if (!e.ctrlKey && !e.shiftKey) clearSelection(); return; }
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
  renderTree();
  activeTool?.refresh?.();
});
renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons) return;
  const hit = pick(e);
  if (hover && hit && same(hover, hit)) return;
  hover = hit;
  clearGroup(hoverGroup);
  if (hit) highlight(hoverGroup, hit, COLORS.hover);
});
renderer.domElement.addEventListener('dblclick', () => fitView());

// =============================================================== 측정 그래픽(선 + 값 표시)
const labels = [];
function clearMeasureGraphics() {
  overlay.children.filter((c) => c.userData.measure).forEach((c) => { overlay.remove(c); c.geometry?.dispose(); });
  labels.splice(0).forEach((l) => l.el.remove());
}
function drawDim(p1, p2, text) {
  const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...p1), new THREE.Vector3(...p2)]);
  const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xd9480f, dashSize: modelSize / 80, gapSize: modelSize / 160, depthTest: false }));
  line.computeLineDistances(); line.renderOrder = 7; line.userData.measure = true;
  overlay.add(line);
  const el = document.createElement('div');
  el.className = 'label3d'; el.textContent = text;
  vp.appendChild(el);
  labels.push({ el, at: new THREE.Vector3(...p1).add(new THREE.Vector3(...p2)).multiplyScalar(0.5) });
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

// =============================================================== 보기
function fitView() {
  const box = worldBox();
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const r = box.getSize(new THREE.Vector3()).length() / 2 || 50;
  const dir = camera.position.clone().sub(controls.target).normalize();
  if (dir.lengthSq() === 0) dir.set(1, -1, 1).normalize();
  controls.target.copy(c);
  const d = r / Math.sin(THREE.MathUtils.degToRad(persp.fov / 2));
  persp.position.copy(c).addScaledVector(dir, d);
  ortho.position.copy(c).addScaledVector(dir, r * 4);
  const asp = vp.clientWidth / vp.clientHeight;
  ortho.top = r * 1.1; ortho.bottom = -r * 1.1; ortho.left = -r * 1.1 * asp; ortho.right = r * 1.1 * asp; ortho.zoom = 1;
  ortho.updateProjectionMatrix();
  persp.near = r / 100; persp.far = r * 100; persp.updateProjectionMatrix();
  controls.update();
}

const VIEWS = {
  front: [[0, -1, 0], [0, 0, 1]], back: [[0, 1, 0], [0, 0, 1]], top: [[0, 0, 1], [0, 1, 0]],
  bottom: [[0, 0, -1], [0, -1, 0]], right: [[1, 0, 0], [0, 0, 1]], iso: [[1, -1, 0.8], [0, 0, 1]],
};
function setView(name) {
  const [d, up] = VIEWS[name];
  const dist = camera.position.distanceTo(controls.target) || modelSize * 2;
  [persp, ortho].forEach((c) => { c.up.set(...up); c.position.copy(controls.target).addScaledVector(new THREE.Vector3(...d).normalize(), dist); });
  controls.update();
  fitView();
}

function toggleOrtho() {
  const next = camera === persp ? ortho : persp;
  next.position.copy(camera.position); next.up.copy(camera.up);
  camera = next;
  controls.object = camera;
  fitView();
  status(camera === ortho ? '평행 투영' : '원근 투영');
}

function setSection(on, axis = 'z', offset = 0, flip = false) {
  sectionOn = on;
  const n = { x: [-1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] }[axis];
  sectionPlane.normal.set(...n).multiplyScalar(flip ? -1 : 1);
  sectionPlane.constant = flip ? -offset : offset;
  views.forEach((v) => {
    v.mesh.material.clippingPlanes = on ? [sectionPlane] : [];
    v.lines.material.clippingPlanes = v.mesh.material.clippingPlanes;
    v.mesh.material.needsUpdate = v.lines.material.needsUpdate = true;
  });
}

// =============================================================== 속성 패널 도구
const panelTitle = $('#panel-title'), panelBody = $('#panel-body');
let activeTool = null;

const fmt = (x, d = 3) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(d).replace(/\.?0+$/, '') || '0';
const fv = (v) => `(${v.map((x) => fmt(x)).join(', ')})`;

function field(label, id, value, attrs = '') {
  return `<div class="row"><label for="${id}">${label}</label><input id="${id}" type="number" step="any" value="${value}" ${attrs}></div>`;
}
function selectField(label, id, options) {
  return `<div class="row"><label for="${id}">${label}</label><select id="${id}">${options.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></div>`;
}
const num = (id) => parseFloat(document.getElementById(id).value);
const val = (id) => document.getElementById(id).value;
const okCancel = (ok = '확인') => `<div class="btns"><button class="ok" id="ok">✔ ${ok}</button><button id="cancel">✖ 닫기</button></div><div class="err" id="err"></div>`;

function wire_(onOk) {
  $('#ok')?.addEventListener('click', async () => {
    try { $('#err').textContent = ''; await onOk(); } catch (e) { $('#err').textContent = e.message; status(e.message, true); }
  });
  $('#cancel')?.addEventListener('click', () => setTool(null));
}

function targetBody() {
  return selection[0]?.body ?? selectedBody ?? state.bodies[0]?.id;
}
function bodyName(id) { return state.bodies.find((b) => b.id === id)?.name ?? '—'; }

async function runOp(payload, msg) {
  const s = await post('/api/op', payload);
  await applyState(s);
  status(msg || `완료: ${s.history.at(-1)}`);
}

function selList(kind) {
  const items = selection.filter((s) => !kind || s.kind === kind);
  const names = { face: '면', edge: '모서리', vertex: '점' };
  return `<ul class="sel-list">${items.map((s) => `<li>${bodyName(s.body)} · ${names[s.kind]} #${s.index + 1}</li>`).join('') || '<li>(없음)</li>'}</ul>`;
}

// 선택 요소를 표 행으로
function infoRows(d) {
  const rows = [['종류', d.type]];
  if (d.point) rows.push(['좌표', fv(d.point)]);
  if (d.length != null) rows.push(['길이', `${fmt(d.length)} mm`]);
  if (d.diameter != null) rows.push(['지름', `Ø${fmt(d.diameter)} mm`], ['반지름', `R${fmt(d.radius)} mm`]);
  else if (d.radius != null) rows.push(['반지름', `R${fmt(d.radius)} mm`]);
  if (d.area != null) rows.push(['면적', `${fmt(d.area)} mm²`]);
  if (d.center) rows.push(['중심', fv(d.center)]);
  if (d.normal) rows.push(['법선', fv(d.normal)]);
  if (d.axis) rows.push(['축 방향', fv(d.axis)]);
  if (d.start) rows.push(['시작점', fv(d.start)], ['끝점', fv(d.end)]);
  if (d.half_angle != null) rows.push(['반각', `${fmt(d.half_angle)}°`]);
  return rows;
}
const table = (rows) => `<table>${rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table>`;

const TOOLS = {
  select: {
    title: '선택', max: 2,
    render() {
      panelBody.innerHTML = `<p class="hint">왼쪽 클릭: 면·모서리·점 선택 (최대 2개, 다시 클릭하면 해제)<br>가운데 드래그: 회전 · Ctrl+가운데: 이동 · 휠: 확대<br>Alt+왼쪽 드래그: 회전 · 더블클릭: 전체 보기 · Esc: 선택 해제</p>${selection.length ? '<div id="minfo">측정 중…</div>' : ''}`;
      if (selection.length) TOOLS.measure.fill();
    },
  },

  measure: {
    title: '측정', max: 2,
    render() {
      panelBody.innerHTML = `<p class="hint">요소 1개: 길이·지름·면적 등 · 2개: 거리·각도·중심 거리</p><div id="minfo"></div>`;
      this.fill();
    },
    async fill() {
      clearMeasureGraphics();
      const box = $('#minfo');
      if (!box) return;
      if (!selection.length) { box.innerHTML = '<p class="hint">측정할 요소를 클릭하세요.</p>'; return; }
      try {
        const r = await post('/api/measure', { picks: selection.map(({ body, kind, index }) => ({ body, kind, index })) });
        if (r.single) { box.innerHTML = table(infoRows(r.single)); return; }
        const p = r.pair;
        const rows = [['최소 거리', `<b>${fmt(p.distance)} mm</b>`], ['dX', `${fmt(p.dx)} mm`], ['dY', `${fmt(p.dy)} mm`], ['dZ', `${fmt(p.dz)} mm`]];
        if (p.parallel_distance != null) rows.push(['평행 거리', `<b>${fmt(p.parallel_distance)} mm</b>`]);
        if (p.center_distance != null) rows.push(['중심 거리', `<b>${fmt(p.center_distance)} mm</b>`]);
        if (p.angle != null) rows.push(['각도', `${fmt(p.angle, 2)}°`]);
        box.innerHTML = table(rows) + '<h4>요소 1</h4>' + table(infoRows(r.a)) + '<h4>요소 2</h4>' + table(infoRows(r.b));
        if (p.center_distance != null) drawDim(p.c1, p.c2, `중심 ${fmt(p.center_distance, 2)} mm`);
        if (p.distance > 1e-9) drawDim(p.p1, p.p2, `${fmt(p.distance, 2)} mm`);
      } catch (e) { box.innerHTML = `<div class="err">${e.message}</div>`; }
    },
    refresh() { this.fill(); },
  },

  mass: {
    title: '질량 특성', max: 1,
    render() {
      panelBody.innerHTML = `<p class="hint">바디를 클릭하거나 트리에서 고르세요.</p><p><b id="mb"></b></p>${field('밀도 (g/cm³)', 'dens', 7.85, 'min="0"')}<div class="hint">강철 7.85 · 알루미늄 2.70 · ABS 1.05</div><div id="mres"></div>${okCancel('계산')}`;
      $('#dens').onchange = () => this.fill();
      wire_(() => this.fill());
      this.fill();
    },
    async fill() {
      const id = targetBody();
      if (id == null) return;
      $('#mb').textContent = bodyName(id);
      const m = await api(`/api/mass/${id}?density=${num('dens')}`);
      $('#mres').innerHTML = table([
        ['부피', `${fmt(m.volume, 2)} mm³`], ['표면적', `${fmt(m.area, 2)} mm²`], ['질량', `${fmt(m.mass, 2)} g`],
        ['무게중심', m.center ? fv(m.center) : '—'], ['크기 X×Y×Z', m.size.map((x) => fmt(x, 2)).join(' × ') + ' mm'],
        ['최소점', fv(m.bbox_min)], ['최대점', fv(m.bbox_max)], ['면 / 모서리', `${m.faces} / ${m.edges}`],
      ]);
    },
    refresh() { this.fill(); },
  },

  section: {
    title: '단면도', max: 0,
    render() {
      const box = worldBox();
      const c = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
      panelBody.innerHTML = selectField('기준면', 'sax', [['z', 'XY 평면 (Z)'], ['y', 'XZ 평면 (Y)'], ['x', 'YZ 평면 (X)']]) +
        field('위치 (mm)', 'soff', fmt(c.z, 2)) + `<div class="row"><label>슬라이더</label><input id="sslide" type="range" min="0" max="1000" value="500"></div>` +
        `<div class="row"><label for="sflip">방향 반전</label><input id="sflip" type="checkbox" style="width:auto"></div>` + okCancel('단면 끄기');
      const upd = () => setSection(true, val('sax'), num('soff'), $('#sflip').checked);
      const slide = () => {
        const b = worldBox(); const ax = val('sax');
        const lo = b.min[ax], hi = b.max[ax];
        $('#soff').value = fmt(lo + (hi - lo) * $('#sslide').value / 1000, 2); upd();
      };
      $('#sax').onchange = () => slide();
      $('#soff').oninput = upd; $('#sflip').onchange = upd; $('#sslide').oninput = slide;
      slide();
      wire_(() => { setSection(false); setTool(null); });
    },
    leave() { /* 단면은 '단면 끄기'로만 끈다 */ },
  },

  primitive: {
    title: '기본 형상 만들기', max: 0,
    render() {
      panelBody.innerHTML = selectField('형상', 'pk', [['box', '상자'], ['cylinder', '원통'], ['sphere', '구'], ['cone', '원뿔']]) + '<div id="pf"></div>' +
        '<h4>위치(원점/아래 중심)</h4>' + field('X', 'px', 0) + field('Y', 'py', 0) + field('Z', 'pz', 0) + okCancel('만들기');
      const fieldsFor = {
        box: field('가로 X', 'dx', 50) + field('세로 Y', 'dy', 30) + field('높이 Z', 'dz', 20),
        cylinder: field('반지름', 'r', 10) + field('높이', 'h', 30),
        sphere: field('반지름', 'r', 15),
        cone: field('아래 반지름', 'r1', 15) + field('위 반지름', 'r2', 0) + field('높이', 'h', 30),
      };
      const set = () => { $('#pf').innerHTML = fieldsFor[val('pk')]; };
      $('#pk').onchange = set; set();
      wire_(async () => {
        const k = val('pk');
        const params = { x: num('px'), y: num('py'), z: num('pz') };
        ({ box: ['dx', 'dy', 'dz'], cylinder: ['r', 'h'], sphere: ['r'], cone: ['r1', 'r2', 'h'] })[k].forEach((n) => { params[n] = num(n); });
        await runOp({ op: 'primitive', kind: k, params });
        if (state.bodies.length === 1) fitView();
      });
    },
  },

  push_pull: {
    title: '면 밀기/당기기', accept: ['face'], max: 1,
    render() {
      panelBody.innerHTML = `<p class="hint">평면 하나를 고르세요. + 는 바깥으로 돌출, − 는 안으로 잘라냅니다.</p>${selList('face')}${field('거리 (mm)', 'dist', 5)}${okCancel()}`;
      wire_(async () => {
        const f = selection.find((s) => s.kind === 'face');
        if (!f) throw new Error('면을 선택하세요');
        await runOp({ op: 'push_pull', body: f.body, faces: [f.index], params: { distance: num('dist') } });
      });
    },
    refresh() { this.render(); },
  },

  hole: {
    title: '구멍', accept: ['face'], max: 1,
    render() {
      panelBody.innerHTML = `<p class="hint">평면 위 구멍 낼 위치를 클릭하세요. 위치는 아래 좌표로 정확히 조정할 수 있습니다.</p>${selList('face')}` +
        field('지름 Ø (mm)', 'hd', 6, 'min="0"') + field('깊이 (0=관통)', 'hdp', 0, 'min="0"') +
        '<h4>중심 좌표</h4>' + field('X', 'hx', fmt(selection[0]?.point[0] ?? 0)) + field('Y', 'hy', fmt(selection[0]?.point[1] ?? 0)) + field('Z', 'hz', fmt(selection[0]?.point[2] ?? 0)) + okCancel();
      wire_(async () => {
        const f = selection.find((s) => s.kind === 'face');
        if (!f) throw new Error('면을 선택하세요');
        await runOp({ op: 'hole', body: f.body, faces: [f.index], point: [num('hx'), num('hy'), num('hz')], params: { diameter: num('hd'), depth: num('hdp') } });
      });
    },
    refresh() {
      const keep = $('#hd') ? [num('hd'), num('hdp')] : null;
      this.render();
      if (keep) { $('#hd').value = keep[0]; $('#hdp').value = keep[1]; }
    },
  },

  fillet: edgeTool('fillet', '필렛', '반지름 R (mm)', 'radius', 2),
  chamfer: edgeTool('chamfer', '챔퍼', '거리 C (mm)', 'distance', 1),

  shell: {
    title: '쉘(속 비우기)', accept: ['face'], max: 20,
    render() {
      panelBody.innerHTML = `<p class="hint">열어 둘 면을 고르세요(0개면 완전히 닫힌 속 빈 형상).</p>${selList('face')}${field('두께 (mm)', 'th', 1, 'min="0"')}${okCancel()}`;
      wire_(async () => {
        const id = targetBody();
        await runOp({ op: 'shell', body: id, faces: selection.filter((s) => s.kind === 'face' && s.body === id).map((s) => s.index), params: { thickness: num('th') } });
      });
    },
    refresh() { this.render(); },
  },

  delete_faces: {
    title: '면 삭제(메우기)', accept: ['face'], max: 50,
    render() {
      panelBody.innerHTML = `<p class="hint">지울 면(구멍 안쪽 면, 필렛 면, 각인 등)을 고르세요. 주변 면을 늘려 자동으로 메웁니다.</p>${selList('face')}${okCancel('삭제')}`;
      wire_(async () => {
        const fs = selection.filter((s) => s.kind === 'face');
        if (!fs.length) throw new Error('면을 선택하세요');
        await runOp({ op: 'delete_faces', body: fs[0].body, faces: fs.filter((s) => s.body === fs[0].body).map((s) => s.index) });
      });
    },
    refresh() { this.render(); },
  },

  boolean: {
    title: '합치기 / 빼기 / 교차', max: 2,
    render() {
      const opts = state.bodies.map((b) => [b.id, b.name]);
      panelBody.innerHTML = selectField('작업', 'bop', [['union', '합치기 (A ∪ B)'], ['cut', '빼기 (A − B)'], ['intersect', '교차 (A ∩ B)']]) +
        selectField('대상 바디 A', 'ba', opts) + selectField('도구 바디 B', 'bb', opts) +
        `<div class="row"><label for="bk">B 남겨두기</label><input id="bk" type="checkbox" style="width:auto"></div>` +
        '<p class="hint">화면에서 두 바디를 차례로 클릭해도 됩니다.</p>' + okCancel();
      const bodies = [...new Set(selection.map((s) => s.body))];
      if (bodies[0] != null) $('#ba').value = bodies[0];
      if (bodies[1] != null) $('#bb').value = bodies[1];
      else if (state.bodies[1]) $('#bb').value = state.bodies.find((b) => b.id !== Number(val('ba')))?.id;
      wire_(() => runOp({ op: 'boolean', kind: val('bop'), body: Number(val('ba')), tool: Number(val('bb')), params: { keep_tool: $('#bk').checked } }));
    },
    refresh() { const op = $('#bop')?.value; this.render(); if (op) $('#bop').value = op; },
  },

  translate: bodyTool('translate', '이동', () => field('dX (mm)', 'dx', 10) + field('dY (mm)', 'dy', 0) + field('dZ (mm)', 'dz', 0), () => ({ dx: num('dx'), dy: num('dy'), dz: num('dz') })),
  copy_body: bodyTool('copy_body', '복사', () => field('dX (mm)', 'dx', 20) + field('dY (mm)', 'dy', 0) + field('dZ (mm)', 'dz', 0), () => ({ dx: num('dx'), dy: num('dy'), dz: num('dz') })),
  rotate: bodyTool('rotate', '회전', () => selectField('축', 'ax', [['z', 'Z 축'], ['x', 'X 축'], ['y', 'Y 축']]) + field('각도 (°)', 'ang', 90) + '<p class="hint">바디 중심을 기준으로 회전합니다.</p>', () => ({ axis: val('ax'), angle: num('ang') })),
  scale: bodyTool('scale', '크기', () => field('X 배율', 'sx', 1) + field('Y 배율', 'sy', 1) + field('Z 배율', 'sz', 1) + '<p class="hint">세 값이 같으면 균일 배율(형상 유지), 다르면 축별 배율입니다.</p>', () => ({ sx: num('sx'), sy: num('sy'), sz: num('sz') })),
  mirror: bodyTool('mirror', '대칭', () => selectField('대칭면', 'mp', [['yz', 'YZ 평면 (X 반전)'], ['xz', 'XZ 평면 (Y 반전)'], ['xy', 'XY 평면 (Z 반전)']]) + field('평면 위치 (mm)', 'mo', 0), () => ({ plane: val('mp'), offset: num('mo') })),
};

function edgeTool(op, name, label, key, def) {
  return {
    title: name, accept: ['edge'], max: 100,
    render() {
      const keep = $('#ev') ? num('ev') : def;
      panelBody.innerHTML = `<p class="hint">모서리를 여러 개 클릭해 고르세요(같은 바디).</p>${selList('edge')}${field(label, 'ev', keep, 'min="0"')}${okCancel()}`;
      wire_(async () => {
        const es = selection.filter((s) => s.kind === 'edge');
        if (!es.length) throw new Error('모서리를 선택하세요');
        await runOp({ op, body: es[0].body, edges: es.filter((s) => s.body === es[0].body).map((s) => s.index), params: { [key]: num('ev') } });
      });
    },
    refresh() { this.render(); },
  };
}

function bodyTool(op, name, fields, params) {
  return {
    title: name, max: 1,
    render() {
      const id = targetBody();
      panelBody.innerHTML = `<p class="hint">대상 바디: <b>${bodyName(id)}</b> (화면이나 트리에서 바꿀 수 있습니다)</p>${fields()}${okCancel()}`;
      wire_(async () => {
        const target = targetBody();
        if (target == null) throw new Error('바디가 없습니다');
        await runOp({ op, body: target, params: params() });
      });
    },
    refresh() {
      const b = panelBody.querySelector('.hint b');
      if (b) b.textContent = bodyName(targetBody());
    },
  };
}

function setTool(name) {
  activeTool?.leave?.();
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === name));
  activeTool = TOOLS[name || 'select'];
  if (activeTool.max !== undefined && selection.length > activeTool.max) { selection = selection.slice(-activeTool.max); redrawSelection(); }
  if (activeTool.accept) { selection = selection.filter((s) => activeTool.accept.includes(s.kind)); redrawSelection(); }
  clearMeasureGraphics();
  panelTitle.textContent = activeTool.title;
  activeTool.render();
  if (!activeTool.refresh) activeTool.refresh = () => activeTool.render();
}
TOOLS.select.refresh = () => TOOLS.select.render();

// =============================================================== 파일
const fileInput = $('#file');
let fileMode = 'open';
async function uploadStep(file, mode) {
  const fd = new FormData();
  fd.append('file', file);
  status(`불러오는 중: ${file.name}`);
  const s = await api(`/api/${mode}`, { method: 'POST', body: fd });
  await applyState(s, { fit: true });
  status(`${mode === 'open' ? '열었습니다' : '가져왔습니다'}: ${file.name} (바디 ${s.bodies.length}개)`);
}
fileInput.onchange = async () => {
  const f = fileInput.files[0];
  fileInput.value = '';
  if (f) try { await uploadStep(f, fileMode); } catch (e) { status(e.message, true); }
};
vp.addEventListener('dragover', (e) => { e.preventDefault(); vp.classList.add('drag'); });
vp.addEventListener('dragleave', () => vp.classList.remove('drag'));
vp.addEventListener('drop', async (e) => {
  e.preventDefault(); vp.classList.remove('drag');
  const f = e.dataTransfer.files[0];
  if (f) try { await uploadStep(f, state.bodies.length && e.shiftKey ? 'import' : 'open'); } catch (err) { status(err.message, true); }
});

async function download(url) {
  const blob = await api(url);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const stem = (state.name || 'model').replace(/\.(step|stp)$/i, '');
  a.download = `${stem === '새 문서' ? 'model' : stem}_edited.${url.includes('stl') ? 'stl' : 'step'}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  status(`저장했습니다: ${a.download}`);
}

const ACTIONS = {
  new: async () => { if (confirm('새 문서를 만들까요? 저장하지 않은 변경은 사라집니다.')) applyState(await post('/api/new', {}), { fit: true }); },
  open: () => { fileMode = 'open'; fileInput.click(); },
  import: () => { fileMode = 'import'; fileInput.click(); },
  'save-step': () => download('/api/export/step'),
  'save-stl': () => download('/api/export/stl'),
  undo: async () => applyState(await post('/api/op', { op: 'undo' })).then(() => status('실행 취소')),
  redo: async () => applyState(await post('/api/op', { op: 'redo' })).then(() => status('다시 실행')),
  'delete-body': async () => {
    const id = targetBody();
    if (id != null && confirm(`바디 "${bodyName(id)}" 를 삭제할까요?`)) await runOp({ op: 'delete_body', body: id });
  },
  fit: () => fitView(),
  wire: () => { wire = !wire; views.forEach((v) => { v.mesh.material.wireframe = wire; }); },
  edges: () => { showEdges = !showEdges; views.forEach((v) => { v.lines.visible = showEdges; }); },
  ortho: () => toggleOrtho(),
};

async function safe(fn) { try { await fn(); } catch (e) { status(e.message, true); } }

document.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => safe(ACTIONS[b.dataset.act])));
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(activeTool === TOOLS[b.dataset.tool] ? null : b.dataset.tool)));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
document.querySelectorAll('#tabs button').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === t));
  document.querySelectorAll('#ribbon .group').forEach((g) => { g.hidden = g.dataset.tab !== t.dataset.tab; });
}));

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); safe(ACTIONS.undo); }
  else if ((e.ctrlKey || e.metaKey) && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); safe(ACTIONS.redo); }
  else if ((e.ctrlKey || e.metaKey) && k === 's') { e.preventDefault(); safe(ACTIONS['save-step']); }
  else if ((e.ctrlKey || e.metaKey) && k === 'o') { e.preventDefault(); ACTIONS.open(); }
  else if (k === 'escape') { clearSelection(); }
  else if (k === 'f') fitView();
  else if (k === 'delete' && selection.some((s) => s.kind === 'face')) setTool('delete_faces');
  else if (k === 'm') setTool('measure');
});

// =============================================================== 렌더 루프 & 시작
function loop() {
  requestAnimationFrame(loop);
  controls.update();
  sun.position.copy(camera.position).add(new THREE.Vector3(modelSize, modelSize, modelSize * 2));
  renderer.render(scene, camera);
  triadCam.position.copy(camera.position).sub(controls.target).normalize().multiplyScalar(5);
  triadCam.up.copy(camera.up);
  triadCam.lookAt(0, 0, 0);
  triad.render(triadScene, triadCam);
  updateLabels();
}

resize();
setTool(null);
loop();
safe(async () => { await applyState(await api('/api/state'), { fit: true }); });
// 자동 테스트용: 요소의 화면 좌표
function screenOf(body, kind, index) {
  const v = views.get(body); let p;
  if (kind === 'vertex') p = new THREE.Vector3(...v.data.vertices.slice(index * 3, index * 3 + 3));
  else if (kind === 'edge') { const e = v.data.edges[index]; const k = Math.floor(e.length / 6) * 3; p = new THREE.Vector3(e[k], e[k + 1], e[k + 2]); }
  else return null;
  p.project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return [r.left + (p.x + 1) / 2 * r.width, r.top + (1 - p.y) / 2 * r.height];
}
window.__stepforge = { get state() { return state; }, get selection() { return selection; }, views, setTool, setView, screenOf, camera: () => camera };
