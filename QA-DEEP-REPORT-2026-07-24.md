# QA deep-pass report — easyeda-mcp-fix v1.5.0 (2026-07-24, second pass)

Second, deeper QA pass over the tree at commit `a8fb93d` (branch
`fix/mcp-bugs-1-2-3-4`), run after and building on
[`QA-REPORT-2026-07-24.md`](QA-REPORT-2026-07-24.md) (the first pass, findings
Q1–Q16). This pass read the transport, spawn, queue, auth, parser and handler
layers end to end, empirically tested two suspected defects, and re-verified a
sample of AUDIT items marked FIXED.

Nothing here supersedes the first report; Q1–Q3 remain the top priorities.
This pass adds **9 findings (1 high, 4 medium, 4 low)**, D-numbered to avoid
clashing with Q-numbers, and records four suspected defects that were
**tested and dismissed** so future passes do not re-chase them.

Work packages for everything actionable are in
[`HANDOVER-2026-07-24.md`](HANDOVER-2026-07-24.md) (updated in place; Block E
carries the D items).

---

## Summary

| ID | Sev | Finding |
|---|---|---|
| D1 | **High** | The extension executes commands from any process that binds port 16168 — the C4 auth is one-directional |
| D2 | Med | Every extension message is JSON-parsed twice for the lifetime of an unauthenticated connection (the default posture) |
| D3 | Med | `document_set_source` ships the full document over the WS three times per upload |
| D4 | Med | `sch_get_connectivity` fires one pin RPC per component with unbounded concurrency |
| D5 | Low | The H11 request queue can be permanently wedged by a synchronously-throwing task |
| D6 | Low | `bridge.log` grows without bound; no rotation anywhere |
| D7 | Low | `pcb_save` advertises a `uuid` parameter the handler never reads |
| D8 | Med | `pcb_run_drc` does not normalise the boolean-only runtime shape that `sch_run_drc` guards against |
| D9 | Low | Pour/fill/region reject the `[{x, y}]` point format that polyline accepts |

---

## High

### D1. The extension trusts any daemon that binds port 16168

The C4 challenge-response (`src/bridge-daemon/index.ts:59-100`,
`src/extension/ws-client.ts:482-500`) authenticates in one direction only:
the **extension proves itself to the daemon**. Nothing proves the daemon to
the extension. The extension auto-connects to `ws://localhost:16168` every
15 s while live mode is on (`ws-client.ts:602-635`), and executes whatever
`{id, method, params}` requests arrive on that socket against the full
`allHandlers` surface (`ws-client.ts:150-169`) — ~90 handler methods
including `fileManager.getDocumentSource`, `fileManager.setDocumentSource`,
`fileManager.getProjectFileByUuid`, and every `sch.*`/`pcb.*`/`lib.*` write.

The daemon-down window is routine, not exotic: the daemon idle-exits **5
seconds** after the last MCP client disconnects
(`protocol.ts:idleExitSeconds`). Any process that binds 16168 during such a
window receives the real extension's connection and can then:

- exfiltrate every open design (`getDocumentSource`, `getProjectFileByUuid`
  returns the whole `.epro` as base64),
- silently corrupt documents (`setDocumentSource` — no backup runs, because
  backups live in the *daemon's* tool layer, which a rogue caller skips),
- drive any library or netlist mutation.

Crucially, **TCP loopback ports are not per-user**. The UDS side is protected
by the 0700 state dir, but 16168 is bindable by *any* account on the machine,
so on a shared or lab machine this crosses a real privilege boundary — unlike
the same-user-malware case, which is out of scope for every control here.
The 2026-07-23 WP1 fix (token-path pinning in `auth-path-validator.ts`)
closed the arbitrary-file-*read* side channel through this position; the
command channel it sits on was left open, and `AUDIT.md` does not record it
as a distinct item.

There is a second-order flaw in the current shape even where the rogue cannot
execute anything useful: the extension *answers the rogue's challenge with the
raw token contents* whenever the challenged path passes the shape validator.
The real `~/.easyeda-mcp/ws-token` passes by construction. Per-run rotation
and shutdown unlink make the stolen value nearly worthless in practice (see
the dismissed-items table), but a protocol that hands the secret to an
unverified peer is fragile by design.

**Fix direction (specced as WP11 in the handover):** mutual challenge-response
with the raw token never crossing the wire. Daemon's challenge carries a
`serverNonce` and a scheme tag; the extension reads the token file (path
validation unchanged), returns `HMAC(token, "ext|" + serverNonce + "|" +
clientNonce)` plus its `clientNonce`; the daemon verifies and answers
`HMAC(token, "daemon|" + clientNonce + "|" + serverNonce)`; the extension
verifies that before treating the daemon as trusted, and surfaces a toast when
it cannot (browser build, permission off). A different-user rogue can neither
read the token nor compute either MAC. WebCrypto (`crypto.subtle`) covers the
extension side; `node:crypto` the daemon side.

---

## Medium

### D2. Double JSON parse of every message on unauthenticated connections

`src/bridge-daemon/index.ts:479-503`. The per-message handler runs
`tryParseAuthToken(raw)` — a full `JSON.parse` — on **every** message while
`authed` is false, then `handleExtensionMessage` parses the same string again.
`authed` only ever becomes true when the extension answers the token
challenge correctly, which requires the desktop client *and* the external
interaction permission. In the default posture (browser EasyEDA, or desktop
without the permission — exactly the configuration the README's default
policy exists to support), `authed` stays false for the connection's entire
life, so every response is parsed twice.

The payloads this hits hardest are the biggest ones in the system:
`document_get_source` responses carry whole `.esch`/`.epcb` sources and
`getProjectFileByUuid` whole projects as base64 — multi-MB strings, parsed
twice on the daemon's single thread. Current MCP performance guidance is
blunt about exactly this class of waste on large payloads.

**Fix:** one boolean. The extension sends exactly one auth answer per
challenge; after the first message that `tryParseAuthToken` recognises (token
correct, wrong, or null), stop probing — set `authAnswered = true` and skip
the probe branch thereafter. Wrong-token sockets already close, so the
security posture is unchanged.

### D3. `document_set_source` moves the document over the wire three times

`src/bridge-daemon/tools/file-manager-tools.ts:132-153`. One upload performs:

1. `fetchCurrentSourceAndContext` — full source fetched, **source discarded**,
   context kept (:136);
2. `backupDocument` — fetches the full source *again*
   (`backup.ts:153`);
3. `fileManager.setDocumentSource` — sends the new source.

`document_load_from_file` (:200-220) has the same shape. For a 5 MB PCB
source that is ~15 MB across the WS per upload — doubled again by D2 in the
default posture — plus three separate H11 queue slots, which widens the
window in which another client's request can interleave between the backup
and the write. This is the AUDIT nice-to-have "`document_set_source` fetches
the source twice; pass it through", verified still open and now costed.

**Fix:** let `backupDocument` accept a prefetched `{source, context}` and
thread the step-1 result through. Three round trips become two, and
backup-vs-write interleaving tightens to a single gap.

### D4. `sch_get_connectivity` fans out one RPC per component, unbounded

`src/extension/handlers/sch-document.ts:78-90`. For every schematic page, the
handler maps **all** components through
`fetchPinNames(comp.primitiveId)` — one `getAllPinsByPrimitiveId` call each —
inside a single `Promise.all`. A 300-component board issues 300 concurrent
in-process EDA API calls per connectivity query. The code comment
acknowledges the over-fetch for designator-filtered queries and accepts it;
what it does not bound is the concurrency, and the EDA renderer's tolerance
for hundreds of simultaneous API calls is exactly the kind of thing that
degrades unpredictably across builds (this repo's own history with
never-resolving EDA calls — `getPdfFile`, the About dialog, bug 4 — argues
for conservatism).

**Fix:** bound the fan-out (batches of 8–16), and optionally skip pin fetches
for components that cannot appear in the output when a designator filter is
present without a net filter. The BFS expansion set must still get pins after
expansion — expand first, then fetch.

### D8. `pcb_run_drc` trusts a return shape `sch_run_drc` explicitly distrusts

`src/extension/handlers/sch-document.ts:22-36` normalises `sch_Drc.check`'s
runtime behaviour (upstream pro-api-sdk issue #27: typed as an array, some
builds return a bare boolean) into a stable `{passed, errors?, note?}`.
`src/extension/handlers/drc.ts:4-6` passes `pcb_Drc.check`'s result through
raw, and the daemon tool (`read-tools.ts:151-162`) forwards it verbatim.
Same vendor, same API family, same documented volatility — on a build that
returns a boolean for the PCB check, callers of the fork's primary DRC gate
get unstructured `true`/`false` text where the schematic side would have
explained itself. Given Q10/WP6 is about to tell every fab-export caller to
run this tool first, its output shape should be the reliable one.

**Fix:** apply the same normalisation on the PCB side. (The `ui` vs
`userInterface` naming drift between the two DRC tools, an old AUDIT
nice-to-have, is confirmed still present — `read-tools.ts:155` vs
`sch-read-tools.ts:250` — and is worth a description line, though renaming
either param would break callers.)

---

## Low

### D5. A synchronously-throwing task poisons the H11 queue forever

`src/extension/request-queue.ts:31-36`: `enqueue` chains
`tail.then(() => runSlot(task, opts))` and `runSlot` calls `task(...)` bare.
If a task ever threw synchronously, `runSlot` would throw, the new tail would
reject, and every subsequent `tail.then(...)` would skip its callback — the
queue is wedged for the tab's lifetime with no log line. The sole current
caller passes an `async` function, which cannot throw synchronously, so this
is latent — but the module is public surface for future handlers and is one
`Promise.resolve().then(() => task(...))` (plus `tail.then(run, run)`) away
from being safe unconditionally.

### D6. `bridge.log` grows without bound

`src/bridge-daemon/spawn.ts:69` opens `~/.easyeda-mcp/bridge.log` in append
mode on every daemon spawn; the daemon logs every WS handshake, every
extension diagnostic line (up to 2 000 chars each), and every lifecycle
event. There is no rotation or cap anywhere in the codebase. Months of
idle-exit/respawn cycles (respawn on every MCP session, by design) make this
a slow, certain disk leak on a file the user does not know exists. A
size-check-and-rotate (`bridge.log` → `bridge.log.1` above ~5 MB) in
`ensureDaemonRunning` before the `openSync` is sufficient.

### D7. `pcb_save`'s `uuid` parameter is dead

`src/bridge-daemon/tools/write-tools.ts` (`pcb_save`) advertises
`uuid: 'Document UUID (uses current document if not provided)'`; the handler
it routes to (`document.ts` `'pcb.document.save'`) is
`async () => eda.pcb_Document.save()` — parameters never read. The required
`document` routing param already selects the target; the `uuid` field is a
schema lie that invites a model to believe it saved a non-active document.
Remove it. (`sch_save` does not have the problem.)

### D9. Polygon input format is inconsistent across the four polygon tools

`pcb_create_polyline_track` accepts ergonomic `[{x, y}, ...]` points, which
`toPolygonSource` (`pcb-params.ts:78-99`) converts to EasyEDA's L-mode source
array — that conversion was bug 5's fix. `pcb_create_pour`, `pcb_create_fill`
and `pcb_create_region` still require the raw flat L-mode array at the schema
level (`write-tools.ts`), and their handlers (`pour-fill.ts`,
`pcb-primitive.ts`) call `createPolygon` without the converter. A model that
has just drawn a polyline the easy way gets a zod rejection when it pours
copper the same way. `toPolygonSource` passes non-matching input through
untouched, so accepting both shapes is a schema-union plus one call in three
handlers.

---

## Tested and dismissed

Recorded so the next pass does not re-chase them.

| Suspicion | Verdict | Evidence |
|---|---|---|
| Zod `.default(true)` on `pcb_run_drc` params is lost in the zod → JSON Schema → `fromJSONSchema` round trip, so documented defaults never apply | **Dismissed** | Empirical: round-tripped the exact shape through the registry's serialisation settings; `parse({})` on the rehydrated schema returns `{strict: true, verbose: true}`. Defaults survive as JSON Schema `default` annotations and zod rehydrates them |
| `activate()`'s `if (autoConnect)` truthiness check treats a Promise as always-true (`extension/index.ts`) | **Dismissed** | `sys_Storage.getExtensionUserConfig(key): any \| undefined` is synchronous per `@jlceda/pro-api-types` (index.d.ts:20568) |
| A rogue 16168 listener can steal a *usable* WS token by challenging the extension with the real default path | **Dismissed as stated** (raw-token disclosure still feeds D1's fix) | Tokens are per-run, written 0600 after the singleton check, and unlinked on clean shutdown (`index.ts:719-725`); a token obtainable during a daemon-down window is stale the moment a real daemon starts. The disclosure is still eliminated by the D1 HMAC design |
| AUDIT items H12 (getPdfFile hang gating), C1/C5 (socket-identity checks), and the 2026-07-23 WP2/WP3 fixes (nonce ids, force-release abandonment) might not hold under re-read | **Hold** | `withExportTimeout` caps getPdfFile/get3DFile/sch BOM at 30 s (`manufacture.ts:33-50`); `p.ws !== ws` and close-handler identity checks present; nonce-prefixed ids and `isForceReleased()` pipeline checks present and tested |

One correction to the first report: Q5 said `EDA_WS_ALLOW_ALL_ORIGINS` is
entirely unsurfaced — in fact `server_info` does report `allowAllOrigins`
(`builtin-tools.ts:30`). The README gap and the missing startup warning
stand; WP10 is unchanged.

---

## Sources

- [Always Secure Your localhost Servers](https://davywybiral.blogspot.com/2019/05/always-secure-your-localhost-servers.html) — local servers must authenticate both peers; origin checks alone are insufficient
- [Linux Network Socket Hardening](https://www.systemshardening.com/articles/linux/linux-socket-hardening/) — loopback TCP binding carries no user identity; "getting socket binding wrong does not produce an error log; it silently expands the attack surface"
- [Red Hat Enterprise Linux Security Guide — Securing Services](https://docs.redhat.com/en/documentation/red_hat_enterprise_linux/7/html/security_guide/sec-securing_services)
- [MCP Performance Optimization Tips for 2026, CData](https://www.cdata.com/blog/proven-mcp-performance-optimization-techniques)
- [MCP Performance Optimization: Reduce Latency & Token Usage, mcpguide.dev](https://mcpguide.dev/blog/mcp-performance-optimization) — payloads over ~1 MB warrant streaming or reference-based transfer, not repeated in-band copies
- [Multi-Modal MCP Servers: Handling Files, Images, and Streaming Data, HackerNoon](https://hackernoon.com/multi-modal-mcp-servers-handling-files-images-and-streaming-data)
- [MCP Streaming Messages: Performance, Transport, Trade-Offs, Stainless](https://www.stainless.com/mcp/mcp-streaming-messages-performance-transport/)
- First-pass sources (EDA/DFM/MCP-safety/version-control) are listed in [`QA-REPORT-2026-07-24.md`](QA-REPORT-2026-07-24.md)
