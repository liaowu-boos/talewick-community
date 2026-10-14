import {createHash} from 'node:crypto';
import {manuscriptFingerprint} from './checks.mjs';

export const WHOLE_REVISION_ACCEPTANCE_VERSION='whole-revision-acceptance-1';
export class WholeRevisionAcceptanceError extends Error{
  constructor(code,message=code){super(message);this.name='WholeRevisionAcceptanceError';this.code=code;}
}
const ensure=(ok,code)=>{if(!ok)throw new WholeRevisionAcceptanceError(code);};
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,fields,code='INVALID_FIELDS')=>ensure(object(value)&&Object.keys(value).length===fields.length&&fields.every(key=>Object.hasOwn(value,key)),code);
const sha256=text=>createHash('sha256').update(text).digest('hex');
const chapterFingerprint=chapter=>sha256(JSON.stringify({id:chapter.id,title:chapter.title,body:chapter.body}));
const nonempty=value=>typeof value==='string'&&value.trim().length>0;

function chapters(value,label){
  ensure(Array.isArray(value)&&value.length>0,`${label}_CHAPTERS`);const ids=new Set();
  for(const chapter of value){exact(chapter,['id','title','body'],`${label}_CHAPTER_FIELDS`);ensure(nonempty(chapter.id)&&nonempty(chapter.title)&&nonempty(chapter.body)&&!ids.has(chapter.id),`${label}_CHAPTER`);ids.add(chapter.id);}
  return value;
}
function quoteAt(chapter,citation){
  exact(citation,['chapterId','quote','start'],'CITATION_FIELDS');
  ensure(Number.isSafeInteger(citation.start)&&citation.start>=0&&nonempty(citation.quote)&&chapter&&chapter.body.slice(citation.start,citation.start+citation.quote.length)===citation.quote,'CITATION_QUOTE');
}
function citations(values){
  const seen=new Set(),result=[];
  for(const value of values){
    const citation={chapterId:value?.chapterId,quote:value?.quote,start:value?.start},key=JSON.stringify(citation);
    if(!seen.has(key)){seen.add(key);result.push(citation);}
  }
  return result;
}

/** Map an already assertWholeRevisionResult-validated creation result into this module's narrow boundary. */
export function normalizeWholeRevisionAcceptanceInput({result,currentChapters,factChecks=[],authorizedPreferencePlanItemIds=[]}={}){
  ensure(object(result)&&object(result.wholeRevision)&&Array.isArray(result.chapters),'ADAPTER_RESULT');
  const whole=result.wholeRevision;
  ensure(Array.isArray(whole.sourceChapters)&&object(whole.diagnosis)&&Array.isArray(whole.diagnosis.findings)&&
    object(whole.plan)&&Array.isArray(whole.plan.items)&&Array.isArray(whole.actualChanges)&&object(whole.reread),'ADAPTER_RESULT');
  ensure(Array.isArray(authorizedPreferencePlanItemIds)&&new Set(authorizedPreferencePlanItemIds).size===authorizedPreferencePlanItemIds.length,'ADAPTER_AUTHORIZATION');
  const findings=new Map(whole.diagnosis.findings.map(item=>[item.id,item])),authorized=new Set(authorizedPreferencePlanItemIds);
  const revisable=whole.plan.items.filter(item=>item.decision==='revise');
  const planItems=revisable.map(item=>{
    ensure(Array.isArray(item.diagnosisIds)&&Array.isArray(item.affectedChapterIds)&&Array.isArray(item.preserve),'ADAPTER_PLAN');
    const selected=item.diagnosisIds.map(id=>findings.get(id));ensure(selected.every(Boolean),'ADAPTER_PLAN');
    const claimTypes=new Set(selected.map(value=>value.claimType));
    const diagnosisKind=claimTypes.has('editorial_preference')?'preference':claimTypes.has('reader_effect_hypothesis')?'reading_hypothesis':'fact';
    const userAuthorized=diagnosisKind==='preference'&&authorized.has(item.id);
    return {id:item.id,diagnosisKind,basis:userAuthorized?'user_instruction':'text_evidence',userAuthorized,
      authorizedChapterIds:item.affectedChapterIds,
      evidence:citations(selected.flatMap(value=>value.evidence??[])),
      preserve:citations([...selected.flatMap(value=>value.preservation??[]),...item.preserve])};
  });
  const preferenceIds=new Set(planItems.filter(item=>item.diagnosisKind==='preference').map(item=>item.id));
  ensure([...authorized].every(id=>preferenceIds.has(id)),'ADAPTER_AUTHORIZATION');
  const baselineMap=new Map(whole.sourceChapters.map(item=>[item.id,item])),candidateMap=new Map(result.chapters.map(item=>[item.id,item]));
  const appliedChanges=whole.actualChanges.filter(change=>change.changed).map(change=>{
    const before=baselineMap.get(change.chapterId),after=candidateMap.get(change.chapterId);
    ensure(before&&after&&Array.isArray(change.planItemIds),'ADAPTER_CHANGE');
    return {planItemIds:change.planItemIds,chapterId:change.chapterId,beforeSha256:chapterFingerprint(before),afterSha256:chapterFingerprint(after)};
  });
  const incomplete=whole.reread.schemaVersion==='whole-revision-reread-incomplete-1';
  const reread=incomplete?{status:'failed',checkedChapterIds:[],failureCode:whole.reread.failureCode}:
    whole.reread.coverage?.status==='complete'?{status:'completed',checkedChapterIds:whole.reread.checkedChapterIds,failureCode:null}:
      {status:'failed',checkedChapterIds:whole.reread.checkedChapterIds??[],failureCode:'REREAD_BOUNDED'};
  const sourceFacts=Array.isArray(factChecks)?factChecks:factChecks?.units;
  ensure(Array.isArray(sourceFacts),'ADAPTER_FACT_CHECKS');
  const normalizedFacts=sourceFacts.map(item=>({unitId:item.unitId,status:item.status,assessment:item.assessment}));
  return {baselineChapters:whole.sourceChapters,currentChapters,candidateChapters:result.chapters,planItems,appliedChanges,reread,factChecks:normalizedFacts};
}

/** Deterministic adoption boundary; it does not decide literary quality or rewrite text. */
export function inspectWholeRevisionCandidate(args){
  exact(args,['baselineChapters','currentChapters','candidateChapters','planItems','appliedChanges','reread','factChecks']);
  const baseline=chapters(args.baselineChapters,'BASELINE'),current=chapters(args.currentChapters,'CURRENT'),candidate=chapters(args.candidateChapters,'CANDIDATE');
  const baselineIds=baseline.map(item=>item.id),currentIds=current.map(item=>item.id),candidateIds=candidate.map(item=>item.id);
  const codes=[];
  if(JSON.stringify(baselineIds)!==JSON.stringify(candidateIds))codes.push('CHAPTER_TOPOLOGY_CHANGED');
  if(manuscriptFingerprint(current)!==manuscriptFingerprint(baseline))codes.push('CURRENT_DRAFT_CHANGED');
  const baselineMap=new Map(baseline.map(item=>[item.id,item])),candidateMap=new Map(candidate.map(item=>[item.id,item]));
  ensure(Array.isArray(args.planItems)&&Array.isArray(args.appliedChanges)&&Array.isArray(args.factChecks),'LIST_REQUIRED');
  const planIds=new Set(),plans=new Map();
  for(const item of args.planItems){
    exact(item,['id','diagnosisKind','basis','userAuthorized','authorizedChapterIds','evidence','preserve'],'PLAN_FIELDS');
    ensure(nonempty(item.id)&&!planIds.has(item.id)&&['fact','reading_hypothesis','preference'].includes(item.diagnosisKind)&&['text_evidence','user_instruction'].includes(item.basis)&&typeof item.userAuthorized==='boolean','PLAN_ITEM');
    planIds.add(item.id);plans.set(item.id,item);
    ensure(Array.isArray(item.authorizedChapterIds)&&item.authorizedChapterIds.length>0&&new Set(item.authorizedChapterIds).size===item.authorizedChapterIds.length&&item.authorizedChapterIds.every(id=>baselineMap.has(id)),'PLAN_SCOPE');
    ensure(Array.isArray(item.evidence)&&Array.isArray(item.preserve),'PLAN_EVIDENCE');
    for(const citation of [...item.evidence,...item.preserve])quoteAt(baselineMap.get(citation.chapterId),citation);
    for(const citation of item.preserve){const after=candidateMap.get(citation.chapterId);if(!after||!after.body.includes(citation.quote))codes.push('PRESERVE_LOST');}
  }
  const baselineHashes=new Map(baseline.map(item=>[item.id,chapterFingerprint(item)])),candidateHashes=new Map(candidate.map(item=>[item.id,chapterFingerprint(item)]));
  const changedChapterIds=baselineIds.filter(id=>candidateHashes.get(id)!==baselineHashes.get(id));
  const recorded=new Set();
  for(const change of args.appliedChanges){
    exact(change,['planItemIds','chapterId','beforeSha256','afterSha256'],'CHANGE_FIELDS');
    ensure(Array.isArray(change.planItemIds)&&change.planItemIds.length>0&&new Set(change.planItemIds).size===change.planItemIds.length,'CHANGE_BINDING');
    const selectedPlans=change.planItemIds.map(id=>plans.get(id));
    ensure(selectedPlans.every(Boolean)&&baselineMap.has(change.chapterId)&&!recorded.has(change.chapterId),'CHANGE_BINDING');recorded.add(change.chapterId);
    ensure(change.beforeSha256===baselineHashes.get(change.chapterId)&&change.afterSha256===candidateHashes.get(change.chapterId),'CHANGE_HASH');
    if(selectedPlans.some(plan=>!plan.authorizedChapterIds.includes(change.chapterId)))codes.push('OUT_OF_SCOPE_CHANGE');
    if(selectedPlans.some(plan=>['fact','reading_hypothesis'].includes(plan.diagnosisKind)&&(plan.basis!=='text_evidence'||plan.evidence.length<2)))codes.push('PLAN_EVIDENCE_INSUFFICIENT');
    if(selectedPlans.some(plan=>plan.diagnosisKind==='preference'&&(plan.basis!=='user_instruction'||!plan.userAuthorized)))codes.push('SUBJECTIVE_PREFERENCE_UNAUTHORIZED');
  }
  if(changedChapterIds.some(id=>!recorded.has(id))||[...recorded].some(id=>!changedChapterIds.includes(id)))codes.push('OUT_OF_SCOPE_CHANGE');
  exact(args.reread,['status','checkedChapterIds','failureCode'],'REREAD_FIELDS');
  ensure(['completed','failed','not_run'].includes(args.reread.status)&&Array.isArray(args.reread.checkedChapterIds)&&(args.reread.failureCode===null||nonempty(args.reread.failureCode)),'REREAD_VALUE');
  if(args.reread.status!=='completed')codes.push('REREAD_INCOMPLETE');
  else if(args.reread.checkedChapterIds.length!==candidateIds.length||new Set(args.reread.checkedChapterIds).size!==candidateIds.length||!candidateIds.every(id=>args.reread.checkedChapterIds.includes(id)))codes.push('REREAD_COVERAGE_INCOMPLETE');
  for(const fact of args.factChecks){
    exact(fact,['unitId','status','assessment'],'FACT_CHECK_FIELDS');
    ensure(nonempty(fact.unitId)&&['completed','failed'].includes(fact.status)&&[null,'conflict','consistent','unknown'].includes(fact.assessment),'FACT_CHECK_VALUE');
    if(fact.status==='failed'||fact.assessment==='unknown'||fact.assessment===null)codes.push('FACT_CHECK_INCOMPLETE');
    if(fact.assessment==='conflict')codes.push('FACT_CONFLICT_REPORTED');
  }
  const uniqueCodes=[...new Set(codes)];
  const conflict=uniqueCodes.includes('CURRENT_DRAFT_CHANGED');
  const blockedCodes=new Set(['CHAPTER_TOPOLOGY_CHANGED','PLAN_EVIDENCE_INSUFFICIENT','SUBJECTIVE_PREFERENCE_UNAUTHORIZED','PRESERVE_LOST','OUT_OF_SCOPE_CHANGE','FACT_CONFLICT_REPORTED']);
  const blocked=uniqueCodes.some(code=>blockedCodes.has(code));
  const status=conflict?'conflict':blocked?'blocked':uniqueCodes.length?'incomplete':'ready';
  return {schemaVersion:WHOLE_REVISION_ACCEPTANCE_VERSION,status,codes:uniqueCodes,
    baselineManuscriptSha256:manuscriptFingerprint(baseline),currentManuscriptSha256:manuscriptFingerprint(current),
    candidateManuscriptSha256:manuscriptFingerprint(candidate),changedChapterIds,
    unchangedChapterIds:baselineIds.filter(id=>!changedChapterIds.includes(id)),candidateGenerated:true,
    adoptionEligible:status==='ready',automaticRevisionEligible:false,literaryQuality:'NOT_ASSESSED',systemGo:false};
}
