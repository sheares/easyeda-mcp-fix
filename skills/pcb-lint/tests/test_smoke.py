"""Phase 0 smoke tests: the runner boots, the pieces wire together."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


SKILL_ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = SKILL_ROOT / "scripts"


def test_imports_wire_up() -> None:
    """Every top-level module the runner imports must import cleanly."""
    import checks  # noqa: F401
    import mcp_client  # noqa: F401
    from checks.base import Check, Finding, registry  # noqa: F401
    from reporters.json_report import render_json  # noqa: F401
    from reporters.markdown import render_markdown  # noqa: F401


def test_registry_populated_with_phase_1_2_3_checks() -> None:
    """Phase 1: 11 SCH (SCH-08 regulator-Vout, SCH-09 driver-COM,
    SCH-10 USB-C CC added 2026-07-23, SCH-11 ESP32 strapping added 2026-08-09);
    Phase 2: 10 PCB mech/DFM (PCB-20 mask-dam added 2026-08-09,
    PCB-21 copper-to-edge added 2026-08-09, PCB-22 antenna-keepout added 2026-08-10);
    Phase 3: 4 signal integrity."""
    from checks import registry
    check_ids = sorted(c.id for c in registry.all_checks())
    expected = [f"SCH-{i:02d}" for i in range(1, 12)] + [
        "PCB-01", "PCB-02", "PCB-03", "PCB-05", "PCB-08", "PCB-10",
        "PCB-11", "PCB-13", "PCB-14", "PCB-18", "PCB-19", "PCB-20", "PCB-21", "PCB-22",
    ]
    assert check_ids == sorted(expected)


def test_markdown_renderer_handles_empty() -> None:
    from reporters.markdown import render_markdown
    out = render_markdown(
        [],
        {
            "board": "test-board",
            "started_at": "2026-07-20T00:00:00Z",
            "high_speed_nets": [],
            "class": 2,
            "temp_rise_c": 10,
            "copper_weight_oz": 1,
            "mcp_fork_version": "stub-0.0.0",
            "bridge_status": "mock",
            "checks_ran": [],
            "checks_skipped": [],
        },
    )
    assert "pcb-lint report" in out
    assert "Errors:   0" in out


def test_json_renderer_roundtrips() -> None:
    from reporters.json_report import render_json
    ctx = {"board": "x", "started_at": "t"}
    payload = json.loads(render_json([], ctx))
    assert payload["context"]["board"] == "x"
    assert payload["findings"] == []


def test_runner_help_boots() -> None:
    """`runner.py --help` must exit cleanly; proves argparse + imports work."""
    result = subprocess.run(
        [sys.executable, str(SCRIPTS / "runner.py"), "--help"],
        capture_output=True,
        text=True,
        cwd=SCRIPTS,
    )
    assert result.returncode == 0, result.stderr
    assert "--board" in result.stdout


@pytest.mark.parametrize("bad_json", ["{", '{"class":}'])
def test_runner_rejects_malformed_config(tmp_path: Path, bad_json: str) -> None:
    cfg = tmp_path / "pcb-lint.config.json"
    cfg.write_text(bad_json)
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPTS / "runner.py"),
            "--board", "test",
            "--config", str(cfg),
        ],
        capture_output=True,
        text=True,
        cwd=SCRIPTS,
    )
    assert result.returncode != 0
    assert "unparseable" in result.stderr.lower() or "config" in result.stderr.lower()
