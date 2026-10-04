"""SCH-10: USB-C sink needs a separate 5.1 kΩ Rd pull-down on EACH of CC1 and CC2.

Without them the board gets NO VBUS at all from a C-to-C cable or a USB-C
charger (it works on A-to-C, fails on C-to-C — the classic "works on my
bench" trap). A single shared resistor between CC1 and CC2 fails with
e-marked / active cables because of the cable's Ra.

Rule enforced:
- For every USB-C receptacle on the board, the CC1 and CC2 pins must EACH
  have their own resistor to GND with a value close to 5.1 kΩ (accepts
  4.7 kΩ to 5.6 kΩ). A single resistor spanning both pins is FLAGGED
  because it fails with e-marked cables.

Source: Infineon KBA "USB Type-C connector — Rp, Rd and Ra termination
resistors"; USB Type-C Specification §4.5.1.2.2 Sink CC Requirements.
"""

from __future__ import annotations

import re
from typing import Any

from .base import Check, Finding, register
from .types import designators_on_net, infer_functional_type, parse_value_field


# USB-C receptacle heuristics: component name substring or footprint hint.
USBC_NAME_HINTS = ("usb-c", "usb_c", "usbc", "usb type-c", "typec", "type-c")

CC_PIN_NAMES = {"CC", "CC1", "CC2"}

# Accept 5.1k ± ~10%, so 4.7k / 5.1k / 5.6k all pass.
CC_RD_ACCEPTABLE_OHMS = (4_700.0, 5_600.0)


_RES_RE = re.compile(r"^\s*(\d+(?:\.\d+)?)\s*([kmr]|kΩ|mΩ|ohm|Ω)?\s*$", re.IGNORECASE)
_RES_UNIT_TO_OHMS = {"k": 1e3, "m": 1e6, "kΩ": 1e3, "mΩ": 1e6, "r": 1.0, "ohm": 1.0, "Ω": 1.0, None: 1.0, "": 1.0}


def _parse_ohms(value: str) -> float | None:
    if not value:
        return None
    m = _RES_RE.match(value.strip())
    if not m:
        return None
    return float(m.group(1)) * _RES_UNIT_TO_OHMS.get((m.group(2) or "").lower(), 1.0)


def _looks_like_usbc(comp: dict) -> bool:
    name = (comp.get("name") or "").lower()
    other = comp.get("otherProperty") or {}
    footprint = (other.get("Footprint") or "").lower()
    for hint in USBC_NAME_HINTS:
        if hint in name or hint in footprint:
            return True
    return False


@register
class SchUsbcCCResistors(Check):
    id = "SCH-10"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])

        # USB-C receptacles: connectors by designator prefix AND name hint.
        usbc_connectors = [
            c for c in parts
            if infer_functional_type(c) == "connector" and _looks_like_usbc(c)
        ]
        if not usbc_connectors:
            return []

        conn = client.sch_get_connectivity(
            document,
            designators=[c.get("designator") for c in usbc_connectors if c.get("designator")],
            depth=1,
        ) or {}
        conn_nets = conn.get("nets", {}) or {}
        conn_comps = conn.get("components", {}) or {}

        # Map resistor designator → parsed ohms + net set
        resistor_by_desig: dict[str, dict] = {}
        for c in parts:
            if infer_functional_type(c) != "resistor":
                continue
            d = (c.get("designator") or "").upper()
            if not d:
                continue
            resistor_by_desig[d] = {
                "ohms": _parse_ohms(parse_value_field(c)),
                "pin_nets": {},
            }
            rp_pins = (conn_comps.get(d, {}) or {}).get("pins", {}) or {}
            for pnum, pin in rp_pins.items():
                if pin.get("net"):
                    resistor_by_desig[d]["pin_nets"][pnum] = pin["net"]

        findings: list[dict] = []

        for usbc in usbc_connectors:
            desig = (usbc.get("designator") or "?").upper()
            pins = (conn_comps.get(desig, {}) or {}).get("pins", {}) or {}

            cc_nets: dict[str, str] = {}
            for pnum, pin in pins.items():
                pname = (pin.get("name") or "").upper()
                if pname in CC_PIN_NAMES and pname != "CC":
                    cc_nets[pname] = pin.get("net") or ""

            if not cc_nets:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=f"{desig} appears to be a USB-C connector but has no CC1/CC2 pin visible in connectivity",
                        offending_ids=[desig],
                        suggestion="Verify the symbol has both CC1 and CC2 pins named per the datasheet.",
                    ).to_dict()
                )
                continue

            # For each CC pin, its net must have a dedicated resistor to GND in 4.7k–5.6k.
            cc_resistors: dict[str, str] = {}
            for cc_name, cc_net in cc_nets.items():
                if not cc_net:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=f"{desig}.{cc_name} is FLOATING — no VBUS from a C-to-C cable",
                            offending_ids=[f"{desig}.{cc_name}"],
                            suggestion=f"Add a 5.1 kΩ resistor from {desig}.{cc_name} to GND (separate resistor per CC pin).",
                        ).to_dict()
                    )
                    continue

                candidates: list[str] = []
                for sibling in designators_on_net(cc_net, conn_nets):
                    if sibling.upper() == desig:
                        continue
                    if not sibling.upper().startswith("R"):
                        continue
                    r = resistor_by_desig.get(sibling.upper())
                    if not r:
                        continue
                    other_nets = {n for pnum, n in r["pin_nets"].items() if n != cc_net}
                    if not any(n.upper().startswith("GND") for n in other_nets):
                        continue
                    ohms = r.get("ohms")
                    if ohms is None or not (CC_RD_ACCEPTABLE_OHMS[0] <= ohms <= CC_RD_ACCEPTABLE_OHMS[1]):
                        findings.append(
                            Finding(
                                check_id=self.id,
                                severity="warn",
                                message=f"{desig}.{cc_name} pulldown {sibling} is {ohms}Ω, should be 5.1kΩ (4.7-5.6kΩ)",
                                offending_ids=[f"{desig}.{cc_name}", sibling],
                                suggestion="Change to a 5.1 kΩ ±20% resistor per the USB-C sink Rd spec.",
                            ).to_dict()
                        )
                        continue
                    candidates.append(sibling.upper())

                if not candidates:
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=f"{desig}.{cc_name} ({cc_net}) has NO 5.1 kΩ Rd to GND — no VBUS from a C-to-C cable or USB-C charger",
                            offending_ids=[f"{desig}.{cc_name}({cc_net})"],
                            suggestion=f"Add a 5.1 kΩ resistor from {cc_net} to GND. Every USB-C CC pin needs its OWN Rd; one shared resistor fails with e-marked cables.",
                        ).to_dict()
                    )
                else:
                    cc_resistors[cc_name] = candidates[0]

            # Both CC pins must have DIFFERENT resistors (no shared pull-down).
            if len(cc_resistors) >= 2:
                values = list(cc_resistors.values())
                if len(set(values)) == 1:
                    shared = values[0]
                    findings.append(
                        Finding(
                            check_id=self.id,
                            severity="error",
                            message=f"{desig}: CC1 and CC2 SHARE {shared} — fails with e-marked / active USB-C cables",
                            offending_ids=[f"{desig}.CC1", f"{desig}.CC2", shared],
                            suggestion="Replace with two separate 5.1 kΩ resistors, one per CC pin. Do not share.",
                        ).to_dict()
                    )

        return findings
