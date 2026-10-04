"""Markdown reporter: renders findings + run context to a human-readable report."""

from __future__ import annotations


def _group(findings: list[dict], severity: str) -> list[dict]:
    return [f for f in findings if f["severity"] == severity]


def _render_finding(f: dict) -> str:
    lines = [f"### {f['check_id']}: {f['message']}"]
    if f.get("offending_ids"):
        lines.append(f"Offending IDs: {', '.join(f['offending_ids'])}")
    if f.get("suggestion"):
        lines.append(f"Suggestion: {f['suggestion']}")
    return "\n".join(lines)


def render_markdown(findings: list[dict], context: dict) -> str:
    errors = _group(findings, "error")
    warnings = _group(findings, "warn")
    infos = _group(findings, "info")

    out: list[str] = []
    out.append(f"# pcb-lint report: {context['board']} ({context['started_at']})")
    out.append("")

    if context.get("bridge_status") == "not-connected":
        out.append("> **Phase 1 preview: MCP wire is not connected.** This run proves the pipeline works but executes no real checks. All 7 checks will appear under Skipped. Phase 1.5 hooks up the real bridge.")
        out.append("")

    out.append("## Summary")
    out.append(f"- Errors:   {len(errors)} (must fix before fab)")
    out.append(f"- Warnings: {len(warnings)} (should fix; document waiver if not)")
    out.append(f"- Info:     {len(infos)} (style / hygiene)")

    if errors:
        out.append("\n## Errors")
        for f in errors:
            out.append(_render_finding(f))
    if warnings:
        out.append("\n## Warnings")
        for f in warnings:
            out.append(_render_finding(f))
    if infos:
        out.append("\n## Info")
        for f in infos:
            out.append(_render_finding(f))

    skipped = context.get("checks_skipped") or []
    if skipped:
        out.append("\n## Skipped this run")
        for s in skipped:
            out.append(f"- {s['check_id']}: {s['reason']}")

    out.append("\n## Manual checks (always)")
    out.append("- Silk-over-pad: MCP cannot query silk. File → Export → PDF and upload for eyeball.")
    out.append("- Rail continuity: check every rail with a multimeter before fitting the MCU.")

    out.append("\n## Ran against")
    out.append(f"- Board: {context['board']}")
    out.append(f"- High-speed nets: {context.get('high_speed_nets') or '(none declared)'}")
    out.append(
        f"- Class: {context.get('class')} | ΔT: {context.get('temp_rise_c')} °C | "
        f"Cu: {context.get('copper_weight_oz')} oz"
    )
    if context.get("config_path"):
        out.append(f"- Config: {context['config_path']}")
    out.append(f"- MCP fork version: {context.get('mcp_fork_version')}")
    out.append(f"- Checks ran: {len(context.get('checks_ran', []))}")

    return "\n".join(out) + "\n"
