"""PCB-21: Copper-to-board-edge clearance.

Rule: copper features (tracks, pads, vias, pour vertices) must stay at least
`pcb_edge_clearance_mil` mils from the board outline (layer 11).

JLC recommended minimum — routed edges: 0.2 mm (≈ 8 mil);
V-cut edges: 0.4 mm (≈ 16 mil).
Source: JLCPCB PCB Manufacturing Capabilities (jlcpcb.com/capabilities/pcb-capabilities,
retrieved 2026-08-09). These figures are labelled "minimum" (required for
successful manufacture, not merely recommended).

Below-minimum clearance risks the router bit or V-cut blade nicking exposed
copper during depanelisation, causing a manufacturing reject or shorted/
exposed edge trace in the panel.

Config:
    pcb_edge_clearance_mil (int/float, default 8): threshold in mils.
        Set to 16 for V-cut panels.

MVP scope (per spec):
  - Outline: straight-segment primitives on layer 11 only.
    Arc-shaped outline primitives emit an info finding and are skipped.
    If the outline is composed entirely of arcs, a warn is emitted and
    copper clearance is NOT verified.
  - Copper coverage:
      tracks  — both endpoints AND each outline-segment endpoint checked
                against the track segment (symmetric pass to catch interior
                outline corners near mid-track).
      pads    — centre checked, minus half the smaller pad dimension
                (approximated as a disc of radius min(w,h)/2).
      vias    — centre checked, minus half the outer pad diameter.
      pours   — each vertex in the pour's points list is checked.
  - Silk-layer clearance and cross-arc outline segments are deferred
    (noted in SKILL.md as known limitations).
"""

from __future__ import annotations

from typing import Any

from .base import Check, Finding, register
from .types import Layer, MIL_TO_MM, MM_TO_MIL, point_to_segment_distance_mil

# Fab-specified minimums (JLCPCB PCB Manufacturing Capabilities, 2026-08-09).
# "Minimum" here means required for manufacture to succeed.
_JLC_ROUTED_CLEARANCE_MIL: float = 0.2 * MM_TO_MIL   # ≈ 7.87 mil
_JLC_VCUT_CLEARANCE_MIL: float = 0.4 * MM_TO_MIL     # ≈ 15.75 mil

_DEFAULT_CLEARANCE_MIL: float = 8.0   # routed default (conservative round-up)


def _copper_layers() -> set[int]:
    """Return the set of layer IDs that are copper signal layers."""
    return {Layer.TOP, Layer.BOTTOM} | set(range(15, 100))


def _is_arc_like(primitive: dict) -> bool:
    """Return True if the primitive looks like an arc (not a straight segment)."""
    ptype = (primitive.get("primitiveType") or primitive.get("type") or "").lower()
    return "arc" in ptype


def _extract_outline_segments(
    outline_prims: list[dict],
) -> tuple[list[dict], int]:
    """Split outline primitives into straight segments and count skipped arcs.

    Returns (segments_list, arc_count).
    Each segment dict is guaranteed to have startX/startY/endX/endY.
    """
    segments: list[dict] = []
    arc_count = 0
    for p in outline_prims:
        if _is_arc_like(p):
            arc_count += 1
            continue
        # Accept if it carries segment endpoints.
        if all(k in p for k in ("startX", "startY", "endX", "endY")):
            segments.append(p)
    return segments, arc_count


def _min_dist_to_outline(
    px: float, py: float, segments: list[dict],
) -> float:
    """Minimum distance (mils) from point (px, py) to the nearest outline segment."""
    best = float("inf")
    for seg in segments:
        d = point_to_segment_distance_mil(
            px, py,
            seg["startX"], seg["startY"],
            seg["endX"], seg["endY"],
        )
        if d < best:
            best = d
    return best


def _track_min_dist(track: dict, segments: list[dict]) -> float:
    """Minimum distance from a track (line segment) to the outline.

    Checks both track endpoints against every outline segment (forward pass),
    and also checks both outline-segment endpoints against the track segment
    (symmetric pass). The symmetric pass catches the pattern where an outline
    corner falls near the middle of a long track — neither track endpoint is
    close, but the outline endpoint is.
    """
    x1 = track.get("startX", track.get("x", 0.0))
    y1 = track.get("startY", track.get("y", 0.0))
    x2 = track.get("endX", x1)
    y2 = track.get("endY", y1)

    best = float("inf")
    for seg in segments:
        # Forward pass: track endpoints → outline segment.
        d1 = point_to_segment_distance_mil(x1, y1,
                                           seg["startX"], seg["startY"],
                                           seg["endX"], seg["endY"])
        d2 = point_to_segment_distance_mil(x2, y2,
                                           seg["startX"], seg["startY"],
                                           seg["endX"], seg["endY"])
        # Symmetric pass: outline-segment endpoints → track segment.
        d3 = point_to_segment_distance_mil(seg["startX"], seg["startY"],
                                           x1, y1, x2, y2)
        d4 = point_to_segment_distance_mil(seg["endX"], seg["endY"],
                                           x1, y1, x2, y2)
        seg_best = min(d1, d2, d3, d4)
        if seg_best < best:
            best = seg_best
    return best


def _pad_min_dist(pad: dict, segments: list[dict]) -> float:
    """Minimum distance from a pad's copper edge to the outline.

    The pad is approximated as a disc of radius min(w, h) / 2 centred on
    (x, y). Distance = point-to-outline minus the disc radius.
    """
    px = pad.get("x", 0.0)
    py = pad.get("y", 0.0)
    pad_geom = pad.get("pad") or []
    dims = [v for v in pad_geom[1:] if isinstance(v, (int, float))]
    radius = min(dims) / 2.0 if len(dims) >= 2 else 0.0
    centre_dist = _min_dist_to_outline(px, py, segments)
    return centre_dist - radius


def _pour_min_dist(pour: dict, segments: list[dict]) -> float:
    """Minimum distance from any pour vertex to the outline.

    Uses the pour's `points` or `outline` list of (x, y) pairs.
    Vertex-list approach avoids the bbox false-negative: a pour polygon
    may have a vertex closer to the edge than any bbox corner.
    """
    points_raw = pour.get("points") or pour.get("outline") or []
    # Tolerate flat list [x1,y1,x2,y2,...] or list-of-pairs [[x,y],...].
    coords: list[tuple[float, float]] = []
    if points_raw and isinstance(points_raw[0], (int, float)):
        it = iter(points_raw)
        for x in it:
            try:
                y = next(it)
                coords.append((float(x), float(y)))
            except StopIteration:
                break
    else:
        for pt in points_raw:
            if isinstance(pt, (list, tuple)) and len(pt) >= 2:
                coords.append((float(pt[0]), float(pt[1])))
            elif isinstance(pt, dict):
                coords.append((float(pt.get("x", 0)), float(pt.get("y", 0))))

    if not coords:
        return float("inf")

    best = float("inf")
    for vx, vy in coords:
        d = _min_dist_to_outline(vx, vy, segments)
        if d < best:
            best = d
    return best


@register
class PcbEdgeClearance(Check):
    id = "PCB-21"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        threshold = float(config.get("pcb_edge_clearance_mil", _DEFAULT_CLEARANCE_MIL))
        threshold_mm = threshold * MIL_TO_MM

        findings: list[dict] = []

        # --- Fetch board outline (layer 11) ---
        outline_prims: list[dict] = (
            client.pcb_get_all_primitives(document, type="track", layer=str(Layer.BOARD_OUTLINE))
            or []
        )
        # Also check generic line-type on the outline layer.
        outline_lines: list[dict] = (
            client.pcb_get_all_primitives(document, type="line", layer=str(Layer.BOARD_OUTLINE))
            or []
        )
        # Normalise: both track-on-outline and explicit line primitives are candidates.
        all_outline: list[dict] = list(outline_prims) + list(outline_lines)

        if not all_outline:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="info",
                    message="PCB-21: no board outline found on layer 11 — cannot check edge clearance.",
                    offending_ids=[],
                    suggestion="Add a board outline on layer 11 (BOARD_OUTLINE) in EasyEDA Pro before checking.",
                ).to_dict()
            )
            return findings

        segments, arc_count = _extract_outline_segments(all_outline)

        if arc_count:
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=(
                        f"PCB-21: {arc_count} outline arc(s) skipped — "
                        "checked only straight segments (arc support is a post-MVP addition)."
                    ),
                    offending_ids=[],
                    suggestion="Review arc regions manually for edge clearance.",
                ).to_dict()
            )

        if not segments:
            # All outline primitives were arcs — no straight segments to check.
            # Promote to warn so the user knows NO copper was inspected.
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="warn",
                    message=(
                        "PCB-21: outline is entirely arcs — no straight segments to check against. "
                        "Copper clearance NOT verified."
                    ),
                    offending_ids=[],
                    suggestion="Review the full board outline for edge clearance manually, or add straight outline segments.",
                ).to_dict()
            )
            return findings

        violations: list[dict] = []

        copper_layers = _copper_layers()

        # --- Tracks ---
        tracks = client.pcb_get_all_primitives(document, type="track") or []
        for track in tracks:
            layer = track.get("layer")
            if layer not in copper_layers:
                continue
            dist = _track_min_dist(track, segments)
            if dist < threshold:
                tid = track.get("primitiveId") or track.get("id") or "?"
                dist_mm = dist * MIL_TO_MM
                violations.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=(
                            f"PCB-21: track {tid} is {dist:.1f} mil "
                            f"({dist_mm:.3f} mm) from board edge — "
                            f"below {threshold:.0f} mil ({threshold_mm:.2f} mm) threshold."
                        ),
                        offending_ids=[str(tid)],
                        suggestion=(
                            f"Move track {tid} at least {threshold:.0f} mil "
                            f"({threshold_mm:.2f} mm) from the board outline. "
                            "JLC minimum for routed edges is 0.2 mm (≈ 8 mil); "
                            "set pcb_edge_clearance_mil=16 in config for V-cut panels."
                        ),
                    ).to_dict()
                )

        # --- Pads ---
        pads = client.pcb_get_all_primitives(document, type="pad") or []
        for pad in pads:
            layer = pad.get("layer")
            # Multi-layer (THT) pads are copper on both sides; include them.
            if layer not in copper_layers and layer != Layer.MULTI_LAYER:
                continue
            dist = _pad_min_dist(pad, segments)
            if dist < threshold:
                pid = pad.get("primitiveId") or pad.get("id") or "?"
                dist_mm = dist * MIL_TO_MM
                violations.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=(
                            f"PCB-21: pad {pid} copper edge is {dist:.1f} mil "
                            f"({dist_mm:.3f} mm) from board edge — "
                            f"below {threshold:.0f} mil ({threshold_mm:.2f} mm) threshold."
                        ),
                        offending_ids=[str(pid)],
                        suggestion=(
                            f"Move pad {pid} at least {threshold:.0f} mil "
                            f"({threshold_mm:.2f} mm) from the board outline. "
                            "JLC minimum for routed edges is 0.2 mm (≈ 8 mil)."
                        ),
                    ).to_dict()
                )

        # --- Vias ---
        vias = client.pcb_get_all_primitives(document, type="via") or []
        for via in vias:
            px = via.get("x", 0.0)
            py = via.get("y", 0.0)
            radius = via.get("diameter", 0.0) / 2.0
            centre_dist = _min_dist_to_outline(px, py, segments)
            dist = centre_dist - radius
            if dist < threshold:
                vid = via.get("primitiveId") or via.get("id") or "?"
                dist_mm = dist * MIL_TO_MM
                violations.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=(
                            f"PCB-21: via {vid} copper edge is {dist:.1f} mil "
                            f"({dist_mm:.3f} mm) from board edge — "
                            f"below {threshold:.0f} mil ({threshold_mm:.2f} mm) threshold."
                        ),
                        offending_ids=[str(vid)],
                        suggestion=(
                            f"Move via {vid} at least {threshold:.0f} mil "
                            f"({threshold_mm:.2f} mm) from the board outline. "
                            "JLC minimum for routed edges is 0.2 mm (≈ 8 mil)."
                        ),
                    ).to_dict()
                )

        # --- Pours (copper fills / regions) ---
        for ptype in ("pour", "region"):
            pours = client.pcb_get_all_primitives(document, type=ptype) or []
            for pour in pours:
                layer = pour.get("layer")
                if layer not in copper_layers:
                    continue
                dist = _pour_min_dist(pour, segments)
                if dist < threshold:
                    pourid = pour.get("primitiveId") or pour.get("id") or "?"
                    dist_mm = dist * MIL_TO_MM
                    violations.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=(
                                f"PCB-21: {ptype} {pourid} has a vertex {dist:.1f} mil "
                                f"({dist_mm:.3f} mm) from board edge — "
                                f"below {threshold:.0f} mil ({threshold_mm:.2f} mm) threshold."
                            ),
                            offending_ids=[str(pourid)],
                            suggestion=(
                                f"Shrink the pour boundary so all vertices are "
                                f"≥ {threshold:.0f} mil ({threshold_mm:.2f} mm) from the board outline. "
                                "Note: vertex-based check may miss violations on polygon edges between vertices. "
                                "Verify the full pour boundary visually if near threshold."
                            ),
                        ).to_dict()
                    )

        findings.extend(violations)

        if not violations:
            # Append a top-level note about the applied threshold.
            findings.append(
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=(
                        f"PCB-21: all copper cleared board edge "
                        f"(applied threshold {threshold:.0f} mil / {threshold_mm:.2f} mm)."
                    ),
                    offending_ids=[],
                    suggestion="",
                ).to_dict()
            )

        return findings
