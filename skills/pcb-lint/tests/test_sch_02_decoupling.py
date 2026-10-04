from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_02_decoupling import SchDecoupling


def _make_client(*, cap_on_3v3: bool):
    components = [
        {
            "componentType": "part",
            "primitiveId": "u1p",
            "designator": "U1",
            "name": "ESP32-C3",
        },
        {
            "componentType": "part",
            "primitiveId": "c1p",
            "designator": "C1",
            "name": "100nF",
            "otherProperty": {"Value": "100nF"},
        },
    ]
    net_entries = ["U1.1(3V3)"]
    if cap_on_3v3:
        net_entries.append("C1.2(2)")
    connectivity = {
        "nets": {"+3V3": net_entries, "GND": ["U1.9(GND)", "C1.1(1)"]},
        "components": {
            "U1": {"part": "ESP32", "pins": {
                "1": {"name": "3V3", "net": "+3V3"},
                "9": {"name": "GND", "net": "GND"},
            }},
        },
    }
    return MockMCPClient(components=components, connectivity=connectivity)


def test_passes_when_ic_has_cap_on_power_net():
    assert run_check(SchDecoupling, _make_client(cap_on_3v3=True)) == []


def test_flags_ic_with_no_decoupling_cap():
    findings = run_check(SchDecoupling, _make_client(cap_on_3v3=False))
    assert len(findings) == 1
    assert findings[0]["check_id"] == "SCH-02"
    assert findings[0]["severity"] == "warn"
    assert any("U1.1" in oid for oid in findings[0]["offending_ids"])


def test_ignores_jumpers_with_u_prefix():
    """U3-BOOT / U6-EN / U8-TXRX are Jumper2 headers, not ICs."""
    components = [
        {"componentType": "part", "primitiveId": "j1p", "designator": "U3-BOOT", "name": "Jumper2"},
    ]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchDecoupling, client) == []


def test_ignores_non_ic_designators():
    """A lone resistor should not trigger the check."""
    components = [{"componentType": "part", "primitiveId": "r1p", "designator": "R1", "name": "10k"}]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchDecoupling, client) == []
