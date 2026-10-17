/* Shared saved-companies store. Same key and format as the expanded edition (overview.js): a JSON array of
   upper-case tickers under so_watchlist_v1. Unreadable stored text is reported and never overwritten silently. */
(function (root) {
  'use strict';
  const KEY = 'so_watchlist_v1';
  const normalize = xs => [...new Set((Array.isArray(xs) ? xs : []).map(x => String(x).trim().toUpperCase()).filter(x => /^[A-Z0-9][A-Z0-9.^-]{0,14}$/.test(x)))];
  function inspect(storage) {
    let raw;
    try { raw = storage.getItem(KEY); } catch (e) { return {ok: false, state: 'unavailable', error: 'Device storage is unavailable; saved companies last only for this tab.'}; }
    if (raw === null) return {ok: true, state: 'empty', list: []};
    try { const v = JSON.parse(raw); if (!Array.isArray(v)) throw new Error('not a list'); return {ok: true, state: 'ok', list: normalize(v)}; }
    catch (e) { return {ok: false, state: 'malformed', raw, error: 'Saved companies on this device could not be read (' + e.message + '). They are kept unchanged until you choose to replace them.'}; }
  }
  function create(storage, notify) {
    let memory = null, blocked = false;
    const first = inspect(storage);
    if (first.state === 'malformed') blocked = true;
    const get = () => memory ? memory.slice() : (first.ok ? inspect(storage).list || [] : []);
    function set(xs) {
      memory = normalize(xs);
      if (blocked) { if (notify) notify('Saved for this tab only: the unreadable saved list was kept.'); return get(); }
      try { storage.setItem(KEY, JSON.stringify(memory)); if (notify) notify(''); }
      catch (e) { if (notify) notify('Could not save on this device; the change lasts for this tab.'); }
      return get();
    }
    return {KEY, get, set, add: xs => set(get().concat(Array.isArray(xs) ? xs : [xs])), remove: t => set(get().filter(x => x !== String(t).toUpperCase())),
      has: t => get().includes(String(t).toUpperCase()), status: () => blocked ? first : inspect(storage),
      replaceUnreadable() { blocked = false; return set(memory || []); }};
  }
  const API = {KEY, normalize, inspect, create};
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  root.SmartOptionsWatchlistStore = API;
})(typeof window !== 'undefined' ? window : globalThis);
