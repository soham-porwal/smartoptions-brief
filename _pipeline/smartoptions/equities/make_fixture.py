"""Trim a real equities.json into fixtures/equities_sample.json (real values, ~12 tickers).

Usage: python -m smartoptions.equities.make_fixture out/<date>/equities.json fixtures/equities_sample.json
Selection is by rule: 3 A+B, 3 A-only (2 up/1 down when possible), 3 B-only, plus up to 3 tickers
with a missing/stale field so renderers see degraded states. Returns trimmed to the last 60 sessions.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from ..contract import write_json


def pick(d: dict, want_ab=3, want_a=3, want_b=3, want_degraded=3) -> list[str]:
    t = d["tickers"]
    chosen: list[str] = []

    def add(cands, n):
        for s in cands:
            if n <= 0:
                break
            if s not in chosen and s in t:
                chosen.append(s)
                n -= 1

    ab = [s for s, x in t.items() if x["sets"] == ["A", "B"]]
    a_only = [s for s, x in t.items() if x["sets"] == ["A"]]
    b_only = sorted((s for s, x in t.items() if x["sets"] == ["B"]),
                    key=lambda s: -((t[s]["sam"] or {}).get("opportunity_score") or 0))
    mv = d["movers"]
    add([s for s in mv["up"] if s in ab] + [s for s in mv["down"] if s in ab] + ab, want_ab)
    add([s for s in mv["up"] if s in a_only][:2] + [s for s in mv["down"] if s in a_only] + a_only, want_a)
    add(b_only, want_b)
    degraded = [s for s, x in t.items() if any(v in ("missing", "stale", "error") for k, v in x["status"].items() if k != "atm_iv")]
    add(degraded, want_degraded)
    return chosen


def trim(d: dict, tickers: list[str], keep_returns: int = 60) -> dict:
    keep = set(tickers)
    out = dict(d)
    out["tickers"] = {s: d["tickers"][s] for s in tickers}
    out["movers"] = {**d["movers"], **{k: [s for s in d["movers"][k] if s in keep] for k in ("up", "down", "unusual_volume")}}
    out["returns"] = {s: v[-keep_returns:] for s, v in d["returns"].items() if s in keep or s == "SPY"}
    out["meta"] = {**d["meta"], "fixture_note": "trimmed sample of a real run; movers lists filtered to included tickers"}
    return out


def main(argv: list[str]) -> int:
    src, dst = Path(argv[1]), Path(argv[2])
    d = json.loads(src.read_text(encoding="utf-8"))
    names = argv[3:] or pick(d)
    write_json(dst, trim(d, names))
    print(f"wrote {dst} with {names}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
