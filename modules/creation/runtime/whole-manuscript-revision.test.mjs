import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runWholeManuscriptRevision, assertWholeRevisionResult, createWholeRevisionRequestSpec,
} from './whole-manuscript-revision.mjs';

const chapters = [
  { id: 'ch-1', title: '旧账', body: '林岚把尺寸簿推回柜台。她说先把旧账分清，再谈谁留下。尺寸簿压住了一张收据。' },
  { id: 'ch-2', title: '折角', body: '林遥第二次把尺寸簿推回去。这一次，她把欠款页折了角。她没有再说自己只是回来帮忙。' },
  { id: 'ch-3', title: '交接', body: '交钥匙那天，林岚留下周末完成寿衣的工时单。林遥接过清单，没有说原谅。' },
];
const request = () => ({ projectId: 'whole-test', requestId: 'run-1', kind: 'revise', revisionMode: 'whole-manuscript-v1',
  idea: '整稿调整', instruction: '加强姐妹认知变化的跨场景联系，保留克制结尾。', chapters: structuredClone(chapters),
  quote: '', baseRevision: 'base-7', projectTitle: '尺寸簿' });
const binding = (user, key) => user.responseBindings[key];
const rawEvidence = (chapterId, quote, purpose, occurrence) => ({ chapterId, quote, purpose, ...(occurrence ? { occurrence } : {}) });

function diagnosisResponse(user, { ambiguous = false } = {}) {
  return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), checkedChapterIds: binding(user, 'checkedChapterIds'),
    coverage: { status: 'complete', omissions: [] }, summary: '尺寸簿动作形成回环，但第二次动作与认识变化的联系可以更清楚。',
    findings: [{ id: 'd-1', claimType: 'reader_effect_hypothesis', area: 'emotion_progression', disposition: 'candidate_change',
      observation: '两次推回尺寸簿的动作形成有效回环；第二次动作之后的选择可以更明确地承接旧账认识。',
      suspectedCause: '第二场已有折角动作，但它与妹妹重新判断姐姐承担方式的联系较隐约。',
      evidence: [
        rawEvidence('ch-1', ambiguous ? '尺寸簿' : '林岚把尺寸簿推回柜台。', '第一次动作建立防守语境', ambiguous ? undefined : undefined),
        rawEvidence('ch-2', '林遥第二次把尺寸簿推回去。', '第二次动作改变执行者与当下选择')],
      counterEvidence: [rawEvidence('ch-2', '她把欠款页折了角。', '动作已经提供了一部分认识变化')],
      preservation: [rawEvidence('ch-3', '林遥接过清单，没有说原谅。', '克制结尾不应被改成强制和解')],
      limitations: ['这是读者效果假设，不是已证实缺陷。'] }] });
}
function diagnosisRepairResponse(user) {
  const input = user.originalInput;
  return JSON.stringify({ ...JSON.parse(diagnosisResponse(input)),
    findings: [{ ...JSON.parse(diagnosisResponse(input)).findings[0],
      evidence: [rawEvidence('ch-1', '尺寸簿', '第一次出现的尺寸簿建立防守语境', 1),
        rawEvidence('ch-2', '林遥第二次把尺寸簿推回去。', '第二次动作改变执行者与当下选择')] }] });
}
function preserveDiagnosisResponse(user) {
  return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), checkedChapterIds: binding(user, 'checkedChapterIds'), coverage: { status: 'complete', omissions: [] },
    summary: '重复动作与克制结尾已经承担明确作用。', findings: [{ id: 'd-p', claimType: 'reader_effect_hypothesis', area: 'meaningful_repetition', disposition: 'preserve',
      observation: '两次推回尺寸簿形成执行者变化。', suspectedCause: '回环用于关系差异而非信息重复。',
      evidence: [rawEvidence('ch-1', '林岚把尺寸簿推回柜台。', '第一次动作'), rawEvidence('ch-2', '林遥第二次把尺寸簿推回去。', '第二次动作')],
      counterEvidence: [], preservation: [rawEvidence('ch-3', '没有说原谅。', '保留有限合作')], limitations: ['不据此证明所有读者都认为有效。'] }] });
}
function planResponse(user, { preserve = false } = {}) {
  return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), diagnosisSha256: binding(user, 'diagnosisSha256'),
    decision: preserve ? 'preserve_original' : 'revise', summary: preserve ? '保留原稿，不为改而改。' : '只调整第二章一句，使折角动作连接新的分工判断。',
    items: preserve ? [{ id: 'p-keep', diagnosisIds: ['d-p'], decision: 'preserve', affectedChapterIds: [], targets: [],
      action: '保留回环。', rationale: '两次动作作用不同。', expectedEffect: '维持克制推进。', risks: ['可能仍有读者希望解释更多。'], preserve: [] }]
      : [{ id: 'p-1', diagnosisIds: ['d-1'], decision: 'revise', affectedChapterIds: ['ch-2'],
        targets: [{ id: 'target-1', ...rawEvidence('ch-2', '她没有再说自己只是回来帮忙。', '把否定表态改成当下分工判断') }],
        action: '把泛化否定改成与欠款页和当下分工相连的一句。', rationale: '连接第一章旧账防守与第二章妹妹的新选择。',
        expectedEffect: '让认知变化通过当下分工显现。', risks: ['解释过满会损伤克制。'],
        preserve: [rawEvidence('ch-3', '林遥接过清单，没有说原谅。', '保留有限合作结尾')] }], unresolved: [] });
}
function crossChapterPlanResponse(user) {
  const value = JSON.parse(planResponse(user));
  value.summary = '把同一认知变化绑定到第一章防守与第二章承担，作为不可拆分的一项。';
  value.items[0].affectedChapterIds = ['ch-1', 'ch-2'];
  value.items[0].targets = [
    { id: 'target-a', ...rawEvidence('ch-1', '她说先把旧账分清，再谈谁留下。', '第一场防守判断') },
    { id: 'target-b', ...rawEvidence('ch-2', '她没有再说自己只是回来帮忙。', '第二场承担判断') },
  ];
  return JSON.stringify(value);
}
function preservationAttackPlanResponse(user) {
  const value = JSON.parse(planResponse(user));
  value.summary = '错误地尝试覆盖诊断明确要求保留的克制结尾。';
  value.items[0].affectedChapterIds = ['ch-3'];
  value.items[0].targets = [{ id: 'target-protected',
    ...rawEvidence('ch-3', '林遥接过清单，没有说原谅。', '尝试把克制结尾改成明确和解') }];
  value.items[0].preserve = [rawEvidence('ch-1', '林岚把尺寸簿推回柜台。', '用无关保护项掩盖遗漏')];
  return JSON.stringify(value);
}
function candidateResponse(user, { malformed = false } = {}) {
  if (malformed) return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), planSha256: binding(user, 'planSha256'), replacements: [{ targetId: 'unknown', chapterId: 'ch-2', sourceQuote: '不存在', replacement: '坏', appliedPlanItemIds: ['p-1'], notes: ['坏范围'] }], skippedPlanItems: [] });
  return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), planSha256: binding(user, 'planSha256'),
    replacements: [{ targetId: 'target-1', chapterId: 'ch-2', sourceQuote: '她没有再说自己只是回来帮忙。',
      replacement: '她把欠款页推到姐姐手边，说余下的电话由自己来打。', appliedPlanItemIds: ['p-1'], notes: ['用当下分工表现认识变化，不补和解。'] }],
    skippedPlanItems: [] });
}
function crossChapterCandidateResponse(user, mode) {
  const replacements = [
    { targetId: 'target-a', chapterId: 'ch-1', sourceQuote: '她说先把旧账分清，再谈谁留下。',
      replacement: '她说先把旧账分清，也把周末的单子留下。', appliedPlanItemIds: ['p-1'], notes: ['第一场承担开始显形。'] },
    { targetId: 'target-b', chapterId: 'ch-2', sourceQuote: '她没有再说自己只是回来帮忙。',
      replacement: '她把欠款页推到姐姐手边，说余下的电话由自己来打。', appliedPlanItemIds: ['p-1'], notes: ['第二场接过实际分工。'] },
  ];
  return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), planSha256: binding(user, 'planSha256'),
    replacements: mode === 'all' ? replacements : replacements.slice(0, 1),
    skippedPlanItems: mode === 'mixed' ? [{ planItemId: 'p-1', reason: '错误地同时跳过。' }] : [] });
}
function rereadResponse(user) {
  const changed = user.candidateChapters[1].body.includes('余下的电话由自己来打');
  return JSON.stringify({ schemaVersion: binding(user, 'schemaVersion'), inputHash: binding(user, 'inputHash'),
    sourceManuscriptSha256: binding(user, 'sourceManuscriptSha256'), candidateManuscriptSha256: binding(user, 'candidateManuscriptSha256'),
    checkedChapterIds: binding(user, 'checkedChapterIds'), coverage: { status: 'complete', omissions: [] },
    summary: changed ? '候选把认识变化落实为分工，同时保留第三章有限合作。' : '原稿回环和克制结尾保持完整。',
    changeChecks: user.plan.items.filter(item => item.decision === 'revise').map(item => ({ planItemId: item.id,
      assessment: changed ? 'supported' : 'uncertain', reason: changed ? '第二章新增行动承接旧账并改变分工。' : '没有实际替换。',
      evidence: changed ? [rawEvidence('ch-2', '她把欠款页推到姐姐手边，说余下的电话由自己来打。', '当下分工行动')] : [], risks: ['仍属于AI阅读判断。'] })),
    introducedIssues: [], unresolvedItems: [], preservedStrengths: [rawEvidence('ch-3', '林遥接过清单，没有说原谅。', '有限合作结尾仍在')] });
}

function journal() {
  const artifacts = {};
  return { artifacts, checkpoint: async (key, value) => { artifacts[key] = structuredClone(value); } };
}
function modelFor({ preserve = false, ambiguous = false, badReread = false, malformedRevision = false, throwRevision = false,
  crossMode, preservationAttack = false } = {}) {
  const calls = [];
  return { calls, complete: async args => {
    calls.push(args); const user = JSON.parse(args.user);
    if (args.stage === 'whole-revision:diagnosis') return preserve ? preserveDiagnosisResponse(user) : diagnosisResponse(user, { ambiguous });
    if (args.stage === 'whole-revision:diagnosis:format-repair') return diagnosisRepairResponse(user);
    if (args.stage === 'whole-revision:plan') return preservationAttack ? preservationAttackPlanResponse(user)
      : crossMode ? crossChapterPlanResponse(user) : planResponse(user, { preserve });
    if (args.stage === 'whole-revision:plan:format-repair') return preservationAttack ? preservationAttackPlanResponse(user.originalInput)
      : crossMode ? crossChapterPlanResponse(user.originalInput) : planResponse(user.originalInput, { preserve });
    if (args.stage === 'whole-revision:revision') { if (throwRevision) throw Object.assign(new Error('transport down'), { code: 'ECONNRESET' });
      return crossMode ? crossChapterCandidateResponse(user, crossMode) : candidateResponse(user, { malformed: malformedRevision }); }
    if (args.stage === 'whole-revision:revision:format-repair') return crossMode ? crossChapterCandidateResponse(user.originalInput, crossMode)
      : candidateResponse(user.originalInput, { malformed: malformedRevision });
    if (args.stage === 'whole-revision:reread') return badReread ? '{bad' : rereadResponse(user);
    if (args.stage === 'whole-revision:reread:format-repair') return badReread ? '{bad' : rereadResponse(user.originalInput);
    throw new Error(`unexpected stage ${args.stage}`);
  } };
}

test('whole revision derives evidence offsets, applies only target ranges, rereads full candidate, and keeps adoption pending', async () => {
  const j = journal(), model = modelFor(), input = request(), before = structuredClone(input);
  const result = await runWholeManuscriptRevision({ request: input, model, artifacts: {}, checkpoint: j.checkpoint });
  assert.deepEqual(input, before); assert.deepEqual(result.wholeRevision.sourceChapters, chapters);
  assert.equal(result.wholeRevision.diagnosis.findings[0].evidence[0].start, chapters[0].body.indexOf('林岚把尺寸簿推回柜台。'));
  assert.equal(result.wholeRevision.plan.items[0].targets[0].start, chapters[1].body.indexOf('她没有再说自己只是回来帮忙。'));
  assert.equal(result.chapters[0].body, chapters[0].body); assert.equal(result.chapters[2].body, chapters[2].body);
  assert.equal(result.chapters[1].body, chapters[1].body.replace('她没有再说自己只是回来帮忙。', '她把欠款页推到姐姐手边，说余下的电话由自己来打。'));
  assert.equal(result.wholeRevision.candidateRevision.replacements[0].sourceStart, chapters[1].body.indexOf('她没有再说自己只是回来帮忙。'));
  assert.deepEqual(result.wholeRevision.diff.changedChapterIds, ['ch-2']); assert.equal(result.wholeRevision.adoption.status, 'not_applied');
  assert.deepEqual(result.wholeRevision.adoption.atomicGroups, [{ planItemId: 'p-1', chapterIds: ['ch-2'] }]);
  assert.deepEqual(model.calls.map(call => call.stage), ['whole-revision:diagnosis', 'whole-revision:plan', 'whole-revision:revision', 'whole-revision:reread']);
  assert.equal(model.calls.find(call => call.stage === 'whole-revision:revision').maxTokens, 12000);
  assert.deepEqual(assertWholeRevisionResult(result, j.artifacts.requestSpec), result);
});

test('every model stage receives exact host-computed bindings, full contracts, and a bound example', async () => {
  const j = journal(), model = modelFor();
  await runWholeManuscriptRevision({ request: request(), model, checkpoint: j.checkpoint });
  for (const call of model.calls) {
    const user = JSON.parse(call.user), input = call.stage.endsWith(':format-repair') ? user.originalInput : user;
    assert.equal(input.responseBindings.inputHash, input.inputHash);
    assert.deepEqual(input.responseExample.inputHash, input.inputHash);
    assert.equal(input.responseExample.schemaVersion, input.responseBindings.schemaVersion);
    assert.equal(input.responseContract.bindingRule.includes('never calculate a SHA'), true);
    assert.equal(input.responseContract.root.additionalProperties, false);
    assert.equal(input.responseContract.evidence?.quote?.includes('1600') ?? input.limits.maxQuoteUtf16Length === 1600, true);
    assert.equal(input.limits.maxQuoteUtf16Length, 1600);
    assert.match(call.system, /不得自行计算或猜测 SHA/);
    assert.match(call.system, /responseExample 除绑定字段外只是字段结构占位/);
  }
  const diagnosis = JSON.parse(model.calls.find(call => call.stage === 'whole-revision:diagnosis').user);
  const plan = JSON.parse(model.calls.find(call => call.stage === 'whole-revision:plan').user);
  const revision = JSON.parse(model.calls.find(call => call.stage === 'whole-revision:revision').user);
  const exampleFinding = diagnosis.responseExample.findings[0], exampleEvidence = exampleFinding.evidence[0];
  assert.notEqual(exampleEvidence.quote, '逐字原文');
  assert.equal(chapters[0].body.includes(exampleEvidence.quote), true);
  assert.ok(exampleEvidence.quote.length <= 1600);
  assert.match(exampleFinding.observation, /结构占位/);
  assert.match(diagnosis.responseContract.preservationSemantics, /hard-protected/);
  assert.match(plan.responseContract.target.replacementRangeRule, /complete exact source range/);
  assert.match(plan.responseContract.target.hostProtectionRule, /another target/);
  assert.match(plan.responseContract.preserve.hardProtectionRule, /must not overlap/);
  assert.match(plan.responseBindings.diagnosisSha256, /^[0-9a-f]{64}$/);
  assert.match(revision.responseBindings.planSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(revision.responseExample.skippedPlanItems, [{ planItemId: 'p-1', reason: '没有安全改法，整项保留原文' }]);
});

test('no suitable edit is a valid no-change candidate and skips revision call', async () => {
  const j = journal(), model = modelFor({ preserve: true });
  const result = await runWholeManuscriptRevision({ request: request(), model, checkpoint: j.checkpoint });
  assert.equal(result.wholeRevision.status, 'no_change'); assert.equal(result.revisionApplied, false); assert.deepEqual(result.chapters, chapters);
  assert.deepEqual(model.calls.map(call => call.stage), ['whole-revision:diagnosis', 'whole-revision:plan', 'whole-revision:reread']);
  assert.equal(result.wholeRevision.modelCalls.primaryCalls, 3); assert.match(result.warnings.join('\n'), /原稿已逐字保留/);
});

test('ambiguous raw quote requires occurrence and one format repair; saved evidence stores host-derived start', async () => {
  const j = journal(), model = modelFor({ ambiguous: true });
  const result = await runWholeManuscriptRevision({ request: request(), model, checkpoint: j.checkpoint });
  assert.deepEqual(model.calls.slice(0, 2).map(call => call.stage), ['whole-revision:diagnosis', 'whole-revision:diagnosis:format-repair']);
  assert.equal(result.wholeRevision.diagnosis.findings[0].evidence[0].start, chapters[0].body.indexOf('尺寸簿'));
  assert.equal(result.wholeRevision.diagnosis.findings[0].evidence[0].occurrence, undefined);
  assert.equal(result.wholeRevision.modelCalls.formatRepairCalls, 1);
  assert.equal(j.artifacts['whole-revision:diagnosis:primary-response'].rawResponse.includes('occurrence'), false);
});

test('completed checkpoints resume with zero model calls and identical result', async () => {
  const j = journal(), first = modelFor();
  const expected = await runWholeManuscriptRevision({ request: request(), model: first, checkpoint: j.checkpoint });
  let calls = 0;
  const resumed = await runWholeManuscriptRevision({ request: request(), artifacts: j.artifacts, checkpoint: j.checkpoint,
    model: { complete() { calls++; throw new Error('forbidden'); } } });
  assert.equal(calls, 0); assert.deepEqual(resumed, expected);
});

test('resume reconstructs a missing receipt from bound saved responses without a model call', async () => {
  const j = journal(), expected = await runWholeManuscriptRevision({ request: request(), model: modelFor(), checkpoint: j.checkpoint });
  const originalReceipt = structuredClone(j.artifacts['whole-revision:plan:receipt']);
  delete j.artifacts['whole-revision:plan:receipt'];
  let calls = 0, rebuilt;
  const resumed = await runWholeManuscriptRevision({ request: request(), artifacts: j.artifacts,
    checkpoint: async (key, value) => { j.artifacts[key] = structuredClone(value); if (key === 'whole-revision:plan:receipt') rebuilt = structuredClone(value); },
    model: { complete() { calls++; throw new Error('forbidden'); } } });
  assert.equal(calls, 0); assert.deepEqual(rebuilt, originalReceipt); assert.deepEqual(resumed, expected);
});

test('changed source or objective cannot reuse saved progress and dispatches no model call', async () => {
  const j = journal(), first = modelFor({ preserve: true });
  await runWholeManuscriptRevision({ request: request(), model: first, checkpoint: j.checkpoint });
  for (const mutate of [value => { value.chapters[0].body += '变更'; }, value => { value.instruction = '另一目标'; }]) {
    const changed = request(); mutate(changed); let calls = 0;
    await assert.rejects(runWholeManuscriptRevision({ request: changed, artifacts: j.artifacts, checkpoint: j.checkpoint,
      model: { complete() { calls++; throw new Error('forbidden'); } } }), { code: 'WHOLE_REVISION_CHECKPOINT_MISMATCH' });
    assert.equal(calls, 0);
  }
});

test('revision transport failure preserves diagnosis and plan; resume runs only missing revision and reread', async () => {
  const j = journal(), failing = modelFor({ throwRevision: true });
  await assert.rejects(runWholeManuscriptRevision({ request: request(), model: failing, checkpoint: j.checkpoint }), { code: 'ECONNRESET' });
  assert.ok(j.artifacts['whole-revision:diagnosis:result']); assert.ok(j.artifacts['whole-revision:plan:result']);
  const resumedModel = modelFor();
  const result = await runWholeManuscriptRevision({ request: request(), model: resumedModel, artifacts: j.artifacts, checkpoint: j.checkpoint });
  assert.deepEqual(resumedModel.calls.map(call => call.stage), ['whole-revision:revision', 'whole-revision:reread']);
  assert.equal(result.wholeRevision.status, 'candidate_ready');
});

test('cancellation before revision dispatch preserves prior checkpoints and resume does not repeat them', async () => {
  const j = journal(), controller = new AbortController(), first = modelFor();
  await assert.rejects(runWholeManuscriptRevision({ request: request(), model: first, checkpoint: j.checkpoint, signal: controller.signal,
    progress: async stage => { if (stage === 'whole-revision:revision') controller.abort(); } }), { name: 'AbortError' });
  assert.deepEqual(first.calls.map(call => call.stage), ['whole-revision:diagnosis', 'whole-revision:plan']);
  assert.ok(j.artifacts['whole-revision:diagnosis:result']); assert.ok(j.artifacts['whole-revision:plan:result']);
  assert.equal(j.artifacts['whole-revision:revision:primary-response'], undefined);
  const resumedModel = modelFor();
  const result = await runWholeManuscriptRevision({ request: request(), model: resumedModel, artifacts: j.artifacts, checkpoint: j.checkpoint });
  assert.deepEqual(resumedModel.calls.map(call => call.stage), ['whole-revision:revision', 'whole-revision:reread']);
  assert.equal(result.wholeRevision.status, 'candidate_ready');
});

test('reread format exhaustion returns candidate with explicit incomplete status and resumes without calls', async () => {
  const j = journal(), model = modelFor({ badReread: true });
  const result = await runWholeManuscriptRevision({ request: request(), model, checkpoint: j.checkpoint });
  assert.equal(result.qualityCheckStatus, 'incomplete'); assert.equal(result.wholeRevision.status, 'candidate_ready_reread_incomplete');
  assert.equal(result.wholeRevision.reread.schemaVersion, 'whole-revision-reread-incomplete-1');
  assert.match(result.warnings.join('\n'), /复读未完成/); assert.equal(result.wholeRevision.modelCalls.formatRepairCalls, 1);
  delete j.artifacts['whole-revision:reread:receipt'];
  let calls = 0; const resumed = await runWholeManuscriptRevision({ request: request(), artifacts: j.artifacts, checkpoint: j.checkpoint,
    model: { complete() { calls++; throw new Error('forbidden'); } } });
  assert.equal(calls, 0); assert.deepEqual(resumed, result); assert.ok(j.artifacts['whole-revision:reread:receipt']);
});

test('invalid revision and its only repair fail without constructing or mutating a candidate', async () => {
  const j = journal(), model = modelFor({ malformedRevision: true }), input = request(), before = structuredClone(input);
  await assert.rejects(runWholeManuscriptRevision({ request: input, model, checkpoint: j.checkpoint }), { code: 'WHOLE_REVISION_FORMAT_FAILED' });
  assert.deepEqual(input, before); assert.equal(j.artifacts['whole-revision:revision:result'], undefined);
  assert.ok(j.artifacts['whole-revision:revision:primary-response']); assert.ok(j.artifacts['whole-revision:revision:repair-response']);
});

test('a cross-chapter plan item cannot apply only one of its targets', async () => {
  const j = journal();
  await assert.rejects(runWholeManuscriptRevision({ request: request(), model: modelFor({ crossMode: 'partial' }), checkpoint: j.checkpoint }),
    { code: 'WHOLE_REVISION_FORMAT_FAILED' });
  assert.equal(j.artifacts['whole-revision:revision:result'], undefined);
});

test('a plan item cannot be both applied and skipped', async () => {
  await assert.rejects(runWholeManuscriptRevision({ request: request(), model: modelFor({ crossMode: 'mixed' }) }),
    { code: 'WHOLE_REVISION_FORMAT_FAILED' });
});

test('a cross-chapter plan item applies every target as one atomic candidate group', async () => {
  const j = journal();
  const result = await runWholeManuscriptRevision({ request: request(), model: modelFor({ crossMode: 'all' }), checkpoint: j.checkpoint });
  assert.deepEqual(result.wholeRevision.diff.changedChapterIds, ['ch-1', 'ch-2']);
  assert.deepEqual(result.wholeRevision.adoption.atomicGroups, [{ planItemId: 'p-1', chapterIds: ['ch-1', 'ch-2'] }]);
  assert.equal(result.wholeRevision.candidateRevision.replacements.length, 2);
});

test('a plan cannot drop diagnosis preservation and target that protected prose', async () => {
  const j = journal(), model = modelFor({ preservationAttack: true });
  await assert.rejects(runWholeManuscriptRevision({ request: request(), model, checkpoint: j.checkpoint }),
    { code: 'WHOLE_REVISION_FORMAT_FAILED' });
  assert.deepEqual(model.calls.map(call => call.stage), ['whole-revision:diagnosis', 'whole-revision:plan', 'whole-revision:plan:format-repair']);
  assert.equal(j.artifacts['whole-revision:plan:result'], undefined);
  assert.equal(j.artifacts['whole-revision:revision:primary-response'], undefined);
});

test('pure result gate rejects source, unaffected chapter, diff, warning, adoption, and completion forgeries', async () => {
  const j = journal(), result = await runWholeManuscriptRevision({ request: request(), model: modelFor(), checkpoint: j.checkpoint });
  const cases = [
    value => { value.wholeRevision.sourceChapters[0].body += '篡改'; },
    value => { value.chapters[0].body += '越权'; },
    value => { value.wholeRevision.diff.changedChapterIds = []; },
    value => { value.warnings = ['已通过']; },
    value => { value.wholeRevision.adoption.status = 'applied'; },
    value => { value.qualityCheckStatus = 'incomplete'; },
  ];
  for (const mutate of cases) { const forged = structuredClone(result); mutate(forged);
    assert.throws(() => assertWholeRevisionResult(forged, j.artifacts.requestSpec)); }
  const other = structuredClone(j.artifacts.requestSpec); other.objective = '别的目标';
  assert.throws(() => assertWholeRevisionResult(result, other));
});

test('whole mode rejects quote selection before any model call', async () => {
  const input = request(); input.quote = '尺寸簿'; input.quoteSource = { chapterId: 'ch-1', start: 3 }; let calls = 0;
  await assert.rejects(runWholeManuscriptRevision({ request: input, model: { complete() { calls++; } } }), { code: 'WHOLE_REVISION_SELECTION_FORBIDDEN' });
  assert.equal(calls, 0);
});

test('empty provider response is retryable transport output and does not spend format repair', async () => {
  const j = journal(); let calls = 0;
  await assert.rejects(runWholeManuscriptRevision({ request: request(), checkpoint: j.checkpoint,
    model: { complete() { calls++; return ''; } } }), { code: 'WHOLE_REVISION_EMPTY_RESPONSE' });
  assert.equal(calls, 1); assert.equal(j.artifacts['whole-revision:diagnosis:primary-response'], undefined);
  assert.equal(j.artifacts['whole-revision:diagnosis:repair-input'], undefined);
});

test('request spec binds full original chapters, objective, mode, and base revision', () => {
  const spec = createWholeRevisionRequestSpec(request());
  assert.equal(spec.revisionMode, 'whole-manuscript-v1'); assert.equal(spec.sourceBaseRevision, 'base-7');
  assert.equal(spec.sourceChapterIds.length, 3); assert.match(spec.inputFingerprint, /^[0-9a-f]{64}$/);
});
