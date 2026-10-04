from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_05_tvs_proximity import PcbTvsProximity
from checks.types import MM_TO_MIL


def _make(tvs_pos, conn_pos):
    sch_components = [
        {"componentType": "part", "designator": "U7", "name": "USBLC6-2SC6-MS"},
        {"componentType": "part", "designator": "CN2", "name": "TYPE-C-31-M-12"},
    ]
    conn = {
        "nets": {"USB_DP": ["U7.1(1)", "CN2.6(DP)"]},
        "components": {
            "U7": {"pins": {"1": {"name": "1", "net": "USB_DP"}}},
        },
    }
    pcb_components = [
        {"designator": "U7", "x": tvs_pos[0], "y": tvs_pos[1]},
        {"designator": "CN2", "x": conn_pos[0], "y": conn_pos[1]},
    ]
    return MockMCPClient(
        components=sch_components,
        connectivity=conn,
        pcb_primitives={"component": pcb_components},
    )


def test_tvs_within_10mm_passes():
    """5 mm = 197 mil apart."""
    client = _make((100, 100), (100, 297))
    assert run_check(PcbTvsProximity, client) == []


def test_tvs_over_10mm_flagged():
    """20 mm = 787 mil apart."""
    client = _make((100, 100), (100, 887))
    findings = run_check(PcbTvsProximity, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "warn"
    assert "U7" in findings[0]["message"] and "CN2" in findings[0]["message"]


def test_no_tvs_on_board_no_finding():
    client = MockMCPClient(components=[
        {"componentType": "part", "designator": "R1", "name": "10k"},
    ])
    assert run_check(PcbTvsProximity, client) == []
