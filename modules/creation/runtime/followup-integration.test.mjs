import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {fixture} from './goal-opportunity-fixtures.mjs';
import {runWholeManuscriptQualityRevision,runCrossChapterAwareWholeManuscriptQualityRevision,assertWholeQualityResult,createWholeQualityRequestSpec,
  inspectStoredWholeQualityPlanFactsFailure} from './whole-manuscript-quality.mjs';
import {buildIndependentReviewRequest} from './independent-review-handoff.mjs';
import {validateRevisionEvidencePolicy} from './revision-evidence-policy.mjs';
import {validateWritingGoals} from './writing-goals.mjs';
const clone=structuredClone;
const sha=value=>createHash('sha256').update(value).digest('hex');
const policy=()=>({schemaVersion:'whole-quality-revision-evidence-policy-1',mode:'required'});
const dims=['identity_relationship','speaker_actor','intent_completion','transfer_direction','event_round'];
const deps=['actor_presence','speaker_action','action_chain','object_transfer','payment_round','question_answer'];
const ev=(version,chapterId,quote)=>({version,chapterId,quote,start:null});
function planWire(input){return {...input.responseBindings,checkedChapterIds:input.sourceChapters.map(c=>c.id),
  assessments:input.assertions.map(a=>({assertionId:a.id,JSONPointer:a.JSONPointer,textSha256:a.textSha256,
    coverage:'no_factual_premise',reason:'离线协议控制值，不代表真实语义审读。',
    premiseChecks:Object.fromEntries(dims.map(d=>[d,{disposition:'none',factIds:[],reason:'离线控制未提出该事实。'}])),facts:[]}))};}
function sceneWire(input,{family=false,removed=false,uncertain=false}={}){
  const source=input.sourceChapters[0],candidate=input.candidateChapters[0];
  const sourceQuote=family?'十点多，快递员推车走进库房。':'她把清单放回桌上。';
  const candidateQuote=family&&!removed?'“包裹呢？”':candidate.body.split('\n\n').at(-1);
  return {...input.responseBindings,checkedChapterIds:input.sourceChapters.map(c=>c.id),groups:input.changeGroups.map(g=>({
    groupId:g.groupId,assessment:uncertain?'uncertain':family&&!removed?'broken':removed?'removed':'intact',reason:'离线已知场景反例；不报告文学改善。',
    checks:Object.fromEntries(deps.map(d=>{const bad=family&&!removed&&['actor_presence','question_answer','action_chain'].includes(d);
      return[d,{status:uncertain?'uncertain':bad?'broken':removed?'not_applicable':'intact',reason:bad?'到场前提消失，问灯和关门仍在。':'离线逐字上下文控制。',
        sourceEvidence:[ev('source',source.id,sourceQuote)],candidateEvidence:[ev('candidate',candidate.id,candidateQuote)],
        counterEvidence:bad||uncertain?[ev('candidate',candidate.id,candidateQuote)]:[]}];}))}))};
}
function enhancedFixture(options={}){
  const f=fixture(options),base=f.model.complete,events=[];
  f.request.revisionEvidencePolicy=policy();
  f.options.model={complete:async args=>{
    events.push(args.stage);const input=JSON.parse(args.user);
    if(args.stage.startsWith('whole-quality:plan-facts:')&&!args.stage.endsWith('format-repair'))return JSON.stringify(planWire(input));
    if(args.stage==='whole-quality:scene-check'){
      assert(!('plan' in input)&&!('reread' in input)&&!('applicability' in input));
      assert.deepEqual(input.sourceChapters,f.chapters);
      return JSON.stringify(sceneWire(input,{family:options.family,removed:options.wholeSceneRemoval,uncertain:options.uncertain}));
    }
    const raw=await base(args);
    if(args.stage==='whole-quality:reread'&&options.family&&!options.wholeSceneRemoval){
      const wire=JSON.parse(raw);wire.unresolvedItems=[];
      for(const c of wire.changeChecks){c.recommendation='eligible_for_user_choice';c.risks=[];
        for(const check of c.sceneDependencyChecks)if(check.assessment==='broken'){check.assessment='intact';check.reason='离线伪全intact，必须被独立核查否定。';}}
      return JSON.stringify(wire);
    }
    return raw;
  }};
  return {...f,allEvents:events};
}

test('strict optional policies bind request; malformed values and unknown fields are rejected',()=>{
  const f=fixture(),old=createWholeQualityRequestSpec(f.request,{deepReferenceEnabled:true});
  f.request.revisionEvidencePolicy=policy();const added=createWholeQualityRequestSpec(f.request,{deepReferenceEnabled:true});
  assert.notEqual(old.inputFingerprint,added.inputFingerprint);
  for(const value of [null,{}, {...policy(),extra:true},{...policy(),mode:'optional'}])assert.throws(()=>validateRevisionEvidencePolicy(value));
  const goal=f.request.writingGoals.goals[0];goal.componentFallback={schemaVersion:'whole-quality-component-fallback-policy-1',enabled:true,
    components:[{id:'cost',facet:'cost_mechanism',statement:'已有选择的局部代价',searchTerms:['选择','代价'],requiredTermGroups:[['代价']]}]};
  assert.notEqual(createWholeQualityRequestSpec(f.request,{deepReferenceEnabled:true}).inputFingerprint,added.inputFingerprint);
  for(const mutate of [g=>g.componentFallback.enabled=false,g=>g.componentFallback.components[0].sourceId='targeted',g=>g.componentFallback.components=[]]){
    const changed=clone(f.request.writingGoals);mutate(changed.goals[0]);assert.throws(()=>validateWritingGoals(changed,f.chapters));
  }
});

test('independent synthetic scene check overrides lying old intact recommendations; result/replay/handoff remain strictly bound',async()=>{
  const f=enhancedFixture({family:true}),result=await runWholeManuscriptQualityRevision(f.options),whole=result.wholeRevision;
  assert.equal(whole.reread.changeChecks[0].recommendation,'eligible_for_user_choice');
  assert.equal(whole.quality.revisionEvidence.sceneDependencies.status,'blocked');
  assert.equal(whole.adoption.atomicGroups[0].recommendation,'not_recommended');
  assert.deepEqual(result.chapters[0],f.knownCandidate);
  assert.deepEqual(assertWholeQualityResult(result,whole.requestSpec),result);
  const handoff={caseId:'offline-independent-scene',request:f.request,result};
  assert.doesNotThrow(()=>buildIndependentReviewRequest(handoff));
  const tampered=clone(result);tampered.wholeRevision.adoption.atomicGroups[0].recommendation='eligible_for_user_choice';
  assert.throws(()=>buildIndependentReviewRequest({...handoff,result:tampered,selection:['plan-1']}),{code:'HANDOFF_SELECTION_NOT_ELIGIBLE'});
  let callbacks=0;const forbidden=async()=>{callbacks++;throw Error('NO_CALLBACK');};
  const resumed=await runWholeManuscriptQualityRevision({request:f.request,artifacts:f.artifacts,model:{complete:forbidden},queryDeepReferences:forbidden});
  assert.deepEqual(resumed,result);assert.equal(callbacks,0);
  for(const mutate of [r=>r.wholeRevision.quality.revisionEvidence.sceneDependencies.blockedGroupIds=[],r=>r.wholeRevision.quality.revisionEvidence.planFacts.status='blocked',
    r=>delete r.wholeRevision.quality.revisionEvidence,r=>r.wholeRevision.quality.revisionEvidence.planHistory.initialPlan.summary+='伪改']){
    const altered=clone(result);mutate(altered);assert.throws(()=>assertWholeQualityResult(altered,whole.requestSpec));
  }
});

test('uncertain independent scene blocks recommendation; complete deletion and original/no material preserve stay legal',async()=>{
  for(const options of [{uncertain:true},{family:true,wholeSceneRemoval:true},{preserve:true}]){
    const f=enhancedFixture(options),result=await runWholeManuscriptQualityRevision(f.options),whole=result.wholeRevision;
    assertWholeQualityResult(result,whole.requestSpec);
    if(options.uncertain){assert.equal(result.qualityCheckStatus,'incomplete');assert.equal(whole.adoption.atomicGroups[0].recommendation,'not_recommended');}
    else if(options.preserve){assert.equal(whole.status,'no_change');assert.equal(whole.quality.revisionEvidence.sceneDependencies.status,'no_changes');assert(!f.allEvents.includes('whole-quality:scene-check'));}
    else assert.equal(whole.quality.revisionEvidence.sceneDependencies.groups[0].assessment,'removed');
  }
});

test('one fact correction/recheck only, including preserve; blocked history has a read-only verified failure projection and zero-call resume',async()=>{
  const f=enhancedFixture({preserve:true}),previous=f.options.model.complete;
  const modelPolicy='whole-manuscript-quality-json-1';
  const {reviewCrossChapter}=await import('../../validation/runtime/cross-chapter-review.mjs');
  f.options.model={complete:async args=>{
    const input=JSON.parse(args.user);
    if(args.stage==='whole-quality:cross-chapter:extract')return JSON.stringify({schemaVersion:'cross-chapter-extraction-compact-1',
      chapterCoverage:f.chapters.map(c=>({chapterId:c.id,extractionNote:'离线流程无比较控制。'})),comparisons:[],unpaired:[]});
    if(args.stage==='whole-quality:cross-chapter:adjudicate')return JSON.stringify({schemaVersion:'cross-chapter-adjudication-compact-1',
      checkedChapterIds:f.chapters.map(c=>c.id),findings:[]});
    if(args.stage.startsWith('whole-quality:plan-facts:')&&!args.stage.endsWith('format-repair')){
      f.allEvents.push(args.stage);const wire=planWire(input),row=wire.assessments[0];row.coverage='unresolved';
      row.premiseChecks.identity_relationship={disposition:'unresolved',factIds:[],reason:'无法核实该保留理由的人物归属。'};
      return JSON.stringify(wire);
    }
    if(args.stage==='whole-quality:plan-correction'){
      f.allEvents.push(args.stage);return JSON.stringify({...input.revisionEvidenceCorrection.initialPlan,...input.responseBindings});
    }
    return previous(args);
  }};
  await assert.rejects(runCrossChapterAwareWholeManuscriptQualityRevision({...f.options,modelPolicy,reviewCrossChapter}),{code:'WHOLE_QUALITY_PLAN_FACTS_UNVERIFIED'});
  assert.equal(f.allEvents.filter(s=>s==='whole-quality:plan-correction').length,1);
  assert(!f.allEvents.includes('whole-quality:feasibility')&&!f.allEvents.includes('whole-quality:revision'));
  const before=clone(f.artifacts),view=await inspectStoredWholeQualityPlanFactsFailure({request:f.request,artifacts:f.artifacts});
  assert.equal(view.status,'verified_failure');assert.equal(view.checkStatus,'incomplete');assert.equal(view.automaticAdoption,false);assert.deepEqual(f.artifacts,before);
  let calls=0;const forbidden=async()=>{calls++;throw Error('NO_CALLBACK');};
  await assert.rejects(runCrossChapterAwareWholeManuscriptQualityRevision({request:f.request,artifacts:f.artifacts,model:{complete:forbidden},queryDeepReferences:forbidden,modelPolicy,reviewCrossChapter}),{code:'WHOLE_QUALITY_PLAN_FACTS_UNVERIFIED'});
  assert.equal(calls,0);
  for(const mutate of [a=>a['whole-quality:plan-facts:blocked'].status='clear',a=>a['whole-quality:plan:receipt'].primaryResponseSha256='0'.repeat(64),
    a=>a['whole-quality:plan-facts:initial:primary-response'].rawResponse+='x',a=>a['whole-quality:plan:input'].input.requestSpec.objective+='x']){
    const altered=clone(f.artifacts);mutate(altered);assert.equal((await inspectStoredWholeQualityPlanFactsFailure({request:f.request,artifacts:altered})).status,'invalid');
  }
  const missing=clone(f.artifacts);delete missing['whole-quality:plan-facts:recheck:receipt'];
  assert.equal((await inspectStoredWholeQualityPlanFactsFailure({request:f.request,artifacts:missing})).status,'not_available');
});

test('successful single fact correction remains in history and receipts, then resumes without dispatch',async()=>{
  const f=enhancedFixture({preserve:true}),base=f.options.model.complete;
  f.options.model={complete:async args=>{
    const input=JSON.parse(args.user);
    if(args.stage==='whole-quality:plan-facts:initial'){
      const wire=planWire(input);wire.assessments[0].coverage='unresolved';
      wire.assessments[0].premiseChecks.event_round={disposition:'unresolved',factIds:[],reason:'保留理由的事件前提尚未明确。'};
      return JSON.stringify(wire);
    }
    if(args.stage==='whole-quality:plan-correction')return JSON.stringify({...input.revisionEvidenceCorrection.initialPlan,...input.responseBindings,
      summary:'限定为未来可能的创作动作；本次保留原稿，不宣称已完成的新事实。'});
    return base(args);
  }};
  const result=await runWholeManuscriptQualityRevision(f.options),whole=result.wholeRevision;
  assert.equal(whole.quality.revisionEvidence.planHistory.initialCheck.status,'incomplete');
  assert.equal(whole.quality.revisionEvidence.planFacts.status,'clear');
  assert(whole.stageReceipts.some(r=>r.stage==='whole-quality:plan-correction'));
  assertWholeQualityResult(result,whole.requestSpec);
  let calls=0;const forbidden=async()=>{calls++;throw Error('NO_CALLBACK');};
  const resumed=await runWholeManuscriptQualityRevision({request:f.request,artifacts:f.artifacts,model:{complete:forbidden},queryDeepReferences:forbidden});
  assert.deepEqual(resumed,result);assert.equal(calls,0);
});
