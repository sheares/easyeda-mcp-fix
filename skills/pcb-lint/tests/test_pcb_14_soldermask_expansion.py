from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_14_soldermask_expansion import PcbSoldermaskExpansion


# Raw MCP mask values are in 1/100 inch: 1 unit = 10 mil = 0.254 mm (so 0.2 = 2 mil).
def _pad(prim_id, top_raw, bot_raw):
    return {
        "primitiveId": prim_id,
        "solderMaskAndPasteMaskExpansion": {
            "topSolderMask": top_raw,
            "bottomSolderMask": bot_raw,
            "topPasteMask": 0,
            "bottomPasteMask": 0,
        },
    }


def test_default_expansion_2_mil_passes():
    """Raw 0.2 = 2 mil (0.0508 mm), the typical real value (passes)."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", 0.2, 0.2)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    warns = [f for f in findings if f["severity"] == "warn"]
    assert warns == []


def test_too_tight_expansion_flagged_as_warn():
    """Raw 0.04 = 0.4 mil, way too tight, risk of mask-on-pad."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", 0.04, 0.04)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    warns = [f for f in findings if f["severity"] == "warn"]
    assert len(warns) == 1
    assert "below" in warns[0]["message"]


def test_too_loose_expansion_flagged_as_info():
    """Raw 0.8 = 8 mil, too loose for fine-pitch parts (info only)."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", 0.8, 0.8)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    infos = [f for f in findings if f["severity"] == "info"]
    assert len(infos) == 1
    assert "above" in infos[0]["message"]


def test_negative_expansion_via_tenting_skipped():
    """Negative expansion = via tenting; don't flag."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("p1", -2.54, -2.54)]})
    assert run_check(PcbSoldermaskExpansion, client) == []


def test_raw_2_is_ambiguous_not_a_bridging_info():
    """Raw 2 is 20 mil under x10 but a normal 2 mil as plain mil (SOD-323 C191023)."""
    client = MockMCPClient(pcb_primitives={"pad": [_pad("d1", 2, 2)]})
    findings = run_check(PcbSoldermaskExpansion, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "info"
    assert "unit-ambiguous" in findings[0]["message"]
    assert "above 6 mil" not in findings[0]["message"]
    assert "20.0 mil (x10) or 2 mil (plain mil)" in findings[0]["offending_ids"][0]
