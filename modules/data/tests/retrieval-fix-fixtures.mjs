import {createHash} from 'node:crypto';
import {buildRetrievalIndex,INDEX_VERSION} from '../runtime/retrieval.mjs';

export const hash=value=>createHash('sha256').update(value).digest('hex');
export const budget={maxCandidates:20,maxUnits:6,maxChars:12000};
export const query={contractVersion:'v04-contract-1',query:'迟疑后承担照护责任',context:'日常动作表现责任与不情愿并存；只借表达，不借事实。',stage:'planning',budget};
export function book(id,{units=1,analysisChars=80,checked=true}={}) {
 const text=Array.from({length:units*2-1},(_,i)=>i%2?'未纳入证据的空隙。':`${id}第${i+1}处：他收起账单，仍把下一次值班记在纸上。`).join('\n');
 const row={sourceId:id,title:id,sourceSha256:hash(text),indexVersion:INDEX_VERSION,textVersion:'text-'+id,completeness:'partial',analysis:{version:'analysis-'+id,reviewStatus:checked?'checked':'needs_review',coverage:{scope:'partial',notes:['只覆盖提交片段。']},limitations:['只支持表达参考，不是事实证明。',' 不得推断远处动机。 ','只支持表达参考，不是事实证明。'],units:[],validation:{semanticReview:{approved:checked,recordId:'review-'+id,sourceId:id,textVersion:'text-'+id,analysisVersion:'analysis-'+id}}}};
 row.analysis.units=Array.from({length:units},(_,i)=>({id:'u'+i,title:'责任与迟疑',event:'看到值班表后继续记录。',psychology:i?'关联分析不供应。':'犹豫并未消失。'.repeat(Math.ceil(analysisChars/8)),emotion:'不情愿与关心并存。',expression:'记录动作承接情绪。',readerEffectHypothesis:'可能让读者看到矛盾。',locator:{lineStart:2*i+1,lineEnd:2*i+1},relatedUnitIds:i?[]:Array.from({length:units-1},(_,j)=>'u'+(j+1))}));
 const entries=buildRetrievalIndex(row,text).entries.map(e=>({...e,row}));
 return {row,text,entries,analysis:entries.find(e=>e.focusUnitId==='u0'),raw:entries.find(e=>e.use==='raw_reference')};
}
export function starvationFixture() {
 const raws=Array.from({length:6},(_,i)=>book('raw-'+i,{checked:false}));
 const long=book('long',{units:5,analysisChars:3100});
 const shorter=book('shorter',{units:4});
 const books=[...raws,long,shorter],texts=new Map(books.map(b=>[b.row.sourceId,b.text]));
 return {books,long,shorter,raws,candidates:[raws[0].raw,raws[1].raw,long.analysis,raws[2].raw,shorter.analysis,...raws.slice(3).map(b=>b.raw)],readText:async row=>texts.get(row.sourceId)};
}
