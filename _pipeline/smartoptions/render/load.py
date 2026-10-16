"""Load the four stage outputs. A missing or unreadable file is a degraded section, never a crash;
every outcome is logged (PLAN.md hard rule 8)."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..log import event

INPUTS = ("macro", "calendar", "equities", "relations")
# minimal top-level shape check: a file that parses but lacks its main key is treated as unusable
REQUIRED = {"macro": "groups", "calendar": "events", "equities": "tickers", "relations": "tickers"}


def load_inputs(in_dir: Path, log_dir: Path | None = None) -> tuple[dict[str, Any], dict[str, str]]:
    """Returns (data, reasons). data[name] is the parsed dict or None; reasons[name] explains a None."""
    data: dict[str, Any] = {}
    reasons: dict[str, str] = {}
    for name in INPUTS:
        p = Path(in_dir) / f"{name}.json"
        data[name] = None
        if not p.exists():
            reasons[name] = f"{p.name} not found in {in_dir}"
            event("render", f"input:{name}", "WARN", reasons[name], log_dir=log_dir)
            continue
        try:
            obj = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:  # unreadable input degrades the section, logged with cause
            reasons[name] = f"{p.name} could not be parsed: {type(e).__name__}: {e}"
            event("render", f"input:{name}", "FAIL", reasons[name], log_dir=log_dir)
            continue
        key = REQUIRED[name]
        if not isinstance(obj, dict) or key not in obj:
            reasons[name] = f"{p.name} has no '{key}' key (contract shape mismatch)"
            event("render", f"input:{name}", "FAIL", reasons[name], log_dir=log_dir)
            continue
        size = len(obj[key]) if hasattr(obj[key], "__len__") else None
        event("render", f"input:{name}", "OK", f"loaded {p.name}", count=size, log_dir=log_dir)
        data[name] = obj
    return data, reasons
