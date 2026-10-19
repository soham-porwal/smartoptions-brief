/* Automatic developing-situation layer. Reads the published data/situation.json (situation.v1, written by the
   scheduled news job) and turns it into at most two ranked developments for Today. Pure model + one small
   foreground controller. Completed-session math is never recomputed here; this only compares newer, independently
   dated observations with their own named comparison bases. Thresholds are materiality rules for what to show,
   not forecasts. No price causality is assigned to a headline, and no direction is predicted. */
'use strict';
(function (root, factory) {
  const api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SmartOptionsSituation = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
  const isNum = v => typeof v === 'number' && isFinite(v);
  const HOUR = 36e5;
  // One versioned rule table. Tested at the boundaries in app/test/situation.test.js.
  const CONFIG = Object.freeze({
    version: 'situation-rules-1',
    max_today: 2,
    observation_max_age_h: 96,       // older observations can be shown as retained, never trigger
    report_max_age_h: 36,            // reports older than this are context, not developments
    artifact_stale_h: 2,             // two missed scheduled runs (best effort twice hourly)
    rules: Object.freeze({
      index_futures: {kinds: ['index_future'], pct: 0.75},
      commodity: {kinds: ['commodity_future'], pct: 2},
      dollar: {kinds: ['currency_index'], pct: 2},
      volatility: {kinds: ['volatility_index'], points: 2, pct: 10},
      breadth: {pp: 5, coverage: 0.9},
      event_24h: {hours: 24, importance: 3}
    })
  });
  const RULE_OF = {index_future: 'index_futures', commodity_future: 'commodity', currency_index: 'dollar', volatility_index: 'volatility'};
  const pct = (v, d = 2) => isNum(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%' : 'n/a';
  const etHour = ms => +new Date(ms).toLocaleString('en-US', {timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23'});
  const isFuture = k => /_future$/.test(k || '');
  const etDate = ms => new Date(ms).toLocaleDateString('en-CA', {timeZone: 'America/New_York'});
  const weekday = iso => { const d = new Date(String(iso) + 'T12:00:00Z'); return isFinite(d) ? d.toLocaleDateString('en-US', {weekday: 'long', timeZone: 'UTC'}) : String(iso); };
  const clock = iso => { const t = Date.parse(iso); return isFinite(t) ? new Date(t).toLocaleString('en-US', {timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}) + ' ET' : 'time unavailable'; };
  function hash(s) { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36); }

  // Validate one observation. Returns a reason string when it cannot be compared.
  function checkObservation(o, nowMs) {
    if (!o || typeof o.symbol !== 'string' || !RULE_OF[o.kind]) return 'unsupported reference';
    if (!isNum(o.value) || !(o.value > 0)) return 'no usable value';
    const at = Date.parse(o.observed_at);
    if (!isFinite(at)) return 'no observation time';
    if (at > nowMs + 10 * 60e3) return 'observation time in the future';
    const c = o.comparison;
    if (!c || !isNum(c.value) || !(c.value > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')) || !c.basis) return 'no validated comparison';
    if (c.basis === 'chart_previous_close') return 'range baseline is not a prior daily close';
    // Futures roll to the next trade date after 18:00 ET, so a same-day completed bar is valid only for futures.
    if (c.date > etDate(at) || (c.date === etDate(at) && !(isFuture(o.kind) && etHour(at) >= 18))) return 'comparison is not earlier than the observation';
    return null;
  }
  // Measured change of a newer observation versus its named comparison.
  function measure(o, baselineSession, nowMs) {
    const reason = checkObservation(o, nowMs), at = Date.parse(o && o.observed_at);
    if (reason) return {symbol: o && o.symbol, label: o && o.label, valid: false, reason};
    const change = o.value - o.comparison.value, p = 100 * (o.value / o.comparison.value - 1), ageH = (nowMs - at) / HOUR;
    // "Newer" = observed on a calendar day (New York) after the completed equity session the brief describes.
    // Futures reopen at 18:00 ET: an evening read on the baseline's own date is already after the completed cash session.
    const newer = !!baselineSession && (etDate(at) > baselineSession || (isFuture(o.kind) && etDate(at) === baselineSession && etHour(at) >= 18));
    return {symbol: o.symbol, label: o.label || o.symbol, kind: o.kind, unit: o.unit, value: o.value, observed_at: o.observed_at, retrieved_at: o.retrieved_at,
      comparison: o.comparison, change, pct: p, ageH, newer, expired: ageH > CONFIG.observation_max_age_h, carried: !!o.carried, source_url: o.source_url, session: o.session || null, valid: true};
  }
  function ruleHit(m) {
    const r = CONFIG.rules[RULE_OF[m.kind]];
    if (m.kind === 'volatility_index') { const s = Math.max(Math.abs(m.change) / r.points, Math.abs(m.pct) / r.pct); return {rule: 'volatility', threshold: `≥${r.points} points or ≥${r.pct}%`, strength: s, hit: s >= 1}; }
    const s = Math.abs(m.pct) / r.pct; return {rule: RULE_OF[m.kind], threshold: `≥${r.pct}%`, strength: s, hit: s >= 1};
  }
  const SHORT = {'ES=F': 'S&P 500 futures', 'NQ=F': 'Nasdaq-100 futures', 'CL=F': 'Oil (WTI)', 'GC=F': 'Gold', 'DX-Y.NYB': 'Dollar index', '^VIX': 'VIX'};
  const shortDay = iso => { const d = new Date(String(iso) + 'T12:00:00Z'); return isFinite(d) ? d.toLocaleDateString('en-US', {month: 'short', day: 'numeric', timeZone: 'UTC'}) : String(iso); };
  // Compact fact for Today; the full value/clock/basis line stays in evidence.
  const briefMove = m => `${SHORT[m.symbol] || m.label} ${m.kind === 'volatility_index' ? (m.change >= 0 ? '+' : '−') + Math.abs(m.change).toFixed(1) + ' pts' : pct(m.pct, 1)} vs ${shortDay(m.comparison.date)} close`;
  const describeMove = m => `${m.label} ${m.kind === 'volatility_index' ? (m.change >= 0 ? 'up ' : 'down ') + Math.abs(m.change).toFixed(2) + ' points' : pct(m.pct)} vs the ${m.comparison.date} daily close (${m.value} at ${clock(m.observed_at)})`;

  // baseline: {session, spy_1d (completed-session %), posture}; snapshot: situation.v1; opts: {exposure(kind), entered:[], events:[]}
  function situationModel(baseline, snapshot, now, opts = {}) {
    const nowMs = isNum(now) ? now : Date.parse(now), b = baseline || {};
    if (!snapshot || snapshot.schema !== 'situation.v1') return {state: 'unavailable', reason: 'Current developments could not be checked.', developments: [], measures: [], reports: []};
    const gen = Date.parse(snapshot.generated_at);
    if (!isFinite(gen) || gen > nowMs + 10 * 60e3) return {state: 'unavailable', reason: 'Current developments could not be checked: the situation file has no valid time.', developments: [], measures: [], reports: []};
    const stale = (nowMs - gen) / HOUR > CONFIG.artifact_stale_h;
    // Market-source health is separate from artifact freshness: a new file built from failed reads is degraded, not current.
    const mh = snapshot.market_health || {}, msrc = (snapshot.sources || {}).market_references || {};
    const marketStatus = mh.status || msrc.status || 'unknown', newsStatus = snapshot.sources?.news_selection?.status || 'unknown';
    const degraded = ['failed', 'partial'].includes(marketStatus) || ['failed', 'budget_busy', 'not_configured', 'suspect'].includes(newsStatus);
    // A newer snapshot may reference an older dated baseline, never a newer one than the reading it is joined to.
    const joinNote = snapshot.baseline_session && b.session && snapshot.baseline_session !== b.session
      ? `Situation file compares against the ${snapshot.baseline_session} session; Today reads ${b.session}.` : null;
    if (snapshot.baseline_session && b.session && snapshot.baseline_session > b.session) return {state: 'unavailable', reason: 'The situation baseline is newer than this completed-session reading.', developments: [], top: [], measures: [], reports: [], retainedOld: [], joinNote};
    const measures = (snapshot.observations || []).map(o => measure(o, b.session, nowMs));
    const devs = [];
    for (const m of measures) {
      if (!m.valid || !m.newer || m.expired || m.carried) continue;   // retained last-good values are shown, never re-triggered
      const h = ruleHit(m); if (!h.hit) continue;
      const up = m.pct > 0, base = isNum(b.spy_1d) ? b.spy_1d : null, day = weekday(m.comparison.date);
      let interp, next, exposureKind = null;
      if (m.kind === 'index_future') {
        const differs = base != null && Math.sign(base) !== Math.sign(m.pct) && Math.abs(base) >= 0.25;
        interp = differs ? `Differs from ${day}'s ${base < 0 ? 'weakness' : 'strength'}; check the cash open before calling it a reversal.`
          : base != null ? `Extends ${day}'s ${base < 0 ? 'weakness' : 'strength'}; check the cash open before calling it a continuation.`
          : 'Moved after the last session; check the cash open before reading it into stocks.';
        next = 'Compare the first regular-session SPY quote with the ' + (b.session || 'last') + ' close.';
        exposureKind = 'equity';
      } else if (m.kind === 'commodity_future') {
        interp = /oil|crude/i.test(m.label) ? `Energy producers carry the most direct exposure; fuel users the opposite side.` : `Producers and input-cost users carry the most direct exposure.`;
        next = `Check whether ${m.label} holds the move at the next regular session and which sectors respond.`;
        exposureKind = /oil|crude/i.test(m.label) ? 'wti' : null;
      } else if (m.kind === 'currency_index') {
        interp = `Overseas-revenue translation is the main channel for US companies.`;
        next = 'Check whether the move persists into the cash session.'; exposureKind = 'dxy';
      } else {
        interp = `Expected volatility ${up ? 'rose' : 'fell'}; option premiums on held names may follow.`;
        next = 'Check whether option-implied volatility on held names moved with it.'; exposureKind = 'vix';
      }
      const fp = hash(['obs', m.symbol, m.observed_at, m.comparison.date, h.rule, CONFIG.version].join('|'));
      devs.push({id: 'obs:' + m.symbol, kind: 'measured', rule: h.rule, threshold: h.threshold, strength: h.strength, fingerprint: fp,
        measured: describeMove(m), brief: briefMove(m), reported: null, interpretation: interp, next_check: next, exposure: opts.exposure ? opts.exposure(exposureKind) : null,
        inputs: [m], at: Date.parse(m.observed_at), carried: m.carried});
    }
    // Scheduled high-importance event inside 24 hours (existing calendar inputs only).
    for (const e of opts.events || []) {
      const t = Date.parse(e.when), r = CONFIG.rules.event_24h;
      if (!isFinite(t) || t < nowMs || t - nowMs > r.hours * HOUR || !(e.importance >= r.importance || e.major)) continue;
      devs.push({id: 'event:' + e.title, kind: 'event', rule: 'event_24h', threshold: '≤24 hours', strength: 1, fingerprint: hash(['ev', e.title, e.when].join('|')),
        measured: null, reported: `${e.title} · ${clock(e.when)}`, interpretation: 'A scheduled release inside 24 hours can reset rate and growth expectations.', next_check: 'Check positions with event exposure before the release.', inputs: [], at: t});
    }
    // Reported developments: open topics selected by the producer. Quality comes from provenance, never model confidence.
    const reports = (snapshot.reports || []).filter(r => r && /^https:\/\//.test(r.url || '') && r.headline && isFinite(Date.parse(r.published_at)) && Date.parse(r.published_at) <= nowMs + 10 * 60e3)
      .map(r => ({...r, ageH: (nowMs - Date.parse(r.published_at)) / HOUR}));
    const material = reports.filter(r => r.material && r.ageH <= CONFIG.report_max_age_h);
    const topics = new Map();
    for (const r of material) { const k = r.topic || 'Unclassified report'; if (!topics.has(k)) topics.set(k, []); topics.get(k).push(r); }
    const syn = snapshot.synthesis && snapshot.synthesis.status === 'valid' ? snapshot.synthesis : null;
    for (const [topic, rs] of topics) {
      rs.sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
      const lead = rs[0], conflict = rs.some(r => (r.conflicts || []).length), s = syn && (syn.topics || []).find(x => (x.source_ids || []).some(id => rs.some(r => r.id === id)));
      devs.push({id: 'topic:' + topic, kind: 'reported', rule: 'report', threshold: 'fresh original report', strength: 0.9 + 0.05 * Math.min(3, rs.length) - (lead.headline_only ? 0.05 : 0),
        fingerprint: hash(['rep', topic, rs.map(r => r.id).join(',')].join('|')), topic, measured: null,
        reported: `${lead.source}: ${lead.headline} · ${clock(lead.published_at)}${rs.length > 1 ? ` · ${rs.length} reports` : ''}`,
        brief: `${lead.source}: ${String(lead.headline).replace(/\s+-\s+[A-Z][\w .&]+$/, '').split(/\s+/).slice(0, 12).join(' ')}${String(lead.headline).split(/\s+/).length > 12 ? '…' : ''}`,
        interpretation: s && s.interpretation ? s.interpretation : (lead.exposure_note || 'Market impact not established; this is reported context, not a measured cause.'),
        next_check: s && s.next_check ? s.next_check : (lead.next_check || 'Check whether prices in the named sectors or assets respond at the next session.'),
        conflict, headline_only: rs.every(r => r.headline_only), reports: rs, at: Date.parse(lead.published_at), synthesized: !!s});
    }
    // Rank: valid recency, magnitude vs threshold, then source quality. Opposing moves are eligible on their own.
    devs.forEach(d => { const ageH = Math.max(0, (nowMs - d.at) / HOUR); d.score = d.strength * (d.kind === 'measured' ? 1.2 : 1) / (1 + ageH / 12) * (d.carried ? 0.5 : 1); });
    devs.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    const top = devs.slice(0, CONFIG.max_today), retainedOld = measures.filter(m => m.valid && !m.newer);
    const fingerprint = hash(top.map(d => d.fingerprint).join('|') + CONFIG.version);
    return {state: stale ? 'stale' : degraded ? 'degraded' : 'current', stale, marketStatus, newsStatus, degraded, carried: measures.filter(x => x.carried).length, generated_at: snapshot.generated_at, baseline_session: snapshot.baseline_session || null, joinNote,
      developments: devs, top, measures, retainedOld, reports, fingerprint, sources: snapshot.sources || {}, synthesis: snapshot.synthesis || null,
      implications: implications(top, b, opts), version: CONFIG.version};
  }
  // Conditional implications by objective. Only supported links; missing positions give public context, not silence.
  function implications(top, b, opts) {
    if (!top.length) return null;
    const entered = (opts.entered || []).length, fut = top.find(d => d.rule === 'index_futures'), exp = top.map(d => d.exposure).find(Boolean);
    return {
      protect: entered ? `Check your ${entered} entered equit${entered === 1 ? 'y' : 'ies'} against ${exp ? exp.text : 'the developments above'} before adding risk.` : `No positions entered. Public exposure: ${exp ? exp.text : 'see the named assets and sectors above'}.`,
      income: 'Not rated - contract pricing unavailable. Avoid selling premium across a listed event until the cash session confirms the move.',
      growth: fut ? 'Candidates still need their own setup and valuation; let the cash open confirm before acting on the futures move.' : 'Candidates still need their own setup, valuation and event check.',
      watch: top[0].next_check
    };
  }

  // Foreground controller: automatic load on Today, on visibility return and every five minutes while visible.
  // Fetching the file never renews observation dates; a failed check keeps the last good model and says so.
  // liveUrl: the Worker's coalesced on-demand recovery, asked ONLY when every static file is older than liveAfterMs.
  function controller({fetchImpl, urls = ['data/situation.json'], liveUrl = null, liveAfterMs = 40 * 60e3, onChange, intervalMs = 5 * 60e3, nowFn = Date.now} = {}) {
    let last = null, lastCheck = null, failures = 0, timer = null, stopped = true, inflight = null;
    const f = fetchImpl || (root.fetch ? root.fetch.bind(root) : null);
    function usable(d, now) {
      const g = Date.parse(d && d.generated_at);
      if (!d || d.schema !== 'situation.v1' || !isFinite(g)) throw Error('invalid situation file');
      if (g > now + 10 * 60e3) throw Error('situation file dated in the future');
      if (!Array.isArray(d.observations) || !Array.isArray(d.reports) || d.observations.some(o => !o || typeof o !== 'object') || d.reports.some(r => !r || typeof r !== 'object')) throw Error('malformed situation file');
      if (d.observations.length > 6 || d.reports.length > 8 || d.observations.some(o => checkObservation(o, now))) throw Error('invalid situation observations');
      if (d.baseline_session != null && !/^\d{4}-\d{2}-\d{2}$/.test(d.baseline_session)) throw Error('invalid situation baseline');
      if (d.reports.some(r => typeof r.headline !== 'string' || typeof r.source !== 'string' || typeof r.id !== 'string' || !/^https:\/\//.test(r.url || '') || !isFinite(Date.parse(r.published_at)) || Date.parse(r.published_at) > now + 600e3 || (r.conflicts != null && !Array.isArray(r.conflicts)))) throw Error('invalid situation reports');
      if (d.synthesis?.status === 'valid' && (!Array.isArray(d.synthesis.topics) || d.synthesis.topics.some(t => !t || typeof t.interpretation !== 'string' || typeof t.next_check !== 'string' || !Array.isArray(t.source_ids)))) throw Error('invalid situation synthesis');
      return d;
    }
    async function one(u) { const r = await f(u, {cache: 'no-cache', credentials: 'omit', signal: AbortSignal.timeout(20000)}); if (!r.ok) throw Error('HTTP ' + r.status); return usable(await r.json(), nowFn()); }
    async function check() {
      if (inflight) return inflight;
      inflight = (async () => {
        const got = await Promise.allSettled(urls.map(one)), ok = got.filter(x => x.status === 'fulfilled').map(x => x.value);
        // A recent live cache must not suppress further five-minute recovery checks while the canonical producer lags.
        const newestStatic = Math.max(-Infinity, ...ok.map(d => Date.parse(d.generated_at)));
        let recovery = 'not_needed';
        if (liveUrl && nowFn() - newestStatic > liveAfterMs) {
          const live = await Promise.allSettled([one(liveUrl)]);
          if (live[0].status === 'fulfilled') { ok.push(live[0].value); recovery = 'ok'; }
          else { got.push(live[0]); recovery = 'failed'; }
        }
        lastCheck = {at: new Date(nowFn()).toISOString(), ok: ok.length > 0 && recovery !== 'failed', recovery, errors: got.filter(x => x.status === 'rejected').map(x => String(x.reason && x.reason.message || x.reason))};
        if (ok.length) {
          failures = recovery === 'failed' ? failures + 1 : 0;
          // Newer valid file wins (client mirror can lag the canonical producer); never move backward.
          const best = ok.sort((a, b) => Date.parse(b.generated_at) - Date.parse(a.generated_at))[0];
          if (!last || Date.parse(best.generated_at) > Date.parse(last.generated_at)) { last = best; onChange && onChange(last, lastCheck); }
          else onChange && onChange(last, lastCheck, true);
        } else { failures++; onChange && onChange(last, lastCheck, true); }
      })().finally(() => { inflight = null; });
      return inflight;
    }
    function schedule() { clearTimeout(timer); if (stopped) return; const wait = failures ? Math.min(intervalMs, 30e3 * 2 ** Math.min(4, failures - 1)) : intervalMs; timer = setTimeout(() => { if (root.document && root.document.hidden) { schedule(); return; } check().finally(schedule); }, wait); }
    const onVis = () => { if (!stopped && root.document && !root.document.hidden) check().finally(schedule); };
    return {
      start() { if (!stopped) return; stopped = false; root.document && root.document.addEventListener('visibilitychange', onVis); check().finally(schedule); },
      stop() { stopped = true; clearTimeout(timer); root.document && root.document.removeEventListener('visibilitychange', onVis); },
      check, get: () => last, lastCheck: () => lastCheck, failures: () => failures, active: () => !stopped
    };
  }
  return {SHORT, briefMove, CONFIG, situationModel, measure, checkObservation, implications, controller, etDate, weekday, clock, hash};
});
