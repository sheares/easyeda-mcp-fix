# Handover — easyeda-agent-mcp-server (2026-07-02)

Orientation for an agent (or human) picking this up. Companion to `AUDIT.md`, which has the full findings with file:line references.

## What this project is

An MCP server that connects Claude Code to EasyEDA Pro (JLCPCB's EDA tool). Three layers:

1. **MCP server** (`src/mcp-server/`) — thin stdio proxy. Registers the daemon's tools with the MCP SDK, forwards calls over a Unix domain socket (NDJSON protocol), re-syncs the tool list on daemon reconnect.
2. **Bridge daemon** (`src/bridge-daemon/`) — long-lived singleton. UDS server for MCP clients, WS server on `127.0.0.1:16168` for EasyEDA extensions. Holds the ~98 tool definitions (`tools/`), routes to instances, git-backed backups before destructive ops (`backup.ts`). Spawned on demand (`spawn.ts`), idle-exits when no MCP clients remain.
3. **EDA Pro extension** (`src/extension/`) — runs inside EasyEDA Pro, connects out to the daemon's WS, executes requests against the `eda.*` extension API via `handlers/`. Packaged as a `.eext` zip by `npm run build`.

Also `src/lib/` — a standalone byte-preserving parse/edit/serialize library for EasyEDA's NDJSON document formats (`.esch`/`.esym`/`.epcb`/`.eins`), used by file-manager tools and recommended (in the server instructions) for bulk edits via throwaway scripts.

Key commands: `npm run typecheck` (both tsconfigs), `npm test` (49 tests, 4 suites; bridge-daemon suite spawns real daemons and takes 60-90 s), `npm run build` (compile + package `.eext` into `build/dist/`).

## State as of this session

- Full audit done → `AUDIT.md` (severity-ranked, file:line cites, suggested order of attack).
- **Verified:** typecheck clean on both configs; all 49 tests pass (35 lib, 14 bridge-daemon).
- Nothing is committed. `git status` shows the working tree carrying BOTH this session's fixes AND the owner's earlier in-progress work (see below). Suggest committing the fixes in themed chunks.

## What was fixed this session (all verified)

IDs refer to `AUDIT.md`.

| ID | Fix | Files |
|----|-----|-------|
| C1 | Extension reconnect race: close handler now only deletes the map entry if it still owns it; pendings rejected per-socket | `src/bridge-daemon/index.ts` |
| C5 | RPC responses only accepted from the socket the request went out on (`p.ws !== ws` check; `ws` added to `PendingExtensionRequest`) | `src/bridge-daemon/index.ts` |
| C2 | Path traversal: `requireSafePathSegment()` validates `projectUuid`/`documentUuid` before join/`rm -rf` | `src/bridge-daemon/backup.ts` |
| C3/H1 | Timeout parsing centralised in `protocol.ts` (`extensionRequestTimeoutMs()`, env `EDA_REQUEST_TIMEOUT_MS`, `EASYEDA_` kept as alias); proxy call timeout = `callToolTimeoutMs()` = 3× daemon budget + 30 s, so the proxy always outlasts the daemon | `src/bridge-daemon/protocol.ts`, `src/bridge-daemon/index.ts`, `src/mcp-server/proxy-client.ts` |
| H2/H3 | Typed `DaemonConnectionError { requestSent }` replaces substring matching; never-sent calls retry once, in-flight calls surface a "verify state before retrying" error instead of double-executing | `src/mcp-server/proxy-client.ts` |
| C6 | All three failed-connect paths in `connect()` now `scheduleReconnect()` (was: one attempt then dead if EasyEDA started before the daemon) | `src/extension/ws-client.ts` |
| H10 | `handleConnectionLost` closes the host WS registration before reconnecting (re-register on an active ID is a silent no-op per the API types) | `src/extension/ws-client.ts` |
| C6b | `activationEvents: {"onStartupFinished": "activate"}` wired so the persisted auto-connect setting can fire on startup | `extension.json` |
| H7 | Shutdown awaits socket/pid unlinks before `process.exit` | `src/bridge-daemon/index.ts` |
| H8 | `.catch` on the reconnect re-list chain; `child.once('error')` on daemon spawn | `src/mcp-server/index.ts`, `src/bridge-daemon/spawn.ts` |
| H19 | Writer `serialize()` inserts appended lines before trailing blank lines (was: interior blank line + lost trailing newline). Regression test added | `src/lib/schematic-writer.ts`, `tests/roundtrip.test.ts` |

## Needs manual verification (requires a real EasyEDA instance)

1. **`activationEvents` format.** Official docs mark it "feature in working" and give no entry schema (https://prodocs.easyeda.com/en/api/guide/extension-json.html). The `{event: exportedFnName}` shape matches `activate(status?: 'onStartupFinished')` in `src/extension/index.ts`, but confirm it actually fires on EasyEDA startup after installing the rebuilt `.eext`.
2. **Reconnect behaviour end to end:** extension reload, daemon restart (`bridge_restart` tool), and EasyEDA-started-before-daemon ordering.
3. **Timeout feel:** call timeout is now up to ~165 s by default. If that's too long for interactive use, lower `EDA_REQUEST_TIMEOUT_MS` — the proxy scales with it.

## Owner's pre-existing uncommitted work (NOT touched this session)

In `src/extension/handlers/component.ts` and `sch-component.ts`:

- **`preserveMetadataOnModify` halves — sound, committable** after: deduplicating the near-identical helper (only the field list differs), and fixing a comment citing `reference_easyeda_mcp_bugs.md` (file doesn't exist in the repo). Note: preserving `designator`/`name` on PCB means callers can never intentionally clear those fields.
- **`sch.component.getAll` multi-page rewrite — NOT ready.** Needs: `try/finally` to restore the original page (a mid-loop throw currently strands the editor and leaks an unhandled `netlistPromise` rejection); a check on `openDocument`'s return value (a failed open silently re-reads the previous page → duplicated components); a stated reason for abandoning the native `getAll(type, allSchematicPages)` (which `sch-document.ts:40` still uses); awareness that N pages × 2-3 s per RPC can blow the 45 s daemon RPC timeout.

## Top remaining audit items (see AUDIT.md for the full list)

1. **C4 — WS auth.** Origin header is spoofable by any local process; a fake "extension" can read documents and drive arbitrary-path file writes. Fix: per-daemon random token in the state dir required in the WS URL, `chmod 0700` state dir / `0600` socket. Invasive: daemon and extension must ship together.
2. **C7 — lib ignores `flip`.** Mirrored components get wrong pin world positions and the writer places elements at wrong coordinates. Implement (the transform exists in `geometry.ts:241`) or throw when `flip !== 0`.
3. **H4 — orphaned MCP server** respawns the daemon forever; add `transport.onclose` / stdin-EOF → exit.
4. **H5/H6 — tool descriptions:** delete-class tools don't say "irreversible, no backup"; PCB coordinate tools don't document units/origin/Y-direction. Cheap, high leverage for LLM callers.
5. **H15-H17 — ship hygiene:** `.eext` contains the 1.1 MB daemon bundle + tests + docs (`.edaignore` misses `/dist/bridge-daemon/`, `/tests/`, `/docs/`, `/examples/`); version drift (extension.json 1.1.8 vs package.json 1.0.0, empty publisher/repo, engines `^2.3.0` vs debugged-on 2.2.47.7); README stale (port-scan architecture, "~80 tools", "lib not wired in").
6. **H9 — delete the three dead tool modules** (`pour-fill-tools.ts`, `pcb-document-tools.ts`, `pcb-primitive-tools.ts`) before someone re-enables them.

## Gotchas for the next agent

- `makeXxxLine()` factories in `src/lib/schema/` return raw tuples; the writer wraps them internally. Outside the writer, wrap with `wrapAsParsedLine()` before pushing into a `ParsedLine[]` stream (this bit the new test once).
- The test fixture symbol map only contains `sym-resistor-uuid`, so `model.palette.netport` is empty in tests — `addNetportAt` throws there.
- Bridge-daemon tests spawn real daemons; in a sandbox with a ~45 s command cap, run with `--test-name-pattern` in halves.
- Each bash call is independent in this environment; the repo mounts at a different path for shell vs file tools.
- Repo conventions: tabs, no CrewAI-style frameworks; docs in British English, no em dashes (owner preference).
