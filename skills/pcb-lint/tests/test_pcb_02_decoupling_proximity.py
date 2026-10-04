from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_02_decoupling_proximity import PcbDecouplingProximity
from checks.types import MM_TO_MIL


def _make(ic_pos, cap_pos):
    """Build a mock with U1 (ic) + C1 (cap), both on +3V3, with given XY."""
    sch_components = [
        {"componentType": "part", "designator": "U1", "name": "STM32", "primitiveId": "u1"},
        {"componentType": "part", "designator": "C1", "name": "100nF",
         "otherProperty": {"Value": "100nF"}, "primitiveId": "c1"},
    ]
    conn = {
        "nets": {"+3V3": ["U1.1(VCC)", "C1.2(2)"]},
        "components": {"U1": {"pins": {"1": {"name": "VCC", "net": "+3V3"}}}},
    }
    pcb_components = [
        {"designator": "U1", "x": ic_pos[0], "y": ic_pos[1]},
        {"designator": "C1", "x": cap_pos[0], "y": cap_pos[1]},
    ]
    return MockMCPClient(
        components=sch_components,
        connectivity=conn,
        pcb_primitives={"component": pcb_components},
    )


def test_cap_within_2mm_passes():
    """1 mm apart (~39 mil) → within threshold."""
    client = _make((100, 100), (100, 139))
    assert run_check(PcbDecouplingProximity, client) == []


def test_cap_between_2_and_5mm_emits_info():
    """3 mm apart (~118 mil) → info, not warn."""
    client = _make((100, 100), (100, 218))
    findings = run_check(PcbDecouplingProximity, client)
    assert any(f["severity"] == "info" for f in findings)


def test_cap_over_5mm_emits_warn():
    """8 mm apart (~315 mil) → warn."""
    client = _make((100, 100), (100, 415))
    findings = run_check(PcbDecouplingProximity, client)
    assert any(f["severity"] == "warn" for f in findings)


def test_no_ics_no_finding():
    client = MockMCPClient(components=[], connectivity={"nets": {}, "components": {}})
    assert run_check(PcbDecouplingProximity, client) == []
