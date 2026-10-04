from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_11_fiducials import PcbFiducials


def test_no_fiducials_emits_info():
    client = MockMCPClient(pcb_primitives={"component": [{"designator": "U1"}]})
    findings = run_check(PcbFiducials, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert "No fiducials" in findings[0]["message"]


def test_fiducials_present_lists_them():
    client = MockMCPClient(pcb_primitives={"component": [
        {"designator": "FID1"}, {"designator": "FID2"}, {"designator": "FID3"},
    ]})
    findings = run_check(PcbFiducials, client)
    assert len(findings) == 1
    assert "3 fiducial" in findings[0]["message"]
