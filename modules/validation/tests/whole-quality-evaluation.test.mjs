import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  prepareWholeQualityEvaluation,prepareStandaloneIndependentReading,prepareFollowupIndependentReading,validateStandaloneIndependentReading,mergeStandaloneIndependentReading,validateIndependentReading,validateBlindPairReview,validateGoalAudit,
  finalizeWholeQualityEvaluation,wholeQualitySha256,
} from '../runtime/whole-quality-evaluation.mjs';

const baseline=[
  {id:'ch-1',title:'门口',body:'雨停了。林遥站在门口，没有回答母亲的问题。'},
  {id:'ch-2',title:'车站',body:'她拿着车票，却仍等母亲替她决定去留。'},
];
const candidate=[
  {id:'ch-1',title:'门口',body:'雨停了。林遥告诉母亲：“我自己决定去南城。”'},
  {id:'ch-2',title:'车站',body:'她撕掉母亲替她买的返程票，独自登上南城的车。'},
];
const source=(chapterId,quote)=>({chapterId,quote,start:baseline.find(item=>item.id===chapterId).body.indexOf(quote)});
const request={caseId:'synthetic-whole-quality',baselineChapters:baseline,candidate:{mode:'revised',chapters:candidate},readerIds:['r-left','r-right'],goals:[{
  id:'g-agency',statement:'让林遥的离开成为她自己的选择',claimType:'editorial_hypothesis',
  sourceEvidence:[source('ch-2','仍等母亲替她决定去留')],counterCase:[source('ch-1','没有回答母亲的问题')],
  expectedEffect:'读者能在结尾前看见她作出选择并执行',failureCriterion:'她仍由母亲代为决定，或只口头表态而没有行动',
  requiredOutcomes:[{id:'o-cognition',dimension:'cognition',description:'林遥明确说出自己的决定'},{id:'o-action',dimension:'action',description:'林遥执行离开的行动'}],
}]};

const prepared=()=>prepareWholeQualityEvaluation(structuredClone(request));
const cite=(manuscript,chapterId,quote)=>({blindId:manuscript.blindId,chapterId,quote,start:manuscript.chapters.find(item=>item.id===chapterId).body.indexOf(quote)});

function independentRecords(bundle){
  return bundle.independentMergeTargets.map(packet=>({schemaVersion:packet.schemaVersion,packetSha256:packet.packetSha256,readerId:packet.readerId,
    entries:packet.manuscripts.map((manuscript,index)=>({blindId:manuscript.blindId,readScope:'whole',overallImpression:index?'结尾动作更明确':'人物仍显犹疑',claims:[{
      id:`${packet.readerId}-${manuscript.blindId}`,claimType:index?'editorial_hypothesis':'hard_fact',statement:'独立初读观察',
      evidence:[cite(manuscript,'ch-1',manuscript.chapters[0].body.slice(0,3))],
    }]})),
  }));
}

function pairRecords(bundle,independent,preferences=['first','second']){
  return bundle.blindPairPackets.map((packet,index)=>{
    const first=packet.manuscripts[0],second=packet.manuscripts[1];
    return {schemaVersion:packet.schemaVersion,packetSha256:packet.packetSha256,readerId:packet.readerId,
      independentRecordSha256:wholeQualitySha256(independent[index]),preference:preferences[index],comparisons:[{
        id:`cmp-${packet.readerId}`,claimType:'editorial_hypothesis',statement:'两稿的人物主动性呈现不同',severeHarm:false,
        evidence:[cite(first,'ch-1',first.chapters[0].body.slice(0,3)),cite(second,'ch-1',second.chapters[0].body.slice(0,3))],
      }]};
  });
}

function goalRecord(bundle,pairs,{status='implemented',outcomeStatuses=['implemented','implemented']}={}){
  const packet=bundle.goalPacket,b=packet.baseline,c=packet.candidate;
  const baselineQuotes=['没有回答母亲的问题','仍等母亲替她决定去留'];
  const candidateQuotes=['我自己决定去南城','独自登上南城的车'];
  return {schemaVersion:packet.schemaVersion,packetSha256:packet.packetSha256,blindPairRecordSha256s:pairs.map(wholeQualitySha256),goalAssessments:[{
    goalId:'g-agency',status,rationale:'逐项核对认知表态和实际行动',failureCriterionMet:status!=='implemented',outcomes:['o-cognition','o-action'].map((outcomeId,index)=>({
      outcomeId,status:outcomeStatuses[index],baselineEvidence:[cite(b,index?'ch-2':'ch-1',baselineQuotes[index])],candidateEvidence:[cite(c,index?'ch-2':'ch-1',candidateQuotes[index])],explanation:'原稿与候选的逐字证据显示变化',
    })),
  }]};
}

test('prepare hides identities and goals until post-blind audit, with opposite reader order',()=>{
  const {publicBundle,privateBinding}=prepared();
  const independentOrders=publicBundle.independentMergeTargets.map(item=>item.manuscripts.map(m=>m.blindId).join('>'));
  assert.deepEqual(new Set(independentOrders),new Set(['A>B','B>A']));
  assert.deepEqual(publicBundle.blindPairPackets.map(item=>item.instructions.order.join('>')),independentOrders);
  const blindJson=JSON.stringify([publicBundle.independentMergeTargets,publicBundle.blindPairPackets]);
  assert.equal(blindJson.includes('baseline'),false);assert.equal(blindJson.includes('candidate'),false);
  assert.equal(blindJson.includes('让林遥'),false);assert.equal(blindJson.includes('g-agency'),false);
  assert.deepEqual(new Set(Object.values(privateBinding.bindings)),new Set(['baseline','candidate']));
});

test('a frozen creation request can start an original-only reading and merge after the candidate is ready',()=>{
  const standalone=prepareStandaloneIndependentReading({requestId:'synthetic-whole-quality',readerId:'r-left',chapters:baseline,projectTitle:'must not leak',instruction:'known issues must not leak'});
  assert.equal(JSON.stringify(standalone).includes('must not leak'),false);assert.equal(standalone.manuscripts.length,1);
  const manuscript=standalone.manuscripts[0],record={schemaVersion:standalone.schemaVersion,packetSha256:standalone.packetSha256,readerId:'r-left',entries:[{
    blindId:'M',readScope:'whole',overallImpression:'人物在结尾仍然犹疑',claims:[{id:'preflight-claim',claimType:'editorial_hypothesis',statement:'行动选择不够明确',evidence:[cite(manuscript,'ch-2','仍等母亲替她决定去留')]}],
  }]};
  assert.equal(validateStandaloneIndependentReading(standalone,record).ok,true);
  const {publicBundle}=prepared(),full=independentRecords(publicBundle)[0];
  const followupPacket=prepareFollowupIndependentReading({bundle:publicBundle,standalonePacket:standalone,standaloneRecord:record});
  const followupEntry=structuredClone(full.entries[1]);followupEntry.blindId='M';followupEntry.claims.forEach(item=>item.evidence.forEach(value=>{value.blindId='M';}));
  const followupRecord={schemaVersion:followupPacket.schemaVersion,packetSha256:followupPacket.packetSha256,readerId:'r-left',entries:[followupEntry]};
  const merged=mergeStandaloneIndependentReading({bundle:publicBundle,standalonePacket:standalone,standaloneRecord:record,followupPacket,followupRecord});
  assert.equal(validateIndependentReading(publicBundle,merged).ok,true);assert.equal(merged.entries[0].claims[0].id,'preflight-claim');
});

test('standalone record readerId must exactly match its packet',()=>{
  const packet=prepareStandaloneIndependentReading({caseId:'reader-binding',readerId:'expected-reader',manuscriptChapters:baseline});
  const manuscript=packet.manuscripts[0],record={schemaVersion:packet.schemaVersion,packetSha256:packet.packetSha256,readerId:'other-reader',entries:[{blindId:'M',readScope:'whole',overallImpression:'完整读后感',claims:[{id:'c',claimType:'hard_fact',statement:'雨停了',evidence:[cite(manuscript,'ch-1','雨停了')]}]}]};
  assert.throws(()=>validateStandaloneIndependentReading(packet,record),error=>error.code==='INDEPENDENT_PACKET_BINDING');
});

test('valid staged records finalize without voting or a literary pass',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent),goal=goalRecord(publicBundle,pairs);
  independent.forEach(item=>assert.equal(validateIndependentReading(publicBundle,item).ok,true));
  pairs.forEach(item=>assert.equal(validateBlindPairReview(publicBundle,item).ok,true));
  assert.equal(validateGoalAudit(publicBundle,goal).ok,true);
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.goalFulfillment,true);assert.equal(result.automaticAdoption,false);assert.equal(result.literaryPass,'NOT_COMPUTED');
  assert.equal(result.adoptionBoundary,'eligible_for_editorial_consideration');
  assert.equal(result.voteResult,null);assert.equal(result.totalScore,null);
});

test('forged or stale quotations are rejected with exact manuscript traceback',()=>{
  const {publicBundle}=prepared(),record=independentRecords(publicBundle)[0];
  record.entries[0].claims[0].evidence[0].quote='不存在的引文';
  assert.throws(()=>validateIndependentReading(publicBundle,record),error=>error.code==='CLAIM_QUOTE');
});

test('hard facts and editorial hypotheses must be explicitly classified',()=>{
  const {publicBundle}=prepared(),record=independentRecords(publicBundle)[0];
  record.entries[0].claims[0].claimType='opinion';
  assert.throws(()=>validateIndependentReading(publicBundle,record),error=>error.code==='CLAIM_VALUE');
});

test('score and voting fields are rejected rather than aggregated',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),record=pairRecords(publicBundle,independent)[0];
  record.totalScore=99;
  assert.throws(()=>validateBlindPairReview(publicBundle,record),error=>error.code==='SCORE_OR_VOTE_FORBIDDEN');
});

test('a pair comparison must trace evidence to both anonymous manuscripts',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),record=pairRecords(publicBundle,independent)[0];
  record.comparisons[0].evidence=record.comparisons[0].evidence.slice(0,1);
  assert.throws(()=>validateBlindPairReview(publicBundle,record),error=>error.code==='PAIR_TWO_SIDED_EVIDENCE');
});

test('internal coherence or blind preference cannot turn an unimplemented plan into goal achievement',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent,['second','first']);
  pairs.forEach(item=>item.comparisons[0].statement='候选稿整体更自洽');
  const goal=goalRecord(publicBundle,pairs,{status:'not_implemented',outcomeStatuses:['not_implemented','not_implemented']});
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.goalFulfillment,false);assert.equal(result.adoptionBoundary,'goals_not_achieved');assert.deepEqual(result.unimplementedGoalIds,['g-agency']);
});

test('unchanged evidence cannot support an implemented outcome',()=>{
  const noChange=structuredClone(request);noChange.candidate={mode:'no_change',chapters:baseline};
  const {publicBundle}=prepareWholeQualityEvaluation(noChange),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent),record=goalRecord(publicBundle,pairs);
  const packet=publicBundle.goalPacket;
  record.goalAssessments[0].outcomes.forEach((outcome,index)=>{
    const quote=index?'仍等母亲替她决定去留':'没有回答母亲的问题',chapterId=index?'ch-2':'ch-1';
    outcome.baselineEvidence=[cite(packet.baseline,chapterId,quote)];outcome.candidateEvidence=[cite(packet.candidate,chapterId,quote)];
  });
  assert.throws(()=>validateGoalAudit(publicBundle,record),error=>['IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE','NO_CHANGE_CANNOT_IMPLEMENT_GOAL'].includes(error.code));
});

test('explicit no-change may have no goals without vacuous goal achievement',()=>{
  const input=structuredClone(request);input.candidate={mode:'no_change',chapters:baseline};input.goals=[];
  const {publicBundle}=prepareWholeQualityEvaluation(input),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent);
  const packet=publicBundle.goalPacket,goal={schemaVersion:packet.schemaVersion,packetSha256:packet.packetSha256,blindPairRecordSha256s:pairs.map(wholeQualitySha256),goalAssessments:[]};
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.goalFulfillment,'not_applicable');assert.equal(result.adoptionBoundary,'no_change');assert.equal(result.qualityGain,'NO_QUALITY_GAIN_ASSERTED');
  const revised=structuredClone(request);revised.goals=[];assert.throws(()=>prepareWholeQualityEvaluation(revised),error=>error.code==='GOALS_REQUIRED'||error.code==='REVISED_REQUIRES_GOALS');
});

test('the whole public bundle is hash-bound across stages',()=>{
  const {publicBundle}=prepared(),record=independentRecords(publicBundle)[0];
  publicBundle.goalPacket.goals[0].statement='被篡改的目标';
  assert.throws(()=>validateIndependentReading(publicBundle,record),error=>error.code==='BUNDLE_TAMPERED');
});

test('a severe harm blocks candidate consideration even when goals were implemented',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent);
  pairs[0].comparisons[0].severeHarm=true;
  const goal=goalRecord(publicBundle,pairs);
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.adoptionBoundary,'preserve_original');assert.equal(result.severeHarms.length,1);
});

test('divergent readings are preserved and force a narrowed recheck',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent,['first','no_clear_preference']),goal=goalRecord(publicBundle,pairs);
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.adoptionBoundary,'narrowed_recheck_required');assert.equal(result.divergentReadings.preferenceDivergence,true);assert.equal(result.divergentReadings.semanticDivergence,'NOT_PROGRAMMATICALLY_ASSESSED');assert.equal(result.divergentReadings.records.length,2);
});

test('matching no-clear-preference readings are not preference divergence',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent,['no_clear_preference','no_clear_preference']),goal=goalRecord(publicBundle,pairs);
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.adoptionBoundary,'eligible_for_editorial_consideration');assert.equal(result.divergentReadings.preferenceDivergence,false);
  assert.equal(result.divergentReadings.semanticDivergence,'NOT_PROGRAMMATICALLY_ASSESSED');
});

test('partially implemented goals require a narrowed recheck and are not fulfilled',()=>{
  const {publicBundle}=prepared(),independent=independentRecords(publicBundle),pairs=pairRecords(publicBundle,independent),goal=goalRecord(publicBundle,pairs,{status:'partially_implemented',outcomeStatuses:['implemented','partially_implemented']});
  const result=finalizeWholeQualityEvaluation({bundle:publicBundle,independentRecords:independent,pairRecords:pairs,goalRecord:goal});
  assert.equal(result.goalFulfillment,false);assert.equal(result.adoptionBoundary,'narrowed_recheck_required');
});

test('CLI is offline, stdout-only, and usable for prepare',()=>{
  const dir=mkdtempSync(join(tmpdir(),'whole-quality-')),path=join(dir,'request.json');writeFileSync(path,JSON.stringify(request));
  const cli=fileURLToPath(new URL('../runtime/whole-quality-evaluation-cli.mjs',import.meta.url));
  const run=spawnSync(process.execPath,[cli,'prepare',path],{encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(run.stdout).publicBundle.schemaVersion,'whole-quality-evaluation-1');
});
