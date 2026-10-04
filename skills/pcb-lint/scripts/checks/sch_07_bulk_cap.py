"""SCH-07: Bulk cap per regulator output rail.

Rewritten Phase 1.6 to handle switching regulators (which have no VOUT
pin — output is post-inductor from the SW node).

Output-net detection order for each regulator:
1. Pin whose name matches VOUT/OUT/etc → that pin's net is the output.
2. Pin named SW (switching output) → trace SW net; if it connects to an
   inductor, the inductor's other side is the output.
3. Give up; emit info that manual output identification is needed.

Then check whether any capacitor on the output net has value ≥ 10 µF.
"""

from __future__ import annotations

import re
from typing import Any

from .base import Check, Finding, register
from .types import (
    designators_on_net,
    find_regulator_output_net,
    infer_functional_type,
    parse_value_field,
)


_VALUE_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*(u|µ|m|n|p|f)f?\s*$", re.IGNORECASE)
_UNIT_TO_UF = {"f": 1e6, "m": 1e3, "u": 1.0, "µ": 1.0, "n": 1e-3, "p": 1e-6}


def _parse_uf(value: str) -> float | None:
    """Parse a capacitor value string to µF; requires explicit unit char."""
    if not value:
        return None
    m = _VALUE_RE.match(value)
    if not m:
        return None
    return float(m.group(1)) * _UNIT_TO_UF[(m.group(2) or "").lower()]


@register
class SchBulkCap(Check):
    id = "SCH-07"
    default_severity = "warn"
    threshold_uf = 10.0

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])
        regulators = [c for c in parts if infer_functional_type(c) == "regulator"]
        if not regulators:
            return []

        # Fetch connectivity once for all regulators + inductors (needed to trace SW).
        inductor_designators = [
            (c.get("designator") or "") for c in parts
            if infer_functional_type(c) == "inductor"
        ]
        reg_designators = [(c.get("designator") or "") for c in regulators]
        query = [d for d in (reg_designators + inductor_designators) if d]
        conn = client.sch_get_connectivity(document, designators=query, depth=2) or {}
        conn_nets = conn.get("nets", {}) or {}
        conn_comps = conn.get("components", {}) or {}

        # Map capacitor designator → parsed µF value
        cap_uf: dict[str, float] = {}
        for c in parts:
            if infer_functional_type(c) != "capacitor":
                continue
            designator = (c.get("designator") or "").upper()
            uf = _parse_uf(parse_value_field(c))
            if uf is not None:
                cap_uf[designator] = uf

        findings: list[dict] = []
        for reg in regulators:
            desig = reg.get("designator") or "?"
            out_net, how = find_regulator_output_net(desig, conn_comps, conn_nets)
            if not out_net:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="info",
                        message=f"{desig}: cannot auto-detect output net ({how})",
                        offending_ids=[desig],
                        suggestion="Verify manually. If topology is unusual (e.g. LDO with sense pin, boost with dedicated OUT), extend infer_functional_type / find_regulator_output_net.",
                    ).to_dict()
                )
                continue

            bulk_caps = [
                sibling.upper() for sibling in designators_on_net(out_net, conn_nets)
                if sibling.upper() in cap_uf and cap_uf[sibling.upper()] >= self.threshold_uf
            ]
            if not bulk_caps:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=f"{desig} output rail {out_net}: no cap >= {self.threshold_uf} µF found ({how})",
                        offending_ids=[f"{desig}:{out_net}"],
                        suggestion="Add a bulk electrolytic or 10 µF ceramic near the regulator output; layout stage checks placement.",
                    ).to_dict()
                )

        return findings
