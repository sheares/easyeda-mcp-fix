from __future__ import annotations

from conftest import MockMCPClient, run_check
from checks.sch_10_usbc_cc_resistors import SchUsbcCCResistors


def _usbc_client(
    *,
    r_cc1: str | None = "5.1k",
    r_cc2: str | None = "5.1k",
    shared_resistor: bool = False,
):
    """One USB-C receptacle CN2 with configurable CC pull-down setup.

    r_cc1 / r_cc2:
      - "5.1k" (or similar) → separate resistor of that value to GND
      - None → no resistor at all on that CC pin
    shared_resistor: if True, both CC1 and CC2 share the SAME resistor.
    """
    components = [
        {"componentType": "part", "primitiveId": "cn2p", "designator": "CN2",
         "name": "USB-C 16-pin receptacle", "otherProperty": {"Footprint": "USB-C-16"}},
    ]
    connectivity_nets: dict[str, list[str]] = {"GND": ["CN2.gnd(GND)"]}
    connectivity_comps: dict[str, dict] = {
        "CN2": {"part": "USB-C", "pins": {}},
    }

    def _add_resistor(desig: str, value: str, cc_net: str) -> None:
        components.append({
            "componentType": "part",
            "primitiveId": f"{desig.lower()}p",
            "designator": desig,
            "name": value,
            "otherProperty": {"Value": value},
        })
        connectivity_nets.setdefault(cc_net, []).append(f"{desig}.1({desig})")
        connectivity_nets["GND"].append(f"{desig}.2(GND)")
        connectivity_comps[desig] = {"part": value, "pins": {
            "1": {"name": "1", "net": cc_net},
            "2": {"name": "2", "net": "GND"},
        }}

    if shared_resistor:
        # Single resistor spans CC1 and CC2 (a common mistake)
        components.append({
            "componentType": "part",
            "primitiveId": "r99p",
            "designator": "R99",
            "name": r_cc1 or "5.1k",
            "otherProperty": {"Value": r_cc1 or "5.1k"},
        })
        connectivity_nets["CC1"] = ["CN2.1(CC1)", "R99.1(1)"]
        connectivity_nets["CC2"] = ["CN2.2(CC2)", "R99.2(2)"]
        connectivity_comps["R99"] = {"part": r_cc1, "pins": {
            "1": {"name": "1", "net": "CC1"},
            "2": {"name": "2", "net": "CC2"},
        }}
        connectivity_comps["CN2"]["pins"]["1"] = {"name": "CC1", "net": "CC1"}
        connectivity_comps["CN2"]["pins"]["2"] = {"name": "CC2", "net": "CC2"}
        # Also give the shared resistor to GND (via a third net?) — actually
        # the failure mode is exactly that neither pin is Rd to GND. So
        # DON'T add GND pins here.
        return MockMCPClient(components=components, connectivity={
            "nets": connectivity_nets, "components": connectivity_comps,
        })

    # Independent path
    if r_cc1 is not None:
        _add_resistor("R11", r_cc1, "CC1")
    if r_cc2 is not None:
        _add_resistor("R12", r_cc2, "CC2")
    connectivity_comps["CN2"]["pins"]["1"] = {"name": "CC1", "net": "CC1" if r_cc1 is not None else ""}
    connectivity_comps["CN2"]["pins"]["2"] = {"name": "CC2", "net": "CC2" if r_cc2 is not None else ""}
    if r_cc1 is None:
        connectivity_nets.setdefault("CC1", [])
    if r_cc2 is None:
        connectivity_nets.setdefault("CC2", [])
    return MockMCPClient(components=components, connectivity={
        "nets": connectivity_nets, "components": connectivity_comps,
    })


def test_passes_with_separate_5k1_resistors_on_each_cc():
    assert run_check(SchUsbcCCResistors, _usbc_client()) == []


def test_errors_when_cc1_has_no_pulldown():
    findings = run_check(SchUsbcCCResistors, _usbc_client(r_cc1=None, r_cc2="5.1k"))
    assert any(f["severity"] == "error" and "CC1" in f["message"] for f in findings)


def test_errors_when_cc2_has_no_pulldown():
    findings = run_check(SchUsbcCCResistors, _usbc_client(r_cc1="5.1k", r_cc2=None))
    assert any(f["severity"] == "error" and "CC2" in f["message"] for f in findings)


def test_errors_when_both_cc_pins_share_resistor():
    findings = run_check(SchUsbcCCResistors, _usbc_client(shared_resistor=True))
    # Shared resistor fails to be Rd on either pin (no GND on the net), so
    # it triggers the "no Rd" errors first; but the shared-resistor detector
    # also fires when both pins have the same "candidate" resistor.
    # Either failure mode is acceptable — the important thing is that this
    # topology is REJECTED (never silently passes).
    assert len(findings) > 0
    assert all(f["severity"] in {"error", "warn"} for f in findings)


def test_warns_when_pulldown_is_wrong_value():
    findings = run_check(SchUsbcCCResistors, _usbc_client(r_cc1="10k", r_cc2="10k"))
    assert any(f["severity"] == "warn" and "should be 5.1kΩ" in f["message"] for f in findings)


def test_no_findings_when_no_usbc_connector_present():
    components = [
        {"componentType": "part", "primitiveId": "cn1p", "designator": "CN1", "name": "USB-A"},
    ]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchUsbcCCResistors, client) == []


def test_matches_typec_footprint_naming():
    components = [
        {"componentType": "part", "primitiveId": "cn2p", "designator": "CN2",
         "name": "connector", "otherProperty": {"Footprint": "TYPEC-16P"}},
        {"componentType": "part", "primitiveId": "r1p", "designator": "R1", "name": "5.1k",
         "otherProperty": {"Value": "5.1k"}},
        {"componentType": "part", "primitiveId": "r2p", "designator": "R2", "name": "5.1k",
         "otherProperty": {"Value": "5.1k"}},
    ]
    connectivity = {
        "nets": {
            "CC1": ["CN2.1(CC1)", "R1.1(1)"],
            "CC2": ["CN2.2(CC2)", "R2.1(1)"],
            "GND": ["CN2.gnd(GND)", "R1.2(2)", "R2.2(2)"],
        },
        "components": {
            "CN2": {"part": "USB-C", "pins": {
                "1": {"name": "CC1", "net": "CC1"},
                "2": {"name": "CC2", "net": "CC2"},
            }},
            "R1": {"part": "5.1k", "pins": {
                "1": {"name": "1", "net": "CC1"},
                "2": {"name": "2", "net": "GND"},
            }},
            "R2": {"part": "5.1k", "pins": {
                "1": {"name": "1", "net": "CC2"},
                "2": {"name": "2", "net": "GND"},
            }},
        },
    }
    client = MockMCPClient(components=components, connectivity=connectivity)
    assert run_check(SchUsbcCCResistors, client) == []
