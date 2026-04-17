# EasyEDA Pro Schematic Format Reference

## .epro File Structure

`.epro` files are ZIP archives containing human-readable NDJSON (newline-delimited JSON arrays):

```
project.json              — manifest: boards, schematics, pcbs, symbols, footprints, devices, config
SHEET/{uuid}/1.esch       — schematic pages
PCB/{uuid}.epcb           — PCB layouts
SYMBOL/{uuid}.esym        — component symbols (embedded copies)
FOOTPRINT/{uuid}.efoo     — component footprints (embedded copies)
INSTANCE/{base64}.eins    — per-instance attribute overrides (designators, unique IDs)
POUR/                     — copper pours
PANEL/                    — panelization data
BLOB/                     — binary blobs (images)
FONT/                     — custom fonts
```

`project.json` has top-level keys: `schematics`, `pcbs`, `panels`, `symbols`, `footprints`, `devices`, `boards`, `config`. The `boards` key maps board name → `{schematic: uuid, pcb: uuid}`.

## Coordinate System

**Standard math coordinates** (not screen coordinates):

- **+X = rightward**
- **+Y = upward**
- Visually higher on screen = larger Y value

Verified 2026-04-09 with reference netports placed at known visual positions.

## Rotation Angles

**Standard counterclockwise** rotation in degrees:

| Rotation | Direction       | Netport use case     |
|----------|----------------|---------------------|
| **0**    | Right (+X)     | Left side of chip    |
| **90**   | Up (+Y)        | Below chip           |
| **180**  | Left (-X)      | Right side of chip   |
| **270**  | Down (-Y)      | Above chip           |

"Netport use case" assumes IN-style netports (arrow points toward the chip/pin).

## Pin World Position

For a component at `(cx, cy)` with rotation `R` (degrees, CCW) and flip `F`:

**When R=0, F=0 (no rotation, no flip):**
```
pin_world_x = cx + pin_symbol_x
pin_world_y = cy + pin_symbol_y
pin_world_angle = pin_symbol_angle
```

**For arbitrary rotation R**, apply the standard 2D rotation matrix to the symbol offset:
```
rx = sx * cos(R) - sy * sin(R)
ry = sx * sin(R) + sy * cos(R)
pin_world_x = cx + rx
pin_world_y = cy + ry
pin_world_angle = (pin_symbol_angle + R) % 360
```

The `SchematicReader` in `src/lib/` does this automatically — every `PinInfo` has pre-computed `worldX`, `worldY`, and `worldAngle`. The flip dimension is currently untested in our edits.

## Resolving Symbol UUIDs

A component's symbol UUID is normally found in its `Symbol` ATTR line:
```json
["ATTR","e11367","e11366","Symbol","c480da12fd764d4bad90f57977a42a9c",...]
```

**However, some components have no `Symbol` ATTR.** In that case, look up the symbol via the device entry in `project.json`:

```
component.Device UUID  →  project.json.devices[uuid].attributes.Symbol
```

This was discovered with the CH572 chip (U1) in the experimental project — it had only a `Device` ATTR, not a `Symbol` ATTR. There can also be multiple device entries pointing to different symbol representations of the same part (e.g., compact vs. detailed pinout).

The `SchematicReader` handles both paths automatically when given `project.json` as input.

## Element Line Formats

### HEAD
```json
["HEAD", {"originX": 0, "originY": 0, "version": "2", "maxId": 10225}]
```
`maxId` must be ≥ all `eN` element IDs used in the file.

### COMPONENT
```json
["COMPONENT", "e4422", "CH572D.1", 1180, 885, 0, 0, {}, 0]
```
Fields: `[type, id, partName, x, y, rotation, flip, props, layer]`

### ATTR
```json
["ATTR", "e291", "e267", "Designator", "R1", null, 1, 370, 575, null, "st13", 0]
```
Fields: `[type, id, parentId, key, value, ?, visible?, x, y, ?, fontStyle, ?]`

### WIRE
```json
["WIRE", "e4711", [[900,875,900,855],[900,855,1000,855]], "st9", 0]
```
Fields: `[type, id, segments, lineStyle, ?]`
- Each segment is `[x1, y1, x2, y2]`
- Zero-length wires `[[x,y,x,y]]` are connection points (for netports/power symbols)

### PIN (in symbol files)
```json
["PIN", "e5", 1, null, -180, 20, 10, 0, null, 0, 0]
```
Fields: `[type, id, ?, ?, x, y, length, angle, ?, ?, ?]`

### FONTSTYLE
```json
["FONTSTYLE", "st6", null, null, null, null, 0, 0, 0, null, 2, 0]
```
Referenced by ID (e.g., `"st6"`) from ATTR lines.

## Netport Recipe (IN-style, 7 lines)

To connect a netport named `NET_NAME` at position `(X, Y)` with rotation `R`:

```json
["COMPONENT","eA","",X,Y,R,0,{},0]
["ATTR","eB","eA","Symbol","<netport-symbol-uuid>",null,null,null,null,null,"<fontstyle>",0]
["ATTR","eC","eA","Name","NET_NAME",null,null,null,null,null,"<fontstyle>",0]
["ATTR","eD","eA","Device","<netport-device-uuid>",0,0,null,null,0,"<fontstyle>",0]
["ATTR","eE","eA","Relevance","[]",0,0,RX,RY,0,"<fontstyle>",0]
["WIRE","eF",[[X,Y,X,Y]],"<linestyle>",0]
["ATTR","eG","eF","NET","NET_NAME",0,0,X,Y,90,"st4",0]
```

- Symbol/Device UUIDs and font/line styles: copy from an existing netport in the same schematic.
- Element IDs (eA–eG): sequential, starting above current `maxId`.
- Update `maxId` in HEAD after adding elements.

## Unique IDs

Every component (ICs, resistors, caps, etc.) **must** have a non-empty `Unique ID` attribute, or the netlist engine will silently ignore it — the component won't appear in connectivity queries or DRC.

Manually-placed components get IDs like `gge4`, `gge50`, etc. When programmatically adding components, assign sequential IDs starting above the highest existing `ggeN` value:

```json
["ATTR","eXXX","eCOMPONENT","Unique ID","gge68",0,0,null,null,0,"st4",0]
```

Netports and power symbols do NOT need Unique IDs (they don't appear in the netlist as components).

## Adding New Component Instances

If the component type (symbol, footprint, device) is **already in the project**, you can freely stamp out more instances — the embedded library data is shared.

For **new component types** not yet in the project, place one instance via the EasyEDA UI or `sch_create_component` API first, then re-export. This embeds the required symbol/footprint/device data.

## Junction Wires

**Component pins do NOT auto-connect by overlapping.** When two component pins meet at the same coordinate (e.g., a resistor pin touching an IC pin), a zero-length wire `[[x,y,x,y]]` must be placed at the junction point to create the electrical connection. Without this wire, the pins are visually overlapping but electrically disconnected.

This applies to all component-to-component connections, not just netports. Netports already include a zero-length wire as part of their recipe, but inline components (resistors, caps, etc.) placed between a chip pin and a netport need an additional junction wire on the chip side.

## Round-Trip Behavior

- `setDocumentSource()` bumps `maxId` internally — this is normal.
- All other content survives round-trip byte-identical.
- Validated 2026-04-09: save → load unchanged → diff shows only `maxId` change.
