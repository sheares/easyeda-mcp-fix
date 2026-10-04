"""PCB-01: DRC clean.

Real MCP shape: pcb_run_drc(verbose=true) returns a list of violation
dicts, or [] if clean. Unlike sch_run_drc there is no {passed, errors}
wrapper.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


@register
class PcbDrc(Check):
    id = "PCB-01"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        violations = client.pcb_run_drc(document, verbose=True) or []
        if not violations:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="error",
                message=f"PCB DRC reports {len(violations)} violation(s)",
                offending_ids=[
                    v.get("id") or v.get("location") or v.get("message") or "?"
                    for v in violations[:20]
                ],
                suggestion="Open the DRC panel in EDA Pro and clear each entry before generating the fab package.",
            ).to_dict()
        ]
