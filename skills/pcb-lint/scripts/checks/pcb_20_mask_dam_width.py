"""PCB-20: Solder-mask dam width on fine-pitch parts.

The mask dam is the sliver of solder mask between two adjacent pads. On
fine-pitch parts (QFN, TSSOP, 0.5 mm pitch and below), mask expansion
around each pad eats into that gap. Below ~0.10 mm remaining dam width,
JLCPCB (and most low-cost fabs) silently delete the dam, leaving bare
copper between the pads. The fab does NOT warn; the first sign of trouble
is solder bridges during reflow.

Rule:
    For each pair of adjacent pads on the same copper layer, compute:
        gap     = centre-to-centre distance minus half each pad's relevant dim
        dam     = gap - (mask_exp_1 + mask_exp_2)
    If dam < pcb_mask_dam_min_mm → ERROR.

Only pairs whose axis-aligned gap is < 0.3 mm (≈ 11.8 mil) are inspected;
wider gaps are nowhere near the danger zone and skipping them keeps the
O(N²) pad-pair scan fast.

Internal copper layers (IDs 15+) are included in the check alongside TOP,
BOTTOM, and MULTI — same set as PCB-21's _copper_layers().

Axis-aligned approximation: pairs must be within ~5° of sharing an X or Y
coordinate (dominant axis). Rotated pairs are skipped (post-MVP).

Config:
    pcb_mask_dam_min_mm (float, default 0.10): minimum dam width in mm.
        JLCPCB green mask (1 oz) minimum. Some fabs need 0.15 mm for
        coloured masks.

Sources:
    JLCPCB PCB Manufacturing Capabilities — "Solder Mask" section
    (jlcpcb.com/capabilities/pcb-capabilities, retrieved 2026-08-09):
    minimum solder-mask bridge (dam) between pads is 0.1 mm for standard
    green mask on 1-oz copper.

Known limitations (post-MVP):
  - Non-axis-aligned pad pairs (rotated components) are skipped. The
    axis-alignment filter (~5° tolerance) may miss oblique fine-pitch rows.
  - Round/oval pads are treated as rectangles (their bbox), which is
    slightly conservative for round pads and slightly loose for oval pads
    at an angle.
  - Cross-layer pairs (MULTI × TOP/BOTTOM) are not checked; THT pads on
    MULTI are paired only with other MULTI pads.
"""

from __future__ import annotations

import math
from typing import Any

from .base import Check, Finding, register
from .types import Layer, MIL_TO_MM, MM_TO_MIL

# Default threshold (JLCPCB green 1 oz, 2026-08-09).
_DEFAULT_MIN_DAM_MM = 0.10

# Edge-to-edge gap threshold: only inspect pairs closer than this (mm).
# Pairs with a gap >= 0.3 mm are nowhere near the danger zone.
_GAP_THRESHOLD_MM = 0.3

# Axis-alignment tolerance: sin(5°) ≈ 0.087.
# If the smaller perpendicular component / magnitude > this, the pair is
# considered rotated and is skipped.
_AXIS_SIN_TOLERANCE = math.sin(math.radians(5))

# Copper layer IDs that receive a mask dam check.
# Internal signal layers use IDs 15+ (same convention as PCB-21 _copper_layers()).
_COPPER_LAYER_IDS: frozenset[int] = frozenset(
    {Layer.TOP, Layer.BOTTOM, Layer.MULTI_LAYER} | set(range(15, 100))
)


def _pad_dims(pad: dict) -> tuple[float, float]:
    """Return (width_mil, height_mil) for a pad (rectangle bbox).

    For ELLIPSE / round pads the bbox equals diameter × diameter.
    If geometry is missing, returns (0, 0).
    """
    pad_geom = pad.get("pad") or []
    dims = [v for v in pad_geom[1:] if isinstance(v, (int, float))]
    if len(dims) >= 2:
        return float(dims[0]), float(dims[1])
    if len(dims) == 1:
        # Circular pad: single-value diameter
        return float(dims[0]), float(dims[0])
    return 0.0, 0.0


def _mask_expansion_mm(pad: dict, layer: int) -> float:
    """Return mask expansion in mm for the relevant side of a pad.

    MULTI-layer (THT) pads use the top-side expansion as the canonical value;
    THT pads have the same dam concern on both sides.
    """
    exp = pad.get("solderMaskAndPasteMaskExpansion") or {}
    if layer == Layer.BOTTOM:
        v = exp.get("bottomSolderMask")
        if v is None:
            v = exp.get("topSolderMask", 0.0)
    else:
        # TOP or MULTI
        v = exp.get("topSolderMask", 0.0)
    return float(v) if v is not None else 0.0


def _axis_aligned_gap_mm(
    x1: float, y1: float, w1: float, h1: float,
    x2: float, y2: float, w2: float, h2: float,
) -> tuple[float | None, str]:
    """Compute axis-aligned edge-to-edge gap (mm) for two rectangular pads.

    Coordinates and dimensions are in mils; the returned gap is converted to mm.

    Returns (gap_mm, dominant_axis) or (None, "skip") if the pair is not
    axis-aligned within the 5° tolerance.

    The dominant axis is the one with the larger centre-to-centre delta.
    Along that axis, gap = |Δcentre| - (half-dim1 + half-dim2).
    """
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    dist = math.hypot(dx, dy)

    if dist < 1e-6:
        # Same-centre pads (e.g. overlapping): gap is 0 or negative
        return 0.0, "X"

    # Check axis alignment: the pair is "axis-aligned" if one delta
    # dominates (< 5° off-axis).
    sin_angle = min(dx, dy) / dist  # sin of angle from dominant axis
    if sin_angle > _AXIS_SIN_TOLERANCE:
        return None, "skip"

    if dx >= dy:
        # Dominant axis = X; use widths
        gap_mil = dx - (w1 + w2) / 2.0
        axis = "X"
    else:
        # Dominant axis = Y; use heights
        gap_mil = dy - (h1 + h2) / 2.0
        axis = "Y"

    return gap_mil * MIL_TO_MM, axis


@register
class PcbMaskDamWidth(Check):
    id = "PCB-20"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        min_dam_mm = float(
            config.get("pcb_mask_dam_min_mm", _DEFAULT_MIN_DAM_MM)
        )

        # Gather pads from all relevant layers.
        pads_raw = client.pcb_get_all_primitives(document, type="pad") or []

        # Bucket by layer. TOP, BOTTOM, MULTI, and internal signal layers (15+)
        # each get their own pair set so cross-layer pairs are never compared.
        layer_groups: dict[int, list[dict]] = {}
        for pad in pads_raw:
            layer = pad.get("layer")
            if layer is not None and layer in _COPPER_LAYER_IDS:
                layer_groups.setdefault(layer, []).append(pad)

        violations: list[str] = []
        # Pre-compute threshold in mils once (used in per-pair proximity ceiling).
        _gap_threshold_mil = _GAP_THRESHOLD_MM * MM_TO_MIL

        for layer, group in layer_groups.items():
            n = len(group)
            for i in range(n):
                p1 = group[i]
                x1 = float(p1.get("x", 0.0))
                y1 = float(p1.get("y", 0.0))
                w1, h1 = _pad_dims(p1)
                exp1 = _mask_expansion_mm(p1, layer)

                for j in range(i + 1, n):
                    p2 = group[j]
                    x2 = float(p2.get("x", 0.0))
                    y2 = float(p2.get("y", 0.0))
                    w2, h2 = _pad_dims(p2)

                    # Dynamic proximity pre-filter: skip if the centre-to-centre
                    # distance already exceeds the maximum possible gap that could
                    # produce a sub-threshold dam for pads of this size.
                    # ceiling = (w1+w2)/2 + gap_threshold_mil
                    proximity_ceil = (w1 + w2) / 2.0 + _gap_threshold_mil
                    if math.hypot(x2 - x1, y2 - y1) > proximity_ceil:
                        continue
                    exp2 = _mask_expansion_mm(p2, layer)

                    gap_mm, axis = _axis_aligned_gap_mm(x1, y1, w1, h1, x2, y2, w2, h2)
                    if gap_mm is None:
                        # Non-axis-aligned pair — skip (post-MVP).
                        continue

                    # Skip pairs whose edge-to-edge gap is already >= 0.3 mm.
                    if gap_mm >= _GAP_THRESHOLD_MM:
                        continue

                    dam_mm = gap_mm - (exp1 + exp2)
                    if dam_mm < min_dam_mm:
                        id1 = p1.get("primitiveId") or "?"
                        id2 = p2.get("primitiveId") or "?"
                        violations.append(
                            f"pads {id1}/{id2}: dam={dam_mm:.3f} mm "
                            f"(gap={gap_mm:.3f} mm, exp={exp1:.3f}+{exp2:.3f} mm)"
                        )

        findings: list[dict] = []
        if violations:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="error",
                    message=(
                        f"PCB-20: {len(violations)} pad pair(s) have mask dam "
                        f"< {min_dam_mm:.2f} mm — fab will silently delete the dam, "
                        "causing solder bridges on fine-pitch parts."
                    ),
                    offending_ids=violations[:20],
                    suggestion=(
                        f"Reduce mask expansion on affected pads so dam ≥ {min_dam_mm:.2f} mm, "
                        "or increase pad-to-pad spacing. "
                        "Config knob: pcb_mask_dam_min_mm (default 0.10 mm for JLCPCB green 1 oz; "
                        "use 0.15 mm for coloured masks)."
                    ),
                ).to_dict()
            )
        return findings
