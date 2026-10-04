from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_03_three_w_spacing import PcbThreeWSpacing


def _hs_config(nets):
    return {"high_speed_nets": nets}


def test_no_config_emits_info():
    findings = run_check(PcbThreeWSpacing, MockMCPClient())
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert "skipped" in findings[0]["message"]


def test_parallel_run_below_3w_flagged():
    """Two horizontal tracks 6-mil wide, y-offset 10 mil, overlap 200 mil = should flag (3W = 18 mil)."""
    tracks = [
        {"primitiveId": "hs", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 200, "endX": 400, "endY": 200},
        {"primitiveId": "other", "net": "GPIO_1", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 210, "endX": 400, "endY": 210},
    ]
    client = MockMCPClient(pcb_primitives={"track": tracks})
    findings = run_check(PcbThreeWSpacing, client, _hs_config(["USB_DP"]))
    warns = [f for f in findings if f["severity"] == "warn"]
    assert len(warns) == 1
    assert "USB_DP" in warns[0]["message"]
    assert "GPIO_1" in warns[0]["message"]


def test_parallel_run_at_3w_or_more_passes():
    """y-offset 20 mil >= 3 * 6 mil = 18 mil, passes."""
    tracks = [
        {"primitiveId": "hs", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 200, "endX": 400, "endY": 200},
        {"primitiveId": "other", "net": "GPIO_1", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 220, "endX": 400, "endY": 220},
    ]
    client = MockMCPClient(pcb_primitives={"track": tracks})
    findings = run_check(PcbThreeWSpacing, client, _hs_config(["USB_DP"]))
    warns = [f for f in findings if f["severity"] == "warn"]
    assert warns == []


def test_perpendicular_crossing_not_flagged():
    """H segment × V segment = 90° crossing, not parallel."""
    tracks = [
        {"primitiveId": "hs", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 200, "endX": 400, "endY": 200},
        {"primitiveId": "other", "net": "GPIO_1", "layer": 1, "lineWidth": 6,
         "startX": 250, "startY": 100, "endX": 250, "endY": 300},
    ]
    client = MockMCPClient(pcb_primitives={"track": tracks})
    assert run_check(PcbThreeWSpacing, client, _hs_config(["USB_DP"])) == []


def test_different_layer_not_flagged_in_mvp():
    """Different layer parallel runs are deferred to Phase 3.1."""
    tracks = [
        {"primitiveId": "hs", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 200, "endX": 400, "endY": 200},
        {"primitiveId": "other", "net": "GPIO_1", "layer": 2, "lineWidth": 6,
         "startX": 100, "startY": 210, "endX": 400, "endY": 210},
    ]
    client = MockMCPClient(pcb_primitives={"track": tracks})
    assert run_check(PcbThreeWSpacing, client, _hs_config(["USB_DP"])) == []


def test_short_overlap_not_flagged():
    """Overlap = 20 mil < 5 * 6 = 30 mil, not flagged."""
    tracks = [
        {"primitiveId": "hs", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 200, "endX": 120, "endY": 200},  # 20 mil long
        {"primitiveId": "other", "net": "GPIO_1", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 205, "endX": 120, "endY": 205},
    ]
    client = MockMCPClient(pcb_primitives={"track": tracks})
    assert run_check(PcbThreeWSpacing, client, _hs_config(["USB_DP"])) == []


def test_same_net_pair_not_flagged():
    """Two segments on the SAME net running parallel is normal (diff-pair, wide-net splits)."""
    tracks = [
        {"primitiveId": "hs1", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 200, "endX": 400, "endY": 200},
        {"primitiveId": "hs2", "net": "USB_DP", "layer": 1, "lineWidth": 6,
         "startX": 100, "startY": 210, "endX": 400, "endY": 210},
    ]
    client = MockMCPClient(pcb_primitives={"track": tracks})
    assert run_check(PcbThreeWSpacing, client, _hs_config(["USB_DP"])) == []
