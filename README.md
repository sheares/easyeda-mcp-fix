# easyeda-mcp-fix

Bug-fix fork of the EasyEDA Pro MCP bridge. Resolves silent BOM wipes, dead
copper to SMD pads and five-minute netlist hangs, hardened on a real board
taken to fab.

Base: [`javawizard/easyeda-agent-mcp-server`](https://github.com/javawizard/easyeda-agent-mcp-server)
(itself a fork of [`QuincySx/easyeda-agent-mcp-server`](https://github.com/QuincySx/easyeda-agent-mcp-server)).

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
- **WebSocket authentication (audit item C4).** The daemon only checks
  the `Origin` header, which any local process can spoof. Local-only
  threat model, still the last open critical. See
  [`AUDIT.md`](AUDIT.md#c4-ws-listener-has-no-authentication).

## Security audit

[`AUDIT.md`](AUDIT.md) documents the whole codebase across the three layers
(MCP server, bridge daemon, EDA Pro extension) with severity ratings.
Seven criticals were identified; six are resolved on this branch. C4 is
the last one open.

## Install

```bash
git clone https://github.com/sheares/easyeda-mcp-fix.git
cd easyeda-mcp-fix
npm install
npm test              # 69 tests
npm run build         # produces build/dist/easyeda-agent-mcp-server_vN.N.N.eext
```

Then in EasyEDA Pro:

1. **Settings → Extensions → Install** the built `.eext` from
   `build/dist/`.
2. Open the extension's page, tick **Allow interactive with external**
   and **Show at header menu**.
3. Click **Claude → Connect Claude** from the header menu.

Point your MCP client (Claude Code or otherwise) at the
`easyeda-agent-mcp-server` binary in `dist/mcp-server/`. The bridge
daemon is spawned automatically on first tool call and listens on
`127.0.0.1:16168`.

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
docs/            .esch / .epcb / .epro file format reference
examples/        working examples using the editing library
tests/           69 tests (node --test, ts-node)
```

## Two distinct pieces

### 1. The MCP server + extension

A pair of programs connected over WebSocket:

- The **MCP server** runs as a stdio process spawned by an MCP client. It
  exposes EasyEDA operations as MCP tools.
- The **`.eext` extension** runs inside EasyEDA Pro (browser or desktop).
  It connects to the MCP server's WebSocket and dispatches API calls to
  EasyEDA Pro's internal `eda.*` namespace.

The server exposes ~98 tools covering schematic primitives, PCB
primitives, libraries, manufacture exports, DRC and document I/O.
Multiple EasyEDA Pro instances can share one daemon; every tool takes an
optional `instance_id` and `document` param for cross-tab routing.

Two tool families are worth calling out for high-throughput workflows:

- **`document_get_source` / `document_set_source`** read and write the
  entire document as a string in EasyEDA's internal NDJSON format.
- **`document_save_to_file` / `document_load_from_file`** do the same via
  local files (avoids MCP payload size limits).
- **`project_export_file` / `project_import_file`** read and write
  entire `.epro` projects as ZIP archives.

### 2. The schematic editing library

`src/lib/` is an in-tree TypeScript library for editing EasyEDA Pro
schematics by manipulating the raw NDJSON format directly. It exists
because EasyEDA's per-operation API is too slow for bulk edits; the
library lets you pull the document source, modify it locally, and push it
back in a single round trip.

It's not wired into MCP tools yet (intentional). The intended workflow:

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
