"""pcb-lint runner entry point.

Phase 0 scaffold: wires up config loading, MCP client, check registry
(empty), and report emission. No real check logic yet; that arrives
in Phase 1.

Usage:
    python3 runner.py --board <name> [--config <path>] [--strict]
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from checks import registry as check_registry
from mcp_client import MCPClient, MCPUnreachable
from reporters.json_report import render_json
from reporters.markdown import render_markdown


DEFAULTS = {
    "class": 2,
    "default_temp_rise_c": 10,
    "copper_weight_oz": 1,
    "strict": False,
    "high_speed_nets": [],
    "per_net_current_a": {},
}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="pcb-lint runner")
    p.add_argument("--board", required=True, help="Board name (matches EDA Pro tab)")
    p.add_argument("--config", type=Path, default=None, help="Path to pcb-lint.config.json (default: auto-discover from CWD upwards)")
    p.add_argument("--strict", action="store_true", help="Warnings become errors")
    p.add_argument("--out-dir", type=Path, default=Path.cwd(), help="Where to save the JSON sidecar")
    return p.parse_args()


def discover_config(start: Path) -> Path | None:
    """Walk upwards from `start` looking for pcb-lint.config.json.

    Stops at the filesystem root or when it finds the file. Returns the
    absolute path if found, else None.
    """
    start = start.resolve()
    for candidate_dir in [start, *start.parents]:
        candidate = candidate_dir / "pcb-lint.config.json"
        if candidate.is_file():
            return candidate
    return None


def load_config(path: Path | None) -> tuple[dict, list[dict], Path | None]:
    """Return (merged_config, config_findings, effective_path)."""
    findings: list[dict] = []

    effective = path or discover_config(Path.cwd())

    if effective is None:
        findings.append({
            "check_id": "CONFIG-01",
            "severity": "info",
            "message": "no pcb-lint.config.json found (searched CWD and parents); running with defaults. Create one to declare per-net current and high-speed nets.",
            "offending_ids": [],
            "suggestion": "Copy config.example.json in the skill directory to the folder next to your .epro.",
        })
        return DEFAULTS.copy(), findings, None

    if not effective.exists():
        raise SystemExit(f"config not found: {effective}")

    try:
        with effective.open() as fh:
            user_cfg = json.load(fh)
    except json.JSONDecodeError as e:
        raise SystemExit(f"config unparseable at line {e.lineno}: {e.msg}")

    merged = DEFAULTS.copy()
    merged.update(user_cfg)
    return merged, findings, effective


def run() -> int:
    args = parse_args()
    started_at = datetime.now(timezone.utc)

    try:
        client = MCPClient()
        server = client.server_info()
    except MCPUnreachable as e:
        print(f"cannot run: bridge down ({e}); click Connect Claude in EDA Pro and re-run.", file=sys.stderr)
        return 2

    config, config_findings, config_path = load_config(args.config)
    if args.strict:
        config["strict"] = True

    all_findings: list[dict] = list(config_findings)
    ran: list[str] = []
    skipped: list[dict] = []

    for check in check_registry.all_checks():
        try:
            findings = check.run(client=client, config=config)
            all_findings.extend(findings)
            ran.append(check.id)
        except Exception as e:  # noqa: BLE001, deliberate per Failure modes spec
            skipped.append({
                "check_id": check.id,
                "reason": f"check raised: {type(e).__name__}: {e}",
            })

    if config["strict"]:
        for f in all_findings:
            if f["severity"] == "warn":
                f["severity"] = "error"

    context = {
        "board": args.board,
        "started_at": started_at.isoformat(),
        "high_speed_nets": config.get("high_speed_nets", []),
        "class": config.get("class"),
        "temp_rise_c": config.get("default_temp_rise_c"),
        "copper_weight_oz": config.get("copper_weight_oz"),
        "mcp_fork_version": server.get("version", "unknown"),
        "bridge_status": server.get("bridge", "unknown"),
        "config_path": str(config_path) if config_path else None,
        "checks_ran": ran,
        "checks_skipped": skipped,
    }

    print(render_markdown(all_findings, context))

    iso = started_at.strftime("%Y%m%dT%H%M%SZ")
    sidecar = args.out_dir / f"pcb-lint-{args.board}-{iso}.json"
    sidecar.write_text(render_json(all_findings, context))

    errors = sum(1 for f in all_findings if f["severity"] == "error")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(run())
