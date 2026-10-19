import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { manuscriptFingerprint } from '../../validation/runtime/checks.mjs';
import { buildIndependentReviewRequest } from './independent-review-handoff.mjs';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const at = (body, quote) => body.indexOf(quote);

const source = [
  { id: 'ch-1', title: '门口', body: '林遥走进来。她说：“我留下。”唐禾没回答。' },
  { id: 'ch-2', title: '账本', body: '唐禾把账本推回去。林遥仍站着。' },
];
const request = { kind: 'revise', revisionMode: 'whole-manuscript-v2', instruction: '只处理已证实的两处联动问题。',
  baseRevision: 'revision-7', chapters: source };

function fixture() {
  const replacements = [
    { targetId: 't-1', chapterId: 'ch-1', sourceQuote: '林遥走进来。', sourceStart: 0,
      replacement: '林遥走进来。唐禾把门关上。', appliedPlanItemIds: ['p-1'], notes: ['加入动作。'] },
    { targetId: 't-2', chapterId: 'ch-2', sourceQuote: '林遥仍站着。', sourceStart: at(source[1].body, '林遥仍站着。'),
      replacement: '林遥接过账本，记下自己要去的三家。', appliedPlanItemIds: ['p-2'], notes: ['落实承担。'] },
  ];
  const apply = selected => source.map(chapter => {
    let body = chapter.body;
    for (const item of replacements.filter(entry => entry.chapterId === chapter.id && selected.includes(entry.appliedPlanItemIds[0])).sort((a, b) => b.sourceStart - a.sourceStart))
      body = body.slice(0, item.sourceStart) + item.replacement + body.slice(item.sourceStart + item.sourceQuote.length);
    return { ...chapter, body };
  });
  const candidate = apply(['p-1', 'p-2']);
  const ev = (chapterId, quote) => ({ chapterId, quote, start: at(source.find(chapter => chapter.id === chapterId).body, quote), purpose: '修订前证据' });
  const issues = [
    { id: 'i-1', claimType: 'reader_effect_hypothesis', evidence: [ev('ch-1', '她说：“我留下。”')],
      counterEvidence: [ev('ch-1', '唐禾没回答。')] },
    { id: 'i-2', claimType: 'textual_conflict', evidence: [ev('ch-2', '林遥仍站着。')],
      counterEvidence: [ev('ch-2', '唐禾把账本推回去。')] },
  ];
  const item = (id, issueId, targetId, chapterId, action) => ({ id, issueIds: [issueId], decision: 'revise',
    action, expectedEffect: `${action}在正文中可见。`, failureCriteria: '只有解释，没有行为或后果。',
    actionRequirements: [{ id: `r-${id}`, description: action, targetIds: [targetId], expectedVisibleChange: `${action}形成可见结果`, failureCriterion: '只有口头承诺' }] });
  const plan = { items: [item('p-1', 'i-1', 't-1', 'ch-1', '保持说话人归属清楚'), item('p-2', 'i-2', 't-2', 'ch-2', '让林遥开始承担实际工作')] };
  const core = { kind: 'revise', revisionMode: 'whole-manuscript-v2', sourceBaseRevision: request.baseRevision,
    objective: request.instruction, chapters: source };
  return { title: '测试候选', chapters: candidate, warnings: [], baseRevision: request.baseRevision, revisionApplied: true,
    wholeRevision: { schemaVersion: 'whole-manuscript-quality-1', status: 'candidate_ready',
      requestSpec: { inputFingerprint: sha256(core), objective: request.instruction, sourceBaseRevision: request.baseRevision,
        sourceManuscriptSha256: manuscriptFingerprint(source) }, sourceChapters: source, plan,
      candidateRevision: { replacements, skippedPlanItems: [] },
      diff: { candidateManuscriptSha256: manuscriptFingerprint(candidate) },
      quality: { independentReading: { issues } },
      adoption: { status: 'not_applied', atomicGroups: [
        { planItemId: 'p-1', recommendation: 'eligible_for_user_choice' },
        { planItemId: 'p-2', recommendation: 'eligible_for_user_choice' },
      ] } } };
}

test('full candidate handoff freezes pre-revision goals and keeps controller provenance outside request', () => {
  const result = fixture(), handoff = buildIndependentReviewRequest({ caseId: 'case-full', request, result });
  assert.equal(handoff.request.mode, 'compare');
  assert.equal(handoff.request.candidate.mode, 'revised');
  assert.deepEqual(handoff.request.goals.map(goal => goal.id), ['p-1', 'p-2']);
  assert.equal(handoff.request.goals[1].claimType, 'hard_fact');
  assert.equal(handoff.request.goals[0].requiredOutcomes[0].dimension, 'other');
  assert.equal(handoff.provenance.artifactRole, 'full_candidate');
  assert.equal(handoff.provenance.rereadScope, 'full-candidate');
  assert.equal(handoff.provenance.requestBindingMode, 'legacy_exact');
  assert.equal(Object.hasOwn(handoff.request, 'provenance'), false);
  assert.match(handoff.provenance.provenanceSha256, /^[a-f0-9]{64}$/);
});

test('selected groups rebuild the actual mixed manuscript and cannot inherit full-candidate reread', () => {
  const result = fixture(), handoff = buildIndependentReviewRequest({ caseId: 'case-partial', request, result, selection: ['p-2'] });
  assert.equal(handoff.request.candidate.chapters[0].body, source[0].body);
  assert.match(handoff.request.candidate.chapters[1].body, /记下自己要去的三家/);
  assert.deepEqual(handoff.request.goals.map(goal => goal.id), ['p-2']);
  assert.deepEqual(handoff.provenance.selectedGroupIds, ['p-2']);
  assert.deepEqual(handoff.provenance.declinedGroupIds, ['p-1']);
  assert.equal(handoff.provenance.goalCoverage, 'selected_groups_only');
  assert.equal(handoff.provenance.rereadScope, 'selected-groups-unchecked');
  assert.notEqual(handoff.provenance.reviewCandidateManuscriptSha256, handoff.provenance.fullCandidateManuscriptSha256);
});

test('adjacency evidence exposes unchanged pronoun context and refuses to call attribution safe', () => {
  const handoff = buildIndependentReviewRequest({ caseId: 'case-adjacent', request, result: fixture(), selection: ['p-1'] });
  const [window] = handoff.provenance.adjacencyEvidence.windows;
  assert.equal(window.source.right, '她说：“我留下。”唐禾没回答。');
  assert.equal(window.candidate.target, '林遥走进来。唐禾把门关上。');
  assert.equal(window.candidate.right, '她说：“我留下。”唐禾没回答。');
  assert.equal(window.semanticStatus, 'requires_independent_attribution_review');
  assert.deepEqual(window.requiredChecks, ['pronoun_referent', 'dialogue_speaker', 'point_of_view_owner']);
});

test('handoff rejects post-hoc goals, tampered candidates, and ineligible adoption', () => {
  const missingCounter = fixture(); missingCounter.wholeRevision.quality.independentReading.issues[0].counterEvidence = [];
  assert.throws(() => buildIndependentReviewRequest({ caseId: 'bad-counter', request, result: missingCounter }), { code: 'HANDOFF_GOAL_BALANCE' });
  const tampered = fixture(); tampered.chapters[0].body += '越权文字';
  assert.throws(() => buildIndependentReviewRequest({ caseId: 'bad-candidate', request, result: tampered }), { code: 'HANDOFF_CANDIDATE_BINDING' });
  const ineligible = fixture(); ineligible.wholeRevision.adoption.atomicGroups[0].recommendation = 'not_recommended';
  assert.throws(() => buildIndependentReviewRequest({ caseId: 'bad-selection', request, result: ineligible, selection: ['p-1'] }), { code: 'HANDOFF_SELECTION_NOT_ELIGIBLE' });
});

test('no-change result hands off the preserved source without invented goals', () => {
  const result = fixture();
  result.chapters = structuredClone(source); result.revisionApplied = false;
  result.wholeRevision.status = 'no_change'; result.wholeRevision.candidateRevision = null;
  result.wholeRevision.plan = { items: [] };
  result.wholeRevision.diff.candidateManuscriptSha256 = manuscriptFingerprint(source);
  result.wholeRevision.adoption.atomicGroups = [];
  const handoff = buildIndependentReviewRequest({ caseId: 'case-no-change', request, result });
  assert.equal(handoff.request.candidate.mode, 'no_change');
  assert.deepEqual(handoff.request.goals, []);
  assert.equal(handoff.provenance.artifactRole, 'source_preserved');
});

test('planned revisions that produced no text change keep every frozen goal without claiming implementation', () => {
  const result = fixture();
  result.chapters = structuredClone(source); result.revisionApplied = false;
  result.wholeRevision.status = 'no_change'; result.wholeRevision.candidateRevision = null;
  result.wholeRevision.diff.candidateManuscriptSha256 = manuscriptFingerprint(source);
  result.wholeRevision.adoption.atomicGroups.forEach(group => { group.recommendation = 'not_recommended'; });
  const handoff = buildIndependentReviewRequest({ caseId: 'case-failed-revision', request, result });
  assert.equal(handoff.request.candidate.mode, 'no_change');
  assert.deepEqual(handoff.request.goals.map(goal => goal.id), ['p-1', 'p-2']);
  assert.deepEqual(handoff.provenance.plannedRevisionGroupIds, ['p-1', 'p-2']);
  assert.deepEqual(handoff.provenance.executedGroupIds, []);
  assert.deepEqual(handoff.provenance.unexecutedGoalGroupIds, ['p-1', 'p-2']);
  assert.equal(handoff.provenance.goalCoverage, 'full_plan');
  assert.equal(Object.hasOwn(handoff.request.goals[0], 'implemented'), false);
});

const crossBinding = { enabled: true, contractVersion: 'cross-chapter-review-result-1',
  integrationVersion: 'whole-quality-cross-chapter-integration-1', modelPolicy: 'whole-manuscript-quality-json-1' };
function crossFixture({ unresolved = false } = {}) {
  const result = fixture(), crossRequest = { ...request, crossChapterReview: crossBinding };
  const first = { chapterId: 'ch-1', quote: '她说：“我留下。”', start: at(source[0].body, '她说：“我留下。”'), purpose: '冲突一侧' };
  const second = { chapterId: 'ch-2', quote: '林遥仍站着。', start: at(source[1].body, '林遥仍站着。'), purpose: '冲突另一侧' };
  const conflict = { id: 'cross-chapter:fact-1', findingId: 'fact-1', claim: '同一承担状态在两章互斥。', evidence: [first, second], scopeOptions: [], limitations: [] };
  const core = { kind: 'revise', revisionMode: 'whole-manuscript-v2', sourceBaseRevision: request.baseRevision,
    objective: request.instruction, chapters: source, crossChapterReview: crossBinding };
  result.wholeRevision.requestSpec = { ...result.wholeRevision.requestSpec, inputFingerprint: sha256(core), crossChapterReview: crossBinding };
  result.wholeRevision.quality.crossChapterReview = { schemaVersion: 'whole-quality-cross-chapter-bundle-1',
    sourceManuscriptSha256: manuscriptFingerprint(source), review: { schemaVersion: 'cross-chapter-review-result-1' }, confirmedConflicts: [conflict] };
  result.wholeRevision.plan.items[1].issueIds = [conflict.id];
  result.wholeRevision.plan.unresolved = [];
  result.wholeRevision.quality.crossChapterResolution = { schemaVersion: 'whole-quality-cross-chapter-outcome-1',
    items: [{ conflictId: conflict.id, repairStatus: 'resolved_in_candidate', planItemIds: ['p-2'] }] };
  if (unresolved) {
    result.chapters = structuredClone(source); result.revisionApplied = false; result.wholeRevision.status = 'no_change';
    result.wholeRevision.candidateRevision = null; result.wholeRevision.diff.candidateManuscriptSha256 = manuscriptFingerprint(source);
    result.wholeRevision.plan.items = []; result.wholeRevision.plan.unresolved = [{ issueId: conflict.id, reason: '无法安全消歧。' }];
    result.wholeRevision.adoption.atomicGroups = [];
    result.wholeRevision.quality.crossChapterResolution.items[0] = { conflictId: conflict.id, repairStatus: 'unresolved', planItemIds: [] };
  }
  return { result, crossRequest };
}

test('handoff validates and preserves confirmed-conflict goals and resolution provenance for new results', () => {
  const { result, crossRequest } = crossFixture(), handoff = buildIndependentReviewRequest({ caseId: 'case-cross', request: crossRequest, result });
  assert.deepEqual(handoff.provenance.confirmedConflictIds, ['cross-chapter:fact-1']);
  assert.deepEqual(handoff.provenance.unresolvedConfirmedConflictIds, []);
  assert.match(handoff.provenance.crossChapterResolutionSha256, /^[a-f0-9]{64}$/);
  assert.equal(handoff.request.goals[1].claimType, 'hard_fact');
  assert.equal(handoff.request.goals[1].sourceEvidence[0].quote, '她说：“我留下。”');
  assert.equal(handoff.request.goals[1].counterCase[0].quote, '林遥仍站着。');
  const forged = structuredClone(result); forged.wholeRevision.quality.crossChapterResolution.items = [];
  assert.throws(() => buildIndependentReviewRequest({ caseId: 'bad-cross', request: crossRequest, result: forged }), { code: 'HANDOFF_CROSS_CHAPTER_OUTCOME' });
});

test('runtime-normalized cross binding repairs persisted-request omission without trusting a client binding', () => {
  const { result, crossRequest } = crossFixture();
  const persistedRequest = structuredClone(crossRequest);
  delete persistedRequest.crossChapterReview;
  const normalized = buildIndependentReviewRequest({ caseId: 'case-cross-omitted', request: persistedRequest, result });
  const exact = buildIndependentReviewRequest({ caseId: 'case-cross-omitted', request: crossRequest, result });
  assert.deepEqual(normalized.request, exact.request);
  assert.equal(normalized.provenance.requestBindingMode, 'runtime_normalized_cross_binding');
  assert.equal(exact.provenance.requestBindingMode, 'persisted_exact');
  assert.deepEqual(normalized.provenance.confirmedConflictIds, ['cross-chapter:fact-1']);

  const forgedClientRequest = structuredClone(crossRequest);
  forgedClientRequest.crossChapterReview.modelPolicy = 'client-invented-policy';
  assert.throws(() => buildIndependentReviewRequest({ caseId: 'bad-client-binding', request: forgedClientRequest, result }),
    { code: 'HANDOFF_REQUEST_BINDING' });

  const changedPersistedRequest = structuredClone(persistedRequest);
  changedPersistedRequest.instruction += '越权增加目标';
  assert.throws(() => buildIndependentReviewRequest({ caseId: 'bad-normalized-core', request: changedPersistedRequest, result }),
    { code: 'HANDOFF_REQUEST_BINDING' });
});

test('handoff accepts new no_change only with an explicit unresolved confirmed conflict retained in provenance', () => {
  const { result, crossRequest } = crossFixture({ unresolved: true });
  const handoff = buildIndependentReviewRequest({ caseId: 'case-cross-unresolved', request: crossRequest, result });
  assert.equal(handoff.request.candidate.mode, 'no_change');
  assert.deepEqual(handoff.request.goals, []);
  assert.deepEqual(handoff.provenance.confirmedConflictIds, ['cross-chapter:fact-1']);
  assert.deepEqual(handoff.provenance.unresolvedConfirmedConflictIds, ['cross-chapter:fact-1']);
});
