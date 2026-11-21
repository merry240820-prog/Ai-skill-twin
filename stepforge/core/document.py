"""문서 = 바디 목록 + 작업 기록(피처 트리) + 실행 취소/다시 실행."""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field

from . import geometry as g

_ids = itertools.count(1)


@dataclass
class Body:
    name: str
    shape: object
    color: str = "#b9c0c8"
    visible: bool = True
    id: int = field(default_factory=lambda: next(_ids))


@dataclass
class Snapshot:
    label: str
    bodies: list  # Body 복사본 목록(형상은 불변이라 얕은 복사로 충분)


class Document:
    MAX_UNDO = 100

    def __init__(self):
        self.name = "새 문서"
        self.bodies: list[Body] = []
        self.history: list[Snapshot] = []  # 실행된 작업들
        self.undone: list[Snapshot] = []  # 다시 실행 대기열
        self.revision = 0

    # ------------------------------------------------ 상태 관리
    def _copy(self) -> list[Body]:
        return [Body(b.name, b.shape, b.color, b.visible, b.id) for b in self.bodies]

    def commit(self, label: str):
        """작업 직전 상태를 저장하는 대신, 작업 직후 상태를 기록한다."""
        self.history.append(Snapshot(label, self._copy()))
        if len(self.history) > self.MAX_UNDO:
            self.history.pop(0)
        self.undone.clear()
        self.revision += 1

    def undo(self):
        if len(self.history) <= 1:
            raise g.GeometryError("더 이상 취소할 작업이 없습니다")
        self.undone.append(self.history.pop())
        self.bodies = [Body(b.name, b.shape, b.color, b.visible, b.id) for b in self.history[-1].bodies]
        self.revision += 1

    def redo(self):
        if not self.undone:
            raise g.GeometryError("다시 실행할 작업이 없습니다")
        snap = self.undone.pop()
        self.history.append(snap)
        self.bodies = [Body(b.name, b.shape, b.color, b.visible, b.id) for b in snap.bodies]
        self.revision += 1

    def body(self, body_id: int) -> Body:
        for b in self.bodies:
            if b.id == body_id:
                return b
        raise g.GeometryError(f"바디 {body_id} 가 없습니다")

    # ------------------------------------------------ 파일
    def new(self):
        self.__init__()
        self.commit("새 문서")

    def open_step(self, path: str, name: str):
        shapes = g.read_step(path)
        self.__init__()
        self.name = name
        stem = name.rsplit(".", 1)[0]
        for i, s in enumerate(shapes):
            self.bodies.append(Body(f"{stem}-{i + 1}" if len(shapes) > 1 else stem, s))
        self.commit(f"열기: {name}")

    def import_step(self, path: str, name: str):
        """현재 문서에 STEP을 추가로 불러온다(조립/합치기용)."""
        stem = name.rsplit(".", 1)[0]
        for i, s in enumerate(g.read_step(path)):
            self.bodies.append(Body(f"{stem}-{i + 1}", s, "#c8b89f"))
        self.commit(f"가져오기: {name}")

    def visible_shapes(self):
        return [b.shape for b in self.bodies if b.visible]

    def all_shapes(self):
        return [b.shape for b in self.bodies]

    # ------------------------------------------------ 편집 작업(모두 실행 취소 가능)
    def add_primitive(self, kind: str, params: dict):
        names = {"box": "상자", "cylinder": "원통", "sphere": "구", "cone": "원뿔"}
        shape = g.make_primitive(kind, params)
        n = sum(1 for b in self.bodies if b.name.startswith(names[kind])) + 1
        self.bodies.append(Body(f"{names[kind]}{n}", shape))
        self.commit(f"{names[kind]} 만들기")

    def replace(self, body_id: int, shape, label: str):
        self.body(body_id).shape = shape
        self.commit(label)

    def boolean(self, op: str, target_id: int, tool_id: int, keep_tool: bool = False):
        if target_id == tool_id:
            raise g.GeometryError("서로 다른 바디 두 개를 고르세요")
        target, tool = self.body(target_id), self.body(tool_id)
        target.shape = g.boolean(op, target.shape, tool.shape)
        if not keep_tool:
            self.bodies.remove(tool)
        label = {"union": "합치기", "cut": "빼기", "intersect": "교차"}[op]
        self.commit(f"{label}: {target.name} ← {tool.name}")

    def delete_body(self, body_id: int):
        b = self.body(body_id)
        self.bodies.remove(b)
        self.commit(f"바디 삭제: {b.name}")

    def copy_body(self, body_id: int, dx=0.0, dy=0.0, dz=0.0):
        b = self.body(body_id)
        nb = Body(b.name + " 복사", g.translate(b.shape, dx, dy, dz), b.color)
        self.bodies.append(nb)
        self.commit(f"복사: {b.name}")

    def set_props(self, body_id: int, name=None, color=None, visible=None):
        b = self.body(body_id)
        if name is not None:
            b.name = name
        if color is not None:
            b.color = color
        if visible is not None:
            b.visible = visible
        if name is not None or color is not None:  # 보이기/숨기기는 기록하지 않는다
            self.commit(f"속성 변경: {b.name}")

    def history_labels(self):
        return [s.label for s in self.history], [s.label for s in reversed(self.undone)]
