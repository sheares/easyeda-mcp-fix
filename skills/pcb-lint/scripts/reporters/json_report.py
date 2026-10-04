"""JSON sidecar reporter.

Named json_report to avoid shadowing the stdlib json module.
"""

from __future__ import annotations

import json


def render_json(findings: list[dict], context: dict) -> str:
    return json.dumps(
        {"context": context, "findings": findings},
        indent=2,
        sort_keys=True,
    )
