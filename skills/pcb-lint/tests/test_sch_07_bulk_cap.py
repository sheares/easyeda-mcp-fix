from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_07_bulk_cap import SchBulkCap, _parse_uf


def test_value_parser_handles_common_forms():
    assert _parse_uf("100nF") == 0.1
    assert _parse_uf("10uF") == 10.0
    assert _parse_uf("10µF") == 10.0
    assert _parse_uf("47uF") == 47.0
    assert _parse_uf("1mF") == 1000.0
    assert _parse_uf("0.1uF") == 0.1
    assert _parse_uf("garbage") is None


def test_value_parser_rejects_bare_numbers():
    assert _parse_uf("10") is None
    assert _parse_uf("") is None


def _buck_client(*, bulk_cap_value: str | None):
    """Model: MP1584 buck (U1) → L1 → +3V3.
    If bulk_cap_value is given, C7 on +3V3 has that value.
    """
    components = [
        {"componentType": "part", "primitiveId": "u1p", "designator": "U1",
         "name": "MP1584EN-LF-Z-JSM", "otherProperty": {"Topology": "Buck"}},
        {"componentType": "part", "primitiveId": "l1p", "designator": "L1", "name": "10uH"},
    ]
    net_entries_on_3v3 = ["L1.1(1)"]
    if bulk_cap_value is not None:
        components.append({
            "componentType": "part", "primitiveId": "c7p", "designator": "C7",
            "name": bulk_cap_value, "otherProperty": {"Value": bulk_cap_value},
        })
        net_entries_on_3v3.append("C7.2(2)")

    connectivity = {
        "nets": {
            "SW": ["U1.1(SW)", "L1.2(2)"],
            "+3V3": net_entries_on_3v3,
        },
        "components": {
            "U1": {"pins": {"1": {"name": "SW", "net": "SW"}}},
            "L1": {"pins": {
                "1": {"name": "1", "net": "+3V3"},
                "2": {"name": "2", "net": "SW"},
            }},
        },
    }
    return MockMCPClient(components=components, connectivity=connectivity)


def test_passes_when_buck_output_has_bulk_cap():
    """Switching regulator: SW → L → OUT; bulk cap on OUT must be detected."""
    assert run_check(SchBulkCap, _buck_client(bulk_cap_value="10uF")) == []


def test_flags_buck_output_with_no_bulk_cap():
    findings = run_check(SchBulkCap, _buck_client(bulk_cap_value=None))
    warn = [f for f in findings if f["severity"] == "warn"]
    assert len(warn) == 1
    assert "U1" in warn[0]["offending_ids"][0]


def test_small_cap_alone_does_not_satisfy_bulk():
    findings = run_check(SchBulkCap, _buck_client(bulk_cap_value="100nF"))
    assert any(f["severity"] == "warn" for f in findings)


def test_ldo_with_direct_vout_pin():
    """LDO with a named VOUT pin: no SW-trace needed."""
    components = [
        {"componentType": "part", "primitiveId": "u1p", "designator": "U1",
         "name": "AMS1117-3.3", "otherProperty": {"Topology": "LDO"}},
        {"componentType": "part", "primitiveId": "c1p", "designator": "C1",
         "name": "22uF", "otherProperty": {"Value": "22uF"}},
    ]
    connectivity = {
        "nets": {"+3V3": ["U1.2(VOUT)", "C1.2(2)"]},
        "components": {"U1": {"pins": {"2": {"name": "VOUT", "net": "+3V3"}}}},
    }
    client = MockMCPClient(components=components, connectivity=connectivity)
    assert run_check(SchBulkCap, client) == []


def test_ignores_non_regulator_ics():
    components = [{"componentType": "part", "primitiveId": "u1p", "designator": "U1",
                   "name": "TPL7407"}]
    client = MockMCPClient(components=components, connectivity={"nets": {}, "components": {}})
    assert run_check(SchBulkCap, client) == []
