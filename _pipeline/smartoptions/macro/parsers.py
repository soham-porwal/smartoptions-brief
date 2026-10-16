"""Pure parsers and arithmetic. Gaps never become zero or adjacent periods."""
import calendar
import csv
import io
import json
import math
from datetime import date, datetime

def number(value):
    try:
        n = float(str(value).replace(",", ""))
        return n if math.isfinite(n) else None
    except (TypeError, ValueError):
        return None

def iso_date(text):
    for fmt in ("%Y-%m-%d", "%m/%d/%Y", "%m/%d/%y"):
        try:
            return datetime.strptime(text.strip()[:10], fmt).date().isoformat()
        except ValueError:
            pass
    raise ValueError("unknown date format")

def treasury(text):
    result = []
    reader = csv.DictReader(io.StringIO(text.lstrip("\ufeff")))
    required = {"Date", "3 Mo", "2 Yr", "10 Yr"}
    if not required.issubset(reader.fieldnames or []):
        raise ValueError("Treasury CSV schema changed: required yield columns absent")
    for row in reader:
        if row.get("Date"):
            result.append((iso_date(row["Date"]), {k: number(row.get(k)) for k in ("3 Mo", "2 Yr", "10 Yr")}))
    return sorted(result)

def cboe(text):
    return sorted((iso_date(r["DATE"]), n) for r in csv.DictReader(io.StringIO(text.lstrip("\ufeff"))) if (n := number(r.get("CLOSE"))) is not None)

def sofr(text):
    return sorted((r["effectiveDate"], n) for r in json.loads(text)["refRates"] if (n := number(r.get("percentRate"))) is not None)

def fred(text):
    data = json.loads(text)
    if "observations" not in data:
        raise ValueError("no FRED observations")
    return sorted((r["date"], n) for r in data["observations"] if (n := number(r["value"])) is not None)

def bls(text):
    data = json.loads(text)
    if data.get("status") != "REQUEST_SUCCEEDED":
        raise ValueError("BLS request unsuccessful")
    result = {}
    for s in data["Results"]["series"]:
        result[s["seriesID"]] = sorted((f'{r["year"]}-{r["period"][1:]}-01', n) for r in s["data"] if r["period"].startswith("M") and 1 <= int(r["period"][1:]) <= 12 and (n := number(r["value"])) is not None)
    return result

def pct_to_bps(value):
    return value * 100

def yield_spread(long_pct, short_pct):
    return None if long_pct is None or short_pct is None else (long_pct-short_pct)*100

def changes(points, lag=1, percent=False):
    return [[points[i][0], (points[i][1]/points[i-lag][1]-1)*100 if percent else points[i][1]-points[i-lag][1]] for i in range(lag, len(points)) if not percent or points[i-lag][1] != 0]

def monthly_transform(points, months=1, percent=True):
    lookup = dict(points)
    result = []
    for d, value in points:
        day = date.fromisoformat(d)
        serial = day.year*12+day.month-1-months
        previous = f"{serial//12:04d}-{serial%12+1:02d}-01"
        base = lookup.get(previous)
        if base is not None and (not percent or base != 0):
            result.append([d, (value/base-1)*100 if percent else value-base])
    return result

def period_end(d, cadence):
    dt = date.fromisoformat(d)
    if cadence == "monthly":
        return dt.replace(day=calendar.monthrange(dt.year, dt.month)[1])
    if cadence == "quarterly":
        m = ((dt.month-1)//3+1)*3
        return date(dt.year, m, calendar.monthrange(dt.year, m)[1])
    return dt
