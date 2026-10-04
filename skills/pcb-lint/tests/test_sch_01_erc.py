from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_01_erc import SchErc


def test_erc_passes_on_clean_drc():
    client = MockMCPClient(drc={"passed": True, "errors": []})
    assert run_check(SchErc, client) == []


def test_erc_flags_errors():
    client = MockMCPClient(drc={
        "passed": False,
        "errors": [
            {"message": "unconnected pin", "location": "U1.3"},
            {"message": "driver-driver conflict", "location": "SIG_OUT"},
        ],
    })
    findings = run_check(SchErc, client)
    assert len(findings) == 1
    f = findings[0]
    assert f["check_id"] == "SCH-01"
    assert f["severity"] == "error"
    assert "2 error" in f["message"]
    assert "U1.3" in f["offending_ids"]


def test_erc_surfaces_warnings_as_info_when_present():
    client = MockMCPClient(drc={
        "passed": True,
        "errors": [],
        "warnings": [{"message": "power flag missing", "location": "3V3"}],
    })
    findings = run_check(SchErc, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"


def test_erc_handles_missing_warnings_key():
    """Live fork builds may return {passed, errors} only with no warnings key."""
    client = MockMCPClient(drc={"passed": True, "errors": []})
    assert run_check(SchErc, client) == []
