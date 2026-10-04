"""PCB-22: Antenna keep-out zone copper/component check.

Rule: RF modules (ESP32-WROOM, ESP32-C3-WROOM, LoRa modules, WiFi/BT modules
with chip antennas) require a keep-out zone around the antenna. No copper
(tracks, pads, vias, pour vertices) and no component centres may fall inside
this zone. Copper inside the zone detunes the antenna, reduces range, and can
cause FCC/CE certification failure.

Keep-out zones are not derivable from the netlist or footprint — they are
physical/EM specs that must be declared per board in config.

Config:
    antenna_keepouts (list): each entry has:
        name  (str):    human label for the zone (used in error messages)
        shape (str):    "circle" or "rect" (polygon is post-MVP)
        For circle:
            x_mm, y_mm   — centre in mm  (same coordinate origin as EasyEDA
                           component/track x/y; read coords from EDA directly)
            radius_mm    — radius in mm
        For rect:
            x_mm, y_mm   — top-left corner in mm  (same coordinate origin as
                           EasyEDA component/track x/y; read coords from EDA)
            w_mm, h_mm   — width and height in mm

If antenna_keepouts is absent or empty, emits an info finding (no silent pass).

Source: typical 2.4 GHz PCB/chip antenna keep-out is 15 mm;
module datasheets vary (ESP32-WROOM: 15 mm, some LoRa modules: 20 mm).

MVP scope:
  - Tracks: both endpoints AND segment body checked (a track passing straight
    through a zone with both endpoints outside is now caught).
  - Pads: pad centre checked.
  - Vias: via centre checked.
  - Pours: each vertex in the points list checked.
  - Components: pad bounding-box checked when pads are present; otherwise
    component centre (x, y) used (large components with no pad geometry may be
    missed — verify visually if the centre is within ~5 mm of a keep-out edge).
  - Polygon-shaped keep-outs: post-MVP (noted in SKILL.md).

Performance note: all MCP primitive fetches are performed once before iterating
zones; on multi-zone boards each fetch is NOT repeated per zone.
"""

from __future__ import annotations

import math
from typing import Any

from .base import Check, Finding, register
from .types import MM_TO_MIL, MIL_TO_MM, distance_mil, point_to_segment_distance_mil, segments_intersect_mil


# ---------- geometry helpers ----------


def _segment_intersects_rect_mil(
    x1: float, y1: float, x2: float, y2: float,
    x_min: float, y_min: float, x_max: float, y_max: float,
) -> bool:
    """Return True if segment (x1,y1)-(x2,y2) crosses any edge of the rectangle.

    The four rectangle edges are tested with segments_intersect_mil.
    This does NOT test whether the segment is entirely inside the rectangle
    (endpoint containment is the caller's job).
    """
    # Top edge: (x_min, y_min) - (x_max, y_min)
    if segments_intersect_mil(x1, y1, x2, y2, x_min, y_min, x_max, y_min):
        return True
    # Bottom edge: (x_min, y_max) - (x_max, y_max)
    if segments_intersect_mil(x1, y1, x2, y2, x_min, y_max, x_max, y_max):
        return True
    # Left edge: (x_min, y_min) - (x_min, y_max)
    if segments_intersect_mil(x1, y1, x2, y2, x_min, y_min, x_min, y_max):
        return True
    # Right edge: (x_max, y_min) - (x_max, y_max)
    if segments_intersect_mil(x1, y1, x2, y2, x_max, y_min, x_max, y_max):
        return True
    return False


def _bbox_overlaps_circle_mil(
    bx_min: float, by_min: float, bx_max: float, by_max: float,
    cx: float, cy: float, r: float,
) -> bool:
    """Return True if the axis-aligned bounding box overlaps a circle.

    Uses the closest-point-on-AABB-to-circle-centre test:
    clamp the centre to the box, then compare distance to radius.
    """
    # Clamp centre to box
    nearest_x = max(bx_min, min(cx, bx_max))
    nearest_y = max(by_min, min(cy, by_max))
    return distance_mil(cx, cy, nearest_x, nearest_y) <= r


def _bbox_overlaps_rect_mil(
    bx_min: float, by_min: float, bx_max: float, by_max: float,
    rx_min: float, ry_min: float, rx_max: float, ry_max: float,
) -> bool:
    """Return True if two axis-aligned bounding boxes overlap (AABB test)."""
    return bx_min <= rx_max and bx_max >= rx_min and by_min <= ry_max and by_max >= ry_min


def _point_in_circle_mil(
    px: float, py: float,
    cx: float, cy: float,
    radius: float,
) -> bool:
    """Return True if (px, py) is inside (or on the boundary of) the circle."""
    return distance_mil(px, py, cx, cy) <= radius


def _point_in_rect_mil(
    px: float, py: float,
    x_min: float, y_min: float,
    x_max: float, y_max: float,
) -> bool:
    """Return True if (px, py) is inside (or on the boundary of) the rectangle."""
    return x_min <= px <= x_max and y_min <= py <= y_max


def _dist_to_circle_edge_mil(
    px: float, py: float,
    cx: float, cy: float,
    radius: float,
) -> float:
    """Distance inside the circle edge (positive = inside, negative = outside)."""
    return radius - distance_mil(px, py, cx, cy)


def _dist_inside_rect_mil(
    px: float, py: float,
    x_min: float, y_min: float,
    x_max: float, y_max: float,
) -> float:
    """How far inside the rectangle boundary the point is (mils).

    Returns the minimum distance to any edge (positive = inside, 0 = on edge).
    Negative means outside, but this is only called after confirming inside.
    """
    return min(px - x_min, x_max - px, py - y_min, y_max - py)


# ---------- zone parsing ----------


def _parse_zones(antenna_keepouts: list[dict]) -> list[dict]:
    """Parse and validate each zone entry. Returns a list of internal zone
    descriptors with all coordinates pre-converted to mils.

    Unknown shapes emit a 'warn_skip' entry consumed by the run() method.
    """
    zones: list[dict] = []
    for entry in antenna_keepouts:
        name = entry.get("name") or "unnamed"
        shape = (entry.get("shape") or "").lower().strip()

        if shape == "circle":
            cx = float(entry.get("x_mm", 0)) * MM_TO_MIL
            cy = float(entry.get("y_mm", 0)) * MM_TO_MIL
            r = float(entry.get("radius_mm", 0)) * MM_TO_MIL
            zones.append({
                "type": "circle",
                "name": name,
                "cx": cx, "cy": cy, "r": r,
            })

        elif shape == "rect":
            x = float(entry.get("x_mm", 0)) * MM_TO_MIL
            y = float(entry.get("y_mm", 0)) * MM_TO_MIL
            w = float(entry.get("w_mm", 0)) * MM_TO_MIL
            h = float(entry.get("h_mm", 0)) * MM_TO_MIL
            zones.append({
                "type": "rect",
                "name": name,
                "x_min": x, "y_min": y,
                "x_max": x + w, "y_max": y + h,
            })

        else:
            zones.append({
                "type": "warn_skip",
                "name": name,
                "raw_shape": shape or entry.get("shape") or "",
            })

    return zones


# ---------- point-in-zone / distance helpers ----------


def _in_zone(px: float, py: float, zone: dict) -> bool:
    if zone["type"] == "circle":
        return _point_in_circle_mil(px, py, zone["cx"], zone["cy"], zone["r"])
    if zone["type"] == "rect":
        return _point_in_rect_mil(px, py, zone["x_min"], zone["y_min"],
                                   zone["x_max"], zone["y_max"])
    return False


def _depth_in_zone_mil(px: float, py: float, zone: dict) -> float:
    """How far inside the zone boundary the point is (mils)."""
    if zone["type"] == "circle":
        return _dist_to_circle_edge_mil(px, py, zone["cx"], zone["cy"], zone["r"])
    if zone["type"] == "rect":
        return _dist_inside_rect_mil(px, py, zone["x_min"], zone["y_min"],
                                      zone["x_max"], zone["y_max"])
    return 0.0


# ---------- pour-vertex extraction (shared pattern with PCB-21) ----------


def _pour_coords(pour: dict) -> list[tuple[float, float]]:
    """Return list of (x, y) vertex pairs from a pour or region primitive."""
    points_raw = pour.get("points") or pour.get("outline") or []
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
    return coords


# ---------- check class ----------


@register
class PcbAntennaKeepout(Check):
    id = "PCB-22"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        keepouts_raw = config.get("antenna_keepouts") or []

        if not keepouts_raw:
            return [
                Finding(
                    check_id=self.id,
                    severity="info",
                    message=(
                        "PCB-22 skipped: no antenna_keepouts declared in config. "
                        "If this board has an RF module, add a keep-out zone."
                    ),
                    offending_ids=[],
                    suggestion=(
                        'Add "antenna_keepouts": [{"name": "...", "shape": "circle", '
                        '"x_mm": 25, "y_mm": 10, "radius_mm": 15}] to pcb-lint.config.json. '
                        "Typical 2.4 GHz keep-out: 15 mm (ESP32-WROOM); some LoRa modules: 20 mm."
                    ),
                ).to_dict()
            ]

        zones = _parse_zones(keepouts_raw)
        findings: list[dict] = []

        # --- Hoist all MCP fetches above the zone loop (Fix 2) ---
        # On multi-zone boards each primitive type is fetched exactly once,
        # not once per zone.
        tracks = client.pcb_get_all_primitives(document, type="track") or []
        pads = client.pcb_get_all_primitives(document, type="pad") or []
        vias = client.pcb_get_all_primitives(document, type="via") or []
        pours = client.pcb_get_all_primitives(document, type="pour") or []
        regions = client.pcb_get_all_primitives(document, type="region") or []
        components = client.pcb_get_all_primitives(document, type="component") or []

        for zone in zones:
            if zone["type"] == "warn_skip":
                raw = zone.get("raw_shape", "")
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=(
                            f"PCB-22: unknown zone shape {raw!r} skipped "
                            f"(zone '{zone['name']}'). Supported shapes: 'circle', 'rect'."
                        ),
                        offending_ids=[],
                        suggestion=(
                            "Polygon-shaped keep-outs are post-MVP. "
                            "Use 'circle' or 'rect' to express the zone for now."
                        ),
                    ).to_dict()
                )
                continue

            # --- Tracks (Fix 1: check segment body, not endpoints only) ---
            for track in tracks:
                x1 = float(track.get("startX", track.get("x", 0.0)))
                y1 = float(track.get("startY", track.get("y", 0.0)))
                x2 = float(track.get("endX", x1))
                y2 = float(track.get("endY", y1))
                in1 = _in_zone(x1, y1, zone)
                in2 = _in_zone(x2, y2, zone)

                # Detect segment crossing even when both endpoints are outside.
                segment_crosses = False
                if not in1 and not in2:
                    if zone["type"] == "circle":
                        dist_to_seg = point_to_segment_distance_mil(
                            zone["cx"], zone["cy"], x1, y1, x2, y2
                        )
                        segment_crosses = dist_to_seg <= zone["r"]
                    elif zone["type"] == "rect":
                        segment_crosses = _segment_intersects_rect_mil(
                            x1, y1, x2, y2,
                            zone["x_min"], zone["y_min"], zone["x_max"], zone["y_max"],
                        )

                if in1 or in2 or segment_crosses:
                    tid = track.get("primitiveId") or track.get("id") or "?"
                    if in1 or in2:
                        depths = []
                        if in1:
                            depths.append(_depth_in_zone_mil(x1, y1, zone))
                        if in2:
                            depths.append(_depth_in_zone_mil(x2, y2, zone))
                        depth = max(depths)
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="error",
                                message=(
                                    f"PCB-22: track {tid} has an endpoint inside antenna keep-out "
                                    f"'{zone['name']}' (penetration {depth:.1f} mil / "
                                    f"{depth * MIL_TO_MM:.2f} mm)."
                                ),
                                offending_ids=[str(tid)],
                                suggestion=(
                                    f"Reroute track {tid} so the segment is entirely outside the "
                                    f"'{zone['name']}' keep-out zone. "
                                    "Copper inside an antenna keep-out detunes the antenna and "
                                    "can cause FCC/CE certification failure."
                                ),
                            ).to_dict()
                        )
                    else:
                        # Segment body crosses the zone; endpoints are outside.
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="error",
                                message=(
                                    f"PCB-22: track {tid} segment passes through antenna keep-out "
                                    f"'{zone['name']}' (endpoints outside, body inside)."
                                ),
                                offending_ids=[str(tid)],
                                suggestion=(
                                    f"Reroute track {tid} so the segment is entirely outside the "
                                    f"'{zone['name']}' keep-out zone. "
                                    "Copper inside an antenna keep-out detunes the antenna and "
                                    "can cause FCC/CE certification failure."
                                ),
                            ).to_dict()
                        )

            # --- Pads ---
            for pad in pads:
                px = pad.get("x", 0.0)
                py = pad.get("y", 0.0)
                if _in_zone(px, py, zone):
                    pid = pad.get("primitiveId") or pad.get("id") or "?"
                    depth = _depth_in_zone_mil(px, py, zone)
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=(
                                f"PCB-22: pad {pid} centre is inside antenna keep-out "
                                f"'{zone['name']}' (penetration {depth:.1f} mil / "
                                f"{depth * MIL_TO_MM:.2f} mm)."
                            ),
                            offending_ids=[str(pid)],
                            suggestion=(
                                f"Move pad {pid} outside the '{zone['name']}' keep-out zone. "
                                "Pads (copper) inside an antenna keep-out detune the antenna."
                            ),
                        ).to_dict()
                    )

            # --- Vias ---
            for via in vias:
                px = via.get("x", 0.0)
                py = via.get("y", 0.0)
                if _in_zone(px, py, zone):
                    vid = via.get("primitiveId") or via.get("id") or "?"
                    depth = _depth_in_zone_mil(px, py, zone)
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=(
                                f"PCB-22: via {vid} centre is inside antenna keep-out "
                                f"'{zone['name']}' (penetration {depth:.1f} mil / "
                                f"{depth * MIL_TO_MM:.2f} mm)."
                            ),
                            offending_ids=[str(vid)],
                            suggestion=(
                                f"Move via {vid} outside the '{zone['name']}' keep-out zone. "
                                "Vias (copper barrels) inside an antenna keep-out detune the antenna."
                            ),
                        ).to_dict()
                    )

            # --- Pours / regions ---
            for ptype, prim_list in (("pour", pours), ("region", regions)):
                for pour in prim_list:
                    coords = _pour_coords(pour)
                    violating = [(x, y) for x, y in coords if _in_zone(x, y, zone)]
                    if violating:
                        pourid = pour.get("primitiveId") or pour.get("id") or "?"
                        depths = [_depth_in_zone_mil(x, y, zone) for x, y in violating]
                        depth = max(depths)
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="error",
                                message=(
                                    f"PCB-22: {ptype} {pourid} has {len(violating)} vertex/vertices "
                                    f"inside antenna keep-out '{zone['name']}' "
                                    f"(worst penetration {depth:.1f} mil / "
                                    f"{depth * MIL_TO_MM:.2f} mm)."
                                ),
                                offending_ids=[str(pourid)],
                                suggestion=(
                                    f"Shrink the {ptype} boundary so all vertices are outside "
                                    f"the '{zone['name']}' keep-out zone. "
                                    "Note: vertex-only check — verify full pour boundary visually."
                                ),
                            ).to_dict()
                        )

            # --- Components (Fix 5: try pad bbox first; fall back to centre) ---
            for comp in components:
                desig = comp.get("designator") or comp.get("primitiveId") or comp.get("id") or "?"
                comp_pads = comp.get("pads") or []

                if comp_pads:
                    # Compute bounding box from pad centres.
                    xs = [float(p.get("x", 0.0)) for p in comp_pads]
                    ys = [float(p.get("y", 0.0)) for p in comp_pads]
                    bx_min, bx_max = min(xs), max(xs)
                    by_min, by_max = min(ys), max(ys)

                    if zone["type"] == "circle":
                        overlaps = _bbox_overlaps_circle_mil(
                            bx_min, by_min, bx_max, by_max,
                            zone["cx"], zone["cy"], zone["r"],
                        )
                    else:  # rect
                        overlaps = _bbox_overlaps_rect_mil(
                            bx_min, by_min, bx_max, by_max,
                            zone["x_min"], zone["y_min"], zone["x_max"], zone["y_max"],
                        )

                    if overlaps:
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="error",
                                message=(
                                    f"PCB-22: component {desig} pad bounding box overlaps antenna "
                                    f"keep-out '{zone['name']}'."
                                ),
                                offending_ids=[str(desig)],
                                suggestion=(
                                    f"Relocate component {desig} outside the '{zone['name']}' "
                                    "keep-out zone. Metal/component bodies inside the keep-out "
                                    "detune the antenna and can cause certification failure."
                                ),
                            ).to_dict()
                        )
                else:
                    # No pad geometry available — fall back to centre check.
                    cx = comp.get("x", 0.0)
                    cy = comp.get("y", 0.0)
                    if _in_zone(cx, cy, zone):
                        depth = _depth_in_zone_mil(cx, cy, zone)
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="error",
                                message=(
                                    f"PCB-22: component {desig} centre is inside antenna keep-out "
                                    f"'{zone['name']}' (penetration {depth:.1f} mil / "
                                    f"{depth * MIL_TO_MM:.2f} mm)."
                                ),
                                offending_ids=[str(desig)],
                                suggestion=(
                                    f"Relocate component {desig} outside the '{zone['name']}' "
                                    "keep-out zone. Metal/component bodies inside the keep-out "
                                    "detune the antenna and can cause certification failure."
                                ),
                            ).to_dict()
                        )

        return findings
