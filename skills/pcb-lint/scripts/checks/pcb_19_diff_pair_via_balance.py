"""PCB-19: Differential-pair via count balance.

Rule: both nets of a differential pair should have matching via counts
across the whole board. Unmatched vias introduce length + impedance
skew between the two halves.

Requires config.differential_pairs = [["USB_DP", "USB_DM"], ...].
If empty, emits an info finding (per Failure modes: no silent pass).

Precedent: Splitflap-v2 Board1 had USB_DP=2 vias, USB_DM=4 vias.
Tolerable at USB 2.0 FS (12 Mbps); problematic at HS (480 Mbps).
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register


@register
class PcbDiffPairViaBalance(Check):
    id = "PCB-19"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        pairs = list(config.get("differential_pairs") or [])
        if not pairs:
            return [
                Finding(
                    check_id=self.id,
                    severity="info",
                    message="PCB-19 skipped: no differential_pairs declared in config",
                    offending_ids=[],
                    suggestion='Add {"differential_pairs": [["USB_DP","USB_DM"], ...]} to pcb-lint.config.json.',
                ).to_dict()
            ]

        findings: list[dict] = []
        for pair in pairs:
            if len(pair) != 2:
                continue
            net_a, net_b = pair[0], pair[1]
            vias_a = client.pcb_get_all_primitives(document, type="via", net=net_a) or []
            vias_b = client.pcb_get_all_primitives(document, type="via", net=net_b) or []
            if isinstance(vias_a, dict):
                vias_a = vias_a.get("items", [])
            if isinstance(vias_b, dict):
                vias_b = vias_b.get("items", [])
            count_a, count_b = len(vias_a), len(vias_b)
            if count_a != count_b:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=(
                            f"Diff pair {net_a}/{net_b}: {count_a} vs {count_b} vias "
                            f"(diff {abs(count_a - count_b)}). Introduces skew."
                        ),
                        offending_ids=[f"{net_a}={count_a}", f"{net_b}={count_b}"],
                        suggestion=(
                            "Rebalance layer transitions so both diff-pair legs take the same via count on the same path. "
                            f"Ok at USB 2.0 Full Speed (12 Mbps); problematic at USB HS (480 Mbps) and any DDR/HDMI/PCIe pair."
                        ),
                    ).to_dict()
                )
        return findings
