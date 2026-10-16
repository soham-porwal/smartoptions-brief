from datetime import date
from smartoptions.contract import Observation, staleness
from .parsers import period_end

LIMITS = {"daily": 4, "weekly": 10, "monthly": 75, "quarterly": 150}

def observation(id, label, provider, series, url, unit, points, today, *, cadence="daily", transform="level", note=None, method=None, vintage=None):
    points = sorted((str(d), float(v)) for d, v in points if v is not None and str(d) <= today.isoformat())
    latest = points[-1] if points else (None, None)
    d, value = latest
    period = (d[:7] if cadence == "monthly" else f"{d[:4]}-Q{(int(d[5:7])-1)//3+1}" if cadence == "quarterly" else d) if d else None
    status = staleness(period_end(d, cadence).isoformat(), LIMITS[cadence], today) if d else "missing"
    result = Observation(id=id, label=label, provider=provider, series=series, source_url=url, unit=unit, value=value, period=period, date=d, transform=transform, prior=points[-2][1] if len(points)>1 else None, status=status, note=note if points else (note or "Source unavailable or insufficient observations"), history=[list(p) for p in points[-(36 if cadence in ("monthly", "quarterly") else 260):]]).to_dict()
    result["method"] = method or "Provider level; prior is previous available observation; no interpolation"
    result["vintage"] = vintage
    return result
