from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_08_annular_ring import PcbAnnularRing


def _client(*, vias=(), pads=(), ipc_class=2):
    return MockMCPClient(
        pcb_primitives={"via": list(vias), "pad": list(pads)},
    ), {"class": ipc_class}


def test_class_2_via_at_5_mil_annular_passes():
    """6 mil pad, 4 mil drill → 1 mil annular = FAILS class 2 (5 mil min).
    But 24 mil pad / 14 mil drill = 5 mil annular = passes."""
    client, cfg = _client(vias=[{"primitiveId": "v1", "net": "GND",
                                  "diameter": 24, "holeDiameter": 14}])
    assert run_check(PcbAnnularRing, client, cfg) == []


def test_class_2_via_below_5_mil_annular_flags():
    client, cfg = _client(vias=[{"primitiveId": "v1", "net": "GND",
                                  "diameter": 16, "holeDiameter": 12}])  # ar=2
    findings = run_check(PcbAnnularRing, client, cfg)
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"


def test_class_3_via_at_5_mil_annular_flags():
    """5 mil annular passes class 2 but not class 3 (needs 6)."""
    client, cfg = _client(
        vias=[{"primitiveId": "v1", "net": "GND", "diameter": 24, "holeDiameter": 14}],
        ipc_class=3,
    )
    findings = run_check(PcbAnnularRing, client, cfg)
    assert len(findings) == 1


def test_tht_pad_annular_ring_derived_from_pad_and_hole():
    """Pad ELLIPSE 118 mil, hole 106 mil → ar = 6 mil (passes class 2)."""
    client, cfg = _client(pads=[{
        "primitiveId": "p1", "net": "GND", "metallization": True,
        "pad": ["ELLIPSE", 118, 118],
        "hole": ["ROUND", 106],
    }])
    assert run_check(PcbAnnularRing, client, cfg) == []


def test_smd_pad_skipped():
    """SMD pad has no hole, should be ignored."""
    client, cfg = _client(pads=[{
        "primitiveId": "p1", "net": "SIG", "metallization": True,
        "pad": ["RECT", 50, 30],
        "hole": None,
    }])
    assert run_check(PcbAnnularRing, client, cfg) == []


def test_non_plated_pad_skipped():
    """Mechanical (unplated) mounting hole shouldn't be checked."""
    client, cfg = _client(pads=[{
        "primitiveId": "p1", "net": "", "metallization": False,
        "pad": ["ELLIPSE", 20, 20],
        "hole": ["ROUND", 118],  # would fail if checked
    }])
    assert run_check(PcbAnnularRing, client, cfg) == []
