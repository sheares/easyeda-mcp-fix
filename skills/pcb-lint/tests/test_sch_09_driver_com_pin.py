from __future__ import annotations

from conftest import MockMCPClient, run_check
from checks.sch_09_driver_com_pin import SchDriverComPin


def _driver_client(*, driver_name: str, com_net: str | None):
    """Build a mock schematic with one driver whose COM pin ties to com_net.
    com_net=None simulates a floating COM (no net entry).
    """
    components = [
        {"componentType": "part", "primitiveId": "u4p", "designator": "U4", "name": driver_name},
    ]
    pins = {"1": {"name": "IN1", "net": "MOTOR_A"}}
    if com_net is not None:
        pins["9"] = {"name": "COM", "net": com_net}
    else:
        pins["9"] = {"name": "COM", "net": ""}
    connectivity = {
        "nets": {},
        "components": {"U4": {"part": driver_name, "pins": pins}},
    }
    return MockMCPClient(components=components, connectivity=connectivity)


def test_passes_uln2003_com_on_vmotor():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="ULN2003", com_net="VMOTOR"))
    assert findings == [], findings


def test_passes_tpl7407_com_on_12v():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="TPL7407L", com_net="+12V"))
    assert findings == [], findings


def test_errors_when_com_floating():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="ULN2003", com_net=None))
    assert any(f["severity"] == "error" and "FLOATING" in f["message"] for f in findings)


def test_errors_when_com_tied_to_gnd():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="ULN2003", com_net="GND"))
    assert any(f["severity"] == "error" and "GND" in f["message"] for f in findings)


def test_errors_when_com_on_3v3_rail():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="ULN2003", com_net="+3V3"))
    assert any(f["severity"] == "error" and "low-voltage" in f["message"] for f in findings)


def test_info_when_com_on_unrecognised_rail():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="ULN2003", com_net="POWER_DRIVER_RAIL"))
    assert any(f["severity"] == "info" for f in findings)


def test_no_findings_when_no_driver_present():
    components = [{"componentType": "part", "primitiveId": "u1p", "designator": "U1", "name": "ESP32-C3"}]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchDriverComPin, client) == []


def test_matches_tpl7407l_family_variant():
    findings = run_check(SchDriverComPin, _driver_client(driver_name="TPL7407LAPWR", com_net=None))
    assert any(f["severity"] == "error" for f in findings)
