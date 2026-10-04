from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_18_via_aspect_ratio import PcbViaAspectRatio


def test_via_within_10_to_1_passes():
    """1.6 mm board = 63 mil. 12 mil hole → 5.25:1, well under 10:1."""
    client = MockMCPClient(pcb_primitives={"via": [
        {"primitiveId": "v1", "net": "GND", "holeDiameter": 12},
    ]})
    assert run_check(PcbViaAspectRatio, client) == []


def test_via_over_10_to_1_flagged():
    """1.6 mm = 63 mil; hole 5 mil → 12.6:1, fails."""
    client = MockMCPClient(pcb_primitives={"via": [
        {"primitiveId": "v1", "net": "GND", "holeDiameter": 5},
    ]})
    findings = run_check(PcbViaAspectRatio, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"
    assert "10:1" in findings[0]["message"]


def test_thicker_board_changes_threshold():
    """2.4 mm board = 94 mil; hole 12 mil → 7.9:1, still passes."""
    client = MockMCPClient(pcb_primitives={"via": [
        {"primitiveId": "v1", "net": "GND", "holeDiameter": 12},
    ]})
    assert run_check(PcbViaAspectRatio, client, {"board_thickness_mm": 2.4}) == []


def test_via_missing_hole_diameter_ignored():
    client = MockMCPClient(pcb_primitives={"via": [
        {"primitiveId": "v1", "net": "GND"},
    ]})
    assert run_check(PcbViaAspectRatio, client) == []
