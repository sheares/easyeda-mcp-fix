"""Shared pytest fixtures for check tests (Phase 1.6 shapes)."""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


SKILL_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL_ROOT / "scripts"

if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))


class MockMCPClient:
    """Deterministic stand-in for MCPClient, real-shape edition.

    All schematic tools take a `document` positional arg (matching real
    MCP); the mock ignores its value.
    """

    def __init__(
        self,
        *,
        components: list[dict] | None = None,
        connectivity: dict | None = None,
        bom: list[dict] | None = None,
        drc: dict | None = None,
        pins_by_component: dict[str, list[dict]] | None = None,
        server: dict | None = None,
        pcb_drc: list[dict] | None = None,
        pcb_primitives: dict[str, list[dict]] | None = None,
        pcb_rules: dict | None = None,
    ) -> None:
        self._components = components or []
        self._connectivity = connectivity or {"nets": {}, "components": {}}
        self._bom = bom or []
        self._drc = drc or {"passed": True, "errors": []}
        self._pins = pins_by_component or {}
        self._server = server or {
            "wsPort": 0,
            "extensionConnected": True,
            "connectedInstanceCount": 1,
            "bridge": "mock",
        }
        self._pcb_drc = pcb_drc or []
        self._pcb_primitives = pcb_primitives or {}
        self._pcb_rules = pcb_rules or {}

    def server_info(self) -> dict:
        return self._server

    def sch_run_drc(self, document: str) -> dict:
        return self._drc

    def sch_get_all_components(
        self,
        document: str,
        *,
        component_type: str | list[str] | None = None,
        fields: list[str] | None = None,
    ) -> dict:
        items = self._components
        if component_type is not None:
            wanted = {component_type} if isinstance(component_type, str) else set(component_type)
            items = [c for c in items if c.get("componentType") in wanted]
        return {"items": items, "_availableFields": []}

    def sch_get_component_pins(self, document: str, primitive_id: str) -> list[dict]:
        return self._pins.get(primitive_id, [])

    def sch_get_connectivity(
        self,
        document: str,
        *,
        designators: list[str] | None = None,
        nets: list[str] | None = None,
        depth: int | None = None,
    ) -> dict:
        # Mock ignores filter args; whole cached connectivity is returned.
        return self._connectivity

    def sch_export_bom(self, document: str) -> list[dict]:
        return self._bom

    # --- PCB (Phase 2) ---

    def pcb_run_drc(self, document: str, *, verbose: bool = True) -> list[dict]:
        return getattr(self, "_pcb_drc", [])

    def pcb_get_design_rules(self, document: str) -> dict:
        return getattr(self, "_pcb_rules", {})

    def pcb_get_all_primitives(
        self,
        document: str,
        *,
        type: str,
        layer: str | None = None,
        net: str | None = None,
        fields: list[str] | None = None,
        limit: int | None = None,
    ) -> list[dict]:
        items = getattr(self, "_pcb_primitives", {}).get(type, [])
        if layer is not None:
            items = [it for it in items if str(it.get("layer")) == str(layer)]
        if net is not None:
            items = [it for it in items if it.get("net") == net]
        if limit is not None:
            items = items[:limit]
        return items


def run_check(check_cls: type, client: Any, config: dict | None = None) -> list[dict]:
    """Helper: instantiate a check class and run it against a mock client."""
    cfg = {"document": "mock-doc"}
    if config:
        cfg.update(config)
    return check_cls().run(client=client, config=cfg)
