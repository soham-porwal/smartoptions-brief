/* Public intelligence evidence, explicitly separated from forecasts. */
'use strict';
(function(root,factory){const M=factory();if(typeof module!=='undefined'&&module.exports)module.exports=M;root.SmartOptionsRelationships=M;})(typeof window!=='undefined'?window:globalThis,function(){
  const matches=q=>/\b(relationships?|drivers?|sensitiv(?:e|ity|ities)|affect|explain(?:ed|s)? (?:the )?(?:move|return)|why .*(?:market|stock|moving|moved)|(?:rates?|oil|dollar|vix|macro).*(?:affect|impact|sensitive))\b/i.test(String(q||''));
  function answer(ticker,data){
    const result={intent:'relationships',title:ticker? ticker+' relationships':'Market drivers',lines:[],facts:[],na:null,action:null,followups:[],noPolish:true};
    if(!data||data.schema!=='smartoptions.intelligence.v1'){result.na='Relationship intelligence is unavailable. No relationship or forecast can be inferred from missing data.';return result;}
    const company=ticker?data.companies?.[ticker]:null;
    const rows=ticker?company?.relationships:data.market?.drivers;
    if(!Array.isArray(rows)||!rows.length){result.na=(ticker?ticker:'The market')+' has no recorded relationship evidence in this snapshot.';return result;}
    for(const r of rows.slice(0,3)){
      const refs=[];
      for(const e of (r.evidence||[]).slice(0,4)){
        const id='r'+(result.facts.length+1),value=typeof e.value==='number'&&Number.isFinite(e.value)?e.value:null;
        result.facts.push({id,text:e.label||r.title||'Evidence',value,unit:e.unit||'',display:value===null?'not available':String(value)+(e.unit?' '+e.unit:''),period:e.date||'',asof:e.date||data.generated_at||'',source:'Intelligence evidence',url:/^https?:\/\//.test(e.source_url||'')?e.source_url:'',note:e.formula||'',ticker:ticker||''});refs.push(id);
      }
      const label={observed:'Observed',association:'Historical association',scenario:'Conditional scenario'}[r.kind]||'Unclassified evidence';
      result.lines.push({text:label+': '+(r.title||'Relationship')+'. '+(r.summary||'Summary unavailable.')+' Counterargument: '+(r.counterargument||'No counterargument supplied; evidence is incomplete.'),refs});
    }
    result.lines.push({text:'Historical fit describes the recorded sample; it is not a validated forecast. Model as of '+(company?.model_asof||data.basis?.model_asof||data.generated_at||'unknown')+'.',refs:[]});
    return result;
  }
  return {matches,answer};
});
