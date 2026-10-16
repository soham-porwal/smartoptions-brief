"""Independent, bounded lane V audit; never rewrites build or app data.

python -m smartoptions.audit_v --date 2026-10-15
Same-provider fresh downloads check transport/parser/math, not vendor independence.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import quote
from zoneinfo import ZoneInfo

import numpy as np
import requests
from curl_cffi import requests as curl

from .contract import Observation, staleness, utc_now, write_json
from .log import event

ROOT = Path(__file__).resolve().parents[1]
TICKERS = ("AAPL", "NVDA", "AMZN", "GOOGL", "DELL", "CTVA", "ADSK", "AMD")
MACROS = ("cpi_headline", "unemployment", "fed_target_upper", "spread_10y_2y", "vix", "hy_oas", "dxy", "wti")
ET = ZoneInfo("America/New_York")


def finite(value):
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


class Audit:
    def __init__(self, day):
        self.day = day
        self.logdir = ROOT / "logs/v"
        self.rawdir = self.logdir / "audit-raw"
        self.rawdir.mkdir(parents=True, exist_ok=True)
        self.inputs = {}
        self.hashes = {}
        for name in ("macro", "equities", "relations"):
            path = ROOT / "out" / day / (name + ".json")
            content = path.read_bytes()
            self.hashes[str(path.relative_to(ROOT))] = hashlib.sha256(content).hexdigest()
            self.inputs[name] = json.loads(content)
        core = ROOT / "app/data/core.json"
        content = core.read_bytes()
        self.hashes["app/data/core.json"] = hashlib.sha256(content).hexdigest()
        self.core = json.loads(content)
        self.rows = {r["t"]: r for r in self.core["rows"]}
        self.details = {}
        for symbol in TICKERS:
            path = ROOT / "app/data/px" / (symbol + ".json")
            if path.exists():
                content = path.read_bytes()
                self.hashes[str(path.relative_to(ROOT))] = hashlib.sha256(content).hexdigest()
                self.details[symbol] = json.loads(content)
        self.macro = {o["id"]: o for g in self.inputs["macro"]["groups"].values() for o in g}
        self.shown_macro = {o["id"]: o for g in self.core["macro"].values() for o in g}
        self.sources = {}
        self.results = []
        self.anomalies = []

    def fetch(self, label, url, *, params=None, impersonate=False):
        for attempt in range(2):
            try:
                response = (curl.get(url, params=params, impersonate="chrome", timeout=18)
                            if impersonate else requests.get(url, params=params,
                                headers={"User-Agent": "Mozilla/5.0 SmartOptionsAudit/1"}, timeout=(8, 18)))
                response.raise_for_status()
                if not response.text.strip():
                    raise ValueError("empty response")
                path = self.rawdir / (label + ".txt")
                path.write_text(response.text, encoding="utf-8")
                self.sources[label] = {"url": url, "retrieved_at": utc_now(), "status": "OK",
                                       "raw_sha256": hashlib.sha256(response.content).hexdigest()}
                event("audit.fetch", label, "OK", f"attempt {attempt+1}; HTTP {response.status_code}", 1)
                return response.text
            except Exception as exc:
                # Never log request exception text: FRED URLs contain a credential.
                event("audit.fetch", label, "FAIL", f"attempt {attempt+1}; {type(exc).__name__}")
                self.sources[label] = {"url": url, "retrieved_at": utc_now(), "status": "FAIL",
                                       "reason": type(exc).__name__}
        return None

    def fred(self, series):
        key = os.environ.get("FRED_API_KEY", "").strip()
        if not key:
            keypath = Path(r"D:\soham\myeverything\Secrets\fred\api_key.txt")
            key = keypath.read_text(encoding="utf-8-sig").strip() if keypath.exists() else ""
        if not key:
            event("audit.fetch", "FRED-" + series, "WARN", "No FRED_API_KEY; source unavailable")
            self.sources["FRED-" + series] = {"url": "https://fred.stlouisfed.org/series/" + series,
                                            "status": "WARN", "reason": "No API key", "retrieved_at": utc_now()}
            return {}
        text = self.fetch("FRED-" + series, "https://api.stlouisfed.org/fred/series/observations", params={
            "series_id": series, "api_key": key, "file_type": "json", "observation_start": "2025-01-01",
            "observation_end": self.day, "realtime_start": self.day, "realtime_end": self.day})
        return {r["date"]: finite(r["value"]) for r in json.loads(text)["observations"]
                if finite(r["value"]) is not None} if text else {}

    def chart(self, symbol):
        url = "https://query1.finance.yahoo.com/v8/finance/chart/" + quote(symbol, safe="")
        end = datetime.fromisoformat(self.day).replace(tzinfo=ET) + timedelta(days=1)
        text = self.fetch("chart-" + symbol.replace("=", "_").replace("^", "_"), url,
            params={"period1": int((end-timedelta(days=550)).timestamp()), "period2": int(end.timestamp()),
                    "interval": "1d", "events": "div,splits"}, impersonate=True)
        if not text:
            return {}
        result = json.loads(text)["chart"]["result"][0]
        prices = result["indicators"]["quote"][0]
        adjusted = result["indicators"].get("adjclose", [{}])[0].get("adjclose", [])
        return {datetime.fromtimestamp(ts, ET).date().isoformat(): {
            "close": finite(prices["close"][i]), "low": finite(prices["low"][i]),
            "high": finite(prices["high"][i]), "adj": finite(adjusted[i]) if i < len(adjusted) else None}
                for i, ts in enumerate(result["timestamp"]) if datetime.fromtimestamp(ts, ET).date().isoformat() <= self.day}

    def add(self, name, shown, stored, independent, url, day, unit, method, tol, provenance=None,
            source_date=None, rounding_tol=0.0, unverified_reason=None, shown_provenance=None):
        missing = [key for key in ("provider", "series", "source_url", "period", "retrieved_at", "unit")
                   if not (provenance or {}).get(key)]
        if shown_provenance is not None:
            missing += ["displayed:" + key for key in ("provider", "series", "source_url", "period", "retrieved_at", "unit")
                        if not shown_provenance.get(key)]
        if shown is None or stored is None or independent is None:
            comparison = "UNVERIFIED"
        elif isinstance(independent, str):
            comparison = "PASS" if shown == independent and stored == independent else "MISMATCH"
        else:
            comparison = "PASS" if abs(stored-independent) <= tol and abs(shown-independent) <= max(tol, rounding_tol) else "MISMATCH"
        if source_date and source_date != day:
            comparison = "PERIOD MISMATCH"
        verdict = comparison if not missing else "FINDING: provenance; " + comparison
        self.results.append({"number": name, "shown": shown, "stored": stored, "independent": independent,
            "source": url, "period": day, "source_date": source_date or day, "unit": unit,
            "method": method, "tolerance": tol, "display_rounding_tolerance": rounding_tol,
            "retrieved_at": utc_now(), "comparison": comparison, "verdict": verdict,
            "provenance_missing": missing, "reason": unverified_reason,
            "stored_provenance": self.provenance_metadata(provenance),
            "displayed_provenance": self.provenance_metadata(shown_provenance)})

    @staticmethod
    def provenance_metadata(provenance):
        """Keep the audit evidence scalar; histories already have frozen input hashes."""
        keys = ("provider", "series", "source_url", "url", "date", "period", "retrieved_at", "unit",
                "field", "method", "reason", "note", "status", "sessions")
        return {k: provenance[k] for k in keys if k in provenance} if provenance is not None else None

    def run(self):
        # Independent FRED request/parser, no production fetch or arithmetic helpers.
        fred = {s: self.fred(s) for s in ("CPIAUCSL", "UNRATE", "DFEDTARU", "BAMLH0A0HYM2")}
        treasury_url = self.macro["spread_10y_2y"]["source_url"]
        treasury = self.fetch("treasury", treasury_url)
        curve = {datetime.strptime(r["Date"], "%m/%d/%Y").date().isoformat(): r
                 for r in csv.DictReader(io.StringIO(treasury))} if treasury else {}
        vix_url = "https://cdn-api.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv"
        text = self.fetch("cboe-vix", vix_url)
        vix = {datetime.strptime(r["DATE"], "%m/%d/%Y").date().isoformat(): finite(r["CLOSE"])
               for r in csv.DictReader(io.StringIO(text))} if text else {}
        charts = {}
        def load(symbol):
            try:
                return symbol, self.chart(symbol)
            except Exception as exc:
                event("audit.parse", symbol, "FAIL", type(exc).__name__)
                return symbol, {}
        with ThreadPoolExecutor(max_workers=3) as pool:
            charts.update(pool.map(load, [*TICKERS, "DX-Y.NYB", "CL=F"]))
        for key in MACROS:
            obs = self.macro[key]
            day = obs["date"]
            val = None
            method = "Fresh same-provider observation at exact displayed date"
            if key == "cpi_headline":
                current = fred["CPIAUCSL"].get(day)
                previous = fred["CPIAUCSL"].get(str(int(day[:4])-1) + day[4:])
                val = (current/previous-1)*100 if current is not None and previous else None
                method = "Fresh FRED SA index: (Sep 2026 / Sep 2025 - 1) * 100; calendar-month alignment"
            elif key in ("unemployment", "fed_target_upper", "hy_oas"):
                series = {"unemployment": "UNRATE", "fed_target_upper": "DFEDTARU", "hy_oas": "BAMLH0A0HYM2"}[key]
                val = fred[series].get(day)
                if val is not None and key == "hy_oas":
                    val *= 100
                    method += "; source percent * 100 = basis points"
            elif key == "spread_10y_2y":
                row = curve.get(day)
                val = (float(row["10 Yr"])-float(row["2 Yr"]))*100 if row else None
                method = "Fresh Treasury CSV; (10-year yield percent minus 2-year yield percent) * 100"
            elif key == "vix":
                val = vix.get(day)
            else:
                symbol = "DX-Y.NYB" if key == "dxy" else "CL=F"
                val = charts[symbol].get(day, {}).get("close")
            # Validate the independently sourced scalar against the shared contract.
            independent = Observation(id=key, label=key, provider=obs["provider"], series=obs["series"],
                source_url=obs["source_url"], unit=obs["unit"], value=val, date=day, period=obs["period"],
                status=staleness(day, 4) if val is not None else "missing")
            self.add(key, self.shown_macro[key]["v"], obs["value"], independent.value,
                     vix_url if key == "vix" else obs["source_url"], day, obs["unit"], method, 1e-6,
                     provenance=obs, rounding_tol=0.000051,
                     shown_provenance={**self.shown_macro[key], "source_url":self.shown_macro[key].get("url")})

        # Eight prices plus eleven other equity fields = 19 equity values.
        extras = [("AAPL", "chg"), ("DELL", "chg"), ("ADSK", "chg"),
                  ("AAPL", "pe"), ("NVDA", "pe"), ("AMZN", "hi"), ("GOOGL", "lo"),
                  ("DELL", "er"), ("ADSK", "er"), ("CTVA", "tgt"), ("NVDA", "tgt")]
        info = {}
        for symbol in ("AAPL", "NVDA", "DELL", "ADSK", "CTVA"):
            # A fresh yfinance object; this does not call the production fundamental shaper.
            import yfinance as yf
            for attempt in range(2):
                try:
                    ticker = yf.Ticker(symbol)
                    data = ticker.get_info()
                    cal = ticker.calendar if symbol in ("DELL", "ADSK") else {}
                    info[symbol] = {"info": data, "calendar": cal}
                    write_json(self.rawdir / ("fundamental-" + symbol + ".json"), info[symbol])
                    self.sources["fundamental-" + symbol] = {"url": "https://finance.yahoo.com/quote/" + symbol + "/analysis/",
                                                           "retrieved_at": utc_now(), "status": "OK"}
                    event("audit.fetch", "fundamental-" + symbol, "OK", "fresh Yahoo info + calendar; same vendor", 1)
                    break
                except Exception as exc:
                    event("audit.fetch", "fundamental-" + symbol, "FAIL", f"attempt {attempt+1}; {type(exc).__name__}")
                    self.sources["fundamental-" + symbol] = {"url": "https://finance.yahoo.com/quote/" + symbol,
                                                           "retrieved_at": utc_now(), "status": "FAIL", "reason": type(exc).__name__}
        for symbol, field in [(s, "px") for s in TICKERS] + extras:
            eq = self.inputs["equities"]["tickers"][symbol]
            day = eq["price_date"]
            history = charts[symbol]
            row = history.get(day, {})
            source = "https://finance.yahoo.com/quote/" + symbol + "/history/"
            val, stored, provkey = None, None, "price"
            unit, tolerance = "USD/share", 0.01
            method = "Fresh raw Yahoo chart daily unadjusted close, exact displayed session; same vendor"
            if field == "px":
                val, stored = row.get("close"), eq["price"]
            elif field == "chg":
                prior = [d for d in sorted(history) if d < day and history[d]["adj"] is not None]
                val = 100*(row["adj"]/history[prior[-1]]["adj"]-1) if row.get("adj") is not None and prior else None
                stored, provkey, unit = eq["chg_1d_pct"], "chg", "percentage points"
                method = "Fresh raw Yahoo chart adjusted Close / previous available session adjusted Close minus 1, *100"
            elif field in ("hi", "lo"):
                bars = [history[d] for d in sorted(history) if d <= day and history[d]["close"] is not None][-252:]
                values = [b["high" if field == "hi" else "low"] for b in bars if b["high" if field == "hi" else "low"] is not None]
                val = (max(values) if field == "hi" else min(values)) if len(bars) == 252 else None
                stored, provkey = eq["range_52w"]["high" if field == "hi" else "low"], "range_52w"
                method = "Extreme of fresh unadjusted daily High/Low across 252 sessions through displayed date"
            else:
                raw = info.get(symbol, {})
                day = "provider snapshot at audit retrieval; historical fundamentals not supplied"
                if field == "pe":
                    val, stored, provkey, unit, tolerance = raw.get("info", {}).get("trailingPE"), eq["pe_trailing"], "pe_trailing", "multiple", 0.05
                    method = "Fresh Yahoo trailingPE; provider value, no locally invented EPS formula"
                elif field == "tgt":
                    val, stored, provkey = raw.get("info", {}).get("targetMeanPrice"), eq["analyst"]["target_mean"], "analyst"
                    method = "Fresh Yahoo targetMeanPrice; analyst aggregate is vendor data, not our recommendation"
                else:
                    dates = (raw.get("calendar") or {}).get("Earnings Date", [])
                    future = sorted(d.isoformat() for d in dates if d.isoformat() >= self.day)
                    val, stored, provkey, unit, tolerance = future[0] if future else None, eq["earnings"]["date"], "earnings", "date", 0
                    method = "Yahoo calendar endpoint vs stored get_earnings_dates; endpoint disagreement is a finding"
                source = "https://finance.yahoo.com/quote/" + symbol + ("/calendar/" if field == "er" else "/analysis/")
            self.add(symbol + " " + field, self.rows[symbol][{"chg": "d1"}.get(field, field)], stored,
                     val, source, day, unit, method, tolerance, provenance=eq["provenance"].get(provkey),
                     shown_provenance=(self.details.get(symbol, {}).get("prov") or {}).get(provkey, {}))

        # Explicit units from the contracts; intentionally never call relate helpers.
        eq = self.inputs["equities"]
        factors = self.inputs["macro"]["daily_factors"]
        series = {"spy": {d: float(v)*100 for d, v in eq["returns"]["SPY"]},
                  "us10y_bps": dict(factors["us10y_bps_chg"]), "dxy": dict(factors["dxy_ret"]),
                  "wti": dict(factors["wti_ret"]), "vix": dict(factors["vix_chg"])}
        use = self.inputs["relations"]["factors"]
        for symbol, factor in (("AAPL", "spy"), ("NVDA", "us10y_bps"), ("DELL", "wti")):
            target = {d: float(v)*100 for d, v in eq["returns"][symbol]}
            dates = sorted(set(target).intersection(*(set(series[k]) for k in use)))[-252:]
            X = np.array([[1.0, *(series[k][d] for k in use)] for d in dates], dtype=float)
            y = np.array([target[d] for d in dates])
            beta = np.linalg.lstsq(X, y, rcond=None)[0]
            value = float(beta[use.index(factor)+1])
            source = f"out/{self.day}/equities.json + macro.json (stored returns; not re-fetched market history)"
            prov = {"provider": "numpy independent recomputation", "series": symbol + "/" + factor,
                    "source_url": source, "period": dates[0]+" to "+dates[-1], "unit": self.inputs["relations"]["factor_units"][factor],
                    "retrieved_at": utc_now()}
            self.add(symbol + " beta " + factor, self.rows[symbol]["rel"]["c"][factor],
                     self.inputs["relations"]["tickers"][symbol]["coef"][factor], value, source,
                     prov["period"], prov["unit"], "Independent numpy OLS with intercept; explicit equity decimal *100; macro percent unchanged; last 252 exact-date common sessions", 1e-5, provenance=prov)
            self.results[-1].update(n=len(dates), rank=int(np.linalg.matrix_rank(X)))
        assert len(self.results) == 30
        self.anomalies.extend([
            "Displayed equity provenance is checked separately from dated build provenance. Number agreement cannot excuse missing provenance in either layer.",
            "Fundamentals are provider snapshots, not historical values at the daily close; fresh changes can explain differences but must not be silently accepted.",
            "Regressions use last common macro date, which can precede the equity session. Attribution must not be presented as a later session's move.",
            "Original audit found magnitude-based return-unit inference. Root-owner hardening is tracked in V-REQUESTS.md; three sampled coefficients alone do not verify every market regime.",
            "Original audit found render-success-only return codes and older same-date JSON risk. Root-owner hardening is checked separately; inspect fresh per-stage receipts rather than treating HTML render success as freshness proof.",
        ])
        result = {"audit_started_for": self.day, "completed_at": utc_now(), "input_sha256": self.hashes,
                  "core_exported_at": self.core.get("exported_at"), "sources": self.sources,
                  "rows": self.results, "anomalies": self.anomalies,
                  "method": "30 frozen app/build values; fresh primary-provider data with independent parsing/math. Source equality does not imply independent vendor confirmation. OLS from stored returns, explicit units. No visual review."}
        result["changed_during_audit"] = [path for path, digest in self.hashes.items()
            if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest]
        if result["changed_during_audit"]:
            self.anomalies.append("Input files changed during this audit; results describe the frozen hashes, not the later live tree. Re-run after release freeze: " + ", ".join(result["changed_during_audit"]))
        write_json(ROOT / "docs/audit-v-evidence.json", result)
        lines = ["# Independent accuracy audit — 2026-10-15", "", f"Completed UTC: {result['completed_at']}", "",
                 "30 sampled app values, checked against their dated build inputs and fresh source responses. Eight macro values; 19 equity values across eight tickers (seven include set B; ADSK is set A only in the frozen inputs); three independently recomputed OLS coefficients. No visual review.", "",
                 "Numeric PASS is separate from provenance. FINDING means delivery review is required even when the number matches. UNVERIFIED is never a pass. Fresh data from the same provider is an independent request/parser check, not an independent vendor check. Earnings compare Yahoo calendar to get_earnings_dates. OLS reuses stored market returns as requested; it does not certify those returns against another vendor.", "",
                 "Tolerances: macro raw 1e-6 plus 0.000051 for four-decimal app rounding; closes/range/targets $0.01; daily change 0.01 percentage point; P/E 0.05; date exact; OLS 1e-5. No tolerance excuses date mismatch. Units and methods are recorded per row in audit-v-evidence.json.", "",
                 "| Number | Shown | Independent | Source / period | Verdict |", "|---|---:|---:|---|---|"]
        for row in self.results:
            fmt = lambda v: "missing" if v is None else (f"{v:.8g}" if isinstance(v, (float, int)) else str(v))
            source = f"[{row['period']}]({row['source']})" if row["source"].startswith("https:") else row["source"]
            lines.append(f"| {row['number']} | {fmt(row['shown'])} | {fmt(row['independent'])} | {source} | {row['verdict']} |")
        lines.extend(["", "## Findings and requests", ""] + ["- " + item for item in self.anomalies])
        lines.extend(["", "## Reproduction and evidence", "", "`python -m smartoptions.audit_v --date 2026-10-15` (network, bounded retries; does not modify app/out). Raw responses: ignored `logs/v/audit-raw/`. Machine evidence and SHA256 input hashes: `docs/audit-v-evidence.json`. Logs: `logs/build-2026-10-15.jsonl`, stage `audit.fetch`. Never print FRED request URLs containing keys.", "", "Input hashes:", ""])
        lines += [f"- `{path}`: `{digest}`" for path, digest in self.hashes.items()]
        (ROOT / "docs/AUDIT-2026-10-15.md").write_text("\n".join(lines)+"\n", encoding="utf-8")
        from collections import Counter
        print(json.dumps({"rows": len(self.results), "comparisons": dict(Counter(r["comparison"] for r in self.results)),
                          "provenance_findings": sum(bool(r["provenance_missing"]) for r in self.results)}))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", default="2026-10-15")
    args = parser.parse_args()
    try:
        Audit(args.date).run()
        return 0
    except Exception as exc:
        event("audit", "lane V", "FAIL", f"{type(exc).__name__}; see local traceback for non-credential code")
        # No traceback that might contain credentials through provider exceptions.
        print(f"Audit incomplete: {type(exc).__name__}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
