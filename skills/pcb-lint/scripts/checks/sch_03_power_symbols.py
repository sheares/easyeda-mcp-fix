"""SCH-03: Every power rail has a proper power port (not a bare label).

Rewritten Phase 1.6. The real MCP netflag primitive doesn't expose
its named-net directly via sch_get_all_components with a
componentType filter — it just returns primitiveId + componentType.
Fetching every netflag's `net` field individually is expensive and
brittle.

Pragmatic Phase 1.6 rule: for each net whose name matches a power
pattern (looks_like_power_rail), verify it has at least two pins
connected. A rail with one pin means it's floating (unused symbol
or a design bug). This isn't strictly a "power symbol present" check,
but it catches the class of errors SCH-03 was written for (dangling
power labels, unwired rails).

A stricter power-symbol check waits until we have a netflag→net
enrichment path.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import looks_like_power_rail


@register
class SchPowerSymbols(Check):
    id = "SCH-03"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        conn = client.sch_get_connectivity(document) or {}
        nets = conn.get("nets", {}) or {}

        dangling: list[str] = []
        for name, pin_entries in nets.items():
            if not looks_like_power_rail(name):
                continue
            if len(pin_entries) < 2:
                dangling.append(name)

        findings: list[dict] = []
        if dangling:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="warn",
                    message=f"{len(dangling)} power rail(s) have < 2 pin connections (possibly floating or unwired)",
                    offending_ids=dangling,
                    suggestion="Confirm each rail is intentionally wired. A power symbol without loads is either an unfinished design or a stray label to delete.",
                ).to_dict()
            )
        return findings
