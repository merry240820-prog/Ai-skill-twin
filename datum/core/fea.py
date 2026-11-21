"""선형 정적 응력 해석(FEA) — 솔리드웍스 Simulation의 '정적 해석'에 해당.

- 메시: gmsh, 2차 사면체(10절점, T10) — 굽힘에서도 정확도가 높다
- 단위계: mm · N · MPa(N/mm²) · t/mm³ 일관 단위
- 경계조건: 고정 면, 하중 면(총 힘 N 또는 압력 MPa, 방향: 면 법선 또는 X/Y/Z)
- 결과: 절점 변위, von Mises 응력, 안전계수
"""
from __future__ import annotations

import math
import os
import tempfile
import threading

import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import spsolve

from . import geometry as g

_gmsh_lock = threading.Lock()  # gmsh는 전역 상태를 쓰므로 한 번에 하나

MATERIALS = {
    # 이름: (탄성계수 E MPa, 푸아송비, 항복강도 MPa, 밀도 g/cm³)
    "steel": ("일반 강철 (S275)", 210000, 0.30, 275, 7.85),
    "stainless": ("스테인리스 304", 193000, 0.29, 215, 8.00),
    "al6061": ("알루미늄 6061-T6", 69000, 0.33, 276, 2.70),
    "brass": ("황동", 100000, 0.34, 200, 8.50),
    "titanium": ("티타늄 Ti-6Al-4V", 114000, 0.34, 880, 4.43),
    "abs": ("ABS", 2200, 0.35, 40, 1.05),
    "pla": ("PLA", 3500, 0.36, 50, 1.24),
}

# ------------------------------------------------------------------ T10 요소
_A, _B = 0.5854101966249685, 0.1381966011250105
_GAUSS = np.array([[_B, _B, _B], [_A, _B, _B], [_B, _A, _B], [_B, _B, _A]])  # (ξ, η, ζ), 가중치 1/24
_CORNERS = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], float)
_EDGES = [(0, 1), (1, 2), (2, 0), (0, 3), (1, 3), (2, 3)]  # 이 순서의 중간 절점으로 정렬해서 쓴다


def _dshape(xi, eta, zeta):
    """T10 형상함수의 (ξ,η,ζ) 미분, (10, 3)."""
    L = np.array([1 - xi - eta - zeta, xi, eta, zeta])
    dL = np.array([[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]], float)
    d = np.zeros((10, 3))
    for i in range(4):
        d[i] = (4 * L[i] - 1) * dL[i]
    for k, (i, j) in enumerate(_EDGES):
        d[4 + k] = 4 * (L[i] * dL[j] + L[j] * dL[i])
    return d


_DN_GAUSS = np.array([_dshape(*p) for p in _GAUSS])
_DN_CORNER = np.array([_dshape(*p) for p in _CORNERS])


def _elasticity(E, nu):
    lam = E * nu / ((1 + nu) * (1 - 2 * nu))
    mu = E / (2 * (1 + nu))
    D = np.zeros((6, 6))
    D[:3, :3] = lam
    D[np.arange(3), np.arange(3)] += 2 * mu
    D[np.arange(3, 6), np.arange(3, 6)] = mu
    return D


def _bmat(dNdx):
    """dNdx (e,10,3) → B (e,6,30), 변형률 순서 xx yy zz xy yz zx(공학 전단)."""
    e = dNdx.shape[0]
    B = np.zeros((e, 6, 30))
    x, y, z = dNdx[:, :, 0], dNdx[:, :, 1], dNdx[:, :, 2]
    B[:, 0, 0::3] = x
    B[:, 1, 1::3] = y
    B[:, 2, 2::3] = z
    B[:, 3, 0::3] = y
    B[:, 3, 1::3] = x
    B[:, 4, 1::3] = z
    B[:, 4, 2::3] = y
    B[:, 5, 0::3] = z
    B[:, 5, 2::3] = x
    return B


def _solve(K, f, pts, comp):
    """대칭 양정치 연립방정식. pyamg(대수 다중격자 + 켤레기울기)를 쓰고, 없거나 실패하면 직접 풀이."""
    try:
        import pyamg
        from scipy.sparse.linalg import cg
        # 강체 모드(이동 3 + 회전 3)를 근사 영공간으로 주면 탄성 문제에서 수렴이 빠르다
        c = pts - pts.mean(axis=0)
        B = np.zeros((len(f), 6))
        for k in range(3):
            B[comp == k, k] = 1
        x, y, z = c.T
        B[comp == 0, 3], B[comp == 1, 3] = -y[comp == 0], x[comp == 1]
        B[comp == 1, 4], B[comp == 2, 4] = -z[comp == 1], y[comp == 2]
        B[comp == 2, 5], B[comp == 0, 5] = -x[comp == 2], z[comp == 0]
        ml = pyamg.smoothed_aggregation_solver(K, B=B, max_coarse=500)
        u, info = cg(K, f, rtol=1e-10, maxiter=400, M=ml.aspreconditioner())
        if info == 0 and np.all(np.isfinite(u)):
            return u
    except ImportError:
        pass
    return spsolve(K.tocsc(), f)


def _von_mises(s):
    sx, sy, sz, txy, tyz, tzx = s.T
    return np.sqrt(0.5 * ((sx - sy) ** 2 + (sy - sz) ** 2 + (sz - sx) ** 2) + 3 * (txy ** 2 + tyz ** 2 + tzx ** 2))


# ------------------------------------------------------------------ 메시
def _mesh(shape, size: float):
    """gmsh로 T10 메시. 반환: 절점 좌표, 요소 연결, 면 태그 정보, 표면 T6."""
    import gmsh
    from OCP.BRepTools import BRepTools

    fd, path = tempfile.mkstemp(suffix=".brep")
    os.close(fd)
    try:
        BRepTools.Write_s(shape, path)
        if gmsh.isInitialized():
            gmsh.finalize()
        gmsh.initialize(["-noenv"], readConfigFiles=False, interruptible=False)
        try:
            gmsh.option.setNumber("General.Terminal", 0)
            gmsh.option.setNumber("General.NumThreads", 0)
            gmsh.model.add("part")
            gmsh.model.occ.importShapes(path)
            gmsh.model.occ.synchronize()
            gmsh.option.setNumber("Mesh.MeshSizeMax", size)
            gmsh.option.setNumber("Mesh.MeshSizeMin", size * 0.15)
            gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 12)
            gmsh.option.setNumber("Mesh.ElementOrder", 2)
            gmsh.option.setNumber("Mesh.SecondOrderLinear", 0)
            gmsh.option.setNumber("Mesh.Algorithm3D", 1)
            gmsh.model.mesh.generate(3)

            tags, coords, _ = gmsh.model.mesh.getNodes()
            xyz = coords.reshape(-1, 3)
            index = np.zeros(int(tags.max()) + 1, dtype=np.int64)
            index[tags.astype(np.int64)] = np.arange(len(tags))

            _, enodes = gmsh.model.mesh.getElementsByType(11)  # 10절점 사면체
            if len(enodes) == 0:
                raise g.GeometryError("솔리드 메시를 만들지 못했습니다 — 닫힌 솔리드인지 확인하세요")
            tets = index[enodes.astype(np.int64)].reshape(-1, 10)

            surfaces = {}
            for _, stag in gmsh.model.getEntities(2):
                _, snodes = gmsh.model.mesh.getElementsByType(9, stag)  # 6절점 삼각형
                com = gmsh.model.occ.getCenterOfMass(2, stag)
                area = gmsh.model.occ.getMass(2, stag)
                surfaces[stag] = {"tri6": index[snodes.astype(np.int64)].reshape(-1, 6), "center": np.array(com), "area": area}
            return xyz, tets, surfaces
        finally:
            gmsh.finalize()
    finally:
        os.remove(path)


def _order_tets(xyz, tets):
    """gmsh 중간 절점 순서를 _EDGES 순서로 맞춘다(기하로 판별하므로 순서 규약에 의존하지 않음)."""
    corner = xyz[tets[:, :4]]
    mids = xyz[tets[:, 4:]]
    out = tets.copy()
    for k, (i, j) in enumerate(_EDGES):
        target = (corner[:, i] + corner[:, j]) / 2
        d = np.linalg.norm(mids - target[:, None, :], axis=2)
        out[:, 4 + k] = tets[np.arange(len(tets)), 4 + np.argmin(d, axis=1)]
    return out


def _match_faces(shape, surfaces):
    """Datum 면 번호 → gmsh 면 태그 (면 중심·면적으로 대응)."""
    n = g.sub_map(shape, "face").Extent()
    mapping = {}
    used = set()
    for i in range(n):
        d = g.describe(shape, "face", i)
        c, a = np.array(d["center"]), d["area"]
        best, score = None, 1e300
        for tag, s in surfaces.items():
            if tag in used:
                continue
            sc = np.linalg.norm(s["center"] - c) + abs(s["area"] - a) / max(a, 1e-9)
            if sc < score:
                best, score = tag, sc
        mapping[i] = best
        used.add(best)
    return mapping


# ------------------------------------------------------------------ 해석
def _direction(spec: str):
    return {"x": [1, 0, 0], "-x": [-1, 0, 0], "y": [0, 1, 0], "-y": [0, -1, 0], "z": [0, 0, 1], "-z": [0, 0, -1]}.get(spec)


def static_analysis(shape, fixed: list[int], loads: list[dict], material: dict, density: str = "normal") -> dict:
    """loads: [{faces:[...], type:'force'|'pressure', value:N 또는 MPa, dir:'normal'|'x'|'-y'...}]"""
    if not fixed:
        raise g.GeometryError("고정할 면을 하나 이상 고르세요")
    if not loads or not any(l.get("faces") for l in loads):
        raise g.GeometryError("하중을 줄 면을 고르세요")
    E, nu, yld = float(material["E"]), float(material["nu"]), float(material.get("yield", 0) or 0)
    if E <= 0 or not 0 <= nu < 0.5:
        raise g.GeometryError("재질 값(E, 푸아송비)을 확인하세요")

    lo, hi = g.bbox(shape)
    diag = math.dist(lo, hi)
    vol = g.mass_properties(shape)["volume"]
    target = {"coarse": 3500, "normal": 9000, "fine": 22000}.get(density, 9000)
    size = max((vol * 6 * math.sqrt(2) / target) ** (1 / 3) * 1.6, diag / 120)  # 요소 수가 대략 target이 되도록
    size = min(size, diag / 6)

    with _gmsh_lock:
        xyz, tets, surfaces = _mesh(shape, size)
    tets = _order_tets(xyz, tets)
    fmap = _match_faces(shape, surfaces)
    nn = len(xyz)
    ndof = nn * 3
    D = _elasticity(E, nu)

    # --- 강성행렬 조립(덩어리 단위로 메모리 절약)
    rows, cols, vals = [], [], []
    for s in range(0, len(tets), 4000):
        T = tets[s:s + 4000]
        X = xyz[T]  # (e,10,3)
        Ke = np.zeros((len(T), 30, 30))
        for gp in range(4):
            J = np.einsum("eni,nj->eij", X, _DN_GAUSS[gp])
            det = np.linalg.det(J)
            if np.any(det <= 0):
                raise g.GeometryError("메시 품질이 나쁩니다 — 메시 밀도를 바꿔 보세요")
            dNdx = np.einsum("nj,eji->eni", _DN_GAUSS[gp], np.linalg.inv(J))
            B = _bmat(dNdx)
            Ke += np.matmul(B.transpose(0, 2, 1), np.matmul(D, B)) * (det / 24)[:, None, None]  # 가중치 1/24
        dofs = (T[:, :, None] * 3 + np.arange(3)).reshape(len(T), 30)
        rows.append(np.repeat(dofs, 30, axis=1).ravel())
        cols.append(np.tile(dofs, (1, 30)).ravel())
        vals.append(Ke.ravel())
    K = coo_matrix((np.concatenate(vals), (np.concatenate(rows), np.concatenate(cols))), shape=(ndof, ndof)).tocsr()

    # --- 하중(6절점 삼각형 균일 분포 → 꼭짓점 0, 중간 절점 각 1/3)
    F = np.zeros(ndof)
    total_force = np.zeros(3)
    opposite = {}
    for a_, b_, c_, d_ in tets[:, :4]:
        opposite[tuple(sorted((a_, b_, c_)))] = d_
        opposite[tuple(sorted((a_, b_, d_)))] = c_
        opposite[tuple(sorted((a_, c_, d_)))] = b_
        opposite[tuple(sorted((b_, c_, d_)))] = a_
    for ld in loads:
        tris = [surfaces[fmap[f]]["tri6"] for f in ld.get("faces", []) if fmap.get(f) in surfaces]
        if not tris:
            continue
        tri = np.vstack(tris)
        p0, p1, p2 = xyz[tri[:, 0]], xyz[tri[:, 1]], xyz[tri[:, 2]]
        cr = np.cross(p1 - p0, p2 - p0)
        area = np.linalg.norm(cr, axis=1) / 2
        normal = cr / np.maximum(np.linalg.norm(cr, axis=1), 1e-30)[:, None]
        # 바깥 법선: 그 삼각형을 면으로 가진 사면체의 반대편 꼭짓점(솔리드 안쪽)에서 멀어지는 방향
        opp = np.array([opposite.get(tuple(sorted(t[:3])), t[0]) for t in tri])
        inward = np.einsum("ij,ij->i", normal, xyz[opp] - p0) > 0
        outward = normal * np.where(inward, -1, 1)[:, None]
        val = float(ld["value"])
        total_area = area.sum()
        pressure = val if ld.get("type") == "pressure" else val / total_area
        d = ld.get("dir", "normal")
        if d in ("normal", "-normal"):
            # '법선' = 면을 누르는 방향(안쪽), '-법선' = 당기는 방향(바깥)
            vec = -outward if d == "normal" else outward
        else:
            vec = np.tile(np.array(_direction(d), float), (len(tri), 1))
        f_tri = vec * (pressure * area)[:, None]
        total_force += f_tri.sum(axis=0)
        for m in (3, 4, 5):
            np.add.at(F, tri[:, m] * 3 + 0, f_tri[:, 0] / 3)
            np.add.at(F, tri[:, m] * 3 + 1, f_tri[:, 1] / 3)
            np.add.at(F, tri[:, m] * 3 + 2, f_tri[:, 2] / 3)

    # --- 고정 경계
    fixed_nodes = np.unique(np.concatenate([surfaces[fmap[f]]["tri6"].ravel() for f in fixed if fmap.get(f) in surfaces]))
    is_fixed = np.zeros(ndof, bool)
    for k in range(3):
        is_fixed[fixed_nodes * 3 + k] = True
    free = np.where(~is_fixed)[0]
    used = np.zeros(nn, bool)
    used[tets.ravel()] = True
    free = free[used[free // 3]]

    U = np.zeros(ndof)
    U[free] = _solve(K[free][:, free].tocsr(), F[free], xyz[free // 3], free % 3)
    if not np.all(np.isfinite(U)):
        raise g.GeometryError("해석이 수렴하지 않았습니다 — 고정 조건이 충분한지 확인하세요(강체 운동)")
    disp = U.reshape(-1, 3)

    # --- 응력: 각 요소의 꼭짓점에서 계산 → 절점 평균(중간 절점은 양 끝 평균)
    vm_sum = np.zeros(nn)
    cnt = np.zeros(nn)
    for s in range(0, len(tets), 8000):
        T = tets[s:s + 8000]
        X = xyz[T]
        Ue = U[(T[:, :, None] * 3 + np.arange(3)).reshape(len(T), 30)]
        for c in range(4):
            J = np.einsum("eni,nj->eij", X, _DN_CORNER[c])
            dNdx = np.einsum("nj,eji->eni", _DN_CORNER[c], np.linalg.inv(J))
            sig = np.einsum("kl,elj,ej->ek", D, _bmat(dNdx), Ue)
            np.add.at(vm_sum, T[:, c], _von_mises(sig))
            np.add.at(cnt, T[:, c], 1)
    vm = np.where(cnt > 0, vm_sum / np.maximum(cnt, 1), 0)
    for k, (i, j) in enumerate(_EDGES):
        mid = tets[:, 4 + k]
        vm[mid] = (vm[tets[:, i]] + vm[tets[:, j]]) / 2

    # --- 표시용 표면: T6 → 선형 삼각형 4개
    tri6 = np.vstack([s["tri6"] for s in surfaces.values()])
    a, b, c, ab, bc, ca = tri6.T
    tris = np.concatenate([np.stack([a, ab, ca], 1), np.stack([ab, b, bc], 1), np.stack([ca, bc, c], 1), np.stack([ab, bc, ca], 1)])
    surf_nodes, inv = np.unique(tris, return_inverse=True)
    P = xyz[surf_nodes]
    tri_local = inv.reshape(-1, 3)

    dmag = np.linalg.norm(disp, axis=1)
    imax_vm = int(np.argmax(vm))
    imax_d = int(np.argmax(dmag))
    vm_max = float(vm.max())
    return {
        "nodes": len(xyz), "elements": len(tets), "dofs": int(len(free)), "mesh_size": size,
        "surface": {
            "pos": np.round(P, 5).ravel().tolist(),
            "idx": tri_local.ravel().tolist(),
            "disp": np.round(disp[surf_nodes], 9).ravel().tolist(),
            "vm": np.round(vm[surf_nodes], 5).tolist(),
        },
        "max_vm": vm_max, "min_vm": float(vm[used].min()), "max_vm_at": xyz[imax_vm].round(4).tolist(),
        "max_disp": float(dmag.max()), "max_disp_at": xyz[imax_d].round(4).tolist(),
        "fos": (yld / vm_max) if yld and vm_max > 0 else None,
        "yield": yld, "applied_force": total_force.round(6).tolist(),
    }
