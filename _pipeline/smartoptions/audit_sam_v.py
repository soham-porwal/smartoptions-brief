"""Read-only source-code/snapshot audit. Does not run the reference pipeline or change his repo.

python -m smartoptions.audit_sam_v --source <read-only clone> --date 2026-10-15
Uses pure scoring functions from git show origin/main, never checks out files.
"""
from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import subprocess
from pathlib import Path

from .contract import utc_now, write_json
from .equities import sam
from .log import event

ROOT = Path(__file__).resolve().parents[1]
PATHS = ["src/sp500_screener/" + name + ".py" for name in
         ("scorer", "quality_scorer", "risk_trend", "market_regime", "technicals")]
PATHS += ["config/config.yaml", "docs/RISKS_AND_ASSUMPTIONS.md", "docs/DECISIONS.md"]
MARKER = "\n## V4 source-code baseline\n"


def git(source, *args):
    return subprocess.run(["git", "-C", str(source), *args], check=True, capture_output=True,
                          text=True, encoding="utf-8", timeout=25).stdout


def scoring_config(text):
    """Parse only the reference flat numeric screener/scoring sections, no YAML dependency."""
    result, section = {}, None
    for line in text.splitlines():
        clean = line.split("#", 1)[0].rstrip()
        if clean and not clean.startswith(" ") and clean.endswith(":"):
            section = clean[:-1]
            if section in ("screener", "scoring"):
                result[section] = {}
        elif section in result and clean.startswith("  ") and ":" in clean:
            key, value = clean.strip().split(":", 1)
            result[section][key] = float(value.strip())
    return result


def opportunity(namespace, config, explain, ar_offset=0, iv_offset=0):
    parts = explain.get("opp") or {}
    def value(k):
        raw = (parts.get(k) or {}).get("val")
        return float(raw) if raw not in (None, "") else None
    ar, iv, distance, delta = [value(k) for k in ("annual_return", "iv", "distance", "delta")]
    if ar is None or iv is None:
        return None
    weights = config["scoring"]
    base = round((namespace["_annual_return_score"](ar + ar_offset, config) * weights["weight_annual_return"]
        + namespace["_iv_score"]((iv + iv_offset) / 100, config) * weights["weight_iv"]
        + namespace["_distance_score"](distance, config) * weights["weight_distance_from_high"]
        + namespace["_delta_fit_score"](delta, config) * weights["weight_delta"]) / 100, 2)
    return namespace["_composite_score"](base, (explain.get("quality") or {}).get("tier"),
                                         (explain.get("risk") or {}).get("risk_tier"), config)


def run(source: Path, day: str):
    commit = git(source, "rev-parse", "origin/main").strip()
    sources, hashes = {}, {}
    for path in PATHS:
        sources[path] = git(source, "show", "origin/main:" + path)
        hashes[path] = hashlib.sha256(sources[path].encode()).hexdigest()
        event("audit.baseline", path, "OK", f"read-only git show origin/main; commit {commit}", 1)
    namespaces = {}
    for name in ("scorer", "quality_scorer", "risk_trend"):
        path = "src/sp500_screener/" + name + ".py"
        namespace = {"__name__": "lane_v_readonly_" + name}
        exec(compile(sources[path], "Sam origin/main:" + path, "exec"), namespace)
        namespaces[name] = namespace
    config = scoring_config(sources["config/config.yaml"])
    snapshot = sam.load()
    snaprows = {row["ticker"].replace(".", "-"): row for row in snapshot["rows"]}
    eq = json.loads((ROOT / "out" / day / "equities.json").read_text(encoding="utf-8"))
    core = json.loads((ROOT / "app/data/core.json").read_text(encoding="utf-8"))
    core_rows = {row["t"]: row for row in core["rows"]}
    differences, roundtrips = [], 0
    fields = {"opportunity_score": "opp", "quality": "q", "trendscore": "trend",
              "risk": "risk", "risk_flags": "flags"}
    for ticker, original in snaprows.items():
        current = (eq["tickers"].get(ticker) or {}).get("sam") or {}
        displayed = (core_rows.get(ticker) or {}).get("sam") or {}
        for original_key, app_key in fields.items():
            if current.get(original_key) != original.get(original_key):
                differences.append(f"{ticker}: build {original_key} differs from source snapshot")
            if displayed.get(app_key) != original.get(original_key):
                differences.append(f"{ticker}: app {app_key} differs from source snapshot")
        original_explain = snapshot["explain"].get(ticker) or snapshot["explain"].get(ticker.replace("-", "."))
        detail_path = ROOT / "app/data/px" / (ticker + ".json")
        detail = json.loads(detail_path.read_text(encoding="utf-8")) if detail_path.exists() else {}
        if current.get("explain") != original_explain:
            differences.append(f"{ticker}: build EXPLAIN differs from source snapshot")
        if detail.get("sam_explain") != original_explain:
            differences.append(f"{ticker}: app EXPLAIN differs from source snapshot")
        roundtrips += 1

    preferred = ["AAPL", "NVDA", "AMZN", "GOOGL", "DELL", "CTVA", "AMD"]
    selected = preferred + [t for t in sorted(snaprows) if t not in preferred][:3]
    checks = []
    for ticker in selected:
        original = snaprows[ticker]
        explain = snapshot["explain"].get(ticker) or snapshot["explain"].get(ticker.replace("-", "."))
        displayed = core_rows[ticker]["sam"]
        computed = opportunity(namespaces["scorer"], config, explain)
        # the reference scorer rounds annual return and IV to 2 decimals in checkpoint
        # output, AFTER scoring. Bounds follow exactly that lost input precision.
        bounds = [opportunity(namespaces["scorer"], config, explain, a, i)
                  for a, i in itertools.product((-0.005, 0, 0.005), repeat=2)]
        bounds = [b for b in bounds if b is not None]
        shown = displayed["opp"]
        quality = namespaces["quality_scorer"]["quality_tier"](float(explain["quality"]["score"]))
        flags = "|".join(f["flag"] for f in explain["risk"]["flags"])
        risk = namespaces["risk_trend"]["compute_risk_tier"](int(displayed["trend"]), flags)
        detail = json.loads((ROOT / "app/data/px" / (ticker + ".json")).read_text(encoding="utf-8"))
        component = detail.get("sam_components") or {}
        if component.get("derived") != computed:
            differences.append(f"{ticker}: exported Opportunity decomposition {component.get('derived')} differs from Sam formula {computed}")
        if displayed["risk"] == "AVOID" and component.get("rmult") != 0:
            differences.append(f"{ticker}: app component equation exports RiskMult={component.get('rmult')} for AVOID; Sam _risk_mult returns 0; result is hard-excluded to 0. Equation must label exclusion or use zero multiplier")
        checks.append({"ticker": ticker, "shown_opportunity": shown, "recomputed_opportunity": computed,
            "rounding_bounds": [min(bounds), max(bounds)] if bounds else None,
            "opportunity_verdict": "EXACT_2DP" if computed == shown else (
                "WITHIN_ROUNDED_INPUT_BOUNDS" if bounds and min(bounds) <= shown <= max(bounds) else "MISMATCH"),
            "shown_quality": displayed["q"], "quality_tier_from_published_score": quality,
            "quality_full_recompute": "UNVERIFIED: original OperatingMarginPct and TrailingPE not retained in snapshot",
            "shown_trend": displayed["trend"],
            "trend_full_recompute": "UNVERIFIED: original SMA50/SMA200 positions and distances not retained in snapshot",
            "shown_risk": displayed["risk"], "risk_tier_given_published_flags": risk,
            "flags_equal_explain": displayed["flags"] == flags,
            "app_component_derived": component.get("derived"),
            "app_component_matches_sam_formula": component.get("derived") == computed,
            "app_risk_multiplier_matches_sam": component.get("rmult") == namespaces["scorer"]["_risk_mult"](displayed["risk"], config),
            "all_flags_full_recompute": "UNVERIFIED: historical SMA values and Beta missing; no flags inferred from missing inputs"})

    result = {"completed_at": utc_now(), "source_repo": "samsej/sp500-screener", "source_ref": "origin/main",
        "source_commit": commit, "source_sha256": hashes, "snapshot_asof": snapshot["asof"],
        "snapshot_sha256": hashlib.sha256(sam.DEFAULT_HTML.read_bytes()).hexdigest(),
        "core_sha256": hashlib.sha256((ROOT / "app/data/core.json").read_bytes()).hexdigest(),
        "roundtrip_tickers": roundtrips, "roundtrip_fields": list(fields), "differences": differences,
        "checks": checks,
        "method": "Exact source-snapshot-to-build/app equality; Sam origin/main pure scoring functions on EXPLAIN inputs. Sam rounds base score before composite. AR and IV input uncertainty follows scorer's 2-decimal CSV output. Tier checks are conditional on published score/flags, not a full input recomputation. No production Sam run; no provider calls."}
    write_json(ROOT / "docs/audit-v-sam-evidence.json", result)
    lines = [MARKER.strip(), "", f"Source commit: `{commit}` (`origin/main`, read-only clone). Completed UTC: {result['completed_at']}.", "",
        f"All {roundtrips} snapshot tickers checked for Opportunity, Quality tier, Trend, Risk, flags and full EXPLAIN preservation against both dated build data and app detail JSON. Exact differences are listed below. The 10-ticker formula check executes the reference pure scoring helpers from that source commit; no dependency added and no source checkout modified.", "",
        "| Ticker | Shown Opportunity | Sam formula from published inputs | Input-rounding interval | Verdict | Quality tier check | Risk tier given published flags |", "|---|---:|---:|---|---|---|---|"]
    for row in checks:
        lines.append(f"| {row['ticker']} | {row['shown_opportunity']} | {row['recomputed_opportunity']} | {row['rounding_bounds']} | {row['opportunity_verdict']} | {row['shown_quality']} / {row['quality_tier_from_published_score']} | {row['shown_risk']} / {row['risk_tier_given_published_flags']} |")
    lines += ["", "**Not fully verifiable:** QualityScore requires original OperatingMarginPct and TrailingPE, which the snapshot does not retain. TrendScore requires SMA positions/distances, also absent. Full risk-flag recomputation requires historical SMA and beta inputs. There are no historical checkpoint CSVs in either inspected local source clone. Do not substitute current fundamentals or assume absent snapshot inputs were absent in the original pipeline. REQUEST: the reference dated CompanyQuality/RiskTrend/Technicals/PricePass/OptionsCandidates checkpoints (or original input cache) to finish exact 10-ticker Quality/Trend/flags recomputation.", "",
        "Opportunity values are recomputed from published annual-return, IV, distance and delta inputs. Annual return and IV were rounded to 2 decimals after scoring by Sam; the interval varies each by ±0.005 and includes the reference intermediate base-score rounding. WITHIN_ROUNDED_INPUT_BOUNDS certifies compatibility with retained precision, not exact recovery of original full-precision inputs.", "", "### Every observed baseline difference", ""]
    lines += ["- " + d for d in differences] or ["- No preserved-column or EXPLAIN differences detected."]
    lines += ["", "### Definition alignment and ownership", "",
        "`docs/score-definitions.json` describes origin/main (checked-out master predates CompositeScore). Its Opportunity weights/thresholds, quality weights/tiers and missing-input defaults, Trend weights, Risk tier precedence/flags, and market regime five-signal weights agree with the inspected source. Our audit uses the config read from origin/main, not a newly chosen threshold.", "",
        "The earlier audit found omitted intermediate base-score rounding and RiskMult 1.0 for AVOID in our decomposition. The root/export owner supplied corrections; this rerun checks each sampled app component's derived value and risk multiplier against the reference source helpers. See the machine evidence and difference list for the current result. Preserved Opportunity values remain copied verbatim. Agreement at retained precision does not recover the unrounded original input cache.", "",
        "Our macro regime, factor associations, attribution, VRP and cycle/pattern models are V2 methods, not the reference scores. the reference regime uses VIX/A-D/NewHL/UpVol/TRIN weights 40/25/15/10/10 with neutral missing-input scores. Our earlier 3-input proxy renormalizes 40/25/15 by 0.80 and uses different data/universe; it cannot be called an exact reproduction. the reference RSI is Wilder-smoothed, SMA50/SMA200 and relative strength are based on his historical candles. Current Yahoo inputs cannot verify his July snapshot's technical values.", "",
        "Machine evidence: `docs/audit-v-sam-evidence.json` (source hashes, snapshot/app hashes, all 10 rows). Pure-function source reads log under `audit.baseline`. No external publication or Sam pipeline was run."]
    audit = ROOT / "docs/AUDIT-2026-10-15.md"
    existing = audit.read_text(encoding="utf-8").split(MARKER, 1)[0]
    audit.write_text(existing.rstrip() + "\n\n" + "\n".join(lines) + "\n", encoding="utf-8")
    from collections import Counter
    print(json.dumps({"tickers_roundtripped": roundtrips, "sample": len(checks),
        "opportunity": dict(Counter(c["opportunity_verdict"] for c in checks)), "differences": len(differences),
        "full_quality_trend": "UNVERIFIED: missing historical inputs"}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=Path(r"D:\soham\myeverything\Data\Refs\sam-sp500-screener"))
    parser.add_argument("--date", default="2026-10-15")
    args = parser.parse_args()
    try:
        run(args.source, args.date)
        return 0
    except Exception as exc:
        event("audit.baseline", "Sam source", "FAIL", type(exc).__name__)
        print(f"Baseline audit incomplete: {type(exc).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
