"""PCB-14: Soldermask expansion around pads.

Rule of thumb: 2-4 mil expansion (~0.05-0.1 mm) around each pad.
Too tight (< 1 mil) risks mask-on-pad (cold joints). Too loose (> 6 mil)
risks solder bridging on fine-pitch parts.

Reads pad.solderMaskAndPasteMaskExpansion.topSolderMask and
bottomSolderMask. The MCP returns these in units of 1/100 inch (1 unit =
10 mil = 0.254 mm), so they are converted x10 to mil (see types.py).
Raw values above 1.5 are unit-ambiguous (one real footprint returned 2
meaning 2 mil, not 20 mil); those pads are reported in a single info
finding with both readings instead of a bridging-risk claim.
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import mask_raw_is_ambiguous, mask_raw_to_mil


MIN_EXPANSION_MIL = 1.0  # tight; below this = mask-on-pad risk
MAX_EXPANSION_MIL = 6.0  # loose; above this = bridging risk on fine-pitch


def _side_raw(pad: dict, side_key: str) -> float | None:
    exp = pad.get("solderMaskAndPasteMaskExpansion") or {}
    v = exp.get(side_key)
    if v is None:
        return None
    return float(v)


@register
class PcbSoldermaskExpansion(Check):
    id = "PCB-14"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        pads = client.pcb_get_all_primitives(document, type="pad") or []

        too_tight: list[str] = []
        too_loose: list[str] = []
        ambiguous: list[str] = []
        for pad in pads:
            for side in ("topSolderMask", "bottomSolderMask"):
                raw = _side_raw(pad, side)
                if raw is None:
                    continue
                exp_mil = mask_raw_to_mil(raw)
                if exp_mil < 0:
                    continue  # negative = mask covers pad (via-tenting), skip
                if mask_raw_is_ambiguous(raw):
                    ambiguous.append(
                        f"pad@{pad.get('primitiveId','?')} {side}: raw={raw:g} "
                        f"= {exp_mil:.1f} mil (x10) or {raw:g} mil (plain mil)"
                    )
                    continue
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
        if ambiguous:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=(
                        f"{len(ambiguous)} pad side(s) returned a raw solder-mask expansion above "
                        "1.5 (unit-ambiguous): the MCP normally reports 1/100 inch (x10 = mil), "
                        "but some footprints appear to report plain mil, so the bridging-risk "
                        "test was not applied to them"
                    ),
                    offending_ids=ambiguous[:10],
                    suggestion="Confirm the solder mask expansion in EasyEDA's pad properties for these pads.",
                ).to_dict()
            )
        return findings
