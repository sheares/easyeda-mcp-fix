"""SCH-01: ERC clean.

Real MCP shape: {passed: bool, errors: list[dict]}. Warnings key not
present on all builds; degrade gracefully.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


@register
class SchErc(Check):
    id = "SCH-01"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        drc = client.sch_run_drc(document) or {}
        errors = drc.get("errors", []) or []
        warnings = drc.get("warnings", []) or []
        findings: list[dict] = []

        if errors:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="error",
                    message=f"ERC reports {len(errors)} error(s)",
                    offending_ids=[
                        e.get("location") or e.get("net") or e.get("message") or "?"
                        for e in errors
                    ],
                    suggestion="Open the schematic ERC panel in EDA Pro and clear each entry before proceeding to layout.",
                ).to_dict()
            )
        if warnings:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=f"ERC reports {len(warnings)} warning(s)",
                    offending_ids=[
                        w.get("location") or w.get("net") or w.get("message") or "?"
                        for w in warnings
                    ],
                    suggestion="Review each ERC warning; fix or document a waiver.",
                ).to_dict()
            )
        return findings
