/* About drawer: methods (docs/METHODS.md verbatim), Historical score definitions, sources, data health, credits. */
'use strict';
(function () {
function md(t, esc) {
  // minimal markdown: headings, bullets, pipe tables, **bold**, inline code; everything escaped first
  const out = []; let tbl = null;
  const flush = () => { if (tbl) { out.push(`<table class="hm" style="margin:4px 0;width:100%">${tbl.join('')}</table>`); tbl = null; } };
  for (const l of esc(t || '').split(/\n/)) {
    if (/^\s*\|/.test(l)) {
      if (/^\s*\|[\s|:-]+\|\s*$/.test(l)) continue;           // separator row
      const cells = l.trim().replace(/^\||\|$/g, '').split('|');
      const tag = tbl ? 'td' : 'th';
      tbl = tbl || [];
      tbl.push('<tr>' + cells.map(c => `<${tag} style="text-align:left;vertical-align:top">${c.trim()}</${tag}>`).join('') + '</tr>');
      continue;
    }
    flush();
    if (/^#{1,3} /.test(l)) out.push(`<h3>${l.replace(/^#+ /, '')}</h3>`);
    else if (/^\s*[-*] /.test(l)) out.push(`<li>${l.replace(/^\s*[-*] /, '')}</li>`);
    else if (l.trim()) out.push(`<p>${l}</p>`);
  }
  flush();
  return out.join('').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}
window.SO2_about = function (el) {
  const A = window.SO2; if (!A) return;
  const D = A.D(), e = A.esc;
  const xc = (D.crosscheck && D.crosscheck.checks) || [];
  const sd = (D.docs && D.docs.score_defs) || {};
  const st = {ok: 0, stale: 0, missing: 0, error: 0};
  for (const g in D.macro) for (const o of D.macro[g]) st[o.status] = (st[o.status] || 0) + 1;
  el.innerHTML = `<button class="x" data-close>Close</button>
    <h3>What this is</h3>
    <p>Daily macro + market fundamentals for S&amp;P 500 movers (A) and Historical SmartOptions universe (B). Session ${e(D.asof_session)}; exported ${e(D.exported_at)}. Prices delayed (Yahoo Finance via yfinance). Relationships are measured associations over ${e(D.rel.window)}, not causes; scenario numbers are historical associations, not forecasts. Education only, not advice; no orders.</p>
    <h3>Data health</h3>
    <p>Macro observations: ${st.ok} ok, ${st.stale || 0} stale, ${st.missing || 0} missing, ${st.error || 0} error. Cross-checks: ${xc.map(c => `${e(c.check)}: ${e(c.result)}`).join('; ') || 'none'}.</p>
    <p>Historical columns are his published SmartOptions snapshot of 2026-07-25, read-only. The component split in the detail pane uses his documented formula and is shown only where it reproduces his published composite.</p>
    <h3>App methods</h3>${Object.entries(D.methods || {}).map(([k, v]) => `<li><b>${e(k)}</b>: ${e(v)}</li>`).join('')}
    <h3>Mover ranking</h3><p>${e((D.movers || {}).method || '')}</p>
    ${md(D.docs && D.docs.methods_md, e)}
    <h3>Historical score definitions</h3>${Object.entries(sd).filter(([k]) => k !== '_meta').map(([k, v]) => `<li><b>${e(k)}</b>: ${e(v.plain || '')} <code>${e(v.formula || '')}</code></li>`).join('')}
    <h3>Credits</h3><p>Charts: TradingView Lightweight Charts v4.2.0, Apache-2.0 (vendor/LICENSE). Data: FRED (St. Louis Fed), U.S. Treasury, BLS, BEA, EIA, Federal Reserve, Cboe, Yahoo Finance, Wikipedia S&amp;P 500 constituents.</p>`;
  el.onclick = ev => { if (ev.target.closest('[data-close]')) el.hidden = true; };
};
})();
