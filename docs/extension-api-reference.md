# EasyEDA Pro Extension API Reference

Quick-reference distilled from `node_modules/@jlceda/pro-api-types/index.d.ts` (the type package shipped with EasyEDA's extension SDK). Every API is exposed off the global `eda` object inside an extension's worker context.

## ⚠️ Performance caveat — read first

Every live API call round-trips to the EasyEDA front-end and is **slow** — empirically ~2–3 seconds per primitive insertion. Fine for surgical/single edits, useless for bulk work.

For bulk operations keep using the export/edit/import path: `document_save_to_file` → edit raw NDJSON locally (use `src/lib/SchematicWriter` for schematic edits) → `document_load_from_file`. Reserve the live primitive APIs for small structural additions and one-shot interactions.

## Custom UI surfaces

### What you cannot do

**No custom right/left/bottom panel tabs.** `SYS_PanelControl` only exposes `openLeftPanel(tab?)` / `openRightPanel(tab?)` / `openBottomPanel(tab?)` and the `tab` argument is restricted to the predefined `ESYS_{Left,Right,Bottom}PanelTab` enums (PROJECT_LIST, SCH_ATTR, PCB_LAYER, LIBRARY, LOG, etc.). Extensions can show/hide/lock the system panels but cannot contribute a new tab. The bottom-panel **Library** tab is populated via `registerExtendLibrary` (see below) — that's a slot in an existing tab, not a new tab.

### What you can do

| Surface | Use it for |
|---|---|
| `sys_IFrame.openIFrame(htmlFile, w, h, id, props)` | The only rich-UI surface. Loads HTML/JS from your extension bundle into a floating dialog. Supports min/max buttons, gray mask, custom title, before-close hook. Used by the About dialog. |
| `sys_Dialog.showInformationMessage / showConfirmationMessage / showInputDialog / showSelectDialog` | Built-in modal prompts (single + multi-select supported). |
| `sys_Dialog.createReactComponentizationDialogInterface()` (alpha) | Returns a portal + fixed `Components` set (Button, Input, CheckBox, RadioGroup, TextArea, Grid, Modal, Panel, Text) for declarative mini-UIs without an iframe. |
| `sys_HeaderMenu.insertHeaderMenus / replaceHeaderMenus` | Top-level menus (used in `extension.json#headerMenus`). |
| `sys_HeaderMenu.insertSystemHeaderMenuItem / removeSystemHeaderMenuItem` | Splice into existing system menus (File/Edit/etc.). Requires external-interaction permission. Cannot touch the Advanced menu. |
| `sys_RightClickMenu.changeMenu` | Customize right-click menus — currently only on bottom-panel library lists (device/symbol/footprint/cbb). |
| `sys_ShortcutKey.register` | Bind keyboard shortcuts to your registered functions. |
| `sys_Message.showToastMessage` | Toast notifications. |
| `sys_LoadingAndProgressBar.showProgressBar / showLoading` | Progress bar + blocking loading overlay. |
| `sys_Log.add` | Write into the bottom log panel. |
| `sys_MessageBus` | Pub/sub — useful for iframe ↔ extension worker comms (alongside `globalThis` and `postMessage`). |

## Library / component integration

### Custom virtual library — the killer feature

```ts
eda.lib_LibrariesList.registerExtendLibrary(title, {
  device?: ILIB_ExtendLibraryDeviceFunctions,
  symbol?: ILIB_ExtendLibrarySymbolFunctions,
  footprint?: ILIB_ExtendLibraryFootprintFunctions,
  cbb?: ILIB_ExtendLibraryCbbFunctions,
  model3d?: ILIB_ExtendLibrary3DModelFunctions,
}): Promise<string | undefined>  // returns library UUID
```

Registers a virtual library backed by your code. EasyEDA's library UI then calls your `getList(props)`, `getDetail(uuid)`, `getClassificationTree()` whenever the user browses it. Search params include `wd` (keyword), `attributes` map, `symbolType`, `classification`, paging. Result rows can supply symbol/footprint/3D references. The library appears as a first-class peer to system/personal/project libraries with EasyEDA's existing browse/preview/place flow for free.

Natural fit for things like a JLCPCB-Basic-only resistor/cap picker backed by the local SQLite DB.

### Library UUID helpers

```ts
eda.lib_LibrariesList.getSystemLibraryUuid(): Promise<string | undefined>
eda.lib_LibrariesList.getPersonalLibraryUuid(): Promise<string | undefined>
eda.lib_LibrariesList.getProjectLibraryUuid(): Promise<string | undefined>
eda.lib_LibrariesList.getFavoriteLibraryUuid(): Promise<string | undefined>
eda.lib_LibrariesList.getAllLibrariesList(): Promise<Array<ILIB_LibraryInfo>>
```

### Lookup / search

```ts
// Keyword search (paged)
eda.lib_Device.search(key, libraryUuid?, classification?, symbolType?, itemsOfPage?, page?)

// Exact-attribute search
eda.lib_Device.searchByProperties(properties, libraryUuid?, classification?, symbolType?, itemsOfPage?, page?)

// LCSC ID lookup — single, returns first match (or array if allowMultiMatch)
eda.lib_Device.getByLcscIds(lcscId: string, libraryUuid?, allowMultiMatch?)

// LCSC ID lookup — batch
eda.lib_Device.getByLcscIds(lcscIds: string[], libraryUuid?, allowMultiMatch?)
```

`libraryUuid` defaults to the system library, so you don't need to fetch it first. Each result has `{uuid, libraryUuid}` — directly usable by the placement APIs below.

> Caveat: `getByLcscIds` is unavailable in private/self-hosted EasyEDA deployments.

### Create / copy library entries

```ts
// Create new
eda.lib_Device.create(libraryUuid, deviceName, classification?, association?, description?, property?)
eda.lib_Symbol.create(libraryUuid, symbolName, classification?, symbolType?, description?)
eda.lib_Footprint.create(libraryUuid, footprintName, classification?, description?)
eda.lib_3DModel.create(libraryUuid, modelFile: Blob, classification?, unit?)

// Copy across libraries (e.g. system → project)
eda.lib_Device.copy(deviceUuid, srcLibUuid, targetLibUuid, targetClassification?, newName?)
eda.lib_Symbol.copy(symbolUuid, srcLibUuid, targetLibUuid, ...)
eda.lib_Footprint.copy(footprintUuid, srcLibUuid, targetLibUuid, ...)
eda.lib_3DModel.copy(modelUuid, srcLibUuid, targetLibUuid, ...)
```

`Device.copy` does not document whether it deep-copies the associated symbol/footprint/3D; if cross-library refs cause grief in offline-edited NDJSON, copy those assets too as cheap insurance.

`Device.create`'s `association` field accepts `{symbolType, symbolUuid, symbol: {uuid, libraryUuid}, footprintUuid, footprint, model3D, imageData}` — so you can either reuse existing assets or mint new ones first via `Symbol.create` / `Footprint.create`.

## Programmatic placement (no mouse interaction)

### Schematic

```ts
eda.sch_PrimitiveComponent.create(
  component: {libraryUuid, uuid} | ILIB_DeviceItem | ILIB_DeviceSearchItem,
  x: number, y: number,
  subPartName?, rotation?, mirror?, addIntoBom?, addIntoPcb?
): Promise<ISCH_PrimitiveComponent | undefined>
```

Places a device at chosen coordinates. Auto-imports into project library as a side effect (same magic as the front-end Place button). Works with system-library devices directly.

Other useful sch_PrimitiveComponent methods:

```ts
modify(primitiveId, {x, y, rotation, mirror, addIntoBom, addIntoPcb,
                     designator, name, uniqueId,
                     manufacturer, manufacturerId, supplier, supplierId,
                     otherProperty})
delete(primitiveIds)
get(primitiveIds) / getAll(componentType?, allSchematicPages?)
getAllPrimitiveId(componentType?, allSchematicPages?)
getAllPinsByPrimitiveId(primitiveId)
getAllPropertyNames()

createNetFlag(identification: 'Power'|'Ground'|'AnalogGround'|'ProtectGround',
              net, x, y, rotation?, mirror?)
createNetPort(direction: 'IN'|'OUT'|'BI', net, x, y, rotation?, mirror?)
createShortCircuitFlag(x, y, rotation?, mirror?)

placeComponentWithMouse(component, subPartName?)  // simulates Place-button click
```

### PCB

```ts
eda.pcb_PrimitiveComponent.create(
  component: {libraryUuid, uuid} | ILIB_DeviceItem,
  layer: TPCB_LayersOfComponent,
  x: number, y: number,
  rotation?, primitiveLock?
): Promise<IPCB_PrimitiveComponent | undefined>
```

Same shape, plus `layer` and `primitiveLock`. Modify/delete/get/getAll/placeComponentWithMouse all mirror the schematic side.

## End-to-end flow examples

### LCSC ID → placed schematic component

```ts
const dev = await eda.lib_Device.getByLcscIds('C12345');
if (dev) {
  await eda.sch_PrimitiveComponent.create(
    { libraryUuid: dev.libraryUuid, uuid: dev.uuid },
    100, 100,                  // x, y in EasyEDA units
    undefined, 0, false,       // subPart, rotation, mirror
    true, true                 // addIntoBom, addIntoPcb
  );
}
```

### Pre-stage system-library device into project library (no placement)

```ts
const projectLib = await eda.lib_LibrariesList.getProjectLibraryUuid();
const dev = await eda.lib_Device.getByLcscIds('C12345');
if (dev && projectLib) {
  const newUuid = await eda.lib_Device.copy(
    dev.uuid, dev.libraryUuid, projectLib
  );
  // newUuid is now usable in offline-edited .epro NDJSON
}
```

### Custom picker iframe → placement

1. Add a header menu item via `extension.json#headerMenus` pointing at `registerFn: 'openPicker'`.
2. `openPicker()` calls `eda.sys_IFrame.openIFrame('pages/picker.html', 800, 600, 'picker', {...})`.
3. Picker iframe queries SQLite (via your MCP server bridge / WebSocket / fetch) and renders its own UI.
4. On user selection, picker posts the chosen LCSC ID back to the worker (e.g. via `globalThis` data + a callback, or `sys_MessageBus`).
5. Worker calls `getByLcscIds(...)` then `sch_PrimitiveComponent.create(...)` (or `placeComponentWithMouse` if you want the user to click-to-place).

## When to use which

| Goal | Use |
|---|---|
| One/few components, controlled positions | `sch_PrimitiveComponent.create` / `pcb_PrimitiveComponent.create` |
| User-driven placement (click on canvas) | `placeComponentWithMouse` |
| Bulk additions (dozens+) | Export NDJSON → edit with SchematicWriter → import |
| Custom component browser | `registerExtendLibrary` (lives in bottom Library tab) OR custom iframe + `getByLcscIds` |
| Pre-stage library entries for offline editing | `lib_*.copy(...)` into project library |
| Rich custom UI | `sys_IFrame` (HTML iframe) |
| Simple modal | `sys_Dialog.show*` |
| Top-menu commands | `extension.json#headerMenus` or `sys_HeaderMenu.insertHeaderMenus` |
| Cross-context comms | `sys_MessageBus`, `globalThis`, `postMessage` |
