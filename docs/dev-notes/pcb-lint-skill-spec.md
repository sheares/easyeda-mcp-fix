# pcb-lint skill (v0.4, Phase 1-3 shipped)

**Status:** Phases 0, 1, 2, 3 all shipped. 18 checks total (7 SCH + 11 PCB), 72 pytest tests green, dogfooded end-to-end on Splitflap-v2-Wireless-v3 Board1 (schematic + PCB) 2026-07-20.

**Runner architecture:** Option B (Claude in-session calls `mcp__easyeda__*` directly). The Python scaffold at `skills/pcb-lint/scripts/` is the reference implementation + regression harness; not the primary runner.

**Author:** Claude, 2026-07-20 (initial draft through Phase 3 delivery all in one session).

## What's shipped (18 checks)

**Phase 1 (schematic hygiene):** SCH-01 ERC, SCH-02 IC decoupling, SCH-03 power symbols, SCH-04 net naming, SCH-05 BOM complete, SCH-06 JLC stock (info-only until API wired), SCH-07 bulk cap per regulator.

**Phase 2 (PCB mechanical + DFM):** PCB-01 DRC, PCB-08 annular ring, PCB-10 testpoints, PCB-11 fiducials, PCB-13 mil-coord sanity, PCB-14 soldermask expansion, PCB-18 via aspect ratio.

**Phase 3 (PCB signal integrity):** PCB-02 decoupling physical proximity, PCB-03 3W spacing (same-layer parallel-run detection), PCB-05 TVS proximity to connector, PCB-19 diff-pair via balance.

## Board1 dogfood outcomes

Real findings that shipped with v1 and went on v2 wish-list:

1. TPL7407 (U4) COM bypass cap absent — TI datasheet §9 explicit: not required. Waived.
2. USB-C VBUS bulk cap absent — downstream 22 µF on VIN cushions; USB used for programming. Waived.
3. **USB_DP=2 vs USB_DM=4 vias** — PCB-19 caught. Ok at USB 2.0 FS; problematic at HS. v2 rebalance.
4. ESP32-C3 nearest +3V3 cap 12.5 mm away — PCB-02 caught. Module has internal decoupling; verify datasheet. v2 tighten.
5. MOTOR_D (L2) × UART_RX_PAD (L1) stacked parallel — cross-layer, PCB-03 MVP misses. Corner case only.

## What's queued (deferred phases)

- **🔴 SCH-08 (highest priority)**: **Regulator Vout vs downstream Vmax** — for every adjustable regulator, compute Vout from FB divider (R_upper/R_lower from live schematic connectivity, Vref from local datasheet PDF), cross-check against every downstream IC's abs max on that output net. Hard error if Vout > Vmax. Also warn if Vout deviates >10% from design intent. **Prevents the class of bug that shipped as Splitflap-v2 Board1's 4.43V (would have destroyed ESP32-C3 at 3.6V max).** Until this lands as code, SKILL.md step 3b enforces the same check manually every run. ~1.5 hr.
- **Phase 2.1**: PCB-08 shape parser for non-ELLIPSE pads; PCB-14 pitch-aware threshold. ~30 min.
- **Phase 2.5**: PCB-12/15/16 silk geometry (polyline-to-pad distance), PCB-17 pour stitching. ~2 hr, needs polygon math.
- **Phase 3.1**: cross-layer stacked parallel-run (extends PCB-03), diff-pair exception list, PCB-05 via-in-path detection. ~1 hr.
- **Phase 4**: current/thermal — PCB-04, PCB-06, PCB-07, PCB-09. ~3 hr.
- **Phase 5**: promote proven checks to fork-side MCP tools (server roadmap after C4).

## Behavioural rules baked in (durable across sessions)

Saved as separate feedback memories, load automatically on future PCB reviews:

- Datasheet before flagging IC issues (spawn parallel Explore sub-agents per IC)
- Ask Ben when finding depends on system context (not unilateral recommendations)
- Hunt aggressor × victim parallel-run adjacencies proactively (don't wait to be asked)

## Why Option B (kept from v0.3 spec)

The fork's mcp-server uses stdio transport (spawned as subprocess by the MCP client, not a WebSocket daemon). A second Python MCP client alongside Claude Code was doable but bought little for a solo-dev workflow. Option B removes the double-connection complexity and matches how most Claude Code skills work: SKILL.md instructs the model, model calls the MCP tools, model produces the output. The Python scaffold retains value as the pytest regression harness and as the reference implementation when a check's semantics look ambiguous from SKILL.md prose.
**Sits under:** PCB best practices (author\'s private notes) and the design checkpoint protocol (author\'s private notes).

---

## Purpose

Run a battery of PCB design-hygiene checks against the currently-open EasyEDA Pro board via the fork MCP, and produce a scored report Ben can act on. Fires at the layout-exit gate of any PCB project, before fab package generation.

Non-goal: replace human judgement on grouping, hierarchy, aesthetics, or DFM decisions that need fab-specific data.

---

## Trigger

**Explicit:** `/pcb-lint` (or the user says "lint the board", "run PCB checks", "check my layout").

**Implicit:** the design checkpoint protocol fires at each block boundary; on PCB projects, the AUDIT gate should invoke this skill automatically.

**Preconditions:**
- EasyEDA Pro is running with the target board open.
- Fork MCP bridge is live (verify with `server_info` ping; if not, prompt "Connect Claude" in EDA Pro per Splitflap → EDA Pro bridge (author\'s private notes)).

---

## Inputs

**Required (from context or asked once):**
- `board_name`: which project/board (default = current active tab).
- `high_speed_nets`: list of net names Ben considers high-speed / sensitive (clocks, USB, ADC inputs, differential pairs). Needed for the 3W rule and TVS proximity checks.
- `power_pins_per_ic`: usually inferable from schematic component pins, but user confirms edge cases (e.g. "AVCC counts", "VBAT doesn't").

**Optional (with defaults):**
- `class`: IPC-2221 Class 2 (default) or Class 3.
- `default_temp_rise_c`: 10 (default).
- `copper_weight_oz`: 1 (default).
- `strict`: if true, warnings become errors.

**Non-inputs (auto-fetched from MCP):**
- BOM, netlist, component pins, primitives, nets, design rules, layer stack.

---

## Checks (v1)

Each check emits: `{check_id, severity (info|warn|error), message, offending_ids[], suggestion}`.

Grouped by which gate they enforce. Every check names its MCP dependency so we know before running whether it can execute.

### Schematic gate (`sch_*` calls)

| ID | Check | Rule | MCP calls | Severity default |
|---|---|---|---|---|
| SCH-01 | ERC clean | `sch_run_drc` returns zero errors | `sch_run_drc` | error |
| SCH-02 | Every IC has local decoupling | For each IC power pin, netlist shows a cap on that net near the IC in schematic | `sch_get_all_components`, `sch_get_netlist`, `sch_get_component_pins` | warn |
| SCH-03 | Every rail has a power symbol | Named power ports on each declared rail, not just labels | `sch_get_all_components` (filter power ports) | warn |
| SCH-04 | Net naming hygiene | Reject NET42/SIG1-style names; require domain prefix on split rails | `sch_get_netlist` | info |
| SCH-05 | BOM complete | Every non-mechanical part has a supplier (LCSC C-number) | `sch_export_bom` | error |
| SCH-06 | JLC assembly stock | Every LCSC part has non-zero JLC stock | `sch_export_bom` + external JLC parts API | warn |
| SCH-07 | Bulk cap per rail near regulator | Each regulator output rail has ≥ 1 bulk cap (≥ 10 µF) adjacent to it in the schematic cluster | `sch_get_all_components`, `sch_get_netlist` | warn |

### Layout gate (`pcb_*` calls)

| ID | Check | Rule | MCP calls | Severity default |
|---|---|---|---|---|
| PCB-01 | DRC clean | `pcb_run_drc` returns zero errors | `pcb_run_drc` | error |
| PCB-02 | Decoupling proximity | Every IC power pin has a cap on the same net within ≤ 2 mm (78 mil) | `pcb_get_component_pins`, `pcb_get_primitives_in_region`, `pcb_get_all_primitives` | warn |
| PCB-03 | 3W spacing (high-speed nets) | Centre-to-centre spacing ≥ 3 × trace width between any high-speed net and any other net | `pcb_get_all_primitives`, `pcb_get_net_primitives` | warn |
| PCB-04 | Trace width vs current | For each net with a declared current, actual width ≥ IPC-2221 minimum (given ΔT, Cu weight, external/internal) | `pcb_get_all_primitives`, `pcb_manage_net_rules` | warn |
| PCB-05 | TVS proximity | For any net entering via a connector, TVS is in-line ≤ 10 mm from connector pin, no intervening via | `pcb_get_component_pins`, `pcb_get_net_primitives`, `pcb_get_net_length` | warn |
| PCB-06 | Thermal via density under power pads | Any pad tagged thermal or belonging to a >0.5 W part has 10–50 vias/cm² of pad area | `pcb_get_all_primitives`, footprint bbox | warn |
| PCB-07 | GND stitching pitch (edges) | GND vias within 100 mil of board edge at ≤ 1 mm pitch | `pcb_get_all_nets`, `pcb_get_net_primitives` (GND) | info |
| PCB-08 | Annular ring | Every plated hole has ≥ 5 mil (Class 2) or ≥ 6 mil (Class 3) annular ring | `pcb_get_all_primitives` (vias + pads) | error |
| PCB-09 | Via current | Any via on a net with declared current I has enough parallel vias to carry I with 1.25× margin | `pcb_get_net_primitives`, `pcb_manage_net_rules` | warn |
| PCB-10 | Testpoint dimensions | Testpoints ≥ 35 mil diameter, ≥ 50 mil pairwise centre-to-centre | `pcb_get_all_primitives` (filter testpoints) | info |
| PCB-11 | Fiducial coverage | Three fiducials per assembled side, asymmetric placement | `pcb_get_all_primitives` (filter fiducials) | warn |
| PCB-12 | Silkscreen clearance to copper | Silk primitives ≥ 6 mil from copper pads | `pcb_get_all_primitives` (silk + pads) | warn |
| PCB-13 | Mil-coord sanity | Any coord value < 10 or > 1e6 is likely a mm/mil confusion | `pcb_get_all_primitives` | info |
| PCB-14 | Soldermask expansion | Mask expansion around each pad within 2.5–3 mil (Class 2) | `pcb_get_all_primitives` (pads + mask apertures) | warn |
| PCB-15 | Silk minimums | Silk-to-mask ≥ 4.5 mil; silk line width ≥ 6 mil; text height ≥ 40 mil | `pcb_get_all_primitives` (silk) | warn |
| PCB-16 | Polarity marks | Every polarised part (diode, electrolytic cap, LED, IC) has a silk polarity mark or pin-1 dot not fully covered by the part body footprint | `pcb_get_all_primitives` (silk + footprints) — **degraded** if silk-content queryability limited (see Known gaps) | info |
| PCB-17 | Copper-pour stitching | Vias inside each GND/PWR pour tie the pour to the main plane at ≤ 5 mm pitch | `pcb_get_all_primitives` (pours + vias) | info |
| PCB-18 | Via aspect ratio | Every via has drill-to-board-thickness aspect ratio ≤ 10:1 | `pcb_get_all_primitives` (vias) + layer stack | error |

### Known gaps (explicitly not covered in v1)

| Rule | Why skipped |
|---|---|
| Silk-over-pad exact overlap | Silk not queryable in EasyEDA MCP; needs PDF eyeball (known bug (author\'s private notes)). Output: prompt user to PDF-export + upload. |
| Traces crossing plane splits | Requires plane-void detection; non-trivial. Consider for v2. |
| Return-path integrity | Requires layer-aware simulation; out of scope. |
| Rail-continuity at bring-up | Physical DMM check; skill can only remind. |
| Datasheet pin-rating compliance | Requires external PDF reading + judgement. |
| Grouping / hierarchy / aesthetics | Human judgement. |

---

## Output shape

Markdown report to the user, structured:

```
# pcb-lint report — <board_name> — <ISO date>

## Summary
- Errors:   N (must fix before fab)
- Warnings: M (should fix; document waiver if not)
- Info:     K (style / hygiene)

## Errors
### PCB-08 Annular ring — 3 vias below 5 mil
Offending IDs: v_1247, v_1289, v_1301
Suggestion: increase pad diameter to 24 mil on these vias, or downshift drill to 8 mil.

## Warnings
...

## Info
...

## Skipped (needs manual)
- PCB silk-over-pad: please File → Export → PDF and upload, I will eyeball.
- Rail continuity: DMM check before socketing MCU (Splitflap precedent).

## Ran against
- Board: <name>
- High-speed nets: <list>
- Class: 2 | ΔT: 10 °C | Cu: 1 oz
- MCP fork version: <from server_info>
```

Machine-readable JSON also written to `pcb-lint-<board>-<ISO>.json` in the current project folder so it's diffable across runs (regression detection).

---

## Failure modes

Explicit behaviour when the environment misbehaves. No silent passes.

| Situation | Behaviour |
|---|---|
| MCP bridge unreachable at start (`server_info` fails) | Abort. Report "cannot run: bridge down; click Connect Claude in EDA Pro and re-run". No partial output. |
| MCP bridge dies mid-run | Retry the failing call twice with 1 s back-off. On third failure, save partial report with a `run: incomplete` header, list which checks ran, mark all remaining as `skipped: bridge-lost`. |
| `high_speed_nets` list empty | Skip PCB-03 and PCB-05 with an `info` finding: "no high-speed nets declared; spacing and TVS-proximity checks skipped. Add to `pcb-lint.config.json` to enable." Do not silently pass. |
| MCP call returns malformed/unexpected data | Skip that check only. Emit `info` finding: "check X skipped: MCP returned unparseable payload — attach payload for diagnosis". Continue the run. |
| Board has zero components (empty board) | Abort. Report "no components found; nothing to lint". |
| Config file present but malformed JSON | Abort with `error`: "config unparseable at line N". |
| Config file absent | Run with defaults; emit `info` finding: "no `pcb-lint.config.json` found; running with defaults. Create one to declare per-net current and high-speed nets." |

---

## Test strategy

Each check ships with a fixture board that deliberately violates the rule, plus a control fixture that passes. The check must catch the violation and pass the control. Without this, a silent bug in a check gives false confidence — worse than no lint.

- **Fixture location:** `tests/fixtures/<check-id>/` in this repo. Two `.epro` files per check: `violates.epro` and `passes.epro`.
- **Test runner:** `pytest tests/test_checks.py`; each test opens the fixture via MCP (against a headless EDA Pro instance in CI, or a dev instance locally), runs the single check, asserts the expected finding count and check IDs.
- **Baseline for v1:** all 25 checks (7 SCH + 18 PCB) have paired fixtures before the skill is declared v1.
- **Regression fixture:** Splitflap Board3 acts as the end-to-end fixture — a known real board with its expected lint output snapshotted. A change to any check that alters the Board3 output requires updating the snapshot or fixing the check.
- **Fixture build order:** Phase 1 checks get fixtures during Phase 1; Phase 2 during Phase 2; etc. Do not batch fixture-building to the end.

---

## Implementation phasing

**Phase 0: skill scaffold**
- Create `skills/pcb-lint/` with SKILL.md + a **Python** runner. Python is fixed: MCP client libraries are more mature there, and it stays out of the fork's Node ecosystem so client-side lint iteration doesn't collide with server-side changes.
- SKILL.md declares trigger phrases and describes purpose; runner uses the standard MCP Python client to call fork primitives.
- Scaffold in the paired fixture directory (`tests/fixtures/`) and empty `pytest` harness.

**Phase 1: schematic checks (SCH-01–07)**
- Cheapest and highest signal: netlist + BOM checks catch a lot before layout is even started.
- Ships with 7 pairs of fixture boards.

**Phase 2: layout mechanical + DFM checks (PCB-01, 08, 10, 11, 12, 13, 14, 15, 16, 17, 18)**
- DRC + geometric + DFM checks that don't need net-class knowledge.
- PCB-16 (polarity marks) ships in degraded form if silk-content queryability is limited by the MCP.

**Phase 3: layout signal-integrity checks (PCB-02, 03, 05)**
- Needs `high_speed_nets` list from user. Highest value for Splitflap-class boards.

**Phase 4: current / thermal (PCB-04, 06, 07, 09)**
- Needs per-net current declaration. Ben supplies once per project via `pcb-lint.config.json`.

**Phase 5 (optional): promote proven checks to fork-side server tools**
- After ≥ 3 runs on ≥ 3 different boards, promote any check that fired ≥ 1 real (non-noise) finding into a fork-side MCP tool (e.g. `pcb_check_decoupling_proximity`) so any client — not just this skill — gets it cheap.
- Sequenced on the fork roadmap after C4 (WebSocket auth).

---

## Decisions locked

- **Config file location.** Per-board `pcb-lint.config.json`, versioned next to the `.epro` file. Rationale: config travels with the design and is diffable per board revision.
- **Runner platform.** Python (see Phase 0).
- **Silk-over-pad handover.** Manual, per existing silk check memo (author\'s private notes). Skill emits a `skipped: needs manual` finding and prompts PDF export.

## Open questions before build

1. **How to declare per-net current.** Extend `pcb_manage_net_rules` with a custom `expected_current_a` field, or keep it in the config file. Recommendation: config file to avoid touching fork.
2. **How to declare high-speed nets.** Config file explicit list, or auto-infer (clocks, USB, HDMI patterns) with a manual override. Recommendation: explicit list with optional auto-infer helper.
3. **Threshold tuning per project.** Splitflap tolerances differ from a general-purpose brief. Ship defaults; allow override in config.

---

## First dogfood target

**Splitflap Board3** — boards already ordered 2026-07-18, so this run is retrospective (any find becomes a v2 fix). Second run: any future PCB block before order. Third run: the next Splitflap board revision or the Microbot Exploration first PCB.

---

## Estimated effort

Rough estimates, ±50%. Ranges account for EasyEDA MCP quirks already documented (silk queryability, sheet-locked bugs, TSV-not-CSV BOM export) plus fixture-building overhead not counted in the original spec.

- Phase 0: ~1.5 hours (skill scaffold + Python MCP client wiring + pytest harness).
- Phase 1: ~3 hours (7 schematic checks + 7 fixture pairs).
- Phase 2: ~5 hours (11 mechanical/DFM checks + fixtures; PCB-16 may be partial).
- Phase 3: ~5 hours (spacing math + path tracing + fixtures; the tricky bits).
- Phase 4: ~3 hours (4 current/thermal checks + fixtures).
- Phase 5: separate roadmap item on the fork, sequenced after C4.

Total to v1 (Phases 0–4): **~17.5 hours ±50%** of focused work. Any single phase can ship independently; skill is useful from Phase 1 onward.
