"""MCP response shapes as they actually arrive from the fork.

Reconciled with a live Phase 1.5 run against SplitFlap-v2-Wireless-v3
Board1 on 2026-07-20. Any drift found later fixed here in one place.

Kept as TypedDict rather than Pydantic to stay lightweight; validation
happens implicitly via `.get()` + defensive defaults in each check.
"""

from __future__ import annotations

from typing import Literal, TypedDict


# Nets whose name matches these patterns are treated as power rails.
PowerRailPatterns = (
    "VCC", "VDD", "VBAT", "VBUS", "VIN", "VOUT", "VREF",
    "AVCC", "AVDD", "DVCC", "DVDD", "VMOTOR", "VSYS",
    "+3V3", "+5V", "+12V", "-12V", "+1V8", "+2V5", "+3.3V",
    "3V3", "5V", "12V",
)


# Designator-prefix heuristics for functional type inference (there is
# no functional-type field on real MCP components; only structural
# `componentType` = "part" | "sheet" | "netflag" | ...).
_PREFIX_TO_TYPE: tuple[tuple[tuple[str, ...], str], ...] = (
    (("LED",), "led"),
    (("CN", "J", "P"), "connector"),
    (("F",), "fuse"),
    (("TP",), "testpoint"),
    (("FID",), "fiducial"),
    (("MK", "MH", "H"), "mechanical"),
    (("C",), "capacitor"),
    (("R",), "resistor"),
    (("L",), "inductor"),
    (("D",), "diode"),
    (("Y", "X"), "crystal"),
    (("Q",), "transistor"),
    (("U", "IC"), "ic"),
)


class RealComponent(TypedDict, total=False):
    primitiveId: str
    componentType: str  # "part" | "sheet" | "netflag" | "netport" | ...
    designator: str
    name: str  # part name; sometimes just the value (e.g. "10uH")
    supplierId: str  # LCSC C-number, e.g. "C14663"
    manufacturerId: str  # manufacturer part number
    otherProperty: dict  # rich metadata including "Value" and "JLCPCB Part Class"
    x: float
    y: float


class RealPin(TypedDict, total=False):
    primitiveId: str
    pinNumber: str
    pinName: str
    pinType: str  # "Undefined" | "IN" | "OUT" — NOT a power/input/output distinction
    net: str
    noConnected: bool
    x: float
    y: float


class RealDRCResult(TypedDict, total=False):
    passed: bool
    errors: list[dict]
    warnings: list[dict]  # not present on all builds


class RealBOMLine(TypedDict, total=False):
    # Real EasyEDA BOM template columns:
    No: str
    Designator: str
    Quantity: str
    Comment: str
    Footprint: str
    Value: str
    Manufacturer_Part: str  # actual column key is "Manufacturer Part" (with space)
    Manufacturer: str
    Supplier_Part: str  # actual column key is "Supplier Part" (with space)
    Supplier: str


class RealConnectivity(TypedDict, total=False):
    note: str
    nets: dict[str, list[str]]  # netName → ["designator.pinNumber(pinName)", ...]
    components: dict[str, dict]  # designator → {part, pins: {pinNumber: {name, net}}}


# ------ Helpers used by checks ------

def infer_functional_type(component: dict) -> str:
    """Infer 'ic' | 'capacitor' | 'regulator' | ... from a real component.

    Priority:
    1. Non-part componentType (sheet/netflag/etc) → "structural"
    2. Jumpers-that-look-like-ICs: name starts with "Jumper" or
       footprint starts with "HDR-" → "jumper"
    3. Regulator detection: designator U*, otherProperty.Topology in
       {Buck, Boost, LDO, Buck-boost} or name matches known LDO prefixes
       → "regulator"
    4. Designator prefix map (LED before D, CN before C, TP before T, etc)
    5. Fallback: "other"
    """
    ctype = (component.get("componentType") or "").lower()
    if ctype and ctype != "part":
        return "structural"

    designator = (component.get("designator") or "").upper()
    name = (component.get("name") or "").lower()
    other = component.get("otherProperty") or {}

    # Jumper filter: U-prefix Jumper2 headers are not ICs
    if name.startswith("jumper") or "hdr-" in name.lower():
        return "jumper"

    # Regulator detection (U-prefix + regulator metadata)
    if designator.startswith(("U", "IC")):
        topology = (other.get("Topology") or "").lower()
        if topology in {"buck", "boost", "buck-boost", "ldo"}:
            return "regulator"
        # LDO name heuristics (AMS1117, AP7343, LM2596, MP1584, etc.)
        for stem in ("ams1117", "ap7343", "ap2112", "lm2596", "mp1584", "mp2307", "tps5", "lp5907"):
            if stem in name:
                return "regulator"

    for prefixes, fn_type in _PREFIX_TO_TYPE:
        if designator.startswith(prefixes):
            return fn_type

    return "other"


def parse_value_field(component: dict) -> str:
    """Return the component's value string, or empty. Value can live in:
    - otherProperty.Value  (most common)
    - name field (value-only parts like L1 name='10uH')
    """
    other = component.get("otherProperty") or {}
    v = (other.get("Value") or "").strip()
    if v:
        return v
    # Some parts put value in the name (e.g. L1: name="10uH", "22uF" caps)
    return (component.get("name") or "").strip()


def is_power_pin_by_name(pin_name: str) -> bool:
    """Power-pin detection falls back to name matching only; pinType
    vocabulary in real MCP is Undefined/IN/OUT with no power distinction.
    """
    if not pin_name:
        return False
    n = pin_name.upper().strip().lstrip("+-")
    return any(n == p.lstrip("+-") or n.startswith(p.lstrip("+-")) for p in PowerRailPatterns)


def looks_like_power_rail(net_name: str) -> bool:
    """Heuristic: is this net name a power/reference rail?"""
    if not net_name:
        return False
    n = net_name.upper().strip().lstrip("+-")
    return any(n == p.lstrip("+-") or n.startswith(p.lstrip("+-")) for p in PowerRailPatterns)


# ------ Connectivity helpers (shared by SCH-* checks) ------


def designators_on_net(net_name: str, conn_nets: dict[str, list[str]]) -> list[str]:
    """Extract designators from connectivity entries like 'C7.2(2)' on a net."""
    designators: list[str] = []
    for entry in conn_nets.get(net_name, []):
        dot = entry.find(".")
        if dot > 0:
            designators.append(entry[:dot])
    return designators


def find_regulator_output_net(
    reg_desig: str,
    conn_comps: dict,
    conn_nets: dict,
) -> tuple[str | None, str]:
    """Identify a regulator's output net. Returns (net_name, how_detected)
    or (None, reason).

    Detection order:
    1. Direct VOUT/OUT pin — LDOs and any regulator with an explicit output
       pin (AMS1117, AP2112, LP5907, etc). Net is the pin's net.
    2. SW pin → inductor → output — switching bucks like MP1584 / MP2307 /
       LM2596 / TPS54331 have no output pin; the output copper is post-
       inductor from the SW node. Trace SW's net, find a component with an
       'L*' designator on it, take the inductor's other-side net.

    Path 2 is what makes this callable from SCH-08's overvoltage check
    against switching bucks. Without it, SCH-08 misses exactly the class
    of hazard it was built for (the Splitflap-v2 Board1 MP1584 4.43V
    incident, 2026-07-20).
    """
    comp = conn_comps.get(reg_desig, {})
    pins = comp.get("pins", {}) or {}

    for pin_number, pin in pins.items():
        name = (pin.get("name") or "").upper()
        if name.startswith(("VOUT", "OUT")):
            return pin.get("net") or None, f"direct pin {reg_desig}.{pin_number}({name})"

    for pin_number, pin in pins.items():
        name = (pin.get("name") or "").upper()
        if name != "SW":
            continue
        sw_net = pin.get("net") or ""
        if not sw_net:
            continue
        for sibling in designators_on_net(sw_net, conn_nets):
            if not sibling.upper().startswith("L"):
                continue
            ind_comp = conn_comps.get(sibling, {})
            ind_pins = ind_comp.get("pins", {}) or {}
            for ip_num, ip in ind_pins.items():
                ip_net = ip.get("net") or ""
                if ip_net and ip_net != sw_net:
                    return ip_net, f"traced {reg_desig}.SW → {sibling}.{ip_num}"
        return None, f"SW pin found on {reg_desig} but no inductor on {sw_net}"

    return None, f"no VOUT/OUT/SW pin identifiable on {reg_desig}"


# ------ PCB (Phase 2) ------

# Standard EasyEDA Pro layer IDs (from live probe on Splitflap-v2 PCB1, 2026-07-20).
class Layer:
    TOP = 1
    BOTTOM = 2
    TOP_SILK = 3
    BOTTOM_SILK = 4
    TOP_MASK = 5
    BOTTOM_MASK = 6
    TOP_PASTE = 7
    BOTTOM_PASTE = 8
    TOP_ASSEMBLY = 9
    BOTTOM_ASSEMBLY = 10
    BOARD_OUTLINE = 11
    MULTI_LAYER = 12  # THT pads live here
    DOCUMENT = 13
    MECHANICAL = 14


# Default 2-layer board thickness in mm (JLCPCB default; override per project).
DEFAULT_BOARD_THICKNESS_MM = 1.6


# EasyEDA PCB coord + dimension units are MILS (see memory reference_easyeda_pcb_mil_coords.md).
# 1 mm = 39.37 mil
MM_TO_MIL = 39.37
MIL_TO_MM = 1 / MM_TO_MIL

# Pad solder-mask expansion (pad.solderMaskAndPasteMaskExpansion.{top,bottom}SolderMask)
# is NOT in mil or mm. EasyEDA Pro's MCP returns it in units of 1/100 inch:
# 1 unit = 10 mil = 0.254 mm. Verified on a real board: the UI showed an expansion
# of 0.051 mm while the MCP returned topSolderMask = 0.2 (0.2 x 0.254 = 0.0508 mm).
# Typical real raw values are 0.2 to 0.5 (2 to 5 mil). Pad sizes, holes and x/y in
# the same struct ARE in mil; the mask field is the odd one out.
MASK_UNIT_MIL = 10.0
MASK_UNIT_MM = 0.254

# One real footprint (SOD-323, JLC C191023) returned topSolderMask = 2, which is an
# implausible 20 mil under the x10 rule but a normal 2 mil read as plain mil. So the
# unit may vary between footprints. Raw values above this are "unit-ambiguous"
# (> 15 mil under x10); checks keep the x10 reading but flag the pad for a human.
MASK_AMBIGUOUS_RAW = 1.5


def mask_raw_to_mil(raw: float) -> float:
    """Convert a raw MCP solder-mask expansion value to mil (x10 rule)."""
    return float(raw) * MASK_UNIT_MIL


def mask_raw_to_mm(raw: float) -> float:
    """Convert a raw MCP solder-mask expansion value to mm (x0.254 rule)."""
    return float(raw) * MASK_UNIT_MM


def mask_raw_is_ambiguous(raw: float) -> bool:
    """True if the raw value is too large to be a plausible x10 expansion."""
    return float(raw) > MASK_AMBIGUOUS_RAW


class RealVia(TypedDict, total=False):
    primitiveId: str
    primitiveType: str  # "Via"
    net: str
    x: float
    y: float
    holeDiameter: float  # mils
    diameter: float  # mils (outer pad diameter)
    viaType: int


class RealPad(TypedDict, total=False):
    primitiveId: str
    primitiveType: str  # "Pad"
    layer: int  # 1=top, 2=bottom, 12=multi (THT)
    padNumber: str
    x: float
    y: float
    pad: list  # ["ELLIPSE"|"RECT"|..., w_mil, h_mil]
    hole: list  # ["ROUND", drill_mil] or None for SMD
    net: str
    metallization: bool
    solderMaskAndPasteMaskExpansion: dict  # {topSolderMask, bottomSolderMask, topPasteMask, bottomPasteMask}


class RealPCBComponent(TypedDict, total=False):
    primitiveId: str
    primitiveType: str
    layer: int  # 1=top, 2=bottom
    designator: str
    footprint: dict  # {name, uuid}
    pads: list[dict]


def annular_ring_mil(outer_mil: float, hole_mil: float) -> float:
    """Annular ring (each side, in mils) = (outer_diameter - hole_diameter) / 2."""
    return (outer_mil - hole_mil) / 2.0


def pad_annular_ring_mil(pad: dict) -> float | None:
    """Return annular-ring (each side, mil) for a plated THT pad. None if not THT."""
    hole = pad.get("hole") or []
    if not hole or len(hole) < 2:
        return None
    drill = hole[1]
    pad_geom = pad.get("pad") or []
    if len(pad_geom) < 2:
        return None
    # Use the smaller of width/height for the tightest annular
    dims = [x for x in pad_geom[1:] if isinstance(x, (int, float))]
    if not dims:
        return None
    outer = min(dims)
    return annular_ring_mil(outer, drill)


def is_silk_layer(layer_id: int) -> bool:
    return layer_id in (Layer.TOP_SILK, Layer.BOTTOM_SILK)


def is_copper_layer(layer_id: int) -> bool:
    return layer_id == Layer.TOP or layer_id == Layer.BOTTOM or layer_id >= 15


# ------ PCB geometry helpers (Phase 3) ------

import math


def distance_mil(x1: float, y1: float, x2: float, y2: float) -> float:
    return math.hypot(x2 - x1, y2 - y1)


def segment_orientation(x1: float, y1: float, x2: float, y2: float) -> str:
    """'H' if approximately horizontal, 'V' if approximately vertical, 'D' otherwise (diagonal / 45°)."""
    dx = abs(x2 - x1)
    dy = abs(y2 - y1)
    if dx < 1e-3 and dy < 1e-3:
        return "P"  # point
    if dy < dx * 0.05:
        return "H"
    if dx < dy * 0.05:
        return "V"
    return "D"


def point_to_segment_distance_mil(
    px: float, py: float,
    x1: float, y1: float,
    x2: float, y2: float,
) -> float:
    """Shortest distance (mils) from point (px, py) to segment (x1,y1)-(x2,y2).

    Uses parametric projection: find the parameter t in [0,1] for the
    nearest point on the segment, clamp, then compute distance to that point.
    If the segment is degenerate (length zero), returns distance to either
    endpoint.
    """
    dx, dy = x2 - x1, y2 - y1
    seg_len_sq = dx * dx + dy * dy
    if seg_len_sq < 1e-12:
        # Degenerate segment — treat as a point.
        return math.hypot(px - x1, py - y1)
    # Parametric projection of P onto the line through (x1,y1)-(x2,y2).
    t = ((px - x1) * dx + (py - y1) * dy) / seg_len_sq
    t = max(0.0, min(1.0, t))
    nearest_x = x1 + t * dx
    nearest_y = y1 + t * dy
    return math.hypot(px - nearest_x, py - nearest_y)


def segments_intersect_mil(
    x1: float, y1: float, x2: float, y2: float,
    x3: float, y3: float, x4: float, y4: float,
) -> bool:
    """Return True if segment (x1,y1)-(x2,y2) intersects segment (x3,y3)-(x4,y4).

    Uses the cross-product (orientation) test. Collinear overlapping segments
    are also treated as intersecting (returns True). Touching at a single
    endpoint counts as intersecting.
    """
    def _cross(ax: float, ay: float, bx: float, by: float) -> float:
        return ax * by - ay * bx

    def _orientation(px: float, py: float, qx: float, qy: float, rx: float, ry: float) -> float:
        """Cross product of (q-p) × (r-p). Positive, negative, or zero."""
        return _cross(qx - px, qy - py, rx - px, ry - py)

    def _on_segment(px: float, py: float, qx: float, qy: float, rx: float, ry: float) -> bool:
        """True if point r lies on segment p-q (assumes collinear)."""
        return (
            min(px, qx) <= rx <= max(px, qx)
            and min(py, qy) <= ry <= max(py, qy)
        )

    d1 = _orientation(x3, y3, x4, y4, x1, y1)
    d2 = _orientation(x3, y3, x4, y4, x2, y2)
    d3 = _orientation(x1, y1, x2, y2, x3, y3)
    d4 = _orientation(x1, y1, x2, y2, x4, y4)

    # Standard crossing: segments straddle each other
    if (d1 * d2 < 0) and (d3 * d4 < 0):
        return True

    # Collinear / endpoint-touching cases
    if d1 == 0 and _on_segment(x3, y3, x4, y4, x1, y1):
        return True
    if d2 == 0 and _on_segment(x3, y3, x4, y4, x2, y2):
        return True
    if d3 == 0 and _on_segment(x1, y1, x2, y2, x3, y3):
        return True
    if d4 == 0 and _on_segment(x1, y1, x2, y2, x4, y4):
        return True

    return False


def axis_aligned_parallel_overlap(
    seg_a: dict, seg_b: dict,
) -> tuple[float, float] | None:
    """For two axis-aligned segments on the same axis, return
    (perpendicular_distance_mil, overlap_length_mil) or None if not
    parallel or on different axes.

    Segments must have startX/startY/endX/endY keys.
    """
    ax1, ay1, ax2, ay2 = seg_a["startX"], seg_a["startY"], seg_a["endX"], seg_a["endY"]
    bx1, by1, bx2, by2 = seg_b["startX"], seg_b["startY"], seg_b["endX"], seg_b["endY"]

    ori_a = segment_orientation(ax1, ay1, ax2, ay2)
    ori_b = segment_orientation(bx1, by1, bx2, by2)
    if ori_a != ori_b or ori_a not in ("H", "V"):
        return None

    if ori_a == "H":
        # Both horizontal: perpendicular distance = |Δy|, overlap on x-range
        perp = abs(ay1 - by1)
        a_lo, a_hi = min(ax1, ax2), max(ax1, ax2)
        b_lo, b_hi = min(bx1, bx2), max(bx1, bx2)
    else:  # V
        perp = abs(ax1 - bx1)
        a_lo, a_hi = min(ay1, ay2), max(ay1, ay2)
        b_lo, b_hi = min(by1, by2), max(by1, by2)

    overlap = max(0.0, min(a_hi, b_hi) - max(a_lo, b_lo))
    return perp, overlap
