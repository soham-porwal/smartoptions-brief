import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from smartoptions.contract import write_json
from smartoptions.log import event
from .calendar import collect_calendar
from .collect import collect, GROUPS, FACTORS

def verify(macro,calendar):
    assert set(macro)=={"generated_at","groups","daily_factors"}
    assert set(macro["groups"])==set(GROUPS)
    assert set(macro["daily_factors"])==set(FACTORS)
    obs=[o for group in macro["groups"].values() for o in group]
    ids=[o["id"] for o in obs]
    assert len(ids)==len(set(ids)), "duplicate observation IDs"
    for o in obs:
        assert o["value"] is not None or o["status"] in ("missing","error")
        assert o["source_url"] and o["provider"] and o["series"] and o["unit"]
        assert o["status"] in ("ok","stale","missing","error")
        assert all(v is not None for _,v in o["history"])
    for points in macro["daily_factors"].values():
        assert len(points)<=300
        assert [p[0] for p in points]==sorted(set(p[0] for p in points))
    for e in calendar["events"]:
        assert e["type"] in ("FOMC","CPI","PPI","PCE","NFP","GDP","EIA")
        assert e["status"] in ("released","scheduled")
        assert e["scheduled_et"][-6:] in ("-04:00","-05:00")
    return Counter(o["status"] for o in obs)

def main():
    ap=argparse.ArgumentParser(description="Fetch sourced macro and official calendar snapshots")
    ap.add_argument("--out",type=Path,required=True)
    ap.add_argument("--date",type=date.fromisoformat)
    args=ap.parse_args()
    try:
        today=args.date or date.fromisoformat(args.out.name)
    except ValueError:
        today=date.today()
    try:
        with ThreadPoolExecutor(max_workers=2) as pool:
            macro_future=pool.submit(collect,args.out,today)
            calendar_future=pool.submit(collect_calendar,args.out,today)
            macro,calendar=macro_future.result(),calendar_future.result()
        counts=verify(macro,calendar)
        write_json(args.out/"macro.json",macro)
        write_json(args.out/"calendar.json",calendar)
        event("macro.verify","snapshot","OK",f"statuses={dict(counts)}; calendar_events={len(calendar['events'])}",count=sum(counts.values()))
        print(f"macro: {dict(counts)}; calendar: {len(calendar['events'])} events; notes: {len(calendar['notes'])}")
    except Exception as exc:
        event("macro.build","snapshot","FAIL",f"{type(exc).__name__}: collection or invariant failure")
        raise

if __name__=="__main__":
    main()
