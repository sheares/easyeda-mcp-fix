from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_06_jlc_stock import SchJlcStock


def test_no_bom_no_finding():
    assert run_check(SchJlcStock, MockMCPClient(bom=[])) == []


def test_emits_info_listing_all_lcsc_codes():
    bom = [
        {"Designator": "U1", "Supplier Part": "C123456"},
        {"Designator": "C1", "Supplier Part": "C789"},
        {"Designator": "R1", "Supplier Part": "RES-10K-0603"},  # not an LCSC code
    ]
    findings = run_check(SchJlcStock, MockMCPClient(bom=bom))
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert set(findings[0]["offending_ids"]) == {"C123456", "C789"}
