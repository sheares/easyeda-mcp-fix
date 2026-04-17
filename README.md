# EasyEDA Agent MCP Server

MCP server that bridges Claude Code (and other MCP clients) to EasyEDA Pro,
plus a TypeScript library for programmatically editing EasyEDA Pro schematics.

## What's Inside

```
src/
  mcp-server/   — The MCP server (TypeScript, stdio transport)
  extension/    — The EasyEDA Pro browser extension (.eext)
  lib/          — Schematic editing library — start at src/lib/README.md
docs/
  schematic-format.md   — Reference for the .esch / .epcb / .epro file format
examples/
  add-fpga-config-resistors.ts — Working example using the editing library
```

## Two Distinct Pieces

### 1. The MCP Server + Extension

A pair of programs connected over WebSocket:

- The **MCP server** runs as a stdio process spawned by an MCP client
  (Claude Code, etc.). It exposes EasyEDA operations as MCP tools.
- The **`.eext` extension** runs inside EasyEDA Pro (browser or desktop).
  It connects to the MCP server's WebSocket and dispatches API calls to
  EasyEDA Pro's internal `eda.*` namespace.

The server scans port range 15168-15207 for active extensions, supports
multiple instances of EasyEDA Pro running simultaneously, and exposes ~80
tools covering schematic primitives, PCB primitives, libraries, manufacture
exports, DRC, and document I/O.

Two notable tool families added 2026-04-09 for high-throughput workflows:

- **`document_get_source` / `document_set_source`** — read/write the entire
  document as a string in EasyEDA's internal NDJSON format
- **`document_save_to_file` / `document_load_from_file`** — same as above
  but routed through local files (avoids context size limits)
- **`project_export_file` / `project_import_file`** — read/write entire
  `.epro` projects as ZIP archives

### 2. The Schematic Editing Library

`src/lib/` is an in-tree TypeScript library for editing EasyEDA Pro
schematics by manipulating the raw NDJSON format directly. It exists
because EasyEDA's per-operation API is too slow for bulk edits — the library
lets you pull the document source, modify it locally as fast as you want,
and push it back in a single round-trip.

It's **not** wired into MCP tools yet (intentional — we're iterating on
the API by writing throwaway `ts-node` scripts). The intended workflow is:

```
1. project_export_file → /tmp/myproject.epro
2. unzip /tmp/myproject.epro -d /tmp/myproject/
3. ts-node a script that uses loadSchematic + SchematicWriter
4. document_load_from_file → push the result back into EasyEDA
```

**Read `src/lib/README.md`** for the full API tour, gotchas, and example.
**Run `examples/add-fpga-config-resistors.ts`** to see it in action.

## Building

```bash
npm install
npm run typecheck     # type-check both server and extension
npm run compile       # build to dist/
npm run build         # build + package extension into .eext file
npm start             # run the MCP server (usually launched by Claude Code)
```

## File Format Reference

`docs/schematic-format.md` documents the `.esch` schematic format:
coordinate system (math coordinates: +X right, +Y up, CCW rotation),
element line formats (COMPONENT, ATTR, WIRE, PIN, FONTSTYLE, HEAD),
the netport recipe, and the gotchas we discovered the hard way (junction
wires required at component-to-component connections, every component
needs a non-empty `Unique ID`, some components resolve their symbol via
`project.json` rather than a `Symbol` ATTR).

## Status

The MCP server has been in active use for several months. The schematic
editing library is new (2026-04-09) and validated against:

- Round-trip integrity (save → push back → only `maxId` changes)
- Adding 12 series resistors + netports to an FPGA's JTAG/config pins
- Auto-designator allocation
- Symbol resolution via `project.json` device fallback
- Verified through `sch_get_connectivity` that the netlist engine sees
  all programmatically-added connections

Component flip handling and PCB editing are not yet implemented in the
library. PCB tools are only available through the MCP server's existing
operation-based API.
