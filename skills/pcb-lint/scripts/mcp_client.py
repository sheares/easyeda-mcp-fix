"""Thin MCP client wrapper (real-shape edition, Phase 1.6).

Signatures + return-shape docstrings match the fork's live schema as of
2026-07-20. Every schematic tool now takes a required `document` UUID.

The wire itself remains stubbed (raises NotImplementedError) because
the primary invocation path is Claude-in-session calling
`mcp__easyeda__*` directly per SKILL.md. This client is used by the
Python test harness with a MockMCPClient in its place; Phase 5+ could
wire the real `mcp` Python package here for headless / CI use.
"""

from __future__ import annotations

import time
from typing import Any


class MCPUnreachable(RuntimeError):
    """Raised when the MCP bridge cannot be reached."""


class MCPClient:
    RETRY_COUNT = 2
    RETRY_BACKOFF_S = 1.0

    def __init__(self, endpoint: str = "stdio://easyeda-mcp") -> None:
        self.endpoint = endpoint

    def _call(self, tool: str, **kwargs: Any) -> Any:
        raise NotImplementedError(
            f"MCP wire not connected (tool={tool}). Primary path is Claude in-session; "
            "Python runner mode wires this in a future phase."
        )

    def _call_with_retry(self, tool: str, **kwargs: Any) -> Any:
        last_exc: Exception | None = None
        for attempt in range(self.RETRY_COUNT + 1):
            try:
                return self._call(tool, **kwargs)
            except MCPUnreachable as e:
                last_exc = e
                if attempt < self.RETRY_COUNT:
                    time.sleep(self.RETRY_BACKOFF_S)
                    continue
                raise
        assert last_exc is not None
        raise last_exc

    def server_info(self) -> dict:
        """Real shape: {wsPort, extensionConnected, connectedInstanceCount, instances, allowAllOrigins}."""
        return {
            "wsPort": 0,
            "extensionConnected": False,
            "connectedInstanceCount": 0,
            "instances": [],
            "bridge": "not-connected",
        }

    # --- Schematic ---

    def sch_run_drc(self, document: str) -> dict:
        """Real shape: {passed: bool, errors: list[dict]}. Warnings key not present on all builds."""
        return self._call_with_retry("sch_run_drc", document=document)

    def sch_get_all_components(
        self,
        document: str,
        *,
        component_type: str | list[str] | None = None,
        fields: list[str] | None = None,
    ) -> dict:
        """Real shape: {items: list[RealComponent], _availableFields: list[str]}.

        `component_type` = "part" (usual) filters out sheets/netflags/netports/etc.
        `fields` projects the response to the named keys to keep payload small.
        """
        kwargs: dict[str, Any] = {"document": document}
        if fields is not None:
            kwargs["fields"] = fields
        if component_type is not None:
            kwargs["filter"] = {"componentType": component_type}
        return self._call_with_retry("sch_get_all_components", **kwargs)

    def sch_get_component_pins(self, document: str, primitive_id: str) -> list[dict]:
        """Real shape: list[RealPin]. Prefer sch_get_connectivity for whole-schematic queries."""
        return self._call_with_retry(
            "sch_get_component_pins", document=document, primitiveId=primitive_id
        )

    def sch_get_connectivity(
        self,
        document: str,
        *,
        designators: list[str] | None = None,
        nets: list[str] | None = None,
        depth: int | None = None,
    ) -> dict:
        """Compact netlist view. Real shape: RealConnectivity.

        This is the primary source of pin-to-net data. One call replaces
        N per-component `sch_get_component_pins` round-trips.
        """
        kwargs: dict[str, Any] = {"document": document}
        if designators is not None:
            kwargs["designators"] = designators
        if nets is not None:
            kwargs["nets"] = nets
        if depth is not None:
            kwargs["depth"] = depth
        return self._call_with_retry("sch_get_connectivity", **kwargs)

    def sch_export_bom(self, document: str) -> list[dict]:
        """Real shape: list of dicts keyed by BOM column ("Designator", "Supplier Part", etc)."""
        return self._call_with_retry("sch_export_bom", document=document)

    # --- PCB (Phase 2) ---

    def pcb_run_drc(self, document: str, *, verbose: bool = True) -> list[dict]:
        """Returns list of violation dicts, or [] if clean."""
        return self._call_with_retry("pcb_run_drc", document=document, verbose=verbose)

    def pcb_get_design_rules(self, document: str) -> dict:
        return self._call_with_retry("pcb_get_design_rules", document=document)

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
        """Returns list of primitive dicts. `type` = component | track | polyline | via | pad | pour | fill | arc | region."""
        kwargs: dict[str, Any] = {"document": document, "type": type}
        if layer is not None:
            kwargs["layer"] = layer
        if net is not None:
            kwargs["net"] = net
        if fields is not None:
            kwargs["fields"] = fields
        if limit is not None:
            kwargs["limit"] = limit
        return self._call_with_retry("pcb_get_all_primitives", **kwargs)
