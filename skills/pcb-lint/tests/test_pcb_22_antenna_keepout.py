"""Tests for PCB-22: antenna keep-out zone copper/component check.

Coordinate conventions:
  All fixture coordinates are in mils (EasyEDA PCB unit).
  Config coordinates are in mm; 1 mm = 39.37 mil.

Zone used in most circle tests:
  centre (0, 0) mil, radius 590.55 mil  (= 15 mm × 39.37)

Zone used in rect test:
  top-left (0, 0) mil, 393.7 × 196.85 mil  (= 10 mm × 5 mm)
"""

from __future__ import annotations

import pytest
from conftest import MockMCPClient, run_check
from checks.pcb_22_antenna_keepout import PcbAntennaKeepout

# 15 mm in mils ≈ 590.55 mil
_R_MIL = 15.0 * 39.37


# ---------- helpers ----------

def _circle_zone(
    name: str = "Test circle",
    x_mm: float = 0.0,
    y_mm: float = 0.0,
    radius_mm: float = 15.0,
) -> dict:
    return {
        "name": name,
        "shape": "circle",
        "x_mm": x_mm,
        "y_mm": y_mm,
        "radius_mm": radius_mm,
    }


def _rect_zone(
    name: str = "Test rect",
    x_mm: float = 0.0,
    y_mm: float = 0.0,
    w_mm: float = 10.0,
    h_mm: float = 5.0,
) -> dict:
    return {
        "name": name,
        "shape": "rect",
        "x_mm": x_mm,
        "y_mm": y_mm,
        "w_mm": w_mm,
        "h_mm": h_mm,
    }


def _client(
    *,
    tracks: list[dict] | None = None,
    pads: list[dict] | None = None,
    vias: list[dict] | None = None,
    pours: list[dict] | None = None,
    components: list[dict] | None = None,
) -> MockMCPClient:
    prims: dict[str, list[dict]] = {
        "track": list(tracks or []),
        "pad": list(pads or []),
        "via": list(vias or []),
        "pour": list(pours or []),
        "region": [],
        "component": list(components or []),
    }
    return MockMCPClient(pcb_primitives=prims)


def _errors(findings: list[dict]) -> list[dict]:
    return [f for f in findings if f["severity"] == "error"]


def _infos(findings: list[dict]) -> list[dict]:
    return [f for f in findings if f["severity"] == "info"]


def _warns(findings: list[dict]) -> list[dict]:
    return [f for f in findings if f["severity"] == "warn"]


# ---------- test 1: no config → info only, no errors ----------

def test_no_config_emits_info_only():
    """Empty antenna_keepouts → info 'PCB-22 skipped', no errors."""
    client = _client()
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": []})
    assert _errors(findings) == []
    assert len(_infos(findings)) == 1
    assert "PCB-22 skipped" in _infos(findings)[0]["message"]
    assert "antenna_keepouts" in _infos(findings)[0]["message"]


def test_missing_config_key_emits_info_only():
    """antenna_keepouts key absent → same info-only behaviour."""
    client = _client()
    # run_check adds document; antenna_keepouts is not present.
    findings = run_check(PcbAntennaKeepout, client)
    assert _errors(findings) == []
    infos = _infos(findings)
    assert len(infos) == 1
    assert "PCB-22 skipped" in infos[0]["message"]


# ---------- test 2: circle zone, clean board → no errors ----------

def test_circle_zone_clean_board():
    """Zone declared, nothing inside → no errors."""
    # Track well outside the 15 mm zone (centre at 0,0):
    # endpoint at (1000, 1000) mil — distance ≈ 1414 mil >> 590.55 mil radius
    track = {
        "primitiveId": "t_safe", "layer": 1,
        "startX": 1000, "startY": 1000,
        "endX": 1200, "endY": 1000,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    assert _errors(findings) == []


# ---------- test 3: circle zone, track endpoint inside → error ----------

def test_circle_zone_track_violation():
    """Track endpoint inside the circle zone → error naming the track."""
    # Zone centre (0, 0), radius 15 mm ≈ 590.55 mil.
    # Endpoint at (100, 0) → distance 100 mil < 590.55 mil → inside.
    track = {
        "primitiveId": "t_bad", "layer": 1,
        "startX": 100, "startY": 0,
        "endX": 2000, "endY": 0,   # far endpoint is outside
    }
    client = _client(tracks=[track])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1
    assert "t_bad" in errors[0]["offending_ids"]
    assert "t_bad" in errors[0]["message"]
    assert "keep-out" in errors[0]["message"].lower()


def test_circle_zone_track_segment_through_zone_errors():
    """Track segment passes straight through the circle zone (both endpoints outside) → error.

    Previously this was a silent miss (endpoints only were checked). The segment
    intersection fix now catches it.
    Zone: centre (0,0), radius 15 mm ≈ 590.55 mil.
    Track: (-700,0) to (700,0) — both endpoints are outside (|x|=700 > 590.55),
    but the segment crosses the circle.
    """
    track = {
        "primitiveId": "t_mid_cross", "layer": 1,
        "startX": -700, "startY": 0,
        "endX": 700, "endY": 0,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1
    assert "t_mid_cross" in errors[0]["offending_ids"]
    assert "keep-out" in errors[0]["message"].lower()


# ---------- test 4: circle zone, component violation → error ----------

def test_circle_zone_component_violation():
    """Component centre inside zone → error naming the designator."""
    comp = {
        "primitiveId": "prim-C7",
        "designator": "C7",
        "layer": 1,
        "x": 200, "y": 0,   # distance 200 mil < 590.55 mil → inside
    }
    client = _client(components=[comp])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1
    assert "C7" in errors[0]["offending_ids"]
    assert "C7" in errors[0]["message"]


def test_circle_zone_component_outside_passes():
    """Component centre outside zone → no error."""
    comp = {
        "primitiveId": "prim-R1",
        "designator": "R1",
        "layer": 1,
        "x": 1000, "y": 1000,   # distance ≈ 1414 mil >> 590.55 mil
    }
    client = _client(components=[comp])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    assert _errors(findings) == []


# ---------- test 5: circle zone, pour vertex inside → error ----------

def test_circle_zone_pour_vertex_violation():
    """Pour with one vertex inside the circle zone → error naming the pour."""
    # Most vertices outside, one at (300, 0) which is inside (300 < 590.55 mil).
    pour = {
        "primitiveId": "pour_rf",
        "layer": 1,
        "points": [1000, 1000, 2000, 1000, 2000, 2000, 1000, 2000, 300, 0],
        # last vertex (300, 0) → inside the zone
    }
    client = _client(pours=[pour])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1
    assert "pour_rf" in errors[0]["offending_ids"]
    assert "pour" in errors[0]["message"].lower()


def test_circle_zone_pour_all_vertices_outside_passes():
    """Pour with all vertices outside zone → no error."""
    pour = {
        "primitiveId": "pour_safe",
        "layer": 1,
        "points": [1000, 1000, 2000, 1000, 2000, 2000, 1000, 2000],
    }
    client = _client(pours=[pour])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    assert _errors(findings) == []


# ---------- test 6: rect zone, pad violation → error ----------

def test_rect_zone_pad_violation():
    """Pad centre inside rect zone → error naming the pad."""
    # Rect zone: x_mm=0, y_mm=0, w_mm=10, h_mm=5
    # In mils: x_min=0, y_min=0, x_max=393.7, y_max=196.85
    # Pad at (200, 100) mil → inside.
    pad = {
        "primitiveId": "pad_in_rect",
        "layer": 1,
        "x": 200, "y": 100,
        "pad": ["RECT", 20, 20],
    }
    client = _client(pads=[pad])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_rect_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1
    assert "pad_in_rect" in errors[0]["offending_ids"]
    assert "pad_in_rect" in errors[0]["message"]


def test_rect_zone_pad_outside_passes():
    """Pad centre outside rect zone → no error."""
    # Rect zone x_max ≈ 393.7 mil; pad at x=500 → outside.
    pad = {
        "primitiveId": "pad_ok",
        "layer": 1,
        "x": 500, "y": 100,
        "pad": ["RECT", 20, 20],
    }
    client = _client(pads=[pad])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_rect_zone()]})
    assert _errors(findings) == []


# ---------- test 7: multiple zones, one violation in each → both errors ----------

def test_multiple_zones_both_violations_emitted():
    """Two zones declared, one violation in each → both errors emitted."""
    # Zone A: circle at (0,0) r=15mm
    zone_a = _circle_zone(name="Zone A")
    # Zone B: rect at x=1000mil/39.37 mm ≈ 25.4mm, y=0, w=10mm, h=10mm
    # → x_min=1000mil, x_max≈1393.7mil, y_min=0, y_max≈393.7mil
    zone_b = {
        "name": "Zone B",
        "shape": "rect",
        "x_mm": 1000 / 39.37,   # 1000 mil in mm
        "y_mm": 0.0,
        "w_mm": 10.0,
        "h_mm": 10.0,
    }

    # Track endpoint inside Zone A (circle at origin, r≈590.55 mil):
    track_a = {
        "primitiveId": "t_zone_a", "layer": 1,
        "startX": 100, "startY": 0,
        "endX": 5000, "endY": 0,
    }
    # Pad inside Zone B (rect starting at x=1000 mil):
    pad_b = {
        "primitiveId": "pad_zone_b",
        "layer": 1,
        "x": 1100, "y": 50,   # inside Zone B
        "pad": ["RECT", 20, 20],
    }

    client = _client(tracks=[track_a], pads=[pad_b])
    findings = run_check(
        PcbAntennaKeepout, client,
        {"antenna_keepouts": [zone_a, zone_b]},
    )
    errors = _errors(findings)
    offending = {eid for e in errors for eid in e["offending_ids"]}
    assert "t_zone_a" in offending
    assert "pad_zone_b" in offending
    assert len(errors) >= 2


# ---------- test 8: unknown shape → warn and skip, other zones continue ----------

def test_unknown_shape_warns_and_skips():
    """Zone with shape='polygon' → warn 'PCB-22: unknown zone shape' + processing continues."""
    # Unknown zone first, then a valid circle zone with a violation.
    poly_zone = {
        "name": "Complex area",
        "shape": "polygon",
        "x_mm": 0, "y_mm": 0,
    }
    circle = _circle_zone(name="Valid circle")
    # Violation in the valid circle zone:
    track = {
        "primitiveId": "t_valid", "layer": 1,
        "startX": 50, "startY": 0,
        "endX": 2000, "endY": 0,
    }
    client = _client(tracks=[track])
    findings = run_check(
        PcbAntennaKeepout, client,
        {"antenna_keepouts": [poly_zone, circle]},
    )

    # Must warn about the unknown shape.
    warns = _warns(findings)
    assert len(warns) == 1
    assert "polygon" in warns[0]["message"]
    assert "PCB-22" in warns[0]["message"]

    # Must still error on the valid circle violation.
    errors = _errors(findings)
    assert len(errors) >= 1
    assert any("t_valid" in e["offending_ids"] for e in errors)


# ---------- test 9: via inside circle zone → error ----------

def test_via_inside_circle_zone_errors():
    """Via centre inside circle zone → error naming the via."""
    via = {
        "primitiveId": "v_in",
        "x": 0, "y": 0,   # exactly at zone centre → inside
        "diameter": 30,
        "holeDiameter": 15,
    }
    client = _client(vias=[via])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1
    assert "v_in" in errors[0]["offending_ids"]
    assert "via" in errors[0]["message"].lower()


def test_via_outside_circle_zone_passes():
    """Via centre outside the zone → no error."""
    via = {
        "primitiveId": "v_out",
        "x": 1000, "y": 1000,   # distance ≈ 1414 mil >> 590.55 mil radius
        "diameter": 30,
        "holeDiameter": 15,
    }
    client = _client(vias=[via])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    assert _errors(findings) == []


# ---------- test 16 (Fix 1 regression): track through circle, endpoints outside → error ----------

def test_16_track_through_circle_zone_endpoints_outside_errors():
    """Regression test for Fix 1 (segment intersection).

    Track from (-20 mm, 0) to (20 mm, 0), 15 mm-radius circle zone at origin.
    Both endpoints are at ±787.4 mil from origin, beyond the 590.55 mil radius.
    The segment passes straight through the antenna zone — previously a silent miss.
    """
    # -20 mm = -787.4 mil; +20 mm = +787.4 mil; radius 15 mm = 590.55 mil
    neg_20mm_mil = -20 * 39.37   # ≈ -787.4 mil
    pos_20mm_mil =  20 * 39.37   # ≈  787.4 mil
    track = {
        "primitiveId": "t_through_circle", "layer": 1,
        "startX": neg_20mm_mil, "startY": 0,
        "endX":   pos_20mm_mil, "endY":   0,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}: {errors}"
    assert "t_through_circle" in errors[0]["offending_ids"]
    assert "keep-out" in errors[0]["message"].lower()


# ---------- test 17 (Fix 1 regression): track through rect zone, endpoints outside → error ----------

def test_17_track_through_rect_zone_endpoints_outside_errors():
    """Regression test for Fix 1 (segment-vs-rect intersection).

    Track from (5 mm, 100 mm) to (95 mm, 100 mm).
    Rect zone at (40 mm, 95 mm), 20 mm wide × 10 mm tall.
    Rect x range: 1574.8 – 2363.2 mil; y range: 3740.15 – 4133.85 mil.
    Track y = 3937 mil is inside the rect's y range. Track x spans
    196.85 – 3740.15 mil, so both endpoints are outside the rect but the
    segment crosses it.
    """
    MM = 39.37
    track = {
        "primitiveId": "t_through_rect", "layer": 1,
        "startX":  5 * MM, "startY": 100 * MM,
        "endX":   95 * MM, "endY":   100 * MM,
    }
    rect_zone = {
        "name": "Rect keepout",
        "shape": "rect",
        "x_mm": 40.0,
        "y_mm": 95.0,
        "w_mm": 20.0,
        "h_mm": 10.0,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [rect_zone]})
    errors = _errors(findings)
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}: {errors}"
    assert "t_through_rect" in errors[0]["offending_ids"]
    assert "keep-out" in errors[0]["message"].lower()


# ---------- test 18 (Fix 5): component bbox overlapping zone → error ----------

def test_18_component_bbox_overlap_circle_zone_errors():
    """Fix 5: component with body extending into zone but centre outside → error via bbox.

    Component centre at (700, 0) mil (outside the 590.55 mil radius).
    Component has pads at x=600 and x=800, so the bounding box spans
    x=600..800, y=0..0.  The closest bbox point to the circle centre (0,0)
    is x=600, y=0 → distance=600 mil > 590.55 mil — but that is just outside.

    Use centre at (650, 0) with pads at x=550 and x=750. Closest bbox point
    to origin is x=550 → distance=550 < 590.55 → bbox overlaps → error.
    """
    comp = {
        "primitiveId": "prim-U99",
        "designator": "U99",
        "layer": 1,
        "x": 650, "y": 0,   # centre is outside (650 > 590.55 mil)
        "pads": [
            {"x": 550, "y": 0},   # this pad is inside the zone (550 < 590.55)
            {"x": 750, "y": 0},
        ],
    }
    client = _client(components=[comp])
    findings = run_check(PcbAntennaKeepout, client, {"antenna_keepouts": [_circle_zone()]})
    errors = _errors(findings)
    assert len(errors) == 1, f"Expected 1 error, got {len(errors)}: {errors}"
    assert "U99" in errors[0]["offending_ids"]
    assert "U99" in errors[0]["message"]
