# easyeda-mcp-fix

Bug-fix fork of the EasyEDA Pro MCP bridge. Resolves silent BOM wipes, dead
copper to SMD pads and five-minute netlist hangs, hardened on a real board
taken to fab.

Base: [`javawizard/easyeda-agent-mcp-server`](https://github.com/javawizard/easyeda-agent-mcp-server)
(itself a fork of [`QuincySx/easyeda-agent-mcp-server`](https://github.com/QuincySx/easyeda-agent-mcp-server)).

## Quick start (students start here)

Connect Claude Code to EasyEDA Pro so Claude can read, check and edit your
schematics and PCBs, then lint a board before you order it.

**Follow the step-by-step [student guide](docs/student-guide.md).** In short:

1. Download `easyeda-mcp.zip` from the [latest release](https://github.com/sheares/easyeda-mcp-fix/releases/latest)
   and unzip it into your home folder. No build step needed.
2. In EasyEDA Pro: **Advanced → Extension Manager → Import** the `.eext`,
   then turn on **External Interactions** and **Show in top menu**.
3. Register the server with Claude Code:
   `claude mcp add --scope user easyeda -e EDA_REQUEST_TIMEOUT_MS=180000 -- node "$HOME/easyeda-mcp/dist/mcp-server/index.js"`
4. Install the board checker: `cp -R ~/easyeda-mcp/skills/pcb-lint ~/.claude/skills/`
5. In EasyEDA, open a schematic or PCB and click **Claude → Connect Claude**.
   Then ask Claude to "check the EasyEDA connection", or run `/pcb-lint`.

| Platform | Status |
|---|---|
| macOS | Tested (EasyEDA Pro desktop 3.2.149) |
| Linux | Should work, untested |
| Windows | Not yet: the bridge fails at start-up on native Windows. WSL2 untested. See the guide |

### pcb-lint: a board checker skill

[`skills/pcb-lint/`](skills/pcb-lint/) is a Claude Code skill that runs 26
design-hygiene checks (12 schematic, 14 PCB) through this bridge and writes
a scored report: regulator output against downstream abs-max, USB-C CC
pull-downs, ESP32 strapping pins, first-flash power path, decoupling
distance, annular ring, mask dams, copper-to-edge clearance, antenna
keep-outs and more. Type `/pcb-lint` in Claude Code with a board open. See
its [README](skills/pcb-lint/README.md) and [SKILL.md](skills/pcb-lint/SKILL.md).

---

The rest of this page is for developers: what the fork fixes, how it is
secured, and how to build it.

## Why this fork exists

The upstream `easyeda-agent-mcp-server` extension bridges Claude Code (and
other MCP clients) to EasyEDA Pro, exposing the internal `eda.*` API as ~98
MCP tools. Excellent design in the small, but during Splitflap Controller
Board 3 bring-up (June 2026) six upstream bugs surfaced that turned
day-to-day workflows into data-loss risks:

- A single `sch_modify_component` call on any parameter (just `x`, say)
  silently wiped `supplierId` and blanked every field of `otherProperty`.
  Twenty-four components lost their BOM lines in one batch before the
  pattern was noticed. The schematic looked correct in the canvas.
- The Board 3 PCB layout passed clearance DRC, and the canvas rendered
  cleanly, but every API-drawn track was electrically dead to its SMD
  pads. Only a No-Connection check surfaced it.
- Every read that needed pin-to-net data hung about five minutes, then
  rejected with nothing. Neither cache nor higher timeouts helped.

Each turned out to have a specific root cause, not just a slow API, so the
fixes below are deterministic rather than workarounds. All six were
live-verified against Splitflap Board 3 taken to fab.

## What's fixed

| # | Symptom on upstream | Root cause | Fix in this fork |
|---|---|---|---|
| 1 | `sch_modify_component` on any parameter silently overwrites `supplierId` with the raw symbol filename and blanks `otherProperty` (Value, LCSC part, tolerance, voltage, datasheet). BOM broken. | Modify re-serialises the component from the symbol, losing metadata. | Snapshot the component via `sch_PrimitiveComponent.get` before write, merge `supplierId`, `otherProperty`, `manufacturer`, `manufacturerId`, `supplier`, `uniqueId` around the caller's property (`preserveMetadataOnModify`, `sch-component.ts`). |
| 2 | `sch_get_all_components allSchematicPages:true` still returns only the active page. | The flag is forwarded to `eda.sch_PrimitiveComponent.getAll`, which ignores it. | Fan out per-page via `dmt_Schematic.getAllSchematicPagesInfo` + `openDocument`. Landing page verified, original active page restored in `finally`, unhandled-rejection safe. |
| 3 | `sch_get_netlist` and every read that needs pin-to-net (connectivity queries, `={...}` template resolution) hangs ~5 min then rejects empty. | Calls `@deprecated eda.sch_Netlist.getNetlist(JLCEDA)`. The deprecated path triggers a blocking JLC reconciliation that never resolves headlessly, even though DRC and File → Export Netlist finish in ~1 s on the same project. | Route through `sch_ManufactureData.getNetlistFile('netlist', JLCEDA_PRO)` (measured 766 ms vs 300 000 ms failure). New parser for the v2.0.0 `{version, components:{uid:{props, pinInfoMap}}}` shape; legacy flat shape kept for the deprecated fallback. Unconnected pins are omitted so they cannot read as a shared net. |
| 4 | API-drawn tracks and arcs are electrically dead to their SMD pads. Clearance DRC passes; only a No-Connection check surfaces it. | EasyEDA stores the `layer` param verbatim (`"TopLayer"`); native SMD pads use numeric `layerId:1`; EasyEDA's connectivity test uses loose `==` so `"TopLayer" == 1` is false. | Central `layer` name → numeric `EPCB_LayerId` conversion on every `pcb.*` write path (`ws-client.ts` dispatch). Names or numbers both accepted. Unknown names throw. Covers line, arc, polyline, pour, fill, region, pad and `pcb_move_component`'s target-layer flip. |
| 5 | `pcb_create_polyline_track` rejects every call as `Invalid polygon data`. Multi-corner routes have to be built from N individual `pcb_create_track` segments. | Handler passes a raw array where `pcb_PrimitivePolyline.create` expects an `IPCB_Polygon`; the fork's own tool documentation had the L-mode source order wrong (leading `L` token). | Handler wraps input via `pcb_MathPolygon.createPolygon`. Ergonomic `[{x, y}, ...]` point arrays now work. Source order corrected to `x1 y1 L x2 y2 ...` per `TPCB_PolygonSourceArray` JSDoc; pour/fill/region tool descriptions fixed too. |
| 6 | Schematic-editing library computes pin world coordinates wrongly for mirrored components (`flip=1`). Downstream `addNetport` / `addSeriesResistor` / `addPowerSymbol` write at those wrong coordinates. | `schematic-reader.ts` pin resolution never consulted `comp.flip`. | Mirror about local Y before rotate (matching the verified `geometry.ts` convention), plus pin-angle flip (`θ → 180 − θ`, normalised to `[0, 360)`). Regression coverage in `tests/schematic-reader-flip.test.ts`. |

All six live-verified on Splitflap Controller Board 3: DRC returns zero,
connectivity queries return real nets in under a second, and the numeric
layer id is round-tripped through `pcb_get_primitives_by_id`.

## Not fixed (yet)

Deliberate limits, kept honest:

- **Sheet-locked modify.** `sch_modify_component`'s `document` param does
  not reassign a primitive across schematic pages; empirically confirmed
  by trying it and catching the underlying `undefined.getState_ComponentType`.
  Cross-page moves still require manual UI Cut, switch page, Paste.

## Security audit

[`AUDIT.md`](docs/dev-notes/AUDIT.md) documents the whole codebase across the three layers
(MCP server, bridge daemon, EDA Pro extension) with severity ratings.
Seven criticals were identified; all seven are resolved on this branch.

C4 (WebSocket authentication) is a mutual HMAC challenge-response
(hmac-v1, since v1.6.0): the daemon writes a per-run random token (mode
0600, inside its 0700 state dir) and challenges every connection with a
fresh nonce; the extension reads the token itself (path shape validated)
and answers with an HMAC over the nonces, and the daemon proves its own
token knowledge back with a domain-separated HMAC the extension verifies.
The raw token never crosses the wire, and a rogue process that binds the
port cannot impersonate either side. A wrong answer always closes the
socket.

Since v1.6.1 the extension also *enforces* its side: when it could read the
token, it refuses every request from a daemon that has not proven itself,
whether the daemon's `auth.ok` failed, never arrived (15 s window from the
challenge, since v1.6.2; 5 s in v1.6.1), or the peer did not offer hmac-v1
at all. The refusal is a clear error on each call plus a one-time toast. A
valid `auth.ok` that arrives after the window (a slow handshake, not a
rogue: a rogue cannot forge the MAC) upgrades the verdict, a second toast
says so, and requests resume without a reconnect. A connection that *cannot* read the token (the
browser web app, or a desktop install without the extension's external
interaction permission) has nothing to check and is still accepted on
Origin trust, matching pre-C4 behaviour. Set `EDA_WS_AUTH=require` in the
daemon's environment to refuse those too (hardened mode; desktop client
only, and the extension's external interaction permission must be
enabled).

Upgrade notes: a v1.6.x `.eext` never sends the raw token. A v1.6.1+
`.eext` against a pre-1.6.0 daemon refuses all requests until the daemon
is restarted on the new build (`bridge_restart` still works: the daemon
answers it without touching the extension). The daemon stays resident
across rebuilds while any MCP client is attached, so after a rebuild check
`server_info`: it reports `daemonVersion`, each instance's
`extensionVersion`, and `versionMismatch`. EasyEDA ignores a same-version
`.eext` reinstall, so bump the version before rebuilding.

Two QA passes on 2026-07-24
([`QA-REPORT-2026-07-24.md`](docs/dev-notes/QA-REPORT-2026-07-24.md),
[`QA-DEEP-REPORT-2026-07-24.md`](docs/dev-notes/QA-DEEP-REPORT-2026-07-24.md)) drove a
further hardening round: document-switch verification before every routed
operation, pre-write backups on bulk supplier swaps, MCP risk annotations
on all ~100 tools, the mutual auth above, and assorted transport and
correctness fixes. See [`HANDOVER-2026-07-24.md`](docs/dev-notes/HANDOVER-2026-07-24.md)
for the work-order trail. A third pass on 2026-08-23
([`QA-REPORT-2026-08-23.md`](docs/dev-notes/QA-REPORT-2026-08-23.md)) verified that round
live and produced v1.6.1: request gating on daemon verification, version
reporting in `server_info`, in-place log rotation, and smaller fixes. A
fourth pass on 2026-09-06
([`QA-REPORT-2026-09-06.md`](docs/dev-notes/QA-REPORT-2026-09-06.md)), after two weeks of
field use, produced v1.6.2: late-`auth.ok` recovery and a headless harness
for the extension's request pipeline. v1.6.3 fixed new-project imports and
v1.6.4 added the library footprint tools.

### Environment variables

All knobs are daemon/server side; the extension has no environment access.

| Variable | Default | Purpose |
|---|---|---|
| `EDA_BRIDGE_STATE_DIR` | `~/.easyeda-mcp` | State dir (UDS socket, pid file, ws-token, bridge.log) |
| `EDA_WS_PORT` | `16168` | Daemon WS port. The extension always dials 16168 (it cannot see env vars), so changing this strands it: test use only |
| `EDA_WS_AUTH` | unset | `require` refuses WS connections that do not prove token knowledge |
| `EDA_WS_ALLOW_ALL_ORIGINS` | unset | `1` disables the WS Origin allowlist. Debugging escape hatch only; the daemon logs a loud warning at startup and `server_info` reports it |
| `EDA_BRIDGE_IDLE_EXIT_SEC` | `5` | Daemon exits this many seconds after the last MCP client disconnects (`0` = immediate) |
| `EDA_BRIDGE_DAEMON_ENTRY` | `dist/bridge-daemon/index.js` | Daemon entry override (tests point it at the .ts source) |
| `EDA_REQUEST_TIMEOUT_MS` | `45000` | Per-RPC extension timeout; the MCP proxy's call timeout derives from it (3x + 30 s). `EASYEDA_REQUEST_TIMEOUT_MS` is an accepted alias |
| `EDA_BACKUP_DIR` | `~/.easyeda-mcp-backup` | Git-tracked backup repo for destructive operations |
| `EDA_DISCOVERY_LOG` | `~/.easyeda-schema-discovery.jsonl` | Where unknown schema tags are logged for schema growth |

## Install from source

Students: use the [release download](#quick-start-students-start-here)
instead. This is for changing the code.

```bash
git clone https://github.com/sheares/easyeda-mcp-fix.git
cd easyeda-mcp-fix
npm install
npm test              # 205 tests
npm run build         # produces dist/ and build/dist/easyeda-agent-mcp-server_vN.N.N.eext
```

Then in EasyEDA Pro (v3):

1. **Advanced → Extension Manager → Import** the built `.eext` from
   `build/dist/`. (EasyEDA Pro v2: **Settings → Extensions → Extension
   Manager → Import Extension**.)
2. Select the extension and turn on **External Interactions** and
   **Show in top menu**.
3. Open a schematic or PCB and click **Claude → Connect Claude**.

Register the server with your MCP client. For Claude Code:

```bash
claude mcp add --scope user easyeda -- node "$(pwd)/dist/mcp-server/index.js"
```

The bridge daemon is spawned automatically on the first tool call and
listens on `127.0.0.1:16168`. `dist/` is fully bundled (no
`node_modules` needed at run time), which is what the release zip ships.

Same-version reinstalls are a no-op in EasyEDA Pro. Bump the version in
`extension.json` before rebuilding if you want your changes to take
effect.

## Provenance

- Base: `javawizard/easyeda-agent-mcp-server` at commit `3b8f2e5` (the
  extended fork with per-request `document` param dispatch already
  threaded through `ws-client.ts`).
- Original: `QuincySx/easyeda-agent-mcp-server`.
- MIT licence, inherited. See [`LICENSE`](LICENSE).

---

## What's inside

```
src/
  mcp-server/    the MCP server (TypeScript, stdio transport)
  bridge-daemon/ the WebSocket bridge between MCP server and extension
  extension/     the EasyEDA Pro extension (.eext), incl. bug-fix handlers
  lib/           schematic editing library (start at src/lib/README.md)
skills/
  pcb-lint/      Claude Code skill: board design-hygiene checks
docs/            student guide, .esch / .epcb / .epro file format reference
  dev-notes/     audit, QA reports and handover work orders
examples/        working examples using the editing library
tests/           205 tests (node --test, ts-node)
```

## Two distinct pieces

### 1. The MCP server + extension

A pair of programs connected over WebSocket:

- The **MCP server** runs as a stdio process spawned by an MCP client. It
  exposes EasyEDA operations as MCP tools.
- The **`.eext` extension** runs inside EasyEDA Pro (browser or desktop).
  It connects to the MCP server's WebSocket and dispatches API calls to
  EasyEDA Pro's internal `eda.*` namespace.

The server exposes ~100 tools covering schematic primitives, PCB
primitives, libraries, manufacture exports, DRC and document I/O.
Multiple EasyEDA Pro instances can share one daemon; every tool takes an
optional `instance_id` and `document` param for cross-tab routing.

Two tool families are worth calling out for high-throughput workflows:

- **`document_get_source` / `document_set_source`** read and write the
  entire document as a string in EasyEDA's internal NDJSON format.
- **`document_save_to_file` / `document_load_from_file`** do the same via
  local files (avoids MCP payload size limits).
- **`project_export_file` / `project_import_file`** read and write
  entire `.epro` projects as ZIP archives. A new-project import is saved to
  the team/workspace of the project open in the target window (fixed in
  v1.6.3: before that, EasyEDA silently rejected every new-project import).
- **`sch_export_bom`** returns the schematic-side BOM as parsed rows
  (the source of truth for supplier metadata), handy for verifying BOM
  integrity after batch edits.
- **`sch_swap_supplier_part`** does a filter-and-replace on supplier
  metadata across matched components in one call, reusing the bug-1
  metadata guard so nothing else is wiped; supports `dryRun` for a
  preview before the real swap.

### 2. The schematic editing library

`src/lib/` is an in-tree TypeScript library for editing EasyEDA Pro
schematics by manipulating the raw NDJSON format directly. It exists
because EasyEDA's per-operation API is too slow for bulk edits; the
library lets you pull the document source, modify it locally, and push it
back in a single round trip.

Its Zod schemas ARE wired into the MCP tools: `document_set_source` and
`document_load_from_file` uploads are validated against them (strict by
default), and `document_validate` exposes the check directly (see
`src/bridge-daemon/tools/schema-tools.ts`). The writer API itself is not
exposed as MCP tools (intentional); the intended workflow:

```
1. project_export_file → /tmp/myproject.epro
2. unzip /tmp/myproject.epro -d /tmp/myproject/
3. ts-node a script that uses loadSchematic + SchematicWriter
4. document_load_from_file → push the result back into EasyEDA
```

Read `src/lib/README.md` for the API tour and gotchas.
Run `examples/add-fpga-config-resistors.ts` to see it in action.

## Building

```bash
npm install
npm run typecheck    # type-check both server and extension
npm run compile      # build to dist/
npm run build        # build + package extension into .eext file
npm test             # run the full test suite
npm start            # run the MCP server (usually launched by an MCP client)
```

## File format reference

[`docs/schematic-format.md`](docs/schematic-format.md) documents the
`.esch` schematic format: coordinate system (math coordinates: `+X`
right, `+Y` up, CCW rotation), element line formats (`COMPONENT`,
`ATTR`, `WIRE`, `PIN`, `FONTSTYLE`, `HEAD`), the netport recipe, and
the gotchas discovered the hard way (junction wires required at
component-to-component connections, every component needs a non-empty
`Unique ID`, some components resolve their symbol via `project.json`
rather than a `Symbol` ATTR).
