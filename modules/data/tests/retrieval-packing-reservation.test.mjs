import test from 'node:test';
import assert from 'node:assert/strict';
import {organizeMaterials,organizeUsableMaterials,selectDiversePreparedMaterials,rankWithRecall,buildRetrievalIndex,compatibleIndex,RETRIEVAL_LIMITS} from '../runtime/retrieval.mjs';
import {prepareRelevance,inspectRelevance,bindFinalMaterials} from '../runtime/relevance.mjs';
import {expandRelevanceInput,packRelevanceInput} from '../runtime/relevance-payload.mjs';
import {mergeFollowupMaterials} from '../runtime/followup-materials.mjs';
import {fixtureSelectionDecision} from './relevance-fixtures.mjs';
import {book,starvationFixture,budget,query,hash} from './retrieval-fix-fixtures.mjs';

const checked=m=>m.use==='reviewed_analysis';
function assertBudget(out,limits=budget) {
 assert.equal(out.usedChars,out.materials.reduce((n,m)=>n+m.content.length,0));
 assert.ok(out.usedChars<=limits.maxChars);
 assert.ok(out.materials.length<=limits.maxUnits);
 assert.ok(out.materials.reduce((n,m)=>n+Math.max(1,new Set(m.references.flatMap(r=>r.unitIds)).size),0)<=limits.maxUnits);
 const keys=[...new Set(out.materials.map(m=>JSON.stringify([m.references[0].sourceSha256,m.references[0].textVersion])))];
 for(const key of keys){const same=out.materials.filter(m=>JSON.stringify([m.references[0].sourceSha256,m.references[0].textVersion])===key);assert.ok(same.length<=3);assert.ok(same.reduce((n,m)=>n+m.content.length,0)<=4800);}
}
const resultFor=(materials,candidates=[])=>({contractVersion:'v04-contract-1',packetId:'synthetic',query,status:materials.length?'matched':'uncovered',materials,candidates,usedChars:materials.reduce((n,m)=>n+m.content.length,0)});

test('raw-first starvation preserves earliest feasible complete analysis, not shortest/most analyses',async()=>{
 const f=starvationFixture(),before=structuredClone(f.candidates);
 const out=await organizeMaterials(f.candidates,budget,f.readText);
 assert.equal(out.materials.filter(checked).length,1);
 assert.equal(out.materials[0].id,f.long.analysis.id);
 assert.equal(out.materials.length,2);
 assert.ok(!out.materials.some(m=>m.id===f.shorter.analysis.id));
 const single=await organizeMaterials([f.long.analysis],budget,f.readText);
 assert.deepEqual(out.materials[0],single.materials[0]);
 assert.ok(out.materials[0].content.length>1600);
 assert.deepEqual(out.materials[0].references.map(r=>r.lineStart),[1,3,5,7,9]);
 assert.ok(!out.materials[0].content.includes('未纳入证据的空隙'));
 assert.ok(out.limits.some(s=>s.includes('原顺序未供应分析')&&s.includes(f.raws[1].raw.id)));
 assert.deepEqual(f.candidates,before);assertBudget(out);
});

test('semantic-usable allocation keeps an existing analysis route when source and material coverage tie',async()=>{
 const f=starvationFixture(),selected=[f.long.analysis,f.raws[0].raw,f.raws[1].raw];
 const before=await organizeMaterials(selected,budget,f.readText);
 assert.deepEqual(before.materials.map(m=>m.id),[f.long.analysis.id,f.raws[0].raw.id]);
 assert.equal(before.materials.reduce((n,m)=>n+Math.max(1,new Set(m.references.flatMap(r=>r.unitIds)).size),0),6);
 const after=await organizeUsableMaterials(selected,budget,f.readText);
 assert.deepEqual(after.materials,before.materials);
 assert.ok(after.limits.some(s=>s.includes('来源数和完整材料数没有增加')&&s.includes('保留原包中已存在的分析路线')));
 assertBudget(after);
});

test('oversized reviewed analysis projects to one checked related locator before relevance review',async()=>{
 const b=book('bounded-analysis',{units:7}),unchanged=structuredClone(b.analysis);
 const ranked=rankWithRecall(b.entries,{...query,query:'承担照护责任并继续值班'}),analysis=ranked.find(c=>c.id===b.analysis.id);
 assert.ok(analysis.analysisContextOrigin);assert.equal(analysis.unitIds.length,2);
 assert.equal(analysis.unitIds[0],'u0');assert.ok(analysis.unitIds[1].startsWith('u'));
 assert.deepEqual(analysis.analysisContextOrigin.parentUnitIds,b.analysis.unitIds);
 assert.ok(!analysis.raw.includes('未纳入证据的空隙'));
 assert.ok(analysis.raw.startsWith(`单元 u0：title: ${b.row.analysis.units[0].title}`));
 const single=await organizeMaterials([analysis],budget,async()=>b.text);
 assert.equal(single.materials.length,1);assert.equal(single.materials[0].use,'reviewed_analysis');assertBudget(single);
 const prepared=await prepareRelevance({...query,query:'承担照护责任并继续值班'},ranked,async()=>b.text);
 const sent=prepared.input.candidates.find(c=>c.candidateId===analysis.id);
 assert.ok(sent);assert.equal(sent.content,single.materials[0].content);assert.deepEqual(sent.references,single.materials[0].references);
 assert.deepEqual(b.analysis,unchanged);
});

test('fair allocation does not drop coverage merely to save units or invent out-of-set candidates',async()=>{
 const f=starvationFixture(),selected=[f.long.analysis,f.raws[0].raw];
 const out=await organizeUsableMaterials(selected,budget,f.readText);
 assert.deepEqual(out.materials.map(m=>m.id),[f.long.analysis.id,f.raws[0].raw.id]);
 assert.ok(out.materials.every(m=>selected.some(c=>c.id===m.id)));
 const single=[];
 for(const c of [f.raws[0].raw,f.raws[1].raw])single.push({candidateId:c.id,material:(await organizeMaterials([c],budget,f.readText)).materials[0]});
 const duplicate=structuredClone(single[0]);duplicate.candidateId='same-source-second';duplicate.material={...duplicate.material,id:'same-source-second',references:duplicate.material.references.map(r=>({...r,lineStart:r.lineEnd+2,lineEnd:r.lineEnd+2}))};
 const picked=selectDiversePreparedMaterials([single[0],duplicate,single[1]],{...budget,maxUnits:2});
 assert.deepEqual(picked.selectedCandidateIds,[single[0].candidateId,single[1].candidateId]);
});

test('an original package already containing analysis preserves every material and its order',async()=>{
 const f=starvationFixture(),cs=[f.raws[0].raw,f.long.analysis,...f.candidates.slice(3)];
 const out=await organizeMaterials(cs,budget,f.readText);
 const raw=await organizeMaterials([cs[0]],budget,f.readText),analysis=await organizeMaterials([cs[1]],budget,f.readText);
 assert.deepEqual(out.materials,[...raw.materials,...analysis.materials]);
 assert.ok(!out.limits.some(s=>s.includes('原顺序未供应分析')));assertBudget(out);
});

test('infeasible analysis stays whole and omitted; next feasible analysis may recover the route',async()=>{
 const f=starvationFixture(),huge=book('oversize',{units:5,analysisChars:6000});
 const tooMany=book('too-many-units',{units:7});
 for(const c of [huge.analysis,tooMany.analysis]){
  const alone=await organizeMaterials([c],budget,f.readText);assert.equal(alone.materials.length,0);
  const out=await organizeMaterials([c,...f.candidates],budget,f.readText);
  assert.equal(out.materials[0].id,f.long.analysis.id);assert.ok(!out.materials.some(m=>m.id===c.id));assertBudget(out);
 }
 const rawOnly=await organizeMaterials([huge.analysis,...f.raws.map(b=>b.raw)],budget,f.readText);
 assert.equal(rawOnly.materials.length,6);assert.ok(rawOnly.materials.every(m=>!checked(m)));
});

test('zero/tight/candidate budgets never obtain an out-of-bound analysis or clip evidence',async()=>{
 const f=starvationFixture();
 for(const limits of [{...budget,maxChars:0},{...budget,maxUnits:0},{...budget,maxCandidates:0}])assert.deepEqual((await organizeMaterials(f.candidates,limits,f.readText)).materials,[]);
 const bounded=await organizeMaterials(f.candidates,{...budget,maxCandidates:2},f.readText);
 assert.ok(bounded.materials.every(m=>!checked(m)));assert.equal(bounded.materials.length,2);
 for(const limits of [{...budget,maxUnits:3},{...budget,maxChars:200}]){
  const out=await organizeMaterials(f.candidates,limits,f.readText);assert.ok(out.materials.every(m=>!checked(m)));assertBudget(out,limits);
 }
 for(const limits of [{maxUnits:-1},{maxChars:NaN},{maxCandidates:1.5}])await assert.rejects(organizeMaterials(f.candidates,limits,f.readText),/Invalid retrieval budget/);
});

test('character starvation and same-source overlap recover without dropping analysis references',async()=>{
 const f=starvationFixture(),chars=(await organizeMaterials([f.long.analysis],budget,f.readText)).usedChars;
 const tight={...budget,maxChars:chars};
 const out=await organizeMaterials(f.candidates,tight,f.readText);assert.equal(out.materials.length,1);assert.equal(out.materials[0].id,f.long.analysis.id);assertBudget(out,tight);
 const overlap=await organizeMaterials([f.long.raw,f.long.analysis],budget,f.readText);
 assert.equal(overlap.materials.length,1);assert.equal(overlap.materials[0].id,f.long.analysis.id);assertBudget(overlap);
});

test('candidate-specific refusal/partial applicability and exact evidence survive wire -> pack -> ledger',async()=>{
 const f=starvationFixture(),prepared=await prepareRelevance(query,f.candidates,f.readText);
 assert.ok(prepared.user.length<=48000);
 const {inputHash,...wire}=JSON.parse(prepared.user);
 assert.deepEqual(expandRelevanceInput(wire),prepared.input);
 assert.deepEqual(expandRelevanceInput(packRelevanceInput(prepared.input)),prepared.input);
 const decisions=inspectRelevance(JSON.stringify({inputHash,decisions:prepared.input.candidates.map(c=>{
  const d=fixtureSelectionDecision(c,c.candidateId===f.shorter.analysis.id?'irrelevant':'usable');
  d.reason=c.candidateId===f.shorter.analysis.id?'不支持当前所需关系。':'仅作记录动作表达的参考，不证明事实或完整动机。';return d;
 })}),prepared);
 const selected=f.candidates.filter(c=>decisions.some(d=>d.candidateId===c.id&&d.relevance==='usable'));
 const out=await organizeMaterials(selected,budget,prepared.readText);
 const bindings=bindFinalMaterials(out.materials,prepared,decisions);
 assert.equal(out.materials[0].id,f.long.analysis.id);assert.ok(!out.materials.some(m=>m.id===f.shorter.analysis.id));
 const material=out.materials[0],sent=prepared.input.candidates.find(c=>c.candidateId===material.id);
 assert.equal(material.content,sent.content);assert.equal(material.sha256,sent.contentSha256);assert.equal(hash(material.content),material.sha256);
 assert.deepEqual(material.references,sent.references);assert.deepEqual(material.limitations,sent.limitations);
 assert.ok(material.limitations.some(l=>l.includes(JSON.stringify(f.long.row.analysis.limitations))));
 for(const quote of decisions.find(d=>d.candidateId===material.id).evidenceQuotes)assert.ok(f.long.text.includes(quote));
 assert.equal(bindings[0].candidateIds[0],material.id);
 const merged=mergeFollowupMaterials({active:[],result:resultFor(out.materials,f.candidates.map(c=>({id:c.id})))});
 assert.equal(merged.dropped.length,0);assert.deepEqual(merged.active,out.materials);assert.equal(merged.chargedChars,out.usedChars);
 // Rejected analysis is not reintroduced when it is the only analysis in scope.
 const rawSelected=selected.filter(c=>c.use==='raw_reference');
 const rawOut=await organizeMaterials(rawSelected,budget,prepared.readText);assert.ok(rawOut.materials.every(m=>!checked(m)));
 bindFinalMaterials(rawOut.materials,prepared,decisions);
});

test('all refusals, no candidates and raw-only sources remain empty/raw-only without invented material',async()=>{
 const f=starvationFixture(),p=await prepareRelevance(query,f.candidates,f.readText);
 const decisions=inspectRelevance(JSON.stringify({inputHash:p.inputHash,decisions:p.input.candidates.map(c=>fixtureSelectionDecision(c,'irrelevant'))}),p);
 const out=await organizeMaterials(f.candidates.filter(c=>decisions.some(d=>d.candidateId===c.id&&d.relevance==='usable')),budget,p.readText);
 assert.deepEqual(out.materials,[]);assert.deepEqual(bindFinalMaterials([],p,decisions),[]);
 assert.deepEqual((await organizeMaterials([],budget,f.readText)).materials,[]);
 const r=book('raw-only',{checked:false});assert.ok(r.entries.every(e=>e.use==='raw_reference'));
 const raw=await organizeMaterials(r.entries,budget,async()=>r.text);assert.equal(raw.materials.length,1);assert.equal(raw.materials[0].use,'raw_reference');
});

test('index/review version mismatch never creates an analysis route; concrete queries stay distinct',()=>{
 const a=book('a'),b=book('b');
 for(const field of ['sourceId','textVersion','analysisVersion']){
  const stale=structuredClone(a.row);stale.analysis.validation.semanticReview[field]='stale';
  assert.ok(buildRetrievalIndex(stale,a.text).entries.every(e=>e.use==='raw_reference'));
  assert.equal(compatibleIndex(buildRetrievalIndex(a.row,a.text),stale),false);
 }
 // The ranker still uses the actual query; fallback cannot invent candidates.
 assert.deepEqual(rankWithRecall(a.entries,{query:'unmatched_unique_needle'}),[]);
 assert.ok(rankWithRecall(a.entries,{query:'值班'}).length);
 assert.equal(rankWithRecall(b.entries,{query:'值班',evidenceType:'performance',recall:{focus:'scene',queries:[]}}).length,0);
 assert.deepEqual(RETRIEVAL_LIMITS,{...budget,coreChars:700,contextChars:280,contextLines:6,maxRangeChars:2400,maxSourceChars:4800,maxSourceMaterials:3});
});

test('followup aliases preserve same-text/version conflicts and cumulative charging after reservation',async()=>{
 const f=starvationFixture(),out=await organizeMaterials(f.candidates,budget,f.readText),material=out.materials[0];
 const first=mergeFollowupMaterials({active:[],result:resultFor(out.materials)});
 for(const [field,value,code] of [['textVersion','other','TEXT_VERSION_CONFLICT'],['analysisVersion','other','ANALYSIS_VERSION_CONFLICT'],['reviewRecordId','other','REVIEW_VERSION_CONFLICT'],['sourceSha256','f'.repeat(64),'SOURCE_HASH_CONFLICT']]){
  const changed=structuredClone(material);changed.id+='-'+field;changed.references.forEach(r=>{r[field]=value;});
  const next=mergeFollowupMaterials({active:first.active,retained:first.retained,result:resultFor([changed])});
  assert.equal(next.dropped[0].code,code);assert.equal(next.chargedChars,first.chargedChars);assert.deepEqual(next.active,first.active);
 }
 const alias=structuredClone(material);alias.id='alias';alias.references.forEach(r=>r.sourceId='alias-source');
 const repeated=mergeFollowupMaterials({active:first.active,retained:first.retained,result:resultFor([alias])});
 assert.equal(repeated.dropped[0].code,'DUPLICATE_REVIEWED_UNIT');assert.equal(repeated.chargedChars,first.chargedChars);
});

test('repacking reads each raw source once and cancellation still propagates',async()=>{
 const f=starvationFixture(),reads=new Map();
 await organizeMaterials(f.candidates,budget,async r=>{reads.set(r.sourceId,(reads.get(r.sourceId)??0)+1);return f.readText(r);});
 assert.ok([...reads.values()].every(n=>n===1));assert.equal(reads.size,6);
 const controller=new AbortController();controller.abort();
 await assert.rejects(organizeMaterials(f.candidates,budget,f.readText,{signal:controller.signal}),{name:'AbortError'});
});
