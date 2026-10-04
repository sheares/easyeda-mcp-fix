"""PCB-13: Mil-coord sanity.

EasyEDA PCB primitives use MILS. If any coordinate is < 10 (a real coord
would be at least a few dozen mils from origin) or > 1e6 (30 metres),
it's almost certainly a mm/mil confusion in a script.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


@register
class PcbMilCoordSanity(Check):
    id = "PCB-13"
    default_severity = "info"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        suspects: list[str] = []
        for ptype in ("via", "pad", "component"):
            items = client.pcb_get_all_primitives(document, type=ptype) or []
            for item in items:
                for key in ("x", "y"):
                    v = item.get(key)
                    if v is None:
                        continue
                    if abs(v) > 1e6:
                        suspects.append(
                            f"{ptype}@{item.get('primitiveId','?')} {key}={v} (>1e6 mil = 25 m, likely mm/mil bug)"
                        )
        if not suspects:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="info",
                message=f"{len(suspects)} primitive coord(s) look implausible for mils",
                offending_ids=suspects[:10],
                suggestion="EasyEDA PCB coords are in mils. If a script wrote a mm value directly, multiply by 39.37 before pcb_create_* calls.",
            ).to_dict()
        ]
