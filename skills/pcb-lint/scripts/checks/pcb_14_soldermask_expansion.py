"""PCB-14: Soldermask expansion around pads.

Rule of thumb: 2-4 mil expansion (~0.05-0.1 mm) around each pad.
Too tight (< 1 mil) risks mask-on-pad (cold joints). Too loose (> 6 mil)
risks solder bridging on fine-pitch parts.

Reads pad.solderMaskAndPasteMaskExpansion.topSolderMask (mm) and
bottomSolderMask (mm). Values are per-pad; the design-rule default may
be overridden by individual pads.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import MM_TO_MIL


MIN_EXPANSION_MIL = 1.0  # tight; below this = mask-on-pad risk
MAX_EXPANSION_MIL = 6.0  # loose; above this = bridging risk on fine-pitch


def _side_expansion_mil(pad: dict, side_key: str) -> float | None:
    exp = pad.get("solderMaskAndPasteMaskExpansion") or {}
    v = exp.get(side_key)
    if v is None:
        return None
    return v * MM_TO_MIL


@register
class PcbSoldermaskExpansion(Check):
    id = "PCB-14"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        pads = client.pcb_get_all_primitives(document, type="pad") or []

        too_tight: list[str] = []
        too_loose: list[str] = []
        for pad in pads:
            for side in ("topSolderMask", "bottomSolderMask"):
                exp_mil = _side_expansion_mil(pad, side)
                if exp_mil is None:
                    continue
                if exp_mil < 0:
                    continue  # negative = mask covers pad (via-tenting), skip
                if exp_mil < MIN_EXPANSION_MIL:
                    too_tight.append(
                        f"pad@{pad.get('primitiveId','?')} {side}={exp_mil:.2f}mil"
                    )
                elif exp_mil > MAX_EXPANSION_MIL:
                    too_loose.append(
                        f"pad@{pad.get('primitiveId','?')} {side}={exp_mil:.2f}mil"
                    )

        findings: list[dict] = []
        if too_tight:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="warn",
                    message=f"{len(too_tight)} pad(s) have soldermask expansion below {MIN_EXPANSION_MIL:.0f} mil (risk of mask-on-pad / cold joints)",
                    offending_ids=too_tight[:10],
                    suggestion="Increase expansion to 2-4 mil in the pad's local override or the project design rules.",
                ).to_dict()
            )
        if too_loose:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=f"{len(too_loose)} pad(s) have soldermask expansion above {MAX_EXPANSION_MIL:.0f} mil (may bridge on fine-pitch)",
                    offending_ids=too_loose[:10],
                    suggestion="Fine for standard-pitch parts; on any part with pitch < 0.5 mm, tighten to 2-3 mil to prevent solder bridging.",
                ).to_dict()
            )
        return findings
