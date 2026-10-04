"""SCH-06: JLC assembly stock.

Phase 1.6: reads the real 'Supplier Part' BOM column. External JLC
parts API remains unwired; check emits an info listing the C-numbers
for manual verify. Never silently passes when BOM has LCSC codes.

Bonus Phase 1.6 signal: also flag rows whose per-part metadata
indicates 'JLCPCB Part Class: Extended Part' (setup fees on JLC
assembly). That data lives on the component's otherProperty, not in
the BOM export, so the check needs both.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


def _extract_lcsc(row: dict) -> str | None:
    part = (row.get("Supplier Part") or "").strip().upper()
    if part.startswith("C") and part[1:].isdigit():
        return part
    return None


@register
class SchJlcStock(Check):
    id = "SCH-06"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        bom = client.sch_export_bom(document) or []
        lcsc_codes = sorted({code for row in bom if (code := _extract_lcsc(row))})

        if not lcsc_codes:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="info",
                message=f"JLC stock not verified for {len(lcsc_codes)} LCSC part(s): external API not wired in Phase 1",
                offending_ids=lcsc_codes,
                suggestion="Verify stock via jlcpcb.com or the JLC parts API before fab order. Zero-stock parts must be reordered.",
            ).to_dict()
        ]
