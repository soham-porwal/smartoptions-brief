"""Optional MarketData.app option chains (puts + calls with delta/IV), mirroring the reference marketdata_client.py.

Same as his client: env var MARKETDATA_API_TOKEN (his env.py), base URL https://api.marketdata.app/v1, endpoint
/options/chain/{TICKER}/ with from/to = today + target_dte -/+ 15 days (his options_fetcher.py), Bearer header,
SHA-256(endpoint+params) JSON file cache wrapped as {_fetched_at, _status_code, payload} with a TTL, and a
max_api_calls_per_run quota guard (config/v2.yaml api.max_api_calls_per_run).
Differs on purpose: retry ONCE (PLAN.md rule 8; his tenacity retries 3x) on timeouts/5xx only (429 is not
retried, as on his origin/main); one call per ticker without a side filter so puts AND calls come back.
No key -> every ticker is status missing, reason "no MARKETDATA key"; nothing is fetched.

Writes out/<date>/options.json. Usage:
  .venv\\Scripts\\python.exe -m smartoptions.sources.marketdata --out out/<date> [--tickers AAPL,MSFT]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import requests

from ..contract import clean, utc_now, write_json
from ..log import event

BASE_URL = "https://api.marketdata.app/v1"
ENV_TOKEN = "MARKETDATA_API_TOKEN"
STAGE = "sources.marketdata"
REPO = Path(__file__).resolve().parents[2]
CONFIG = REPO / "config" / "v2.yaml"
NO_KEY = "no MARKETDATA key"
TRANSIENT = {500, 502, 503, 504}


def load_config(path: Path = CONFIG) -> dict:
    import yaml
    with path.open(encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def read_token(env: dict | None = None, dotenv: Path | None = REPO / ".env") -> str | None:
    """Env first, then KEY=VALUE lines in the repo .env (his convention; python-dotenv not required)."""
    env = os.environ if env is None else env
    tok = (env.get(ENV_TOKEN) or "").strip()
    if tok:
        return tok
    if dotenv and dotenv.exists():
        for line in dotenv.read_text(encoding="utf-8").splitlines():
            k, _, v = line.partition("=")
            if k.strip() == ENV_TOKEN and v.strip():
                return v.strip().strip('"').strip("'")
    return None


class QuotaExceeded(RuntimeError):
    pass


class Client:
    """His MarketDataClient semantics: cache check, quota guard, call, cache write, per-call API log."""

    def __init__(self, token: str, max_api_calls_per_run: int, cache_dir: Path, cache_expire_seconds: int,
                 timeout: int = 30, session=None, now=None):
        self.token, self.max_calls, self.cache_dir = token, max_api_calls_per_run, Path(cache_dir)
        self.ttl, self.timeout = cache_expire_seconds, timeout
        self.session = session or requests.Session()
        self.now = now or datetime.now
        self.api_calls_used, self.api_log = 0, []

    def cache_file(self, endpoint: str, params: dict) -> Path:
        key = hashlib.sha256(json.dumps({"endpoint": endpoint, "params": params or {}}, sort_keys=True).encode("utf-8")).hexdigest()
        return self.cache_dir / f"{endpoint.strip('/').replace('/', '_')}_{key}.json"

    def _log(self, endpoint, params, status, from_cache, error=""):
        self.api_log.append({"FetchedAt": self.now().isoformat(timespec="seconds"), "Endpoint": endpoint,
                             "Params": str(params), "StatusCode": status, "FromCache": from_cache,
                             "ApiCallsUsed": self.api_calls_used, "Error": error})

    def get(self, endpoint: str, params: dict) -> tuple[dict, bool, str]:
        """(payload, from_cache, fetched_at). Raises QuotaExceeded / requests errors after one retry."""
        cf = self.cache_file(endpoint, params)
        if cf.exists() and self.now() - datetime.fromtimestamp(cf.stat().st_mtime) < timedelta(seconds=self.ttl):
            data = json.loads(cf.read_text(encoding="utf-8"))
            self._log(endpoint, params, data.get("_status_code"), True)
            return data["payload"], True, data.get("_fetched_at")
        last: Exception | None = None
        for attempt in (1, 2):
            if self.api_calls_used >= self.max_calls:
                raise QuotaExceeded(f"quota guard: max_api_calls_per_run={self.max_calls} reached")
            try:
                r = self.session.get(f"{BASE_URL}{endpoint}", params=params, timeout=self.timeout,
                                     headers={"Authorization": f"Bearer {self.token}", "Accept": "application/json"})
                self.api_calls_used += 1
                self._log(endpoint, params, r.status_code, False)
                if r.status_code in TRANSIENT and attempt == 1:
                    last = requests.HTTPError(f"HTTP {r.status_code}")
                    continue
                if r.status_code == 404:  # MarketData answers no-data with 404 + {"s":"no_data"}
                    try:
                        return r.json(), False, self.now().isoformat(timespec="seconds")
                    except ValueError:
                        pass
                r.raise_for_status()
                payload = r.json()
                fetched = self.now().isoformat(timespec="seconds")
                cf.parent.mkdir(parents=True, exist_ok=True)
                cf.write_text(json.dumps({"_fetched_at": fetched, "_status_code": r.status_code, "payload": payload}), encoding="utf-8")
                return payload, False, fetched
            except (requests.Timeout, requests.ConnectionError) as e:
                self._log(endpoint, params, None, False, type(e).__name__)
                last = e
                if attempt == 2:
                    raise
        raise last  # second transient 5xx


FIELDS = {"optionSymbol": "symbol", "side": "side", "strike": "strike", "dte": "dte", "bid": "bid", "ask": "ask",
          "mid": "mid", "last": "last", "delta": "delta", "iv": "iv", "openInterest": "open_interest",
          "volume": "volume", "underlyingPrice": "underlying_price"}


def parse_chain(payload: dict) -> list[dict]:
    """Parallel arrays -> contracts (his NA3 iteration pattern). Unix expiration/updated -> ISO."""
    n = len(payload.get("optionSymbol") or [])
    out = []
    for i in range(n):
        g = {k: (v[i] if isinstance(v, list) else v) for k, v in payload.items()}
        c = {ours: clean(g.get(his)) for his, ours in FIELDS.items()}
        exp, upd = g.get("expiration"), g.get("updated")
        c["expiration"] = datetime.fromtimestamp(exp, timezone.utc).date().isoformat() if isinstance(exp, (int, float)) else None
        c["quote_updated"] = datetime.fromtimestamp(upd, timezone.utc).isoformat().replace("+00:00", "Z") if isinstance(upd, (int, float)) else None
        out.append(c)
    return out


def chain_params(today: date, cfg: dict) -> dict:
    dte = int((cfg.get("screener") or {}).get("target_dte", 30))
    p = {"from": (today + timedelta(days=dte - 15)).isoformat(), "to": (today + timedelta(days=dte + 15)).isoformat()}
    side = (cfg.get("options") or {}).get("side", "both")
    if side in ("put", "call"):
        p["side"] = side
    return p


def fetch_chains(tickers: list[str], cfg: dict, token: str | None, today: date | None = None, session=None,
                 cache_dir: Path | None = None, now=None, log_dir: Path | None = None) -> dict:
    """options.json contract. Never raises for a per-ticker problem; each ticker gets status + reason."""
    today = today or date.today()
    api, cache = cfg.get("api") or {}, cfg.get("cache") or {}
    cap = int(api.get("max_tickers_per_run", 40))
    params = chain_params(today, cfg)
    doc = {"generated_at": utc_now(), "provider": "MarketData.app", "base_url": BASE_URL,
           "endpoint": "/options/chain/{ticker}/", "params": params,
           "method": "One chain call per ticker, expirations within target_dte +/-15 days (the reference options_fetcher window); "
                     "puts and calls; values as returned by MarketData (iv is a decimal, delta signed).",
           "max_api_calls_per_run": int(api.get("max_api_calls_per_run", 60)), "api_calls_used": 0,
           "status": "missing", "reason": None, "tickers": {}}
    tickers = list(dict.fromkeys(t.upper() for t in tickers))
    if len(tickers) > cap:
        event(STAGE, "tickers", "WARN", f"{len(tickers)} requested, capped to max_tickers_per_run={cap}; dropped: {tickers[cap:]}", log_dir=log_dir)
        doc["dropped_tickers"] = tickers[cap:]
        tickers = tickers[:cap]
    if not token:
        doc["reason"] = NO_KEY
        doc["tickers"] = {t: {"status": "missing", "reason": NO_KEY, "contracts": []} for t in tickers}
        event(STAGE, "token", "WARN", f"{NO_KEY} ({ENV_TOKEN} unset); {len(tickers)} tickers left missing", log_dir=log_dir)
        return doc
    cl = Client(token, doc["max_api_calls_per_run"], cache_dir or REPO / cache.get("dir", "out/cache/marketdata"),
                int(float(cache.get("options_hours", 4)) * 3600), int(api.get("timeout_seconds", 30)), session, now)
    ok = 0
    for t in tickers:
        ep = f"/options/chain/{t}/"
        rec = {"status": "missing", "reason": None, "contracts": [],
               "source_url": f"{BASE_URL}{ep}?from={params['from']}&to={params['to']}" + (f"&side={params['side']}" if "side" in params else "")}
        try:
            payload, from_cache, fetched = cl.get(ep, params)
            rec.update({"from_cache": from_cache, "retrieved_at": fetched})
            if payload.get("s") != "ok" or not payload.get("optionSymbol"):
                rec["reason"] = f"MarketData returned s={payload.get('s')!r} {payload.get('errmsg') or ''}".strip()
                event(STAGE, t, "SUSPECT", rec["reason"], 0, log_dir=log_dir)
            else:
                cs = parse_chain(payload)
                rec.update({"status": "ok", "contracts": cs, "underlying_price": cs[0]["underlying_price"] if cs else None,
                            "expirations": sorted({c["expiration"] for c in cs if c["expiration"]}),
                            "n_put": sum(c["side"] == "put" for c in cs), "n_call": sum(c["side"] == "call" for c in cs)})
                ok += 1
                event(STAGE, t, "OK", f"{len(cs)} contracts from_cache={from_cache}", len(cs), log_dir=log_dir)
        except QuotaExceeded as e:
            rec["reason"] = str(e)
            event(STAGE, t, "WARN", rec["reason"], log_dir=log_dir)
        except requests.HTTPError as e:
            code = getattr(e.response, "status_code", None)
            rec.update({"status": "error", "reason": ("auth rejected (HTTP %s); check the key" % code) if code in (401, 403) else f"HTTP error: {e}"[:200]})
            event(STAGE, t, "FAIL", rec["reason"], log_dir=log_dir)
        except Exception as e:  # noqa: BLE001 - one ticker never kills the run
            rec.update({"status": "error", "reason": f"{type(e).__name__}: {e}"[:200]})
            event(STAGE, t, "FAIL", rec["reason"], log_dir=log_dir)
        doc["tickers"][t] = rec
    doc["api_calls_used"] = cl.api_calls_used
    doc["status"] = "ok" if ok == len(tickers) and tickers else ("partial" if ok else "error" if tickers else "missing")
    doc["reason"] = None if doc["status"] == "ok" else f"{ok}/{len(tickers)} tickers returned chains"
    doc["api_log"] = cl.api_log
    return doc


def default_tickers(out_dir: Path, cap: int) -> list[str]:
    """Movers (A) first, then the highest Sam opportunity scores (B), from this run's equities.json."""
    p = out_dir / "equities.json"
    if not p.exists():
        return []
    eq = json.loads(p.read_text(encoding="utf-8"))
    mv = eq.get("movers") or {}
    a = list(mv.get("up") or []) + list(mv.get("down") or [])
    b = sorted((t for t, v in (eq.get("tickers") or {}).items() if (v.get("sam") or {}).get("opportunity_score") is not None),
               key=lambda t: -eq["tickers"][t]["sam"]["opportunity_score"])
    return list(dict.fromkeys(a + b))[:cap]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--out", required=True)
    ap.add_argument("--tickers", default="")
    a = ap.parse_args(argv)
    out = Path(a.out)
    cfg = load_config()
    cap = int((cfg.get("api") or {}).get("max_tickers_per_run", 40))
    tickers = [t for t in a.tickers.split(",") if t.strip()] or default_tickers(out, cap)
    doc = fetch_chains(tickers, cfg, read_token())
    write_json(out / "options.json", doc)
    print(f"options.json: status={doc['status']} tickers={len(doc['tickers'])} calls={doc['api_calls_used']} reason={doc['reason']}")
    return 0  # a missing optional source never fails the build


if __name__ == "__main__":
    sys.exit(main())
