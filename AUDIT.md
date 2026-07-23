# easyeda-agent-mcp-server — audit (2026-07-02)

Full-codebase review across the three layers (MCP server, bridge daemon, EDA Pro extension) plus lib, tests and packaging. Verified on this machine: `npm run typecheck` clean on both configs, `npm test` 48/48 pass.

> **Re-verification 2026-07-23 (v1.4.0, 107/107 tests): 26 FIXED / 3 PARTIAL (C4, H6, H20) / 0 OPEN.** See the addendum at the end of this file for per-item evidence and four NEW risks this audit missed.

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

### C4. WS listener has no authentication — RESOLVED (2026-07-12)
`src/bridge-daemon/index.ts:38-54, 352-362`. Only the `Origin` header is checked, which any local process can spoof (`curl -H "Origin: ..."`). A fake "extension" can register, get auto-selected by `resolveExtension`, receive full document sources, and feed responses into tools that write attacker-controlled bytes to arbitrary paths (`document_save_to_file`, `pcb_export_to_file`, backups). The UDS socket and `~/.easyeda-mcp` also get default permissions (no chmod anywhere).
**Fix:** per-daemon random token in the state dir, required in the WS URL; `chmod 0700` the state dir and `0600` the socket.
**Fix applied:** state dir 0700 + socket 0600 landed earlier (efc391a). Token auth works as a challenge-response, because the extension cannot know the state-dir path up front: the daemon writes a per-run random token (0600) and challenges each connection with the token path; the extension reads it back via `eda.sys_FileSystem.readFileFromFileSystem`, proving same-user file access. A wrong answer always closes the socket (also enforced for `?token=` in the WS URL). Because `readFileFromFileSystem` is desktop-only, `@beta`, and gated on the extension's external interaction permission, the default policy still accepts connections that cannot read the token (Origin trust, pre-C4 status quo); `EDA_WS_AUTH=require` refuses them. Covered by four tests in `tests/bridge-daemon.test.ts`.

### C5. Cross-instance RPC response spoofing
`src/bridge-daemon/index.ts:288-294`. Pending RPCs are resolved by `msg.id` only; ids are global and sequential, so any connected extension can answer another instance's request.
**Fix (one line):** `if (p.instanceId !== instanceId) return;`.

### C6. Auto-reconnect never fires after a failed initial connect
`src/extension/ws-client.ts:375-417`. All three failure paths of `connect()` skip `scheduleReconnect()`; it is only reachable after a previously successful connection. If EasyEDA starts before the daemon, the extension makes one attempt and stays dead until manual Connect. Compounding it, `extension.json:21` has `"activationEvents": {}`, so `activate()` (src/extension/index.ts:7-17) is dead code and the persisted `autoConnect` setting does nothing across restarts.
**Fix:** call `scheduleReconnect()` on every connect failure path, and register `activate` under `"onStartupFinished"`.

### C7. Pin world positions ignore `flip`: silently wrong writes — RESOLVED (2026-07-03)
`src/lib/schematic-reader.ts:321-333` never consulted `comp.flip` (parsed at :269). Every mirrored component got wrong `worldX/worldY/worldAngle`, and `addNetport`/`addSeriesResistor`/`addPowerSymbol` then wrote elements at those wrong coordinates.
**Fix applied:** the pin loop now calls `transformSymbolPoint(sp.x, sp.y, comp.rotation, comp.flip)` (mirror about local Y first, then rotate — matching the verified `geometry.ts:transformPoint` convention) and `transformPinAngle(sp.angle, comp.rotation, comp.flip)` (θ → 180−θ on flip, normalised to [0,360)). Regression coverage in `tests/schematic-reader-flip.test.ts` (flip=0 baseline + flip=1 position/angle).

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

---

## Addendum: re-verification against v1.4.0 (2026-07-23)

Every C/H item re-read against current code on branch `fix/mcp-bugs-1-2-3-4`; tests 107/107 pass.

| Item | Status | Evidence |
|---|---|---|
| C1 | FIXED | 592e1bb; close handler `extensions.get(instanceId)?.ws === ws`, pendings keyed by `p.ws` |
| C2 | FIXED | a94ced8; `backup.ts:requireSafePathSegment` on both UUIDs |
| C3 | FIXED | 2c3b8ba; `protocol.ts:callToolTimeoutMs()` = 3×extension timeout + 30 s, single source |
| C4 | **PARTIAL** | efc391a + 6e2167a; challenge-response token, 0700/0600 perms. Default policy still registers sockets that never answer the challenge; Origin-spoof path remains unless `EDA_WS_AUTH=require` |
| C5 | FIXED | 592e1bb; `if (p.ws !== ws) return` |
| C6 | FIXED | 15d9f74; all connect() failure paths reach `scheduleReconnect`; `onStartupFinished` activation |
| C7 | FIXED | 834ac07; `transformSymbolPoint`/`transformPinAngle` + flip tests |
| H1–H5, H7–H19, H21, H22 | FIXED | see commits 2c3b8ba, 6e2167a, 35e0753, 51303b4, 3ff01fc, 794d5bc, e028849, f09799e |
| H6 | FIXED (2026-07-23, e1fce38) | `PCB_COORD_NOTE` now on the six coordinate-taking read/nav tools too (`pcb_navigate_to`, `pcb_navigate_to_region`, `pcb_get_primitive_at_point`, `pcb_get_primitives_in_region`, `pcb_canvas_origin`, `pcb_convert_coordinates`) |
| H20 | **PARTIAL** | geometry.ts skips non-finite ARC slots (no NaN poisoning); ARC slot layout still unverified, no real-ARC fixture, malformed ARCs silently excluded from overlap detection |

Nice-to-haves independently fixed: `updateInstanceInfo` merges only defined fields; `list_instances` staleness; `sch_select_primitives` routes to working `crossProbe`. The rest of the N-list stands.

### New risks this audit missed

1. **`auth.challenge` tokenPath is an arbitrary-file-read primitive** (`ws-client.ts:answerAuthChallenge`): the extension reads whatever path the server sends and returns its contents. Any local process that binds 16168 (easy — daemon idle-exits shortly after the last MCP client, extension retries every 15 s) can exfiltrate any user-readable file. **Fix: pin the expected `~/.easyeda-mcp/ws-token` path client-side.** **FIXED 2026-07-23 (3242ba6)**: new pure module `src/extension/auth-path-validator.ts` refuses any path that isn't shaped like `.../.easyeda-mcp/ws-token` (rejects `..`, NUL, wrong basename, wrong parent dir). `answerAuthChallenge` validates before `readFileFromFileSystem`. 12 unit tests cover POSIX/Windows shape and classic exfil targets.
2. **Buffered-response id collision across daemon restarts**: `extRequestIdCounter` resets each daemon run ("d1", "d2"…); a flushed stale response for old "d5" arriving on the new socket can be accepted as the answer to the new daemon's unrelated "d5" (the `p.ws === ws` check passes post-reconnect). Fix: include a per-run nonce in request ids. **FIXED 2026-07-23 (45dda57)**: new `src/bridge-daemon/request-id.ts` factories the generator with a 24-bit hex per-run nonce; ids now `d<nonce>-<counter>` so different runs live in disjoint id spaces. 3 unit tests including a disjoint-space cross-check.
3. **H11 queue force-release (120 s)** lets a wedged handler later complete against a different request's active document — the serialisation guarantee lapses exactly in the hang cases it was built for. Fix: cancel (ignore result of) the wedged handler on force-release rather than letting it land. **FIXED 2026-07-23 (9fc512d)**: `enqueueRequest` task signature now receives `isForceReleased()`; the pipeline in `handleMessage` checks it after every await and abandons silently on true (no `sendResponse`, no further eda calls). Queue extracted to `src/extension/request-queue.ts` for isolation testing (5 tests).
4. **`sch_swap_supplier_part` leaves a stale symbol/label** when the replacement part's symbol/footprint differ (field-confirmed). Constrain use to true drop-ins, or document delete-and-re-add as the required path; consider a warning in the tool description. **FIXED 2026-07-23 (e1fce38)**: tool description now leads with an explicit warning that it swaps supplier metadata only and requires a true drop-in (identical symbol + footprint); otherwise delete and re-add.

**Post-addendum state (2026-07-23, v1.5.0)**: **28 FIXED / 2 PARTIAL (C4, H20) / 0 OPEN**, plus all four new-risk items above are FIXED. C4 remains PARTIAL only in the "default policy accepts non-answering sockets" sense; the new WP1 fix closes the arbitrary-file-read primitive that made it dangerous.
