"""Unit tests for geometry helpers in scripts/checks/types.py."""

from __future__ import annotations

import math
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL_ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from checks.types import point_to_segment_distance_mil, segments_intersect_mil


# ---------- point_to_segment_distance_mil ----------

def test_point_on_segment_midpoint_is_zero():
    """Point exactly on the segment should return 0 (within floating-point tolerance)."""
    d = point_to_segment_distance_mil(5.0, 0.0, 0.0, 0.0, 10.0, 0.0)
    assert d == pytest.approx(0.0, abs=1e-9)


def test_point_perpendicular_to_midpoint():
    """Point perpendicular to the midpoint of a horizontal segment."""
    # Segment (0,0)-(10,0), point at (5,3) → nearest point is (5,0) → distance 3.
    d = point_to_segment_distance_mil(5.0, 3.0, 0.0, 0.0, 10.0, 0.0)
    assert d == pytest.approx(3.0, abs=1e-9)


def test_point_past_end_clamped_to_endpoint():
    """Point beyond the end of the segment → distance to nearest endpoint."""
    # Segment (0,0)-(10,0), point at (15,0) → nearest endpoint is (10,0) → distance 5.
    d = point_to_segment_distance_mil(15.0, 0.0, 0.0, 0.0, 10.0, 0.0)
    assert d == pytest.approx(5.0, abs=1e-9)


def test_point_before_start_clamped_to_start():
    """Point before the start of the segment → distance to the start endpoint."""
    # Segment (5,0)-(15,0), point at (0,0) → nearest endpoint is (5,0) → distance 5.
    d = point_to_segment_distance_mil(0.0, 0.0, 5.0, 0.0, 15.0, 0.0)
    assert d == pytest.approx(5.0, abs=1e-9)


def test_degenerate_segment_zero_length():
    """Degenerate segment (both endpoints the same) → distance to that point."""
    d = point_to_segment_distance_mil(3.0, 4.0, 0.0, 0.0, 0.0, 0.0)
    assert d == pytest.approx(5.0, abs=1e-9)


def test_diagonal_segment():
    """Distance from (0,1) to diagonal segment (0,0)-(1,1)."""
    # Nearest point on segment: project (0,1) onto (0,0)+(0.5)(1,1) direction.
    # t = ((0*1)+(1*1)) / 2 = 0.5 → nearest = (0.5, 0.5) → dist = sqrt(0.25+0.25).
    d = point_to_segment_distance_mil(0.0, 1.0, 0.0, 0.0, 1.0, 1.0)
    assert d == pytest.approx(math.sqrt(0.5), abs=1e-9)


import pytest


# ---------- segments_intersect_mil ----------

def test_crossing_segments_intersect():
    """Classic + crossing: (0,0)-(10,10) crosses (0,10)-(10,0) at (5,5)."""
    assert segments_intersect_mil(0, 0, 10, 10, 0, 10, 10, 0) is True


def test_parallel_non_overlapping_segments_do_not_intersect():
    """Two parallel horizontal segments with a vertical gap do not intersect."""
    # Seg A: y=0, x=0..10; Seg B: y=5, x=0..10 — parallel, no crossing
    assert segments_intersect_mil(0, 0, 10, 0, 0, 5, 10, 5) is False


def test_colinear_overlapping_segments_intersect():
    """Collinear segments that share a stretch are treated as intersecting."""
    # Both on y=0: A covers x=0..10, B covers x=5..15 — overlap at x=5..10
    assert segments_intersect_mil(0, 0, 10, 0, 5, 0, 15, 0) is True


def test_colinear_non_overlapping_segments_do_not_intersect():
    """Collinear segments with a gap between them do not intersect."""
    # A covers x=0..4, B covers x=6..10 — gap at x=4..6
    assert segments_intersect_mil(0, 0, 4, 0, 6, 0, 10, 0) is False


def test_touching_at_endpoint_intersects():
    """Segments sharing exactly one endpoint are counted as intersecting."""
    # T-shape: A=(0,0)-(10,0), B=(5,0)-(5,10) touch at (5,0)
    assert segments_intersect_mil(0, 0, 10, 0, 5, 0, 5, 10) is True
