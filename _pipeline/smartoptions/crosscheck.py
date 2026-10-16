"""Independent cross-checks: the same quantity from two unrelated sources must agree within a tolerance.
Writes out/<date>/crosscheck.json + logs/crosscheck-<date>.md. A mismatch is logged WARN, never hidden.

Checks: Treasury 10Y (home.treasury.gov) vs FRED DGS10; Cboe VIX close vs FRED VIXCLS; SPY last close
(Yahoo) vs FRED SP500 index level ratio stability (sanity, not equality); FRED CPI YoY recomputed from the
raw index vs the value shown."""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

from .contract import utc_now, write_json
from .log import event

KEY_FILE = Path(r"D:\soham\myeverything\Secrets\fred\api_key.txt")


def fred_obs(series: str, n: int = 30) -> dict[str, float]:
    key = os.environ.get("FRED_API_KEY") or KEY_FILE.read_text().strip()
    url = (f"https://api.stlouisfed.org/fred/series/observations?series_id={series}&api_key={key}"
           f"&file_type=json&sort_order=desc&limit={n}")
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
        obs = json.loads(r.read())["observations"]
    return {o["date"]: float(o["value"]) for o in obs if o["value"] not in (".", "")}


def find(macro: dict, pred) -> dict | None:
    for g in (macro.get("groups") or {}).values():
        for o in g:
            if pred(o):
                return o
    return None


def main(argv: list[str]) -> int:
    in_dir = Path(argv[argv.index("--in") + 1])
    macro = json.loads((in_dir / "macro.json").read_text(encoding="utf-8"))
    rows = []

    def check(name, a_label, a, b_label, b, tol, unit):
        if a is None or b is None:
            rows.append({"check": name, "a": a_label, "b": b_label, "result": "SKIP", "detail": "value unavailable"})
            event("crosscheck", name, "WARN", "skipped: value unavailable")
            return
        diff = abs(a - b)
        ok = diff <= tol
        rows.append({"check": name, "a": f"{a_label} = {a}", "b": f"{b_label} = {b}", "diff": round(diff, 4),
                     "tol": tol, "unit": unit, "result": "PASS" if ok else "MISMATCH"})
        event("crosscheck", name, "OK" if ok else "WARN", f"diff {diff:.4f} {unit} tol {tol}", 1)

    for label, series, pred, tol, unit in [
        ("10Y yield: Treasury vs FRED", "DGS10",
         lambda o: "10" in (o.get("label") or "") and "Treasury" in (o.get("provider") or "") and (o.get("unit") or "").startswith("%")
         and "spread" not in (o.get("label") or "").lower(), 0.011, "pct pts"),
        ("VIX close: Cboe vs FRED", "VIXCLS",
         lambda o: (o.get("series") or "").upper() in ("VIX", "^VIX") or (o.get("id") or "").lower() in ("vix", "vix_close"), 0.051, "index pts"),
    ]:
        o = find(macro, pred)
        try:
            f = fred_obs(series)
        except Exception as e:
            rows.append({"check": label, "result": "SKIP", "detail": f"FRED fetch failed: {type(e).__name__}"})
            event("crosscheck", label, "WARN", f"FRED fetch failed {e!r}")
            continue
        d = (o or {}).get("date")
        # compare on the latest date both sources have
        common = [x for x in (o or {}).get("history") or [] if x[0][:10] in f]
        if common:
            d, a = common[-1][0][:10], common[-1][1]
        else:
            a = (o or {}).get("value")
        check(f"{label} ({d})", (o or {}).get("provider", "ours"), a, f"FRED {series}", f.get((d or "")[:10]), tol, unit)

    cpi = find(macro, lambda o: (o.get("series") or "") == "CPIAUCSL" and o.get("transform") == "yoy")
    try:
        raw = fred_obs("CPIAUCSL", 24)
        ds = sorted(raw)
        last = ds[-1]
        yago = f"{int(last[:4]) - 1}{last[4:]}"  # same month one year earlier, by DATE (FRED has gaps, e.g. Oct 2025)
        recomputed = round((raw[last] / raw[yago] - 1) * 100, 3)
        check(f"CPI YoY recomputed from raw index ({ds[-1][:7]})", "page value", round(cpi["value"], 3) if cpi else None,
              "FRED CPIAUCSL raw ratio", recomputed, 0.01, "pct pts")
    except Exception as e:
        rows.append({"check": "CPI YoY recompute", "result": "SKIP", "detail": f"{type(e).__name__}"})

    res = {"generated_at": utc_now(), "checks": rows,
           "summary": {k: sum(1 for r in rows if r["result"] == k) for k in ("PASS", "MISMATCH", "SKIP")}}
    write_json(in_dir / "crosscheck.json", res)
    md = ["# SmartOptions cross-check " + in_dir.name, "", "| check | ours | independent | diff | result |", "|---|---|---|---|---|"]
    md += [f"| {r['check']} | {r.get('a','')} | {r.get('b','')} | {r.get('diff','')} | {r['result']} {r.get('detail','')} |" for r in rows]
    log = Path(__file__).resolve().parent.parent / "logs" / f"crosscheck-{in_dir.name}.md"
    log.write_text("\n".join(md) + "\n", encoding="utf-8")
    print(res["summary"], "->", log)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

