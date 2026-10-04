"""Tests for PCB-21: copper-to-board-edge clearance.

Board coordinate system used in fixtures:
  outline: rectangle from (0,0) to (2000,1500) mils.
  "right edge" = the segment from (2000,0) to (2000,1500).
  "bottom edge" = the segment from (0,1500) to (2000,1500).

Default threshold: 8 mil (routed panels).
"""

from __future__ import annotations

import pytest
from conftest import MockMCPClient, run_check
from checks.pcb_21_edge_clearance import PcbEdgeClearance


# ---------- helpers ----------

def _rect_outline(x0: float, y0: float, x1: float, y1: float) -> list[dict]:
    """Four straight track segments forming a closed rectangle."""
    # Outline primitives live on layer 11 (BOARD_OUTLINE).
    segs = [
        {"primitiveId": "ol1", "primitiveType": "Track", "layer": 11,
         "startX": x0, "startY": y0, "endX": x1, "endY": y0},
        {"primitiveId": "ol2", "primitiveType": "Track", "layer": 11,
         "startX": x1, "startY": y0, "endX": x1, "endY": y1},
        {"primitiveId": "ol3", "primitiveType": "Track", "layer": 11,
         "startX": x1, "startY": y1, "endX": x0, "endY": y1},
        {"primitiveId": "ol4", "primitiveType": "Track", "layer": 11,
         "startX": x0, "startY": y1, "endX": x0, "endY": y0},
    ]
    return segs


def _client(
    *,
    outline: list[dict] | None = None,
    tracks: list[dict] | None = None,
    pads: list[dict] | None = None,
    pours: list[dict] | None = None,
    vias: list[dict] | None = None,
) -> MockMCPClient:
    outline = outline if outline is not None else _rect_outline(0, 0, 2000, 1500)

    # Build pcb_primitives keyed by type+layer so the mock can filter.
    # The mock client filters on layer using str comparison, so store as int
    # (the mock uses str(it.get("layer")) == str(layer)).
    prims: dict[str, list[dict]] = {
        "track": list(outline) + list(tracks or []),
        "pad": list(pads or []),
        "pour": list(pours or []),
        "region": [],
        "line": [],
        "via": list(vias or []),
    }
    return MockMCPClient(pcb_primitives=prims)


def _findings_errors(findings: list[dict]) -> list[dict]:
    return [f for f in findings if f["severity"] == "error"]


def _findings_info(findings: list[dict]) -> list[dict]:
    return [f for f in findings if f["severity"] == "info"]


# ---------- test 1: clean board ----------

def test_clean_board_no_errors():
    """Single track well inside a 2000×1500 mil board → no errors."""
    track = {
        "primitiveId": "t1", "layer": 1,   # TOP
        "startX": 500, "startY": 500,
        "endX": 800, "endY": 500,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbEdgeClearance, client)
    assert _findings_errors(findings) == []
    # Should get one info "all copper cleared" finding.
    info = _findings_info(findings)
    assert any("PCB-21" in f["message"] for f in info)


# ---------- test 2: track too close to edge ----------

def test_track_too_close_to_right_edge():
    """Track endpoint 5 mil from the right edge (x=2000) → error."""
    # Right edge is at x=2000; endpoint at x=1995 → 5 mil away.
    track = {
        "primitiveId": "t_close", "layer": 1,
        "startX": 1995, "startY": 700,
        "endX": 1990, "endY": 700,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 1
    assert "t_close" in errors[0]["offending_ids"]
    # Message must mention the distance and the offending ID.
    assert "t_close" in errors[0]["message"]
    assert "5.0 mil" in errors[0]["message"]


# ---------- test 3: exactly at threshold / just below ----------

def test_track_exactly_at_threshold_passes():
    """Track endpoint 8 mil from right edge with default threshold 8 → pass (>= not >)."""
    track = {
        "primitiveId": "t_exact", "layer": 1,
        "startX": 1992, "startY": 700,   # 2000 - 1992 = 8 mil
        "endX": 1985, "endY": 700,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbEdgeClearance, client)
    assert _findings_errors(findings) == []


def test_track_just_below_threshold_errors():
    """Track endpoint 7.99 mil from edge → error."""
    # x=1992.01 → 2000 - 1992.01 = 7.99 mil
    track = {
        "primitiveId": "t_under", "layer": 1,
        "startX": 1992.01, "startY": 700,
        "endX": 1985, "endY": 700,
    }
    client = _client(tracks=[track])
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 1
    assert "t_under" in errors[0]["offending_ids"]


# ---------- test 4: pad too close ----------

def test_pad_too_close_to_edge():
    """SMD pad centre 3 mil from edge; pad 10×10 mil (radius 5 mil) → edge distance -2 mil → error."""
    # Pad at x=1997, right edge at x=2000 → centre is 3 mil away.
    # Pad is 10×10 mil → radius = 5 mil → copper edge = 3 - 5 = -2 mil < 8 mil threshold.
    pad = {
        "primitiveId": "p_close", "layer": 1,
        "x": 1997, "y": 700,
        "pad": ["RECT", 10, 10],
    }
    client = _client(pads=[pad])
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 1
    assert "p_close" in errors[0]["offending_ids"]


# ---------- test 5: V-cut config ----------

def test_vcut_config_catches_track_at_10_mil():
    """Track 10 mil from edge would pass default (8 mil) but fails with V-cut threshold (16 mil)."""
    # Default 8 mil: 10 >= 8 → pass.
    track = {
        "primitiveId": "t_vcut", "layer": 1,
        "startX": 1990, "startY": 700,   # 2000 - 1990 = 10 mil
        "endX": 1985, "endY": 700,
    }
    # First confirm it passes at default.
    client = _client(tracks=[track])
    findings_default = run_check(PcbEdgeClearance, client)
    assert _findings_errors(findings_default) == []

    # Now with V-cut threshold.
    findings_vcut = run_check(PcbEdgeClearance, client, {"pcb_edge_clearance_mil": 16})
    errors = _findings_errors(findings_vcut)
    assert len(errors) == 1
    assert "t_vcut" in errors[0]["offending_ids"]


# ---------- test 6: arc in outline → info, continues with straight segments ----------

def test_arc_in_outline_emits_info_and_continues():
    """Outline with one arc primitive → info about skipped arc; straight segments still checked."""
    straight_segs = _rect_outline(0, 0, 2000, 1500)
    arc_prim = {
        "primitiveId": "arc1", "primitiveType": "Arc", "layer": 11,
        "startX": 0, "startY": 0, "endX": 100, "endY": 100,
    }
    # Close track well inside the board.
    good_track = {
        "primitiveId": "t_good", "layer": 1,
        "startX": 500, "startY": 500, "endX": 800, "endY": 500,
    }
    # Bad track near edge.
    bad_track = {
        "primitiveId": "t_bad", "layer": 1,
        "startX": 1995, "startY": 700, "endX": 1990, "endY": 700,
    }

    prims = {
        "track": straight_segs + [good_track, bad_track],
        "pad": [],
        "pour": [],
        "region": [],
        "line": [arc_prim],
    }
    client = MockMCPClient(pcb_primitives=prims)
    findings = run_check(PcbEdgeClearance, client)
    info = _findings_info(findings)
    arc_infos = [f for f in info if "arc" in f["message"].lower()]
    assert len(arc_infos) == 1
    assert "1" in arc_infos[0]["message"]

    # The bad track must still generate an error (straight segments were checked).
    errors = _findings_errors(findings)
    assert any("t_bad" in e["offending_ids"] for e in errors)


# ---------- test 7: no outline → info, no errors ----------

def test_no_outline_emits_info_only():
    """Empty outline layer → info, no errors or warnings."""
    track = {
        "primitiveId": "t1", "layer": 1,
        "startX": 500, "startY": 500, "endX": 800, "endY": 500,
    }
    # Provide outline as empty list by not passing outline to the helper.
    prims = {
        "track": [track],
        "pad": [],
        "pour": [],
        "region": [],
        "line": [],
    }
    client = MockMCPClient(pcb_primitives=prims)
    findings = run_check(PcbEdgeClearance, client)
    # Should have exactly one info finding, no errors.
    assert _findings_errors(findings) == []
    info = _findings_info(findings)
    assert len(info) == 1
    assert "no board outline" in info[0]["message"].lower()


# ---------- test 8: pour vertex close to edge → error ----------

def test_pour_vertex_close_to_edge():
    """Pour with one vertex 3 mil from right edge → error naming the pour."""
    pour = {
        "primitiveId": "pour1", "layer": 1,
        "points": [200, 200, 800, 200, 800, 800, 200, 800, 1997, 700],
        # Last vertex at x=1997 → 3 mil from right edge (x=2000).
    }
    client = _client(pours=[pour])
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 1
    assert "pour1" in errors[0]["offending_ids"]
    assert "pour" in errors[0]["message"].lower()


# ---------- test 9: multiple violations → all emitted ----------

def test_multiple_edge_violations_all_emitted():
    """Several tracks under threshold → all findings emitted, not just first."""
    tracks = [
        {"primitiveId": f"t{i}", "layer": 1,
         "startX": 1995, "startY": 100 + i * 50,
         "endX": 1990, "endY": 100 + i * 50}
        for i in range(4)
    ]
    client = _client(tracks=tracks)
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 4
    offending = {eid for e in errors for eid in e["offending_ids"]}
    for i in range(4):
        assert f"t{i}" in offending


# ---------- test 10 (Fix 1): all-arc outline → warn, no errors ----------

def test_all_arc_outline_emits_warn_not_error():
    """Outline composed entirely of arc primitives → warn that copper clearance NOT verified.

    A track near the edge must NOT generate an error because no straight segments
    were ever checked — the warn is the only active finding (plus the arc info).
    """
    arc_only_outline = [
        {"primitiveId": f"arc{i}", "primitiveType": "Arc", "layer": 11,
         "startX": i * 100, "startY": 0, "endX": (i + 1) * 100, "endY": 100}
        for i in range(4)
    ]
    # Track that would be an error if any straight segment existed near it.
    close_track = {
        "primitiveId": "t_near_edge", "layer": 1,
        "startX": 1995, "startY": 700, "endX": 1990, "endY": 700,
    }
    prims = {
        "track": arc_only_outline + [close_track],
        "pad": [],
        "pour": [],
        "region": [],
        "line": [],
        "via": [],
    }
    client = MockMCPClient(pcb_primitives=prims)
    findings = run_check(PcbEdgeClearance, client)

    # No errors — copper was never compared against the outline.
    assert _findings_errors(findings) == []

    # Must have at least one warn about the all-arc outline.
    warns = [f for f in findings if f["severity"] == "warn"]
    assert len(warns) == 1
    msg = warns[0]["message"]
    assert "entirely arcs" in msg.lower() or "no straight segments" in msg.lower()
    assert "NOT verified" in msg


# ---------- test 11 (Fix 2): outline corner near track mid-point → error ----------

def test_outline_endpoint_near_track_midpoint_triggers_error():
    """Interior outline segment ending 5 mil from the middle of a long horizontal track.

    Neither track endpoint is close to the outline — only the outline segment's
    endpoint falls near the track mid-point. The symmetric distance pass must
    catch this.

    Track: (100, 500) → (1900, 500).  Right-edge outline at x=2000 is far.
    Interior outline segment: (400, 400) → (1000, 505).
    Outline-segment endpoint (1000, 505) is 5 mil from the track (y=500),
    which is below the 8 mil threshold.
    """
    # Standard rect outline plus one extra interior segment whose endpoint
    # lands 5 mil above the mid-section of the long track.
    standard = _rect_outline(0, 0, 2000, 1500)
    interior_seg = {
        "primitiveId": "interior_seg", "primitiveType": "Track", "layer": 11,
        "startX": 400, "startY": 400,
        "endX": 1000, "endY": 505,   # endpoint 5 mil from track at y=500
    }
    long_track = {
        "primitiveId": "t_long", "layer": 1,
        "startX": 100, "startY": 500,
        "endX": 1900, "endY": 500,
    }
    prims = {
        "track": standard + [interior_seg, long_track],
        "pad": [],
        "pour": [],
        "region": [],
        "line": [],
        "via": [],
    }
    client = MockMCPClient(pcb_primitives=prims)
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 1
    assert "t_long" in errors[0]["offending_ids"]
    assert "t_long" in errors[0]["message"]


# ---------- test 12 (Fix 4): via too close to edge → error ----------

def test_via_too_close_to_edge():
    """Via at (1997, 700) with diameter=10 mil (radius 5 mil).

    Centre is 3 mil from right edge (x=2000); copper edge = 3 - 5 = -2 mil → error.
    """
    via = {
        "primitiveId": "v_close", "primitiveType": "Via",
        "x": 1997, "y": 700,
        "diameter": 10,     # outer pad diameter in mils
        "holeDiameter": 4,
    }
    client = _client(vias=[via])
    findings = run_check(PcbEdgeClearance, client)
    errors = _findings_errors(findings)
    assert len(errors) == 1
    assert "v_close" in errors[0]["offending_ids"]
    assert "v_close" in errors[0]["message"]
