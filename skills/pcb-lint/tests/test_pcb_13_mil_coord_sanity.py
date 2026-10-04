from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_13_mil_coord_sanity import PcbMilCoordSanity


def test_normal_coords_pass():
    client = MockMCPClient(pcb_primitives={
        "via": [{"primitiveId": "v1", "x": 1200, "y": 500}],
        "pad": [{"primitiveId": "p1", "x": 100, "y": 100}],
        "component": [{"primitiveId": "u1", "x": 800, "y": 400}],
    })
    assert run_check(PcbMilCoordSanity, client) == []


def test_mm_confusion_flagged():
    """A value >1e6 mil = 25+ metres, clearly a mm-treated-as-mil bug."""
    client = MockMCPClient(pcb_primitives={
        "via": [{"primitiveId": "v1", "x": 2000000, "y": 500}],
        "pad": [], "component": [],
    })
    findings = run_check(PcbMilCoordSanity, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
