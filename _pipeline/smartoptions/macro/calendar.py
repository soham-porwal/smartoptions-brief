"""Official calendar parsing. No inferred BLS dates or release weekdays."""
import re
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, date, time, timedelta
from zoneinfo import ZoneInfo
from lxml import html
from smartoptions.contract import utc_now
from smartoptions.log import event
from .fetch import fetch

ET = ZoneInfo("America/New_York")
SOURCES = {"fomc":"https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm", "cpi":"https://www.bls.gov/schedule/news_release/cpi.htm", "ppi":"https://www.bls.gov/schedule/news_release/ppi.htm", "empsit":"https://www.bls.gov/schedule/news_release/empsit.htm", "jolts":"https://www.bls.gov/schedule/news_release/jolts.htm", "bea":"https://www.bea.gov/news/schedule", "eia":"https://www.eia.gov/petroleum/supply/weekly/schedule.php"}

def text(node):
    return " ".join(node.text_content().split())

def make_event(kind, title, d, clock, url, now):
    dt = datetime.combine(d, clock, ET)
    return {"id":f"{kind.lower()}-{d.isoformat()}","type":kind,"title":title,"scheduled_et":dt.isoformat(),"source_url":url,"status":"released" if dt <= now else "scheduled","risk_tags":["scheduled"]}

def parse_fomc(raw, url, now):
    root = html.fromstring(raw)
    result = []
    for panel in root.xpath('//div[contains(concat(" ",normalize-space(@class)," ")," panel ")]'):
        heading = panel.xpath('.//h4')
        match = re.search(r"(20\d{2}) FOMC Meetings", text(heading[0]) if heading else "")
        if not match:
            continue
        year = int(match[1])
        for row in panel.xpath('.//div[contains(concat(" ",normalize-space(@class)," ")," fomc-meeting ")]'):
            month = row.xpath('.//div[contains(@class,"fomc-meeting__month")]')
            days = row.xpath('.//div[contains(@class,"fomc-meeting__date")]')
            if not month or not days or "notation" in text(days[0]).lower():
                continue
            # Statement belongs to the final meeting day; 14:00 ET per approved contract.
            m = text(month[0]).split("/")[-1]
            day = int(re.findall(r"\d+",text(days[0]).split("(")[0])[-1])
            d = datetime.strptime(f"{m[:3]} {day} {year}","%b %d %Y").date()
            result.append(make_event("FOMC","FOMC policy statement (scheduled)",d,time(14),url,now))
    return result

def parse_bea(raw, url, now):
    root = html.fromstring(raw)
    result = []
    for table in root.xpath('//table'):
        heading = text(table.xpath('.//thead')[0]) if table.xpath('.//thead') else ""
        year_match = re.search(r"20\d{2}",heading)
        if not year_match:
            continue
        year = year_match[0]
        for row in table.xpath('.//tr'):
            title_node = row.xpath('.//td[contains(@class,"release-title")]')
            date_node = row.xpath('.//div[contains(@class,"release-date")]')
            time_node = row.xpath('.//small')
            if not title_node or not date_node or not time_node:
                continue
            title = text(title_node[0])
            kind = "PCE" if "Personal Income and Outlays" in title else "GDP" if title.startswith("GDP (") else None
            if kind:
                dt = datetime.strptime(f"{text(date_node[0])} {year} {text(time_node[0])}","%B %d %Y %I:%M %p")
                result.append(make_event(kind,title,dt.date(),dt.time(),url,now))
    return result

def parse_bls(raw, url, now, kind):
    root = html.fromstring(raw)
    result = []
    for row in root.xpath('//tr'):
        cells = [text(x) for x in row.xpath('./th|./td')]
        if len(cells)<3:
            continue
        # BLS table columns: reference month, release date, release time.
        for i,c in enumerate(cells):
            m = re.search(r"([A-Za-z]+\.?\s+\d{1,2},\s+20\d{2})",c)
            if not m:
                continue
            ds = m[1].replace(".","")
            d = None
            for fmt in ("%B %d, %Y","%b %d, %Y"):
                try:
                    d = datetime.strptime(ds,fmt).date()
                    break
                except ValueError:
                    pass
            clock_match = re.search(r"(\d{1,2}:\d{2})\s*([AP]M)?"," ".join(cells[i+1:]),re.I)
            if d and clock_match:
                fmt = "%I:%M %p" if clock_match[2] else "%H:%M"
                clock = datetime.strptime(clock_match[1]+(" "+clock_match[2].upper() if clock_match[2] else ""),fmt).time()
                result.append(make_event(kind,{"CPI":"Consumer Price Index","PPI":"Producer Price Index","NFP":"Employment Situation"}[kind],d,clock,url,now))
                break
    return result

def parse_eia(raw, url, now, today):
    root = html.fromstring(raw)
    result = {}
    exceptions = {}
    for row in root.xpath('//tr'):
        cells = [text(x) for x in row.xpath('./th|./td')]
        if len(cells)<4:
            continue
        try:
            week_end = datetime.strptime(cells[0],"%B %d, %Y").date()
            release = datetime.strptime(cells[1],"%B %d, %Y").date()
            clock = datetime.strptime(cells[3].replace("a.m.","AM").replace("p.m.","PM"),"%I:%M %p").time()
        except ValueError:
            continue
        # Keep the source's reference-week date; no reference weekday is assumed.
        exceptions[week_end] = (release,clock)
    content = text(root)
    m = re.search(r"standard release time and day of the week will be at (\d{1,2}:\d{2})\s*(a\.m\.|p\.m\.)\s+eastern time on (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)",content,re.I)
    if not m:
        raise ValueError("EIA standard schedule not explicitly found")
    weekday = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"].index(m[3].title())
    clock = datetime.strptime(m[1]+" "+("AM" if m[2].lower()=="a.m." else "PM"),"%I:%M %p").time()
    overrides = {week_end+timedelta(days=(weekday-week_end.weekday())%7 or 7): release for week_end,release in exceptions.items()}
    # Source publishes a recurring rule and exceptions, rather than dated normal rows.
    for offset in range(-14,38):
        d = today+timedelta(days=offset)
        if d.weekday()!=weekday:
            continue
        release,t = overrides.get(d,(d,clock))
        result[release] = make_event("EIA","EIA Weekly Petroleum Status Report",release,t,url,now)
    return list(result.values())

FRED_RELEASES = {"cpi": (10, "CPI", "Consumer Price Index"), "ppi": (46, "PPI", "Producer Price Index"),
                 "empsit": (50, "NFP", "Employment Situation (payrolls)")}


def fred_release_events(name, now, today):
    """Fallback when bls.gov blocks us (403): release DATES from FRED's release calendar (St. Louis Fed, which
    publishes BLS's schedule). The 08:30 ET time is BLS's standard release time for these three reports and is
    labeled as such in the event note; it is not read from the fallback source."""
    import json
    import urllib.request
    from pathlib import Path as _P
    key_file = _P(r"D:\soham\myeverything\Secrets\fred\api_key.txt")
    import os
    key = os.environ.get("FRED_API_KEY") or (key_file.read_text().strip() if key_file.exists() else None)
    if not key:
        return []
    rid, kind, title = FRED_RELEASES[name]
    url = (f"https://api.stlouisfed.org/fred/release/dates?release_id={rid}&api_key={key}&file_type=json"
           f"&realtime_start={(today - timedelta(days=10)).isoformat()}&include_release_dates_with_no_data=true&sort_order=asc&limit=10")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        dates = [d["date"] for d in json.loads(r.read())["release_dates"]]
    src = f"https://fred.stlouisfed.org/releases/calendar?rid={rid}"
    rows = []
    for d in dates:
        e = make_event(kind, title, date.fromisoformat(d), time(8, 30), src, now)
        e["note"] = "date: FRED release calendar (BLS blocked automated access); time: BLS standard 08:30 ET"
        rows.append(e)
    return rows


def collect_calendar(out, today):
    now = datetime.fromisoformat(utc_now().replace("Z","+00:00")).astimezone(ET)
    if now.date()!=today:
        now = datetime.combine(today,time(23,59,59),ET)
    def load(item):
        name,url=item
        return name,fetch(url,out/"raw"/(name+".html"),"calendar "+name)
    with ThreadPoolExecutor(max_workers=7) as pool:
        raws = dict(pool.map(load,SOURCES.items()))
    events=[]
    notes=[]
    source_status={}
    for name,raw in raws.items():
        source_status[name]={"status":"missing", "source_url":SOURCES[name],
                             "reason":"No parseable official calendar events"}
        if not raw and name=="jolts":
            # Not a fetch failure worth reporting as one: JOLTS is outside the tracked event types either way.
            notes.append("jolts: JOLTS omitted; it is not in the tracked release set, so its dates are not listed")
            continue
        if not raw:
            if name in FRED_RELEASES:
                try:
                    rows = fred_release_events(name, now, today)
                    event("macro.calendar", f"{name}-fred", "OK" if rows else "SUSPECT", "bls.gov blocked; dates from FRED release calendar", count=len(rows))
                    if rows:
                        source_status[name]={"status":"ok", "source_url":rows[0]["source_url"],
                                             "note":"FRED release-date fallback; standard BLS time, not scraped time"}
                        notes.append(f"{name}: bls.gov blocked automated access; dates from FRED release calendar, 08:30 ET standard time")
                        events.extend(rows)
                        continue
                except Exception as exc:
                    event("macro.calendar", f"{name}-fred", "FAIL", f"{type(exc).__name__}: FRED release-dates fallback failed")
            notes.append(f"{name}: official calendar unavailable after two attempts; events omitted")
            continue
        if name=="jolts":
            notes.append("JOLTS omitted: current PLAN event types exclude JOLTS")
            event("macro.calendar",name,"WARN","JOLTS outside contracted event enum")
            continue
        try:
            url=SOURCES[name]
            rows = parse_fomc(raw,url,now) if name=="fomc" else parse_bea(raw,url,now) if name=="bea" else parse_eia(raw,url,now,today) if name=="eia" else parse_bls(raw,url,now,{"cpi":"CPI","ppi":"PPI","empsit":"NFP"}[name])
            event("macro.calendar",name,"OK" if rows else "SUSPECT","official calendar parsed",count=len(rows))
            if not rows:
                notes.append(f"{name}: no parseable official releases; events omitted")
            else:
                source_status[name]={"status":"ok", "source_url":url}
            events.extend(rows)
        except Exception as exc:
            event("macro.calendar",name,"FAIL",f"{type(exc).__name__}: calendar parser failed")
            notes.append(f"{name}: official calendar parsing failed; events omitted")
    low, high=today-timedelta(days=7),today+timedelta(days=30)
    selected={e["id"]:e for e in events if low<=date.fromisoformat(e["scheduled_et"][:10])<=high}
    return {"events":sorted(selected.values(),key=lambda e:e["scheduled_et"]),"notes":notes,
            "status":"ok" if selected else "missing", "source_status":source_status}
