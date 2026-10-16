/* Actions return receipts only after reading back the resulting dashboard state. */
'use strict';
(function (root, factory) {
  const M = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  root.SmartOptionsActions = M;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  async function execute(a, env) {
    const w = env || root, api = w.SmartOptionsAPI;
    if (!api) throw new Error('Dashboard actions are not ready.');
    if (!api.brief_action) api.brief_action = async function (x) {
      const d = w.document, wl = w.SmartOptionsWatchlist;
      const wait = async predicate => {
        for (let i=0;i<60;i++) { if (predicate()) return; await new Promise(r=>setTimeout(r,50)); }
        throw new Error('The dashboard did not confirm the requested change.');
      };
      if (x.kind === 'watch_add' || x.kind === 'watch_remove') {
        if (!wl) throw new Error('Watchlist is not ready.');
        const add = x.kind === 'watch_add', before = wl.get().includes(x.ticker);
        if (add !== before) { if (add) wl.add([x.ticker]); else wl.remove(x.ticker); }
        if (wl.get().includes(x.ticker) !== add) throw new Error('Watchlist change was not saved.');
        return {text:before === add ? x.ticker + (add ? ' is already on your watchlist.' : ' is not on your watchlist.') : (add ? 'Added ' : 'Removed ') + x.ticker + (add ? ' to your watchlist.' : ' from your watchlist.'), watch:wl.get()};
      }
      if (x.kind === 'open_ticker') {
        if (x.tab) {
          w.location.hash = '#/research/markets';
          await wait(()=>!!w.SO2_ready && typeof api.open_ticker_tab === 'function');
          await api.open_ticker_tab(x.ticker,x.tab);
          await wait(()=>{
            const det=d.querySelector('#detail'), box=det?.querySelector('.r7-box');
            return det?.dataset.r7t===x.ticker && det.querySelector('.r7-tabs .on')?.dataset.r7tab===x.tab &&
              !det.closest('[hidden]') && (x.tab==='overview'||(box&&!box.hidden&&!!box.children.length));
          });
          return {text:'Opened ' + x.ticker + ' in ' + x.tab + '.', ticker:d.querySelector('#detail').dataset.r7t, tab:d.querySelector('#detail .r7-tabs .on').dataset.r7tab};
        }
        w.location.hash = '#/company/' + encodeURIComponent(x.ticker);
        await wait(()=>w.location.hash === '#/company/' + x.ticker && d.querySelector('.co-t')?.textContent.trim() === x.ticker);
        return {text:'Opened ' + x.ticker + '.'};
      }
      if (x.kind === 'show_sector' || x.kind === 'switch_period') {
        w.location.hash = '#/brief';
        await wait(()=>!!d.querySelector('.so-hm')?.__soHm);
        const el=d.querySelector('.so-hm'), hm=el.__soHm; await hm.ready;
        if (x.kind === 'show_sector') {
          const b=[...el.querySelectorAll('.hm-secrow')].find(b=>b.dataset.sec===x.sector);
          if(!b)throw new Error('That sector is not available on the map.');
          hm.highlight('');
          if(b.getAttribute('aria-pressed')!=='true')b.click();
          await wait(()=>el.querySelector('.hm-stage')?.getAttribute('aria-label')===x.sector+' heatmap' && el.querySelectorAll('.hm-tile').length>0);
          return {text:'Highlighted ' + x.sector + ' on the map.', sector:el.querySelector('.hm-ztitle').textContent, tiles:el.querySelectorAll('.hm-tile').length};
        }
        if (!['1D','1W','1M'].includes(x.period)) throw new Error('Unsupported map period.');
        const control=[...d.querySelectorAll('#h-pos + * [data-period], .b-seg [data-period]')].find(b=>b.dataset.period===x.period);
        if(control)control.click();else hm.setPeriod(x.period);
        if (el.querySelector('.hm-seg [aria-pressed="true"]')?.dataset.p !== x.period) throw new Error('Map period was not confirmed.');
        if(control && control.getAttribute('aria-pressed')!=='true')throw new Error('Visible period control was not confirmed.');
        return {text:'Map now shows ' + x.period + '.'};
      }
      if (x.kind === 'expand_macro') {
        w.location.hash = '#/macro'; await wait(()=>!!d.querySelector('#h-obs'));
        return {text:'Opened detailed macro observations.'};
      }
      if (x.kind === 'sort_filter') {
        if (x.sort && !['pe','price','change','mcap','rating'].includes(x.sort)) throw new Error('That sort is not available in the research table.');
        w.location.hash = '#/research/markets';
        await wait(()=>!!w.SO2_ready);
        const result=api.set_filters({reset:true, ...(x.sector ? {sector:x.sector} : {})});
        if (result.unsupported?.length || (x.sector && result.applied?.sector !== x.sector)) throw new Error('The sector filter was not applied.');
        if (x.sort) {
          const key={price:'px',change:'d1',pe:'pef',mcap:'mcap',rating:'rating'}[x.sort], so=w.SO2;
          if (!so || !so.V || !so.renderTable) throw new Error('Table sorting is not ready.');
          so.V.sort={k:key,dir:x.sort==='pe' ? 1 : -1}; so.renderTable();
          if (so.V.sort.k !== key) throw new Error('Table sort was not confirmed.');
        }
        return {text:'Research table updated' + (x.sector ? ' to ' + x.sector : '') + (x.sort ? ', sorted by ' + x.sort : '') + '.', receipt:result};
      }
      throw new Error('This dashboard action is not available.');
    };
    return api.brief_action(a);
  }
  return {execute};
});
