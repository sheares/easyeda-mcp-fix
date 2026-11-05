# EasyEDA Pro 3.2.209 and v1.7.0 to v1.7.3 (5 November 2026)

Branch `feat/eda-3.2.209`, uncommitted at the time of writing. Version 1.7.3 in `package.json` and `extension.json`.

## What changed in EasyEDA

- **Editor 3.2.209** (21 Oct 2026; `Contents/Resources/app/version.txt`). The bundle's `CFBundleShortVersionString`
  still reads 2.2.32.4.
- **Runtime pro-api 0.3.59** (was 0.3.50), shipped locally at
  `/Applications/EasyEDA-Pro.app/Contents/Resources/app/assets/pro-api/0.3.59.1ca9efb5/api.js`. It is 20 RPCs up on
  0.3.50 and removes none:
  - `DMT_EditorControl.waitForDocumentReady` / `getDocumentReadyState`, `DMT_Project.waitForReady` / `getReadyState`;
  - `PCB_Document.startAutoRouting` / `startAutoLayout` / `getAutoJobStatus` / `cancelAutoJob` / `getAutoJobLog`;
  - five `PCB_RayTracerEngine` calls and `SCH_SourcePrimitive{Arc,Rectangle,Text}.add/remove`.
- **Types 0.4.27** (16 Oct). Most of the new API is marked "since EDA v4.1.79". The useful new notes:
  - verbose DRC returns a grouped tree whose length counts categories;
  - `getAllLayers` includes disabled layers;
  - `importChanges` takes a hidden `force` argument, the no-dialog mode (the 3.2.209 host ignores it; see v1.7.2);
  - `saveFileToFileSystem` loses `force`;
  - `lib_Symbol.getDocumentSource` "does not settle" (matches our 3.2.206 finding).
- **The host does not serve the new calls.** The runtime has them, but the host's handler table (`pro-ui
  3.2.198`, `ui.js`, the `PCB_Document:{...}` and `DMT_EditorControl:{...}` maps) lists none of them. `PCB_Document`
  serves 20 calls, ending `autoLayout, autoRouting` (the blocking pair, "since 3.2.150"). `DMT_EditorControl` has no
  `waitForDocumentReady` / `getDocumentReadyState`, and `DMT_Project` has no `waitForReady` / `getReadyState`. All of
  these are marked "since EDA v4.1.79" in the types. An rpcCall with no host handler never settles, so each one hangs.
  Seen live: `startAutoRouting` gave no answer in 20 s (nothing was routed: the next export was byte-identical in
  every zip member), and `waitForDocumentReady` ran past its own 6 s timeout into our 8 s guard.
- **Still broken:** API pour rebuild (same `{ids,isLast:false}` RPC and `.length` on undefined) and library
  `getDocumentSource`. The client code is identical.

## Behaviour seen live on 3.2.209 (a copy of a 4-layer test board, read-only except the scratchpad)

- The handshake and every read we tried work with the 1.6.9 extension.
- `project_get_structure` straight after opening a project returned `data: []`; five seconds later it was full.
  This is the race the new ready-waits exist for.
- PCB DRC with `verbose` returns an array (`[]` when clean); on 3.2.206 it was a bare boolean. Schematic DRC returns
  `[{type:"warn",count:4}]`: categories, not violations.
- The schematic BOM (`getBomFile('csv')`) decodes fine, despite the 0.4.27 note about UTF-16.
- Formats:
  - `getProjectFile` with no type now gives **.epro2** (a zip holding one `{header}||{body}` .epru), which src/lib
    cannot read. `project_export_file` now asks for `epro` when no type is given.
  - `getPickAndPlaceFile` with no type gives **.xlsx**; with `csv` it gives UTF-16LE tab-separated text.
  - `getFlyingProbeTestFile` gives a zip holding one JSON file.

## v1.7.0

1. Types 0.4.27.
2. Ready-waits (`src/extension/ready-wait*.ts`).
   - When: after every document switch, page walk, `editor_open_document`, `lib_*_open_in_editor` and
     `project_get_structure`.
   - How: feature-detected (a no-op before 3.2.209), EasyEDA's own timeout 6 s, our guard 8 s. A breaker skips
     further waits after one hang, and nothing ever throws.
   - **Not yet live-verified:** it needs the 1.7.0 `.eext`.
3. DRC normaliser (`drc-result.ts`). `passed` and `errors` keep their old meaning; `summary` adds the total and the
   count per type, and a note explains the grouped shape.
4. `pcb_import_changes` takes `force` (default false).
5. Autoroute and auto-layout job tools (`autoroute-tools.ts`, `auto-job.ts`, experimental). The start tools back
   the board up first. **Not yet live-verified** (needs the `.eext`).
6. `project_fetch_datasheets` (`datasheets.ts`): the id-pcb recipe.
   - Source order: the JLC `dataManualUrl`, then the wmsc.lcsc.com mirror, then the device's own Datasheet link and
     the first PDF link on that page.
   - Only `%PDF` bytes are saved. Files already there in either naming order are kept, and `INDEX.md` is not
     overwritten when someone else wrote it.
   - Live on the test board: 13 cached, 3 downloaded.
7. `pcb_check_orientation` (`orientation/`). Its inputs are EasyEDA's own files: the .epro2, the flying-probe file
   and the pick-and-place file.
   - Mark check: does the layer-49 mark point at the cathode or pin 1? The question is "which turn of the target pad
     is nearest the mark", because nearest-pad fails on QFN corner dots (on one boost converter's footprint the nearest pad is 2) and module body
     marks.
   - Also checked: the pick-and-place pin 1 on probe pad 1, LED and diode nets, and chip GND/VCC pin nets.
   - Verdict `pass` only with a datasheet for every part.
   - Live on the test board: 16/16 ok with datasheets. Mutating the real data (a diode's pin names swapped, a
     chip's pin 1 nudged 1 mm, an LED's mark turned) gave three errors and nothing else.
8. 287 tests (36 new), build and smoke pass.

## v1.7.1 (same day, after the live test)

1. `src/extension/host-probe.ts`: `answersWithin(call, ms)` and `probeOnce(cache, key, ...)`. A rejection counts as an
   answer; only silence means the host lacks the handler. `typeof fn === 'function'` is no longer trusted for new
   calls.
2. Ready-waits probe first: `getDocumentReadyState` / `getReadyState` with a 1.5 s guard, once per kind (in practice
   until EasyEDA restarts: see v1.7.2 item 5 and v1.7.3) per extension
   load. A silent host turns that wait off, costing 1.5 s once instead of 8 s.
3. Autoroute jobs: `getAutoJobStatus('mcp-probe')` with a 2 s guard decides the path.
   - Answered: the job API, as in 1.7.0 (`mode: "job"`).
   - Silent: `mode: "blocking-fallback"`. The extension starts the blocking `autoRouting(props)` /
     `autoLayout()` without awaiting it and tracks it in `LocalJobStore` (`handlers/auto-job-local.ts`, job ids
     `mcp-blocking-*`).
   - Fallback status reads never touch the host. They report `emulated: true` and `progress: null` until it
     finishes, then EasyEDA's own result (`totalNetsCount`, `successNetsCount`, `failedNets`, `duration`).
   - The fallback cannot be cancelled. After 17 minutes without an answer, the job is reported as failed with
     `NO_ANSWER` (EasyEDA's own ceiling is 15 minutes).
4. `tests/host-probe.test.ts` (10 tests). 297 in all; build and smoke pass.

## v1.7.2 (same day, from the autoroute race)

1. **PCB DRC with violations** returns a nested tree (category, then kind, then violations of about 2 KB each). 751
   violations came to 1.7 million characters, and `limit` did not help because the result is an object.
   `normaliseDrcResult` now does four things:
   - flattens the tree into compact violations (`category, kind, rule, objects, layer, at, message`);
   - lists them smallest group first, capped by the new `maxErrors` (default 100);
   - counts every violation in `summary.byType` and `summary.byKind`;
   - flags stale pours when most hits are pour fill. On the real result: 31 thousand characters, and the 6 real
     faults listed first.
2. **Pipe-source line ends.** Every line ends in `|` except the last. `setDocumentSource` rejects a source that
   breaks this ("Failed to set document source - the format may be invalid"), as happened after deleting the record
   that was last. `normalisePipeLineEnds` (src/lib/schema/parser.ts) repairs the ends in `document_load_from_file`
   and `document_set_source`. The result reports `lineEndsFixed`.
3. **`existing: "remove"`** rips up vias and plain track segments (`LINE`) only. Polyline tracks (`POLY`, which the
   offline layout toolchain writes), copper fills and pour fill stay as obstacles. The tool description says so.
4. **Proxy tool re-sync.** After a daemon restart the stdio proxy re-listed its tools but kept the old registration
   of any tool whose name was unchanged. The MCP SDK validates arguments against the registered zod schema and strips
   keys it does not know, so a new parameter on an existing tool never reached the daemon. Seen live: `maxErrors: 20`
   came back as 100. `src/mcp-server/tool-sync.ts` (`planToolSync`) now re-registers any tool whose description,
   schema or annotations changed. The fix takes effect when Claude Code restarts the proxy.
5. **Ready-wait probe verified live** after Ben restarted EasyEDA: `ready-wait project: unsupported after 1501 ms
   (the host did not answer the ready-state probe within 1500 ms)`, then off. It had not shown before because the
   breaker that 1.7.0 tripped lives on globalThis, which outlives an extension reinstall in the same window. Only an
   EasyEDA restart clears it; the log wording now says so.
6. 304 tests. Live on the 1.7.2 extension: the compact DRC came back with the right totals (768), the 6 router faults
   first, and the stale-pour note.
7. **`force` on `pcb_import_changes` does nothing on 3.2.209.** The runtime sends `{uuid, force}`, but the host's
   `PCB_Document.importChanges` (pro-ui 3.2.198, `ui.js`) reads only a `source` field and runs the interactive
   import. It opens the Import Changes dialog when there are changes and answers `true` as soon as the dialog is up,
   before anything is applied. `uuid` is ignored as well: the host always uses the active board's own schematic.
   The tool description now says so, and the result carries a note whenever `force` is passed.
8. Test fixtures are synthetic: part numbers, net names and designators that came from a real board were replaced.
   306 tests; build and smoke pass.

## v1.7.3 (same day, from the open-items check)

1. **Shared extension state is stamped with the extension version** (`src/extension/shared-state.ts`,
   `versionedShared`). The ready-wait breakers, the host-probe cache, the probe-log flag and the emulated-job store
   now carry the version, and a different version rebuilds them. This closes the case in v1.7.2 item 5, where the
   breaker that 1.7.0 tripped silently stopped 1.7.1's probe until EasyEDA restarted. Cost after an upgrade: one fresh
   short probe, and emulated jobs started by the older version are no longer tracked (the board still gets their
   result).
2. Wording: the job-not-found message and the comments now say "until EasyEDA restarts or a different extension
   version is installed".
3. README: the autoroute entry said the tools wrap 3.2.209's background jobs, which 3.2.209 does not serve. It now
   describes the blocking fallback and says to treat the result as a draft. `pcb_run_drc`'s compact output is listed.
4. **`pcb_check_track_widths`** (`src/bridge-daemon/track-widths.ts`, daemon only). It reads the project export and
   checks every copper track (LINE, ARC, POLY) against its net's track rule: the net's own, its differential pair's,
   its net class's, else the board default (that order is assumed). Inside the PCB document rule values are mil;
   the schematic documents carry mm-valued copies, which are ignored.
   - fail: below the minimum or above the maximum. review: narrower than a net, pair or class rule's default width,
     with the net's copper fills counted. Nets on the board default rule are held to min and max only, or every
     0.15 mm signal track would be flagged.
   - On the race boards: EasyEDA's autorouted board fails on three power nets (0.219 mm against a 0.25 mm class
     minimum), which EasyEDA's DRC never reported. Claude's routing fails nothing; seven power nets are narrower
     than their class default, three of them with fills carrying the current.
   - `pcb_get_auto_job_status` adds `next` once a job completes; the autoroute descriptions and CLAUDE.md point at
     the check; pcb-lint gains PCB-24.
5. The last real-board name in a committed test fixture was replaced.
6. Tests, build and smoke: see the Open list. Item 1 verified live (see the Open list).

## Autoroute race, 4-layer test board (5 Nov)

- **Run 1, routing ripped up in place:** EasyEDA kept all 197 of Claude's polyline records and removed all 102 vias.
  It routed 17 of 43 nets in 4 min 53 s. Invalid as a race.
- **Run 2, from bare placement:** the source was stripped offline of tracks, vias, net fills and pour fill (pour
  outlines and keep-outs kept). 43 of 43 nets were reported routed in 51 s, on layers Top, Inner2 and Bottom, with
  45° corners. The 1.7.1 blocking fallback was used.
- **Scores** (a scratch script comparing both boards' exports). Claude's board is DRC-clean; EasyEDA's was checked
  before the pours were rebuilt.

  | | Claude | EasyEDA |
  |---|---|---|
  | Track length | 490 mm | 762 mm |
  | Vias | 102 (36 GND) | 66 (8 GND) |
  | Power fills | 14 | 0 |
  | Acute corners | 1 | 7 |
  | Segments under 0.13 mm | 14 | 42 |
  | DRC | clean | 6 router faults, plus 745 stale-pour hits |

- **Widths:** EasyEDA used about 0.25 mm everywhere and ignored the net-class widths (the power classes ask for
  0.4 to 1.0 mm). It put 0.22 mm on three power nets, below their class minimum of 0.25 mm.
- **USB:** Claude 13.2 / 13.5 mm with 1 via each; EasyEDA 27.9 / 23.6 mm with 4 vias each.
- **Where EasyEDA did better:** a strapping-pin net (3.3 against 15.1 mm), an I2C clock net (38.0 mm and 2 vias
  against 57.6 mm and 3), three signal nets with 2 vias each against 4, and 12 right-angle corners against 24.
- **pcb_check_orientation** after the run: pass, 16 of 16, with nothing moved.
- **Final DRC, after the pours were rebuilt in the UI:** 6 errors, all from EasyEDA's router; the pour fixed none
  of them.
  - Two stacked vias on one net.
  - The USB pair mismatched by 4.329 mm against a 0.254 mm rule.
  - The I2C clock net open at a via and at a chip pin.
  - Two GND pads still open.
  - Claude's routing, on the same placement: DRC clean.
- Board-specific detail (net names, designators, datasheet reading) is kept with the board's own private notes,
  not in this repo.

## Open

- Verified live:
  - the blocking-fallback autoroute, the compact DRC and the ready-wait probe;
  - `maxErrors`, through a fresh proxy (6 violations, 3 listed, `truncated` says 3 of 6, 1,625 characters);
  - the proxy re-sync: one proxy kept open across a rebuild and `bridge_restart` picked up the new
    `pcb_check_track_widths` (add) and the changed `pcb_autoroute_start` description (replace);
  - `pcb_check_track_widths` on the autorouted board: fail on three power nets, 742 tracks in 315 ms, matching the
    offline run.
- `force` on `pcb_import_changes`: settled from the host code (v1.7.2 item 7), not run live.
- v1.7.3 item 1, live: 1.7.3 installed over 1.7.2 in the same window (same instance id, no EasyEDA restart). The
  project ready-wait probed again (`unsupported after 1501 ms`, new wording), where 1.7.2's breaker, tripped that
  morning, would have kept it silent.
- 313 tests; build and smoke pass.
- Commit, push, tag and release only when Ben says so (public repo: gitleaks first; it is not installed yet).
