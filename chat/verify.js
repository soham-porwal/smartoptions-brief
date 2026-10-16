/* Fail closed on unsupported quantities, dates, tickers and citations. Pure and deterministic. */
'use strict';
(function(root,factory){const M=factory();if(typeof module!=='undefined'&&module.exports)module.exports=M;root.SmartOptionsVerify=M;})(typeof window!=='undefined'?window:globalThis,function(){
  const STOP=new Set('I A US USD UTC ET EPS PE PEG GDP CPI PPI PCE FED FRED SEC BLS FCF IV VIX SMA RSI ETF TTM YOY QOQ CEO CFO P E OK S BPS'.split(' '));
  const MULT={k:1e3,thousand:1e3,m:1e6,million:1e6,b:1e9,bn:1e9,billion:1e9,t:1e12,tn:1e12,trillion:1e12};
  const NUM=/([-+−]?)(\$?)(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*(%|percent\b|percentage points?\b|pp\b|bps\b|basis points?\b|points?\b|x\b|times\b|trillion\b|billion\b|million\b|thousand\b|tn\b|bn\b|[kmbt]\b)?/gi;
  function quantities(s){return [...String(s).matchAll(NUM)].map(m=>({raw:m[0].trim(),value:(m[1]==='-'||m[1]==='−'?-1:1)*Number(m[3].replace(/,/g,'')+(m[4]||'')),precision:m[4]?m[4].length-1:0,unit:(m[5]||'').toLowerCase(),money:!!m[2]}));}
  function kind(q){if(q.money||MULT[q.unit])return 'money';if(/%|^percent$/.test(q.unit))return 'percent';if(/bps|basis/.test(q.unit))return 'bps';if(/points|^pp$/.test(q.unit))return 'pp';if(/x|times/.test(q.unit))return 'ratio';return '';}
  function canonical(q){const k=kind(q);return k==='money'?q.value*(MULT[q.unit]||1):k==='percent'||k==='pp'?q.value/100:k==='bps'?q.value/10000:q.value;}
  function matches(q,f){
    if(typeof f.value!=='number'||!Number.isFinite(f.value))return false;
    const u=String(f.unit||''),k=kind(q);
    const fk=u.startsWith('USD')?'money':u.startsWith('%')?'percent':u==='pp'?'pp':u==='bps'?'bps':u==='x'||u==='ratio'?'ratio':'';
    if(k&&fk!==k&&!(['ratio','percent'].includes(k)&&['ratio','percent'].includes(fk)))return false;
    if(!k&&fk&&!(q.value===f.value))return false;
    const fv=fk==='percent'||fk==='pp'?f.value/100:fk==='bps'?f.value/10000:f.value;
    const divisor=k==='percent'||k==='pp'?100:k==='bps'?10000:1;
    const scale=k==='money'?(MULT[q.unit]||1):1;
    let tolerance=(0.5*Math.pow(10,-q.precision)*scale/divisor)+1e-10;
    const displayed=quantities(f.display||'')[0];
    if(displayed){const dk=kind(displayed), ds=dk==='money'?(MULT[displayed.unit]||1):1, dd=dk==='percent'||dk==='pp'?100:dk==='bps'?10000:1;
      tolerance=Math.min(tolerance,0.5*Math.pow(10,-displayed.precision)*ds/dd+1e-10);}
    return Math.abs((k?canonical(q):q.value)-(k?fv:f.value))<=tolerance && (q.value===0||Math.sign(q.value)===Math.sign(f.value));
  }
  function sentences(s){return String(s||'').replace(/(\d)\.(\d)/g,'$1․$2').split(/(?:[.!?]\s+|\n+)/).map(x=>x.replace(/․/g,'.').trim()).filter(Boolean);}
  function check(text,facts,opts){
    opts=opts||{};const s=String(text||'').trim().replace(/\[(f\d+(?:\s*,\s*f\d+)+)\]/g,(_,ids)=>ids.split(/\s*,\s*/).map(id=>'['+id+']').join('')),reasons=[],numbers=[];facts=facts||[];
    if(!s)return {ok:false,reasons:['empty'],numbers};
    const by=new Map(facts.map(f=>[f.id,f])),cited=[...s.matchAll(/\[(f\d+)\]/g)].map(m=>m[1]);
    for(const id of cited)if(!by.has(id))reasons.push('unknown citation '+id);
    if(/\[(?!f\d+\])[^\]]*\]|https?:|www\./i.test(s))reasons.push('unsupported citation or URL');
    if(/!|```|\*\*|^#/m.test(s))reasons.push('unsupported formatting');
    if(/\b(guarantee\w*|risk.free|buy now|sell now|you should|skyrocket\w*|unlock\w*|supercharg\w*|ai.powered)\b/i.test(s))reasons.push('advice or hype');
    const sent=sentences(s);if(opts.maxSentences&&sent.length>opts.maxSentences)reasons.push('too many sentences');if(opts.maxChars&&s.length>opts.maxChars)reasons.push('too long');
    for(const line of sent){
      const refs=[...line.matchAll(/\[(f\d+)\]/g)].map(m=>m[1]);
      const evidence=opts.requireCites?refs.map(id=>by.get(id)).filter(Boolean):facts;
      if(opts.requireCites&&!refs.length)reasons.push('uncited sentence');
      let body=line.replace(/\[f\d+\]/g,'');
      body=body.replace(/\b\d{4}-(?:Q[1-4]|\d{2})(?![\d-])/g,date=>{if(!evidence.some(f=>[f.value,f.period,f.asof].some(x=>String(x||'').includes(date))))reasons.push('period not in cited facts');return '';});
      body=body.replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.+Z-]+)?\b/g,date=>{if(!evidence.some(f=>[f.value,f.period,f.asof].some(x=>String(x||'').includes(date))))reasons.push('date not in cited facts');return '';});
      body=body.replace(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?/gi,date=>{const parsed=new Date(date);if(!Number.isFinite(+parsed)||!evidence.some(f=>[f.value,f.period,f.asof].some(x=>{const d=new Date(x);return Number.isFinite(+d)&&d.getUTCMonth()===parsed.getUTCMonth()&&d.getUTCDate()===parsed.getUTCDate()&&(!/\d{4}/.test(date)||d.getUTCFullYear()===parsed.getUTCFullYear());})))reasons.push('date not in cited facts');return '';});
      const tickers=new Set(evidence.flatMap(f=>[f.ticker,...(f.tickers||[]),...((String(f.text||'').match(/\b[A-Z]{1,5}(?:-[A-Z])?\b/g))||[])]).filter(Boolean));
      body.replace(/\$?\b[A-Z]{1,5}(?:[.-][A-Z])?\b/g,w=>{const t=w.replace(/^\$/,'').replace('.','-');if(!STOP.has(t)&&!tickers.has(t))reasons.push('ticker or acronym not in cited facts: '+t);return w;});
      for(const q of quantities(body)){
        const ok=evidence.some(f=>matches(q,f)||(!kind(q)&&[f.period,f.unit,f.text].some(v=>quantities(v||'').some(a=>a.value===q.value&&a.unit===q.unit))));
        numbers.push({text:q.raw,ok});if(!ok)reasons.push('number not in cited facts: '+q.raw);
      }
      // Reject lower-case ticker mentions when they are recognizable symbols too.
      if(opts.universe)for(const w of body.match(/\$?[a-z]{3,5}\b/g)||[]){const t=w.replace(/^\$/,'').toUpperCase();if((w.startsWith('$')||opts.universe.has(t))&&!STOP.has(t)&&!['ARE','ALL','NOW','HAS','CAN','FOR','ONE','OUT','SEE','ANY','NEW','PER','WELL','COST'].includes(t)&&!tickers.has(t))reasons.push('ticker not in cited facts: '+t);}
    }
    return {ok:!reasons.length,reasons:[...new Set(reasons)],numbers,cited};
  }
  return {check,sentences,quantities,matches};
});
