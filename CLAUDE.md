# CLAUDE.md

This folder is the EasyEDA Pro bridge for Claude Code: an MCP server plus an EasyEDA extension that let you read, check and edit the user's schematics and PCBs, and the `/pcb-lint` board checker. Assume the person you are talking to is a student, new to both this tool and Claude Code, unless they show otherwise. Explain in plain English and summarise tool results; never paste raw JSON at them.

Which folder are you in?

- **Release folder** (usually `~/easyeda-mcp`): has `dist/`, `skills/`, a `.eext` file and `docs/student-guide.md`, but no `src/`. Use the first three sections below.
- **Source clone**: has `src/` and `tests/`. Someone is working on the code; the last section applies as well.

## Getting a newbie set up

`docs/student-guide.md` is the single source of truth for setup. Follow it step by step rather than from memory, and send the user to its Troubleshooting table when something fails.

1. **Find out their OS first** and give only that OS's commands. Windows means native PowerShell, never WSL: EasyEDA runs on Windows, so Claude Code must too.
2. **Check the basics** (guide step 1). You can run these for them: `node --version` (needs 20.5+), `git --version` (backups depend on git), `claude --version`.
3. **Register the server** (guide step 4). Offer to run the `claude mcp add` command yourself. Use the real path of *this* folder's `dist/mcp-server/index.js`; the guide assumes `~/easyeda-mcp`, so adjust it if they unzipped somewhere else. In a source clone, run `npm install` and `npm run build` first, because `dist/` does not exist yet. The name must be `easyeda` (pcb-lint looks for `mcp__easyeda__*` tools).
4. **Install the skill** (guide step 5). Offer to copy `skills/pcb-lint` into `~/.claude/skills/` for them.
5. **Hand over the EasyEDA steps.** Only the user can do these: import the `.eext` (Advanced → Extension Manager → Import), switch on **External Interactions** and **Show in top menu**, open a schematic or PCB, then click **Claude → Connect Claude**. Say exactly where to click, and wait for them to confirm each step.
6. **Restart.** The easyeda tools do not appear in the session that ran `claude mcp add`. Tell them to quit Claude Code, start it again in their own project folder, and ask "check the EasyEDA connection".
7. **Verify** with `server_info`: you want `extensionConnected: true` and their project listed. If the bridge never connects, read `~/.easyeda-mcp/bridge.log`.
8. **First tasks should be read-only** (guide section 7): list components, show a part's nets, explain DRC errors, check the BOM for missing LCSC numbers. Move on to editing once they trust it.

## Do

- **Call `server_info` first** in any EasyEDA session. If `extensionConnected` is false, tell the user to click **Claude → Connect Claude** and stop there; do not run anything against a dead bridge.
- **Read before you write.** Use `editor_get_open_tabs` to confirm which sheet or board is meant, and say it back to the user before changing it. With more than one EasyEDA window open, find the right one with `list_instances` and pass its `instance_id`.
- **Get the user to save in EasyEDA before a big edit**, and remind them to save afterwards.
- **Work in mil on the PCB.** PCB coordinates are mil, not mm (1 mm = 39.37 mil). Convert when the user talks in millimetres. A part that lands absurdly far away usually means a unit mix-up.
- **Preview before bulk changes.** Run `sch_swap_supplier_part` with `dryRun: true` first and show the user the before and after.
- **Use the script workflow for bulk schematic edits** (more than a handful of primitives). This is the export, edit with `src/lib`, load back flow in the server instructions; it is much faster and safer than dozens of single calls.
- **Report the backup SHA** that every destructive call returns, so the user can get back to the previous state.
- **Check your own work.** After an edit, re-read what changed and run `sch_run_drc` or `pcb_run_drc`. After metadata edits, run `sch_export_bom` and confirm no part has lost its LCSC number.
- **Before they order boards:** run `/pcb-lint` and then EasyEDA's own DRC. pcb-lint is a second pair of eyes, not a sign-off.

## Don't

- **Don't touch library assets without saving them first.** Deleting or replacing a library symbol, footprint or device (`lib_*_delete`, `lib_*_update_document_source`) has no undo and **no backup**. The same goes for reducing the copper layer count or removing a layer with `pcb_manage_layers`. Save the source first, and ask the user before going ahead.
- **Don't force an upload with `validate: 'off'`.** A strict validation failure means the edit or the schema is wrong. Fix the edit, or extend the schema as the server instructions describe.
- **Don't blindly retry a write that timed out** or lost its connection. The error warns that the operation may still have completed; re-read the document first, because retrying can apply the change twice.
- **Don't move parts between schematic sheets** with `sch_modify_component`'s `document` parameter. It does not work; tell the user to cut and paste in EasyEDA instead.
- **Don't change the bridge's networking settings** for a user. `EDA_WS_PORT` strands the extension (it always dials 16168), and `EDA_WS_ALLOW_ALL_ORIGINS` turns off a security check.
- **Don't rename the MCP server** from `easyeda`, and don't run Claude Code inside WSL on Windows.
- **Don't edit `~/.easyeda-mcp-backup` by hand.** It is the user's safety net; only read from it.

## Undoing a bad edit

Destructive tools snapshot the document into the git repo at `~/.easyeda-mcp-backup` (or `EDA_BACKUP_DIR`) before writing, and return the commit SHA. To restore:

1. `git -C ~/.easyeda-mcp-backup show --stat <sha>` shows which file was saved (`projects/<project>/documents/<doc>.esch` or `.epcb`).
2. `git -C ~/.easyeda-mcp-backup show <sha>:<that path> > restore.esch` writes the old version to disk.
3. Load it back with `document_load_from_file` into the same document, after confirming with the user.

## Working on the code (source clone only)

- **Layout:** `src/mcp-server` (stdio proxy), `src/bridge-daemon` (WebSocket bridge and all tool definitions in `tools/`), `src/extension` (runs inside EasyEDA), `src/lib` (schematic editing library; start at `src/lib/README.md`), `skills/pcb-lint` (Python reference checks plus `SKILL.md`).
- **Commands:** `npm run typecheck`, `npm test` (208 tests, 2 skipped on Windows; the bridge-daemon suite spawns real daemons and is slow), `npm run build`, then `npm run smoke`. pcb-lint: `cd skills/pcb-lint && pip install -e ".[dev]" && pytest -q`.
- **CI** (`.github/workflows/test.yml`) runs everything on Ubuntu, macOS and Windows on each push to `main` and `fix/mcp-bugs-1-2-3-4`. After pushing, check `gh run list`.
- **Windows rules:** the bridge socket is a named pipe there (`socketPath()` in `src/bridge-daemon/protocol.ts`), so never chmod, unlink or stat it. Build paths with `path.join` and `path.basename`, never `split('/')`. Test ports must stay in 20000-29999, because Windows reserves blocks above 49152. `build/dist/` is gitignored and does not exist in a fresh clone.
- **Releasing:** bump the version in **both** `package.json` and `extension.json`, because EasyEDA ignores a same-version `.eext` reinstall. Then build. Release assets are the `.eext` and `easyeda-mcp.zip`: an `easyeda-mcp/` folder holding the `.eext`, `dist/`, `skills/pcb-lint`, `README.md`, `docs/student-guide.md`, `LICENSE` and this file.
- **After a rebuild,** the old daemon can stay resident. Check `versionMismatch` in `server_info` and use `bridge_restart`.
- **History:** `docs/dev-notes/` holds the security audit, dated handovers and QA reports. Record outcomes there; do not create a `PROJECT.md`.
- **Style:** tabs in code. Docs in British English, with no em dashes.
- `.claude/agents/eda-worker.md` is upstream's PCB-executor subagent (in Chinese), kept as-is.
