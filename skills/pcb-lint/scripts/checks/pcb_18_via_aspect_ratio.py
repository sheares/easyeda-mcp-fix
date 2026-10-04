"""PCB-18: Via aspect ratio (board thickness / hole diameter).

Rule: aspect ratio <= 10:1 for reliable plating. Higher ratios risk
voids or incomplete copper coverage inside the barrel.

Board thickness: taken from config.board_thickness_mm (default 1.6 mm
= standard JLCPCB 2-layer). Override per project.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import DEFAULT_BOARD_THICKNESS_MM, MM_TO_MIL


MAX_ASPECT_RATIO = 10.0


@register
class PcbViaAspectRatio(Check):
    id = "PCB-18"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        thickness_mm = float(config.get("board_thickness_mm") or DEFAULT_BOARD_THICKNESS_MM)
        thickness_mil = thickness_mm * MM_TO_MIL

        vias = client.pcb_get_all_primitives(document, type="via") or []
        offending: list[str] = []
        for via in vias:
            hole = via.get("holeDiameter")
            if hole is None or hole <= 0:
                continue
            ratio = thickness_mil / hole
            if ratio > MAX_ASPECT_RATIO:
                offending.append(
                    f"via@{via.get('primitiveId','?')} net={via.get('net','?')} "
                    f"hole={hole}mil, ratio={ratio:.1f}:1"
                )

        if not offending:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="error",
                message=f"{len(offending)} via(s) exceed {MAX_ASPECT_RATIO:.0f}:1 aspect ratio for {thickness_mm:.1f} mm board",
                offending_ids=offending[:10],
                suggestion=f"Increase hole diameter to keep board_thickness / hole <= {MAX_ASPECT_RATIO:.0f}:1. For a {thickness_mm:.1f} mm board, min hole = {thickness_mil/MAX_ASPECT_RATIO:.2f} mil.",
            ).to_dict()
        ]
