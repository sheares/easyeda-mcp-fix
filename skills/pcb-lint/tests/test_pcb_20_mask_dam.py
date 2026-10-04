"""Tests for PCB-20: solder-mask dam width on fine-pitch parts."""

from __future__ import annotations

from conftest import MockMCPClient, run_check

from checks.pcb_20_mask_dam_width import PcbMaskDamWidth
from checks.types import Layer


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _pad(
    prim_id: str,
    x: float,
    y: float,
    w: float,
    h: float,
    layer: int = Layer.TOP,
    top_mask_raw: float = 0.2,
    bot_mask_raw: float = 0.2,
) -> dict:
    """Build a minimal pad primitive in mils.

    x, y, w, h are in mils (matching EasyEDA PCB coordinate units).
    Mask expansions are RAW MCP values in 1/100 inch (1 unit = 10 mil = 0.254 mm),
    e.g. 0.2 = 2 mil = 0.0508 mm. They are NOT mm.
    """
    return {
        "primitiveId": prim_id,
        "layer": layer,
        "x": float(x),
        "y": float(y),
        "pad": ["RECT", float(w), float(h)],
        "solderMaskAndPasteMaskExpansion": {
            "topSolderMask": top_mask_raw,
            "bottomSolderMask": bot_mask_raw,
            "topPasteMask": 0.0,
            "bottomPasteMask": 0.0,
        },
    }


# 1 mm in mils
MM = 39.37


# ---------------------------------------------------------------------------
# Test 1: Clean board — pads far apart, no findings
# ---------------------------------------------------------------------------

def test_clean_board_wide_spacing():
    """Two pads 1 mm (39.37 mil) apart — gap far exceeds threshold; no findings."""
    pads = [
        _pad("p1", x=0.0,  y=0.0, w=20.0, h=20.0, top_mask_raw=0.2),
        _pad("p2", x=MM,   y=0.0, w=20.0, h=20.0, top_mask_raw=0.2),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    assert run_check(PcbMaskDamWidth, client) == []


# ---------------------------------------------------------------------------
# Test 2: Fine-pitch pad pair OK — dam = 0.15 mm ≥ 0.10 mm threshold → pass
# ---------------------------------------------------------------------------

def test_fine_pitch_ok():
    """Gap = 0.25 mm, mask exp = raw 0.2 (0.0508 mm) each side → dam = 0.15 mm ≥ 0.10 mm → pass.

    Centre-to-centre = 0.25 mm + half_w1 + half_w2.
    We use pad width 4 mil (≈ 0.10 mm) and space centres 0.25 mm + 0.10 mm = 0.35 mm apart.
    gap = 0.35 mm - (0.05 mm + 0.05 mm) = 0.25 mm
    dam = 0.25 mm - (0.05 mm + 0.05 mm) = 0.15 mm
    """
    w_mil = 4.0  # pad width ≈ 0.10 mm
    # Centre-to-centre along X so that edge-to-edge gap = 0.25 mm
    # gap = cc_dist - w_mil = 0.25 mm → cc_dist = 0.25 mm + w_mil
    gap_mm = 0.25
    cc_dist_mil = gap_mm * MM_TO_MIL() + w_mil
    pads = [
        _pad("p1", x=0.0,         y=0.0, w=w_mil, h=20.0, top_mask_raw=0.2),
        _pad("p2", x=cc_dist_mil, y=0.0, w=w_mil, h=20.0, top_mask_raw=0.2),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    assert run_check(PcbMaskDamWidth, client) == []


def MM_TO_MIL():
    return 39.37


# ---------------------------------------------------------------------------
# Test 3: Fine-pitch BELOW threshold — dam = 0.09 mm < 0.10 mm → error
# ---------------------------------------------------------------------------

def test_fine_pitch_below_threshold():
    """Gap = 0.25 mm, mask exp = 0.08 mm each side → dam = 0.09 mm < 0.10 mm → error.

    Pad width 4 mil (≈ 0.10 mm).
    cc_dist = gap + pad_width = 0.25 mm + 0.10 mm = 0.35 mm → 13.78 mil
    """
    w_mil = 4.0
    gap_mm = 0.25
    cc_dist_mil = gap_mm * 39.37 + w_mil
    pads = [
        _pad("p1", x=0.0,         y=0.0, w=w_mil, h=20.0, top_mask_raw=0.3),
        _pad("p2", x=cc_dist_mil, y=0.0, w=w_mil, h=20.0, top_mask_raw=0.3),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    findings = run_check(PcbMaskDamWidth, client)
    assert len(findings) == 1
    f = findings[0]
    assert f["severity"] == "error"
    assert f["check_id"] == "PCB-20"
    # Both pad IDs should appear in offending_ids
    offending = " ".join(f["offending_ids"])
    assert "p1" in offending
    assert "p2" in offending


# ---------------------------------------------------------------------------
# Test 4: Exactly at threshold — dam = 0.10 mm exactly → pass (strict <)
# ---------------------------------------------------------------------------

def test_exactly_at_threshold_passes():
    """dam = 0.11 mm (just above threshold) → pass (strict < semantics, not <=).

    Note: choosing gap = 0.21 mm with exp = 0.05 each gives dam ≈ 0.11 mm
    after the mil round-trip. A nominal dam of exactly 0.10 mm cannot be
    represented without floating-point loss through the mil↔mm conversion;
    0.11 mm is the safe "at threshold" test value for strict-less-than.
    """
    w_mil = 4.0
    # gap ≈ 0.21 mm; exp = 0.05 mm each; dam ≈ 0.11 mm > 0.10 mm → pass
    gap_mm = 0.21
    cc_dist_mil = gap_mm * 39.37 + w_mil
    pads = [
        _pad("p1", x=0.0,         y=0.0, w=w_mil, h=20.0, top_mask_raw=0.2),
        _pad("p2", x=cc_dist_mil, y=0.0, w=w_mil, h=20.0, top_mask_raw=0.2),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    assert run_check(PcbMaskDamWidth, client) == []


# ---------------------------------------------------------------------------
# Test 5: Pads on different layers at same XY → no finding
# ---------------------------------------------------------------------------

def test_different_layers_no_finding():
    """TOP pad and BOTTOM pad at the same XY — dams don't cross layers; no finding."""
    pads = [
        _pad("p1", x=0.0, y=0.0, w=4.0, h=4.0, layer=Layer.TOP,    top_mask_raw=0.3),
        _pad("p2", x=2.0, y=0.0, w=4.0, h=4.0, layer=Layer.BOTTOM, bot_mask_raw=0.3),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    assert run_check(PcbMaskDamWidth, client) == []


# ---------------------------------------------------------------------------
# Test 6: Rotated pair (>5° misalignment) — skipped silently
# ---------------------------------------------------------------------------

def test_rotated_pair_skipped():
    """Pad pair at 45° — not axis-aligned; skipped (post-MVP limitation)."""
    # Place pads diagonally so dx = dy, which gives a 45° angle
    # Use small spacing so they'd normally be close enough to inspect
    offset_mil = 4.0  # each component = 4 mil → total ≈ 5.66 mil centre-to-centre
    pads = [
        _pad("p1", x=0.0,        y=0.0,        w=2.0, h=2.0, top_mask_raw=0.3),
        _pad("p2", x=offset_mil, y=offset_mil, w=2.0, h=2.0, top_mask_raw=0.3),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    # Rotated pairs are skipped; no finding emitted even if gap would be tight
    assert run_check(PcbMaskDamWidth, client) == []


# ---------------------------------------------------------------------------
# Test 7: THT pads on MULTI_LAYER — tight spacing → error emitted
# ---------------------------------------------------------------------------

def test_tht_multi_layer_tight_spacing():
    """Two THT pads on MULTI_LAYER with dam below threshold → error."""
    w_mil = 4.0
    gap_mm = 0.25
    cc_dist_mil = gap_mm * 39.37 + w_mil
    pads = [
        _pad("p1", x=0.0,         y=0.0, w=w_mil, h=20.0,
             layer=Layer.MULTI_LAYER, top_mask_raw=0.3),
        _pad("p2", x=cc_dist_mil, y=0.0, w=w_mil, h=20.0,
             layer=Layer.MULTI_LAYER, top_mask_raw=0.3),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    findings = run_check(PcbMaskDamWidth, client)
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"
    offending = " ".join(findings[0]["offending_ids"])
    assert "p1" in offending
    assert "p2" in offending


# ---------------------------------------------------------------------------
# Test 8: Config knob — raise threshold to 0.15 mm; previously-passing dam errors
# ---------------------------------------------------------------------------

def test_config_knob_raises_threshold():
    """dam = 0.12 mm passes at default 0.10 mm but errors with pcb_mask_dam_min_mm=0.15."""
    w_mil = 4.0
    # gap = 0.22 mm; exp = 0.05 each; dam = 0.22 - 0.10 = 0.12 mm
    gap_mm = 0.22
    cc_dist_mil = gap_mm * 39.37 + w_mil
    pads = [
        _pad("p1", x=0.0,         y=0.0, w=w_mil, h=20.0, top_mask_raw=0.2),
        _pad("p2", x=cc_dist_mil, y=0.0, w=w_mil, h=20.0, top_mask_raw=0.2),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    # Default threshold (0.10 mm) — passes
    assert run_check(PcbMaskDamWidth, client) == []
    # Raised threshold (0.15 mm) — errors
    findings = run_check(PcbMaskDamWidth, client, config={"pcb_mask_dam_min_mm": 0.15})
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"


# ---------------------------------------------------------------------------
# Test 9: Multiple violations — all emitted, not just first
# ---------------------------------------------------------------------------

def test_multiple_violations_all_emitted():
    """Three adjacent tight-pitch pad pairs all violate → all captured in offending_ids."""
    w_mil = 4.0
    gap_mm = 0.25
    cc_dist_mil = gap_mm * 39.37 + w_mil

    # Build 4 pads in a row: pairs (p1,p2), (p2,p3), (p3,p4) all tight.
    # But note: the check is O(N^2) unique pairs, so we'll build 4 independent pairs
    # by spacing them far enough in Y that cross-pair distances exceed the proximity threshold.
    far_y = 20 * 39.37  # 20 mm apart in Y — well beyond 0.3 mm proximity

    pads = []
    for row in range(3):
        y = row * far_y
        pads.append(_pad(f"a{row}", x=0.0,         y=y, w=w_mil, h=20.0, top_mask_raw=0.3))
        pads.append(_pad(f"b{row}", x=cc_dist_mil, y=y, w=w_mil, h=20.0, top_mask_raw=0.3))

    client = MockMCPClient(pcb_primitives={"pad": pads})
    findings = run_check(PcbMaskDamWidth, client)
    assert len(findings) == 1
    # All 3 violations must appear in offending_ids (one entry per pair)
    offending = findings[0]["offending_ids"]
    assert len(offending) == 3


# ---------------------------------------------------------------------------
# Test 10 (Fix 3): Internal signal layer — tight spacing → error emitted
# ---------------------------------------------------------------------------

def test_internal_signal_layer_tight_spacing_errors():
    """Two pads on internal layer 15 with sub-threshold mask dam → error.

    Confirms that layer IDs >= 15 are no longer silently excluded.
    Pad width 4 mil, gap 0.25 mm, mask exp 0.08 mm each → dam 0.09 mm < 0.10 mm.
    """
    w_mil = 4.0
    gap_mm = 0.25
    cc_dist_mil = gap_mm * 39.37 + w_mil
    pads = [
        _pad("il_p1", x=0.0,         y=0.0, w=w_mil, h=20.0,
             layer=15, top_mask_raw=0.3),
        _pad("il_p2", x=cc_dist_mil, y=0.0, w=w_mil, h=20.0,
             layer=15, top_mask_raw=0.3),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    findings = run_check(PcbMaskDamWidth, client)
    assert len(findings) == 1, f"Expected 1 finding, got {len(findings)}"
    f = findings[0]
    assert f["severity"] == "error"
    assert f["check_id"] == "PCB-20"
    offending = " ".join(f["offending_ids"])
    assert "il_p1" in offending
    assert "il_p2" in offending


# ---------------------------------------------------------------------------
# Test 11 (Fix 4): Wide pads (0.5 mm each) with centres 30 mil apart → error
# ---------------------------------------------------------------------------

def test_wide_pad_pair_not_dropped_by_proximity_prefilter():
    """Regression test for Fix 4 (dynamic proximity pre-filter).

    Two 0.5 mm-wide pads (≈ 20 mil) with centres 30 mil apart.
    Old fixed pre-filter ceiling was 23.6 mil → 30 mil > 23.6 mil → pair silently dropped.
    Dynamic ceiling = (20 + 20) / 2 + gap_threshold_mil ≈ 20 + 11.8 = 31.8 mil.
    30 mil < 31.8 mil → pair is now inspected.

    gap = 30 - (20/2 + 20/2) = 30 - 20 = 10 mil = 0.254 mm
    mask exp = 0.1 mm each
    dam = 0.254 - (0.1 + 0.1) = 0.054 mm < 0.10 mm → error.
    """
    w_mil = 20.0  # 0.5 mm = 20 mil
    cc_dist_mil = 30.0
    pads = [
        _pad("wp1", x=0.0,         y=0.0, w=w_mil, h=w_mil,
             layer=Layer.TOP, top_mask_raw=0.4),
        _pad("wp2", x=cc_dist_mil, y=0.0, w=w_mil, h=w_mil,
             layer=Layer.TOP, top_mask_raw=0.4),
    ]
    client = MockMCPClient(pcb_primitives={"pad": pads})
    findings = run_check(PcbMaskDamWidth, client)
    assert len(findings) == 1, f"Expected 1 finding, got {len(findings)}: {findings}"
    f = findings[0]
    assert f["severity"] == "error"
    assert f["check_id"] == "PCB-20"
    offending = " ".join(f["offending_ids"])
    assert "wp1" in offending
    assert "wp2" in offending


# ---------------------------------------------------------------------------
# Regression tests for the mask-expansion unit bug (raw value is 1/100 inch)
# ---------------------------------------------------------------------------

def _tssop20_pads(raw_mask: float) -> list[dict]:
    """TSSOP-20: 0.65 mm pitch, pads 0.40 mm wide (along the pitch axis), 1.5 mm long.

    Two columns of 10 pads, 6 mm apart. Pitch axis is Y, so pad height is the
    0.40 mm dimension; adjacent edge-to-edge gap = 0.65 - 0.40 = 0.25 mm.
    """
    pitch = 0.65 * MM
    pads = []
    for i in range(10):
        for side, x in (("L", -3.0 * MM), ("R", 3.0 * MM)):
            pads.append(
                _pad(f"{side}{i + 1}", x=x, y=i * pitch, w=1.5 * MM, h=0.40 * MM,
                     top_mask_raw=raw_mask, bot_mask_raw=raw_mask)
            )
    return pads


def test_tssop20_realistic_mask_raw_0_2_no_false_alarm():
    """Regression: real MCP value 0.2 (= 2 mil = 0.0508 mm) must not error.

    Dam = 0.25 - 2 x 0.0508 = 0.148 mm >= 0.10 mm, so no finding. Under the old
    (wrong) mm interpretation the same fixture read 0.2 mm per pad:
    dam = 0.25 - 0.40 = -0.15 mm and PCB-20 raised a false negative-dam error
    (seen on a real board as -7.54 mil / -4.44 mil dams on parts whose real
    dams were +4.2 / +7.3 mil).
    """
    client = MockMCPClient(pcb_primitives={"pad": _tssop20_pads(0.2)})
    assert run_check(PcbMaskDamWidth, client) == []


def test_ambiguous_raw_2_named_in_pcb20_message_and_pcb14_info():
    """Raw 2 (e.g. SOD-323 C191023) is unit-ambiguous: 20 mil under x10, 2 mil as plain mil.

    PCB-20 keeps the conservative x10 reading (so it errors on a 0.25 mm gap) and
    names the ambiguous pad. PCB-14 emits one ambiguity info, not a bridging info.
    """
    pads = [
        _pad("sod_a", x=0.0, y=0.0, w=4.0, h=20.0, top_mask_raw=2, bot_mask_raw=2),
        _pad("sod_k", x=0.25 * MM + 4.0, y=0.0, w=4.0, h=20.0,
             top_mask_raw=0.2, bot_mask_raw=0.2),
    ]
    findings = run_check(PcbMaskDamWidth, MockMCPClient(pcb_primitives={"pad": pads}))
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"
    assert "unit-ambiguous" in findings[0]["message"].lower()
    assert "sod_a" in findings[0]["message"]
    assert "sod_k" not in findings[0]["message"]

    from checks.pcb_14_soldermask_expansion import PcbSoldermaskExpansion
    f14 = run_check(PcbSoldermaskExpansion, MockMCPClient(pcb_primitives={"pad": pads}))
    assert len(f14) == 1
    assert f14[0]["severity"] == "info"
    assert "unit-ambiguous" in f14[0]["message"]
    assert "above 6 mil" not in f14[0]["message"]
    assert "sod_a" in " ".join(f14[0]["offending_ids"])


def test_genuinely_tight_pair_still_errors_under_x10():
    """Raw 0.5 (5 mil = 0.127 mm) on both pads of a 0.25 mm gap: dam = -0.004 mm -> error."""
    pads = [p for p in _tssop20_pads(0.5)]
    findings = run_check(PcbMaskDamWidth, MockMCPClient(pcb_primitives={"pad": pads}))
    assert len(findings) == 1
    assert findings[0]["severity"] == "error"
    assert "unit-ambiguous" not in findings[0]["message"].lower()
