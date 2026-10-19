/* Presentation seam for Today. Inputs belong to the existing market, history and
 * private-book services. No acquisition, storage, model calls or routing here. */
(function(root){
  'use strict';
  const num=x=>typeof x==='number'&&Number.isFinite(x);
  const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const pct=x=>num(x)?(x>0?'+':x<0?'−':'')+Math.abs(x).toFixed(2)+'%':'—';
  function trend(brief){
    const ms=brief?.macro?.price_trend?.metrics||[],get=re=>ms.find(m=>re.test(m.label)&&num(m.value));
    const close=get(/^SPY close$/),ma50=get(/50-session average/),ma200=get(/200-session average/);
    const levels=[ma50,ma200].filter(Boolean).map(m=>({name:/50-session/.test(m.label)?'50-session average':'200-session average',value:m.value,date:m.period,source:m.source}));
    return {levels,positive:[ma50&&`SPY ${close&&close.value<ma50.value?'reclaims and holds':'holds'} above its 50-session average ($${ma50.value.toFixed(2)}).`,'Participation broadens alongside price; credit risk eases.'].filter(Boolean),
      negative:[ma200&&`SPY loses its 200-session average ($${ma200.value.toFixed(2)}).`,'Participation weakens while credit or volatility risk rises.'].filter(Boolean),
      summary:close&&ma50&&ma200?`SPY is ${close.value>=ma50.value?'above':'below'} its 50-session trend and ${close.value>=ma200.value?'above':'below'} its 200-session trend.`:brief?.macro?.price_trend?.line||'Inspect the available price history.'};
  }
  function rotation(core,quotes,period,H){
    const map=H.sessionMap(core.rows,quotes,period,core.asof_session),history=(core.spy_close||[]).filter(p=>p[0]<=core.asof_session),last=history.at(-1),prior=history.at(-22);
    const spyMonth=last?.[0]===core.asof_session&&prior&&prior[1]>0?100*(last[1]/prior[1]-1):null;
    const month=H.sessionMap(core.rows,{},'1M',core.asof_session);
    return {...map,sectors:map.sectors.map(s=>({...s,relative:num(spyMonth)&&num(month.sectors.find(x=>x.sec===s.sec)?.pct)?month.sectors.find(x=>x.sec===s.sec).pct-spyMonth:null,
      movers:map.values.filter(r=>r.sec===s.sec&&num(r.value)).sort((a,b)=>Math.abs(b.value)-Math.abs(a.value)).slice(0,2)})).sort((a,b)=>(b.pct??-Infinity)-(a.pct??-Infinity)),spyMonth};
  }
  function rotationHTML(m,exposure={}){
    return `<div class="desk-table-wrap"><table class="desk-table rotation-table"><thead><tr><th>Sector</th><th class="n">${esc(m.period)}</th><th class="n">1M vs SPY</th><th>Largest moves · ${esc(m.period)}</th>${Object.keys(exposure).length?'<th class="n">My priced shares</th>':''}</tr></thead><tbody>${m.sectors.map(s=>`<tr><td><a href="#/markets?sec=${encodeURIComponent(s.sec)}&p=${encodeURIComponent(m.period)}">${esc(s.sec)}</a></td><td class="n ${num(s.pct)?s.pct>=0?'up':'dn':''}">${pct(s.pct)}</td><td class="n ${num(s.relative)?s.relative>=0?'up':'dn':''}">${num(s.relative)?(s.relative>=0?'+':'−')+Math.abs(s.relative).toFixed(1)+' pp':'—'}</td><td>${s.movers.map(r=>`<a href="#/markets?sel=${encodeURIComponent(r.t)}&p=${encodeURIComponent(m.period)}">${esc(r.t)} <span class="${r.value>=0?'up':'dn'}">${pct(r.value)}</span></a>`).join(' ')}</td>${Object.keys(exposure).length?`<td class="n">${num(exposure[s.sec])?exposure[s.sec].toFixed(1)+'%':'—'}</td>`:''}</tr>`).join('')}</tbody></table></div>`;
  }
  function attentionHTML(review){
    if(!review?.items?.length)return `<div class="desk-empty"><b>Make this about your portfolio.</b><p>Add holdings or follow companies to surface their moves, earnings and review dates here.</p><a class="btn" href="#/positions">Add holdings</a> <a class="text" href="#/companies">Find companies</a></div>`;
    return `<p class="small dim">${review.scope==='positions'?'Your entered shares':'Your followed companies'} · ${review.items.length} to review</p><div class="desk-table-wrap"><table class="desk-table attention-table"><thead><tr><th>Asset</th><th>Why look</th><th class="n">Session move</th><th></th></tr></thead><tbody>${review.items.slice(0,3).map(x=>`<tr><td><a href="#/markets?sel=${esc(x.t)}"><b>${esc(x.t)}</b></a></td><td>${esc(x.why.find(w=>!w.startsWith('Latest-session'))||'Price moved in the latest session')}<small>${esc(x.p?.session||'Check source date')}</small></td><td class="n ${num(x.p?.change)?x.p.change>=0?'up':'dn':''}">${pct(x.p?.change)}${num(x.p?.dollars)?`<small>${x.p.dollars<0?'−':'+'}$${Math.abs(x.p.dollars).toLocaleString('en-US',{maximumFractionDigits:0})} in shares</small>`:''}</td><td><a class="desk-action" href="${x.r?'#/company/'+esc(x.t)+'/'+(x.why.some(w=>/Earnings/i.test(w))?'events':'drivers'):'#/markets?sel='+esc(x.t)}">Review →</a></td></tr>`).join('')}</tbody></table></div><p class="small dim">Actual quoted movement, not a loss forecast. Open options are not included.</p>`;
  }
  function mountChart(host,a){
    let chart=null,history=null,dead=false,suspended=false,token=0,range='6M';
    const colors=['#c98b25','#5484cf','#2b9678'];
    const readTheme=()=>{const cs=root.getComputedStyle(host);return {ink:cs.color,line:cs.getPropertyValue('--line').trim()};};
    function draw(){
      if(dead||suspended||!history||!host.isConnected)return;
      chart?.remove();chart=null;
      const bars=(history.bars||[]).filter(b=>b[0]<=a.session&&b.slice(1,5).every(num)&&b[4]>0);
      const counts={'1M':22,'3M':63,'6M':126,'1Y':252},cut=bars.slice(-counts[range]),box=host.querySelector('[data-desk-chart]'),theme=readTheme();
      if(!cut.length){host.querySelector('[data-chart-basis]').textContent='Daily history could not be loaded. Open the full chart to retry.';return;}
      host.dataset.chartEnd=cut.at(-1)[0];host.dataset.chartClose=cut.at(-1)[4];
      const LC=a.charts;
      if(!LC){host.querySelector('[data-chart-basis]').textContent='Chart library did not load. The full price workspace remains available.';return;}
      chart=LC.createChart(box,{height:240,autoSize:true,layout:{background:{color:'transparent'},textColor:theme.ink,fontSize:11},grid:{vertLines:{visible:false},horzLines:{color:theme.line}},rightPriceScale:{borderVisible:false},timeScale:{borderVisible:false},handleScroll:false,handleScale:false});
      const add=(kind,options)=>chart['add'+kind+'Series']?chart['add'+kind+'Series'](options):chart.addSeries(LC[kind+'Series'],options);
      add('Candlestick',{upColor:'#2b9678',downColor:'#cc645c',borderVisible:false,wickUpColor:'#2b9678',wickDownColor:'#cc645c',lastValueVisible:false,priceLineVisible:false}).setData(cut.map(b=>({time:b[0],open:b[1],high:b[2],low:b[3],close:b[4]})));
      const legend=[];
      [20,50,200].forEach((n,i)=>{const all=a.sma(bars.map(b=>[b[0],b[4]]),n),visible=all.filter(p=>p[0]>=cut[0][0]);if(!visible.length)return;
        add('Line',{title:'SMA '+n,color:colors[i],lineWidth:2,lastValueVisible:false,priceLineVisible:false,crosshairMarkerVisible:false}).setData(visible.map(p=>({time:p[0],value:p[1]})));
        legend.push(`<span><i style="background:${colors[i]}"></i>SMA ${n} <b>$${all.at(-1)[1].toFixed(2)}</b></span>`);
      });
      host.querySelector('[data-chart-legend]').innerHTML=legend.join('');
      const basis=host.querySelector('[data-chart-basis]');basis.textContent=`Daily candles · USD/share · ${cut[0][0]}–${cut.at(-1)[0]}`;
      host.querySelector('[data-chart-source]').textContent=history.source||'Published Yahoo Finance daily bars';
      chart.timeScale().fitContent();
      chart.subscribeCrosshairMove(p=>{if(!p.time)return;const b=cut.find(b=>b[0]===p.time);if(b)basis.textContent=`${b[0]} · O $${b[1].toFixed(2)} · H $${b[2].toFixed(2)} · L $${b[3].toFixed(2)} · C $${b[4].toFixed(2)}`;});
    }
    const buttons=[...host.querySelectorAll('[data-chart-range]')];
    const click=e=>{const b=e.target.closest('[data-chart-range]');if(!b)return;range=b.dataset.chartRange;buttons.forEach(x=>x.setAttribute('aria-pressed',String(x===b)));draw();};host.addEventListener('click',click);
    const observer=new MutationObserver(()=>draw());observer.observe(root.document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const media=root.matchMedia('(prefers-color-scheme: dark)'),themeChange=()=>draw();media.addEventListener?.('change',themeChange);
    const own=++token;
    a.history('SPY').then(x=>{if(!dead&&own===token){history=x;draw();}}).catch(e=>{if(!dead){host.querySelector('[data-chart-basis]').textContent='Daily history could not be loaded. Open the full chart to retry.';console.warn('[cockpit] SPY daily history',e.message);}});
    return {suspend(){suspended=true;observer.disconnect();},resume(){suspended=false;observer.observe(root.document.documentElement,{attributes:true,attributeFilter:['data-theme']});draw();},destroy(){dead=true;token++;observer.disconnect();media.removeEventListener?.('change',themeChange);host.removeEventListener('click',click);chart?.remove();chart=null;}};
  }
  const api={trend,rotation,rotationHTML,attentionHTML,mountChart};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  root.SmartOptionsCockpit=api;
})(typeof window==='undefined'?globalThis:window);
