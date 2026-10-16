"""Daily macro collection. All transforms name their basis and observation period."""
import json
import os
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
from pathlib import Path
from smartoptions.contract import utc_now
from smartoptions.log import event
from .fetch import fetch, parsed, UA
from . import parsers
from .observations import observation

GROUPS = ("inflation","labor","growth","policy","curve","cross_asset","credit_funding","volatility")
FACTORS = ("us10y_bps_chg","us2y_bps_chg","dxy_ret","wti_ret","vix_chg","hy_oas_bps_chg")
# group, id, label, unit, cadence, BLS fallback series (or None)
SERIES = {
 "CPIAUCSL":("inflation","cpi_headline","CPI all items (SA)","index","monthly","CUSR0000SA0"),
 "CPILFESL":("inflation","cpi_core","CPI excluding food and energy (SA)","index","monthly","CUSR0000SA0L1E"),
 "PPIFIS":("inflation","ppi_final_demand","PPI final demand (SA)","index","monthly","WPSFD4"),
 "PCEPI":("inflation","pce_headline","PCE price index (SA)","index","monthly",None),
 "PCEPILFE":("inflation","pce_core","PCE excluding food and energy (SA)","index","monthly",None),
 "PAYEMS":("labor","payrolls","Nonfarm payrolls (SA)","thousands","monthly","CES0000000001"),
 "UNRATE":("labor","unemployment","Unemployment rate (SA)","%","monthly","LNS14000000"),
 "CIVPART":("labor","participation","Labor force participation (SA)","%","monthly","LNS11300000"),
 "CES0500000003":("labor","ahe","Average hourly earnings, private (SA)","$/hour","monthly","CES0500000003"),
 "ICSA":("labor","initial_claims","Initial unemployment claims (SA)","claims","weekly",None),
 "GDPC1":("growth","real_gdp_level","Real GDP (SAAR level)","billions chained 2017 USD","quarterly",None),
 "A191RL1Q225SBEA":("growth","real_gdp_saar","Real GDP growth (quarterly SAAR)","% SAAR","quarterly",None),
 "DFEDTARU":("policy","fed_target_upper","Federal funds target upper bound","%","daily",None),
 "DFEDTARL":("policy","fed_target_lower","Federal funds target lower bound","%","daily",None),
 "EFFR":("policy","effective_fed_funds","Effective federal funds rate","%","daily",None),
 "WALCL":("credit_funding","fed_balance_sheet","Federal Reserve total assets","millions USD","weekly",None),
 "WRESBAL":("credit_funding","reserve_balances","Reserve balances with Federal Reserve Banks","millions USD","weekly",None),
 "BAMLH0A0HYM2":("credit_funding","hy_oas","ICE BofA US High Yield OAS","bps","daily",None),
}

def fred_key():
    key = os.environ.get("FRED_API_KEY","").strip()
    if key:
        return key
    path=Path(r"D:\soham\myeverything\Secrets\fred\api_key.txt")
    try:
        return path.read_text(encoding="utf-8-sig").strip() if path.exists() else None
    except OSError as exc:
        event("macro.credentials","FRED","WARN",f"Key unavailable: {type(exc).__name__}")
        return None

def curve(groups,factors,out,today):
    def load(year):
        url=f"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv"
        return url,parsed(fetch(url,out/"raw"/f"treasury-{year}.csv",f"Treasury {year}"),parsers.treasury,f"Treasury {year}")
    with ThreadPoolExecutor(max_workers=2) as pool:
        batches=list(pool.map(load,(today.year-1,today.year)))
    rows=sorted({d:v for _,batch in batches for d,v in batch if d<=today.isoformat()}.items())
    url=batches[-1][0]
    points={}
    for col,id,label in (("3 Mo","us3m","US Treasury 3-month"),("2 Yr","us2y","US Treasury 2-year"),("10 Yr","us10y","US Treasury 10-year")):
        p=[(d,v[col]) for d,v in rows if v[col] is not None]
        points[col]=p
        groups["curve"].append(observation(id,label,"US Treasury",col,url,"%",p,today))
        diff=[[d,parsers.pct_to_bps(v)] for d,v in parsers.changes(p)]
        groups["curve"].append(observation(id+"_bps_chg",label+" daily change","US Treasury",col,url,"bps",diff,today,transform="chg_bps",method="(yield percent today - previous available session yield percent) * 100"))
        if id in ("us2y","us10y"):
            factors[id+"_bps_chg"]=diff[-300:]
    for short,id,label in (("2 Yr","spread_10y_2y","10-year minus 2-year Treasury spread"),("3 Mo","spread_10y_3m","10-year minus 3-month Treasury spread")):
        p=[[d,parsers.yield_spread(v["10 Yr"],v[short])] for d,v in rows if v["10 Yr"] is not None and v[short] is not None]
        groups["curve"].append(observation(id,label,"US Treasury","10 Yr - "+short,url,"bps",p,today,method="(10-year yield percent - short yield percent) * 100; matched source date"))

def volatility(groups,factors,out,today):
    def load(series):
        url=f"https://cdn.cboe.com/api/global/us_indices/daily_prices/{series}_History.csv"
        p=parsed(fetch(url,out/"raw"/(series+".csv"),"Cboe "+series),parsers.cboe,"Cboe "+series)
        return series,url,[x for x in p if x[0]<=today.isoformat()]
    with ThreadPoolExecutor(max_workers=3) as pool:
        rows=list(pool.map(load,("VIX","VIX9D","VIX3M")))
    term={}
    for series,url,p in rows:
        term[series]=dict(p)
        groups["volatility"].append(observation(series.lower(),series+" close (volatility term structure)","Cboe",series,url,"index points",p,today))
        if series=="VIX":
            factors["vix_chg"]=parsers.changes(p)[-300:]
    url="https://www.cboe.com/tradable_products/vix/"
    for other,id in (("VIX9D","vix9d_minus_vix"),("VIX3M","vix3m_minus_vix")):
        p=[[d,term[other][d]-v] for d,v in term["VIX"].items() if d in term[other]]
        groups["volatility"].append(observation(id,other+" minus VIX (term structure)","Cboe",other+" - VIX",url,"index points",p,today,method="Difference between volatility-index closes matched by date; no regime threshold"))

def funding(groups,out,today):
    url="https://markets.newyorkfed.org/api/rates/secured/sofr/last/300.json"
    p=parsed(fetch(url,out/"raw/sofr.json","NY Fed SOFR"),parsers.sofr,"NY Fed SOFR")
    groups["credit_funding"].append(observation("sofr","Secured Overnight Financing Rate","Federal Reserve Bank of New York","SOFR",url,"%",p,today))

def economy(groups,factors,out,today):
    key=fred_key()
    fallback={}
    if not key:
        ids=[v[5] for v in SERIES.values() if v[5]]
        raw=fetch("https://api.bls.gov/publicAPI/v2/timeseries/data/",out/"raw/bls.json","BLS batch",payload={"seriesid":ids,"startyear":str(today.year-1),"endyear":str(today.year)},cache=True)
        if raw:
            try:
                fallback=parsers.bls(raw)
                count=sum(map(len,fallback.values()))
                event("macro.parse","BLS batch","OK" if count else "SUSPECT","batched seven series",count=count)
            except Exception as exc:
                event("macro.parse","BLS batch","FAIL",type(exc).__name__)
    def load(item):
        series,meta=item
        vintage=None
        if key:
            raw=fetch("https://api.stlouisfed.org/fred/series/observations",out/"raw"/("fred-"+series+".json"),"FRED "+series,params={"series_id":series,"api_key":key,"file_type":"json","observation_start":f"{today.year-5}-01-01","observation_end":today.isoformat(),"realtime_end":today.isoformat(),"realtime_start":today.isoformat()})
            p=parsed(raw,parsers.fred,"FRED "+series)
            if raw:
                try:
                    vintage=json.loads(raw).get("realtime_start")
                except (ValueError,TypeError):
                    event("macro.vintage",series,"WARN","Invalid vintage response")
            return series,p,vintage,"BLS via FRED" if meta[5] else "BEA via FRED" if series in ("PCEPI","PCEPILFE","GDPC1","A191RL1Q225SBEA") else "FRED",series,f"https://fred.stlouisfed.org/series/{series}",None
        blsid=meta[5]
        p=fallback.get(blsid,[]) if blsid else []
        reason=None if p else "BLS fallback unavailable or empty" if blsid else "needs FRED key"
        event("macro.source",series,"OK" if p else "WARN",reason or "BLS fallback observations",count=len(p))
        return series,p,None,"BLS Public API" if blsid else "FRED",blsid or series,"https://api.bls.gov/publicAPI/v2/timeseries/data/" if blsid else f"https://fred.stlouisfed.org/series/{series}",reason
    with ThreadPoolExecutor(max_workers=6) as pool:
        rows=list(pool.map(load,SERIES.items()))
    for series,p,vintage,provider,sourceid,url,note in rows:
        group,id,label,unit,cadence,_=SERIES[series]
        p=[x for x in p if x[0]<=today.isoformat()]
        base_method="Provider level; SA where labeled; prior reflects latest vintage, not original release; consensus unavailable"
        if not key:
            base_method+="; BLS API does not provide a realtime vintage or original-release revision history"
        if group=="inflation":
            for months,suffix in ((12,"yoy"),(1,"mom")):
                points=parsers.monthly_transform(p,months)
                groups[group].append(observation(id if months==12 else id+"_mom",label+f" {suffix.upper()}",provider,sourceid,url,"% "+suffix.upper(),points,today,cadence=cadence,transform=suffix,note=note,method=f"(index[t] / index[t-{months} calendar months] - 1) * 100; "+base_method,vintage=vintage))
        else:
            if series=="PAYEMS":
                p=parsers.monthly_transform(p,1,False)
                label="Monthly nonfarm payroll change (SA)"
                base_method="PAYEMS[t] - PAYEMS[t-1 calendar month]; thousands; prior uses current revised vintage"
            elif series=="BAMLH0A0HYM2":
                p=[[d,v*100] for d,v in p]
                factors["hy_oas_bps_chg"]=parsers.changes(p)[-300:]
                base_method="Provider percentage-point OAS * 100 = bps; daily factor is difference in bps"
            groups[group].append(observation(id,label,provider,sourceid,url,unit,p,today,cadence=cadence,transform="monthly_change" if series=="PAYEMS" else "level",note=note,method=base_method,vintage=vintage))

def cross_assets(groups,factors,out,today):
    import yfinance as yf
    from curl_cffi import requests as curl_requests
    assets=(("DX-Y.NYB","dxy","DXY (ICE, via Yahoo, delayed)","index points"),("CL=F","wti","WTI front-month continuous, not roll-adjusted","USD/barrel"),("BZ=F","brent","Brent front-month continuous, not roll-adjusted","USD/barrel"),("HG=F","copper","COMEX copper front-month continuous, not roll-adjusted","USD/lb"))
    session=curl_requests.Session(impersonate="chrome")
    session.headers.update({"User-Agent":UA})
    for ticker,id,label,unit in assets:
        p=[]
        for attempt in range(2):
            try:
                data=yf.Ticker(ticker,session=session).history(start=(today-timedelta(days=520)).isoformat(),end=(today+timedelta(days=1)).isoformat(),interval="1d",auto_adjust=False,timeout=18,raise_errors=True)
                p=[(d.date().isoformat(),float(v)) for d,v in data["Close"].items() if parsers.number(v) is not None and d.date()<=today]
                # A daily bar stamped today can be unfinished. Use completed prior day only.
                p=[x for x in p if x[0]<today.isoformat()]
                event("macro.fetch","Yahoo "+ticker,"OK" if p else "SUSPECT",f"attempt {attempt+1}; completed previous-day bars",count=len(p))
                if p:
                    from smartoptions.contract import write_json
                    write_json(out/"raw"/(id+"-yahoo.json"),{"provider":"Yahoo Finance via yfinance","series":ticker,"retrieved_at":utc_now(),"prices":p,"method":"Unadjusted daily Close; today's possibly partial bar excluded"})
                    break
            except Exception as exc:
                event("macro.fetch","Yahoo "+ticker,"FAIL",f"attempt {attempt+1}/2; {type(exc).__name__}")
        url="https://finance.yahoo.com/quote/"+ticker.replace("=","%3D")+"/history/"
        groups["cross_asset"].append(observation(id,label,"Yahoo Finance via yfinance",ticker,url,unit,p,today,method="Unadjusted daily close; partial current-day bar excluded; delayed distributor; futures roll discontinuities possible"))
        for lag in (1,5,20):
            returns=parsers.changes(p,lag,True)
            groups["cross_asset"].append(observation(f"{id}_ret_{lag}d",label+f" {lag}-session change","Yahoo Finance via yfinance",ticker,url,"%",returns,today,transform="ret_pct",method=f"(close[t] / close[t-{lag} available trading sessions] - 1) * 100; not roll-adjusted"))
            if lag==1 and id in ("dxy","wti"):
                factors[id+"_ret"]=returns[-300:]

def collect(out,today):
    groups={g:[] for g in GROUPS}
    factors={k:[] for k in FACTORS}
    # Sources write disjoint groups; no nested process or standalone agent session.
    jobs=(lambda:curve(groups,factors,out,today),lambda:volatility(groups,factors,out,today),lambda:funding(groups,out,today),lambda:economy(groups,factors,out,today),lambda:cross_assets(groups,factors,out,today))
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures=[pool.submit(job) for job in jobs]
        for future in futures:
            try:
                future.result()
            except Exception as exc:
                event("macro.collect","stage","FAIL",f"Unhandled source group failure: {type(exc).__name__}")
                raise
    return {"generated_at":utc_now(),"groups":groups,"daily_factors":factors}
