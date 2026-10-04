"""SCH-05: BOM complete.

Rewritten Phase 1.6 to match real EasyEDA BOM column names:
'Designator', 'Supplier', 'Supplier Part', 'Manufacturer Part', ...

Every non-mechanical BOM line must have Supplier=LCSC and a non-empty
Supplier Part (LCSC C-number). Mechanical parts (testpoints, fiducials,
mounting holes) are excluded.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


MECHANICAL_DESIGNATOR_PREFIXES = ("TP", "MK", "MH", "FID", "LOGO", "H")


def _is_mechanical(row: dict) -> bool:
    designators = (row.get("Designator") or "").split(",")
    if not any(d.strip() for d in designators):
        return False
    return all(
        d.strip().upper().startswith(MECHANICAL_DESIGNATOR_PREFIXES)
        for d in designators if d.strip()
    )


@register
class SchBomComplete(Check):
    id = "SCH-05"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        bom = client.sch_export_bom(document) or []
        missing: list[str] = []
        for row in bom:
            if _is_mechanical(row):
                continue
            supplier = (row.get("Supplier") or "").strip().upper()
            supplier_part = (row.get("Supplier Part") or "").strip()
            manufacturer_part = (row.get("Manufacturer Part") or "").strip()
            # Acceptable when Supplier=LCSC + Supplier Part present, OR
            # when Supplier Part looks like an LCSC C-number regardless.
            has_lcsc = supplier == "LCSC" and bool(supplier_part)
            has_c_number = supplier_part.upper().startswith("C") and supplier_part[1:].isdigit()
            if has_lcsc or has_c_number:
                continue
            missing.append(row.get("Designator") or manufacturer_part or "?")

        if not missing:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="error",
                message=f"{len(missing)} BOM line(s) missing supplier / LCSC code",
                offending_ids=missing,
                suggestion="In EDA Pro: right-click component → Attribute → set Supplier = LCSC and paste the C-number before generating the fab package.",
            ).to_dict()
        ]
