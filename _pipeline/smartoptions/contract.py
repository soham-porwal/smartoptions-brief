"""Shared data contract for every stage. Owned by the orchestrator; lanes import, never edit.

A displayed value is only as good as its provenance: every Observation carries where it came
from, what period it describes and when we fetched it. Missing stays None with a status,
never 0 (PLAN.md hard rules 1-2).
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

STATUSES = ("ok", "stale", "missing", "error")


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clean(v: Any) -> Any:
    """NaN/inf -> None so JSON never carries a fake number."""
    if isinstance(v, float) and (math.isnan(v) or math.isinf(v)):
        return None
    return v


@dataclass
class Observation:
    id: str
    label: str
    provider: str
    series: str
    source_url: str
    unit: str
    value: float | None = None
    period: str | None = None          # human period: "2026-09", "2026-Q2", "2026-10-14"
    date: str | None = None            # ISO date of the observation
    transform: str = "level"           # level | yoy | mom | chg_bps | ret_pct ...
    prior: float | None = None         # previous observation of the same transform
    retrieved_at: str = field(default_factory=utc_now)
    status: str = "missing"
    note: str | None = None
    history: list[list[Any]] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.value, self.prior = clean(self.value), clean(self.prior)
        if self.status not in STATUSES:
            raise ValueError(f"bad status {self.status!r} for {self.id}")
        if self.status == "ok" and self.value is None:
            raise ValueError(f"{self.id}: status ok requires a value")

    def to_dict(self) -> dict[str, Any]:
        d = asdict(self)
        d["history"] = [[h[0], clean(h[1])] for h in self.history]
        return d


def staleness(obs_date: str | None, max_age_days: int, today: date | None = None) -> str:
    """'ok' if obs_date is within max_age_days of today, else 'stale'; 'missing' if no date."""
    if not obs_date:
        return "missing"
    today = today or date.today()
    age = (today - date.fromisoformat(obs_date[:10])).days
    return "ok" if age <= max_age_days else "stale"


def write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=1, default=str, allow_nan=False), encoding="utf-8")
    tmp.replace(path)
