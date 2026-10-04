from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.sch_05_bom_complete import SchBomComplete


def test_passes_when_every_line_has_lcsc_supplier():
    bom = [
        {"Designator": "U1", "Supplier": "LCSC", "Supplier Part": "C123456", "Manufacturer Part": "STM32"},
        {"Designator": "C1", "Supplier": "LCSC", "Supplier Part": "C789", "Manufacturer Part": "CL21A"},
    ]
    assert run_check(SchBomComplete, MockMCPClient(bom=bom)) == []


def test_flags_missing_supplier():
    bom = [
        {"Designator": "U1", "Supplier": "", "Supplier Part": "", "Manufacturer Part": "STM32F103"},
        {"Designator": "R1", "Supplier": "", "Supplier Part": ""},
    ]
    findings = run_check(SchBomComplete, MockMCPClient(bom=bom))
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"
    assert "U1" in findings[0]["offending_ids"]
    assert "R1" in findings[0]["offending_ids"]


def test_ignores_mechanical_designator_prefixes():
    bom = [
        {"Designator": "TP1", "Supplier": "", "Supplier Part": ""},
        {"Designator": "FID1,FID2,FID3", "Supplier": "", "Supplier Part": ""},
        {"Designator": "H1,H2,H3", "Supplier": "", "Supplier Part": ""},
    ]
    assert run_check(SchBomComplete, MockMCPClient(bom=bom)) == []


def test_accepts_bare_lcsc_code_in_supplier_part_column():
    """If Supplier Part is a C-number, Supplier field can be empty (legacy edits)."""
    bom = [{"Designator": "U1", "Supplier": "", "Supplier Part": "C123456"}]
    assert run_check(SchBomComplete, MockMCPClient(bom=bom)) == []
