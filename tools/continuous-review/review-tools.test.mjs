import test from 'node:test';
import assert from 'node:assert/strict';
import {manuscripts,makeResponse} from './synthetic-fixture.mjs';
import {buildReadingPrompts,validateReading,inspectChangeCoverage,inspectExecution,sha256} from './review-tools.mjs';
const inspect=r=>validateReading({manuscripts,raw:JSON.stringify(r)});
test('two isolated two-message plans carry full three-chapter texts in reversed order',()=>{
 const p=buildReadingPrompts({manuscripts});assert.deepEqual(p.map(x=>x.order),[['A','B'],['B','A']]);
 for(const plan of p){assert.equal(plan.messages.length,2);const body=JSON.parse(plan.user);assert.deepEqual(body.manuscripts.map(m=>m.version),plan.order);for(const m of body.manuscripts)assert.deepEqual(m.chapters,manuscripts[m.version]);assert.deepEqual(Object.keys(body),['instructions','manuscripts','responseContract']);}
});
test('valid complete evidence remains independent from facts and literary acceptance',()=>{
 const before=JSON.stringify(manuscripts),r=inspect(makeResponse());assert(r.valid);assert.equal(r.references.length,6);assert.equal(r.references[0].start,0);assert.equal(r.factJudgment,'requires_human_review');assert.equal(r.literaryJudgment,'requires_human_review');assert.equal(r.fullManuscriptAccepted,false);assert.equal(r.changeCoverage.uncoveredUnitCount,0);assert.equal(JSON.stringify(manuscripts),before);
});
test('verbatim altered and repeated citations fail without repaired preference',()=>{
 const r=makeResponse();r.evidence[0].quote+='不存在';let v=inspect(r);assert(!v.citationsExact);assert.equal(v.preference,null);
 const m=structuredClone(manuscripts);m.A[0].body+='\n\n'+r.evidence[1].quote;const response=makeResponse();m.A[0].body+='\n\n'+response.evidence[0].quote;v=validateReading({manuscripts:m,raw:JSON.stringify(response)});assert(v.errors.some(e=>e.code==='QUOTE_AMBIGUOUS'));
});
test('missing chapter or wrong-version evidence fails despite precise strings',()=>{
 const r=makeResponse();r.chapterReadings.pop();assert(!inspect(r).evidenceContractValid);
 const s=makeResponse();s.dimensions[0].A.evidenceIds=['B2'];const v=inspect(s);assert(v.citationsExact);assert(!v.valid);assert(v.errors.some(e=>e.code==='WRONG_SOURCE'));
});
test('malformed JSON, arbitrary JSON types, fences and duplicate evidence IDs fail closed',()=>{
 for(const raw of ['null','[]','1','"x"','{','```json\n{}\n```',JSON.stringify({freeReading:{filter:'x'}})])assert(!validateReading({manuscripts,raw}).valid);
 const r=makeResponse();r.evidence[1].id=r.evidence[0].id;assert(!inspect(r).valid);
});
test('raw digest mismatch is separate from schema and citation success',()=>{
 const raw=JSON.stringify(makeResponse()),r=validateReading({manuscripts,raw,expectedRawSHA256:sha256('wrong')});assert(r.schemaValid&&r.citationsExact);assert(!r.valid);assert(r.errors.some(e=>e.code==='RAW_HASH_MISMATCH'));
});
test('uncovered changes are visible; no automated evidence padding or literary rejection',()=>{
 const r=makeResponse();r.evidence.find(e=>e.id==='A2').quote='他听见里屋有人叫自己的名字。';const v=inspect(r);assert(v.valid);assert(v.changeCoverage.uncoveredUnitCount>0);assert.equal(v.literaryJudgment,'requires_human_review');
});
test('shared wording inside changed paragraph is identified separately',()=>{
 const m=structuredClone(manuscripts);m.A[1].body='值班人收回钥匙。访客退到门边。';m.B[1].body='值班人没有收回钥匙。访客退到门边。';const quote='访客退到门边。';const start=m.A[1].body.indexOf(quote);
 const c=inspectChangeCoverage({manuscripts:m,citations:[{id:'E',version:'A',chapterId:'ch-2',quote,start,end:start+quote.length,exactUnique:true}]});const unit=c.units.find(u=>u.version==='A'&&u.chapterId==='ch-2');assert.deepEqual(unit.commonWordingCitationIds,['E']);assert.equal(unit.distinctWordingCitationIds.length,0);
});
test('cross-chapter movement and within-chapter reorder remain visible',()=>{
 const m=structuredClone(manuscripts);m.A[0].body='甲段。\n\n乙段。';m.B[0].body='乙段。\n\n甲段。';m.A[1].body='迁移段。';m.B[1].body='另一段。';m.B[2].body+='\n\n迁移段。';const c=inspectChangeCoverage({manuscripts:m});assert(c.units.some(u=>u.kind==='reordered'));assert(c.units.some(u=>u.kind==='cross_chapter_move'));
});
test('receipt isolation and actual history mismatch fail independently',()=>{
 const planned=buildReadingPrompts({manuscripts}),executions=planned.map((p,i)=>({readerId:p.readerId,messages:p.messages,raw:JSON.stringify(makeResponse()),receipt:{contextId:'c'+i,invocationId:'i'+i}}));assert(inspectExecution({planned,executions}).valid);executions[1].receipt.contextId='c0';assert(!inspectExecution({planned,executions}).valid);executions[1].receipt.contextId='c1';executions[1].messages=[...executions[1].messages,{role:'assistant',content:'other reader'}];assert(!inspectExecution({planned,executions}).valid);
});
test('factual identity language on unequal bodies prompts review without silently changing preference',()=>{
 const r=makeResponse();r.overall.assessment='两稿完全相同。';const v=inspect(r);assert(v.valid);assert.equal(v.preference,'tradeoff');assert(v.factualWarnings.length);assert.equal(v.factJudgment,'requires_human_review');
});
