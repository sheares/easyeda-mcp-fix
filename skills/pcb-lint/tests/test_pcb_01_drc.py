from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_01_drc import PcbDrc


def test_pcb_drc_passes_when_clean():
    assert run_check(PcbDrc, MockMCPClient(pcb_drc=[])) == []


def test_pcb_drc_flags_violations():
    client = MockMCPClient(pcb_drc=[
        {"message": "clearance violation", "location": "10,20"},
        {"message": "short circuit", "id": "sh1"},
    ])
    findings = run_check(PcbDrc, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"
    assert "2 violation" in findings[0]["message"]
