from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_10_testpoints import PcbTestpoints


def test_no_testpoints_emits_info():
    client = MockMCPClient(pcb_primitives={"component": [
        {"designator": "U1"}, {"designator": "R2"},
    ]})
    findings = run_check(PcbTestpoints, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert "No testpoints" in findings[0]["message"]


def test_testpoints_present_emits_info_listing_them():
    client = MockMCPClient(pcb_primitives={"component": [
        {"designator": "TP1"}, {"designator": "TP2"}, {"designator": "U1"},
    ]})
    findings = run_check(PcbTestpoints, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert "2 testpoint" in findings[0]["message"]
    assert set(findings[0]["offending_ids"]) == {"TP1", "TP2"}
