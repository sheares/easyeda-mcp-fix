"""PCB-11: Fiducial coverage for pick-and-place assembly.

Heuristic: look for components with designator FID*. If none, emit info
(not warn) since JLCPCB PCBA works without fiducials on simple boards;
the assembler and board size decide whether they're worth adding.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


@register
class PcbFiducials(Check):
    id = "PCB-11"
    default_severity = "info"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        components = client.pcb_get_all_primitives(document, type="component") or []
        fids = [
            c for c in components
            if (c.get("designator") or "").upper().startswith("FID")
        ]

        if fids:
            return [
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=f"{len(fids)} fiducial(s) placed",
                    offending_ids=[c.get("designator") or "?" for c in fids],
                    suggestion="Verify: 3 per assembled side, asymmetric placement (so the pick-and-place can determine orientation).",
                ).to_dict()
            ]
        return [
            Finding(
                check_id=self.id,
                severity="info",
                message="No fiducials (FID*) placed",
                offending_ids=[],
                suggestion="For JLCPCB PCBA on small prototype boards: usually fine without. For higher volume, fine-pitch parts (< 0.5 mm), or in-house SMT line: add 3 fiducials per assembled side, asymmetric layout, 1 mm dot with 2 mm mask clearance.",
            ).to_dict()
        ]
