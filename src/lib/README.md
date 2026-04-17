# Schematic Editing Library

A standalone TypeScript library for programmatically editing EasyEDA Pro schematics.
Built so an LLM agent (or human) can express schematic edits at a high level
without dealing with the raw NDJSON format, ID allocation, junction wire
bookkeeping, or coordinate math.

## Why This Exists

EasyEDA Pro's MCP API is operation-based: every component placement, every
attribute change, every wire is a separate WebSocket round-trip to the
extension running inside the EasyEDA app. For bulk edits (placing 12 netports,
adding series resistors, hooking up power rails) this is *slow* — each
operation takes ~100ms+, and a typical chip-hookup might be hundreds of
operations.

The shortcut: EasyEDA Pro exposes `getDocumentSource()` / `setDocumentSource()`
which return/accept the entire raw schematic as a string of newline-delimited
JSON arrays. We can pull the source once, modify it locally as fast as we want,
and push it back in one call. This library is the "modify it locally" part.

## Architecture

Three modules:

- **`schematic-reader.ts`** — parses `.esch` source into a `SchematicModel`.
  Resolves pin world positions (handling component rotation), auto-detects a
  "palette" of reusable templates (netport symbol, power symbols, component
  templates with their font styles), and builds an index of components by
  designator.

- **`schematic-writer.ts`** — `SchematicWriter` class that applies edits.
  Handles all the low-level invariants automatically:
  - Sequential element ID allocation (`eN`)
  - Unique ID assignment (`ggeN`)
  - `maxId` bookkeeping in HEAD
  - Junction wire creation at component-to-component connections
  - Designator auto-allocation (R25, R26, ...)

- **`loader.ts`** — `loadSchematic()` convenience function that takes an
  extracted `.epro` directory and a schematic UUID, then loads the source +
  all symbol files + project.json and returns a fully-parsed model ready
  for editing.

## Workflow

The library is **not currently wired into MCP tools**. The intended workflow
is to write throwaway `ts-node` scripts that use the library directly:

```
1. Use MCP tool `project_export_file` to save .epro to /tmp/something.epro
2. Unzip it: `unzip /tmp/something.epro -d /tmp/project/`
3. Write a TypeScript script that:
     - calls loadSchematic('/tmp/project', schematicUuid)
     - creates a SchematicWriter
     - calls high-level edit methods
     - writes the result to /tmp/output.esch
4. Use MCP tool `document_load_from_file` to push it back into EasyEDA
```

Why throwaway scripts instead of MCP tools? Because we don't yet know what the
right MCP tool API looks like. By writing scripts, we can iterate on the
library API freely. Once patterns stabilize, the most useful operations can
be wrapped as MCP tools.

## Complete Example

See `examples/add-fpga-config-resistors.ts` for a working script that
adds 22Ω series resistors between an FPGA's JTAG/config pins and netports.

Quick API tour:

```typescript
import { loadSchematic, SchematicWriter } from '../src/lib';
import { writeFileSync } from 'fs';

const eproDir = '/tmp/easyeda-roundtrip/project';
const schematicUuid = '49824b837e2e4a0aa9218bb56d44ac5f';

// Load — this gives you a fully-parsed model with pin world positions
const { source, model } = loadSchematic(eproDir, schematicUuid);

// Inspect what's available
console.log('Components:', model.components.length);
console.log('Component palette:', Object.keys(model.palette.components));
console.log('Power symbols:', Object.keys(model.palette.powerSymbols));

// Find a specific pin
const u2 = model.components.find(c => c.designator === 'U2');
const tckPin = u2?.pins.find(p => p.name === 'TCK');
console.log(`TCK at world (${tckPin.worldX}, ${tckPin.worldY}) angle=${tckPin.worldAngle}`);

// Build edits
const writer = new SchematicWriter(source, model);

// Add a netport (auto-positions and rotates from the pin)
writer.addNetport('FPGA_TCK', 'U2:TCK');           // by pin name
writer.addNetport('FPGA_PA0', 'U3.14');            // by designator.pinNumber

// Add a series resistor (auto-allocates designator R25, R26, ...)
writer.addSeriesResistor('0402WGF220JTCE', 'U2:TMS', 'FPGA_TMS');

// Add a power symbol
writer.addPowerSymbol('GND', 'U2.4');

// Stamp a component manually
writer.addComponent('CL05B104KO5NNNC', writer.allocDesignator('C'), 1000, 500, 0);

// Remove an element (and all its ATTRs)
writer.removeElement('e6827');

// Serialize and write
writeFileSync('/tmp/output.esch', writer.serialize());
```

## Key Concepts

### Pin References

Methods that take a `pinRef` accept two formats:
- **`"U2.16"`** — designator + pin number (after the dot)
- **`"U2:TCK"`** — designator + pin name (after the colon)

Use pin names when the symbol has them (most ICs label their special-function
pins like TCK, TDI, MOSI, etc.). Use pin numbers as a universal fallback.

### The Palette

`model.palette` is auto-detected from existing components in the schematic.
It contains:

- **`netport`** — the symbol/device UUIDs and font styles for the netport
  template. Used by all `addNetport*` calls.
- **`powerSymbols`** — map of rail name (`GND`, `VCC`, etc.) to symbol/device
  UUIDs. Used by `addPowerSymbol`.
- **`components`** — map of part name (without the trailing `.1`) to symbol
  UUID, device UUID, and font styles. Used by `addComponent` and
  `addSeriesResistor`.
- **`wireLineStyle`** — typically `"st9"`. Used for all new wires.

If you try to use a part that's not in the palette, you'll get an error
listing what *is* available. To add a new part type to a project, manually
place one instance via the EasyEDA UI first, then re-export — that embeds
the symbol/footprint/device data.

### Coordinate System & Rotation

EasyEDA uses **standard math coordinates**: `+X = right`, `+Y = up`, angles
counterclockwise. Visually higher on screen = larger Y value. See
`docs/schematic-format.md` for the full reference.

The reader pre-computes pin world positions accounting for component rotation,
so you usually don't have to do coordinate math yourself.

### Gotchas

These are documented in `docs/schematic-format.md` but worth repeating because
they bit us during development:

1. **Component pins do NOT auto-connect by overlapping.** A zero-length wire
   `[[x,y,x,y]]` must exist at every junction where two component pins meet.
   The writer's `addSeriesResistor` and `addPowerSymbol` handle this
   automatically. If you're placing components manually with `addComponent`
   and they share a pin position with another component, call
   `writer.addJunctionWire(x, y)` at the connection point.

2. **Every component needs a non-empty Unique ID** (`ggeN`) or the netlist
   engine silently ignores it — the component won't appear in connectivity
   queries or DRC. The writer handles this automatically for components
   added via `addComponent`. Netports and power symbols don't need them.

3. **Some components have no explicit `Symbol` ATTR.** In that case the symbol
   UUID is only stored in `project.json` under the device entry. The reader
   handles this fallback automatically when given `project.json` (which
   `loadSchematic` does for you).

## Status

Working as of 2026-04-09. Validated against:
- Round-trip (save → push back unchanged) — only `maxId` changes
- Adding netports to FPGA pins (12 connections, both sides of chip)
- Adding 22Ω series resistors with junction wires (verified in JLCEDA netlist
  output via `sch_get_connectivity`)
- Auto-designator allocation (scans existing components for max R, C, U)
- Symbol resolution via project.json fallback (CH572 with no Symbol ATTR)

Not yet built (potential next features):
- Power rail hookup (`connectPowerPins(designator, mapping)`)
- Decoupling cap placement (`addDecouplingCaps`)
- Bus connections (`connectBus(srcPins, dstPins, netPrefix)`)
- Wire routing (real wires instead of netports — needs spatial reasoning)
- Component flip handling (untested)

## See Also

- `docs/schematic-format.md` — reference for the .esch / .esym / .epcb format
- `examples/` — working example scripts
- Memory file `easyeda-epro-format.md` in the user's auto-memory
