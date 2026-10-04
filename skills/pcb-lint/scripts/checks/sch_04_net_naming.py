"""SCH-04: Net naming hygiene.

Rewritten Phase 1.6 to enumerate nets from sch_get_connectivity (much
cheaper than sch_get_netlist).

Auto-generated $-prefixed nets (e.g. $R11_1) are hidden from the
`nets` section of the connectivity response by the fork itself. They
represent real unlabelled connections; we do NOT treat them as
placeholder-name violations, since 'give every net a label' is a stricter
policy than the standard SCH-04 catches.
"""

from __future__ import annotations

import re
from typing import Any

from .base import Check, Finding, register


_BAD_NAME = re.compile(r"^(NET\d+|SIG\d+|N\$\d+|UNNAMED\d*|WIRE\d+)$", re.IGNORECASE)


@register
class SchNetNaming(Check):
    id = "SCH-04"
    default_severity = "info"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        conn = client.sch_get_connectivity(document) or {}
        nets = conn.get("nets", {}) or {}

        bad = [name for name in nets.keys() if _BAD_NAME.match(name)]
        if not bad:
            return []
        return [
            Finding(
                check_id=self.id,
                severity="info",
                message=f"{len(bad)} net(s) use auto-generated placeholder names",
                offending_ids=bad,
                suggestion="Rename to functional labels (I2C_SCL, MOTOR_A_STEP, UART_TX). Placeholder names hide accidental shorts.",
            ).to_dict()
        ]
