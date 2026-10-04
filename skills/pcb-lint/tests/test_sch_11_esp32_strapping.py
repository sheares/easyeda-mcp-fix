"""Tests for SCH-11: ESP32 strapping-pin conflict.

Test numbering aligns with the brief's coverage checklist:
 1. Bare ESP32-C3, no external components on strap nets → info only, no error/warn.
 2. ESP32-C3, GPIO9 hard-tied to GND via 0 Ω → error.
 3. ESP32-C3, GPIO8 pulled LOW via 10 kΩ → warn (correct range but wrong direction).
 4. ESP32-S3, GPIO45 hard-tied HIGH with assumed 3.3V flash → error.
 5. ESP32-S3, GPIO0 connected to UART transceiver output with no series R → error.
 6. ESP32-C3, GPIO9 pulled HIGH via 10 kΩ → pass (no error/warn).
 7. ESP32-C3, GPIO9 pulled HIGH via 100 Ω (too strong) → warn.
 8. No ESP32 on board → no findings.
 9a. Ambiguous name "MCU", manufacturerId "ESP32-C3-MINI-1U" → detects C3 via mfr.
 9b. Name "ESP32-C3-WROOM" (module) → detects C3 via name.
10. Splitflap-v2-Board1 style ESP32-C3 correctly strapped → no errors/warns.

Additional edge-case tests:
11. ESP32-S3, GPIO46 pulled LOW via 4.7 kΩ (matches internal pull-down) → pass.
12. Pull resistor with unparseable value → warn.
13. ESP32 classic variant detected via "ESP32-WROOM-32" module name.
"""

from __future__ import annotations

from conftest import MockMCPClient, run_check
from checks.sch_11_esp32_strapping import SchEsp32Strapping, _normalise_gpio


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _make_esp32_comp(
    *,
    desig: str = "U1",
    name: str = "ESP32-C3-MINI-1U",
    mfr_id: str = "",
) -> dict:
    return {
        "componentType": "part",
        "primitiveId": f"{desig.lower()}p",
        "designator": desig,
        "name": name,
        "manufacturerId": mfr_id,
        "otherProperty": {},
    }


def _make_resistor(
    *,
    desig: str,
    value: str,
    net_a: str,
    net_b: str,
) -> dict:
    return {
        "componentType": "part",
        "primitiveId": f"{desig.lower()}p",
        "designator": desig,
        "name": value,
        "otherProperty": {"Value": value},
    }


def _connectivity_with_pull(
    *,
    esp32_desig: str,
    gpio_pin_name: str,
    strap_net: str,
    pull_desig: str,
    pull_value: str,
    pull_to_net: str,
    extra_comps: list[dict] | None = None,
) -> dict:
    """Build connectivity where:
    - esp32_desig.gpio_pin_name → strap_net
    - pull_desig.1 → strap_net
    - pull_desig.2 → pull_to_net
    """
    nets = {
        strap_net: [
            f"{esp32_desig}.1({gpio_pin_name})",
            f"{pull_desig}.1(1)",
        ],
        pull_to_net: [
            f"{pull_desig}.2(2)",
        ],
    }
    components = {
        esp32_desig: {"part": "ESP32", "pins": {
            "1": {"name": gpio_pin_name, "net": strap_net},
        }},
        pull_desig: {"part": pull_value, "pins": {
            "1": {"name": "1", "net": strap_net},
            "2": {"name": "2", "net": pull_to_net},
        }},
    }
    return {"nets": nets, "components": components}


# ---------------------------------------------------------------------------
# Test 1 — Bare ESP32-C3 with only ESP32 on strap nets → info only (no error/warn)
# ---------------------------------------------------------------------------

def test_1_bare_c3_no_external_info_only():
    """Only ESP32-C3 on strap nets; no external component. Must not emit error or warn."""
    components = [_make_esp32_comp(name="ESP32-C3-MINI-1U")]
    conn = {
        "nets": {
            "GPIO9_NET": ["U1.9(GPIO9)"],
            "GPIO8_NET": ["U1.8(GPIO8)"],
            "GPIO2_NET": ["U1.2(GPIO2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "2":  {"name": "GPIO2", "net": "GPIO9_NET"},
                "8":  {"name": "GPIO8", "net": "GPIO8_NET"},
                "9":  {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors_warns = [f for f in findings if f["severity"] in ("error", "warn")]
    assert errors_warns == [], errors_warns


# ---------------------------------------------------------------------------
# Test 2 — ESP32-C3, GPIO9 hard-tied to GND via 0 Ω → error
# ---------------------------------------------------------------------------

def test_2_c3_gpio9_hard_tied_gnd_error():
    """GPIO9 tied to GND via 0 Ω should produce an error."""
    components = [
        _make_esp32_comp(name="ESP32-C3"),
        _make_resistor(desig="R1", value="0R", net_a="GPIO9_NET", net_b="GND"),
    ]
    conn = {
        "nets": {
            "GPIO9_NET": ["U1.9(GPIO9)", "R1.1(1)"],
            "GND":       ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
            "R1": {"part": "0R", "pins": {
                "1": {"name": "1", "net": "GPIO9_NET"},
                "2": {"name": "2", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO9" in f["message"]]
    assert errors, f"Expected error for GPIO9 hard-tied GND, got: {findings}"


# ---------------------------------------------------------------------------
# Test 3 — ESP32-C3, GPIO8 pulled LOW via 10 kΩ → warn (correct range, wrong direction)
# GPIO8 requires HIGH; pull to GND is wrong direction.
# Semantic call: this is a warn (not error) because the pull is a valid value,
# just pointing the wrong way — a design intent issue, not a hard short.
# ---------------------------------------------------------------------------

def test_3_c3_gpio8_pulled_low_wrong_direction_warn():
    """GPIO8 needs HIGH; 10 kΩ to GND pulls LOW → warn (wrong direction, good value)."""
    components = [
        _make_esp32_comp(name="ESP32-C3"),
        _make_resistor(desig="R1", value="10k", net_a="GPIO8_NET", net_b="GND"),
    ]
    conn = {
        "nets": {
            "GPIO8_NET": ["U1.8(GPIO8)", "R1.1(1)"],
            "GND":       ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "8": {"name": "GPIO8", "net": "GPIO8_NET"},
            }},
            "R1": {"part": "10k", "pins": {
                "1": {"name": "1", "net": "GPIO8_NET"},
                "2": {"name": "2", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    warns = [f for f in findings if f["severity"] == "warn" and "GPIO8" in f["message"]]
    assert warns, f"Expected warn for GPIO8 pulled LOW (wrong direction), got: {findings}"
    # Must NOT be an error (that's reserved for hard ties and IC-output conflicts)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO8" in f["message"]]
    assert not errors, f"Should be warn not error: {errors}"


# ---------------------------------------------------------------------------
# Test 4 — ESP32-S3, GPIO45 hard-tied HIGH (VCC) → error (brick risk)
# GPIO45 is VDD_SPI voltage select: LOW = 3.3V (safe), HIGH = 1.8V (bricks 3.3V flash).
# ---------------------------------------------------------------------------

def test_4_s3_gpio45_hard_tied_high_error():
    """GPIO45 hard-tied HIGH (VCC) on ESP32-S3 → error (brick risk, wrong level)."""
    components = [
        _make_esp32_comp(name="ESP32-S3-WROOM-1"),
        _make_resistor(desig="R1", value="0R", net_a="GPIO45_NET", net_b="VCC"),
    ]
    conn = {
        "nets": {
            "GPIO45_NET": ["U1.45(GPIO45)", "R1.1(1)"],
            "VCC":        ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "45": {"name": "GPIO45", "net": "GPIO45_NET"},
            }},
            "R1": {"part": "0R", "pins": {
                "1": {"name": "1", "net": "GPIO45_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO45" in f["message"]]
    assert errors, f"Expected error for GPIO45 hard-tied VCC (brick risk), got: {findings}"


# ---------------------------------------------------------------------------
# Test 5 — ESP32-S3, GPIO0 connected to UART transceiver output without series R → error
# ---------------------------------------------------------------------------

def test_5_s3_gpio0_ic_output_no_series_r_error():
    """IC output (U2) on GPIO0 strap net with no series resistor → error."""
    components = [
        _make_esp32_comp(name="ESP32-S3", desig="U1"),
        {
            "componentType": "part",
            "primitiveId": "u2p",
            "designator": "U2",
            "name": "MAX3232",
            "otherProperty": {},
        },
    ]
    conn = {
        "nets": {
            "GPIO0_NET": ["U1.1(GPIO0)", "U2.14(T1OUT)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "1": {"name": "GPIO0", "net": "GPIO0_NET"},
            }},
            "U2": {"part": "MAX3232", "pins": {
                "14": {"name": "T1OUT", "net": "GPIO0_NET"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO0" in f["message"]]
    assert errors, f"Expected error for GPIO0 driven by IC output without series R, got: {findings}"


# ---------------------------------------------------------------------------
# Test 6 — ESP32-C3, GPIO9 pulled HIGH via 10 kΩ → pass (no error/warn)
# GPIO9 requires HIGH; 10 kΩ to VCC is correct direction and in range.
# ---------------------------------------------------------------------------

def test_6_c3_gpio9_pulled_high_10k_pass():
    """GPIO9 pulled HIGH via 10 kΩ → no errors or warns."""
    components = [
        _make_esp32_comp(name="ESP32-C3"),
        _make_resistor(desig="R1", value="10k", net_a="GPIO9_NET", net_b="VCC"),
    ]
    conn = {
        "nets": {
            "GPIO9_NET": ["U1.9(GPIO9)", "R1.1(1)"],
            "VCC":       ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
            "R1": {"part": "10k", "pins": {
                "1": {"name": "1", "net": "GPIO9_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    bad = [f for f in findings if f["severity"] in ("error", "warn") and "GPIO9" in f["message"]]
    assert not bad, f"Expected clean pass for GPIO9 pulled HIGH via 10k, got: {bad}"


# ---------------------------------------------------------------------------
# Test 7 — ESP32-C3, GPIO9 pulled HIGH via 100 Ω (too strong) → warn
# ---------------------------------------------------------------------------

def test_7_c3_gpio9_pull_too_strong_warn():
    """GPIO9 pulled HIGH via 100 Ω (below 1 kΩ minimum) → warn."""
    components = [
        _make_esp32_comp(name="ESP32-C3"),
        _make_resistor(desig="R1", value="100R", net_a="GPIO9_NET", net_b="VCC"),
    ]
    conn = {
        "nets": {
            "GPIO9_NET": ["U1.9(GPIO9)", "R1.1(1)"],
            "VCC":       ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
            "R1": {"part": "100R", "pins": {
                "1": {"name": "1", "net": "GPIO9_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    warns = [f for f in findings if f["severity"] == "warn" and "GPIO9" in f["message"]]
    assert warns, f"Expected warn for 100 Ω pull (too strong), got: {findings}"


# ---------------------------------------------------------------------------
# Test 8 — No ESP32 on board → no findings
# ---------------------------------------------------------------------------

def test_8_no_esp32_no_findings():
    """Board with only passives and a non-ESP MCU → no SCH-11 findings."""
    components = [
        {"componentType": "part", "primitiveId": "u1p", "designator": "U1",
         "name": "STM32F103C8T6", "otherProperty": {}},
        {"componentType": "part", "primitiveId": "r1p", "designator": "R1",
         "name": "10k", "otherProperty": {"Value": "10k"}},
    ]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchEsp32Strapping, client) == []


# ---------------------------------------------------------------------------
# Test 9a — Ambiguous name "MCU", manufacturerId "ESP32-C3-MINI-1U" → detects C3
# ---------------------------------------------------------------------------

def test_9a_detects_variant_via_manufacturer_id():
    """Component named 'MCU' but manufacturerId is ESP32-C3 → must identify as C3."""
    components = [{
        "componentType": "part",
        "primitiveId": "u1p",
        "designator": "U1",
        "name": "MCU",
        "manufacturerId": "ESP32-C3-MINI-1U",
        "otherProperty": {},
    }]
    conn = {
        "nets": {"GPIO9_NET": ["U1.9(GPIO9)"]},
        "components": {
            "U1": {"part": "MCU", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    # Should produce findings (at least info) for GPIO9, not a variant-unknown warn
    unknown_warns = [f for f in findings if "variant could not be determined" in f["message"]]
    assert not unknown_warns, f"Should have detected C3 via manufacturerId: {findings}"
    c3_findings = [f for f in findings if "C3" in f["message"]]
    assert c3_findings, f"Expected findings mentioning C3 variant: {findings}"


# ---------------------------------------------------------------------------
# Test 9b — Module name "ESP32-C3-WROOM" → detects C3
# ---------------------------------------------------------------------------

def test_9b_detects_variant_via_module_name():
    """ESP32-C3-WROOM module name → must be detected as C3 variant."""
    components = [_make_esp32_comp(name="ESP32-C3-WROOM-02")]
    conn = {
        "nets": {"GPIO9_NET": ["U1.9(GPIO9)"]},
        "components": {
            "U1": {"part": "ESP32-C3-WROOM-02", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    c3_findings = [f for f in findings if "C3" in f["message"]]
    assert c3_findings, f"Expected C3 findings for ESP32-C3-WROOM-02: {findings}"


# ---------------------------------------------------------------------------
# Test 10 — Splitflap-v2-Board1 style: ESP32-C3, GPIO9 pulled HIGH 10 kΩ,
#           GPIO8 unconnected (internal pull applies), GPIO2 unconnected.
#           → must pass clean (no errors or warns)
# ---------------------------------------------------------------------------

def test_10_splitflap_v2_board1_style_clean_pass():
    """Realistic Splitflap-v2 Board1 ESP32-C3 strapping setup → no errors or warns."""
    components = [
        _make_esp32_comp(name="ESP32-C3-MINI-1U"),
        _make_resistor(desig="R10", value="10k", net_a="EN_NET", net_b="VCC"),
        # GPIO9 pulled high via 10k (BOOT button path — when button is open, HIGH)
        _make_resistor(desig="R11", value="10k", net_a="GPIO9_NET", net_b="VCC"),
    ]
    conn = {
        "nets": {
            "GPIO9_NET": ["U1.9(GPIO9)", "R11.1(1)"],
            "VCC":       ["R11.2(2)", "R10.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3-MINI-1U", "pins": {
                # GPIO9 correctly pulled HIGH
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
                # GPIO8 and GPIO2 left NC (internal pull applies)
            }},
            "R11": {"part": "10k", "pins": {
                "1": {"name": "1", "net": "GPIO9_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    bad = [f for f in findings if f["severity"] in ("error", "warn")]
    assert not bad, f"Expected clean pass for Splitflap-v2-style board, got: {bad}"


# ---------------------------------------------------------------------------
# Test 11 — ESP32-S3, GPIO46 pulled LOW via 4.7 kΩ → pass
# GPIO46 internal pull is LOW; 4.7 kΩ to GND is correct direction and in range.
# ---------------------------------------------------------------------------

def test_11_s3_gpio46_pulled_low_correct_direction_pass():
    """GPIO46 (internal pull-down) pulled LOW via 4.7 kΩ → no error/warn."""
    components = [
        _make_esp32_comp(name="ESP32-S3", desig="U1"),
        _make_resistor(desig="R1", value="4.7k", net_a="GPIO46_NET", net_b="GND"),
    ]
    conn = {
        "nets": {
            "GPIO46_NET": ["U1.46(GPIO46)", "R1.1(1)"],
            "GND":        ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "46": {"name": "GPIO46", "net": "GPIO46_NET"},
            }},
            "R1": {"part": "4.7k", "pins": {
                "1": {"name": "1", "net": "GPIO46_NET"},
                "2": {"name": "2", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    bad = [f for f in findings if f["severity"] in ("error", "warn") and "GPIO46" in f["message"]]
    assert not bad, f"GPIO46 pulled LOW is correct direction, expected pass: {bad}"


# ---------------------------------------------------------------------------
# Test 12 — Pull resistor with unparseable value → warn
# ---------------------------------------------------------------------------

def test_12_unparseable_pull_resistor_value_warn():
    """A pull resistor whose value can't be parsed → warn to verify."""
    components = [
        _make_esp32_comp(name="ESP32-C3"),
        _make_resistor(desig="R1", value="TBD", net_a="GPIO9_NET", net_b="VCC"),
    ]
    conn = {
        "nets": {
            "GPIO9_NET": ["U1.9(GPIO9)", "R1.1(1)"],
            "VCC":       ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
            "R1": {"part": "TBD", "pins": {
                "1": {"name": "1", "net": "GPIO9_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    warns = [f for f in findings if f["severity"] == "warn" and "GPIO9" in f["message"]]
    assert warns, f"Expected warn for unparseable resistor value, got: {findings}"


# ---------------------------------------------------------------------------
# Test 13 — ESP32 classic module "ESP32-WROOM-32" → detected as classic variant
# ---------------------------------------------------------------------------

def test_13_classic_variant_via_wroom32_module_name():
    """ESP32-WROOM-32 module name → classic variant, GPIO12 strapping checked."""
    components = [
        _make_esp32_comp(name="ESP32-WROOM-32"),
    ]
    conn = {
        "nets": {
            "GPIO12_NET": ["U1.14(GPIO12)", "R1.1(1)"],
            "VCC":        ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-WROOM-32", "pins": {
                "14": {"name": "GPIO12", "net": "GPIO12_NET"},
            }},
            # Resistor pulling GPIO12 HIGH — this is brick risk on classic (needs LOW)
            "R1": {"part": "10k", "pins": {
                "1": {"name": "1", "net": "GPIO12_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    components.append(_make_resistor(desig="R1", value="10k", net_a="GPIO12_NET", net_b="VCC"))
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    # GPIO12 HIGH is wrong direction (needs LOW for 3.3V flash) → should warn
    gpio12_findings = [f for f in findings if "GPIO12" in f["message"]]
    assert gpio12_findings, f"Expected GPIO12 findings for classic variant: {findings}"


# ---------------------------------------------------------------------------
# Test 14 — S3 GPIO45 wired directly to +3V3 (sole member, no 0Ω R) → error + brick
# ---------------------------------------------------------------------------

def test_14_s3_gpio45_wired_to_plus3v3_direct_error():
    """GPIO45 net IS +3V3 (merged by schematic wire-to-symbol); only the ESP32 is on it.
    Canonical-name corroboration fires → error with BRICK language.
    """
    components = [_make_esp32_comp(name="ESP32-S3-WROOM-1")]
    # No external components on the +3V3 net — the pin is wired directly to the symbol.
    conn = {
        "nets": {
            "+3V3": ["U1.45(GPIO45)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "45": {"name": "GPIO45", "net": "+3V3"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO45" in f["message"]]
    assert errors, f"Expected error for GPIO45 wired to +3V3, got: {findings}"
    brick_findings = [f for f in errors if "BRICK" in f["message"].upper()]
    assert brick_findings, f"Expected BRICK language in error for GPIO45, got: {errors}"


# ---------------------------------------------------------------------------
# Test 15 — Classic GPIO12 on net '3V3' with decoupling cap C1 → error + brick
# ---------------------------------------------------------------------------

def test_15_classic_gpio12_on_3v3_net_with_cap_error():
    """Classic GPIO12 on a net named '3V3' that also has a cap C1.
    Cap corroborates the rail → error with BRICK language.
    """
    components = [
        _make_esp32_comp(name="ESP32-WROOM-32"),
        {
            "componentType": "part",
            "primitiveId": "c1p",
            "designator": "C1",
            "name": "100nF",
            "otherProperty": {"Value": "100nF"},
        },
    ]
    conn = {
        "nets": {
            "3V3": ["U1.14(GPIO12)", "C1.1(1)"],
            "GND": ["C1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-WROOM-32", "pins": {
                "14": {"name": "GPIO12", "net": "3V3"},
            }},
            "C1": {"part": "100nF", "pins": {
                "1": {"name": "1", "net": "3V3"},
                "2": {"name": "2", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO12" in f["message"]]
    assert errors, f"Expected error for GPIO12 on 3V3 rail with cap, got: {findings}"
    brick_findings = [f for f in errors if "BRICK" in f["message"].upper()]
    assert brick_findings, f"Expected BRICK language for GPIO12 brick-risk, got: {errors}"


# ---------------------------------------------------------------------------
# Test 16 — S3 GPIO45 on GND (correct LOW level) → no error or warn
# ---------------------------------------------------------------------------

def test_16_s3_gpio45_on_gnd_correct_level_pass():
    """GPIO45 net IS GND (correct LOW level for S3 VDD_SPI select) → no error/warn."""
    components = [_make_esp32_comp(name="ESP32-S3-WROOM-1")]
    conn = {
        "nets": {
            "GND": ["U1.45(GPIO45)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "45": {"name": "GPIO45", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    bad = [f for f in findings if f["severity"] in ("error", "warn") and "GPIO45" in f["message"]]
    assert not bad, f"GPIO45 on GND is the correct level (LOW) — expected pass, got: {bad}"


# ---------------------------------------------------------------------------
# Test 17 — Strap pin on divider midpoint 'VBUS_SENSE' with two resistors → warn (not error)
# ---------------------------------------------------------------------------

def test_17_strap_pin_on_divider_midpoint_name_only_warn():
    """A strap pin on net 'VBUS_SENSE' (two pull resistors, no canonical corroboration).
    Net name resembles a rail ('VBUS' prefix) but is NOT in the canonical set and has
    no cap or IC power pin → warn (FP guard), not error.
    """
    components = [
        _make_esp32_comp(name="ESP32-S3-WROOM-1"),
        _make_resistor(desig="R1", value="100k", net_a="VBUS_SENSE", net_b="VBUS"),
        _make_resistor(desig="R2", value="100k", net_a="VBUS_SENSE", net_b="GND"),
    ]
    conn = {
        "nets": {
            "VBUS_SENSE": ["U1.45(GPIO45)", "R1.1(1)", "R2.1(1)"],
            "VBUS": ["R1.2(2)"],
            "GND":  ["R2.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "45": {"name": "GPIO45", "net": "VBUS_SENSE"},
            }},
            "R1": {"part": "100k", "pins": {
                "1": {"name": "1", "net": "VBUS_SENSE"},
                "2": {"name": "2", "net": "VBUS"},
            }},
            "R2": {"part": "100k", "pins": {
                "1": {"name": "1", "net": "VBUS_SENSE"},
                "2": {"name": "2", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    # The net name looks like a rail (VBUS prefix) but is a divider midpoint → warn, not error
    gpio45_findings = [f for f in findings if "GPIO45" in f["message"]]
    assert gpio45_findings, f"Expected at least one finding for GPIO45 on VBUS_SENSE, got: {findings}"
    errors = [f for f in gpio45_findings if f["severity"] == "error"]
    assert not errors, f"Should be warn (not error) for unconfirmed rail name: {errors}"
    warns = [f for f in gpio45_findings if f["severity"] == "warn"]
    assert warns, f"Expected warn for VBUS_SENSE resembling a rail, got: {gpio45_findings}"


# ---------------------------------------------------------------------------
# Test 18 — Pin name with suffix: GPIO45/SPICS1_VDD_SPI, IO12/MTDI, GPIO12(VDD_SDIO)
# ---------------------------------------------------------------------------

def test_18a_s3_gpio45_slash_suffix_pin_name_error():
    """S3 GPIO45 symbol pin named 'GPIO45/SPICS1_VDD_SPI' tied to +3V3 → real strap fires."""
    components = [_make_esp32_comp(name="ESP32-S3-WROOM-1")]
    conn = {
        "nets": {
            "+3V3": ["U1.45(GPIO45/SPICS1_VDD_SPI)"],
        },
        "components": {
            "U1": {"part": "ESP32-S3", "pins": {
                "45": {"name": "GPIO45/SPICS1_VDD_SPI", "net": "+3V3"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO45" in f["message"]]
    assert errors, f"Expected error for GPIO45/SPICS1_VDD_SPI pin tied to +3V3: {findings}"


def test_18b_classic_gpio12_io12_prefix_pin_name_error():
    """Classic GPIO12 symbol pin named 'IO12/MTDI' tied to +3V3 → strap fires."""
    components = [_make_esp32_comp(name="ESP32-WROOM-32")]
    conn = {
        "nets": {
            "+3V3": ["U1.14(IO12/MTDI)"],
        },
        "components": {
            "U1": {"part": "ESP32-WROOM-32", "pins": {
                "14": {"name": "IO12/MTDI", "net": "+3V3"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO12" in f["message"]]
    assert errors, f"Expected error for IO12/MTDI pin tied to +3V3: {findings}"
    brick_findings = [f for f in errors if "BRICK" in f["message"].upper()]
    assert brick_findings, f"Expected BRICK language for GPIO12, got: {errors}"


def test_18c_classic_gpio12_parenthesis_suffix_pin_name_error():
    """Classic GPIO12 symbol pin named 'GPIO12(VDD_SDIO)' tied to +3V3 → strap fires."""
    components = [_make_esp32_comp(name="ESP32-WROOM-32")]
    conn = {
        "nets": {
            "+3V3": ["U1.14(GPIO12(VDD_SDIO))"],
        },
        "components": {
            "U1": {"part": "ESP32-WROOM-32", "pins": {
                "14": {"name": "GPIO12(VDD_SDIO)", "net": "+3V3"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    errors = [f for f in findings if f["severity"] == "error" and "GPIO12" in f["message"]]
    assert errors, f"Expected error for GPIO12(VDD_SDIO) pin tied to +3V3: {findings}"


# ---------------------------------------------------------------------------
# Test 19 — Regression: non-ESP32 IC pins OUT1, SPICS1, 3V3 → no phantom GPIO findings
# ---------------------------------------------------------------------------

def test_19_non_esp32_ic_pins_no_phantom_gpio_findings():
    """A non-ESP32 IC with pin names OUT1, SPICS1, 3V3 must not produce any GPIO findings.
    This is the lstrip regression: lstrip('GPIOIO') would strip O/G/P from these names
    and the old three-candidate loop could produce spurious GPIO hits.
    """
    components = [
        _make_esp32_comp(name="ESP32-C3-MINI-1U"),
        {
            "componentType": "part",
            "primitiveId": "u2p",
            "designator": "U2",
            "name": "SomeDriver",
            "otherProperty": {},
        },
    ]
    conn = {
        "nets": {
            "NET_OUT1":   ["U2.1(OUT1)"],
            "NET_SPICS1": ["U2.2(SPICS1)"],
            "3V3":        ["U2.3(3V3)"],
            # GPIO9 correctly pulled high — the only strap pin visible
            "GPIO9_NET":  ["U1.9(GPIO9)", "R1.1(1)"],
            "VCC":        ["R1.2(2)"],
        },
        "components": {
            "U1": {"part": "ESP32-C3", "pins": {
                "9": {"name": "GPIO9", "net": "GPIO9_NET"},
            }},
            "U2": {"part": "SomeDriver", "pins": {
                "1": {"name": "OUT1",   "net": "NET_OUT1"},
                "2": {"name": "SPICS1", "net": "NET_SPICS1"},
                "3": {"name": "3V3",    "net": "3V3"},
            }},
            "R1": {"part": "10k", "pins": {
                "1": {"name": "1", "net": "GPIO9_NET"},
                "2": {"name": "2", "net": "VCC"},
            }},
        },
    }
    components.append(_make_resistor(desig="R1", value="10k", net_a="GPIO9_NET", net_b="VCC"))
    client = MockMCPClient(components=components, connectivity=conn)
    findings = run_check(SchEsp32Strapping, client)
    # Must not produce errors or warns for OUT1 / SPICS1 / 3V3 phantom GPIO matching
    phantom = [
        f for f in findings
        if f["severity"] in ("error", "warn")
        and any(kw in f["message"] for kw in ("OUT1", "SPICS1", "PAD5"))
    ]
    assert not phantom, f"Phantom GPIO findings from non-GPIO pin names: {phantom}"
    # GPIO9 is correctly strapped → no error/warn for GPIO9 either
    gpio9_bad = [
        f for f in findings
        if f["severity"] in ("error", "warn") and "GPIO9" in f["message"]
    ]
    assert not gpio9_bad, f"Unexpected error/warn for correctly strapped GPIO9: {gpio9_bad}"


# ---------------------------------------------------------------------------
# Test 20 — Unit tests for _normalise_gpio
# ---------------------------------------------------------------------------

def test_20_normalise_gpio_table():
    """Table-driven unit tests for _normalise_gpio covering all documented cases."""
    cases: list[tuple[str, str | None]] = [
        # Standard forms
        ("GPIO2",                "GPIO2"),
        ("GPIO45",               "GPIO45"),
        ("IO2",                  "GPIO2"),
        ("IO12",                 "GPIO12"),
        # Delimiter variants
        ("GPIO_45",              "GPIO45"),
        ("GPIO-45",              "GPIO45"),
        ("IO_12",                "GPIO12"),
        # Slash-separated suffixes (real ESP32 symbols)
        ("GPIO45/SPICS1_VDD_SPI", "GPIO45"),
        ("IO12/MTDI",            "GPIO12"),
        # Parenthesis suffix
        ("GPIO12(VDD_SDIO)",     "GPIO12"),
        # Bare integer
        ("9",                    "GPIO9"),
        # Should NOT match
        ("OUT1",                 None),   # lstrip regression
        ("SPICS1",               None),   # lstrip regression
        ("PAD5",                 None),   # lstrip regression — no GPIO/IO prefix
        ("3V3",                  None),   # voltage rail, not a GPIO
        ("SD_DATA_1",            None),   # non-GPIO signal name
        ("VCC",                  None),   # power net name
        # Ambiguous (multiple GPIOs in one name) → None
        ("GPIO12/GPIO13",        None),   # two bare GPIO tokens → ambiguous
        # GPIO12/GPIO13_DUAL: GPIO13_DUAL has a non-numeric suffix so only GPIO12 matches
        ("GPIO12/GPIO13_DUAL",   "GPIO12"),
    ]
    for name, expected in cases:
        result = _normalise_gpio(name)
        assert result == expected, (
            f"_normalise_gpio({name!r}): expected {expected!r}, got {result!r}"
        )
