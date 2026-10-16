import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {buildRetrievalIndex,rankWithRecall} from '../runtime/retrieval.mjs';
import {
  buildWholeQualityQuery,buildWholeQualityObservationRecall,addWholeQualityObservationRecall,
  retrieveWholeQualityEvidence,retrieveWholeQualityEvidenceWithObservationRecall,buildWholeQualityMaterialUseLedger,buildWholeQualityApplicabilityReview,
  buildWholeQualityFinalTextUseEvidence,buildWholeQualityC06ReferenceList,
} from '../runtime/whole-quality-retrieval.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const issue = overrides => ({issueId:'S01-known-information-subtraction',question:'怎样删去已知账目解释，同时保留工钱、料钱两个方向和未决责任？',
  storyProblem:'相邻章节反复解释相同账目。',expectedEffect:'减少重复，同时保留两笔钱的方向和不替当事人定论的边界。',
  failureCriterion:'删后混淆钱款方向，或替人物确定尚未核清的责任。',counterConsideration:'若减法损坏事实边界，应保留原稿。',
  sceneQueries:['已知信息减法 两笔钱 未决责任'],...overrides});

const row = (id,text) => ({sourceId:id,title:`来源 ${id}`,sourceSha256:id.repeat(64),textVersion:`text-${id}`,
  completeness:'unknown',analysis:{version:`analysis-${id}`,coverage:{scope:'full',notes:[]},units:[],limitations:[]}});
const entries = (r,text) => buildRetrievalIndex(r,text).entries.map(entry=>({...entry,row:r}));

test('reviewed observation seed adds an exact source window that plain lexical recall misses',()=>{
  const directText='普通开头\n她把工钱和料钱分开登记，责任暂时不替母亲定论。\n普通结尾';
  const noisyText='合伙人退出协商，公开报复并让对方破产。';
  const direct=row('b',directText),noisy=row('a',noisyText),line='她把工钱和料钱分开登记，责任暂时不替母亲定论。';
  const lineStart='普通开头\n'.length;
  const seed={seedId:'observation-seed-b',observationQueryHash:'c'.repeat(64),observationId:'legacy:b:ending_mechanism',recordType:'legacy_card_observation',
    sourceId:direct.sourceId,sourceSha256:direct.sourceSha256,textVersion:direct.textVersion,analysisVersion:direct.analysis.version,
    lineStart:2,lineEnd:2,lineWindowUtf16Start:lineStart,lineWindowUtf16End:lineStart+line.length,lineWindowBodySha256:hash(line),
    quote:line,quoteUtf16Start:lineStart,quoteUtf16End:lineStart+line.length,quoteSha256:hash(line)};
  const all=[...entries(noisy,noisyText),...entries(direct,directText)];
  const query={query:'合伙人退出协商',evidenceType:'narrative',budget:{maxCandidates:20,maxUnits:6,maxChars:12000},recall:{focus:'scene',queries:[]}};
  assert(!rankWithRecall(all,query).some(candidate=>candidate.row.sourceId==='b'));
  const recalled=rankWithRecall(all,{...query,recall:{...query.recall,observationSeeds:[seed]}});
  const candidate=recalled.find(item=>item.row.sourceId==='b');
  assert(candidate);assert.equal(candidate.raw,line);assert(candidate.recallOrigins.some(origin=>origin.kind==='observation'));
  const stale=structuredClone(seed);stale.sourceSha256='d'.repeat(64);
  assert(!rankWithRecall(all,{...query,recall:{...query.recall,observationSeeds:[stale]}}).some(candidate=>candidate.row.sourceId==='b'));
});

test('whole-quality observation artifact preserves exact evidence and augments rather than truncates the query',()=>{
  const question=issue().question,line='她把工钱和料钱分开登记。',start=4;
  const result={contractVersion:'narrative-observation-query-1',queryHash:'e'.repeat(64),status:'covered',request:{query:question},results:[{
    recordType:'legacy_card_observation',id:'legacy:source-b:ending_mechanism',source:{sourceId:'source-b',sourceSha256:'b'.repeat(64),textVersion:'text-b'},
    currentReviewState:{analysisVersion:'analysis-b',reviewRecordId:null},quotes:[{quote:line,lineStart:2,lineEnd:2,lineWindowUtf16Start:start,
      lineWindowUtf16End:start+line.length,lineWindowBodySha256:hash(line),matchedCueUtf16Start:start,matchedCueUtf16End:start+line.length}],
  }]};
  const recall=buildWholeQualityObservationRecall(issue(),result);
  assert.equal(recall.seeds.length,1);assert.equal(recall.seeds[0].quote,line);
  const augmented=addWholeQualityObservationRecall(buildWholeQualityQuery(issue()),recall);
  assert.equal(augmented.query,question);assert.equal(augmented.recall.observationSeeds[0].sourceSha256,'b'.repeat(64));
});

test('whole-quality observation recall preserves a verified quote with trailing source whitespace',()=>{
  const question=issue().question,quote='她把责任留在账本里。\n ',start=7;
  const result={contractVersion:'narrative-observation-query-1',queryHash:'9'.repeat(64),status:'covered',request:{query:question},results:[{
    recordType:'checked_analysis_unit',id:'analysis:source-w:u06',source:{sourceId:'source-w',sourceSha256:'c'.repeat(64),textVersion:'text-w'},
    currentReviewState:{analysisVersion:'analysis-w',reviewRecordId:'review-w'},quotes:[{quote,lineStart:6,lineEnd:7,lineWindowUtf16Start:start,
      lineWindowUtf16End:start+quote.length,lineWindowBodySha256:hash(quote),matchedQuoteUtf16Start:start,matchedQuoteUtf16End:start+quote.length}],
  }]};
  const recall=buildWholeQualityObservationRecall(issue(),result);
  assert.equal(recall.seeds.length,1);assert.equal(recall.seeds[0].quote,quote);assert.equal(recall.seeds[0].quoteSha256,hash(quote));
});

test('observation-aware executor makes one explicit observation query and one normal retrieval call',async()=>{
  let observationCalls=0,retrievalCalls=0;
  const observationResult={contractVersion:'narrative-observation-query-1',queryHash:'f'.repeat(64),status:'uncovered',
    request:{query:issue().question},results:[]};
  const result=await retrieveWholeQualityEvidenceWithObservationRecall({issue:issue(),
    queryNarrativeObservations:async request=>{observationCalls++;assert.equal(request.query,issue().question);return observationResult;},
    retrieveKnowledge:async query=>{retrievalCalls++;return packet(query,[]);}});
  assert.equal(observationCalls,1);assert.equal(retrievalCalls,1);assert.equal(result.packet.status,'uncovered');
  assert.equal(result.observationRecall.availableSeedCount,0);
});

const reference = (sourceId,lineStart=1,lineEnd=2) => ({sourceId,sourceSha256:sourceId.repeat(64),textVersion:`text-${sourceId}`,
  analysisVersion:`analysis-${sourceId}`,unitIds:[],lineStart,lineEnd});
const material = (id,sourceId=id) => {
  const content=`【原文参考；不作为已发布分析】\n${id} 的连续场景原文`;
  return {id,title:`材料 ${id}`,kind:'retrieved',use:'raw_reference',content,sha256:hash(content),references:[reference(sourceId)],
    selectionReason:'固定回归夹具，仍需功能适用判断。',limitations:['命中不等于直接适配。']};
};
const packet = (query,materials) => ({contractVersion:'v04-contract-1',packetId:'packet-real-failures',status:materials.length?'matched':'uncovered',query,materials,
  candidates:materials.map(item=>({id:item.id,sourceId:item.references[0].sourceId,reason:'固定候选'})),usedChars:materials.reduce((sum,item)=>sum+item.content.length,0),
  limits:['真实失败回归只检验合同，不宣称文学效果。']});

async function retrievalFor(materials) {
  return retrieveWholeQualityEvidence({issue:issue(),retrieveKnowledge:async query=>packet(query,materials)});
}

test('S01 broad mechanisms cannot masquerade as a directly suitable material',async()=>{
  const retrieval=await retrievalFor([material('death-escalation','a'),material('money-cure','b')]);
  const evidence=retrieval.evidenceBundle.materials.map(item=>item.evidence[0].evidenceId);
  const review=buildWholeQualityApplicabilityReview(retrieval,[
    {materialId:'death-escalation',fit:'mechanism_only',reason:'只说明重复伴随升级，依赖死亡惩罚。',evidenceIds:[evidence[0]],transferBoundary:'只可参考每次重复新增动作；不可迁移死亡或报复。'},
    {materialId:'money-cure',fit:'inapplicable',reason:'金额推动治愈归属，没有未决责任。',evidenceIds:[]},
  ],{noSuitableReason:'没有材料同时覆盖已知信息减法、两笔方向和未决责任。'});
  assert.equal(review.noSuitableMaterial,true);assert.deepEqual(review.directMaterialIds,[]);assert.deepEqual(review.mechanismOnlyMaterialIds,['death-escalation']);
});

test('S03 high lexical overlap remains an explicit no-material result',async()=>{
  const retrieval=await retrievalFor([material('revenge-bankruptcy','c')]);
  const review=buildWholeQualityApplicabilityReview(retrieval,[{materialId:'revenge-bankruptcy',fit:'inapplicable',
    reason:'有合伙、退出和素材词面，但机制依赖报复性破产。',evidenceIds:[]}],
  {noSuitableReason:'没有无反派创作伙伴通过具体工作动作完成退出协商的材料。'});
  assert.equal(review.noSuitableMaterial,true);assert.match(review.noSuitableReason,/无反派/);
  const empty=await retrievalFor([]);
  assert.equal(buildWholeQualityApplicabilityReview(empty,[],{noSuitableReason:'候选为空。'}).noSuitableMaterial,true);
});

test('final manuscript evidence verifies UTF-16 text presence without claiming effect',async()=>{
  const retrieval=await retrievalFor([material('direct-ledger','d')]);
  const evidenceId=retrieval.evidenceBundle.materials[0].evidence[0].evidenceId;
  const ledger=buildWholeQualityMaterialUseLedger(retrieval,[{materialId:'direct-ledger',decision:'used',reason:'用于区分两笔方向。',
    evidenceIds:[evidenceId],changeGroupIds:['change-ledger'],appliedAs:'以登记动作保留未决责任。'}]);
  const body='她把工钱写在左页，把料钱写在右页。责任一栏仍空着。',quote='责任一栏仍空着。',start=body.indexOf(quote);
  const finalEvidence=buildWholeQualityFinalTextUseEvidence({materialUseLedger:ledger,chapters:[{id:'ch-10',title:'第十章',body}],records:[{
    materialId:'direct-ledger',status:'located',findings:[{chapterId:'ch-10',start,quote,changeGroupId:'change-ledger',sourceEvidenceIds:[evidenceId],
      textRole:'visible_application',explanation:'正文可见未决责任仍未被人物代为定论。'}]}]});
  assert.equal(finalEvidence.allUsedMaterialsLocated,true);assert.equal(finalEvidence.automaticEffectClaim,false);assert.equal(finalEvidence.literaryEffect,'NOT_COMPUTED');
  const bad={chapterId:'ch-10',start:start+1,quote,changeGroupId:'change-ledger',sourceEvidenceIds:[evidenceId],
    textRole:'visible_application',explanation:'正文可见未决责任仍未被人物代为定论。'};
  assert.throws(()=>buildWholeQualityFinalTextUseEvidence({materialUseLedger:ledger,chapters:[{id:'ch-10',body}],records:[{materialId:'direct-ledger',status:'located',findings:[bad]}]}),/UTF-16/);
});

test('C06 export is finite, versioned and never presented as a 136-source comparison',async()=>{
  const retrieval=await retrievalFor([material('used-one','e'),material('candidate-two','f')]);
  const evidenceId=retrieval.evidenceBundle.materials[0].evidence[0].evidenceId;
  const ledger=buildWholeQualityMaterialUseLedger(retrieval,[
    {materialId:'used-one',decision:'used',reason:'采用。',evidenceIds:[evidenceId],changeGroupIds:['c1'],appliedAs:'局部动作。'},
    {materialId:'candidate-two',decision:'not_used',reason:'仅保留为有限对照。',evidenceIds:[],changeGroupIds:[]},
  ]);
  const list=buildWholeQualityC06ReferenceList({retrieval,materialUseLedger:ledger,includeMaterialIds:['candidate-two']});
  assert.equal(list.completeLibraryComparison,false);assert.equal(list.coverage,'finite_explicit_material_set');assert.equal(list.referenceCount,2);
  assert(list.references.every(item=>item.scope==='fragment'&&hash(item.content)===item.contentSha256));
});
