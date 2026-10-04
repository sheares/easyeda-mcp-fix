from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_14_soldermask_expansion import PcbSoldermaskExpansion


def _pad(prim_id, top_mm, bot_mm):
    return {
        "primitiveId": prim_id,
        "solderMaskAndPasteMaskExpansion": {
            "topSolderMask": top_mm,
            "bottomSolderMask": bot_mm,
            "topPasteMask": 0,
            "bottomPasteMask": 0,
        },
    }


def test_default_expansion_2_mil_passes():
    """0.0508 mm ≈ 2 mil, right at the min threshold (passes)."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", 0.0508, 0.0508)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    warns = [f for f in findings if f["severity"] == "warn"]
    assert warns == []


def test_too_tight_expansion_flagged_as_warn():
    """0.01 mm ≈ 0.4 mil, way too tight, risk of mask-on-pad."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", 0.01, 0.01)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    warns = [f for f in findings if f["severity"] == "warn"]
    assert len(warns) == 1
    assert "below" in warns[0]["message"]


def test_too_loose_expansion_flagged_as_info():
    """0.2 mm ≈ 8 mil, too loose for fine-pitch parts (info only)."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", 0.2, 0.2)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    infos = [f for f in findings if f["severity"] == "info"]
    assert len(infos) == 1
    assert "above" in infos[0]["message"]


def test_negative_expansion_via_tenting_skipped():
    """Negative expansion = via tenting; don't flag."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", -25.4, -25.4)]})
    assert run_check(PcbSoldermaskExpansion, client) == []
