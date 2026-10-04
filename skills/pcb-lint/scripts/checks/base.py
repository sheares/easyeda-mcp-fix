"""Check base class + module-level registry."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, ClassVar, Literal, get_args


Severity = Literal["info", "warn", "error"]
_VALID_SEVERITIES = frozenset(get_args(Severity))


@dataclass
class Finding:
    check_id: str
    severity: Severity
    message: str
    offending_ids: list[str] = field(default_factory=list)
    suggestion: str = ""

    def __post_init__(self) -> None:
        if self.severity not in _VALID_SEVERITIES:
            raise ValueError(
                f"invalid severity {self.severity!r}; must be one of {sorted(_VALID_SEVERITIES)}"
            )

    def to_dict(self) -> dict[str, Any]:
        return {
            "check_id": self.check_id,
            "severity": self.severity,
            "message": self.message,
            "offending_ids": self.offending_ids,
            "suggestion": self.suggestion,
        }


class Check:
    """Base class for a pcb-lint check.

    Subclasses must set `id` and implement `run`.
    """

    id: ClassVar[str] = ""
    default_severity: ClassVar[Severity] = "warn"

    def run(self, *, client: Any, config: dict) -> list[dict]:
        """Return a list of finding dicts (see Finding.to_dict).

        Implementations should be pure over (client, config): call MCP,
        compute, return findings. No side effects, no printing.
        """
        raise NotImplementedError


class _Registry:
    def __init__(self) -> None:
        self._checks: list[Check] = []

    def register(self, cls: type[Check]) -> type[Check]:
        if not cls.id:
            raise ValueError(f"{cls.__name__} must set a non-empty `id`")
        self._checks.append(cls())
        return cls

    def all_checks(self) -> list[Check]:
        return list(self._checks)


registry = _Registry()


def register(cls: type[Check]) -> type[Check]:
    """Decorator: register a Check subclass in the module-level registry."""
    return registry.register(cls)
