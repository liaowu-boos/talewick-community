import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {inspectWholeRevisionCandidate,normalizeWholeRevisionAcceptanceInput} from '../runtime/whole-revision-acceptance.mjs';

const baseline=[
  {id:'ch-1',title:'起点',body:'第一天，她把日期写在纸上。门后的旧钟响了一声。'},
  {id:'ch-2',title:'中段',body:'第二天，她们仍在核对清单，没有交钥匙。'},
  {id:'ch-3',title:'交接',body:'第三天下午，她把钥匙交给胡姐。门后的旧钟又响了一声。'},
];
const chapterHash=chapter=>createHash('sha256').update(JSON.stringify({id:chapter.id,title:chapter.title,body:chapter.body})).digest('hex');
const cite=(chapterId,quote)=>({chapterId,quote,start:baseline.find(item=>item.id===chapterId).body.indexOf(quote)});
const plan={id:'plan-cross-chain',diagnosisKind:'fact',basis:'text_evidence',userAuthorized:false,authorizedChapterIds:['ch-1','ch-3'],
  evidence:[cite('ch-1','第一天，她把日期写在纸上。'),cite('ch-3','第三天下午，她把钥匙交给胡姐。')],
  preserve:[cite('ch-1','门后的旧钟响了一声。'),cite('ch-3','门后的旧钟又响了一声。')]};

function fixture({candidate,current=baseline,planItems=[plan],reread={status:'completed',checkedChapterIds:['ch-1','ch-2','ch-3'],failureCode:null},factChecks=[{unitId:'handover',status:'completed',assessment:'consistent'}]}={}){
  const next=candidate??[
    {...baseline[0],body:'第一天，她把第三天下午交接的日期写在纸上。门后的旧钟响了一声。'},
    baseline[1],
    {...baseline[2],body:'第三天下午，她核对纸上的日期，把钥匙交给胡姐。门后的旧钟又响了一声。'},
  ];
  const appliedChanges=baseline.filter((item,index)=>chapterHash(item)!==chapterHash(next[index])).map(item=>({
    planItemIds:[planItems[0]?.id??'missing'],chapterId:item.id,beforeSha256:chapterHash(item),afterSha256:chapterHash(next.find(value=>value.id===item.id)),
  }));
  return {baselineChapters:baseline,currentChapters:current,candidateChapters:next,planItems,appliedChanges,reread,factChecks};
}

test('cross-chapter candidate is ready only with scoped changes, preserved echoes, reread and consistent fact unit',()=>{
  const audit=inspectWholeRevisionCandidate(fixture());
  assert.equal(audit.status,'ready');assert.equal(audit.adoptionEligible,true);
  assert.deepEqual(audit.changedChapterIds,['ch-1','ch-3']);
  assert.deepEqual(audit.unchangedChapterIds,['ch-2']);
  assert.equal(audit.literaryQuality,'NOT_ASSESSED');assert.equal(audit.systemGo,false);
});

test('unsupported subjective preference cannot authorize an automatic rewrite',()=>{
  const preference={...plan,id:'taste',diagnosisKind:'preference',basis:'text_evidence',userAuthorized:false};
  const audit=inspectWholeRevisionCandidate(fixture({planItems:[preference]}));
  assert.equal(audit.status,'blocked');assert(audit.codes.includes('SUBJECTIVE_PREFERENCE_UNAUTHORIZED'));
  assert.equal(audit.automaticRevisionEligible,false);
});

test('an unapplied preference may remain recorded without becoming an authorization',()=>{
  const preference={...plan,id:'taste-only',diagnosisKind:'preference',basis:'text_evidence',userAuthorized:false,authorizedChapterIds:['ch-2']};
  const args=fixture({planItems:[plan,preference]});
  args.appliedChanges=args.appliedChanges.map(change=>({...change,planItemIds:[plan.id]}));
  const audit=inspectWholeRevisionCandidate(args);
  assert.equal(audit.status,'ready');assert.equal(audit.codes.includes('SUBJECTIVE_PREFERENCE_UNAUTHORIZED'),false);
});

test('a preserved echo removed by the candidate is reported as damage',()=>{
  const candidate=[{...baseline[0],body:'第一天，她把第三天下午交接的日期写在纸上。'},baseline[1],
    {...baseline[2],body:'第三天下午，她核对纸上的日期，把钥匙交给胡姐。门后的旧钟又响了一声。'}];
  const audit=inspectWholeRevisionCandidate(fixture({candidate}));
  assert.equal(audit.status,'blocked');assert(audit.codes.includes('PRESERVE_LOST'));
});

test('an unplanned chapter edit is out of scope and unchanged chapters are protected',()=>{
  const base=fixture(),candidate=base.candidateChapters.map(item=>item.id==='ch-2'?{...item,body:item.body+' 多加一句。'}:item);
  const args=fixture({candidate});args.appliedChanges=args.appliedChanges.filter(change=>change.chapterId!=='ch-2');
  const audit=inspectWholeRevisionCandidate(args);
  assert.equal(audit.status,'blocked');assert(audit.codes.includes('OUT_OF_SCOPE_CHANGE'));
});

test('a user edit during the task creates an adoption conflict without overwriting either version',()=>{
  const current=baseline.map(item=>item.id==='ch-2'?{...item,body:item.body+' 用户新增说明。'}:item);
  const audit=inspectWholeRevisionCandidate(fixture({current}));
  assert.equal(audit.status,'conflict');assert(audit.codes.includes('CURRENT_DRAFT_CHANGED'));assert.equal(audit.adoptionEligible,false);
});

test('reread failure and unknown fact unit remain incomplete rather than passing',()=>{
  const failed=inspectWholeRevisionCandidate(fixture({reread:{status:'failed',checkedChapterIds:[],failureCode:'RESPONSE_JSON'}}));
  assert.equal(failed.status,'incomplete');assert(failed.codes.includes('REREAD_INCOMPLETE'));
  const unknown=inspectWholeRevisionCandidate(fixture({factChecks:[{unitId:'handover',status:'completed',assessment:'unknown'}]}));
  assert.equal(unknown.status,'incomplete');assert(unknown.codes.includes('FACT_CHECK_INCOMPLETE'));assert.equal(unknown.adoptionEligible,false);
});

test('reported cross-chapter conflict blocks adoption but does not grant revision authority',()=>{
  const audit=inspectWholeRevisionCandidate(fixture({factChecks:[{unitId:'handover',status:'completed',assessment:'conflict'}]}));
  assert.equal(audit.status,'blocked');assert(audit.codes.includes('FACT_CONFLICT_REPORTED'));
  assert.equal(audit.automaticRevisionEligible,false);
});

test('validated creation fields normalize without trusting body hashes or model preference authority',()=>{
  const candidate=fixture().candidateChapters;
  const result={chapters:candidate,wholeRevision:{sourceChapters:baseline,
    diagnosis:{findings:[{id:'d-1',claimType:'textual_conflict',evidence:plan.evidence,preservation:plan.preserve}]},
    plan:{items:[{id:plan.id,decision:'revise',diagnosisIds:['d-1'],affectedChapterIds:plan.authorizedChapterIds,preserve:plan.preserve}]},
    actualChanges:fixture().appliedChanges.map(change=>({chapterId:change.chapterId,changed:true,planItemIds:change.planItemIds,
      beforeBodySha256:'creation-body-hash',afterBodySha256:'creation-body-hash'})),
    reread:{schemaVersion:'whole-revision-reread-1',coverage:{status:'complete',omissions:[]},checkedChapterIds:['ch-1','ch-2','ch-3']}}};
  const normalized=normalizeWholeRevisionAcceptanceInput({result,currentChapters:baseline,
    factChecks:{units:[{unitId:'handover',status:'completed',assessment:'consistent',result:{}}]}});
  const audit=inspectWholeRevisionCandidate(normalized);
  assert.equal(audit.status,'ready');assert.deepEqual(audit.changedChapterIds,['ch-1','ch-3']);
});

test('creation preference mapping stays blocked until the controller supplies explicit user authorization',()=>{
  const candidate=fixture().candidateChapters,creation={chapters:candidate,wholeRevision:{sourceChapters:baseline,
    diagnosis:{findings:[{id:'d-taste',claimType:'editorial_preference',evidence:plan.evidence,preservation:plan.preserve}]},
    plan:{items:[{id:'taste',decision:'revise',diagnosisIds:['d-taste'],affectedChapterIds:plan.authorizedChapterIds,preserve:plan.preserve}]},
    actualChanges:fixture().appliedChanges.map(change=>({chapterId:change.chapterId,changed:true,planItemIds:['taste']})),
    reread:{schemaVersion:'whole-revision-reread-1',coverage:{status:'complete',omissions:[]},checkedChapterIds:['ch-1','ch-2','ch-3']}}};
  const facts=[{unitId:'handover',status:'completed',assessment:'consistent'}];
  const blocked=inspectWholeRevisionCandidate(normalizeWholeRevisionAcceptanceInput({result:creation,currentChapters:baseline,factChecks:facts}));
  assert(blocked.codes.includes('SUBJECTIVE_PREFERENCE_UNAUTHORIZED'));
  const authorized=inspectWholeRevisionCandidate(normalizeWholeRevisionAcceptanceInput({result:creation,currentChapters:baseline,factChecks:facts,authorizedPreferencePlanItemIds:['taste']}));
  assert.equal(authorized.status,'ready');
});
