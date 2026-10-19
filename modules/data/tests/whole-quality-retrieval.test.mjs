import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildWholeQualityQuery,retrieveWholeQualityEvidence,validateWholeQualityRetrievalPacket,
  assertWholeQualityEvidenceBundle,buildWholeQualityMaterialUseLedger,buildWholeQualityObservationRecall,addWholeQualityObservationRecall} from '../runtime/whole-quality-retrieval.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const issue = overrides => ({issueId:'issue-1',question:'人物在压力累积后如何用行动回应此前承诺？',storyProblem:'心理解释重复，关键决定没有变成可见动作。',
  expectedEffect:'让选择在同一场景里由压力、判断推进到动作。',failureCriterion:'只增加解释，或动作与此前压力没有可见关系。',
  counterConsideration:'人物克制可能有意保留；若动作会破坏这种克制，应保留原稿。',sceneQueries:['压力 判断 动作','承诺 回应'],...overrides});
const reference = overrides => ({sourceId:'source-a',sourceSha256:'a'.repeat(64),textVersion:'text-v1',analysisVersion:'analysis-v1',unitIds:[],lineStart:8,lineEnd:12,...overrides});
const material = (id,use='raw_reference',overrides={}) => {
  const content=`${use==='raw_reference'?'【原文参考；不作为已发布分析】':'【经语义复核的分析及原文；文学效果未验证】'}\n连续场景原文`;
  const ref=reference(use==='reviewed_analysis'?{unitIds:['u1'],reviewRecordId:'review-1'}:{});
  return {id,title:`材料 ${id}`,kind:'retrieved',use,content,sha256:hash(content),references:[ref],selectionReason:'离线合同夹具；仍需判断适用性。',limitations:['仅为连续局部窗口。'],...overrides};
};
const packet = (query,materials=[material('raw-1')],overrides={}) => ({contractVersion:'v04-contract-1',packetId:'packet-1',status:materials.length?'matched':'uncovered',
  query,materials,candidates:materials.map(item=>({id:item.id,sourceId:item.references[0].sourceId,reason:'候选理由'})),usedChars:materials.reduce((n,item)=>n+item.content.length,0),limits:['命中不等于相关。'],...overrides});

test('one issue becomes one exact scene-recall query and preserves the production packet',async()=>{
  const expected=buildWholeQualityQuery(issue());let calls=0;
  const result=await retrieveWholeQualityEvidence({issue:issue(),retrieveKnowledge:async(query,{signal})=>{calls++;assert.deepEqual(query,expected);assert.equal(signal,undefined);return packet(query,[material('raw-1'),material('reviewed-1','reviewed_analysis')]);}});
  assert.equal(calls,1);assert.deepEqual(result.query,expected);assert.equal(result.packet.materials.length,2);
  assert.equal(result.evidenceBundle.materials[0].reviewBoundary,'unreviewed_raw_reference');
  assert.equal(result.evidenceBundle.materials[1].reviewBoundary,'source_bound_reviewed_analysis');
  assert(result.evidenceBundle.materials.every(item=>item.evidence.every(e=>e.continuity==='single_contiguous_line_range')));
  assert.deepEqual(assertWholeQualityEvidenceBundle(result.evidenceBundle,result.packet,result.issueId),result.evidenceBundle);
});

test('query input is bounded without title- or answer-specific production rules',()=>{
  const scoped=buildWholeQualityQuery(issue({sourceIds:['one','two'],sceneQueries:[]}));
  assert.deepEqual(scoped.sourceIds,['one','two']);assert.deepEqual(scoped.recall,{focus:'scene',queries:[]});assert.equal(scoped.stage,'revision');
  assert.equal(scoped.evidenceType,'narrative');assert.deepEqual(scoped.budget,{maxCandidates:20,maxUnits:6,maxChars:12000});
  for(const bad of [issue({issueId:' '}),issue({sceneQueries:['same','same']}),issue({sceneQueries:['x'.repeat(4001)]})])assert.throws(()=>buildWholeQualityQuery(bad));
  const full='完整问题与迁移约束'.repeat(20),preserved=buildWholeQualityQuery(issue({sceneQueries:[full]}));
  assert.deepEqual(preserved.recall.queries,[]);assert.deepEqual(preserved.recall.fullQueries,[full]);
  assert.throws(()=>buildWholeQualityQuery(issue(),{budget:{maxChars:12001}}));
});

test('raw and reviewed provenance cannot be relabelled or detached from bytes',()=>{
  const query=buildWholeQualityQuery(issue());
  const rawWithReview=material('raw');rawWithReview.references[0].reviewRecordId='forged';
  assert.throws(()=>validateWholeQualityRetrievalPacket(packet(query,[rawWithReview]),query),/raw reference/);
  const reviewedWithoutRecord=material('reviewed','reviewed_analysis');delete reviewedWithoutRecord.references[0].reviewRecordId;
  assert.throws(()=>validateWholeQualityRetrievalPacket(packet(query,[reviewedWithoutRecord]),query),/reviewRecordId/);
  const forged=material('forged');forged.content+='改';assert.throws(()=>validateWholeQualityRetrievalPacket(packet(query,[forged]),query),/content/);
  assert.throws(()=>validateWholeQualityRetrievalPacket(packet({...query,query:'另一问题'}),query),/exact query/);
});

test('production source windows preserve trailing whitespace as hash-bound content',()=>{
  const query=buildWholeQualityQuery(issue()),raw=material('raw');
  raw.content='【原文参考；不作为已发布分析】\n连续场景原文\n ';
  raw.sha256=hash(raw.content);
  const actual=packet(query,[raw]);
  const validated=validateWholeQualityRetrievalPacket(actual,query);
  assert.equal(validated.materials[0].content,raw.content);
  assert.equal(validated.materials[0].sha256,hash(raw.content));
  const trimmed=structuredClone(actual);trimmed.materials[0].content=trimmed.materials[0].content.trim();
  assert.throws(()=>validateWholeQualityRetrievalPacket(trimmed,query),/content/);
  const blank=structuredClone(actual);blank.materials[0].content='\n ';blank.materials[0].sha256=hash(blank.materials[0].content);blank.usedChars=2;
  assert.throws(()=>validateWholeQualityRetrievalPacket(blank,query),/content/);
});

test('legacy duplicate caveats remain valid while candidate identities stay unique',()=>{
  const query=buildWholeQualityQuery(issue()),raw=material('raw');
  raw.limitations=['同一版本说明。','同一版本说明。'];
  assert.doesNotThrow(()=>validateWholeQualityRetrievalPacket(packet(query,[raw],{limits:['共享边界。','共享边界。']}),query));
  const duplicated=packet(query,[raw]);duplicated.candidates.push({...duplicated.candidates[0]});
  assert.throws(()=>validateWholeQualityRetrievalPacket(duplicated,query),/candidate identity/);
});

test('uncovered is a valid counterexample and never manufactures evidence',async()=>{
  const result=await retrieveWholeQualityEvidence({issue:issue({issueId:'negative'}),retrieveKnowledge:async query=>packet(query,[])});
  assert.equal(result.packet.status,'uncovered');assert.deepEqual(result.evidenceBundle.materials,[]);
  assert.deepEqual(buildWholeQualityMaterialUseLedger(result,[]).decisions,[]);
});

test('complete use ledger separates supply from declared use and binds sources',async()=>{
  const second=material('b','raw_reference',{references:[reference({lineStart:13,lineEnd:15})]});
  const result=await retrieveWholeQualityEvidence({issue:issue(),retrieveKnowledge:async query=>packet(query,[material('a'),second])});
  const evidenceId=result.evidenceBundle.materials[0].evidence[0].evidenceId;
  const ledger=buildWholeQualityMaterialUseLedger(result,[
    {materialId:'a',decision:'used',reason:'该窗口提供动作落点。',evidenceIds:[evidenceId],changeGroupIds:['change-1'],appliedAs:'用判断后的动作回应前文压力。'},
    {materialId:'b',decision:'not_used',reason:'与当前人物克制的保留理由冲突。',evidenceIds:[],changeGroupIds:[]},
  ]);
  assert.deepEqual(ledger.usedMaterialIds,['a']);assert.deepEqual(ledger.notUsedMaterialIds,['b']);
  assert.deepEqual(ledger.decisions[0].sourceBindings,[{sourceId:'source-a',sourceSha256:'a'.repeat(64),textVersion:'text-v1'}]);
  assert.match(ledger.boundary,/尚未证明正文可辨作用/);
});

test('use ledger rejects implicit adoption, unknown evidence and unsupported effect claims',async()=>{
  const second=material('b','raw_reference',{references:[reference({lineStart:13,lineEnd:15})]});
  const result=await retrieveWholeQualityEvidence({issue:issue(),retrieveKnowledge:async query=>packet(query,[material('a'),second])});
  const evidenceId=result.evidenceBundle.materials[0].evidence[0].evidenceId;
  assert.throws(()=>buildWholeQualityMaterialUseLedger(result,[{materialId:'a',decision:'not_used',reason:'不用'}]),/every supplied/);
  assert.throws(()=>buildWholeQualityMaterialUseLedger(result,[
    {materialId:'a',decision:'used',reason:'用',evidenceIds:['unknown'],changeGroupIds:['c'],appliedAs:'作用'},
    {materialId:'b',decision:'not_used',reason:'不用'},
  ]),/unknown evidence/);
  assert.throws(()=>buildWholeQualityMaterialUseLedger(result,[
    {materialId:'a',decision:'used',reason:'用',evidenceIds:[evidenceId],changeGroupIds:[],appliedAs:'作用'},
    {materialId:'b',decision:'not_used',reason:'不用'},
  ]),/requires evidenceIds/);
});

test('abort stops before callback and callback failures are not rewritten as misses',async()=>{
  const controller=new AbortController();controller.abort(new Error('stop'));let calls=0;
  await assert.rejects(retrieveWholeQualityEvidence({issue:issue(),signal:controller.signal,retrieveKnowledge:async()=>{calls++;}}),/stop/);assert.equal(calls,0);
  await assert.rejects(retrieveWholeQualityEvidence({issue:issue(),retrieveKnowledge:async()=>{throw Error('offline failure');}}),/offline failure/);
});


test('oversized verified observation quotes are recorded as omitted seeds without breaking other recall or altering evidence',()=>{
  const quote=value=>({quote:value,lineStart:1,lineEnd:1,lineWindowUtf16Start:0,lineWindowUtf16End:value.length,lineWindowBodySha256:hash(value),matchedQuoteUtf16Start:0,matchedQuoteUtf16End:value.length});
  const large=quote('甲'.repeat(2218)),small=quote('她关门后把钥匙交给同伴。');
  const item={id:'observation-1',recordType:'checked_analysis_unit',source:{sourceId:'source-a',sourceSha256:'a'.repeat(64),textVersion:'text-v1'},currentReviewState:{analysisVersion:'analysis-v1',reviewRecordId:'review-1'},quotes:[large,small]};
  const input={contractVersion:'narrative-observation-query-1',queryHash:'b'.repeat(64),status:'covered',request:{query:issue().question},results:[item]};
  const before=structuredClone(input), recall=buildWholeQualityObservationRecall(issue(),input);
  assert.deepEqual(input,before);assert.equal(recall.seeds.length,1);assert.equal(recall.seeds[0].quote,small.quote);
  assert.equal(recall.excludedQuotes[0].quoteSha256,hash(large.quote));assert.equal(recall.excludedQuotes[0].characters,2218);
  assert.doesNotThrow(()=>addWholeQualityObservationRecall(buildWholeQualityQuery(issue()),recall));
  const allLarge=structuredClone(input);allLarge.results[0].quotes=[large];
  const empty=buildWholeQualityObservationRecall(issue(),allLarge);assert.equal(empty.seeds.length,0);assert.equal(empty.excludedQuotes.length,1);
  assert.doesNotThrow(()=>addWholeQualityObservationRecall(buildWholeQualityQuery(issue()),empty));
  const forged=structuredClone(input);forged.results[0].quotes[0].matchedQuoteUtf16End--;
  assert.throws(()=>buildWholeQualityObservationRecall(issue(),forged),/UTF-16 binding/);
});
