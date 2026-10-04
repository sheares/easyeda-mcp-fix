"""SCH-08: Regulator Vout vs downstream IC absolute-maximum voltage.

Exists specifically to prevent recurrence of the Splitflap-v2 Board1 4.43V
incident: MP1584 buck with an FB divider (68k/15k) producing 4.43V into an
ESP32-C3 rated 3.6V absolute max, caught only by manual datasheet review
AFTER boards were ordered.

For each adjustable-output regulator:
1. Look up Vref from a data-driven table (unknown => WARN, never silently pass).
2. Find the FB divider on the FB net: R_upper is on both FB and VOUT nets,
   R_lower is on both FB and GND.
3. Compute Vout = Vref × (1 + R_upper / R_lower) using the actual resistor
   values in the schematic.
4. Collect downstream ICs on the VOUT net; look up each one's abs-max on
   the same data-driven table.
5. HARD ERROR if Vout > any downstream abs max. WARN if Vout deviates
   >10% from the rail's design-intent voltage (from net name, e.g. +3V3).

Data-driven tables live at the top of the module. When a regulator or IC is
absent from the table, this check DOES NOT silently pass: it emits an info
finding that the datasheet needs to be added. Manual verification (per
SKILL.md step 3b) remains the fallback for that case.
"""

from __future__ import annotations

import re
from typing import Any

from .base import Check, Finding, register
from .types import (
    designators_on_net,
    find_regulator_output_net,
    infer_functional_type,
    parse_value_field,
)


# --- Data tables (verify against datasheet before shipping) ---

# Adjustable-output regulator Vref (volts). Keyed by lowercase name stem
# that must appear as a substring of the component `name` field. Extend as
# new regulators are used. All values sourced from the manufacturer
# datasheet; the comment cites the datasheet section.
REGULATOR_VREF_V: dict[str, float] = {
    # Buck converters
    "mp1584": 0.800,   # MPS MP1584 datasheet §Electrical Characteristics: VFB typ 0.8V
    "mp2307": 0.925,   # MPS MP2307 §Electrical Characteristics: VFB typ 0.925V
    "lm2596": 1.230,   # TI LM2596 §Electrical Characteristics: VFB typ 1.23V (adj variant)
    "tps54331": 0.800, # TI TPS54331 §Electrical Characteristics: VFB typ 0.8V
    # LDOs (adjustable variants)
    "ams1117": 1.250,  # AMS1117 §Electrical Characteristics: VREF typ 1.25V (adj)
    "lp5907": 1.200,   # TI LP5907 §Electrical Characteristics: VFB typ 1.2V (adj)
    "ap2112": 1.220,   # Diodes AP2112 §Electrical Characteristics: VFB typ 1.22V (adj)
}


# Absolute-maximum supply voltage (volts). Keyed by lowercase substring
# of the component `name` field. Verify against the datasheet's Absolute
# Maximum Ratings table before shipping.
IC_ABS_MAX_SUPPLY_V: dict[str, float] = {
    # Espressif — all module abs-max is 3.6V (see chip datasheets §Absolute Maximum Ratings).
    "esp32-c3": 3.6,
    "esp32-s3": 3.6,
    "esp32-c6": 3.6,
    "esp32-s2": 3.6,
    "esp32-h2": 3.6,
    "esp32":    3.6,   # generic ESP32 family
    # Common 5V-tolerant / logic parts
    "stm32":    3.6,   # STM32 F/G/L series VDD abs-max (verify per part; L is 3.6V)
    "atmega":   5.5,   # ATmega328P abs-max VCC 6.0V, keep conservative 5.5
    # Interface parts
    "max485":   6.0,   # Maxim MAX485 datasheet: VCC abs-max 7V; conservative 6.0
    "tpl7407":  40.0,  # TI TPL7407L: VS(motor) abs-max 40V; logic VCC 5.5V (not this rail)
    "uln2003":  50.0,  # TI ULN2003A: max output V 50V
}


# Design-intent target voltages inferred from rail net names (volts). The
# regex is applied to a normalised form of the net name where the "V is the
# decimal point" convention (+3V3 = 3.3V, +1V8 = 1.8V) has been rewritten
# to +3.3V / +1.8V, so we only need one regex per rail.
RAIL_TARGET_V: tuple[tuple[re.Pattern, float], ...] = (
    (re.compile(r"(?:^|[^\d])3\.3(?:v|V|$|_)",  re.IGNORECASE), 3.3),
    (re.compile(r"(?:^|[^\d])5(?:v|V|$|_)",     re.IGNORECASE), 5.0),
    (re.compile(r"(?:^|[^\d])12(?:v|V|$|_)",    re.IGNORECASE), 12.0),
    (re.compile(r"(?:^|[^\d])1\.8(?:v|V|$|_)",  re.IGNORECASE), 1.8),
    (re.compile(r"(?:^|[^\d])2\.5(?:v|V|$|_)",  re.IGNORECASE), 2.5),
)


_VN_RE = re.compile(r"(\d)V(\d)")


def _normalise_rail_name(net_name: str) -> str:
    """Rewrite +3V3 → +3.3V, +1V8 → +1.8V so a single regex catches both
    the +3V3 and +3.3V spelling conventions.
    """
    return _VN_RE.sub(r"\1.\2V", net_name)


_RES_RE = re.compile(
    r"^\s*(\d+(?:\.\d+)?)\s*([kmr]|kΩ|mΩ|ohm|Ω)?\s*$",
    re.IGNORECASE,
)
_RES_UNIT_TO_OHMS = {"k": 1e3, "m": 1e6, "kΩ": 1e3, "mΩ": 1e6, "r": 1.0, "ohm": 1.0, "Ω": 1.0, None: 1.0, "": 1.0}


def parse_resistance_ohms(value: str) -> float | None:
    """Parse '10k' → 10000, '68k' → 68000, '15k' → 15000, '4.7k' → 4700,
    '100R' → 100, '1M' → 1e6, '10' → 10. Returns None on unparseable input.
    """
    if not value:
        return None
    m = _RES_RE.match(value.strip())
    if not m:
        return None
    magnitude = float(m.group(1))
    unit = (m.group(2) or "").lower()
    return magnitude * _RES_UNIT_TO_OHMS.get(unit, 1.0)


def _lookup_by_substring(table: dict[str, float], name: str) -> tuple[str, float] | None:
    """Case-insensitive substring lookup; returns (matched_key, value) or None."""
    n = (name or "").lower()
    for key, val in table.items():
        if key in n:
            return key, val
    return None


def _rail_target_v(net_name: str) -> float | None:
    normalised = _normalise_rail_name(net_name)
    for pat, v in RAIL_TARGET_V:
        if pat.search(normalised):
            return v
    return None


def _find_fb_net(reg_desig: str, conn_comps: dict) -> str | None:
    """Return the FB net for a regulator: pin name FB, FBK, ADJ, or *_FB."""
    pins = (conn_comps.get(reg_desig, {}) or {}).get("pins", {}) or {}
    for pin in pins.values():
        pname = (pin.get("name") or "").upper()
        net = pin.get("net") or None
        if not net:
            continue
        if pname == "FB" or pname == "FBK" or pname == "ADJ" or pname.endswith("_FB"):
            return net
    return None


def _find_regulator_pins(
    reg_desig: str,
    conn_comps: dict,
    conn_nets: dict,
) -> tuple[str | None, str | None, str]:
    """Return (fb_net, vout_net, how_vout_detected). VOUT/OUT direct pin
    covers LDOs; the SW→inductor→output trace covers switching bucks (MP1584
    et al) that have no output pin. Without the second path, SCH-08 misses
    exactly the switching-buck overvoltage class it exists to catch (see the
    Splitflap-v2 Board1 4.43V regression fixture below).
    """
    fb_net = _find_fb_net(reg_desig, conn_comps)
    vout_net, how = find_regulator_output_net(reg_desig, conn_comps, conn_nets)
    return fb_net, vout_net, how


def _find_fb_divider(
    fb_net: str,
    vout_net: str,
    conn_nets: dict,
    conn_comps: dict,
    resistor_pins_on_nets: dict[str, dict[str, set[str]]],
) -> tuple[str | None, str | None]:
    """Return (r_upper_desig, r_lower_desig). r_upper connects FB to VOUT;
    r_lower connects FB to GND (net name 'GND' or matching /^GND/).
    """
    fb_designators = {d.upper() for d in designators_on_net(fb_net, conn_nets)}
    r_upper: str | None = None
    r_lower: str | None = None
    for desig in fb_designators:
        if not desig.startswith("R"):
            continue
        nets = resistor_pins_on_nets.get(desig, {})
        other_nets = {n for n in nets if n != fb_net}
        if vout_net in other_nets:
            r_upper = desig
        for on in other_nets:
            if on == "GND" or on.upper().startswith("GND"):
                r_lower = desig
                break
    return r_upper, r_lower


def _build_resistor_net_map(parts: list[dict], conn_comps: dict) -> dict[str, dict[str, set[str]]]:
    """{'R7': {'FB': {'FB', 'VOUT_3V3'}, ...}} — for each resistor, the set of
    nets each of its pins connects to. Only nets we can see; pins with no
    net contribute nothing.
    """
    out: dict[str, dict[str, set[str]]] = {}
    for c in parts:
        if infer_functional_type(c) != "resistor":
            continue
        desig = (c.get("designator") or "").upper()
        if not desig:
            continue
        pins = (conn_comps.get(desig, {}) or {}).get("pins", {}) or {}
        by_pin: dict[str, set[str]] = {}
        for pnum, pin in pins.items():
            net = pin.get("net") or ""
            if net:
                by_pin.setdefault(pnum, set()).add(net)
        # Also aggregate at the resistor level for the FB-divider query above.
        agg: set[str] = set()
        for s in by_pin.values():
            agg |= s
        # Store both shapes in one dict: pin-level keys AND a synthetic "*" key.
        by_pin["*"] = agg
        out[desig] = by_pin
    # Also fold in the flat aggregate as top-level keys per _find_fb_divider's
    # expectation (nets touched by this resistor as a set).
    flat: dict[str, dict[str, set[str]]] = {}
    for desig, by_pin in out.items():
        flat[desig] = {n: set() for n in by_pin.get("*", set())}
    return flat


@register
class SchRegulatorVout(Check):
    id = "SCH-08"
    default_severity = "error"
    deviation_pct = 10.0  # warn on ±10% deviation from rail target

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])
        regulators = [c for c in parts if infer_functional_type(c) == "regulator"]
        if not regulators:
            return []

        conn = client.sch_get_connectivity(
            document,
            designators=[c.get("designator") for c in parts if c.get("designator")],
            depth=1,
        ) or {}
        conn_nets = conn.get("nets", {}) or {}
        conn_comps = conn.get("components", {}) or {}

        resistor_value_by_desig: dict[str, float | None] = {}
        for c in parts:
            if infer_functional_type(c) != "resistor":
                continue
            desig = (c.get("designator") or "").upper()
            if not desig:
                continue
            resistor_value_by_desig[desig] = parse_resistance_ohms(parse_value_field(c))

        component_by_desig: dict[str, dict] = {}
        for c in parts:
            d = (c.get("designator") or "").upper()
            if d:
                component_by_desig[d] = c

        resistor_nets = _build_resistor_net_map(parts, conn_comps)

        findings: list[dict] = []

        for reg in regulators:
            desig = (reg.get("designator") or "?").upper()
            reg_name = reg.get("name") or ""

            vref_hit = _lookup_by_substring(REGULATOR_VREF_V, reg_name)
            if vref_hit is None:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=f"{desig} ({reg_name}): Vref unknown, add to REGULATOR_VREF_V table",
                        offending_ids=[desig],
                        suggestion=(
                            "Look up VFB/VREF from the regulator datasheet's Electrical "
                            "Characteristics table and add a row to REGULATOR_VREF_V in "
                            "scripts/checks/sch_08_regulator_vout.py. Meanwhile, verify Vout "
                            "manually per SKILL.md step 3b."
                        ),
                    ).to_dict()
                )
                continue
            reg_key, vref = vref_hit

            fb_net, vout_net, vout_how = _find_regulator_pins(desig, conn_comps, conn_nets)
            if not fb_net or not vout_net:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="info",
                        message=(
                            f"{desig}: cannot identify FB and output pins "
                            f"(fb={fb_net}, vout={vout_net}; {vout_how})"
                        ),
                        offending_ids=[desig],
                        suggestion=(
                            "For switching regulators, ensure an inductor with an 'L*' designator "
                            "sits on the SW node. For other topologies, extend "
                            "find_regulator_output_net in types.py or verify manually."
                        ),
                    ).to_dict()
                )
                continue

            r_upper_desig, r_lower_desig = _find_fb_divider(
                fb_net, vout_net, conn_nets, conn_comps, resistor_nets,
            )
            if not r_upper_desig or not r_lower_desig:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="info",
                        message=(
                            f"{desig}: cannot find FB divider on {fb_net} "
                            f"(upper={r_upper_desig}, lower={r_lower_desig}). "
                            f"Fixed-Vout variant, or divider missing?"
                        ),
                        offending_ids=[desig],
                        suggestion="If this is a fixed-Vout variant, no divider check needed — verify by name. Otherwise the schematic is missing a divider resistor.",
                    ).to_dict()
                )
                continue

            r_upper = resistor_value_by_desig.get(r_upper_desig)
            r_lower = resistor_value_by_desig.get(r_lower_desig)
            if r_upper is None or r_lower is None or r_lower == 0:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=(
                            f"{desig} FB divider: unparseable resistor values "
                            f"({r_upper_desig}={resistor_value_by_desig.get(r_upper_desig)}, "
                            f"{r_lower_desig}={resistor_value_by_desig.get(r_lower_desig)})"
                        ),
                        offending_ids=[r_upper_desig, r_lower_desig],
                        suggestion="Set Value on both divider resistors in the schematic (e.g. '68k', '15k').",
                    ).to_dict()
                )
                continue

            vout = vref * (1.0 + r_upper / r_lower)
            rail_target = _rail_target_v(vout_net)

            downstream = [
                d for d in designators_on_net(vout_net, conn_nets)
                if d.upper() != desig and d.upper() != r_upper_desig and d.upper() != r_lower_desig
            ]
            overvolt_hits: list[tuple[str, str, float]] = []
            unknown_downstream: list[str] = []
            for d in downstream:
                comp = component_by_desig.get(d.upper())
                if not comp:
                    continue
                if infer_functional_type(comp) not in {"ic", "regulator"}:
                    continue
                cname = comp.get("name") or ""
                hit = _lookup_by_substring(IC_ABS_MAX_SUPPLY_V, cname)
                if hit is None:
                    unknown_downstream.append(f"{d}({cname or '?'})")
                    continue
                _key, abs_max = hit
                if vout > abs_max:
                    overvolt_hits.append((d, cname, abs_max))

            summary = (
                f"{desig} ({reg_key}, Vref={vref}V) with {r_upper_desig}={r_upper:.0f}Ω / "
                f"{r_lower_desig}={r_lower:.0f}Ω → Vout={vout:.3f}V on {vout_net}"
            )

            if overvolt_hits:
                hit_lines = ", ".join(f"{d} ({name} abs-max {vmax}V)" for d, name, vmax in overvolt_hits)
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=f"OVERVOLTAGE: {summary}. Downstream over abs-max: {hit_lines}",
                        offending_ids=[desig, r_upper_desig, r_lower_desig] + [d for d, _, _ in overvolt_hits],
                        suggestion=(
                            "DO NOT proceed to fab or power-on. Recompute the FB divider for the intended Vout, "
                            "swap the resistor values, and re-run this check. Precedent: Splitflap-v2 Board1 shipped "
                            "with an MP1584 divider producing 4.43V into an ESP32-C3 rated 3.6V abs-max, caught only "
                            "by manual datasheet review after boards were ordered."
                        ),
                    ).to_dict()
                )
                continue

            if rail_target is not None:
                deviation_pct = 100.0 * (vout - rail_target) / rail_target
                if abs(deviation_pct) > self.deviation_pct:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="warn",
                            message=(
                                f"{summary}; deviates {deviation_pct:+.1f}% from rail intent {rail_target}V"
                            ),
                            offending_ids=[desig, r_upper_desig, r_lower_desig],
                            suggestion="Check divider values; if intentional (e.g. calibrated rail), rename the net so the check passes.",
                        ).to_dict()
                    )
                    continue

            if unknown_downstream:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="info",
                        message=(
                            f"{summary}. Downstream ICs not in abs-max table: {', '.join(unknown_downstream)}"
                        ),
                        offending_ids=[desig] + unknown_downstream,
                        suggestion="Add these parts to IC_ABS_MAX_SUPPLY_V in scripts/checks/sch_08_regulator_vout.py so future runs verify automatically.",
                    ).to_dict()
                )

        return findings
