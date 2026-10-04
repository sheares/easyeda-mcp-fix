"""SCH-11: ESP32 strapping-pin conflict check.

Certain ESP32 GPIO pins are sampled at reset to configure boot mode, flash
voltage, and UART logging. If those pins are tied to the wrong level, driven
by an external IC output without a series resistor, or have a pull resistor
that fights the internal pull direction, the board either refuses to boot or
enters an incorrect mode. The VDD_SPI strapping pin (GPIO45 on S3, GPIO12 on
classic) is especially dangerous: the wrong level bricks a 3.3V flash chip by
enabling 1.8V mode.

Rules enforced (per variant):
1. If the strap net has only the ESP32 on it (no external influence) → info.
2. If a pull resistor on the strap net exists but its value is outside 1 kΩ–10 kΩ
   → warn (too weak = noise-sensitive, too strong = fights internal pull).
3. If a pull resistor is within 1 kΩ–10 kΩ and matches the required boot level
   → pass (no finding).
4. If a pull resistor is within 1 kΩ–10 kΩ but pulls to the WRONG level
   (e.g. a pull-down on a pin that requires HIGH) → warn. This is a likely
   boot-mode misconfig.
5. If a driver/transceiver output pin (any IC output that is not the ESP32
   itself) is on the strap net without evidence of a 1 kΩ–10 kΩ series
   resistor between them → error.
6. If the strap is hard-tied (0 Ω direct wire or 0Ω resistor) to a level that
   fights its required boot level → error.

Sources:
- ESP32-C3 Series Datasheet §2.8 "Strapping Pins" (v1.7, Espressif 2023).
- ESP32-S3 Series Datasheet §3.3 "Strapping Pins" (v1.4, Espressif 2023).
- ESP32 Series Datasheet §2.4 "Strapping Pins" (v3.5, Espressif 2023).
- ESP32 Hardware Design Guidelines §2.2 (Espressif, 2023).
- ESP32-S2 Series Datasheet §2.4 "Strapping Pins" (v1.8, Espressif 2023).
- ESP32-C6 Technical Reference Manual §2.2 / datasheet §2.8 (Espressif 2023).
- ESP32-H2 Series Datasheet §2.8 "Strapping Pins" (v0.5, Espressif 2023).

NOTE ON SERIES-R DETECTION: The check looks for a resistor on the strap net
whose other pin connects to a GND/power rail (pull) vs to an IC output (series
protection). True series-R detection between IC output and strap pin requires
a two-hop graph walk; the heuristic here flags absence of any pull/series R
on a net that also has an IC output, which catches the common footgun.
"""

from __future__ import annotations

import re
from typing import Any

from .base import Check, Finding, register
from .types import (
    designators_on_net,
    infer_functional_type,
    is_power_pin_by_name,
    looks_like_power_rail,
    parse_value_field,
)


# ---------------------------------------------------------------------------
# Strapping-pin tables, keyed by variant slug.
# Each entry: (gpio_number, required_boot_level, default_internal_pull, note).
#   required_boot_level: "HIGH" | "LOW" | None (None = doesn't block boot,
#                        but wrong level changes a sub-mode)
#   default_internal_pull: "HIGH" (internal pull-up) | "LOW" (internal pull-down) | None
#   brick_risk: True if the wrong level can brick the board (e.g. flash voltage)
# ---------------------------------------------------------------------------

StrapPin = dict  # typed locally to keep the dataclass light

STRAPPING_PINS: dict[str, list[StrapPin]] = {

    # ESP32-C3 Series Datasheet §2.8
    "c3": [
        {
            "gpio": "GPIO2",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "Must be HIGH for SPI flash boot. Internal weak pull-up present; "
                "an external pull-up is recommended for robustness. "
                "LOW disables SPI flash boot. "
                "ESP32-C3 datasheet §2.8."
            ),
        },
        {
            "gpio": "GPIO8",
            "required_level": "HIGH",
            "internal_pull": None,
            "brick_risk": False,
            "note": (
                "GPIO8 is Floating at reset (no internal pull — Table 3-1, v2.4). "
                "Boot mode: GPIO8 = 'Any value' for SPI boot (Table 3-3); "
                "however GPIO8 = LOW combined with GPIO9 = LOW selects Joint Download "
                "Boot, so HIGH is recommended to avoid inadvertent download mode. "
                "ROM log control (Table 3-4): when EFUSE_UART_PRINT_CONTROL = 1, "
                "GPIO8 HIGH = UART0 printing ENABLED, GPIO8 LOW = printing DISABLED. "
                "The previous note ('HIGH suppresses ROM log') was INCORRECT and has "
                "been corrected. Verified against ESP32-C3 Series Datasheet §3.1–3.2, "
                "v2.4 (Espressif), 2026-08-09. "
                "Datasheet: https://www.espressif.com/sites/default/files/"
                "documentation/esp32-c3_datasheet_en.pdf"
            ),
        },
        {
            "gpio": "GPIO9",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "HIGH (default) = SPI flash boot. LOW at reset = UART download mode. "
                "Internal pull-up active; pulling LOW intentionally puts the chip into "
                "download mode. "
                "ESP32-C3 datasheet §2.8."
            ),
        },
    ],

    # ESP32-S3 Series Datasheet §3.3
    "s3": [
        {
            "gpio": "GPIO0",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "HIGH = SPI boot (normal run); LOW = download mode. "
                "Internal pull-up. "
                "ESP32-S3 datasheet §3.3."
            ),
        },
        {
            "gpio": "GPIO3",
            "required_level": None,  # Not a boot-blocker, selects JTAG source
            "internal_pull": "HIGH",  # ~45 kΩ pull per datasheet
            "brick_risk": False,
            "note": (
                "Selects JTAG signal source: HIGH = USB-Serial-JTAG; "
                "LOW = GPIO JTAG. Not a boot blocker; wrong level causes debug "
                "tool to fail silently. "
                "ESP32-S3 datasheet §3.3."
            ),
        },
        {
            "gpio": "GPIO45",
            "required_level": "LOW",
            "internal_pull": "LOW",
            "brick_risk": True,
            "note": (
                "VDD_SPI voltage select: LOW = 3.3V (required for 3.3V flash), "
                "HIGH = 1.8V. WRONG LEVEL BRICKS BOOT when paired with a 3.3V flash "
                "chip. Internal pull-down; never pull HIGH unless using 1.8V flash. "
                "ESP32-S3 datasheet §3.3; hardware design guidelines §2.2.4."
            ),
        },
        {
            "gpio": "GPIO46",
            "required_level": None,  # Affects ROM logging, not boot
            "internal_pull": "LOW",
            "brick_risk": False,
            "note": (
                "ROM messages print: HIGH = print to UART0, LOW = silent. "
                "Internal weak pull-down. Pulling HIGH is usually undesirable in "
                "production. "
                "ESP32-S3 datasheet §3.3."
            ),
        },
    ],

    # ESP32 Classic Series Datasheet §2.4; Hardware Design Guidelines §2.2
    "classic": [
        {
            "gpio": "GPIO0",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "HIGH = SPI flash boot; LOW = download (UART programming) mode. "
                "Internal pull-up. "
                "ESP32 datasheet §2.4."
            ),
        },
        {
            "gpio": "GPIO2",
            "required_level": "LOW",
            "internal_pull": "LOW",
            "brick_risk": False,
            "note": (
                "Must be LOW (or floating, which resolves LOW via internal pull-down) "
                "during normal flash boot. HIGH at boot prevents SPI download mode "
                "but is fine for normal boot. Keep undriven HIGH or tied LOW. "
                "ESP32 datasheet §2.4."
            ),
        },
        {
            "gpio": "GPIO5",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "Controls SDIO slave timing and debug print output. "
                "HIGH (default internal pull-up) = normal. "
                "ESP32 datasheet §2.4."
            ),
        },
        {
            "gpio": "GPIO12",
            "required_level": "LOW",
            "internal_pull": "LOW",
            "brick_risk": True,
            "note": (
                "VDD_SDIO / flash voltage select: LOW = 3.3V (required for 3.3V flash), "
                "HIGH = 1.8V. WRONG LEVEL BRICKS BOOT with a 3.3V flash chip. "
                "Internal pull-down. Do NOT pull HIGH unless using 1.8V flash. "
                "ESP32 hardware design guidelines §2.2; datasheet §2.4."
            ),
        },
        {
            "gpio": "GPIO15",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "Controls MTDO/JTAG signal and U0TXD print at boot. "
                "HIGH = ROM prints to UART0 (default). LOW = silent at boot. "
                "Internal pull-up. "
                "ESP32 datasheet §2.4."
            ),
        },
    ],

    # ESP32-S2 Series Datasheet §2.4
    "s2": [
        {
            "gpio": "GPIO0",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "HIGH = SPI flash boot; LOW = download mode. Internal pull-up. "
                "ESP32-S2 datasheet §2.4."
            ),
        },
        {
            "gpio": "GPIO45",
            "required_level": "LOW",
            "internal_pull": "LOW",
            "brick_risk": True,
            "note": (
                "VDD_SPI voltage: LOW = 3.3V, HIGH = 1.8V. "
                "WRONG LEVEL BRICKS BOOT with 3.3V flash. "
                "ESP32-S2 datasheet §2.4."
            ),
        },
        {
            "gpio": "GPIO46",
            "required_level": None,
            "internal_pull": "LOW",
            "brick_risk": False,
            "note": (
                "ROM messages: HIGH = print, LOW = silent. Internal pull-down. "
                "ESP32-S2 datasheet §2.4."
            ),
        },
    ],

    # ESP32-C6 Datasheet §2.8 (Espressif 2023, verify against latest revision)
    "c6": [
        {
            "gpio": "GPIO4",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "Boot mode select: HIGH = SPI flash boot; LOW = download mode. "
                "Internal pull-up. "
                "ESP32-C6 datasheet §2.8."
            ),
        },
        {
            "gpio": "GPIO5",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "JTAG signal source select. HIGH = USB-JTAG; LOW = GPIO JTAG. "
                "ESP32-C6 datasheet §2.8."
            ),
        },
        {
            "gpio": "GPIO8",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "ROM log control: HIGH = ROM prints to UART; LOW = silent. "
                "Internal pull-up. "
                "ESP32-C6 datasheet §2.8."
            ),
        },
        {
            "gpio": "GPIO9",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "SPI flash boot (HIGH) vs download mode (LOW). Internal pull-up. "
                "ESP32-C6 datasheet §2.8."
            ),
        },
        {
            "gpio": "GPIO15",
            "required_level": None,
            "internal_pull": "LOW",
            "brick_risk": False,
            "note": (
                "Chip ID / package config pin; behaviour varies by revision. "
                "Verify against current ESP32-C6 datasheet §2.8 before use. "
                "ESP32-C6 datasheet §2.8."
            ),
        },
    ],

    # ESP32-H2 Datasheet §2.8 (v0.5, Espressif 2023 — verify; earliest revision)
    "h2": [
        {
            "gpio": "GPIO8",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "ROM log control: HIGH = ROM prints to UART; LOW = silent. "
                "Internal pull-up. "
                "ESP32-H2 datasheet §2.8 (verify against current datasheet revision)."
            ),
        },
        {
            "gpio": "GPIO9",
            "required_level": "HIGH",
            "internal_pull": "HIGH",
            "brick_risk": False,
            "note": (
                "SPI flash boot (HIGH) vs download mode (LOW). Internal pull-up. "
                "ESP32-H2 datasheet §2.8 (verify against current datasheet revision)."
            ),
        },
    ],
}


# ---------------------------------------------------------------------------
# Pull-resistor value thresholds (Ω)
# ---------------------------------------------------------------------------
PULL_R_MIN_OHMS = 1_000.0   # 1 kΩ — below this, too strong (fights internal pull)
PULL_R_MAX_OHMS = 10_000.0  # 10 kΩ — above this, too weak (noise-sensitive)

# 0 Ω resistor = direct hard-tie (considered equivalent to a wire short)
ZERO_OHM_THRESHOLD = 10.0   # ≤ 10 Ω is treated as 0 Ω / hard tie


# ---------------------------------------------------------------------------
# Variant detection
# ---------------------------------------------------------------------------

# Ordered from most-specific to least, so "ESP32-S3" matches before bare "ESP32".
_VARIANT_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"esp32[\-_]?s3", re.IGNORECASE), "s3"),
    (re.compile(r"esp32[\-_]?s2", re.IGNORECASE), "s2"),
    (re.compile(r"esp32[\-_]?c3", re.IGNORECASE), "c3"),
    (re.compile(r"esp32[\-_]?c6", re.IGNORECASE), "c6"),
    (re.compile(r"esp32[\-_]?h2", re.IGNORECASE), "h2"),
    (re.compile(r"esp32",         re.IGNORECASE), "classic"),
]


def _detect_variant(comp: dict) -> str | None:
    """Return the variant slug ('c3', 's3', 'classic', …) or None if not an ESP32."""
    name = (comp.get("name") or "").strip()
    mfr  = (comp.get("manufacturerId") or "").strip()
    value = ((comp.get("otherProperty") or {}).get("Value") or "").strip()

    for src in (name, mfr, value):
        if not src:
            continue
        for pattern, slug in _VARIANT_PATTERNS:
            if pattern.search(src):
                return slug
    return None


def _is_esp32(comp: dict) -> bool:
    return _detect_variant(comp) is not None


# ---------------------------------------------------------------------------
# Resistor value parsing (reuses the pattern from SCH-10)
# ---------------------------------------------------------------------------
_RES_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmrΩ]|kΩ|mΩ|ohm)?\s*$", re.IGNORECASE)
_RES_UNIT_TO_OHMS: dict[str | None, float] = {
    "k": 1e3, "kΩ": 1e3,
    "m": 1e6, "mΩ": 1e6,
    "r": 1.0, "ohm": 1.0, "Ω": 1.0,
    None: 1.0, "": 1.0,
}


def _parse_ohms(value: str) -> float | None:
    if not value:
        return None
    m = _RES_RE.match(value.strip())
    if not m:
        return None
    unit = (m.group(2) or "").lower() or None
    return float(m.group(1)) * _RES_UNIT_TO_OHMS.get(unit, 1.0)


# ---------------------------------------------------------------------------
# Net-classification helpers
# ---------------------------------------------------------------------------

def _net_is_gnd(net_name: str) -> bool:
    return (net_name or "").upper().startswith("GND")


def _infer_pull_level(net_name: str) -> str | None:
    """Return 'LOW' if the net is GND, 'HIGH' if it's a supply rail, else None."""
    if _net_is_gnd(net_name):
        return "LOW"
    if looks_like_power_rail(net_name):
        return "HIGH"
    return None


# ---------------------------------------------------------------------------
# Walk the strap net and classify what's on it
# ---------------------------------------------------------------------------

def _is_corroborated_power_rail(
    strap_net: str,
    conn_nets: dict[str, list[str]],
    conn_comps: dict[str, dict],
    all_components_by_desig: dict[str, dict],
) -> bool:
    """Return True if the strap net is corroborated as a power rail by at least one of:
    1. The net name is in the canonical power-rail vocabulary (exact match).
    2. A capacitor is on the net (typical decoupling signature of a power rail).
    3. Another IC has a power-named pin on this net.
    """
    # 1. Exact-name match against canonical power-rail set.
    _CANONICAL_RAILS = {
        "+3V3", "3V3", "+3.3V", "3.3V",
        "+5V", "5V",
        "+12V", "12V",
        "VCC", "VDD", "VBUS", "VIN",
        "GND", "AGND", "DGND",
    }
    if strap_net.upper() in _CANONICAL_RAILS:
        return True

    # 2. Any capacitor on the net.
    # 3. Another IC with a power-named pin on this net.
    members = designators_on_net(strap_net, conn_nets)
    for entry in conn_nets.get(strap_net, []):
        # entry format: "DESIG.pinNumber(pinName)"
        dot = entry.find(".")
        paren_open = entry.find("(")
        paren_close = entry.find(")")
        if dot < 0:
            continue
        entry_desig = entry[:dot].upper()
        comp = all_components_by_desig.get(entry_desig)
        if comp is None:
            continue
        fn_type = infer_functional_type(comp)
        if fn_type == "capacitor":
            return True
        if fn_type == "ic" and paren_open >= 0 and paren_close > paren_open:
            pin_name = entry[paren_open + 1:paren_close]
            if is_power_pin_by_name(pin_name):
                return True

    return False


def classify_strap_net(
    strap_net: str,
    esp32_desig: str,
    conn_nets: dict[str, list[str]],
    conn_comps: dict[str, dict],
    all_components_by_desig: dict[str, dict],
) -> dict:
    """Return a classification dict for the strap net.

    Returns:
        {
          "only_esp32": bool,               # True if nothing external on the net
          "pulls": list[dict],              # {desig, ohms, pull_level, value_str}
          "ic_outputs": list[str],          # designators of ICs (not ESP32) with output pins on net
          "has_series_r_on_ic": bool,       # True if any resistor sits between an IC output and the strap pin
          "hard_ties": list[str],           # net names the strap pin is hard-tied to (0Ω R or direct)
          "net_pull_level": str | None,     # pull level inferred from the strap net's own name
          "is_corroborated_rail": bool,     # True if net_pull_level is backed by canonical name/cap/IC-power-pin
        }
    """
    members = designators_on_net(strap_net, conn_nets)

    pulls: list[dict] = []
    ic_outputs: list[str] = []
    has_series_r = False
    hard_ties: list[str] = []
    only_esp32 = True

    for desig in members:
        if desig.upper() == esp32_desig.upper():
            continue  # skip the ESP32 itself
        only_esp32 = False

        comp = all_components_by_desig.get(desig.upper())
        if comp is None:
            continue

        fn_type = infer_functional_type(comp)
        if fn_type == "resistor":
            value_str = parse_value_field(comp)
            ohms = _parse_ohms(value_str)
            # Find which side of the resistor is on the strap net and which on the other net.
            comp_pins = (conn_comps.get(desig.upper(), {}) or {}).get("pins", {}) or {}
            other_nets = {
                pin_data.get("net")
                for pnum, pin_data in comp_pins.items()
                if pin_data.get("net") and pin_data.get("net") != strap_net
            }
            pull_to_level = None
            for other_net in other_nets:
                lvl = _infer_pull_level(other_net or "")
                if lvl is not None:
                    pull_to_level = lvl
                    break

            if ohms is not None and ohms <= ZERO_OHM_THRESHOLD:
                # 0 Ω = hard tie through this resistor
                for other_net in other_nets:
                    hard_ties.append(other_net or "")
                continue

            if pull_to_level is not None:
                # It's a pull resistor (one side on GND or supply)
                pulls.append({
                    "desig": desig.upper(),
                    "ohms": ohms,
                    "pull_level": pull_to_level,
                    "value_str": value_str,
                })
            else:
                # Resistor between two non-power nets = series protection candidate
                has_series_r = True

        elif fn_type == "ic":
            # An external IC (not the ESP32) is on the strap net
            ic_outputs.append(desig.upper())

    # Net-level pull inference (direct-wire-to-rail detection)
    net_pull_level = _infer_pull_level(strap_net)
    is_corroborated = (
        _is_corroborated_power_rail(strap_net, conn_nets, conn_comps, all_components_by_desig)
        if net_pull_level is not None
        else False
    )

    result = {
        "only_esp32": only_esp32,
        "pulls": pulls,
        "ic_outputs": ic_outputs,
        "has_series_r_on_ic": has_series_r,
        "hard_ties": hard_ties,
        "net_pull_level": net_pull_level,
        "is_corroborated_rail": is_corroborated,
    }
    return result


# ---------------------------------------------------------------------------
# The check
# ---------------------------------------------------------------------------

@register
class SchEsp32Strapping(Check):
    id = "SCH-11"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        parts = (
            client.sch_get_all_components(document, component_type="part") or {}
        ).get("items", [])

        # Detect all ESP32 ICs
        esp32_parts = [c for c in parts if _is_esp32(c)]
        if not esp32_parts:
            return []

        # Build a flat index for cheap lookup
        all_by_desig: dict[str, dict] = {
            (c.get("designator") or "").upper(): c
            for c in parts
            if c.get("designator")
        }

        # Warn on ambiguous/unidentifiable variants separately from main loop
        findings: list[dict] = []

        # Fetch full connectivity
        conn = (
            client.sch_get_connectivity(document, depth=2) or {}
        )
        conn_nets: dict[str, list[str]] = conn.get("nets", {}) or {}
        conn_comps: dict[str, dict] = conn.get("components", {}) or {}

        for comp in esp32_parts:
            desig = (comp.get("designator") or "?").upper()
            variant = _detect_variant(comp)

            if variant is None:
                # Should not happen given _is_esp32 passed, but guard anyway
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=(
                            f"{desig}: ESP32 variant could not be determined. "
                            "Specify the manufacturer part number (e.g. ESP32-C3-MINI-1) "
                            "in the component's manufacturerId field."
                        ),
                        offending_ids=[desig],
                        suggestion=(
                            "Set the manufacturerId or component name to include the exact "
                            "variant (ESP32-C3, ESP32-S3, etc). Strapping-pin checks skipped."
                        ),
                    ).to_dict()
                )
                continue

            strap_pins = STRAPPING_PINS.get(variant, [])
            comp_pins = (conn_comps.get(desig, {}) or {}).get("pins", {}) or {}

            # Build gpio → net map for this ESP32
            gpio_to_net: dict[str, str] = {}
            for _pnum, pin_data in comp_pins.items():
                pin_name = (pin_data.get("name") or "").strip()
                normalised = _normalise_gpio(pin_name)
                if normalised:
                    gpio_to_net[normalised] = pin_data.get("net") or ""

            for strap in strap_pins:
                gpio = strap["gpio"]  # e.g. "GPIO2"
                strap_net = gpio_to_net.get(gpio)

                if strap_net is None:
                    # Pin not visible in connectivity — it may be unconnected (NC) on
                    # the symbol. Emit info so the designer can verify.
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="info",
                            message=(
                                f"{desig} ({variant.upper()}): {gpio} not visible in "
                                "schematic connectivity — verify it is left unconnected "
                                "(internal pull applies) and not accidentally shared."
                            ),
                            offending_ids=[f"{desig}.{gpio}"],
                            suggestion=strap["note"],
                        ).to_dict()
                    )
                    continue

                if not strap_net:
                    # Empty string net = floating/NC in connectivity
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="info",
                            message=(
                                f"{desig} ({variant.upper()}): {gpio} is unconnected "
                                "(default internal pull applies)."
                            ),
                            offending_ids=[f"{desig}.{gpio}"],
                            suggestion=strap["note"],
                        ).to_dict()
                    )
                    continue

                classification = classify_strap_net(
                    strap_net,
                    desig,
                    conn_nets,
                    conn_comps,
                    all_by_desig,
                )

                required = strap["required_level"]
                brick = strap["brick_risk"]

                # ── Case 0: direct wire to a power/GND rail ──────────────────
                # When the strap pin's net IS a power rail (schematic wires it
                # directly to a VCC/GND symbol), the net name itself reveals the
                # hard-tie level. This must fire before Case 1 (only_esp32) which
                # would otherwise emit a benign info and mask the brick.
                net_pull = classification["net_pull_level"]
                if net_pull is not None and required is not None and net_pull != required:
                    if classification["is_corroborated_rail"]:
                        brick_suffix = " BRICK RISK." if brick else ""
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="error",
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} is wired directly "
                                    f"to rail {strap_net!r} ({net_pull}) but must be "
                                    f"{required} for normal boot.{brick_suffix}"
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})"],
                                suggestion=strap["note"],
                            ).to_dict()
                        )
                        continue  # skip further analysis on a merged power net
                    else:
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="warn",
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} is on net "
                                    f"{strap_net!r} whose name resembles a rail ({net_pull}) "
                                    f"but is not corroborated by a cap or IC power pin — "
                                    "verify this is not a hard-tie to a power rail."
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})"],
                                suggestion=strap["note"],
                            ).to_dict()
                        )
                        continue  # further pull/IC analysis on this net would be noise

                # ── Case 1: only the ESP32 is on this net ────────────────────
                if classification["only_esp32"]:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="info",
                            message=(
                                f"{desig} ({variant.upper()}): {gpio} on net {strap_net!r} "
                                "with no external components — internal default applies."
                            ),
                            offending_ids=[f"{desig}.{gpio}({strap_net})"],
                            suggestion=strap["note"],
                        ).to_dict()
                    )
                    continue

                # ── Case 2: hard tie through a 0 Ω resistor ─────────────────
                for hard_net in classification["hard_ties"]:
                    hard_level = _infer_pull_level(hard_net)
                    if required is not None and hard_level and hard_level != required:
                        sev = "error"
                        brick_suffix = " This will BRICK the board." if brick else ""
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity=sev,
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} is hard-tied "
                                    f"(0 Ω) to {hard_net!r} ({hard_level}) but must be "
                                    f"{required} for normal boot.{brick_suffix}"
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})"],
                                suggestion=strap["note"],
                            ).to_dict()
                        )

                # ── Case 3: external IC output on the strap net ──────────────
                if classification["ic_outputs"] and not classification["has_series_r_on_ic"]:
                    ic_list = ", ".join(classification["ic_outputs"])
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=(
                                f"{desig} ({variant.upper()}): {gpio} strap net {strap_net!r} "
                                f"is driven by IC output(s) [{ic_list}] with no series "
                                "resistor (1 kΩ–10 kΩ required). The driver output will "
                                "fight the internal boot strap — undefined boot state."
                            ),
                            offending_ids=[f"{desig}.{gpio}({strap_net})"] + classification["ic_outputs"],
                            suggestion=(
                                f"Add a 4.7 kΩ series resistor between {ic_list} output "
                                f"and {gpio} so the internal strap level can be set by an "
                                "external pull before the driver takes over at runtime. "
                                + strap["note"]
                            ),
                        ).to_dict()
                    )

                # ── Case 4: pull resistors ────────────────────────────────────
                for pull in classification["pulls"]:
                    ohms = pull["ohms"]
                    pull_level = pull["pull_level"]
                    r_desig = pull["desig"]
                    val_str = pull["value_str"]

                    if ohms is None:
                        # Unknown value — warn to verify
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="warn",
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} has pull "
                                    f"resistor {r_desig} with unparseable value "
                                    f"{val_str!r}. Verify it is within 1 kΩ–10 kΩ."
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})", r_desig],
                                suggestion=strap["note"],
                            ).to_dict()
                        )
                        continue

                    if ohms < PULL_R_MIN_OHMS:
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="warn",
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} pull "
                                    f"resistor {r_desig} is {val_str} ({ohms:.0f} Ω) — "
                                    f"below 1 kΩ minimum. This fights the internal "
                                    f"{strap['internal_pull']} pull and may cause "
                                    "excessive current or boot-level conflict."
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})", r_desig],
                                suggestion=(
                                    "Use a pull resistor in the 1 kΩ–10 kΩ range for "
                                    "strap pins. " + strap["note"]
                                ),
                            ).to_dict()
                        )
                        continue

                    if ohms > PULL_R_MAX_OHMS:
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="warn",
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} pull "
                                    f"resistor {r_desig} is {val_str} ({ohms:.0f} Ω) — "
                                    "above 10 kΩ maximum. Too weak: noise may "
                                    "override the intended strap level."
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})", r_desig],
                                suggestion=(
                                    "Use a pull resistor in the 1 kΩ–10 kΩ range for "
                                    "strap pins. " + strap["note"]
                                ),
                            ).to_dict()
                        )
                        continue

                    # Value is in 1 kΩ–10 kΩ: check the direction
                    if required is not None and pull_level != required:
                        brick_suffix = " BRICK RISK." if brick else ""
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="warn",
                                message=(
                                    f"{desig} ({variant.upper()}): {gpio} pull "
                                    f"resistor {r_desig} ({val_str}) pulls {pull_level} "
                                    f"but boot requires {required}.{brick_suffix} "
                                    "This will configure the wrong boot mode."
                                ),
                                offending_ids=[f"{desig}.{gpio}({strap_net})", r_desig],
                                suggestion=strap["note"],
                            ).to_dict()
                        )
                    # else: pull is in range and in the right direction — pass (no finding)

        return findings


# ---------------------------------------------------------------------------
# GPIO name normalisation helper
# ---------------------------------------------------------------------------

# Matches a single GPIO token: GPIO45, IO45, GPIO_45, GPIO-45, IO_12, etc.
_GPIO_TOKEN_RE = re.compile(r"^(?:GPIO|IO)[_-]?(\d+)$")


def _normalise_gpio(name: str) -> str | None:
    """Convert pin names like 'GPIO2', 'IO2', 'GPIO45/SPICS1_VDD_SPI',
    'IO12/MTDI', 'GPIO12(VDD_SDIO)', or bare '2' to 'GPIO2'.
    Returns None if the name doesn't unambiguously map to a single GPIO.

    Design decisions:
    - Splits on delimiters that separate pin functions on ESP32 symbols.
    - Bare integers must be a full-token match (not a prefix of '3V3').
    - Multiple GPIO tokens in one name returns None (schematic-symbol bug).
    """
    tokens = re.split(r"[/(),\s]+", name.upper().strip())
    matches: set[str] = set()
    for tok in tokens:
        if not tok:
            continue
        m = _GPIO_TOKEN_RE.match(tok)
        if m:
            matches.add(f"GPIO{m.group(1)}")
            continue
        # Bare integer: full token match only
        if tok.isdigit():
            matches.add(f"GPIO{tok}")
    if len(matches) == 1:
        return matches.pop()
    return None  # ambiguous (multiple GPIOs) or no match
