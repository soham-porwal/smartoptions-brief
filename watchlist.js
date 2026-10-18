/* Shared saved-companies store. Same key and format as the expanded edition (overview.js): a JSON array of
   upper-case tickers under so_watchlist_v1. Unreadable stored text is reported and never overwritten silently. */
(function (root) {
  'use strict';
  const KEY = 'so_watchlist_v1';
  const normalize = xs => [...new Set((Array.isArray(xs) ? xs : []).map(x => String(x).trim().toUpperCase()).filter(x => /^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(x)))];
  function inspect(storage) {
    let raw;
    try { raw = storage.getItem(KEY); } catch (e) { return {ok: false, state: 'unavailable', error: 'Device storage is unavailable; saved companies last only for this tab.'}; }
    if (raw === null) return {ok: true, state: 'empty', list: [], raw:null};
    try { const v = JSON.parse(raw); if (!Array.isArray(v)) throw new Error('not a list'); return {ok: true, state: 'ok', list: normalize(v), raw}; }
    catch (e) { return {ok: false, state: 'malformed', raw, error: 'Saved companies on this device could not be read (' + e.message + '). They are kept unchanged until you choose to replace them.'}; }
  }
  function create(storage, notify) {
    let memory = null, blocked = false, warning='';
    const first = inspect(storage);
    let baseline=first.raw;
    if (first.state === 'malformed') blocked = true;
    const get = () => memory ? memory.slice() : (first.ok ? inspect(storage).list || [] : []);
    function set(xs) {
      const next=normalize(xs);
      try {if(!blocked && storage.getItem(KEY)!==baseline){warning='Another tab changed saved companies. Reload the latest list before saving.';if(notify)notify(warning);return get();}}catch(e){warning='Device storage unavailable; changes last only in this tab.';}
      memory = next;
      if (blocked) { if (notify) notify('Saved for this tab only: the unreadable saved list was kept.'); return get(); }
      try { const raw=JSON.stringify(memory);storage.setItem(KEY,raw);if(storage.getItem(KEY)!==raw)throw Error('readback');baseline=raw;warning='';if (notify) notify(''); }
      catch (e) { warning='Could not save on this device; the change lasts for this tab.';if (notify) notify(warning); }
      return get();
    }
    return {KEY, get, set, add: xs => set(get().concat(Array.isArray(xs) ? xs : [xs])), remove: t => set(get().filter(x => x !== String(t).toUpperCase())),
      has: t => get().includes(String(t).toUpperCase()), status: () => warning?{ok:false,state:'unsaved',error:warning}:blocked ? first : inspect(storage),
      reload(){memory=null;warning='';const latest=inspect(storage);baseline=latest.raw;blocked=latest.state==='malformed';return latest.list||[];},
      replaceUnreadable() { baseline=inspect(storage).raw;blocked = false; return set(memory || []); }};
  }
  const API = {KEY, normalize, inspect, create};
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.SmartOptionsWatchlistStore = API;
})(typeof window !== 'undefined' ? window : globalThis);
