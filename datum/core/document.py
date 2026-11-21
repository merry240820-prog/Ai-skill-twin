"""문서 = 바디 목록 + 타임라인(작업 기록) + 실행 취소/다시 실행/되돌아가기."""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field, replace

from . import assembly
from . import geometry as g
from . import stepio

_ids = itertools.count(1)
_revs = itertools.count(1)

PALETTE = ["#b9c0c8", "#8fb3d9", "#d9b48f", "#9fcf9f", "#c9a3d6", "#d99a9a", "#a3c9c9", "#cfc58a"]


@dataclass
class Body:
    name: str
    shape: object
    color: str = PALETTE[0]
    visible: bool = True
    fixed: bool = False  # 어셈블리에서 움직이지 않는 부품(솔리드웍스의 '고정')
    id: int = field(default_factory=lambda: next(_ids))
    rev: int = field(default_factory=lambda: next(_revs))  # 형상이 바뀔 때마다 증가 → 화면 메시 캐시 키

    def set_shape(self, shape):
        self.shape = shape
        self.rev = next(_revs)


@dataclass
class Step:
    label: str
    kind: str  # 타임라인 아이콘용 작업 종류
    bodies: list
    mates: list = field(default_factory=list)


class Document:
    MAX_UNDO = 200

    def __init__(self):
        self.name = "새 문서"
        self.bodies: list[Body] = []
        self.history: list[Step] = []
        self.undone: list[Step] = []
        self.mates: list[dict] = []
        self.residual: dict = {}
        self.revision = 0
        self._mate_ids = itertools.count(1)

    # ------------------------------------------------ 타임라인
    def _copy(self) -> list[Body]:
        return [replace(b) for b in self.bodies]

    def commit(self, label: str, kind: str = "edit"):
        if self.mates:
            self._solve()
        self.history.append(Step(label, kind, self._copy(), [dict(m) for m in self.mates]))
        if len(self.history) > self.MAX_UNDO:
            self.history.pop(0)
        self.undone.clear()
        self.revision += 1

    def _restore(self, step: Step):
        # 보이기/숨기기는 화면 상태라 되돌리지 않는다
        vis = {b.id: b.visible for b in self.bodies}
        self.bodies = [replace(b, visible=vis.get(b.id, b.visible)) for b in step.bodies]
        self.mates = [dict(m) for m in step.mates]
        self._residuals()
        self.revision += 1

    def undo(self):
        if len(self.history) <= 1:
            raise g.GeometryError("더 이상 취소할 작업이 없습니다")
        self.undone.append(self.history.pop())
        self._restore(self.history[-1])

    def redo(self):
        if not self.undone:
            raise g.GeometryError("다시 실행할 작업이 없습니다")
        step = self.undone.pop()
        self.history.append(step)
        self._restore(step)

    def goto(self, index: int):
        """타임라인의 index 번째 작업 직후 상태로 이동(앞뒤 모두 가능)."""
        total = len(self.history) + len(self.undone)
        if not 0 <= index < total:
            raise g.GeometryError("타임라인 범위를 벗어났습니다")
        while len(self.history) - 1 > index:
            self.undone.append(self.history.pop())
        while len(self.history) - 1 < index:
            self.history.append(self.undone.pop())
        self._restore(self.history[-1])

    def body(self, body_id: int) -> Body:
        for b in self.bodies:
            if b.id == body_id:
                return b
        raise g.GeometryError("바디를 찾을 수 없습니다 — 다시 선택하세요")

    # ------------------------------------------------ 파일
    def new(self):
        self.__init__()
        self.commit("새 문서", "new")

    def _add_parts(self, parts, stem):
        for i, p in enumerate(parts):
            name = p["name"] if p["name"] not in ("Part", "", None) else f"{stem}-{i + 1}"
            self.bodies.append(Body(name, p["shape"], p.get("color") or PALETTE[len(self.bodies) % len(PALETTE)]))

    def open_step(self, path: str, name: str):
        parts = stepio.read_step(path)
        self.__init__()
        self.name = name
        self._add_parts(parts, name.rsplit(".", 1)[0])
        if len(self.bodies) > 1:
            self.bodies[0].fixed = True  # 솔리드웍스처럼 첫 부품을 고정
        self.commit(f"열기 · {name}", "open")

    def import_step(self, path: str, name: str):
        self._add_parts(stepio.read_step(path), name.rsplit(".", 1)[0])
        self.commit(f"가져오기 · {name}", "import")

    def parts(self, visible_only=False):
        return [{"name": b.name, "shape": b.shape, "color": b.color}
                for b in self.bodies if b.visible or not visible_only]

    # ------------------------------------------------ 편집
    def add_primitive(self, kind: str, params: dict):
        names = {"box": "상자", "cylinder": "원통", "sphere": "구", "cone": "원뿔"}
        shape = g.make_primitive(kind, params)
        n = sum(1 for b in self.bodies if b.name.startswith(names[kind])) + 1
        self.bodies.append(Body(f"{names[kind]}{n}", shape, PALETTE[len(self.bodies) % len(PALETTE)]))
        self.commit(f"{names[kind]} 만들기", "primitive")

    def replace_shape(self, body_id: int, shape, label: str, kind: str):
        b = self.body(body_id)
        b.set_shape(shape)
        self.commit(f"{label} · {b.name}", kind)

    def boolean(self, op: str, target_id: int, tool_id: int, keep_tool: bool = False):
        if target_id == tool_id:
            raise g.GeometryError("서로 다른 바디 두 개를 고르세요")
        target, tool = self.body(target_id), self.body(tool_id)
        target.set_shape(g.boolean(op, target.shape, tool.shape))
        if not keep_tool:
            self.bodies.remove(tool)
        label = {"union": "합치기", "cut": "빼기", "intersect": "교차"}[op]
        self.commit(f"{label} · {target.name} ← {tool.name}", op)

    def delete_body(self, body_id: int):
        b = self.body(body_id)
        self.bodies.remove(b)
        self.mates = [m for m in self.mates if body_id not in (m["ref"]["body"], m["mov"]["body"])]
        self.commit(f"바디 삭제 · {b.name}", "delete")

    def copy_body(self, body_id: int, dx=0.0, dy=0.0, dz=0.0):
        b = self.body(body_id)
        self.bodies.append(Body(b.name + " 복사", g.translate(b.shape, dx, dy, dz), b.color))
        self.commit(f"복사 · {b.name}", "copy")

    def pattern(self, body_id: int, copies: list, merge: bool, label: str):
        b = self.body(body_id)
        if merge:
            shape = b.shape
            for c in copies:
                shape = g.boolean("union", shape, c)
            b.set_shape(shape)
        else:
            for k, c in enumerate(copies, start=2):
                self.bodies.append(Body(f"{b.name} ({k})", c, b.color))
        self.commit(f"{label} · {b.name}", "pattern")

    def set_props(self, body_id: int, name=None, color=None, visible=None):
        b = self.body(body_id)
        if visible is not None:
            b.visible = visible
        if name is not None or color is not None:
            if name is not None:
                b.name = name
            if color is not None:
                b.color = color
            self.commit(f"속성 · {b.name}", "props")
        else:
            self.revision += 1

    # ------------------------------------------------ 어셈블리
    def _solve(self):
        shapes = {b.id: b.shape for b in self.bodies}
        before = dict(shapes)
        live = [m for m in self.mates if m["ref"]["body"] in shapes and m["mov"]["body"] in shapes]
        self.residual = assembly.solve(live, shapes, {b.id for b in self.bodies if b.fixed})
        for b in self.bodies:
            if shapes[b.id] is not before[b.id]:
                b.set_shape(shapes[b.id])

    def _residuals(self):
        shapes = {b.id: b.shape for b in self.bodies}
        self.residual = {m["id"]: assembly._current_residual(m, shapes) for m in self.mates
                         if m["ref"]["body"] in shapes and m["mov"]["body"] in shapes}

    def add_mate(self, kind: str, ref: dict, mov: dict, offset: float = 0.0, aligned: bool = False):
        if ref["body"] == mov["body"]:
            raise g.GeometryError("서로 다른 부품의 요소를 고르세요")
        m = {"id": next(self._mate_ids), "type": kind, "ref": ref, "mov": mov, "offset": offset, "aligned": aligned}
        # 먼저 한 번 풀어 보고 실패하면 추가하지 않는다
        shapes = {b.id: b.shape for b in self.bodies}
        assembly.solve([m], shapes, {b.id for b in self.bodies if b.fixed})
        if assembly._current_residual(m, shapes) > 1e-4:
            raise g.GeometryError("메이트를 적용할 수 없습니다 — 두 부품이 모두 고정이거나 요소 종류가 맞지 않습니다")
        self.mates.append(m)
        self.commit(f"메이트 {assembly.MATE_NAMES[kind]} · {self.body(ref['body']).name} ↔ {self.body(mov['body']).name}", "mate")

    def delete_mate(self, mate_id: int):
        m = next((x for x in self.mates if x["id"] == mate_id), None)
        if not m:
            raise g.GeometryError("메이트를 찾을 수 없습니다")
        self.mates.remove(m)
        self.commit(f"메이트 삭제 · {assembly.MATE_NAMES[m['type']]}", "delete")

    def edit_mate(self, mate_id: int, offset=None, aligned=None):
        m = next((x for x in self.mates if x["id"] == mate_id), None)
        if not m:
            raise g.GeometryError("메이트를 찾을 수 없습니다")
        if offset is not None:
            m["offset"] = float(offset)
        if aligned is not None:
            m["aligned"] = bool(aligned)
        self.commit(f"메이트 수정 · {assembly.MATE_NAMES[m['type']]}", "mate")

    def set_fixed(self, body_id: int, fixed: bool):
        b = self.body(body_id)
        b.fixed = fixed
        self.commit(f"{'고정' if fixed else '고정 해제'} · {b.name}", "fix")

    def rebuild(self):
        self.commit("재생성", "rebuild")

    def mate_list(self):
        out = []
        for m in self.mates:
            try:
                rn, mn = self.body(m["ref"]["body"]).name, self.body(m["mov"]["body"]).name
            except g.GeometryError:
                continue
            r = self.residual.get(m["id"], 0)
            out.append({"id": m["id"], "type": m["type"], "name": assembly.MATE_NAMES[m["type"]],
                        "label": f"{rn} ↔ {mn}", "offset": m.get("offset", 0), "aligned": m.get("aligned", False),
                        "ok": r < 1e-4, "bodies": [m["ref"]["body"], m["mov"]["body"]]})
        return out

    def timeline(self):
        return ([{"label": s.label, "kind": s.kind} for s in self.history],
                [{"label": s.label, "kind": s.kind} for s in reversed(self.undone)])
