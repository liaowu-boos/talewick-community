import test from 'node:test';
import assert from 'node:assert/strict';
import { runWholeManuscriptQualityRevision, createWholeQualityRequestSpec, assertWholeQualityResult } from './whole-manuscript-quality.mjs';
import { buildIndependentReviewRequest } from './independent-review-handoff.mjs';
import { validateGoalImprovementPolicy, resolveOpportunityEvidence, validateOpportunityPlan,
  validateSceneDependencyReread, GOAL_OPPORTUNITY_PLAN_VERSION } from './goal-opportunity.mjs';
import { fixture, policy } from './goal-opportunity-fixtures.mjs';

const copy = value => structuredClone(value);
const wholeError = error => /^WHOLE_QUALITY_/.test(error.code);

test('policy is exact, opt-in, goal-bound, and changes request fingerprint without changing default spec', () => {
  const f = fixture({ enabled: false, preserve: true }), before = createWholeQualityRequestSpec(f.request, { deepReferenceEnabled: true });
  assert.equal(Object.hasOwn(before, 'goalImprovementPolicy'), false);
  assert.deepEqual(before, createWholeQualityRequestSpec(copy(f.request), { deepReferenceEnabled: true }));
  const enabled = createWholeQualityRequestSpec({ ...f.request, goalImprovementPolicy: policy() }, { deepReferenceEnabled: true });
  assert.notEqual(enabled.inputFingerprint, before.inputFingerprint); assert.deepEqual(enabled.goalImprovementPolicy, policy());
  assert.throws(() => validateGoalImprovementPolicy(policy()), wholeError);
  for (const changed of [{ ...policy(), mode: 'force_change' }, { ...policy(), maxOpportunitiesPerGoal: 2 }, { ...policy(), extra: true }])
    assert.throws(() => validateGoalImprovementPolicy(changed, f.request.writingGoals), wholeError);
});

test('no materials and no diagnosed issues allow one original opportunity through existing stages and full result gate', async () => {
  const f = fixture(), result = await runWholeManuscriptQualityRevision(f.options);
  assert.equal(result.wholeRevision.plan.schemaVersion, GOAL_OPPORTUNITY_PLAN_VERSION);
  assert.deepEqual(f.events, ['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:revision','whole-quality:reread']);
  assert.deepEqual(result.wholeRevision.quality.independentReading.issues, []);
  assert.equal(result.wholeRevision.quality.writingGoals.goals[0].deepMaterialOutcome, 'query_unavailable');
  assert.equal(result.wholeRevision.plan.goalDispositions[0].incrementalAssessment.materialBasis.kind, 'original');
  assert.equal(result.wholeRevision.adoption.atomicGroups[0].recommendation, 'eligible_for_user_choice');
  assert.equal(result.chapters[0].body, f.candidateBody);
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
  assert(f.inputs['whole-quality:revision'].affectedSceneContexts[0].source.quote.includes(f.protectedQuote));
  assert.equal(f.inputs['whole-quality:reread'].affectedSceneContexts[0].candidate.quote.includes(f.replacement), true);
});

test('specific no-safe-increment preserve is valid, leaves text unchanged, and adds no revision or retry stage', async () => {
  const f = fixture({ preserve: true }), result = await runWholeManuscriptQualityRevision(f.options);
  assert.deepEqual(f.events, ['whole-quality:reading','whole-quality:plan','whole-quality:reread']);
  assert.equal(result.wholeRevision.status, 'no_change'); assert.deepEqual(result.chapters, f.chapters);
  const assessment = result.wholeRevision.plan.goalDispositions[0].incrementalAssessment;
  assert.equal(assessment.opportunity, null); assert.equal(assessment.opportunityAssessment, 'preserve');
  assert.equal(assessment.currentAchievementEvidence.length, 1); assert.match(assessment.opportunityReason, /新增设定/);
});

test('synthetic isolated dialogue is replayed unchanged and evidence-bound broken dependencies block its group', async () => {
  const f = fixture({ family: true }), result = await runWholeManuscriptQualityRevision(f.options);
  assert.deepEqual(result.chapters[0], f.knownCandidate);
  const check = result.wholeRevision.reread.changeChecks[0];
  assert.equal(check.goalAssessment, 'implemented'); assert.equal(check.coherenceAssessment, 'consistent');
  assert.equal(result.wholeRevision.adoption.atomicGroups[0].recommendation, 'not_recommended');
  const broken = check.sceneDependencyChecks.filter(check => check.assessment === 'broken'); assert.equal(broken.length, 3);
  for (const check of broken) {
    assert(check.sourceEvidence.length && check.candidateEvidence.length);
    for (const e of check.candidateEvidence) assert.equal(result.chapters[0].body.slice(e.start,e.start+e.quote.length), e.quote);
  }
  const altered = copy(result.wholeRevision.reread); altered.changeChecks[0].recommendation = 'eligible_for_user_choice';
  assert.throws(() => validateSceneDependencyReread(altered, f.artifacts['whole-quality:reread:input'].input), { code: 'WHOLE_QUALITY_SCENE_DEPENDENCY' });
  const badResult = copy(result); badResult.wholeRevision.reread.changeChecks[0].recommendation = 'eligible_for_user_choice';
  assert.throws(() => assertWholeQualityResult(badResult, badResult.wholeRevision.requestSpec), wholeError);
});

test('whole scene deletion is legal when every dependency is authorized, actually removed, and the seam has exact evidence', async () => {
  const f = fixture({ family: true, wholeSceneRemoval: true }), result = await runWholeManuscriptQualityRevision(f.options);
  assert.equal(result.chapters[0].body, f.candidateBody);
  assert.equal(result.chapters[0].body.includes('“包裹呢？”'), false);
  assert(result.wholeRevision.reread.changeChecks[0].sceneDependencyChecks.every(check => check.assessment === 'removed_with_scene'));
  assert.equal(result.wholeRevision.adoption.atomicGroups[0].recommendation, 'eligible_for_user_choice');
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
});

test('removing only setup cannot be described as whole-scene removal', async () => {
  const f = fixture({ family: true }), result = await runWholeManuscriptQualityRevision(f.options), plan = copy(result.wholeRevision.plan);
  plan.items[0].sceneDependencies.find(dependency => dependency.kind === 'presence').handling = 'remove_with_scene';
  assert.throws(() => validateOpportunityPlan(plan, f.artifacts['whole-quality:plan:input'].input), /整场删除/);
});

test('an opportunity cannot omit its source, move outside its goal, invent a direct-fit supply, or escape its atomic group', async () => {
  const f = fixture(), result = await runWholeManuscriptQualityRevision(f.options), input = f.artifacts['whole-quality:plan:input'].input;
  for (const mutate of [
    p => { p.goalDispositions[0].incrementalAssessment.opportunity = null; },
    p => { p.goalDispositions[0].incrementalAssessment.opportunity.sourceEvidence = []; },
    p => { p.goalDispositions[0].incrementalAssessment.opportunity.sourceEvidence[0].quote = '改写的来源引文'; },
    p => { p.goalDispositions[0].incrementalAssessment.opportunity.sceneIds = ['unknown']; },
    p => { p.goalDispositions[0].incrementalAssessment.materialBasis = { kind: 'supplied', supplyIds: ['forged'], evidenceIds: ['e-1'], reason: '伪造供应。' }; },
    p => { p.items[0].sceneDependencies[2].targetIds = ['another-group-target']; },
    p => { p.goalDispositions[0].planItemIds = []; },
  ]) { const altered = copy(result.wholeRevision.plan); mutate(altered); assert.throws(() => validateOpportunityPlan(altered, input), wholeError); }
});

test('implemented increment cannot take credit for unchanged baseline evidence; missing or edited scene quotations fail', async () => {
  const f = fixture(), result = await runWholeManuscriptQualityRevision(f.options), input = f.artifacts['whole-quality:reread:input'].input;
  const altered = copy(result.wholeRevision.reread), body = result.chapters[0].body;
  altered.changeChecks[0].requirementChecks[0].evidence = [{ chapterId: 'ch-1', start: body.indexOf(f.protectedQuote), quote: f.protectedQuote, purpose: '未改的基线既有实现。' }];
  assert.throws(() => validateSceneDependencyReread(altered, input), /未改变/);
  for (const mutate of [
    p => { p.changeChecks[0].sceneDependencyChecks[2].sourceEvidence = []; },
    p => { p.changeChecks[0].sceneDependencyChecks[2].candidateEvidence[0].quote = '看似相似但不是原文'; },
    p => { p.changeChecks[0].sceneDependencyChecks = p.changeChecks[0].sceneDependencyChecks.slice(1); },
  ]) { const altered = copy(result.wholeRevision.reread); mutate(altered); assert.throws(() => validateSceneDependencyReread(altered, input), wholeError); }
});

test('supplied increment basis must match a direct-fit supply and its complete used before/after evidence', async () => {
  const f = fixture(), result = await runWholeManuscriptQualityRevision(f.options), input = copy(f.artifacts['whole-quality:plan:input'].input), plan = copy(result.wholeRevision.plan);
  const supply = { supplyId: 'goal:supply', goalId: 'bounded-choice', evidenceIds: ['before','after'] };
  input.retrieval.supplies = [supply]; input.applicability.directSupplyIds = [supply.supplyId];
  plan.materialDecisions = [{ goalId: 'bounded-choice', supplyId: supply.supplyId, decision: 'used', evidenceIds: [...supply.evidenceIds] }];
  plan.goalDispositions[0].incrementalAssessment.materialBasis = { kind: 'supplied', supplyIds: [supply.supplyId], evidenceIds: [...supply.evidenceIds], reason: '功能前后完整证据绑定；这里只检查接口，不证明适用判断。' };
  assert.doesNotThrow(() => validateOpportunityPlan(plan, input));
  const half = copy(plan); half.materialDecisions[0].evidenceIds = ['after']; assert.throws(() => validateOpportunityPlan(half, input), /完整功能证据/);
  input.applicability.directSupplyIds = []; assert.throws(() => validateOpportunityPlan(plan, input), /direct_fit/);
});

test('unique multiline UTF16 citations resolve exactly; repeated quotes require an exact persisted position', () => {
  const chapters = [{ id: 'c', title: 'layout', body: '😀\r\n前文\n\n重复。\n\n重复。\n尾巴 ' }];
  const quote = '😀\r\n前文\n\n';
  assert.equal(resolveOpportunityEvidence({ chapterId: 'c', quote, start: null, purpose: 'layout' }, chapters).start, 0);
  assert.throws(() => resolveOpportunityEvidence({ chapterId: 'c', quote: '重复。', start: null, purpose: 'layout' }, chapters), /不唯一/);
  const start = chapters[0].body.lastIndexOf('重复。');
  assert.equal(resolveOpportunityEvidence({ chapterId: 'c', quote: '重复。', start, purpose: 'layout' }, chapters).start, start);
  assert.throws(() => resolveOpportunityEvidence({ chapterId: 'missing', quote, start: null, purpose: 'layout' }, chapters), /章节/);
});

test('completed new checkpoints resume with zero callbacks, and switching policy in either direction is rejected before dispatch', async () => {
  for (const enabled of [false,true]) {
    const f = fixture({ enabled, preserve: true }), result = await runWholeManuscriptQualityRevision(f.options); let callbacks = 0;
    const forbidden = async () => { callbacks++; throw new Error('OFFLINE_FORBIDDEN_DISPATCH'); };
    const resumed = await runWholeManuscriptQualityRevision({ request: f.request, artifacts: f.artifacts, model: { complete: forbidden }, queryDeepReferences: forbidden });
    assert.deepEqual(resumed, result); assert.equal(callbacks, 0);
    const changed = copy(f.request); if (enabled) delete changed.goalImprovementPolicy; else changed.goalImprovementPolicy = policy();
    await assert.rejects(runWholeManuscriptQualityRevision({ request: changed, artifacts: f.artifacts, model: { complete: forbidden }, queryDeepReferences: forbidden }), { code: 'WHOLE_QUALITY_CHECKPOINT_MISMATCH' });
    assert.equal(callbacks, 0);
  }
});

test('handoff preserves policy source binding without leaking it to anonymous review and rejects stripped policy', async () => {
  const f = fixture(), result = await runWholeManuscriptQualityRevision(f.options);
  const args = { caseId: 'offline-bound-handoff', request: f.request, result };
  const handoff = buildIndependentReviewRequest(args);
  assert.equal(Object.hasOwn(handoff.request, 'goalImprovementPolicy'), false);
  const stripped = copy(f.request); delete stripped.goalImprovementPolicy;
  assert.throws(() => buildIndependentReviewRequest({ ...args, request: stripped }), { code: 'HANDOFF_REQUEST_BINDING' });
});
