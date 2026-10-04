from __future__ import annotations

import pytest
from conftest import MockMCPClient, run_check

from checks.sch_08_regulator_vout import SchRegulatorVout, parse_resistance_ohms


# ---------- parse_resistance_ohms ----------

@pytest.mark.parametrize("s,expected", [
    ("10k", 10_000.0),
    ("68k", 68_000.0),
    ("15k", 15_000.0),
    ("4.7k", 4_700.0),
    ("1M", 1_000_000.0),
    ("100R", 100.0),
    ("100", 100.0),
    ("1.5k", 1_500.0),
])
def test_parses_valid_resistance(s, expected):
    assert parse_resistance_ohms(s) == expected


@pytest.mark.parametrize("s", ["", "n/a", "10 ohms 5%", "abc", "??"])
def test_returns_none_on_unparseable(s):
    assert parse_resistance_ohms(s) is None


# ---------- SCH-08 end-to-end ----------
#
# Fixture design note (2026-07-23, post-live-dogfood):
# The original `_splitflap_v2_board1_client` fixture gave MP1584 a fake VOUT
# pin (pin 7). Real MP1584 has NO output pin — its pinout is
# SW/EN/COMP/FB/GND/RT/VIN/BST and the output sits post-inductor from SW.
# The old fixture passed against a broken check that couldn't find the
# output net on switching bucks; dogfooding SCH-08 against the live Board1
# schematic exposed this and forced a fixture rewrite. The current fixture
# below models MP1584 pin-accurately including L1 between SW and +3V3.
#
# _ldo_client keeps the direct-VOUT-pin path (LDOs like AMS1117) covered.


def _splitflap_v2_board1_client(
    *,
    r_upper: str,
    r_lower: str,
    downstream_name: str = "ESP32-C3",
):
    """Reproduce the Splitflap-v2 Board1 topology faithfully:
    MP1584 buck (SW/FB/GND, no VOUT) → L1 → +3V3 → R_UP → FB → R_LO → GND;
    +3V3 also feeds U2 (ESP32-C3).
    """
    components = [
        {
            "componentType": "part",
            "primitiveId": "regp",
            "designator": "U1",
            "name": "MP1584",
            "otherProperty": {"Topology": "Buck"},
        },
        {
            "componentType": "part",
            "primitiveId": "l1p",
            "designator": "L1",
            "name": "10uH",
            "otherProperty": {"Value": "10uH"},
        },
        {
            "componentType": "part",
            "primitiveId": "rup",
            "designator": "R3",
            "name": r_upper,
            "otherProperty": {"Value": r_upper},
        },
        {
            "componentType": "part",
            "primitiveId": "rlo",
            "designator": "R4",
            "name": r_lower,
            "otherProperty": {"Value": r_lower},
        },
        {
            "componentType": "part",
            "primitiveId": "espp",
            "designator": "U2",
            "name": downstream_name,
        },
    ]
    connectivity = {
        "nets": {
            "SW":   ["U1.1(SW)", "L1.1(1)"],
            "FB":   ["U1.4(FB)", "R3.2(2)", "R4.2(2)"],
            "+3V3": ["L1.2(2)", "R3.1(1)", "U2.1(VDD)"],
            "GND":  ["U1.5(GND)", "R4.1(1)", "U2.9(GND)"],
            "VIN":  ["U1.7(VIN)"],
        },
        "components": {
            "U1": {"part": "MP1584", "pins": {
                "1": {"name": "SW",  "net": "SW"},
                "4": {"name": "FB",  "net": "FB"},
                "5": {"name": "GND", "net": "GND"},
                "7": {"name": "VIN", "net": "VIN"},
            }},
            "L1": {"part": "10uH", "pins": {
                "1": {"name": "1", "net": "SW"},
                "2": {"name": "2", "net": "+3V3"},
            }},
            "R3": {"part": r_upper, "pins": {
                "1": {"name": "1", "net": "+3V3"},
                "2": {"name": "2", "net": "FB"},
            }},
            "R4": {"part": r_lower, "pins": {
                "1": {"name": "1", "net": "GND"},
                "2": {"name": "2", "net": "FB"},
            }},
            "U2": {"part": downstream_name, "pins": {
                "1": {"name": "VDD", "net": "+3V3"},
                "9": {"name": "GND", "net": "GND"},
            }},
        },
    }
    return MockMCPClient(components=components, connectivity=connectivity)


def _ldo_client(*, r_upper: str, r_lower: str, downstream_name: str = "ESP32-C3"):
    """LDO with a direct VOUT pin (AMS1117 shape). Covers the non-switching
    code path in find_regulator_output_net so a future refactor can't
    silently regress it.
    """
    components = [
        {"componentType": "part", "primitiveId": "regp", "designator": "U1", "name": "AMS1117",
         "otherProperty": {"Topology": "LDO"}},
        {"componentType": "part", "primitiveId": "rup", "designator": "R3", "name": r_upper,
         "otherProperty": {"Value": r_upper}},
        {"componentType": "part", "primitiveId": "rlo", "designator": "R4", "name": r_lower,
         "otherProperty": {"Value": r_lower}},
        {"componentType": "part", "primitiveId": "espp", "designator": "U2", "name": downstream_name},
    ]
    connectivity = {
        "nets": {
            "FB":   ["U1.4(ADJ)", "R3.2(2)", "R4.2(2)"],
            "+3V3": ["U1.2(VOUT)", "R3.1(1)", "U2.1(VDD)"],
            "GND":  ["U1.1(GND)", "R4.1(1)", "U2.9(GND)"],
        },
        "components": {
            "U1": {"part": "AMS1117", "pins": {
                "1": {"name": "GND",  "net": "GND"},
                "2": {"name": "VOUT", "net": "+3V3"},
                "4": {"name": "ADJ",  "net": "FB"},
            }},
            "R3": {"part": r_upper, "pins": {
                "1": {"name": "1", "net": "+3V3"},
                "2": {"name": "2", "net": "FB"},
            }},
            "R4": {"part": r_lower, "pins": {
                "1": {"name": "1", "net": "GND"},
                "2": {"name": "2", "net": "FB"},
            }},
            "U2": {"part": downstream_name, "pins": {
                "1": {"name": "VDD", "net": "+3V3"},
                "9": {"name": "GND", "net": "GND"},
            }},
        },
    }
    return MockMCPClient(components=components, connectivity=connectivity)


def test_hard_errors_on_splitflap_v2_board1_incident():
    """The exact configuration that shipped on Board1 (2026-07-18 fab order):
    MP1584, R3=68k / R4=15k, ESP32-C3 downstream. Vout = 0.8 × (1 + 68/15)
    = 4.427V, above ESP32-C3 abs-max 3.6V. Regression test: this test would
    have failed against the pre-2026-07-23 SCH-08 (which only handled LDO-
    shape regulators with a direct VOUT pin).
    """
    client = _splitflap_v2_board1_client(r_upper="68k", r_lower="15k")
    findings = run_check(SchRegulatorVout, client)
    errors = [f for f in findings if f["severity"] == "error"]
    assert len(errors) == 1, findings
    assert "OVERVOLTAGE" in errors[0]["message"]
    assert "4.4" in errors[0]["message"] or "4.427" in errors[0]["message"]
    assert "ESP32-C3" in errors[0]["message"]


def test_switching_buck_output_traced_through_inductor():
    """Explicit coverage for the SW → inductor → output path. A broken
    find_regulator_output_net that only looked for a VOUT pin would emit
    an info here instead of the overvoltage error.
    """
    client = _splitflap_v2_board1_client(r_upper="68k", r_lower="15k")
    findings = run_check(SchRegulatorVout, client)
    infos = [f for f in findings if f["severity"] == "info"]
    for f in infos:
        assert "cannot identify FB and output pins" not in f["message"], (
            "SW → L1 → +3V3 trace should have found the output net; got info instead"
        )


def test_ldo_direct_vout_pin_still_works():
    """AMS1117-shape LDO with a real VOUT pin: 0.8V Vref × (1 + 68/15) = 4.43V,
    same abuse but through the direct-pin code path. Guards against a future
    refactor breaking the LDO case while fixing the switching-buck one.
    """
    client = _ldo_client(r_upper="68k", r_lower="15k")
    findings = run_check(SchRegulatorVout, client)
    # AMS1117 Vref in table = 1.25V, so Vout = 1.25 × (1 + 68/15) = 6.92V.
    # That's still overvoltage vs ESP32-C3 3.6V; check the error fires.
    errors = [f for f in findings if f["severity"] == "error"]
    assert len(errors) == 1, findings
    assert "OVERVOLTAGE" in errors[0]["message"]


def test_passes_on_correct_divider():
    """MP1584 with 100k/32k gives exactly Vout = 0.8 × (1 + 100/32) = 3.30V."""
    client = _splitflap_v2_board1_client(r_upper="100k", r_lower="32k")
    findings = run_check(SchRegulatorVout, client)
    errors = [f for f in findings if f["severity"] == "error"]
    warns = [f for f in findings if f["severity"] == "warn"]
    assert errors == [], f"expected no errors, got {errors}"
    assert warns == [], f"expected no warns, got {warns}"


def test_warns_on_deviation_over_10_percent_from_rail_intent():
    """Vout = 0.8 × (1 + 56/15) = 3.79V on +3V3 rail = +14.8% deviation.
    No downstream IC (to keep the abs-max check out of the way), so only
    the rail-intent deviation warn should fire.
    """
    components = [
        {"componentType": "part", "primitiveId": "regp", "designator": "U1", "name": "MP1584",
         "otherProperty": {"Topology": "Buck"}},
        {"componentType": "part", "primitiveId": "l1p", "designator": "L1", "name": "10uH",
         "otherProperty": {"Value": "10uH"}},
        {"componentType": "part", "primitiveId": "rup", "designator": "R3", "name": "56k",
         "otherProperty": {"Value": "56k"}},
        {"componentType": "part", "primitiveId": "rlo", "designator": "R4", "name": "15k",
         "otherProperty": {"Value": "15k"}},
    ]
    connectivity = {
        "nets": {
            "SW":   ["U1.1(SW)", "L1.1(1)"],
            "FB":   ["U1.4(FB)", "R3.2(2)", "R4.2(2)"],
            "+3V3": ["L1.2(2)", "R3.1(1)"],
            "GND":  ["U1.5(GND)", "R4.1(1)"],
        },
        "components": {
            "U1": {"part": "MP1584", "pins": {
                "1": {"name": "SW",  "net": "SW"},
                "4": {"name": "FB",  "net": "FB"},
                "5": {"name": "GND", "net": "GND"},
            }},
            "L1": {"part": "10uH", "pins": {
                "1": {"name": "1", "net": "SW"},
                "2": {"name": "2", "net": "+3V3"},
            }},
            "R3": {"part": "56k", "pins": {
                "1": {"name": "1", "net": "+3V3"},
                "2": {"name": "2", "net": "FB"},
            }},
            "R4": {"part": "15k", "pins": {
                "1": {"name": "1", "net": "GND"},
                "2": {"name": "2", "net": "FB"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=connectivity)
    findings = run_check(SchRegulatorVout, client)
    warns = [f for f in findings if f["severity"] == "warn"]
    assert len(warns) == 1, findings
    assert "deviates" in warns[0]["message"].lower()


def test_warns_when_regulator_not_in_vref_table():
    """An unknown adjustable regulator must warn, not silently pass."""
    components = [
        {"componentType": "part", "primitiveId": "regp", "designator": "U1", "name": "MysteryBuck",
         "otherProperty": {"Topology": "Buck"}},
    ]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    findings = run_check(SchRegulatorVout, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "warn"
    assert "Vref unknown" in findings[0]["message"]


def test_info_when_switching_buck_has_no_inductor_on_sw_node():
    """SW pin exists but no L* component sits on the SW net → SCH-08 emits
    info (can't identify output), not a spurious error."""
    components = [
        {"componentType": "part", "primitiveId": "regp", "designator": "U1", "name": "MP1584",
         "otherProperty": {"Topology": "Buck"}},
    ]
    connectivity = {
        "nets": {"SW": ["U1.1(SW)"], "FB": ["U1.4(FB)"], "GND": ["U1.5(GND)"]},
        "components": {
            "U1": {"part": "MP1584", "pins": {
                "1": {"name": "SW",  "net": "SW"},
                "4": {"name": "FB",  "net": "FB"},
                "5": {"name": "GND", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=connectivity)
    findings = run_check(SchRegulatorVout, client)
    infos = [f for f in findings if f["severity"] == "info"]
    assert len(infos) == 1, findings
    assert "cannot identify FB and output pins" in infos[0]["message"]
    assert "SW pin found" in infos[0]["message"] or "no inductor" in infos[0]["message"]


def test_no_findings_when_no_regulator_present():
    components = [{"componentType": "part", "primitiveId": "r1p", "designator": "R1", "name": "10k"}]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchRegulatorVout, client) == []


def test_info_when_downstream_ic_missing_from_absmax_table():
    """Regulator + FB divider parses correctly, Vout in range, downstream IC
    isn't in IC_ABS_MAX_SUPPLY_V. Emits info so the table can be extended.
    Uses the realistic switching-buck fixture.
    """
    components = [
        {"componentType": "part", "primitiveId": "regp", "designator": "U1", "name": "MP1584",
         "otherProperty": {"Topology": "Buck"}},
        {"componentType": "part", "primitiveId": "l1p", "designator": "L1", "name": "10uH",
         "otherProperty": {"Value": "10uH"}},
        {"componentType": "part", "primitiveId": "rup", "designator": "R3", "name": "100k",
         "otherProperty": {"Value": "100k"}},
        {"componentType": "part", "primitiveId": "rlo", "designator": "R4", "name": "32k",
         "otherProperty": {"Value": "32k"}},
        {"componentType": "part", "primitiveId": "expp", "designator": "U2", "name": "MysteryIC",
         "otherProperty": {"Value": "?"}},
    ]
    connectivity = {
        "nets": {
            "SW":   ["U1.1(SW)", "L1.1(1)"],
            "FB":   ["U1.4(FB)", "R3.2(2)", "R4.2(2)"],
            "+3V3": ["L1.2(2)", "R3.1(1)", "U2.1(VDD)"],
            "GND":  ["U1.5(GND)", "R4.1(1)", "U2.9(GND)"],
        },
        "components": {
            "U1": {"part": "MP1584", "pins": {
                "1": {"name": "SW",  "net": "SW"},
                "4": {"name": "FB",  "net": "FB"},
                "5": {"name": "GND", "net": "GND"},
            }},
            "L1": {"part": "10uH", "pins": {
                "1": {"name": "1", "net": "SW"},
                "2": {"name": "2", "net": "+3V3"},
            }},
            "R3": {"part": "100k", "pins": {
                "1": {"name": "1", "net": "+3V3"},
                "2": {"name": "2", "net": "FB"},
            }},
            "R4": {"part": "32k", "pins": {
                "1": {"name": "1", "net": "FB"},
                "2": {"name": "2", "net": "GND"},
            }},
            "U2": {"part": "MysteryIC", "pins": {
                "1": {"name": "VDD", "net": "+3V3"},
                "9": {"name": "GND", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=connectivity)
    findings = run_check(SchRegulatorVout, client)
    infos = [f for f in findings if f["severity"] == "info"]
    assert len(infos) == 1, findings
    assert "abs-max table" in infos[0]["message"]
