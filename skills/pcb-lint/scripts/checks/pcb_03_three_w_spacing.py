"""PCB-03: 3W spacing on high-speed nets.

Detects parallel-run adjacency: any track on a high-speed net that runs
next to another net's track on the same layer for a meaningful overlap
length with less than 3 x trace_width separation.

Scope in MVP (Phase 3):
- Axis-aligned segments only (H or V). Diagonal / 45 degrees skipped.
- Same-layer pairs only. Cross-layer stacked runs deferred to Phase 3.1
  (needs stackup / dielectric awareness).
- Requires config.high_speed_nets (list of net names). If empty, emits
  an info finding rather than silently passing (per Failure modes).
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import axis_aligned_parallel_overlap


MIN_OVERLAP_MULT = 5.0  # overlap must be >= this * trace_width to matter


@register
class PcbThreeWSpacing(Check):
    id = "PCB-03"
    default_severity = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        high_speed_nets = list(config.get("high_speed_nets") or [])
        if not high_speed_nets:
            return [
                Finding(
                    check_id=self.id,
                    severity="info",
                    message="PCB-03 skipped: no high_speed_nets declared in config",
                    offending_ids=[],
                    suggestion='Add {"high_speed_nets": ["USB_DP", ...]} to pcb-lint.config.json.',
                ).to_dict()
            ]

        # Get all tracks by high-speed net, and (once) all tracks by layer for neighbours
        tracks_hs: list[dict] = []
        for net in high_speed_nets:
            got = client.pcb_get_all_primitives(document, type="track", net=net) or []
            if isinstance(got, dict):
                got = got.get("items", [])
            tracks_hs.extend(got)

        if not tracks_hs:
            return []

        all_tracks = client.pcb_get_all_primitives(document, type="track") or []
        if isinstance(all_tracks, dict):
            all_tracks = all_tracks.get("items", [])
        hs_ids = {t.get("primitiveId") for t in tracks_hs}

        findings: list[dict] = []
        for hs in tracks_hs:
            hs_width = float(hs.get("lineWidth") or 0)
            if hs_width <= 0:
                continue
            min_perp_ok = 3.0 * hs_width  # 3W rule
            min_overlap = MIN_OVERLAP_MULT * hs_width
            hs_net = hs.get("net") or ""
            hs_layer = hs.get("layer")

            for other in all_tracks:
                if other.get("primitiveId") == hs.get("primitiveId"):
                    continue
                if other.get("net") == hs_net:
                    continue  # same-net segments don't count
                if other.get("layer") != hs_layer:
                    continue  # different layers handled elsewhere
                result = axis_aligned_parallel_overlap(hs, other)
                if result is None:
                    continue
                perp_mil, overlap_mil = result
                if perp_mil >= min_perp_ok:
                    continue
                if overlap_mil < min_overlap:
                    continue
                findings.append({
                    "hs_net": hs_net,
                    "hs_id": hs.get("primitiveId"),
                    "other_net": other.get("net"),
                    "other_id": other.get("primitiveId"),
                    "layer": hs_layer,
                    "perp_mil": round(perp_mil, 2),
                    "overlap_mil": round(overlap_mil, 2),
                    "trace_width_mil": hs_width,
                })

        if not findings:
            return []

        # Group by (hs_net, other_net) to avoid noise
        by_pair: dict[tuple[str, str], list[dict]] = {}
        for f in findings:
            key = (f["hs_net"], f["other_net"])
            by_pair.setdefault(key, []).append(f)

        emitted: list[dict] = []
        for (hs_net, other_net), rows in sorted(by_pair.items()):
            total_overlap = sum(r["overlap_mil"] for r in rows)
            worst = min(rows, key=lambda r: r["perp_mil"])
            emitted.append(
                Finding(
                    check_id=self.id,
                    severity="warn",
                    message=(
                        f"{hs_net} runs parallel to {other_net} on layer {worst['layer']}: "
                        f"{len(rows)} segment-pair(s), min gap {worst['perp_mil']} mil, "
                        f"total overlap {total_overlap:.0f} mil "
                        f"(3W = {3*worst['trace_width_mil']:.1f} mil for {worst['trace_width_mil']}-mil traces)"
                    ),
                    offending_ids=[f"{r['hs_id']}<->{r['other_id']}" for r in rows[:5]],
                    suggestion=(
                        "Reroute either net to break the parallel run, or increase spacing to >= 3 x trace_width. "
                        "If 90 degrees crossing (perpendicular) or short adjacency is unavoidable, that is fine; the risk scales with overlap length."
                    ),
                ).to_dict()
            )
        return emitted
