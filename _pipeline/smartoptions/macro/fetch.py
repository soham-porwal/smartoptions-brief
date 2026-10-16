"""Bounded requests with raw audit files; never log credential-bearing URLs."""
from pathlib import Path
import json
import requests
from smartoptions.log import event

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"

def fetch(url, raw: Path, source, *, params=None, payload=None, cache=False):
    if cache and raw.exists():
        try:
            text = raw.read_text(encoding="utf-8")
            event("macro.fetch", source, "OK", "cached raw response", count=1)
            return text
        except OSError as exc:
            event("macro.fetch", source, "WARN", type(exc).__name__)
    for attempt in range(2):
        try:
            response = requests.post(url, json=payload, headers={"User-Agent": UA}, timeout=(8, 18)) if payload is not None else requests.get(url, params=params, headers={"User-Agent": UA}, timeout=(8, 18))
            response.raise_for_status()
            text = response.text
            if not text.strip():
                raise ValueError("empty response")
            raw.parent.mkdir(parents=True, exist_ok=True)
            raw.write_text(text, encoding="utf-8")
            event("macro.fetch", source, "OK", f"HTTP {response.status_code}; raw={raw.name}", count=1)
            return text
        except Exception as exc:
            # Exception strings from requests can include an API key. Types/status only.
            code = getattr(getattr(exc, "response", None), "status_code", None)
            event("macro.fetch", source, "FAIL", f"attempt {attempt+1}/2; {type(exc).__name__}; HTTP={code}")
    return None

def parsed(text, parser, source):
    if text is None:
        return []
    try:
        rows = parser(text)
        event("macro.parse", source, "OK" if rows else "SUSPECT", "parsed records", count=len(rows))
        return rows
    except Exception as exc:
        event("macro.parse", source, "FAIL", f"{type(exc).__name__}: invalid source response")
        return []
