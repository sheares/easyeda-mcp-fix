"""PCB-10: Testpoint coverage.

Heuristic in Phase 2: look for components whose designator starts with TP*.
If none present, emit info (not warning) since most compact prototype
boards skip formal testpoints. The designer decides if the board's usage
(bring-up, production test) warrants them.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


TESTPOINT_PREFIXES = ("TP",)


@register
class PcbTestpoints(Check):
    id = "PCB-10"
    default_severity = "info"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        components = client.pcb_get_all_primitives(document, type="component") or []
        tps = [
            c for c in components
            if (c.get("designator") or "").upper().startswith(TESTPOINT_PREFIXES)
        ]

        if tps:
            return [
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=f"{len(tps)} testpoint(s) placed; verify each meets probe minimums (35 mil diameter, 50 mil centre-to-centre) if this board is for in-circuit test",
                    offending_ids=[c.get("designator") or "?" for c in tps[:20]],
                    suggestion="Testpoint geometry not automatable in Phase 2. Manual verify or add PCB-10.1 in a future phase.",
                ).to_dict()
            ]
        return [
            Finding(
                check_id=self.id,
                severity="info",
                message="No testpoints (TP*) placed on the board",
                offending_ids=[],
                suggestion="For bring-up + production test: add testpoints on power rails, key clocks, reset, boot pins, UART. Prototypes commonly skip; decide per usage.",
            ).to_dict()
        ]
