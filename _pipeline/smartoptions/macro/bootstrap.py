"""Create the first real-data integration fixtures with no fabricated values."""
from pathlib import Path
from datetime import date
from smartoptions.contract import write_json, utc_now
from .fetch import fetch, parsed
from .parsers import treasury
from .observations import observation

def main():
    today = date(2026,10,15)
    out = Path("out/2026-10-15")
    url = f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{today.year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={today.year}&page&_format=csv"
    rows = parsed(fetch(url, out/"raw/treasury-2026.csv", "Treasury 2026"), treasury, "Treasury 2026")
    groups = {g: [] for g in ("inflation", "labor", "growth", "policy", "curve", "cross_asset", "credit_funding", "volatility")}
    for field, id, label in (("3 Mo","us3m","US Treasury 3-month"),("2 Yr","us2y","US Treasury 2-year"),("10 Yr","us10y","US Treasury 10-year")):
        groups["curve"].append(observation(id,label,"US Treasury",field,url,"%",[(d,v[field]) for d,v in rows if v[field] is not None],today))
    write_json(Path("fixtures/macro_sample.json"), {"generated_at":utc_now(),"groups":groups,"daily_factors":{k:[] for k in ("us10y_bps_chg","us2y_bps_chg","dxy_ret","wti_ret","vix_chg","hy_oas_bps_chg")}})
    # The calendar fixture is refreshed by the full collector after source parsing.
    write_json(Path("fixtures/calendar_sample.json"), {"events":[]})
    print(f"real treasury fixture: {len(rows)} rows; {len(groups['curve'])} observations")

if __name__ == "__main__":
    main()
