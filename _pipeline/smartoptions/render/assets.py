"""Inline CSS and JS. No external fonts, scripts or images: the page makes zero network requests."""

CSS = r"""
:root{--bg:#f4f4f4;--panel:#fff;--panel2:#f8f8f8;--bd:#e0e0e0;--bd2:#ececec;--tx:#161616;--mu:#5a5a5a;--ln:#0f62fe;--up:#0e6027;--dn:#a2191f;--ok:#0e6027;--okb:#defbe6;--st:#8a5a00;--stb:#fcf4d6;--ms:#5a5a5a;--msb:#ececec;--er:#a2191f;--erb:#fff1f1;--hp:rgba(36,161,72,.16);--hn:rgba(218,30,40,.13);--pr:36,161,72;--nr:218,30,40;--e7:#8a5a00;--e7b:#fcf4d6;--hd:#1a1a2e;--hdt:#e8e8f0;--sh:none}
:root[data-theme=dark]{--bg:#161616;--panel:#1e1e1e;--panel2:#262626;--bd:#393939;--bd2:#2b2b2b;--tx:#f4f4f4;--mu:#a8a8a8;--ln:#78a9ff;--up:#42be65;--dn:#ff8389;--ok:#42be65;--okb:#0f2e19;--st:#f1c21b;--stb:#33290a;--ms:#a8a8a8;--msb:#2b2b2b;--er:#ff8389;--erb:#3d1214;--hp:rgba(66,190,101,.18);--hn:rgba(250,77,86,.18);--pr:66,190,101;--nr:250,77,86;--e7:#f1c21b;--e7b:#33290a;--hd:#1a1a2e;--hdt:#e8e8f0;--sh:none}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#161616;--panel:#1e1e1e;--panel2:#262626;--bd:#393939;--bd2:#2b2b2b;--tx:#f4f4f4;--mu:#a8a8a8;--ln:#78a9ff;--up:#42be65;--dn:#ff8389;--ok:#42be65;--okb:#0f2e19;--st:#f1c21b;--stb:#33290a;--ms:#a8a8a8;--msb:#2b2b2b;--er:#ff8389;--erb:#3d1214;--hp:rgba(66,190,101,.18);--hn:rgba(250,77,86,.18);--pr:66,190,101;--nr:250,77,86;--e7:#f1c21b;--e7b:#33290a;--hd:#1a1a2e;--hdt:#e8e8f0;--sh:none}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--tx);font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI Variable Text","Segoe UI",system-ui,Roboto,"Helvetica Neue",Arial,sans-serif;
font-variant-numeric:tabular-nums;overflow-x:hidden}
a{color:var(--ln);text-decoration:none}a:hover{text-decoration:underline}
.wrap{max-width:1480px;margin:0 auto;padding:0 20px 60px}
h1{font-size:19px;margin:0;font-weight:650;letter-spacing:-.01em}h1 .sep{color:var(--mu);font-weight:400}
h2{font-size:15px;margin:0;font-weight:650;letter-spacing:.01em;text-transform:uppercase;color:var(--tx)}
h3{font-size:14px;margin:0 0 6px;font-weight:620}h4{font-size:11.5px;margin:10px 0 3px;text-transform:uppercase;letter-spacing:.05em;color:var(--mu);font-weight:600}
.n{font-variant-numeric:tabular-nums}.muted{color:var(--mu)}.small,small{font-size:12px}
.up{color:var(--up)}.dn{color:var(--dn)}.na{color:var(--mu);cursor:help}
.warn{color:var(--st)}
header.top{background:var(--hd);color:var(--hdt);margin:0 -20px;padding:12px 20px 6px}header.top a{color:#a6c8ff}header.top .meta,header.top .meta b{color:#c6c6d4}header.top .btn{background:transparent;color:var(--hdt);border-color:rgba(255,255,255,.25)}.hfoot{display:flex;gap:16px;align-items:baseline;flex-wrap:wrap;border-top:1px solid rgba(255,255,255,.12);margin-top:8px;padding-top:4px}header.top details.fresh{margin:0}header.top details.fresh summary{color:#c6c6d4}header.top .fresh-body{color:var(--tx)}
.titlebar{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap}
.meta{color:var(--mu);font-size:12.5px;margin-top:3px}.meta b{color:var(--tx)}
.tools{display:flex;gap:12px;align-items:center;font-size:13px}
.btn{font:inherit;font-size:12.5px;background:var(--panel);color:var(--tx);border:1px solid var(--bd);border-radius:4px;padding:3px 10px;cursor:pointer}
.btn:hover{border-color:var(--mu)}
.disc{font-size:11.5px;color:rgba(255,255,255,.5)}
details.fresh{margin-top:10px;font-size:12.5px}details.fresh summary{cursor:pointer;color:var(--mu)}
.fresh-body{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:8px 12px;margin-top:6px;overflow-x:auto}
.chip{display:inline-block;font-size:11px;line-height:16px;padding:0 6px;border-radius:3px;font-weight:600;white-space:nowrap;letter-spacing:.01em}
.st-ok{color:var(--ok);background:var(--okb)}.st-stale{color:var(--st);background:var(--stb)}
.st-missing{color:var(--ms);background:var(--msb)}.st-error{color:var(--er);background:var(--erb)}
section.blk{margin-top:22px}
.blk-h{display:flex;align-items:baseline;gap:10px;border-bottom:1px solid var(--bd);padding-bottom:5px;margin-bottom:10px;flex-wrap:wrap}
.blk-h .muted{font-size:12px}
.sub{margin-top:12px;font-size:12px;color:var(--mu);text-transform:uppercase;letter-spacing:.05em}
.unavail{border:1px dashed var(--bd);border-radius:4px;padding:12px 14px;color:var(--mu);background:var(--panel2)}
.unavail strong{color:var(--tx)}
.evgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:8px}
.ev{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:8px 10px;min-width:0;box-shadow:var(--sh)}
.ev.past{background:var(--panel2);opacity:.85}
.ev-h{display:flex;justify-content:space-between;align-items:center}.ev-type{font-weight:700;font-size:12px;letter-spacing:.04em}
.ev-t{font-size:13px;margin:3px 0;overflow-wrap:anywhere}.ev-time{font-size:12.5px}.ev-time .lt,.ev-time .cd{display:block;color:var(--mu)}
.ev-time .cd{color:var(--tx);font-weight:600}
.ev-f{font-size:12px;margin-top:4px;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.tag{display:inline-block;font-size:11px;padding:0 6px;border:1px solid var(--bd);border-radius:3px;color:var(--mu);line-height:16px}
.tag.hot{color:var(--e7);border-color:var(--e7)}
.lt:empty,.cd:empty{display:none!important}
details.later{margin-top:8px;font-size:13px}details.later summary{cursor:pointer;color:var(--mu)}details.later li{margin:2px 0}
.notes{font-size:12px;color:var(--mu);margin:8px 0 0;padding-left:18px}
.ctx{margin-bottom:10px}.mcgrid.ctxgrid{grid-template-columns:repeat(auto-fill,minmax(210px,250px))}
.insgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:8px;margin-top:12px}
.ins{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:8px 10px;min-width:0}
.ins-h{display:flex;justify-content:space-between;gap:8px;align-items:flex-start}.ins-h h3{margin:0}
.ins p{margin:4px 0}.obs{font-size:13.5px}
.ins ul{margin:2px 0;padding-left:18px}.ins li{margin:1px 0;overflow-wrap:anywhere}
.evid .lbl{color:var(--mu)}
.chips{display:flex;flex-wrap:wrap;gap:5px}
.tk{font:inherit;font-size:12px;font-weight:650;border:1px solid var(--bd);background:var(--panel2);color:var(--tx);border-radius:3px;padding:1px 7px;cursor:pointer}
.tk small{font-weight:400;color:var(--mu)}.tk:hover{border-color:var(--ln)}.tk-unk{opacity:.6}
.ins-f{margin-top:8px}
.mgs{display:grid;grid-template-columns:repeat(auto-fill,minmax(540px,1fr));gap:14px 24px;align-items:start}.mg{min-width:0;max-width:100%}.mtab{width:100%;border-collapse:collapse;font-size:12.5px;background:var(--panel);border:1px solid var(--bd);border-radius:4px}.mtab th,.mtab td{padding:3px 8px;border-bottom:1px solid var(--bd2);white-space:nowrap;vertical-align:middle}.mtab th{font-weight:500;text-align:left;white-space:normal;cursor:help}.mtab th .chip{margin-left:6px}.mtab td.mv,.mtab td.md{text-align:right}.mtab td.md{color:var(--mu)}.mtab td.msp{color:var(--mu);width:90px}.mtab td.mp{color:var(--mu);font-size:11.5px}.mtab td.ms{font-size:11.5px}.mtab .unit{font-size:11px}.mtab tr.st-b-stale th{box-shadow:inset 2px 0 var(--st)}.mtab tr.st-b-error th,.mtab tr.st-b-missing th{box-shadow:inset 2px 0 var(--er)}
summary.mg-h{cursor:pointer;list-style:none}summary.mg-h::-webkit-details-marker{display:none}
summary.mg-h::before{content:"\25BE";color:var(--mu);font-size:11px;margin-right:2px}details.mg:not([open]) summary.mg-h::before{content:"\25B8"}.mg-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}.mg-h h3{margin:0}
.trend{font-size:11.5px;font-weight:650;padding:0 6px;border-radius:3px;border:1px solid var(--bd)}
.tr-acc{color:var(--dn);border-color:var(--dn)}.tr-slow{color:var(--up);border-color:var(--up)}.tr-mix{color:var(--st);border-color:var(--st)}.tr-ins{color:var(--mu)}
.mcgrid{display:grid;grid-template-columns:repeat(var(--n,3),minmax(0,210px));gap:8px}
.mc{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:8px 10px;min-width:0;box-shadow:var(--sh)}
.mc.st-b-stale{border-top:2px solid var(--st)}.mc.st-b-error{border-top:2px solid var(--er)}.mc.st-b-missing{border-top:2px solid var(--ms)}
.mc-h{display:flex;justify-content:space-between;gap:6px;align-items:flex-start}.mc-l{font-size:12.5px;font-weight:600;overflow-wrap:anywhere}
.mc-v{margin-top:3px}.big{font-size:20px;font-weight:600;letter-spacing:-.01em}.unit{color:var(--mu);font-size:12px}
.mc-d{font-size:12px}.mc-s{color:var(--mu);margin-top:4px;height:30px}.spark{display:block;max-width:100%}
.spark-na{font-size:11px;color:var(--mu);line-height:30px}
.mc-f{display:flex;justify-content:space-between;font-size:12px;color:var(--mu);margin-top:3px;gap:6px}.mc-f b{color:var(--tx);font-weight:600}
.note{font-size:11.5px;color:var(--mu);margin-top:4px;overflow-wrap:anywhere}
.tctl{display:flex;flex-direction:column;gap:7px;margin-bottom:8px}
#tq{font:inherit;font-size:13px;padding:5px 9px;border:1px solid var(--bd);border-radius:4px;background:var(--panel);color:var(--tx);max-width:360px;width:100%}
.qfs,.tgs{display:flex;flex-wrap:wrap;gap:5px}
.qf{font:inherit;font-size:12px;border:1px solid var(--bd);background:var(--panel);color:var(--tx);border-radius:12px;padding:2px 10px;cursor:pointer}
.qf.on{background:var(--hd);color:#fff;border-color:var(--hd)}
.tg{font-size:12px;color:var(--mu);border:1px solid var(--bd2);border-radius:4px;padding:1px 8px;cursor:pointer;user-select:none}
.twrap{overflow:auto;max-height:78vh;border:1px solid var(--bd);border-radius:4px;background:var(--panel);max-width:100%}
.tt{border-collapse:separate;border-spacing:0;width:max-content;min-width:100%;font-size:12.5px}
.tt th,.tt td{padding:4px 8px;border-bottom:1px solid var(--bd2);white-space:nowrap;text-align:right;vertical-align:middle}
.tt thead th{position:sticky;top:0;z-index:2;background:var(--hd);font-size:11.5px;font-weight:600;color:var(--hdt);cursor:pointer;
border-bottom:1px solid var(--bd);user-select:none}
.tt thead th.asc::after{content:" \25B2";font-size:9px}.tt thead th.desc::after{content:" \25BC";font-size:9px}
.tt .g-id{text-align:left}.tt td.sect{max-width:150px;overflow:hidden;text-overflow:ellipsis}
.tt .sticky{position:sticky;left:0;z-index:1;background:var(--panel);border-right:1px solid var(--bd2)}
.tt thead th.sticky{z-index:3;background:var(--hd)}
.tt tbody tr{cursor:pointer}.tt tbody tr:hover td,.tt tbody tr:hover th{background:var(--panel2)}
.tt tbody tr.sel td,.tt tbody tr.sel th{background:var(--panel2)}
.tkcell{text-align:left;max-width:190px}
.tklink{font:inherit;font-weight:700;background:none;border:0;color:var(--tx);padding:0;cursor:pointer}
.nm{display:block;font-size:11px;color:var(--mu);font-weight:400;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.g-price.g-price{}.tt td.hot{font-weight:650}
.set{display:inline-block;font-size:10.5px;font-weight:700;padding:0 5px;border-radius:3px;border:1px solid var(--bd);color:var(--mu)}
.set-AB{color:var(--tx);border-color:var(--tx)}.set-A{color:var(--tx)}
.rbar{display:inline-block;position:relative;width:70px;height:6px;background:var(--bd2);border-radius:3px;vertical-align:middle}
.rbar i{position:absolute;top:-2px;width:3px;height:10px;margin-left:-1px;background:var(--tx);border-radius:1px}
.earn7{color:var(--e7);background:var(--e7b);font-weight:650;padding:0 4px;border-radius:3px}
td.heat-pos,.heat-pos{background:var(--hp)}td.heat-neg,.heat-neg{background:var(--hn)}
.t{color:var(--mu)}
.hide-price .g-price,.hide-fund .g-fund,.hide-sam .g-sam,.hide-sens .g-sens,.hide-opt .g-opt{display:none}
#drawer{position:fixed;top:0;right:0;height:100%;width:min(720px,100%);background:var(--panel);border-left:1px solid var(--bd);
transform:translateX(100%);transition:transform .18s ease;z-index:20;overflow-y:auto;padding:14px 18px 40px;box-shadow:-8px 0 24px rgba(0,0,0,.12)}
#drawer.open{transform:none}
#dimmer{position:fixed;inset:0;background:rgba(0,0,0,.25);z-index:19;display:none}#dimmer.open{display:block}
#drawer h2{text-transform:none;font-size:20px;letter-spacing:0}
#drawer h3{margin-top:16px;border-bottom:1px solid var(--bd2);padding-bottom:3px}
#drawer .xclose{position:sticky;top:0;float:right}
.dr-h{margin-bottom:6px}
table.mini{border-collapse:collapse;font-size:12.5px;width:100%}
table.mini th,table.mini td{padding:3px 6px;border-bottom:1px solid var(--bd2);text-align:left;vertical-align:top}
table.mini th{color:var(--mu);font-weight:600;white-space:nowrap}
table.mini td.n{text-align:right;white-space:nowrap}
.prov{font-size:11.5px;color:var(--mu);overflow-wrap:anywhere}
.rd{font-size:12px}
.explain{font-size:12.5px;background:var(--panel2);border:1px solid var(--bd2);border-radius:4px;padding:6px 10px}
dl.x{margin:0;display:grid;grid-template-columns:max-content 1fr;gap:2px 10px}dl.x dt{color:var(--mu);font-weight:600}dl.x dd{margin:0}
ul.x{margin:0;padding-left:16px}.xv{font-weight:650}.xd{color:var(--tx)}
.evl{padding-left:18px;font-size:12.5px}.evl .lt{color:var(--mu)}
.pbgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}
.pb{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:10px 12px;min-width:0}
.pb p{margin:4px 0;font-size:13px}.pb ul{margin:3px 0;padding-left:18px;font-size:13px}.pb li{margin:2px 0}
.pb .nt{border-top:1px solid var(--bd2);padding-top:5px;margin-top:6px;font-size:12.5px}
.meth{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:10px}
.meth .pb ul{font-size:12.5px}
.srcs{font-size:12.5px;columns:2 320px;padding-left:18px}.srcs li{break-inside:avoid;margin:1px 0;overflow-wrap:anywhere}
.pre{white-space:pre-wrap;font-size:12px;overflow-wrap:anywhere}
footer{margin-top:28px;border-top:1px solid var(--bd);padding-top:10px;font-size:12px;color:var(--mu)}
.info{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;border-radius:50%;border:1px solid currentColor;
font-size:9.5px;font-weight:700;font-style:italic;font-family:Georgia,serif;color:var(--mu);cursor:help;margin-left:5px;vertical-align:1px;flex:none}
.eyebrow{font-size:12px;color:var(--mu);font-weight:500;display:flex;align-items:center;gap:2px}
.hero{display:grid;grid-template-columns:minmax(220px,auto) minmax(300px,1fr) auto;gap:16px 32px;align-items:end;
background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:14px 18px;margin-top:16px}
.hero-v{display:flex;align-items:center;gap:12px;margin-top:2px}
.hero-n{font-size:52px;line-height:1;font-weight:600;letter-spacing:-.03em}
.tier{font-size:13px;font-weight:700;letter-spacing:.04em;padding:3px 10px;border-radius:999px;background:var(--msb);color:var(--ms)}
.t-avoid{--c:var(--dn);--cb:var(--erb)}.t-defensive{--c:var(--st);--cb:var(--stb)}.t-normal{--c:var(--ln);--cb:var(--panel2)}
.t-favorable{--c:var(--up);--cb:var(--okb)}.t-optimal{--c:var(--up);--cb:var(--okb)}
.tier[class*=t-]{color:var(--c);background:var(--cb)}
.hero-scale{position:relative;height:16px;margin-top:10px;border-top:4px solid var(--bd2);font-size:10px;color:var(--mu)}
.hero-scale span{position:absolute;top:2px;transform:translateX(-50%)}
.hero-scale span::before{content:"";position:absolute;left:50%;top:-6px;width:1px;height:4px;background:var(--mu)}
.hero-scale i{position:absolute;top:-8px;width:3px;height:12px;margin-left:-1px;background:var(--tx);border-radius:1px}
.segbar{display:flex;gap:3px;margin-top:6px}
.seg{position:relative;height:46px;background:var(--panel2);border:1px solid var(--bd2);border-radius:4px;overflow:hidden;min-width:0}
.seg i{position:absolute;left:0;bottom:0;top:0;background:var(--c,var(--mu));opacity:.22}
.seg-l{position:absolute;left:6px;top:4px;font-size:11px;color:var(--mu);white-space:nowrap}
.seg-v{position:absolute;left:6px;bottom:3px;font-size:17px;font-weight:600}
.seg-na{background:repeating-linear-gradient(135deg,transparent 0 5px,var(--bd2) 5px 6px)}.seg-na .seg-v{font-size:12px;color:var(--mu);font-weight:500}
.hero-r{color:var(--tx)}.hero-sp{display:block;margin-top:6px}.sp-band{stroke:var(--bd);stroke-width:1;stroke-dasharray:2 3}
.sp-ref{stroke:var(--mu);stroke-width:1;stroke-dasharray:3 3;opacity:.7}
.gauges{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin-top:8px}
.gauge{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:8px 12px;min-width:0}
.g-h{display:flex;align-items:center;gap:8px}.g-l{font-weight:650;font-size:13px}.g-s{font-size:11.5px;color:var(--mu);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.g-v{display:flex;align-items:baseline;gap:6px;margin-top:2px}.g-n{font-size:24px;font-weight:600;letter-spacing:-.02em}.g-u{font-size:12px;color:var(--mu)}
.state{margin-left:auto;font-size:12px;font-weight:650;padding:1px 9px;border-radius:999px;background:var(--msb);color:var(--ms)}
.s-pos{background:var(--okb);color:var(--ok)}.s-neg{background:var(--erb);color:var(--er)}
.g-track{position:relative;height:4px;background:var(--bd2);border-radius:2px;margin:6px 0 4px}
.g-track b{position:absolute;top:-3px;width:1px;height:10px;background:var(--mu)}
.g-track i{position:absolute;top:-4px;width:8px;height:12px;margin-left:-4px;border-radius:2px;background:var(--tx)}
.gauge .spark{color:var(--mu);width:100%}
.inter{display:grid;grid-template-columns:minmax(0,auto) minmax(260px,1fr);gap:12px 24px;align-items:start}
.hm-wrap{overflow-x:auto;max-width:100%}
.hmt{border-collapse:separate;border-spacing:3px;font-size:12px}
.hmt th{font-weight:600;color:var(--mu);text-align:left;white-space:nowrap;padding:0 6px 0 0}.hmt thead th{text-align:center;padding:0 0 2px}
.hmt thead th.hm-c{text-align:left;vertical-align:bottom;font-weight:500;font-size:11px}.hmt thead th small{display:block;font-weight:400;font-size:10.5px}.hmt tbody th small{font-weight:400;font-size:10.5px;color:var(--mu)}
.hmt tbody th{color:var(--tx);font-weight:500}.hmt td{padding:0}
.hm{font:inherit;font-size:12px;font-variant-numeric:tabular-nums;width:76px;height:30px;border:1px solid transparent;border-radius:4px;cursor:pointer;color:var(--tx)}
.hm.hp{background:rgba(var(--pr),var(--a))}.hm.hn{background:rgba(var(--nr),var(--a))}
.hm:hover{border-color:var(--tx)}.hm.on{outline:2px solid var(--ln);outline-offset:1px}
.mxs{display:flex;flex-direction:column;gap:6px}.mx{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.mx-l{font-size:12px;color:var(--mu);width:56px;flex:none}
.hmband{font-size:12.5px;background:var(--panel2);border:1px solid var(--bd);border-radius:4px;padding:4px 8px;display:flex;gap:8px;align-items:center}
.hmband[hidden]{display:none}
.nx{font-size:12px;color:var(--mu);margin:4px 0}.nx b{color:var(--tx);font-weight:600}
.pbl{font-size:12px}
.evid{list-style:none;padding:0!important;margin:4px 0!important;display:flex;flex-wrap:wrap;gap:4px 12px;font-size:12.5px}
.evid .lbl{font-size:11.5px;display:inline-block;max-width:16ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;vertical-align:bottom}.evid li{white-space:nowrap}
.also{margin-top:14px}.aws{display:flex;flex-wrap:wrap;gap:8px;margin-top:4px}
.aw{background:var(--panel);border:1px solid var(--bd);border-radius:4px;padding:6px 10px;min-width:0}
.aw-h{font-size:12px;font-weight:600;margin-bottom:2px}
.aw-i{display:inline-flex;align-items:center;gap:5px;margin-right:14px;font-size:12.5px;white-space:nowrap}.aw-l{color:var(--mu);font-size:11.5px;display:inline-block;max-width:22ch;overflow:hidden;text-overflow:ellipsis}
.spark.mini{display:inline-block;color:var(--mu);vertical-align:middle}
.ab{display:inline-flex;align-items:center;gap:5px}.ab-bar{display:inline-flex;width:64px;height:8px;border-radius:2px;overflow:hidden;background:var(--bd2)}
.ab-w .ab-bar{width:220px;height:12px}
.ab-f{background:var(--mu);opacity:.55}.ab-s.p{background:var(--up)}.ab-s.n{background:var(--dn)}.ab small{color:var(--mu);font-size:11px}
.cact{display:block;width:max-content;margin-top:2px;font-size:10px}
details.pbw{margin-top:22px;border-top:1px solid var(--bd);padding-top:6px}
details.pbw>summary{cursor:pointer;list-style:none;display:flex;align-items:baseline;gap:10px;padding:4px 0}
details.pbw>summary::-webkit-details-marker{display:none}details.pbw>summary::before{content:"\25B8";color:var(--mu);font-size:11px}
details.pbw[open]>summary::before{content:"\25BE"}
details.notes{font-size:12px;color:var(--mu);margin-top:6px}details.notes summary{cursor:pointer}
::selection{background:rgba(15,98,254,.22)}
:focus-visible{outline:2px solid var(--ln);outline-offset:1px}
@media (max-width:900px){.hero{grid-template-columns:1fr 1fr}.hero-m{grid-column:1/-1;grid-row:2}.inter{grid-template-columns:1fr}}
@media (max-width:640px){.mgs{grid-template-columns:1fr}.mtab td.mp,.mtab td.msp{display:none}.mtab th{font-size:12px}.hero{grid-template-columns:1fr;padding:12px;gap:12px}.hero-m{grid-row:auto}.hero-n{font-size:44px}.hero-sp{width:100%}.gauges{grid-template-columns:repeat(3,minmax(0,1fr));gap:6px}.gauge{padding:6px 7px}.g-n{font-size:18px}.g-u{display:none}.g-v{flex-wrap:wrap}.state{margin-left:0;font-size:11px;padding:0 6px}.gauge .info{display:none}.hm{width:46px;height:28px;font-size:10.5px}.hmt{border-spacing:2px;font-size:11px}.hmt tbody th small{display:none}.seg-l{font-size:10px;left:4px;right:2px;overflow:hidden;text-overflow:ellipsis}.seg-v{left:4px;font-size:15px}.aw-i{white-space:normal;flex-wrap:wrap}.evid .lbl{max-width:13ch}.mx-l{width:100%}header.top{margin:0 -10px;padding:10px 10px 6px}.g-s{display:none}.aw-i{margin-right:8px}.wrap{padding:0 10px 40px}h1{font-size:16px}.insgrid,.pbgrid,.meth{grid-template-columns:1fr}
.mg{width:100%}.mcgrid,.ctxgrid{grid-template-columns:repeat(2,minmax(0,1fr))}.evgrid{grid-template-columns:repeat(2,minmax(0,1fr))}
.big{font-size:17px}.twrap{max-height:70vh}.srcs{columns:1}#drawer{padding:12px}
table.mini.fields td.prov,table.mini.fields th:nth-child(4){display:none}
.tt .sect{display:none}.tkcell{max-width:120px}.nm{max-width:105px}.tt th,.tt td{padding:4px 6px}}
@media print{#drawer,#dimmer,.tctl,#theme{display:none}.twrap{max-height:none;overflow:visible}}
"""

JS = r"""
(function(){
var d=document,root=d.documentElement;
try{var th=localStorage.getItem('so-theme');if(th)root.setAttribute('data-theme',th);}catch(e){}
var tb=d.getElementById('theme');
if(tb)tb.addEventListener('click',function(){
 var cur=root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');
 var nx=cur==='dark'?'light':'dark';root.setAttribute('data-theme',nx);try{localStorage.setItem('so-theme',nx);}catch(e){}});
function pad(n){return n<10?'0'+n:''+n}
function localText(t){try{return 'local '+t.toLocaleString([], {weekday:'short',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'});}catch(e){return ''}}
function cd(ms){var a=Math.abs(ms),m=Math.round(a/60000),h=Math.floor(m/60),dd=Math.floor(h/24),s;
 if(dd>=1)s=dd+'d '+(h%24)+'h';else if(h>=1)s=h+'h '+(m%60)+'m';else s=m+'m';return ms>=0?'in '+s:s+' ago'}
function tick(){var now=Date.now();
 d.querySelectorAll('.lt[data-ts]').forEach(function(el){if(!el.textContent){var t=new Date(el.getAttribute('data-ts'));if(!isNaN(t))el.textContent=localText(t);}});
 d.querySelectorAll('.cd[data-ts]').forEach(function(el){var t=new Date(el.getAttribute('data-ts'));if(!isNaN(t))el.textContent=cd(t-now);});}
tick();setInterval(tick,60000);
// phones: macro groups start collapsed (summary keeps the trend label visible)
if(window.matchMedia&&matchMedia('(max-width:640px)').matches){d.querySelectorAll('details.mg').forEach(function(x){x.removeAttribute('open')});}
// table
var tt=d.getElementById('tt');
if(tt){
 var tbd=tt.tBodies[0],rows=[].slice.call(tbd.rows),qf='all',q='',sec='';
 var cnt=d.getElementById('tcount'),hb=d.getElementById('hmband');
 function apply(){var n=0;rows.forEach(function(r){var ok=(!q||r.getAttribute('data-q').indexOf(q)>=0)&&(!sec||r.getAttribute('data-sec')===sec)&&(qf==='all'||(' '+r.getAttribute('data-f')+' ').indexOf(' '+qf+' ')>=0);
  r.style.display=ok?'':'none';if(ok)n++;});if(cnt)cnt.textContent=n;}
 var qi=d.getElementById('tq');if(qi)qi.addEventListener('input',function(){q=qi.value.trim().toLowerCase();apply();});
 d.querySelectorAll('.qf').forEach(function(b){b.addEventListener('click',function(){d.querySelectorAll('.qf').forEach(function(x){x.classList.remove('on')});b.classList.add('on');qf=b.getAttribute('data-qf');apply();});});
 var wrap=d.getElementById('twrap');
 d.querySelectorAll('.tgs input').forEach(function(c){c.addEventListener('change',function(){wrap.classList.toggle('hide-'+c.getAttribute('data-g'),!c.checked);});});
 var ths=[].slice.call(tt.tHead.rows[0].cells);
 ths.forEach(function(th,i){th.addEventListener('click',function(){
  var dir=th.classList.contains('desc')?1:-1;if(!th.classList.contains('asc')&&!th.classList.contains('desc'))dir=th.getAttribute('data-type')==='s'?1:-1;
  ths.forEach(function(x){x.classList.remove('asc','desc')});th.classList.add(dir>0?'asc':'desc');
  var num=th.getAttribute('data-type')==='n';
  rows.sort(function(a,b){var va=a.cells[i].getAttribute('data-v'),vb=b.cells[i].getAttribute('data-v');
   var ea=va===null||va==='',eb=vb===null||vb==='';if(ea&&eb)return 0;if(ea)return 1;if(eb)return -1;
   if(num){va=parseFloat(va);vb=parseFloat(vb);return (va-vb)*dir;}return va.localeCompare(vb)*dir;});
  rows.forEach(function(r){tbd.appendChild(r)});});});
 // heatmap cell -> filter table to that sector, sort by that factor's coefficient (strongest in the cell's direction first)
 function clearSec(){sec='';d.querySelectorAll('.hm.on').forEach(function(x){x.classList.remove('on')});if(hb)hb.hidden=true;apply();}
 d.querySelectorAll('.hm[data-sec]').forEach(function(b){b.addEventListener('click',function(){
  if(b.classList.contains('on')){clearSec();return;}
  d.querySelectorAll('.hm.on').forEach(function(x){x.classList.remove('on')});b.classList.add('on');
  sec=b.getAttribute('data-sec');var f=b.getAttribute('data-f'),dir=parseInt(b.getAttribute('data-dir'),10)||1,k='data-c-'+f;
  ths.forEach(function(x){x.classList.remove('asc','desc')});
  rows.sort(function(a,c){var va=a.getAttribute(k),vc=c.getAttribute(k);if(va===null&&vc===null)return 0;if(va===null)return 1;if(vc===null)return -1;
   return (parseFloat(vc)-parseFloat(va))*dir;});
  rows.forEach(function(r){tbd.appendChild(r)});
  if(hb){hb.hidden=false;hb.querySelector('b').textContent=sec+' · sorted by '+b.getAttribute('data-lbl')+' β '+(dir>0?'high→low':'low→high');}
  apply();var tb=d.getElementById('table');if(tb)tb.scrollIntoView({behavior:'smooth',block:'start'});});});
 var hbx=d.getElementById('hmclear');if(hbx)hbx.addEventListener('click',clearSec);
 tbd.addEventListener('click',function(e){if(e.target.closest('a'))return;var r=e.target.closest('tr');if(r)openT(r.getAttribute('data-t'));});
}
// drawer
var dr=d.getElementById('drawer'),dm=d.getElementById('dimmer'),body=d.getElementById('drbody');
function openT(t){if(!dr)return;var tp=d.getElementById('dr-'+t);body.innerHTML='';
 if(tp)body.appendChild(tp.content.cloneNode(true));
 else{var p=d.createElement('p');p.textContent=t+': no equities record in this build, so no detail is available.';body.appendChild(p);}
 dr.classList.add('open');dm.classList.add('open');dr.scrollTop=0;tick();
 rowsSel(t);try{history.replaceState(null,'','#t-'+t);}catch(e){}
 var cb=d.getElementById('drclose');if(cb)cb.focus();}
function rowsSel(t){d.querySelectorAll('.tt tr.sel').forEach(function(r){r.classList.remove('sel')});if(t){var r=d.querySelector('.tt tr[data-t="'+t+'"]');if(r)r.classList.add('sel');}}
function closeT(){if(!dr)return;dr.classList.remove('open');dm.classList.remove('open');rowsSel(null);try{history.replaceState(null,'',location.pathname);}catch(e){}}
d.addEventListener('click',function(e){var b=e.target.closest('.tk');if(b){openT(b.getAttribute('data-t'));return;}
 if(e.target.closest('.close-dr'))closeT();});
if(dm)dm.addEventListener('click',closeT);
var cbt=d.getElementById('drclose');if(cbt)cbt.addEventListener('click',closeT);
d.addEventListener('keydown',function(e){if(e.key==='Escape')closeT();});
d.addEventListener('click',function(e){var a=e.target.closest('a[href^="#pb-"]');if(a){var pw=d.getElementById('playbook');if(pw)pw.open=true;}});
if(location.hash.indexOf('#t-')===0)openT(decodeURIComponent(location.hash.slice(3)));
})();
"""
