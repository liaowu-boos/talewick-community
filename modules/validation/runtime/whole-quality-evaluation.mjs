import {createHash} from 'node:crypto';

export const LEGACY_WHOLE_QUALITY_EVALUATION_VERSION='whole-quality-evaluation-1';
export const WHOLE_QUALITY_EVALUATION_VERSION='whole-quality-evaluation-2';
export const INDEPENDENT_READING_VERSION='whole-quality-independent-reading-1';
export const LEGACY_BLIND_PAIR_VERSION='whole-quality-blind-pair-1';
export const BLIND_PAIR_VERSION='whole-quality-blind-pair-2';
export const GOAL_AUDIT_VERSION='whole-quality-goal-audit-1';
export const WHOLE_QUALITY_PROTOCOL_COMPATIBILITY=Object.freeze({
  [LEGACY_WHOLE_QUALITY_EVALUATION_VERSION]:Object.freeze({
    pairVersion:LEGACY_BLIND_PAIR_VERSION,
    privateBindingVersion:'whole-quality-private-binding-1',
    resultVersion:'whole-quality-evaluation-result-1',
    completionEvidenceVersion:'independent-review-compare-completion-evidence-1',
  }),
  [WHOLE_QUALITY_EVALUATION_VERSION]:Object.freeze({
    pairVersion:BLIND_PAIR_VERSION,
    privateBindingVersion:'whole-quality-private-binding-2',
    resultVersion:'whole-quality-evaluation-result-2',
    completionEvidenceVersion:'independent-review-compare-completion-evidence-2',
  }),
});

export class WholeQualityEvaluationError extends Error{
  constructor(code,message=code){super(message);this.name='WholeQualityEvaluationError';this.code=code;}
}

const ensure=(ok,code)=>{if(!ok)throw new WholeQualityEvaluationError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const nonempty=value=>typeof value==='string'&&value.trim().length>0;
const exact=(value,fields,code='INVALID_FIELDS')=>ensure(object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key)),code);
const sorted=value=>Array.isArray(value)?value.map(sorted):object(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
export const canonicalJson=value=>JSON.stringify(sorted(value));
export const wholeQualitySha256=value=>createHash('sha256').update(typeof value==='string'?value:canonicalJson(value)).digest('hex');

function assertNoScoreOrVote(value,path='$'){
  if(Array.isArray(value)){value.forEach((item,index)=>assertNoScoreOrVote(item,`${path}[${index}]`));return;}
  if(!object(value))return;
  for(const [key,item] of Object.entries(value)){
    ensure(!/^(?:score|scores|totalScore|aggregateScore|votes|voteCount|winnerVotes|majority|rank|ranking)$/i.test(key),'SCORE_OR_VOTE_FORBIDDEN');
    assertNoScoreOrVote(item,`${path}.${key}`);
  }
}

function chapters(value,label){
  ensure(Array.isArray(value)&&value.length>0,`${label}_CHAPTERS`);
  const ids=new Set();
  for(const chapter of value){
    exact(chapter,['id','title','body'],`${label}_CHAPTER_FIELDS`);
    ensure(nonempty(chapter.id)&&nonempty(chapter.title)&&nonempty(chapter.body)&&!ids.has(chapter.id),`${label}_CHAPTER`);
    ids.add(chapter.id);
  }
  return value;
}
const manuscriptSha256=value=>wholeQualitySha256(chapters(value,'MANUSCRIPT'));
const packetSha256=packet=>wholeQualitySha256(packet);

function citation(value,manuscript,label='EVIDENCE'){
  exact(value,['blindId','chapterId','quote','start'],`${label}_FIELDS`);
  const chapter=manuscript.chapters.find(item=>item.id===value.chapterId);
  ensure(value.blindId===manuscript.blindId&&chapter&&nonempty(value.quote)&&Number.isSafeInteger(value.start)&&value.start>=0&&chapter.body.slice(value.start,value.start+value.quote.length)===value.quote,`${label}_QUOTE`);
  return value;
}

function sourceCitation(value,source,label='SOURCE_EVIDENCE'){
  exact(value,['chapterId','quote','start'],`${label}_FIELDS`);
  const chapter=source.find(item=>item.id===value.chapterId);
  ensure(chapter&&nonempty(value.quote)&&Number.isSafeInteger(value.start)&&value.start>=0&&chapter.body.slice(value.start,value.start+value.quote.length)===value.quote,`${label}_QUOTE`);
}

function validateGoals(goals,baseline,{allowEmpty=false}={}){
  ensure(Array.isArray(goals)&&(allowEmpty||goals.length>0),'GOALS_REQUIRED');
  const goalIds=new Set();
  for(const goal of goals){
    exact(goal,['id','statement','claimType','sourceEvidence','counterCase','expectedEffect','failureCriterion','requiredOutcomes'],'GOAL_FIELDS');
    ensure(nonempty(goal.id)&&!goalIds.has(goal.id)&&nonempty(goal.statement)&&['hard_fact','editorial_hypothesis'].includes(goal.claimType)&&nonempty(goal.expectedEffect)&&nonempty(goal.failureCriterion),'GOAL_VALUE');
    goalIds.add(goal.id);
    ensure(Array.isArray(goal.sourceEvidence)&&goal.sourceEvidence.length>0&&Array.isArray(goal.counterCase)&&goal.counterCase.length>0,'GOAL_SOURCE_BALANCE');
    goal.sourceEvidence.forEach(value=>sourceCitation(value,baseline));
    goal.counterCase.forEach(value=>sourceCitation(value,baseline,'COUNTER_CASE'));
    ensure(Array.isArray(goal.requiredOutcomes)&&goal.requiredOutcomes.length>0,'GOAL_OUTCOMES');
    const outcomeIds=new Set();
    for(const outcome of goal.requiredOutcomes){
      exact(outcome,['id','dimension','description'],'GOAL_OUTCOME_FIELDS');
      ensure(nonempty(outcome.id)&&!outcomeIds.has(outcome.id)&&['action','cognition','relationship','other'].includes(outcome.dimension)&&nonempty(outcome.description),'GOAL_OUTCOME');
      outcomeIds.add(outcome.id);
    }
  }
}

function publicManuscript(blindId,chaptersValue){return {blindId,manuscriptSha256:manuscriptSha256(chaptersValue),chapters:chaptersValue};}

/**
 * Freeze two manuscripts, two opposite reader orders, and a post-blind goal packet.
 * No model, provider, network, filesystem, or editor operation occurs here.
 */
export function prepareWholeQualityEvaluation({caseId,baselineChapters,candidate,goals,readerIds=['reader-1','reader-2']}={}){
  ensure(nonempty(caseId),'CASE_ID');
  const baseline=chapters(baselineChapters,'BASELINE');
  exact(candidate,['mode','chapters'],'CANDIDATE_FIELDS');
  ensure(['revised','no_change'].includes(candidate.mode),'CANDIDATE_MODE');
  const next=chapters(candidate.chapters,'CANDIDATE');
  ensure(JSON.stringify(baseline.map(item=>item.id))===JSON.stringify(next.map(item=>item.id)),'CHAPTER_TOPOLOGY');
  const baselineHash=manuscriptSha256(baseline),candidateHash=manuscriptSha256(next);
  if(candidate.mode==='no_change')ensure(baselineHash===candidateHash,'NO_CHANGE_MISMATCH');
  validateGoals(goals,baseline,{allowEmpty:candidate.mode==='no_change'});
  if(candidate.mode==='revised')ensure(goals.length>0,'REVISED_REQUIRES_GOALS');
  ensure(Array.isArray(readerIds)&&readerIds.length===2&&readerIds.every(nonempty)&&new Set(readerIds).size===2,'TWO_READERS_REQUIRED');

  const baselineIsA=parseInt(wholeQualitySha256({caseId,baselineHash,candidateHash}).slice(0,2),16)%2===0;
  const bindings={A:baselineIsA?'baseline':'candidate',B:baselineIsA?'candidate':'baseline'};
  const byRole={baseline,candidate:next};
  const manuscripts={A:publicManuscript('A',byRole[bindings.A]),B:publicManuscript('B',byRole[bindings.B])};
  const baselineBlindId=baselineIsA?'A':'B',candidateBlindId=baselineIsA?'B':'A';
  const orders=[[baselineBlindId,candidateBlindId],[candidateBlindId,baselineBlindId]];
  const independentMergeTargets=readerIds.map((readerId,index)=>{
    const packet={schemaVersion:INDEPENDENT_READING_VERSION,caseId,readerId,stage:'independent_reading',instructions:{readScope:'whole',identityHidden:true,goalsHidden:true,knownIssuesHidden:true,recordEachManuscriptBeforeComparison:true,claimTypes:['hard_fact','editorial_hypothesis']},manuscripts:orders[index].map(id=>manuscripts[id])};
    return {...packet,packetSha256:packetSha256(packet)};
  });
  const blindPairPackets=readerIds.map((readerId,index)=>{
    const packet={schemaVersion:BLIND_PAIR_VERSION,caseId,readerId,stage:'blind_pair',instructions:{identityHidden:true,goalsHidden:true,knownIssuesHidden:true,order:orders[index],scoresForbidden:true,votingForbidden:true,severeHarmMustBeReported:true,severeHarmAttributionRequired:true},manuscripts:orders[index].map(id=>manuscripts[id])};
    return {...packet,packetSha256:packetSha256(packet)};
  });
  const goalPacket={schemaVersion:GOAL_AUDIT_VERSION,caseId,stage:'goal_audit',candidateMode:candidate.mode,bindings,baseline:manuscripts[baselineIsA?'A':'B'],candidate:manuscripts[baselineIsA?'B':'A'],goals,
    instructions:{performedAfterBlindPair:true,coherenceOrPreferenceCannotProveImplementation:true,eachRequiredOutcomeMustBeAudited:true,failureCriterionMustBeChecked:true}};
  const publicGoalPacket={...goalPacket,packetSha256:packetSha256(goalPacket)};
  const publicBundleBody={schemaVersion:WHOLE_QUALITY_EVALUATION_VERSION,caseId,independentMergeTargets,blindPairPackets,goalPacket:publicGoalPacket};
  const publicBundle={...publicBundleBody,bundleSha256:wholeQualitySha256(publicBundleBody)};
  return {publicBundle,privateBinding:{schemaVersion:'whole-quality-private-binding-2',caseId,bindings,baselineManuscriptSha256:baselineHash,candidateManuscriptSha256:candidateHash,bundleSha256:publicBundle.bundleSha256}};
}

function validateBundle(bundle){
  ensure(object(bundle)&&[LEGACY_WHOLE_QUALITY_EVALUATION_VERSION,WHOLE_QUALITY_EVALUATION_VERSION].includes(bundle.schemaVersion)&&nonempty(bundle.bundleSha256),'BUNDLE_VERSION');
  const {bundleSha256,...body}=bundle;ensure(bundleSha256===wholeQualitySha256(body),'BUNDLE_TAMPERED');
  const pairVersion=WHOLE_QUALITY_PROTOCOL_COMPATIBILITY[bundle.schemaVersion].pairVersion;
  ensure(Array.isArray(bundle.blindPairPackets)&&bundle.blindPairPackets.length===2&&bundle.blindPairPackets.every(packet=>packet.schemaVersion===pairVersion),'BUNDLE_PAIR_VERSION');
}

function findPacket(bundle,stage,readerId){
  validateBundle(bundle);
  const list=stage==='independent'?bundle.independentMergeTargets:bundle.blindPairPackets;
  const packet=list?.find(item=>item.readerId===readerId);
  ensure(packet,'PACKET_NOT_FOUND');
  const {packetSha256:stored,...body}=packet;
  ensure(stored===packetSha256(body),'PACKET_TAMPERED');
  return packet;
}

function verifyPacket(packet,version){
  ensure(object(packet)&&packet.schemaVersion===version&&Array.isArray(packet.manuscripts),'PACKET_VERSION');
  const {packetSha256:stored,...body}=packet;ensure(stored===packetSha256(body),'PACKET_TAMPERED');return packet;
}

function compatibilityFor(protocolVersion){
  const compatibility=WHOLE_QUALITY_PROTOCOL_COMPATIBILITY[protocolVersion];
  ensure(compatibility,'PROTOCOL_VERSION_UNSUPPORTED');return compatibility;
}

function pairManuscripts(bundle,compatibility){
  const snapshots=bundle.blindPairPackets.map(packet=>{
    verifyPacket(packet,compatibility.pairVersion);
    ensure(packet.manuscripts.length===2,'PRIVATE_BINDING_INVALID');
    const byId=new Map();
    for(const manuscript of packet.manuscripts){
      ensure(object(manuscript)&&nonempty(manuscript.blindId)&&nonempty(manuscript.manuscriptSha256)&&!byId.has(manuscript.blindId),'PRIVATE_BINDING_INVALID');
      ensure(manuscript.manuscriptSha256===manuscriptSha256(manuscript.chapters),'PRIVATE_BINDING_INVALID');
      byId.set(manuscript.blindId,manuscript);
    }
    return byId;
  });
  const blindIds=[...snapshots[0].keys()].sort();
  ensure(blindIds.length===2&&snapshots.every(snapshot=>canonicalJson([...snapshot.keys()].sort())===canonicalJson(blindIds)
    &&blindIds.every(id=>snapshot.get(id).manuscriptSha256===snapshots[0].get(id).manuscriptSha256)),'PRIVATE_BINDING_INVALID');
  return snapshots[0];
}

/** Validate the exact task/bundle/private/result/completion version row and manuscript identity binding. */
export function validateWholeQualityProtocolArtifacts({protocolVersion,bundle,privateBinding,result,completionEvidence}={}){
  const compatibility=compatibilityFor(protocolVersion);
  validateBundle(bundle);ensure(bundle.schemaVersion===protocolVersion,'BUNDLE_PROTOCOL_VERSION');
  const manuscripts=pairManuscripts(bundle,compatibility),blindIds=[...manuscripts.keys()].sort();
  exact(privateBinding,['schemaVersion','caseId','bindings','baselineManuscriptSha256','candidateManuscriptSha256','bundleSha256'],'PRIVATE_BINDING_FIELDS');
  ensure(privateBinding.schemaVersion===compatibility.privateBindingVersion&&privateBinding.caseId===bundle.caseId
    &&privateBinding.bundleSha256===bundle.bundleSha256&&object(privateBinding.bindings),'PRIVATE_BINDING_INVALID');
  const bindingIds=Object.keys(privateBinding.bindings).sort(),roles=Object.values(privateBinding.bindings).sort();
  ensure(canonicalJson(bindingIds)===canonicalJson(blindIds)&&canonicalJson(roles)===canonicalJson(['baseline','candidate'])
    &&object(bundle.goalPacket?.bindings)&&canonicalJson(privateBinding.bindings)===canonicalJson(bundle.goalPacket.bindings),'PRIVATE_BINDING_INVALID');
  for(const blindId of blindIds){
    const role=privateBinding.bindings[blindId],manuscript=manuscripts.get(blindId),expectedHash=role==='baseline'?privateBinding.baselineManuscriptSha256:privateBinding.candidateManuscriptSha256;
    ensure(manuscript.manuscriptSha256===expectedHash,'PRIVATE_BINDING_INVALID');
  }
  for(const role of ['baseline','candidate']){
    const blindId=bindingIds.find(id=>privateBinding.bindings[id]===role),goalManuscript=bundle.goalPacket?.[role],manuscript=manuscripts.get(blindId);
    ensure(goalManuscript?.blindId===blindId&&goalManuscript.manuscriptSha256===manuscript.manuscriptSha256
      &&goalManuscript.manuscriptSha256===manuscriptSha256(goalManuscript.chapters),'PRIVATE_BINDING_INVALID');
  }
  if(result!==undefined)ensure(object(result)&&result.schemaVersion===compatibility.resultVersion&&result.caseId===bundle.caseId
    &&completionEvidence!==undefined,'RESULT_PROTOCOL_VERSION');
  if(completionEvidence!==undefined)ensure(object(completionEvidence)&&completionEvidence.schemaVersion===compatibility.completionEvidenceVersion,'COMPLETION_PROTOCOL_VERSION');
  return structuredClone(compatibility);
}

/** Create an identity/goal-free first-reading packet before a candidate exists. */
export function prepareStandaloneIndependentReading(input={}){
  const caseId=input.caseId??input.requestId,readerId=input.readerId??'reader-1',source=input.manuscriptChapters??input.chapters;
  ensure(nonempty(caseId)&&nonempty(readerId),'STANDALONE_ID');
  const manuscript=publicManuscript('M',chapters(source,'STANDALONE'));
  const packet={schemaVersion:INDEPENDENT_READING_VERSION,caseId,readerId,stage:'independent_reading',instructions:{readScope:'whole',identityHidden:true,goalsHidden:true,knownIssuesHidden:true,recordEachManuscriptBeforeComparison:true,claimTypes:['hard_fact','editorial_hypothesis']},manuscripts:[manuscript]};
  return {...packet,packetSha256:packetSha256(packet)};
}

function claim(value,manuscripts,label='CLAIM'){
  exact(value,['id','claimType','statement','evidence'],`${label}_FIELDS`);
  ensure(nonempty(value.id)&&['hard_fact','editorial_hypothesis'].includes(value.claimType)&&nonempty(value.statement)&&Array.isArray(value.evidence)&&value.evidence.length>0,`${label}_VALUE`);
  value.evidence.forEach(item=>{
    const manuscript=manuscripts.find(entry=>entry.blindId===item.blindId);
    ensure(manuscript,`${label}_BLIND_ID`);citation(item,manuscript,label);
  });
}

function validateIndependentRecordAgainstPacket(packet,record){
  assertNoScoreOrVote(record);
  exact(record,['schemaVersion','packetSha256','readerId','entries'],'INDEPENDENT_RECORD_FIELDS');
  ensure(record.schemaVersion===INDEPENDENT_READING_VERSION,'INDEPENDENT_RECORD_VERSION');
  ensure(record.packetSha256===packet.packetSha256&&record.readerId===packet.readerId,'INDEPENDENT_PACKET_BINDING');
  ensure(Array.isArray(record.entries)&&record.entries.length===packet.manuscripts.length,'INDEPENDENT_ENTRIES');
  const seen=new Set();
  record.entries.forEach((entry,index)=>{
    exact(entry,['blindId','readScope','overallImpression','claims'],'INDEPENDENT_ENTRY_FIELDS');
    ensure(entry.blindId===packet.manuscripts[index].blindId&&!seen.has(entry.blindId)&&entry.readScope==='whole'&&nonempty(entry.overallImpression)&&Array.isArray(entry.claims),'INDEPENDENT_ENTRY');
    seen.add(entry.blindId);
    const ids=new Set();entry.claims.forEach(item=>{claim(item,packet.manuscripts);ensure(!ids.has(item.id),'DUPLICATE_CLAIM');ids.add(item.id);});
  });
  return {ok:true,stage:'independent_reading',readerId:record.readerId,recordSha256:wholeQualitySha256(record)};
}

export function validateIndependentReading(bundle,record){return validateIndependentRecordAgainstPacket(findPacket(bundle,'independent',record.readerId),record);}

export function validateStandaloneIndependentReading(packet,record){
  verifyPacket(packet,INDEPENDENT_READING_VERSION);ensure(packet.manuscripts.length===1&&packet.manuscripts[0].blindId==='M','STANDALONE_PACKET');
  return validateIndependentRecordAgainstPacket(packet,record);
}

/** Release exactly one second manuscript only after the first single-manuscript record validates. */
export function prepareFollowupIndependentReading({bundle,standalonePacket,standaloneRecord}={}){
  validateStandaloneIndependentReading(standalonePacket,standaloneRecord);
  const target=findPacket(bundle,'independent',standaloneRecord.readerId);
  const source=standalonePacket.manuscripts[0],targetIndex=target.manuscripts.findIndex(item=>item.manuscriptSha256===source.manuscriptSha256);
  ensure(targetIndex===0,'STANDALONE_ORDER_MISMATCH');
  const manuscript={...target.manuscripts[1],blindId:'M'};
  const packet={schemaVersion:INDEPENDENT_READING_VERSION,caseId:bundle.caseId,readerId:target.readerId,stage:'independent_reading',instructions:{readScope:'whole',identityHidden:true,goalsHidden:true,knownIssuesHidden:true,recordEachManuscriptBeforeComparison:true,claimTypes:['hard_fact','editorial_hypothesis'],priorIndependentRecordSha256:wholeQualitySha256(standaloneRecord)},manuscripts:[manuscript]};
  return {...packet,packetSha256:packetSha256(packet)};
}

/** Merge two separately hash-bound readings into the controller-only target used by pair review. */
export function mergeStandaloneIndependentReading({bundle,standalonePacket,standaloneRecord,followupPacket,followupRecord}={}){
  validateStandaloneIndependentReading(standalonePacket,standaloneRecord);validateStandaloneIndependentReading(followupPacket,followupRecord);
  ensure(followupPacket.instructions.priorIndependentRecordSha256===wholeQualitySha256(standaloneRecord),'FOLLOWUP_SEQUENCE_BINDING');
  const target=findPacket(bundle,'independent',standaloneRecord.readerId);
  ensure(followupRecord.readerId===standaloneRecord.readerId,'FOLLOWUP_READER_BINDING');
  const sourceHashes=[standalonePacket,followupPacket].map(packet=>packet.manuscripts[0].manuscriptSha256);
  ensure(sourceHashes[0]===target.manuscripts[0].manuscriptSha256&&sourceHashes[1]===target.manuscripts[1].manuscriptSha256,'STANDALONE_ORDER_MISMATCH');
  const entries=[standaloneRecord.entries[0],followupRecord.entries[0]].map((entry,index)=>{
    const value=structuredClone(entry),blindId=target.manuscripts[index].blindId;value.blindId=blindId;
    value.claims.forEach(item=>item.evidence.forEach(evidence=>{evidence.blindId=blindId;}));return value;
  });
  const record={schemaVersion:INDEPENDENT_READING_VERSION,packetSha256:target.packetSha256,readerId:target.readerId,entries};
  validateIndependentRecordAgainstPacket(target,record);return record;
}

export function validateBlindPairReview(bundle,record){
  assertNoScoreOrVote(record);
  exact(record,['schemaVersion','packetSha256','readerId','independentRecordSha256','preference','comparisons'],'PAIR_RECORD_FIELDS');
  const packet=findPacket(bundle,'pair',record.readerId);
  ensure(record.schemaVersion===packet.schemaVersion&&[LEGACY_BLIND_PAIR_VERSION,BLIND_PAIR_VERSION].includes(record.schemaVersion),'PAIR_RECORD_VERSION');
  ensure(record.packetSha256===packet.packetSha256&&/^[a-f0-9]{64}$/.test(record.independentRecordSha256),'PAIR_BINDING');
  ensure(['first','second','mixed','no_clear_preference'].includes(record.preference)&&Array.isArray(record.comparisons)&&record.comparisons.length>0,'PAIR_VALUE');
  const ids=new Set();
  for(const comparison of record.comparisons){
    exact(comparison,['id','claimType','statement','severeHarm','evidence'],'PAIR_COMPARISON_FIELDS');
    const legacy=record.schemaVersion===LEGACY_BLIND_PAIR_VERSION;
    ensure(nonempty(comparison.id)&&!ids.has(comparison.id)&&['hard_fact','editorial_hypothesis'].includes(comparison.claimType)&&nonempty(comparison.statement)&&(legacy?typeof comparison.severeHarm==='boolean':object(comparison.severeHarm))&&Array.isArray(comparison.evidence)&&comparison.evidence.length>0,'PAIR_COMPARISON');
    ids.add(comparison.id);
    comparison.evidence.forEach(item=>{const manuscript=packet.manuscripts.find(entry=>entry.blindId===item.blindId);ensure(manuscript,'PAIR_BLIND_ID');citation(item,manuscript,'PAIR_EVIDENCE');});
    ensure(new Set(comparison.evidence.map(item=>item.blindId)).size===2,'PAIR_TWO_SIDED_EVIDENCE');
    if(legacy){if(comparison.severeHarm)ensure(comparison.evidence.length>=1,'SEVERE_HARM_EVIDENCE');continue;}
    exact(comparison.severeHarm,['status','blindIds','evidence'],'SEVERE_HARM_FIELDS');
    const harm=comparison.severeHarm,validIds=new Set(packet.manuscripts.map(item=>item.blindId));
    ensure(['none','attributed','unknown'].includes(harm.status)&&Array.isArray(harm.blindIds)&&Array.isArray(harm.evidence),'SEVERE_HARM_VALUE');
    ensure(harm.blindIds.every(id=>validIds.has(id))&&new Set(harm.blindIds).size===harm.blindIds.length,'SEVERE_HARM_BLIND_IDS');
    harm.evidence.forEach(item=>{const manuscript=packet.manuscripts.find(entry=>entry.blindId===item.blindId);ensure(manuscript,'SEVERE_HARM_BLIND_ID');citation(item,manuscript,'SEVERE_HARM_EVIDENCE');});
    if(harm.status==='none')ensure(harm.blindIds.length===0&&harm.evidence.length===0,'SEVERE_HARM_NONE');
    if(harm.status==='attributed'){
      ensure(harm.blindIds.length>0&&harm.evidence.length>0,'SEVERE_HARM_ATTRIBUTION');
      const evidenceIds=new Set(harm.evidence.map(item=>item.blindId));
      ensure(harm.evidence.every(item=>harm.blindIds.includes(item.blindId))&&harm.blindIds.every(id=>evidenceIds.has(id)),'SEVERE_HARM_ATTRIBUTION_EVIDENCE');
    }
    if(harm.status==='unknown')ensure(harm.blindIds.length===0&&new Set(harm.evidence.map(item=>item.blindId)).size===2,'SEVERE_HARM_UNKNOWN_EVIDENCE');
  }
  return {ok:true,stage:'blind_pair',readerId:record.readerId,recordSha256:wholeQualitySha256(record)};
}

function goalCitation(value,manuscript,label){citation(value,manuscript,label);}
const evidenceContent=value=>({chapterId:value.chapterId,quote:value.quote,start:value.start});
const sameEvidence=(left,right)=>left.length===right.length&&left.every((item,index)=>canonicalJson(evidenceContent(item))===canonicalJson(evidenceContent(right[index])));

export function validateGoalAudit(bundle,record){
  assertNoScoreOrVote(record);
  validateBundle(bundle);
  exact(record,['schemaVersion','packetSha256','blindPairRecordSha256s','goalAssessments'],'GOAL_RECORD_FIELDS');
  ensure(record.schemaVersion===GOAL_AUDIT_VERSION,'GOAL_RECORD_VERSION');
  const packet=bundle?.goalPacket;ensure(packet,'GOAL_PACKET');const {packetSha256:stored,...body}=packet;ensure(stored===packetSha256(body)&&record.packetSha256===stored,'GOAL_PACKET_BINDING');
  ensure(Array.isArray(record.blindPairRecordSha256s)&&record.blindPairRecordSha256s.length===2&&new Set(record.blindPairRecordSha256s).size===2&&record.blindPairRecordSha256s.every(value=>/^[a-f0-9]{64}$/.test(value)),'GOAL_PAIR_BINDINGS');
  ensure(Array.isArray(record.goalAssessments)&&record.goalAssessments.length===packet.goals.length,'GOAL_ASSESSMENTS');
  record.goalAssessments.forEach((assessment,index)=>{
    exact(assessment,['goalId','status','rationale','failureCriterionMet','outcomes'],'GOAL_ASSESSMENT_FIELDS');
    const goal=packet.goals[index];
    ensure(assessment.goalId===goal.id&&['implemented','partially_implemented','not_implemented','not_applicable'].includes(assessment.status)&&nonempty(assessment.rationale)&&typeof assessment.failureCriterionMet==='boolean'&&Array.isArray(assessment.outcomes)&&assessment.outcomes.length===goal.requiredOutcomes.length,'GOAL_ASSESSMENT');
    assessment.outcomes.forEach((outcome,outcomeIndex)=>{
      exact(outcome,['outcomeId','status','baselineEvidence','candidateEvidence','explanation'],'OUTCOME_ASSESSMENT_FIELDS');
      ensure(outcome.outcomeId===goal.requiredOutcomes[outcomeIndex].id&&['implemented','partially_implemented','not_implemented','not_applicable'].includes(outcome.status)&&nonempty(outcome.explanation)&&Array.isArray(outcome.baselineEvidence)&&Array.isArray(outcome.candidateEvidence),'OUTCOME_ASSESSMENT');
      if(outcome.status!=='not_applicable')ensure(outcome.baselineEvidence.length>0&&outcome.candidateEvidence.length>0,'OUTCOME_EVIDENCE_REQUIRED');
      outcome.baselineEvidence.forEach(value=>goalCitation(value,packet.baseline,'BASELINE_EVIDENCE'));
      outcome.candidateEvidence.forEach(value=>goalCitation(value,packet.candidate,'CANDIDATE_EVIDENCE'));
      if(outcome.status==='implemented')ensure(!sameEvidence(outcome.baselineEvidence,outcome.candidateEvidence),'IMPLEMENTED_WITHOUT_CHANGE_EVIDENCE');
    });
    const outcomeStatuses=assessment.outcomes.map(item=>item.status);
    if(packet.candidateMode==='no_change')ensure(assessment.status!=='implemented'&&!outcomeStatuses.includes('implemented'),'NO_CHANGE_CANNOT_IMPLEMENT_GOAL');
    if(assessment.status==='implemented')ensure(outcomeStatuses.every(value=>value==='implemented')&&!assessment.failureCriterionMet,'GOAL_IMPLEMENTATION_UNSUPPORTED');
    if(assessment.status==='not_implemented')ensure(outcomeStatuses.some(value=>value==='not_implemented')||assessment.failureCriterionMet,'GOAL_NONIMPLEMENTATION_UNSUPPORTED');
  });
  return {ok:true,stage:'goal_audit',recordSha256:wholeQualitySha256(record)};
}

/** Preserve reader-level evidence and disagreement. No vote, score, or literary pass is computed. */
export function finalizeWholeQualityEvaluation({bundle,privateBinding,independentRecords,pairRecords,goalRecord}={}){
  const compatibility=validateWholeQualityProtocolArtifacts({protocolVersion:bundle?.schemaVersion,bundle,privateBinding});
  ensure(Array.isArray(independentRecords)&&independentRecords.length===2&&Array.isArray(pairRecords)&&pairRecords.length===2,'TWO_READER_RECORDS_REQUIRED');
  const independent=independentRecords.map(record=>({...validateIndependentReading(bundle,record),record}));
  const independentByReader=new Map(independent.map(item=>[item.readerId,item.recordSha256]));
  const pairs=pairRecords.map(record=>{
    const result=validateBlindPairReview(bundle,record);
    ensure(record.independentRecordSha256===independentByReader.get(record.readerId),'PAIR_INDEPENDENT_BINDING');
    return {...result,record};
  });
  ensure(new Set(independent.map(item=>item.readerId)).size===2&&new Set(pairs.map(item=>item.readerId)).size===2,'READER_DUPLICATE');
  const orders=bundle.blindPairPackets.map(packet=>packet.instructions.order.join('>'));
  ensure(new Set(orders).size===2&&orders.includes('A>B')&&orders.includes('B>A'),'ORDER_SWAP_REQUIRED');
  const pairHashes=pairs.map(item=>item.recordSha256);
  ensure(canonicalJson([...goalRecord.blindPairRecordSha256s].sort())===canonicalJson([...pairHashes].sort()),'GOAL_PAIR_RECORD_BINDING');
  const goal=validateGoalAudit(bundle,goalRecord);
  const legacy=bundle.schemaVersion===LEGACY_WHOLE_QUALITY_EVALUATION_VERSION;
  const roleByBlindId=privateBinding.bindings;
  const severeHarms=pairs.flatMap(item=>item.record.comparisons.flatMap(comparison=>{
    if(legacy)return comparison.severeHarm?[{readerId:item.readerId,comparison}]:[];
    const harm=comparison.severeHarm;
    if(harm.status==='none')return [];
    if(harm.status==='unknown')return [{readerId:item.readerId,comparison,attribution:{status:'unknown',blindIds:[],roles:[]}}];
    const roles=harm.blindIds.map(blindId=>roleByBlindId[blindId]);
    ensure(roles.every(role=>['baseline','candidate'].includes(role)),'PRIVATE_BINDING_INVALID');
    const roleSet=new Set(roles),status=roleSet.size===2?'both':roles[0]==='candidate'?'candidate':'baseline';
    return [{readerId:item.readerId,comparison,attribution:{status,blindIds:[...harm.blindIds],roles}}];
  }));
  const candidateRisks=legacy?[]:severeHarms.filter(item=>['candidate','both'].includes(item.attribution.status));
  const baselineIssues=legacy?[]:severeHarms.filter(item=>['baseline','both'].includes(item.attribution.status));
  const unknownHarms=legacy?[]:severeHarms.filter(item=>item.attribution.status==='unknown');
  const unimplementedGoals=goalRecord.goalAssessments.filter(item=>item.status!=='implemented');
  const preferences=pairs.map(item=>{
    const order=bundle.blindPairPackets.find(packet=>packet.readerId===item.readerId).instructions.order;
    const selectedBlindId=item.record.preference==='first'?order[0]:item.record.preference==='second'?order[1]:null;
    return {readerId:item.readerId,preference:item.record.preference,order,selectedBlindId};
  });
  const divergent=preferences[0].selectedBlindId!==preferences[1].selectedBlindId;
  const partialGoal=goalRecord.goalAssessments.some(item=>item.status==='partially_implemented');
  const failedGoal=goalRecord.goalAssessments.some(item=>['not_implemented','not_applicable'].includes(item.status));
  const noChangeWithoutGoals=bundle.goalPacket.candidateMode==='no_change'&&bundle.goalPacket.goals.length===0;
  let adoptionBoundary='eligible_for_editorial_consideration';
  if(noChangeWithoutGoals)adoptionBoundary='no_change';
  else if(legacy&&severeHarms.length)adoptionBoundary='preserve_original';
  else if(candidateRisks.length)adoptionBoundary='preserve_original';
  else if(failedGoal)adoptionBoundary='goals_not_achieved';
  else if(unknownHarms.length||partialGoal||divergent)adoptionBoundary='narrowed_recheck_required';
  return {schemaVersion:compatibility.resultVersion,caseId:bundle.caseId,status:'completed',goalFulfillment:noChangeWithoutGoals?'not_applicable':unimplementedGoals.length===0,qualityGain:'NO_QUALITY_GAIN_ASSERTED',
    adoptionBoundary,automaticAdoption:false,literaryPass:'NOT_COMPUTED',voteResult:null,totalScore:null,
    severeHarms,...(!legacy?{severeHarmAttribution:{candidateRisks,baselineIssues,unknown:unknownHarms}}:{}),unimplementedGoalIds:unimplementedGoals.map(item=>item.goalId),readerViews:preferences,
    divergentReadings:{preferenceDivergence:divergent,semanticDivergence:'NOT_PROGRAMMATICALLY_ASSESSED',preserved:true,records:pairs.map(item=>({readerId:item.readerId,recordSha256:item.recordSha256,comparisons:item.record.comparisons}))},
    evidenceTrace:{independentRecordSha256s:independent.map(item=>item.recordSha256),pairRecordSha256s:pairHashes,goalRecordSha256:goal.recordSha256},
    limitations:['Blind preference does not prove goal implementation.','Goal implementation does not by itself grant adoption.','Mixed or divergent findings require a narrowed recheck rather than aggregation.']};
}
