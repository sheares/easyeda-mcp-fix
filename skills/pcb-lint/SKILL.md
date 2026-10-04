---
name: pcb-lint
description: Run a battery of PCB design-hygiene checks against the board open in EasyEDA Pro, through the easyeda MCP tools, and produce a scored report. Use when the user says "/pcb-lint", "lint the board", "run PCB checks", "check my layout", "is this board ready to fab?", or finishes a PCB layout iteration and is about to order boards. Use "/pcb-lint sch" for a schematic with no layout yet. Do not use for firmware, enclosure or mechanical review.
---

# pcb-lint

A structured design-hygiene pass over the board open in EasyEDA Pro. **You (Claude) call the `mcp__easyeda__*` tools directly, apply the check rules below, and write a markdown report plus a JSON sidecar.**

It is a second pair of eyes, not a sign-off. It catches the common, expensive mistakes (an overvoltage regulator divider, a USB-C port that never gets power, copper too close to the board edge) before you pay for boards. It does not replace reading the datasheets or the fab's own DRC.

## What is in this folder

- `SKILL.md` (this file): the operational rules you follow.
- `scripts/checks/{sch,pcb}_*.py`: a Python reference implementation of 25 of the 26 checks, unit-tested against mock MCP payloads (`tests/`, 189 tests). When a rule below is ambiguous, read the Python. If the Python and this file disagree, the Python is the truth.
- `scripts/config.example.json`: a template for the optional per-board config.

The Python is a test harness and reference, **not** the runner. You are the runner.

## Invocation modes

- **`/pcb-lint`** (no arguments): run all checks and assemble one report grouped by severity. The normal path.
- **`/pcb-lint sch`**: schematic checks only (SCH-*). Use when the schematic exists but the PCB is not laid out yet.
- **`/pcb-lint pcb`**: PCB checks only (PCB-*).
- **`/pcb-lint <check-id>`** (for example `/pcb-lint PCB-21`): one check only. Use to iterate quickly while fixing one class of finding.

## Preconditions

1. **EasyEDA Pro is running with the target project open.**
2. **The bridge is live.** Call `mcp__easyeda__server_info` first. If the call fails, or `extensionConnected` is false, or `connectedInstanceCount` is 0, tell the user the extension is not connected (in EasyEDA Pro: **Claude → Connect Claude** in the top menu) and stop. Do not run checks against a dead bridge.
3. **The right board is active.** Call `mcp__easyeda__editor_get_open_tabs` and confirm the active tab is the board the user means. If several EasyEDA windows are open, use `mcp__easyeda__list_instances` and pass the right `instance_id`.
4. **Config file (optional).** Look for `pcb-lint.config.json` in the project folder the user is working from. If absent, run with defaults and emit a `CONFIG-01` info finding pointing at `scripts/config.example.json`.

If no `mcp__easyeda__*` tools are available at all, the MCP server is not registered under the name `easyeda`. Tell the user to follow the setup guide in the repository (`docs/student-guide.md`).

## Procedure

1. **Fetch schematic data once** (needed by the SCH checks and by several PCB checks):
   - `mcp__easyeda__sch_run_drc` → ERC/DRC result
   - `mcp__easyeda__sch_get_all_components` (filter `componentType: "part"`)
   - `mcp__easyeda__sch_get_connectivity` → compact pin-to-net map (one call replaces many per-IC pin fetches)
   - `mcp__easyeda__sch_export_bom` → BOM rows keyed by column
2. **Fetch PCB data once** (PCB checks):
   - `mcp__easyeda__pcb_run_drc` (verbose=true) → violation list
   - `mcp__easyeda__pcb_get_all_primitives` for types: via, pad, component, track (track per high-speed net if the config declares any)
3. **Datasheets before judgement.** Before reporting any IC-related finding (SCH-02, SCH-07, SCH-08, PCB-02, PCB-05), check what the part's datasheet actually says. Many bypass capacitors are "recommended", not "required". If the user's project folder has a `datasheets/` folder, use it; otherwise fetch the datasheet for each non-passive part you are about to flag (sub-agents in parallel work well for this). Never flag an IC from memory alone.
4. **Run each check** in the selected mode against the fetched data. Collect findings as `{check_id, severity, message, offending_ids, suggestion}`. When the datasheet labels a part as "recommended, not required", downgrade the finding from warn to info and quote the section.
5. **Parallel-run sweep (PCB boards).** In addition to PCB-03, look for noisy-next-to-sensitive pairs (motor, switching or clock nets running alongside UART, I2C or ADC nets), including on different layers stacked on top of each other, and mention any you find.
6. **Assemble the report** in the output shape below. Print the markdown to the user. Write the JSON sidecar as `pcb-lint-<board>-<ISO-time>.json` in the user's project folder (the current working directory if unsure).
7. **For findings that depend on how the board will be used** (load, environment, whether a feature will actually run), present the finding, the datasheet wording and the failure conditions, then **ask the user** whether to fix, waive or defer. Do not decide for them.
8. **No silent passes.** Follow the failure-mode table below.

## Checks: schematic (SCH-01 to SCH-12)

Each check emits zero or more findings. Default severities shown; `strict` mode in config promotes warn to error.

### SCH-01: ERC clean (error)
From `sch_run_drc`.
- `errors` non-empty: **error** "ERC reports N error(s)", with each error's location, net and message as `offending_ids`.
- `warnings` non-empty: **info** with the same shape.

### SCH-02: Every IC has local decoupling (warn)
For each IC (component with `type=="ic"` or any power pin), each power pin's net must contain at least one capacitor.
- Power pin: `pin.type == "power"` or the pin name starts with VCC, VDD, AVCC, DVCC, VBAT, VBUS, VIN, VOUT, VREF, +3V3, +5V, +12V (see `PowerRailPatterns` in `scripts/checks/types.py`).
- Uncovered pin: **warn** per IC listing `{designator}.{pin}({net})`.

### SCH-03: Every power rail has a power symbol (warn)
Each net whose name matches a power-rail pattern needs at least one component with `type=="power_port"` naming that rail.
- Missing rail: **warn** with the list of rails.

### SCH-04: Net naming hygiene (info)
Flag auto-generated names matching `^(NET\d+|SIG\d+|N\$\d+|UNNAMED\d*|WIRE\d+)$` (case-insensitive). Named nets make the schematic, the layout and the debugging far easier to read.

### SCH-05: BOM complete (error)
Every non-mechanical BOM line has a supplier part or LCSC C-number.
- Mechanical: `type` in `{testpoint, fiducial, mechanical, logo}` or designator prefix in `{TP, MK, MH, FID, LOGO, H}`.
- Missing supplier and missing `lcsc_code` and `part_number` not starting `C\d+`: **error** listing designators.

### SCH-06: JLC assembly stock (info)
The JLC stock API is not wired in. Always emit **info** listing the LCSC C-numbers so the user can check stock and Basic vs Extended status on jlcpcb.com before ordering. Never silently pass when the BOM has LCSC codes.

### SCH-07: Bulk capacitor on each regulator output (warn)
For each regulator (`type=="regulator"`), find its output pins (`type=="output"` or a name starting VOUT/OUT). Each output net needs a capacitor of at least 10 µF.
- Value parsing (`_parse_uf` in `sch_07_bulk_cap.py`) needs an explicit unit (100nF, 10uF, 10µF, 1mF, 0.1uF). Bare numbers are rejected.
- Switching regulators have no VOUT pin: trace SW → inductor → output net (`_find_output_net`).
- Missing: **warn** listing `{designator}:{net}`.

### SCH-08: Regulator output vs downstream abs-max (error)
For each adjustable regulator, look up Vref in `REGULATOR_VREF_V`, find the feedback divider on its FB net (R_upper between FB and the output, R_lower between FB and GND), compute `Vout = Vref × (1 + R_upper / R_lower)` from the actual resistor values, and compare against the absolute-maximum supply voltage of every IC on that rail (`IC_ABS_MAX_SUPPLY_V`).
- Downstream IC over abs-max: **error** OVERVOLTAGE with regulator, divider and downstream designators and the numeric Vout.
- Vout more than 10 % off the rail's intended voltage (inferred from names such as +3V3, +3.3V, +5V, +12V, +1V8, +2V5): **warn**.
- Regulator not in the table: **warn** "Vref unknown", never a silent pass. Look Vref up in the datasheet, add a row to the table at the top of `scripts/checks/sch_08_regulator_vout.py`, and re-run; or verify by hand that `Vout ≤ min(downstream Vmax)`.
- Downstream IC not in the abs-max table: **info** asking to extend it.
- Why this exists: a real board shipped with a buck converter's divider set for 4.43 V feeding an ESP32-C3 whose absolute maximum is 3.6 V. The incident is reproduced as a regression test in `tests/test_sch_08_regulator_vout.py`.

### SCH-09: Motor driver COM pin tied to the motor supply (error)
For ULN2003 / TPL7407 parts (matched on component name), the COM pin's net must be the motor supply (VMOTOR, VM, VS, VIN, +5V, +12V, +24V, VBUS). Floating COM, or COM on GND, leaves no flyback clamp and the driver dies on the first inductive kick. COM on a low-voltage logic rail (+3V3, +1V8, +2V5) is also an error.
- Unrecognised rail name: **info** (verify by hand; renaming the rail lets future runs verify it).
- Sources: TI TPL7407LA datasheet §7.4; TI ULN2003A datasheet.

### SCH-10: USB-C CC1 and CC2 each have their own 5.1 kΩ pull-down (error)
For every USB-C receptacle (name or footprint contains USB-C, USB_C, TypeC, TYPEC and similar), CC1 and CC2 each need a separate resistor to GND, valued 4.7 kΩ to 5.6 kΩ. Without them a C-to-C cable or USB-C charger supplies no power at all. A wrong value is a warn. One resistor shared between CC1 and CC2 is an error (it fails with e-marked and active cables).
- Sources: USB Type-C specification §4.5.1.2.2 (Sink CC); Infineon KBA on Rp/Rd/Ra.

### SCH-11: ESP32 strapping pins (error / warn / info)
Strapping pins are GPIOs sampled at reset to choose boot mode, flash voltage or log output; the wrong level can stop the chip booting or damage flash.

Variant detection: name, manufacturer part or value containing `ESP32-S3`, `ESP32-C3`, `ESP32-S2`, `ESP32-C6`, `ESP32-H2`, or `ESP32` (classic, fallback). Modules (WROOM, MINI and so on) use the same table as their chip.

Findings per strap pin:
- **info**: pin unconnected (internal pull applies), or only the ESP32 is on the net.
- **warn**: pull resistor outside 1 kΩ to 10 kΩ; pull in range but in the wrong direction for the required boot level; or a strap net whose name looks like a power rail but is not corroborated (could be a divider midpoint, verify by hand).
- **error**: strap hard-tied (0 Ω) to the wrong level; strap wired straight to a corroborated power or GND rail at the wrong level; or another IC's output drives the strap net with no 1 kΩ to 10 kΩ series resistor.
- GPIO45 (S3, S2) and GPIO12 (classic) carry "BRICK RISK" in their messages when violated.

A strap net counts as a real power rail if (a) its name is canonical (`+3V3`, `3V3`, `+3.3V`, `3.3V`, `+5V`, `5V`, `+12V`, `12V`, `VCC`, `VDD`, `VBUS`, `VIN`, `GND`, `AGND`, `DGND`), or (b) a capacitor is on it, or (c) another IC has a power pin on it.

Tables live at the top of `scripts/checks/sch_11_esp32_strapping.py`, keyed by variant, each entry citing the Espressif datasheet section (ESP32-C3 §2.8, ESP32-S3 §3.3, ESP32 §2.4 and hardware design guidelines §2.2, ESP32-S2 §2.4, ESP32-C6 §2.8, ESP32-H2 §2.8).

### SCH-12: First-flash power path exists (warn / info)
Every board with a microcontroller needs a clean way to load code on day one. This catches the mistake where a programming header exists but the programmer cannot power the chip, or speaks the wrong voltage. *Claude-run only: there is no Python reference for SCH-12 yet.*

**Find the programming header**: connectors (`type=="connector"` or designator prefix CN, J, H) whose pin names match one of:
- SWD: `SWCLK` + `SWDIO` (optional `NRST`, `SWO`, `GND`, `VCC`, `3V3`, `5V`).
- WCH single-wire: `SWIO` or `DIO` + `GND` (optional `3V3`, `VCC`, `TX`, `RX`).
- AVR ISP: `MOSI` + `MISO` + `SCK` + `RST`/`NRST` + `GND` (optional `VCC`).

**Find how the MCU is powered** on its VDD net: an on-board regulator (infer voltage from the net name or the SCH-08 table), USB VBUS wired straight to VDD, or a battery or adapter with no regulator.

**Programmer signal voltage**: a `3V3` header pin implies 3.3 V signals, a `5V` pin implies 5 V. Otherwise assume 3.3 V (WCH-LinkE, ST-Link, DAPLink, J-Link and CH340 / CP2102 USB-serial adapters all default to 3.3 V). Config override: `programmer_signal_voltage_v`.

Findings:
- **warn**: header has no VDD pin and the MCU has no on-board regulator matching the programmer voltage (for example a 5 V-only board with a 3.3 V programmer). Suggest a VDD pin on the header plus a power-select jumper, or an LDO matching the programmer voltage.
- **warn**: programmer signal voltage gives less than 200 mV of margin over the MCU's input-high threshold (typically 0.65 × VDD). Example: an MCU at 5 V needs at least 3.25 V; 3.3 V signals leave only 50 mV.
- **info**: header VDD pin is on a different net from the MCU VDD; make sure the first-flash power path is documented.
- **info**: no programming header and no obvious USB bootloader path; suggest adding a header.

Skip with an info finding if the board has no MCU, or the MCU has a factory USB bootloader wired to its USB connector (RP2040 BOOTSEL, ESP32 auto-download through a USB-serial chip, and similar).

## Checks: PCB manufacturing (10 checks)

### PCB-01: PCB DRC clean (error)
`pcb_run_drc(verbose=true)` returns a list of violations, `[]` if clean. Any violation: **error** with the count.

### PCB-08: Annular ring on plated holes (error)
Vias `(diameter - holeDiameter) / 2` and through-hole pads `(min(pad_w, pad_h) - hole) / 2` must meet IPC Class 2 (≥ 5 mil) or Class 3 (≥ 6 mil, set `class` in config). Non-plated pads are skipped.

### PCB-10: Test points (info)
Components with designator prefix `TP`. None: info suggesting test points for bring-up and production test. Some: info reminding of probe minimums (35 mil pad, 50 mil centre to centre).

### PCB-11: Fiducials (info)
Components with designator prefix `FID`. None: info that JLCPCB assembly of small prototypes works without them. Some: info reminding three per side, placed asymmetrically.

### PCB-13: Coordinate sanity (info)
Any primitive with `|x|` or `|y|` over 1,000,000 mil (about 25 m) means a mm/mil mix-up somewhere. EasyEDA's PCB API works in **mil** (1 mm = 39.37 mil).

### PCB-14: Solder-mask expansion (warn / info)
Read `solderMaskAndPasteMaskExpansion.{topSolderMask, bottomSolderMask}` on pads. **The unit is 1/100 inch, so 1 unit = 10 mil** (not mm). Convert with `value × 10 = mil` or `value × 0.254 = mm`. Typical expansion is 2 to 5 mil per side, so raw values are usually 0.2 to 0.5; if you compute more than 15 mil you have probably multiplied by 39.37 by mistake.
- Under 1 mil: **warn** (mask may cover the pad).
- Over 6 mil: **info** (bridging risk on fine-pitch parts). The threshold is not pitch-aware yet.
- **Unit ambiguity:** the Python converts `× 10` to mil (shared helper in `scripts/checks/types.py`) and treats a raw value above 1.5 (over 15 mil) as unit-ambiguous, because one real footprint (an SOD-323 diode) returned `2` where plain mil was the only plausible reading. PCB-14 does not claim a bridging risk for those pads; it emits one info finding listing them with both readings and asks you to confirm the expansion in EasyEDA's pad properties.

### PCB-18: Via aspect ratio (error)
`board_thickness / holeDiameter ≤ 10`. Default board thickness 1.6 mm; override `board_thickness_mm` in config.

### PCB-20: Solder-mask dam on fine-pitch parts (error)
For adjacent pads on the same copper layer, `dam = gap - (mask_expansion_1 + mask_expansion_2)`, where gap is the edge-to-edge distance. If the dam is under `pcb_mask_dam_min_mm` (default **0.10 mm**; use 0.15 mm for coloured masks): **error**. Below this, JLCPCB removes the dam without warning and the pads can bridge during reflow. Use the `× 10` mask-unit conversion from PCB-14 (`× 0.254` for mm). Raw values above 1.5 are kept at the conservative `× 10` reading (the smaller dam) and the finding message names those pads as unit-ambiguous so you can check them.
- Source: JLCPCB PCB capabilities, solder mask section (minimum mask bridge 0.1 mm, green, 1 oz).
- Limits: rotated (non-axis-aligned) pad pairs are skipped; round pads are treated as their bounding box (conservative).

### PCB-21: Copper to board edge (error)
Every copper feature (tracks, pads, vias, pour vertices) must sit at least `pcb_edge_clearance_mil` from the board outline (layer 11). Default 8 mil (0.20 mm, JLCPCB minimum for routed edges); use 16 mil (0.40 mm) for V-cut panels. Too close and the router bit or V-cut blade nicks the copper.
- If the outline is made only of arcs, emit a warn: clearance cannot be verified.
- Arc segments of an outline are skipped (info with the count).

### PCB-22: Antenna keep-out (error)
Wi-Fi, Bluetooth and LoRa modules with on-board antennas need a zone free of copper and components, or the antenna detunes and range collapses. The geometry comes from the module datasheet, so the user declares it in config; PCB-22 checks nothing intrudes.

```json
"antenna_keepouts": [
  {"name": "ESP32-C3 antenna", "shape": "circle", "x_mm": 25.0, "y_mm": 10.0, "radius_mm": 15.0},
  {"name": "LoRa antenna area", "shape": "rect", "x_mm": 5.0, "y_mm": 40.0, "w_mm": 20.0, "h_mm": 5.0}
]
```

- No zones declared: **info** "PCB-22 skipped: no antenna_keepouts in config" (never a silent pass). If the board has an RF module, say so and suggest declaring its zone.
- Unknown `shape`: **warn**, skip that zone, carry on with the others.
- Per zone, check track segments (endpoints and segment crossing), pad and via centres, pour vertices and component pad bounding boxes (component centre if no pads are attached). **Error** per intrusion with the ID and depth.
- Zone coordinates use the board's own origin, the same frame as component x/y in EasyEDA. Only circle and rect zones are supported.

## Checks: signal integrity (4 checks)

### PCB-02: Decoupling capacitor distance (warn / info)
The physical half of SCH-02. For each IC power pin, measure **pad-to-pin distance**: from the decoupling capacitor's pad on that net to the IC's power pin pad (fetch with `pcb_get_all_primitives(type='pad')` filtered by net, then match designators).
- **Do not use component-centre distance.** Centre to centre overstates by 30 to 70 % for rotated ICs and small passives, and pushes people into moves that make the layout worse.
- Thresholds by role: small high-frequency bypass caps (under 1 µF) warn beyond 3 mm; bulk caps (1 µF and up) warn beyond 5 mm; 2 to 5 mm is info. A close 10 µF ceramic can cover both roles for a low-current MCU, so a second, farther 100 nF is then info, not warn.
- Put the measured distance in the message, not just the threshold.

### PCB-03: 3W spacing on high-speed nets (warn)
For each track on a net listed in `high_speed_nets`, compare against every other track on the **same layer**. If the gap is under 3 × track width for more than 5 × track width of parallel run, flag coupling risk. Needs `high_speed_nets` in config; if empty, emit info (no silent pass). Cross-layer runs are not checked; cover them in the procedure's step 5.

### PCB-05: ESD/TVS diode near its connector (warn)
For each TVS or ESD part (names containing USBLC, SP0503, ESDA, PESD, TPD, TVS, ESD), find connectors sharing a net through the schematic connectivity and measure component-centre distance. Warn beyond 10 mm: protection only works if the diode sits right at the connector.

### PCB-19: Differential pair via balance (warn)
For each pair in `differential_pairs` config, count vias on each net. Flag unequal counts (for example USB D+ with 2 vias and D- with 4). Harmless at USB full speed, a problem at high speed.

## Failure modes (no silent passes)

| Situation | Behaviour |
|---|---|
| `server_info` fails or extension disconnected | Stop before any check. Tell the user how to reconnect. |
| One MCP call fails mid-run | Retry twice about 1 s apart. Still failing: skip only that check with an info finding "XX skipped: `<tool>` failed after retries" and continue. |
| MCP returns an unexpected shape | Skip that check with an info finding naming the payload. Continue. |
| `high_speed_nets` empty | Skip PCB-03 with an info finding. |
| Board has no components | Abort: "no components found; nothing to lint". |
| Config is malformed JSON | Abort with an error naming the problem. |
| Config absent | Run with defaults; emit CONFIG-01 info. |

## Output shape

Mirror `scripts/reporters/markdown.py` so reports stay comparable between runs:

```
# pcb-lint report: <board> (<ISO-UTC>)

## Summary
- Errors:   N (must fix before fab)
- Warnings: M (should fix; note why if you waive one)
- Info:     K (style / hygiene)

## Errors
### SCH-XX: <message>
Offending IDs: id1, id2, id3
Suggestion: <one-line fix>

## Warnings
[same shape]

## Info
[same shape]

## Skipped this run
- SCH-XX: <reason> (only if any checks were skipped)

## Manual checks (always)
- Silk over pads: the API cannot query silkscreen. Export a PDF (File → Export → PDF) and look.
- Rail continuity: check every rail with a multimeter before fitting the MCU.

## Ran against
- Board: <name>
- High-speed nets: <list or "(none declared)">
- Class: 2 | Cu: 1 oz
- Config: <path or "(defaults)">
- MCP server version: <server_info version, else "unknown">
- Checks ran: <count>
```

Then write the same content as JSON next to the project, `pcb-lint-<board>-<ISO>.json`:

```json
{
  "context": { "board": "...", "started_at": "...", "config": "..." },
  "findings": [ { "check_id": "...", "severity": "...", "message": "...", "offending_ids": [], "suggestion": "..." } ]
}
```

The sidecar lets the user compare findings across board revisions.

## What to do with findings

- **Errors** block the order. Report them; fix only when the user asks.
- **Warnings**: report; the user decides fix or waive. Suggest they note each waiver and the reason (a `decisions.md` in the project works well).
- **Info**: report in a batch; not blocking.
- **Manual checks**: always prompt the user to do them.

Do not fix anything silently. Report first, then fix on instruction.

## Running the Python tests (optional, for people extending the checks)

```bash
cd ~/.claude/skills/pcb-lint
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest tests/
```

To add a check: create `scripts/checks/<id>_<name>.py` with a `@register`-decorated `Check` subclass, **import it in `scripts/checks/__init__.py`** (or it never registers), add its ID to the expected list in `tests/test_smoke.py`, and add a test file. Build test fixtures from the real part's pinout, not an invented one: a fake fixture once let a check pass its tests while missing the exact bug it was written for.
