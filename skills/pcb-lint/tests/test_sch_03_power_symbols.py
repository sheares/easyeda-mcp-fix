from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_03_power_symbols import SchPowerSymbols


def test_passes_when_every_power_rail_has_multiple_pins():
    connectivity = {
        "nets": {
            "+3V3": ["U1.1(3V3)", "C1.2(2)", "R1.1(1)"],
            "+5V": ["U2.5(VBUS)", "C2.2(2)"],
            "I2C_SCL": ["U1.4(SCL)"],  # not a power rail, should be ignored
        },
        "components": {},
    }
    client = MockMCPClient(connectivity=connectivity)
    assert run_check(SchPowerSymbols, client) == []


def test_flags_power_rail_with_single_pin():
    connectivity = {
        "nets": {
            "+3V3": ["U1.1(3V3)", "C1.2(2)"],
            "+5V": ["CN2.5(VBUS)"],  # dangling: only one pin
        },
        "components": {},
    }
    findings = run_check(SchPowerSymbols, client=MockMCPClient(connectivity=connectivity))
    assert len(findings) == 1
    assert "+5V" in findings[0]["offending_ids"]


def test_ignores_non_power_nets_with_single_pin():
    """Signal nets with one pin (like unrouted GPIO) are outside this check."""
    connectivity = {"nets": {"GPIO_UNUSED": ["U1.7(IO7)"]}, "components": {}}
    client = MockMCPClient(connectivity=connectivity)
    assert run_check(SchPowerSymbols, client) == []
