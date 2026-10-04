"""SCH-09: ULN2003 / TPL7407 COM pin must be tied to the motor supply.

The COM pin is the common cathode of the driver's internal flyback diodes.
Floating COM = no clamp path for inductive kickback from the stepper coils
= the driver dies on the first stepping pulse. On TPL7407L there is an
additional constraint: COM feeds the internal gate regulator, so a COM
supply below 6.5V degrades drive strength (specified in the TI TPL7407LA
datasheet §Recommended Operating Conditions).

Rules enforced:
1. Every ULN2003 or TPL7407* variant on the board must have its COM pin
   connected to a rail whose name looks like a motor/high-side supply
   (VMOTOR, VM, VS, +5V and up, VIN, +12V, etc). NOT floating, NOT GND.
2. If the connected rail is a known low-voltage rail (+3V3, +1V8, +2V5) →
   ERROR: the driver won't clamp usefully at that voltage.
3. On TPL7407L specifically, WARN if the rail is under 6.5V (works but
   degraded).

Source: TI TPL7407LA datasheet §7.4 Power Supply Recommendations; TI
ULN2003A datasheet §Absolute Maximum Ratings and §7.2 Typical
Applications; TI E2E "ULN2003A voltage spikes from stepper motor".
"""

from __future__ import annotations

import re
from typing import Any

from .base import Check, Finding, register
from .types import infer_functional_type


# Substring match on component `name`; case-insensitive. Extend as new
# darlington/high-side arrays are used.
DRIVER_NAMES: dict[str, dict] = {
    "uln2003": {"min_com_v": 5.0,  "notes": "ULN2003A common-cathode of internal flyback diodes"},
    "uln2803": {"min_com_v": 5.0,  "notes": "ULN2803A common-cathode of internal flyback diodes"},
    "tpl7407": {"min_com_v": 6.5,  "notes": "TPL7407L COM feeds internal gate regulator; 6.5V min for full drive"},
}


# Rail-name patterns for what counts as a "motor supply".
MOTOR_RAIL_PATTERNS = (
    re.compile(r"(?:^|_|\+)V(?:MOTOR|M|S)(?:$|_|\d)",  re.IGNORECASE),
    re.compile(r"(?:^|_|\+)VIN(?:$|_|\d)",             re.IGNORECASE),
    re.compile(r"(?:^|_|\+)5V(?:$|_|\d)",              re.IGNORECASE),
    re.compile(r"(?:^|_|\+)12V(?:$|_|\d)",             re.IGNORECASE),
    re.compile(r"(?:^|_|\+)24V(?:$|_|\d)",             re.IGNORECASE),
    re.compile(r"(?:^|_|\+)VBUS(?:$|_|\d)",            re.IGNORECASE),
)


LOW_VOLTAGE_RAIL_PATTERNS = (
    re.compile(r"(?:^|_|\+)3\.?3V?3?(?:$|_|\d)", re.IGNORECASE),
    re.compile(r"(?:^|_|\+)1\.?8V?8?(?:$|_|\d)", re.IGNORECASE),
    re.compile(r"(?:^|_|\+)2\.?5V?5?(?:$|_|\d)", re.IGNORECASE),
    re.compile(r"(?:^|_|\+)3V3(?:$|_|\d)",       re.IGNORECASE),
    re.compile(r"(?:^|_|\+)1V8(?:$|_|\d)",       re.IGNORECASE),
)


def _match_driver(name: str) -> tuple[str, dict] | None:
    n = (name or "").lower()
    for key, meta in DRIVER_NAMES.items():
        if key in n:
            return key, meta
    return None


def _looks_like_motor_rail(net: str) -> bool:
    return any(p.search(net) for p in MOTOR_RAIL_PATTERNS)


def _looks_like_low_voltage_rail(net: str) -> bool:
    return any(p.search(net) for p in LOW_VOLTAGE_RAIL_PATTERNS)


@register
class SchDriverComPin(Check):
    id = "SCH-09"
    default_severity = "error"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        document = config.get("document") or ""
        parts = (client.sch_get_all_components(document, component_type="part") or {}).get("items", [])
        drivers = []
        for c in parts:
            if infer_functional_type(c) != "ic":
                continue
            hit = _match_driver(c.get("name") or "")
            if hit:
                drivers.append((c, hit))
        if not drivers:
            return []

        conn = client.sch_get_connectivity(
            document,
            designators=[d[0].get("designator") for d in drivers if d[0].get("designator")],
            depth=1,
        ) or {}
        conn_comps = conn.get("components", {}) or {}

        findings: list[dict] = []
        for driver, (family, meta) in drivers:
            desig = (driver.get("designator") or "?").upper()
            pins = (conn_comps.get(desig, {}) or {}).get("pins", {}) or {}
            com_pin_num = None
            com_net = None
            for pnum, pin in pins.items():
                if (pin.get("name") or "").upper() == "COM":
                    com_pin_num = pnum
                    com_net = pin.get("net") or ""
                    break

            if com_pin_num is None:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="warn",
                        message=f"{desig} ({family}): no COM pin found in connectivity",
                        offending_ids=[desig],
                        suggestion="Verify the symbol pin naming matches the datasheet (pin should be labelled COM).",
                    ).to_dict()
                )
                continue

            if not com_net:
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=f"{desig} ({family}) COM pin is FLOATING — no flyback clamp path, driver will die on first inductive kick",
                        offending_ids=[f"{desig}.{com_pin_num}"],
                        suggestion=f"Tie {desig}.COM to the motor supply rail (VMOTOR / VM / VIN etc, {meta['min_com_v']}V minimum). {meta['notes']}.",
                    ).to_dict()
                )
                continue

            if com_net.upper().startswith("GND"):
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=f"{desig} ({family}) COM pin tied to GND — no flyback clamp path, driver will die",
                        offending_ids=[f"{desig}.{com_pin_num}({com_net})"],
                        suggestion=f"Tie {desig}.COM to the motor supply rail (VMOTOR / VM / VIN etc). {meta['notes']}.",
                    ).to_dict()
                )
                continue

            if _looks_like_low_voltage_rail(com_net):
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="error",
                        message=f"{desig} ({family}) COM tied to low-voltage rail {com_net} — won't clamp the motor supply",
                        offending_ids=[f"{desig}.{com_pin_num}({com_net})"],
                        suggestion=(
                            f"COM must clamp the MOTOR supply, not a logic rail. Move to the motor rail "
                            f"(≥{meta['min_com_v']}V for this family)."
                        ),
                    ).to_dict()
                )
                continue

            if not _looks_like_motor_rail(com_net):
                # Unknown-rail: emit info, don't hard-fail. The designer may have
                # a valid rail with an unusual name.
                findings.append(
                    Finding(
                        check_id=self.id,
                        severity="info",
                        message=f"{desig} ({family}) COM pin on unrecognised rail {com_net}; verify it is the motor supply (≥{meta['min_com_v']}V)",
                        offending_ids=[f"{desig}.{com_pin_num}({com_net})"],
                        suggestion="Rename the rail to something like VMOTOR/VM/VIN so this check can auto-verify next run, or waive with rationale in decisions.md.",
                    ).to_dict()
                )
                # No 'continue' — fall through to TPL7407L 6.5V warn if the
                # unrecognised rail is a known low-V rail (already handled above).

        return findings
