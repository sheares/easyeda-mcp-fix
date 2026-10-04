"""SCH-02: Every IC has local decoupling.

Rewritten Phase 1.6 to use sch_get_connectivity (one MCP call replaces
per-IC pin fetches). For each IC, look at its pin→net map, filter to
power pins by name, and check whether the same net also connects a
capacitor.

Functional type inference: designator prefix + jumper filter (real MCP
has no functional `type` field). Jumpers-that-look-like-ICs (U3-BOOT,
U6-EN, U8-TXRX in Splitflap-v2) are excluded.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import infer_functional_type, is_power_pin_by_name


def _designators_on_net(net_name: str, connectivity_nets: dict[str, list[str]]) -> list[str]:
    """Return designators (e.g. 'C7') from connectivity entries like 'C7.2(2)'."""
    designators: list[str] = []
    for entry in connectivity_nets.get(net_name, []):
        dot = entry.find(".")
        if dot > 0:
            designators.append(entry[:dot])
    return designators


@register
class SchDecoupling(Check):
    id = "SCH-02"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])
        ics = [c for c in parts if infer_functional_type(c) in {"ic", "regulator"}]
        if not ics:
            return []

        designators = [c.get("designator") for c in ics if c.get("designator")]
        conn = client.sch_get_connectivity(document, designators=designators, depth=1) or {}
        conn_nets = conn.get("nets", {}) or {}
        conn_comps = conn.get("components", {}) or {}

        # Cache: which designators are capacitors?
        cap_designators = {
            (c.get("designator") or "").upper()
            for c in parts
            if infer_functional_type(c) == "capacitor"
        }

        findings: list[dict] = []
        for ic in ics:
            desig = ic.get("designator") or ""
            comp_entry = conn_comps.get(desig, {})
            pins = comp_entry.get("pins", {}) or {}
            uncovered: list[str] = []

            for pin_number, pin in pins.items():
                pin_name = pin.get("name") or ""
                net = pin.get("net") or ""
                if not net or net == "GND":
                    continue
                if not is_power_pin_by_name(pin_name):
                    continue
                # Is any cap on this net?
                sibling_designators = {d.upper() for d in _designators_on_net(net, conn_nets) if d.upper() != desig.upper()}
                if not (sibling_designators & cap_designators):
                    uncovered.append(f"{desig}.{pin_number}({pin_name}→{net})")

            if uncovered:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=f"{desig} has power pin(s) with no capacitor on the net",
                        offending_ids=uncovered,
                        suggestion=(
                            "Before treating this as a fix: read the datasheet's Power Supply Recommendations. "
                            "Some ICs (e.g. TPL7407LA COM pin, some ESD-protection VBUS pins) explicitly label the "
                            "bypass cap as 'recommended for sensitive supplies, not required for proper operation'. "
                            "If required: add 100 nF X7R ceramic on this net; layout stage checks placement proximity. "
                            "If only recommended: waive with system-context rationale in decisions.md and consider for v2."
                        ),
                    ).to_dict()
                )
        return findings
