"""PCB-02: Decoupling cap physical proximity to IC power pin.

SCH-02 verifies a cap exists on the same net in the schematic.
PCB-02 verifies that cap is physically close to the IC — because a
100 nF cap 15 mm away is not a high-frequency decoupling cap, it's
just a bulk cap sitting near nothing useful.

Rule: for each IC power pin, the nearest cap on the same net should
be <= 2 mm (78 mil) away. Above 5 mm (196 mil): warn hard.

Simplified metric: uses component-centre-to-component-centre distance
(rather than pin-to-pin), which is conservative — the actual pin
distance will usually be shorter. Good enough for catching "cap on
opposite side of board" cases which is what this rule really targets.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import (
    MM_TO_MIL,
    distance_mil,
    infer_functional_type,
    is_power_pin_by_name,
)


PROXIMITY_WARN_MM = 2.0
PROXIMITY_HARD_WARN_MM = 5.0


@register
class PcbDecouplingProximity(Check):
    id = "PCB-02"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""

        # Schematic side: which nets are power pins on which ICs?
        sch_parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])
        ics = [c for c in sch_parts if infer_functional_type(c) in {"ic", "regulator"}]
        if not ics:
            return []
        ic_designators = [c.get("designator") for c in ics if c.get("designator")]
        conn = client.sch_get_connectivity(document, designators=ic_designators, depth=1) or {}
        conn_comps = conn.get("components", {}) or {}

        # Which sch caps are on which nets (for cross-net matching)
        cap_designators = {
            (c.get("designator") or "").upper()
            for c in sch_parts
            if infer_functional_type(c) == "capacitor"
        }

        # PCB side: physical positions of every component
        pcb_components = client.pcb_get_all_primitives(document, type="component") or []
        # Handle both raw-list and {items: [...]} shapes
        if isinstance(pcb_components, dict):
            pcb_components = pcb_components.get("items", [])
        pos_by_designator: dict[str, tuple[float, float]] = {
            (c.get("designator") or "").upper(): (c.get("x", 0.0), c.get("y", 0.0))
            for c in pcb_components
        }

        threshold_mil = PROXIMITY_WARN_MM * MM_TO_MIL
        hard_mil = PROXIMITY_HARD_WARN_MM * MM_TO_MIL
        findings: list[dict] = []

        for ic in ics:
            desig = (ic.get("designator") or "").upper()
            ic_pos = pos_by_designator.get(desig)
            if ic_pos is None:
                continue  # not placed yet
            comp_entry = conn_comps.get(desig, {})
            pins = comp_entry.get("pins", {}) or {}

            for pin_number, pin in pins.items():
                if not is_power_pin_by_name(pin.get("name") or ""):
                    continue
                net = pin.get("net") or ""
                if not net or net == "GND":
                    continue
                # Find all caps on this net (from schematic connectivity)
                # First get connectivity for this net specifically
                net_conn = client.sch_get_connectivity(document, nets=[net]) or {}
                caps_on_net = []
                for entry in (net_conn.get("nets", {}) or {}).get(net, []):
                    dot = entry.find(".")
                    if dot > 0:
                        d = entry[:dot].upper()
                        if d in cap_designators:
                            caps_on_net.append(d)

                if not caps_on_net:
                    continue  # SCH-02 already flagged
                nearest_dist_mil = None
                nearest_cap = None
                for cap_desig in caps_on_net:
                    cap_pos = pos_by_designator.get(cap_desig)
                    if cap_pos is None:
                        continue
                    d_mil = distance_mil(ic_pos[0], ic_pos[1], cap_pos[0], cap_pos[1])
                    if nearest_dist_mil is None or d_mil < nearest_dist_mil:
                        nearest_dist_mil = d_mil
                        nearest_cap = cap_desig
                if nearest_dist_mil is None:
                    continue

                dist_mm = nearest_dist_mil / MM_TO_MIL
                if nearest_dist_mil > hard_mil:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="warn",
                            message=f"{desig}.{pin_number}({net}): nearest cap {nearest_cap} is {dist_mm:.1f} mm away (target <= {PROXIMITY_WARN_MM:.0f} mm)",
                            offending_ids=[f"{desig}.{pin_number}→{nearest_cap}"],
                            suggestion="Move the decoupling cap physically adjacent to the IC power pin. Every mm of trace adds inductance that defeats HF decoupling.",
                        ).to_dict()
                    )
                elif nearest_dist_mil > threshold_mil:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="info",
                            message=f"{desig}.{pin_number}({net}): nearest cap {nearest_cap} at {dist_mm:.1f} mm (target <= {PROXIMITY_WARN_MM:.0f} mm)",
                            offending_ids=[f"{desig}.{pin_number}→{nearest_cap}"],
                            suggestion="Tighten placement if convenient. 2-5 mm range is acceptable for slower ICs; tighten for fast digital / RF.",
                        ).to_dict()
                    )
        return findings
