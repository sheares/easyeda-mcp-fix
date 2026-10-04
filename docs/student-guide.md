# Student guide: Claude + EasyEDA Pro

This guide gets you from nothing to Claude reading and editing your EasyEDA Pro schematics and PCBs, plus the `/pcb-lint` board checker. Allow 20 minutes the first time.

**Tested on:** macOS, EasyEDA Pro desktop 3.2.149, Claude Code, extension v1.6.4.

> **Windows:** not supported yet. The bridge fails at start-up on native Windows (it uses a Unix-style socket); a fix is planned. WSL2 may work but is untested, see [the note at the end](#windows-and-linux).
> **Linux:** should work (EasyEDA Pro has a Linux client) but is untested.

## How it fits together

```
Claude Code ──► MCP server ──► bridge (runs in the background) ◄── extension inside EasyEDA Pro
```

You install two things: an **extension** inside EasyEDA Pro, and an **MCP server** that Claude Code starts for you. They find each other automatically on your own computer (port 16168, nothing leaves your machine).

## 1. Check you have the basics

Open **Terminal** and run each line. Each should print a version number.

```bash
node --version     # needs v20.5 or newer
git --version      # used for automatic backups before risky edits
claude --version   # Claude Code
```

- No Node, or older than v20.5: install the **LTS** version from [nodejs.org](https://nodejs.org).
- No git: on a Mac, running `git --version` offers to install it. Accept.
- No Claude Code: follow your class's Claude Code setup sheet first.
- **EasyEDA Pro desktop:** download from [easyeda.com/page/download](https://easyeda.com/page/download) (the Pro edition, free). Use the desktop app rather than the browser version.

## 2. Download the bridge

Paste this into Terminal. It downloads the latest release and unpacks it into a folder called `easyeda-mcp` in your home folder.

```bash
cd ~
curl -L -o easyeda-mcp.zip https://github.com/sheares/easyeda-mcp-fix/releases/latest/download/easyeda-mcp.zip
unzip -o easyeda-mcp.zip
ls ~/easyeda-mcp
```

You should see `dist`, `skills`, `README.md` and a file ending in `.eext`. Leave this folder where it is; Claude Code runs the server from here.

(Prefer clicking? Open the [Releases page](https://github.com/sheares/easyeda-mcp-fix/releases/latest), download `easyeda-mcp.zip`, and unzip it into your home folder.)

## 3. Install the extension in EasyEDA Pro

1. Open EasyEDA Pro and any project.
2. Go to **Advanced → Extension Manager**.
3. Click **Import** and choose the `.eext` file in your `easyeda-mcp` folder (for example `easyeda-agent-mcp-server_v1.6.4.eext`). On a Mac, press **Cmd + Shift + H** in the file picker to jump to your home folder.
4. In the Extension Manager, select **EasyEDA Agent** and turn on:
   - **External Interactions** (lets the extension talk to Claude on your computer)
   - **Show in top menu** (puts a **Claude** menu in the editor's top bar)

## 4. Connect Claude Code to the bridge

Paste this into Terminal (one command):

```bash
claude mcp add --scope user easyeda -e EDA_REQUEST_TIMEOUT_MS=180000 -- node "$HOME/easyeda-mcp/dist/mcp-server/index.js"
```

- The name **must be `easyeda`**: the pcb-lint skill looks for tools with that name.
- `--scope user` makes it available in every folder you open Claude Code in.
- The timeout gives big projects three minutes per operation instead of 45 seconds.

## 5. Install the pcb-lint skill

```bash
mkdir -p ~/.claude/skills
cp -R ~/easyeda-mcp/skills/pcb-lint ~/.claude/skills/
```

## 6. Connect and test

1. In EasyEDA Pro, open a **schematic or PCB** (the Claude menu only shows in those editors).
2. Click **Claude → Connect Claude** in the top menu. A message confirms it is connecting. From now on it reconnects by itself whenever EasyEDA starts.
3. Start (or restart) Claude Code in your project folder: `claude`
4. Type `/mcp`. You should see **easyeda** listed as connected.
5. Ask Claude: **"Check the EasyEDA connection."** It calls `server_info`; you want to see `extensionConnected: true` and your project name.

If any step fails, see [Troubleshooting](#troubleshooting).

## 7. Things to try

Start with reading, then move on to editing once you trust it.

- "List every component on my schematic with its value and LCSC part number."
- "Which nets is U1 connected to?"
- "Run DRC on the PCB and explain each error in plain English."
- "Export the BOM and tell me which parts are missing a supplier part number."
- `/pcb-lint sch` once your schematic is done; `/pcb-lint` before you order boards.

`/pcb-lint` gives a report sorted into **errors** (fix before ordering), **warnings** (fix, or write down why not) and **info**. It also saves a `.json` copy so you can compare revisions. Optional per-board settings (antenna keep-out zones, high-speed nets) go in a `pcb-lint.config.json` in your project folder; copy `~/easyeda-mcp/skills/pcb-lint/scripts/config.example.json` as a starting point.

## Working safely

Claude can change and delete things in your design. A few habits keep that safe:

- **Read what Claude is about to do.** Claude Code asks permission before each tool call unless you have told it not to. Tools that change your design say so.
- **Save in EasyEDA before big edits.** It costs a second.
- **Automatic backups.** Before risky operations (replacing a whole document, importing over a project, bulk part swaps) the bridge saves the old version into a git repository at `~/.easyeda-mcp-backup` and reports a backup ID. If an edit goes wrong, give Claude that ID: it can pull the old version out of the backup and load it back.
- **One window at a time** while you are learning. With several EasyEDA windows open, Claude must be told which one (it can list them with `list_instances`).
- **The PCB API works in mil**, not mm (1 mm = 39.37 mil). If Claude places something absurdly far away, that is usually why.
- **Check the result in EasyEDA**, especially the first few times. Run EasyEDA's own DRC before ordering, whatever pcb-lint says.

## Troubleshooting

| What you see | What to do |
|---|---|
| `/mcp` shows **easyeda** as failed | Run `node --version` (must be 20.5+). Check the path in step 4 points at a real file: `ls ~/easyeda-mcp/dist/mcp-server/index.js`. To redo step 4, first run `claude mcp remove easyeda --scope user`. |
| `extensionConnected: false` | In EasyEDA, open a schematic or PCB and click **Claude → Connect Claude**. Check **External Interactions** is on in the Extension Manager. Restart EasyEDA if needed. |
| No **Claude** menu in EasyEDA | Open a schematic or PCB editor (not the home screen). If **Show in top menu** is off, the menu is under **Advanced** instead. |
| No `mcp__easyeda__` tools, or `/pcb-lint` says the bridge is missing | The server must be registered as `easyeda` (step 4). Restart Claude Code after adding it. |
| `/pcb-lint` not recognised | Check `ls ~/.claude/skills/pcb-lint/SKILL.md` exists, then restart Claude Code. |
| Calls time out on a big project | Raise the timeout in step 4 (for example `EDA_REQUEST_TIMEOUT_MS=300000`) and re-add the server. |
| Claude edited the wrong document | Ask it to check `editor_get_open_tabs` and `list_instances` first, and name the sheet or board you mean. |
| `server_info` shows `versionMismatch: true` after an update | Restart Claude Code, then ask Claude to run `bridge_restart`. |

## Updating to a new version

1. Re-run the download commands in step 2 (they overwrite the old files).
2. In **Advanced → Extension Manager**, remove the old **EasyEDA Agent**, then import the new `.eext`. Turn the two toggles back on.
3. Copy the skill again: `cp -R ~/easyeda-mcp/skills/pcb-lint ~/.claude/skills/`
4. Restart Claude Code and EasyEDA Pro.

## Windows and Linux

**Windows.** Native Windows does not work yet: the background bridge cannot open its local socket, so every tool call fails. A fix is planned; watch the [Releases page](https://github.com/sheares/easyeda-mcp-fix/releases).

If you are comfortable with WSL2, this combination may work today, but nobody has tested it: EasyEDA Pro desktop on Windows, and Node, git and Claude Code inside WSL2. Follow steps 2, 4 and 5 inside WSL, and import the `.eext` into Windows EasyEDA (from `\\wsl$\<distro>\home\<you>\easyeda-mcp`). The extension then reaches the bridge through WSL's localhost forwarding, and connects with a weaker handshake because it cannot read the bridge's token file inside WSL. File paths you give Claude must be WSL paths (`/home/...`). If you try it, tell your lecturer whether it worked.

**Linux.** Follow the macOS steps using the Linux EasyEDA Pro client. Untested; reports welcome.

## Where to go next

- The repository [README](../README.md) explains what the bridge fixes and lists every tool.
- [`skills/pcb-lint/SKILL.md`](../skills/pcb-lint/SKILL.md) explains exactly what each pcb-lint check looks for and why.
- [`src/lib/README.md`](../src/lib/README.md) covers bulk schematic editing with scripts, for when one-at-a-time edits get slow.
