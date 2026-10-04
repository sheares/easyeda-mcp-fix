# pcb-lint

A Claude Code skill that runs 26 design-hygiene checks (12 schematic, 14 PCB) against the board open in EasyEDA Pro, through this repository's MCP server, and writes a scored report.

It catches the mistakes that cost a board respin: a regulator divider that overvolts the MCU, a USB-C port with no CC pull-downs, copper too close to the board edge, ESP32 strapping pins tied the wrong way, a programming header that cannot power the chip.

## Install

Copy this folder into your Claude Code skills folder:

```bash
# macOS / Linux (run from the repository root)
mkdir -p ~/.claude/skills
cp -R skills/pcb-lint ~/.claude/skills/
```

```powershell
# Windows PowerShell (run from the repository root)
New-Item -ItemType Directory -Force "$HOME\.claude\skills" | Out-Null
Copy-Item -Recurse skills\pcb-lint "$HOME\.claude\skills\"
```

Restart Claude Code. The skill needs the MCP server registered under the name `easyeda` (see [`docs/student-guide.md`](../../docs/student-guide.md)).

## Use

With EasyEDA Pro open on your project and the extension connected, type in Claude Code:

| Command | What it does |
|---|---|
| `/pcb-lint` | All checks, one report |
| `/pcb-lint sch` | Schematic checks only (before layout) |
| `/pcb-lint pcb` | PCB checks only |
| `/pcb-lint PCB-21` | One check, for quick iteration |

Plain English works too: "lint my board", "is this board ready to order?".

## Optional config

Copy `scripts/config.example.json` to your project folder as `pcb-lint.config.json` and edit it. It declares things the checks cannot work out alone: high-speed nets, differential pairs, antenna keep-out zones, board thickness, edge clearance for V-cut panels. Without a config the checks run on defaults and say so.

## What is in here

- `SKILL.md`: the rules Claude follows. Read it to see exactly what each check looks for.
- `scripts/checks/`: a Python reference implementation of 25 checks (SCH-12 is Claude-only for now).
- `tests/`: 189 pytest tests against mock MCP payloads. You only need Python if you want to run or extend these:

```bash
cd ~/.claude/skills/pcb-lint
python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
pytest tests/
```

## Limits

It is a second pair of eyes, not a sign-off. Always run EasyEDA's own DRC, read the datasheets for your parts, and eyeball the silkscreen in a PDF export. Known gaps are listed in `SKILL.md` (cross-layer coupling is not automated; antenna zones are circle or rectangle only).
