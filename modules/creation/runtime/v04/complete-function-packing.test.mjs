import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createDeepReferenceRetrievalAdapter, assertGoalDeepReferencePacket, projectOpportunityModelInput,
  resolveDeepReferenceCallback, composeRetrievalPackets, COMPARABLE_DEEP_FIRST_COMPOSITION_VERSION } from './deep-reference.mjs';
import { buildWholeQualityQuery } from '../../../data/runtime/whole-quality-retrieval.mjs';
import { runWholeManuscriptQualityRevision, assertWholeQualityResult } from '../whole-manuscript-quality.mjs';
import { fixture } from '../goal-opportunity-fixtures.mjs';
import { WRITING_GOAL_DATA_OPTIONS, writingGoalQuerySubject } from '../writing-goals.mjs';
import { COMPARABLE_FUNCTION_PACKING } from '../goal-opportunity.mjs';
import { buildIndependentReviewRequest } from '../independent-review-handoff.mjs';
const sha = text => createHash('sha256').update(text).digest('hex');
const clone = value => structuredClone(value);
const sourceId = n => `offline-source-${n}`;
function dataResult(n, functions = 3) {
  const id = sourceId(n), sourceSha256 = sha(`source-${n}`), sourceTextSha256 = sha(`text-${n}`), candidateSha256 = sha(`candidate-${n}`), reportSha256 = sha(`review-${n}`);
  const exactReferences = Array.from({ length: functions * 2 }, (_,i) => {
    const quote = `完整证据 source${n} part${i}：角色面对物证作有限选择。 `;
    return { evidenceId: `${id}-e${i}`, unitId: `${id}-u${i}`, locator: { lineStart: i + 1, lineEnd: i + 1, charStart: i * 100, charEnd: i * 100 + quote.length },
      quoteSha256: sha(quote), textVersion: 'text-v1', quote, sourceId: id, sourceSha256, sourceTextSha256 };
  });
  return { referenceId: `deepref:${id}:${candidateSha256.slice(0,16)}:${reportSha256.slice(0,16)}`,
    source: { sourceId: id, sourceSha256, sourceTextSha256, textVersion: 'text-v1', title: `离线来源${n}` },
    analysis: { analysisId: `a-${n}`, analysisVersion: 'deep-v1', candidateSha256, packetSha256: sha(`packet-${n}`), candidateStatus: 'candidate_unreviewed', approved: false, checked: false, active: false },
    semanticReview: { reportPath: `reviews/${id}.json`, reportSha256, verdict: 'retain_with_caveats', caveats: ['文学解释不等于事实证明。'], blockingDefects: [], approvalGranted: false, activeProductionChanged: false },
    match: { matchedTerms: ['选择','代价'], matchedTermCount: 2, requiredMatchedTermCount: 2, lexicalScore: 2, semanticSimilarityClaimed: false },
    borrowableWritingFunctions: Array.from({ length: functions }, (_,i) => ({ functionId: `${id}-f${i}`, dimension: 'psychologicalChangeDrivers', status: 'evidence_bound_hypothesis',
      observablePattern: '两个精确落点之间出现有限行动。', borrowableFunction: '比较转折前后而非只有主题相似。', alternatives: ['仍可能没有心理转变。'], limitation: '不能据此认定承担自己责任。',
      evidenceIds: exactReferences.slice(i*2,i*2+2).map(e => e.evidenceId), unitIds: exactReferences.slice(i*2,i*2+2).map(e => e.unitId) })),
    exactReferences, limits: { visibility: '仅见证据窗', statements: ['不复制情节。'] }, retrievalIsUse: false, requiresExplicitAdoption: true };
}
function response(request, results = [dataResult(1),dataResult(2),dataResult(3)]) {
  const normalized = { problem: { ...clone(request.problem), requiredTermGroups: request.problem.requiredTermGroups ?? [] }, dimensions: clone(request.dimensions), sourceIds: request.sourceIds ?? null,
    limit: request.limit, maxFunctionsPerResult: request.maxFunctionsPerResult, maxEvidenceRefsPerResult: request.maxEvidenceRefsPerResult };
  const installId = 'offline-complete-function-test';
  return { schemaVersion: 'analysis99-problem-query-2', queryId: `deepref-query-${sha(`${JSON.stringify({installId,request:normalized},null,2)}\n`)}`,
    installId, request: normalized, status: results.length ? 'covered' : 'uncovered', resultCount: results.length, limits: { maxResults: 8 }, boundary: 'retrieval is not use', retrievalIsUse: false, requiresExplicitAdoption: true, results };
}
function setup() {
  const f = fixture({ preserve: true }), goal = f.request.writingGoals.goals[0], query = buildWholeQualityQuery(writingGoalQuerySubject(goal));
  const options = { path: 'whole_manuscript_writing_goal', problem: goal.problem, ...WRITING_GOAL_DATA_OPTIONS };
  return { f, goal, query, options };
}
function legacyPacket(query) {
  const content = '既有136完整材料；是否适用仍须独立判断。', material = { id: 'legacy-material', title: '既有材料', kind: 'retrieved', use: 'raw_reference',
    content, sha256: sha(content), references: [{ sourceId: 'legacy-source', sourceSha256: sha('legacy-source'),
      textVersion: 'legacy-text-v1', analysisVersion: 'legacy-analysis-v1', unitIds: [], lineStart: 3, lineEnd: 3 }],
    selectionReason: '既有136有界命中', limitations: ['仍须判断适用性'] };
  return { contractVersion: 'v04-contract-1', packetId: 'legacy-packet', query: clone(query), status: 'matched',
    materials: [material], candidates: [{ id: material.id, sourceId: 'legacy-source', reason: '既有136候选' }], usedChars: content.length, limits: ['命中不等于采用'] };
}
const compositionOptions = { compositionPolicyVersion: COMPARABLE_DEEP_FIRST_COMPOSITION_VERSION };

test('production compose → applicability → plan retains two complete deep sources before legacy and allows all declined', async () => {
  const { f, goal, query, options } = setup(), original = f.model.complete, captures = {};
  let deepCalls = 0, legacyCalls = 0;
  const supply = request => response(request, [dataResult(1,2),dataResult(2,1)]);
  const deep = await createDeepReferenceRetrievalAdapter(async request => supply(request), { ...options, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING })(query);
  const old = composeRetrievalPackets(query, deep, legacyPacket(query));
  assert.equal(old.deepReference.composition.selectedDeepMaterialIds.length, 1); // Reproduces the lost comparison source.
  f.options.queryDeepReferences = async request => { deepCalls++; return supply(request); };
  f.options.retrieveKnowledge = async query => { legacyCalls++; return legacyPacket(query); };
  f.options.model = { complete: async args => {
    const input = JSON.parse(args.user); captures[args.stage] = { input, system: args.system };
    if (args.stage === 'whole-quality:applicability') return JSON.stringify({ ...input.responseExample,
      assessments: input.responseExample.assessments.map(row => ({ ...row, reason: '离线夹具保留未知，完整供应不自动变成适用。' })) });
    const raw = await original(args);
    if (args.stage !== 'whole-quality:plan') return raw;
    const plan = JSON.parse(raw); plan.materialDecisions = input.responseExample.materialDecisions;
    return JSON.stringify(plan);
  } };
  const result = await runWholeManuscriptQualityRevision(f.options);
  assert.equal(deepCalls, 1); assert.equal(legacyCalls, 1);
  for (const stage of ['whole-quality:applicability','whole-quality:plan']) {
    const input = captures[stage].input, packet = input.retrieval.byGoal[0].result.packet;
    assert.deepEqual(packet.materials, deep.materials);
    assert.deepEqual(input.retrieval.supplies.map(s => s.materialId), deep.materials.map(m => m.id));
    assert.equal(packet.deepReference.composition.legacyStatus, 'matched');
    assert.deepEqual(packet.deepReference.composition.selectedLegacyMaterialIds, []);
    assert.equal(packet.deepReference.composition.policyVersion, COMPARABLE_DEEP_FIRST_COMPOSITION_VERSION);
    const ledger = packet.deepReference.composition.finalSupplySelection;
    assert.equal(ledger.usedUnits, 6); assert.deepEqual(ledger.supplied.map(row => row.materialId), deep.materials.map(m => m.id));
    assert.equal(ledger.excluded[0].materialId, 'legacy-material'); assert.equal(ledger.excluded[0].reason, 'shared_composition_budget');
    assert.equal(ledger.excluded[0].applicability, 'not_assessed');
    assert(packet.usedChars <= 12000); assert.equal(packet.usedChars, deep.usedChars);
    for (const material of packet.materials) {
      const selected = packet.deepReference.functionSelection.selections.find(row => row.materialId === material.id);
      const functions = JSON.parse(material.content.split('\n\n')[0]).borrowableWritingFunctions;
      assert.deepEqual(functions.map(fn => fn.functionId), selected.selectedFunctionIds);
      assert.equal(functions.every(fn => fn.evidenceIds.length === 2), true);
      assert.equal(input.retrieval.supplies.find(s => s.materialId === material.id).evidenceIds.length, material.references.length);
    }
    assert(captures[stage].system.includes('不得') && captures[stage].system.includes('子目标'));
  }
  assert(captures['whole-quality:plan'].input.goalOpportunityGuidance.includes('无direct_fit'));
  assert(captures['whole-quality:applicability'].input.functionalComparisonGuidance.includes('题材'));
  assert.equal(result.wholeRevision.status, 'no_change'); assert.deepEqual(result.chapters, f.chapters);
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
  const packet = f.artifacts['whole-quality:plan:input'].input.retrieval.byGoal[0].result.packet;
  const checkedOptions = { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING, ...compositionOptions };
  assertGoalDeepReferencePacket(packet, goal.problem, checkedOptions);
  for (const mutate of [p => { p.materials.pop(); }, p => { p.materials[1].content += 'edited'; },
    p => { p.deepReference.composition.selectedDeepMaterialIds.pop(); }, p => { p.deepReference.composition.policyVersion = 'creation-deep-plus-legacy-composition-1'; },
    p => { delete p.deepReference.composition; }, p => { delete p.deepReference.composition.finalSupplySelection; },
    p => { p.deepReference.composition.finalSupplySelection.usedChars++; },
    p => { p.deepReference.composition.finalSupplySelection.supplied[1].functionIds.pop(); },
    p => { p.deepReference.composition.finalSupplySelection.excluded[0].applicability = 'inapplicable'; }]) {
    const changed = clone(packet); mutate(changed); assert.throws(() => assertGoalDeepReferencePacket(changed, goal.problem, checkedOptions));
  }
  const handoffArgs = { caseId: 'offline-composition-binding', request: f.request, result };
  const handoff = buildIndependentReviewRequest(handoffArgs); assert.equal(JSON.stringify(handoff.request).includes(COMPARABLE_DEEP_FIRST_COMPOSITION_VERSION), false);
  for (const version of [undefined, 'unknown']) {
    const changed = clone(result);
    if (version === undefined) delete changed.wholeRevision.requestSpec.deepReferenceCompositionPolicyVersion;
    else changed.wholeRevision.requestSpec.deepReferenceCompositionPolicyVersion = version;
    assert.throws(() => assertWholeQualityResult(changed, changed.wholeRevision.requestSpec));
    assert.throws(() => buildIndependentReviewRequest({ ...handoffArgs, result: changed }), { code: 'HANDOFF_REQUEST_BINDING' });
  }
  let callbacks = 0; const forbidden = async () => { callbacks++; throw new Error('NO_DISPATCH_ON_REPLAY'); };
  const resumed = await runWholeManuscriptQualityRevision({ request: f.request, artifacts: f.artifacts,
    model: { complete: forbidden }, queryDeepReferences: forbidden, retrieveKnowledge: forbidden });
  assert.deepEqual(resumed, result); assert.equal(callbacks, 0);
  const changed = clone(f.artifacts); delete changed.requestSpec.deepReferenceCompositionPolicyVersion;
  await assert.rejects(runWholeManuscriptQualityRevision({ request: f.request, artifacts: changed,
    model: { complete: forbidden }, queryDeepReferences: forbidden, retrieveKnowledge: forbidden }), { code: 'WHOLE_QUALITY_CHECKPOINT_MISMATCH' });
  assert.equal(callbacks, 0);
});

test('complete comparable pack leaves legacy only the residual budget, preserves failures, and refuses silent clipping or unknown policy', async () => {
  const { goal, query, options } = setup();
  const adapter = createDeepReferenceRetrievalAdapter(async request => response(request,[dataResult(1,1),dataResult(2,1)]),
    { ...options, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING });
  const deep = await adapter(query), legacy = legacyPacket(query);
  const packet = await resolveDeepReferenceCallback(adapter, async () => legacy, compositionOptions)(query);
  assert.deepEqual(packet.materials, [...deep.materials,...legacy.materials]);
  assert.deepEqual(packet.deepReference.composition.selectedLegacyMaterialIds, ['legacy-material']);
  assertGoalDeepReferencePacket(packet, goal.problem, { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING, ...compositionOptions });
  assert.throws(() => composeRetrievalPackets({ ...query, budget: { ...query.budget, maxUnits: 7 } },
    { ...deep, query: { ...query, budget: { ...query.budget, maxUnits: 7 } } }, legacy, compositionOptions), /扩大共同预算/);
  const oversize = clone(deep); oversize.materials[1].content = 'x'.repeat(12000);
  assert.throws(() => composeRetrievalPackets(query, oversize, legacy, compositionOptions), /不得静默丢弃/);
  assert.throws(() => resolveDeepReferenceCallback(adapter, async () => legacy, { compositionPolicyVersion: 'unknown' }), /未知/);
  const absent = createDeepReferenceRetrievalAdapter(async () => { throw new Error('OFFLINE_UNAVAILABLE'); }, { ...options, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING });
  const fallback = await resolveDeepReferenceCallback(absent, async () => legacy, compositionOptions)(query);
  assert.deepEqual(fallback.materials, legacy.materials); assert.equal(fallback.deepReference.composition.deepStatus, 'unavailable');
  assertGoalDeepReferencePacket(fallback, goal.problem, { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING, ...compositionOptions });
  const noLegacy = await resolveDeepReferenceCallback(adapter, undefined, compositionOptions)(query);
  assertGoalDeepReferencePacket(noLegacy, goal.problem, { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING, ...compositionOptions });
});

test('new opt-in pack fits complete two-ref functions from three sources in the same total budget; default pack stays sequential', async () => {
  const { goal, query, options } = setup(); let supplied;
  const callback = async request => supplied = response(request);
  const legacy = await createDeepReferenceRetrievalAdapter(callback, options)(query);
  const packet = await createDeepReferenceRetrievalAdapter(callback, { ...options, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING })(query);
  assert.equal(legacy.deepReference.functionSelection.schemaVersion, 'creation-whole-goal-complete-functions-1');
  assert.equal(packet.deepReference.functionSelection.schemaVersion, COMPARABLE_FUNCTION_PACKING);
  assert.equal(legacy.materials.length, 1); assert.equal(packet.materials.length, 3);
  assert.equal(packet.usedChars, packet.materials.reduce((sum,m) => sum + m.content.length, 0)); assert(packet.usedChars <= query.budget.maxChars);
  const units = new Set(packet.materials.flatMap(m => m.references.flatMap(r => r.unitIds.map(id => `${r.sourceId}:${id}`)))); assert.equal(units.size, 6);
  for (const material of packet.materials) {
    const projected = JSON.parse(material.content.split('\n\n')[0]); assert.equal(projected.borrowableWritingFunctions.length, 1);
    const fn = projected.borrowableWritingFunctions[0]; assert.equal(fn.evidenceIds.length, 2);
    const original = supplied.results.find(result => result.referenceId === material.id);
    for (const e of original.exactReferences.filter(e => fn.evidenceIds.includes(e.evidenceId))) assert(material.content.includes(e.quote));
    assert(projected.comparison.every(card => card.applicability === 'not_assessed' && card.unknownFields.length === 4));
    assert.equal(material.sha256, sha(material.content));
  }
  assertGoalDeepReferencePacket(packet, goal.problem, { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING });
  assert.throws(() => assertGoalDeepReferencePacket(packet, goal.problem, WRITING_GOAL_DATA_OPTIONS), /策略/);
  for (const mutate of [p => { p.deepReference.comparison.cards[0].fields.actor.value = '伪造行动者'; }, p => { p.deepReference.functionSelection.selections[0].selectedFunctionIds.push('fake'); }, p => { p.materials[0].content += '未绑定说明'; }]) {
    const altered = clone(packet); mutate(altered); assert.throws(() => assertGoalDeepReferencePacket(altered, goal.problem, { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING }));
  }
});

test('zero capacity for a complete function preserves hits and budget exclusion, never supplies one side of a transition', async () => {
  const { goal, query, options } = setup(); const constrained = { ...query, budget: { ...query.budget, maxUnits: 1 } };
  const packet = await createDeepReferenceRetrievalAdapter(async request => response(request,[dataResult(1,1)]), { ...options, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING })(constrained);
  assert.equal(packet.materials.length, 0); assert.equal(packet.deepReference.response.resultCount, 1);
  const excluded = packet.deepReference.functionSelection.selections[0]; assert.equal(excluded.completeEvidence, true); assert.equal(excluded.selectedFunctionIds.length, 0);
  assert.equal(excluded.budgetExcludedFunctionIds.length, 1); assert.equal(excluded.applicability, 'not_assessed');
  assertGoalDeepReferencePacket(packet, goal.problem, { ...WRITING_GOAL_DATA_OPTIONS, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING });
});

test('budget-excluded raw quotes and comparison cards remain host-only; default model input is unchanged', async () => {
  const { f, query, options } = setup();
  const packet = await createDeepReferenceRetrievalAdapter(async request => response(request), { ...options, functionPackingPolicy: COMPARABLE_FUNCTION_PACKING })(query);
  const input = { requestSpec: { goalImprovementPolicy: f.request.goalImprovementPolicy }, retrieval: { byIssue: [], byGoal: [{ result: { packet } }] } };
  const visible = projectOpportunityModelInput(input), metadata = visible.retrieval.byGoal[0].result.packet.deepReference;
  assert.equal(metadata.response, undefined); assert.equal(metadata.comparison, undefined);
  assert.equal(metadata.dataResponseSummary.resultCount, 3); assert(metadata.dataResponseSummary.responseSha256);
  assert.equal(JSON.stringify(visible).includes('完整证据 source1 part5'), false);
  assert(JSON.stringify(visible).includes('完整证据 source1 part0'));
  assert(input.retrieval.byGoal[0].result.packet.deepReference.response);
  const old = { ...input, requestSpec: {} }; assert.equal(projectOpportunityModelInput(old), old);
});

test('real whole pipeline compares four axes against target text and may reject every supplied candidate then preserve', async () => {
  const { f } = setup(), original = f.model.complete;
  f.options.queryDeepReferences = async request => response(request);
  f.options.model = { complete: async args => {
    const input = JSON.parse(args.user);
    if (args.stage === 'whole-quality:applicability') {
      f.events.push(args.stage); f.inputs[args.stage] = input;
      for (const axis of ['actor','emotionalDirection','acknowledgmentObject','costBearer']) assert(args.system.includes(axis));
      assert.deepEqual(input.targetChapters, f.chapters); assert(args.system.includes('unknown'));
      assert.equal(input.retrieval.byGoal[0].result.packet.deepReference.response, undefined);
      return JSON.stringify({ ...input.responseBindings, assessments: input.retrieval.supplies.map(s => ({ supplyId: s.supplyId, issueId: s.issueId, materialId: s.materialId,
        fit: 'insufficient_context', reason: '行动者未明；转变方向只见行动；承认对象未明；代价承担者未明。目标要求承担本人职责，不能仅凭选择主题判断适用。', evidenceIds: [], transferBoundary: '完整引文尚不支持四轴迁移，全部拒绝，不复制来源事件。' })),
        noSuitableReasons: input.writingGoals.map(g => ({ issueId: g.querySubjectId, reason: '来源四轴unknown尚无独立证据补足；保留不适用与未采用。' })) });
    }
    const raw = await original(args);
    if (args.stage !== 'whole-quality:plan') return raw;
    const plan = JSON.parse(raw); plan.materialDecisions = input.retrieval.supplies.map(s => ({ supplyId: s.supplyId, issueId: s.issueId, materialId: s.materialId, goalId: s.goalId,
      decision: 'not_used', planItemIds: [], evidenceIds: [], reason: '不能证明该来源对应本人承担责任，保留拒用。', applicabilityBoundary: 'unknown不能默认fit。', limitations: ['有命中不等于适用。'] }));
    return JSON.stringify(plan);
  } };
  const result = await runWholeManuscriptQualityRevision(f.options), goal = result.wholeRevision.quality.writingGoals.goals[0];
  assert.equal(goal.deepMaterialOutcome, 'supplied_all_declined'); assert.equal(goal.deepQuery.returnedCandidateCount, 3); assert.equal(goal.deepQuery.suppliedMaterialCount, 3);
  assert.equal(result.wholeRevision.status, 'no_change'); assert.deepEqual(result.chapters, f.chapters);
  assert.deepEqual(f.events, ['whole-quality:reading','whole-quality:applicability','whole-quality:plan','whole-quality:reread']);
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
});
