"""PCB-08: Annular ring on plated holes.

Rule (per config.class):
- Class 2 (default, commercial): >= 5 mil annular
- Class 3 (medical/aerospace): >= 6 mil annular

Checks both vias (holeDiameter / diameter) and THT pads (hole[1] / pad[1..]).
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import annular_ring_mil, pad_annular_ring_mil


@register
class PcbAnnularRing(Check):
    id = "PCB-08"
    default_severity = "error"

    def _threshold_mil(self, ipc_class: int) -> float:
        return 6.0 if ipc_class >= 3 else 5.0

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        ipc_class = int(config.get("class") or 2)
        threshold = self._threshold_mil(ipc_class)

        vias = client.pcb_get_all_primitives(document, type="via") or []
        pads = client.pcb_get_all_primitives(document, type="pad") or []

        offending: list[str] = []
        for via in vias:
            hole = via.get("holeDiameter")
            outer = via.get("diameter")
            if hole is None or outer is None:
                continue
            ar = annular_ring_mil(outer, hole)
            if ar < threshold:
                offending.append(
                    f"via@{via.get('primitiveId','?')} net={via.get('net','?')} "
                    f"ar={ar:.2f}mil (drill {hole}mil, pad {outer}mil)"
                )

        for pad in pads:
            if not pad.get("metallization", True):
                continue  # non-plated (mechanical) hole, skip
            ar = pad_annular_ring_mil(pad)
            if ar is None:
                continue  # SMD pad, no drill
            if ar < threshold:
                offending.append(
                    f"pad@{pad.get('primitiveId','?')} net={pad.get('net','?')} "
                    f"ar={ar:.2f}mil"
                )

        if not offending:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="error",
                message=f"{len(offending)} plated hole(s) below Class {ipc_class} annular-ring minimum ({threshold:.0f} mil)",
                offending_ids=offending[:15],
                suggestion=f"Widen the pad or reduce the drill so each annular ring >= {threshold:.0f} mil. Class 2 = 5 mil; Class 3 = 6 mil.",
            ).to_dict()
        ]
