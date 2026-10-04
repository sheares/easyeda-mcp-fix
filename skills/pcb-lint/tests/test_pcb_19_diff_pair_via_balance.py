from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_19_diff_pair_via_balance import PcbDiffPairViaBalance


def test_no_config_emits_info():
    findings = run_check(PcbDiffPairViaBalance, MockMCPClient())
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert "skipped" in findings[0]["message"]


def test_balanced_diff_pair_passes():
    vias = [
        {"primitiveId": "v1", "net": "USB_DP"}, {"primitiveId": "v2", "net": "USB_DP"},
        {"primitiveId": "v3", "net": "USB_DM"}, {"primitiveId": "v4", "net": "USB_DM"},
    ]
    client = MockMCPClient(pcb_primitives={"via": vias})
    findings = run_check(
        PcbDiffPairViaBalance, client,
        {"differential_pairs": [["USB_DP", "USB_DM"]]},
    )
    assert findings == []


def test_unbalanced_diff_pair_flagged():
    """2 vias on DP, 4 on DM — the actual Board1 finding."""
    vias = [
        {"primitiveId": "v1", "net": "USB_DP"}, {"primitiveId": "v2", "net": "USB_DP"},
        {"primitiveId": "v3", "net": "USB_DM"}, {"primitiveId": "v4", "net": "USB_DM"},
        {"primitiveId": "v5", "net": "USB_DM"}, {"primitiveId": "v6", "net": "USB_DM"},
    ]
    client = MockMCPClient(pcb_primitives={"via": vias})
    findings = run_check(
        PcbDiffPairViaBalance, client,
        {"differential_pairs": [["USB_DP", "USB_DM"]]},
    )
    assert len(findings) == 1
    assert findings[0]["severity"] == "warn"
    assert "2 vs 4" in findings[0]["message"]
