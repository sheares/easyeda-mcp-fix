# easyeda-agent-mcp-server — audit (2026-07-02)

Full-codebase review across the three layers (MCP server, bridge daemon, EDA Pro extension) plus lib, tests and packaging. Verified on this machine: `npm run typecheck` clean on both configs, `npm test` 48/48 pass.

Severity: **C** = fix before relying on it, **H** = important, **N** = nice-to-have.

---

## Critical

### C1. Stale-close race wipes a freshly reconnected extension
`src/bridge-daemon/index.ts:391-413`. On extension reconnect with the same `instanceId`, the old socket's `'close'` handler runs after the new socket is stored and does `extensions.delete(instanceId)` unconditionally, deleting the new entry and rejecting in-flight requests on the new socket. After every extension reload the daemon thinks nothing is connected.
**Fix:** in the close handler, only delete if `extensions.get(instanceId)?.ws === ws`; reject pendings keyed by socket, not instanceId.

### C2. Path traversal in backup.ts: arbitrary recursive delete and write
`src/bridge-daemon/backup.ts:144, 193-198`. `projectUuid`/`documentUuid` are joined into paths unvalidated. `existingProjectUuid` on `project_import_file` is model-supplied; a value like `../../..` reaches `rm(..., { recursive: true, force: true })`. Zip entries are sanitised (`safeJoinZipEntry`) but the base segments are not.
**Fix:** reject any segment not matching `/^[A-Za-z0-9._-]+$/` (and `.`/`..`).

### C3. Proxy timeout ≤ daemon execution time: silent double-execution of destructive ops
`src/mcp-server/proxy-client.ts:23` (45 s) vs `src/bridge-daemon/index.ts:59-69` (45 s per extension RPC, and one tool call can issue three RPCs plus git work, e.g. `document_set_source`). The proxy times out, the daemon completes the write anyway, the model retries, the write runs twice. The uncommitted `EASYEDA_REQUEST_TIMEOUT_MS` change makes this worse because only the daemon side is tunable (see H1).
**Fix:** proxy timeout must exceed the daemon's worst-case budget, or the daemon should send per-call keepalives/deadlines.

### C4. WS listener has no authentication
`src/bridge-daemon/index.ts:38-54, 352-362`. Only the `Origin` header is checked, which any local process can spoof (`curl -H "Origin: ..."`). A fake "extension" can register, get auto-selected by `resolveExtension`, receive full document sources, and feed responses into tools that write attacker-controlled bytes to arbitrary paths (`document_save_to_file`, `pcb_export_to_file`, backups). The UDS socket and `~/.easyeda-mcp` also get default permissions (no chmod anywhere).
**Fix:** per-daemon random token in the state dir, required in the WS URL; `chmod 0700` the state dir and `0600` the socket.

### C5. Cross-instance RPC response spoofing
`src/bridge-daemon/index.ts:288-294`. Pending RPCs are resolved by `msg.id` only; ids are global and sequential, so any connected extension can answer another instance's request.
**Fix (one line):** `if (p.instanceId !== instanceId) return;`.

### C6. Auto-reconnect never fires after a failed initial connect
`src/extension/ws-client.ts:375-417`. All three failure paths of `connect()` skip `scheduleReconnect()`; it is only reachable after a previously successful connection. If EasyEDA starts before the daemon, the extension makes one attempt and stays dead until manual Connect. Compounding it, `extension.json:21` has `"activationEvents": {}`, so `activate()` (src/extension/index.ts:7-17) is dead code and the persisted `autoConnect` setting does nothing across restarts.
**Fix:** call `scheduleReconnect()` on every connect failure path, and register `activate` under `"onStartupFinished"`.

### C7. Pin world positions ignore `flip`: silently wrong writes
`src/lib/schematic-reader.ts:321-333` never consults `comp.flip` (parsed at :269). Every mirrored component gets wrong `worldX/worldY/worldAngle`, and `addNetport`/`addSeriesResistor`/`addPowerSymbol` then write elements at those wrong coordinates. README admits flip is unimplemented, but the lib returns confidently wrong data instead of refusing.
**Fix:** implement (geometry.ts:241 already has the transform) or throw when `flip !== 0`.

---

## The uncommitted diff (assessment)

- **Committable after cleanup:** the `preserveMetadataOnModify` halves in `component.ts` and `sch-component.ts`. Deduplicate the near-identical helper (only the field list differs) and fix the comment citing `reference_easyeda_mcp_bugs.md`, which does not exist in the repo. Note: preserving `designator`/`name` on PCB means a caller can never intentionally clear them.
- **Not ready:** the `sch.component.getAll` multi-page rewrite (`sch-component.ts:171-212`):
  - Page restore is not in a `finally`; any mid-loop throw strands the user's editor on a random page and leaves `netlistPromise` as an unhandled rejection.
  - `openDocument`'s return value is ignored; a failed open silently re-reads the previous page and duplicates components.
  - N pages × ~2-3 s per RPC will blow the 45 s daemon timeout on real multi-page projects.
  - No comment saying why the native `getAll(type, allSchematicPages)` path was abandoned, and `sch-document.ts:40` still uses it, so the two disagree.
- **H1.** New `EASYEDA_REQUEST_TIMEOUT_MS` env var only tunes the daemon side (see C3) and breaks the `EDA_` prefix convention used by every other knob.

---

## Important

### Daemon / MCP server
- **H2.** `isDisconnectError` matches the substring `'not connected'` (`proxy-client.ts:252-255`), which the daemon's own application errors contain, so "EasyEDA isn't running" triggers the reconnect-and-retry path, i.e. a duplicate call. Signal transport errors by class or code, not message text.
- **H3.** `callTool` retries blindly after "Bridge daemon disconnected" (`proxy-client.ts:221-232`) with no read/write distinction. Only auto-retry when the request never left the process.
- **H4.** No `transport.onclose`/stdin-EOF handling in `mcp-server/index.ts`; an orphaned MCP server reconnects and respawns the daemon forever, defeating idle-exit. Add `transport.onclose` and `process.stdin.on('end')` → exit.
- **H5.** Delete-class tools (`pcb_delete_primitives`, `sch_delete_component`, `lib_symbol_delete`, `pcb_manage_layers set_copper_count`, etc.) have no backup and no "irreversible" wording, despite the workflow hint promising auto-backup for destructive ops. At minimum fix the descriptions; better, back up before deletes.
- **H6.** No units, origin or Y-axis direction documented on any PCB coordinate tool (schematic tools document the axis but not units). This is the biggest LLM-usability gap in the tool surface; a model will guess and guess wrong.
- **H7.** `done()` fires async unlinks then `process.exit` on the next line (`bridge-daemon/index.ts:590-594`); socket and pid files are always left stale. `await Promise.allSettled` first.
- **H8.** Unhandled rejection traps: `mcp-server/index.ts:123-129` (`.then(onOk, onErr)` doesn't catch throws inside `onOk`; use `.catch`) and `spawn.ts:68-73` (no `child.on('error')`).
- **H9.** Three dead tool modules (`pour-fill-tools.ts`, `pcb-document-tools.ts`, `pcb-primitive-tools.ts`, ~656 lines) are explicitly unregistered and use the old pattern without instance routing. Delete or merge before someone re-enables them.

### Extension
- **H10.** `handleConnectionLost` (`ws-client.ts:366-369`) schedules reconnect without `sys_WebSocket.close(WS_ID)`; per the API types, re-registering an active ID is a no-op, so half-open connections never recover. The shutdown and heartbeat paths close first; this one must too.
- **H11.** No request serialisation: concurrent requests each do `switchDoc → handler` and can interleave, so a handler executes against the wrong document (`ws-client.ts:306-325`). Add a per-instance promise queue.
- **H12.** `pcb.manufacture.getPdfFile` is called unguarded (`manufacture.ts:112-115`) even though `editor.ts:19-27` in this repo documents it as never resolving; same class as the fixed About-dialog hang. Gate it or return a specific error.
- **H13.** Error propagation: non-Error rejections become `"[object Object]"`; unparseable or id-less requests are swallowed so the daemon waits out its full timeout; `throw new Error('')` reports success (`ws-client.ts:312-337`).
- **H14.** Responses completed while the socket is down are discarded, and heartbeat dead-detection is worst-case ~270 s (90 s interval + 180 s threshold), so the daemon learns only via timeout. Buffer responses for pending ids and flush on reconnect.

### Packaging / metadata
- **H15.** The shipped `.eext` (verified against v1.1.8) contains the 1.1 MB Node daemon bundle, tests (100 KB `sample.epcb`), docs and examples. `.edaignore` excludes `/dist/mcp-server/` but not `/dist/bridge-daemon/`, `/tests/`, `/docs/`, `/examples/`. The extension needs only `extension.json`, `dist/index.js`, `pages/`, `images/`.
- **H16.** Version drift: `extension.json` 1.1.8 vs `package.json` 1.0.0; empty `publisher` and `repository.url` in the store-facing manifest; `engines.eda: "^2.3.0"` vs a code comment saying it was debugged on 2.2.47.7.
- **H17.** README stale: still says port scan 15168-15207 (code uses fixed 16168), "~80 tools" (daemon logs 98), "lib not wired into MCP tools yet" (it is, via `schema-tools.ts`), and omits `src/bridge-daemon/` and `npm test` entirely.

### Lib
- **H18.** `.esch` schema map lacks TABLE/OBJ/RECT/POLY/ARC etc. that real schematics with title blocks contain (registered only for `.esym`), so `validate()`'s "zero unknowns" health gate is meaningless on real files (`schema/esch.ts:30-40`).
- **H19.** Writer append emits a stray blank line and drops the trailing newline when the source ends with `\n` (`schematic-writer.ts:477-482`); neither fixture ends with a newline so tests never catch it.
- **H20.** Malformed ARC slots become NaN and silently disable overlap detection (`geometry.ts:200-206`); the ARC slot layout is marked "TBD" in `line-graphics.ts:106` while geometry.ts asserts a specific layout, with no real-ARC test to arbitrate.
- **H21.** `removeElement` cannot remove same-session appended lines (silent no-op) and orphans the junction wire it created with a component (`schematic-writer.ts:449-457`).
- **H22.** Writer core paths untested: `addNetport(At)`, `addComponent`, `addSeriesResistor` (the trickiest geometry in the repo, maths verified correct by review but untested), `addPowerSymbol`, `removeElement`, `allocDesignator`, all of `loader.ts`, rotated-pin world positions.

---

## Nice-to-have (condensed)

- ~90 copies of the same `sendToExtension → JSON.stringify` handler body across tools/; a `forward(method)` helper would cut ~40% of that code.
- Param naming drift: `ui` vs `userInterface` (pcb vs sch DRC), `ids` vs `primitiveIds`; RPC methods mix verb-first and noun-first.
- `updateInstanceInfo` clobbers known fields with `undefined` (merge instead); `pushInstanceInfo` only fires once post-connect, so `list_instances` data goes stale.
- `document_set_source` fetches the source twice (context + backup); pass it through.
- Backup `changed` flag unreliable when sessions share the repo; compare the subpath diff instead.
- `filePath.split('/')` is Windows-hostile (use `basename`); apply `pcb_export_to_file`'s absolute-path guard to all file-writing tools.
- Known-broken `sch-select` methods return fake success; throw with a pointer to `crossProbe` instead.
- `pages/about.html`: dead `postMessage` branch, unreachable dark-theme CSS, Google Fonts import (network dependency inside an EDA tool).
- `build/packaged.ts`: no freshness check on `dist/index.js` before zipping; unhandled stream errors.
- `NetInfo.connections` is dead API (always `[]`); either populate or remove.
- Mutated lines re-stringified via `JSON.stringify` lose `\r` on CRLF files and normalise floats/unicode escapes; only edited lines affected, no test covers it.
- `serialize()` mutates the shared model in place; a second writer on the same model sees stale `maxId`.
- `tests/` are outside both tsconfigs, so typecheck never sees them.
- The `.epcb` LINE-corruption test self-disables if its regex stops matching (silent `return`).
- Registry dispatch does no input validation for non-MCP UDS clients; cheap `z.object(def.inputShape).parse(args)`.
- Tool schema changes after `bridge_restart` are not re-registered for same-name tools; compare a descriptor hash.

---

## Suggested order of attack

1. **Correctness of the write path:** C3 + H2 + H3 (timeout/retry semantics; this is the "my board got mangled twice" bug), then C1 (reconnect race).
2. **Security:** C2 (path traversal, small fix), C4 + C5 (WS auth token + instance check).
3. **Reliability of the connection:** C6 + H10 (extension reconnect), H4 (orphan cleanup).
4. **Finish or park the uncommitted diff** per the assessment above.
5. **Lib correctness:** C7 (flip), H19 (trailing newline), then tests for the writer (H22).
6. **Ship hygiene:** H15-H17 (packaging, versions, README), delete dead tool modules (H9).
7. Tool descriptions: units/axis/irreversibility wording (H5, H6) — cheap, high leverage for LLM callers.

## What is already good

Daemon lifecycle design (singleton UDS bind with probe-and-unlink, dev:ino self-termination, spawn race safety), NDJSON framing on both ends, instanceId validation against log injection, zip-entry traversal guards, commit-message sanitisation, `bridge_restart`'s multi-session warning, context-budget params (`fields`/`filter`/`limit`), and the lib's byte-preserving round-trip architecture. Typecheck is clean and all 48 tests pass.
