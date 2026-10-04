"""PCB-05: TVS proximity to connector.

For each connector-side signal that has a TVS on the net, verify the
TVS is physically close to the connector (< 10 mm, per PCB best practice).

MVP scope: distance from connector-component centre to TVS-component
centre. Ignores whether there's a via between them (defer to Phase 3.1
which needs track-path tracing).

TVS identification heuristic: component name matches known ESD-diode
family patterns (USBLC, SP0503, ESDA, PESD, TPD, etc). Extend as needed.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import MM_TO_MIL, distance_mil, infer_functional_type


TVS_NAME_HINTS = ("USBLC", "SP0503", "ESDA", "PESD", "TPD", "TVS", "ESD")
CONNECTOR_DESIGNATOR_PREFIXES = ("CN", "J", "P")

TVS_PROXIMITY_MAX_MM = 10.0


def _is_tvs(component: dict) -> bool:
    name = (component.get("name") or "").upper()
    mfr = (component.get("manufacturerId") or "").upper()
    return any(h in name or h in mfr for h in TVS_NAME_HINTS)


def _is_connector(component: dict) -> bool:
    return (component.get("designator") or "").upper().startswith(CONNECTOR_DESIGNATOR_PREFIXES)


@register
class PcbTvsProximity(Check):
    id = "PCB-05"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        sch_parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])
        tvs_components = [c for c in sch_parts if _is_tvs(c)]
        if not tvs_components:
            return []
        connector_components = [c for c in sch_parts if _is_connector(c)]

        pcb_components = client.pcb_get_all_primitives(document, type="component") or []
        if isinstance(pcb_components, dict):
            pcb_components = pcb_components.get("items", [])
        pos_by_designator: dict[str, tuple[float, float]] = {
            (c.get("designator") or "").upper(): (c.get("x", 0.0), c.get("y", 0.0))
            for c in pcb_components
        }

        # Find nets connecting each TVS to each connector via connectivity
        tvs_designators = [c.get("designator") for c in tvs_components if c.get("designator")]
        connector_designators = [c.get("designator") for c in connector_components if c.get("designator")]
        conn = client.sch_get_connectivity(
            document, designators=tvs_designators + connector_designators, depth=1
        ) or {}
        conn_comps = conn.get("components", {}) or {}
        conn_nets = conn.get("nets", {}) or {}

        threshold_mil = TVS_PROXIMITY_MAX_MM * MM_TO_MIL
        findings: list[dict] = []

        for tvs in tvs_components:
            tvs_desig = (tvs.get("designator") or "").upper()
            tvs_pos = pos_by_designator.get(tvs_desig)
            if tvs_pos is None:
                continue
            tvs_pins = (conn_comps.get(tvs_desig, {}).get("pins") or {})
            tvs_nets = {p.get("net") for p in tvs_pins.values() if p.get("net") and p.get("net") not in ("GND",)}

            # Which connector shares a net with this TVS?
            paired_connectors: dict[str, list[str]] = {}
            for net in tvs_nets:
                for entry in conn_nets.get(net, []):
                    dot = entry.find(".")
                    if dot <= 0:
                        continue
                    desig = entry[:dot].upper()
                    if any(desig.startswith(p) for p in CONNECTOR_DESIGNATOR_PREFIXES):
                        paired_connectors.setdefault(desig, []).append(net)

            for conn_desig, shared_nets in paired_connectors.items():
                conn_pos = pos_by_designator.get(conn_desig)
                if conn_pos is None:
                    continue
                d_mil = distance_mil(tvs_pos[0], tvs_pos[1], conn_pos[0], conn_pos[1])
                if d_mil > threshold_mil:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="warn",
                            message=(
                                f"{tvs_desig} is {d_mil / MM_TO_MIL:.1f} mm from {conn_desig} "
                                f"(target <= {TVS_PROXIMITY_MAX_MM:.0f} mm) via nets {sorted(set(shared_nets))}"
                            ),
                            offending_ids=[f"{tvs_desig}<->{conn_desig}"],
                            suggestion=(
                                "Move the TVS physically adjacent to the connector pins it protects. "
                                "ESD current takes the path of lowest inductance; distance defeats the clamp."
                            ),
                        ).to_dict()
                    )
        return findings
