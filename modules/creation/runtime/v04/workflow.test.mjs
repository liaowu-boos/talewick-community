import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runWorkflow } from '../workflow.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
// Explicit contract fixtures: no real retrieval, analysis, or literary-effect claim.
const request = { kind: 'create', idea: '小禾修好旧钟，保留她是修钟师傅的事实', context: {}, materials: [] };
const requirements = { summary: request.idea, genre: '当代', targetHanMin: 1, targetHanMax: 1000, targetChapterCount: 2,
  assumptions: [], requiredElements: ['小禾是修钟师傅'], prohibitions: [] };
const plan = { title: '旧钟', premise: '钟停了', ending: '她修好了钟', chapters: [
  { title: '停钟', goal: '发现旧钟停摆', scenes: ['推门检查'], continuity: '决定修钟', targetHanMin: 50, targetHan: 100, targetHanMax: 150 },
  { title: '钟声', goal: '修好钟', scenes: ['装上齿轮'], continuity: '钟响收束', targetHanMin: 50, targetHan: 100, targetHanMax: 150 } ],
  characterArcs: [{ character: '小禾', experience: '钟停摆', belief: '修钟是自己的责任', desire: '钟再次响起', fear: '失败', change: '担忧后采取行动', expression: '检查与装齿轮' }],
  emotionalScenes: Array.from({ length: 2 }, () => ({ experience: '钟楼里的经历', cognition: '理解故障', action: '修理', expression: '动作', development: '展开修理现场', echo: '钟声回应寂静' })),
  materialDecisions: [], psychologyLimitations: ['正文落实未验证'] };
const bodies = { 'draft:ch-1': '小禾推开门，钟楼静悄悄的。她检查了齿轮。', 'draft:ch-2': '小禾装好齿轮，钟声传出窗外。' };
const review = { summary: '她修好了钟', issues: [], strengths: ['具体动作'], limitations: [], readingObservations: [{
  observation: '寂静与钟声有回应，担忧转为行动的过程可继续观察', category: 'emotion', suspectedCause: '需要阅读比较',
  evidence: [{ chapterId: 'ch-1', quote: '钟楼静悄悄的' }, { chapterId: 'ch-2', quote: '钟声传出窗外' }],
  revisionScope: { chapterIds: ['ch-1', 'ch-2'], action: '核对转换过程', reason: '情绪连续性', preserve: ['寂静与钟声的回应'] }, limitations: ['模型观察'] }] };
function modelFixture(overrides = {}) {
  const calls = [];
  return { calls, complete: async args => {
    calls.push(args);
    if (overrides[args.stage]) return overrides[args.stage](args);
    if (args.stage === 'requirements') return JSON.stringify(requirements);
    if (args.stage === 'planning') return JSON.stringify(plan);
    if (bodies[args.stage]) return bodies[args.stage];
    if (args.stage === 'review') return JSON.stringify(review);
    throw new Error(`unexpected stage ${args.stage}`);
  } };
}
function retrieved(query) {
  const content = '参考来源中的人物是医生。仅前四章可见，结局未知；不能替换新作职业。';
  return { contractVersion: 'v04-contract-1', packetId: 'test-retrieval-v1', query, status: 'matched',
    materials: [{ id: 'm1', title: '测试来源', content, kind: 'retrieved', use: 'reviewed_analysis', sha256: hash(content),
      references: [{ sourceId: 's1', textVersion: 'text-v1', analysisVersion: 'analysis-v1', reviewRecordId: 'review-test-1', sourceSha256: hash('测试原文'), unitIds: ['u1'], lineStart: 1, lineEnd: 2 }],
      selectionReason: '认知与行动联系', limitations: ['first_four；中后段未观察'] }], candidates: [], usedChars: content.length, limits: [] };
}

test('one query, frozen versioned material, actual previous text, neutral review, no diagnosis-driven rewrite', async () => {
  const artifacts = {}; let queries = 0;
  const model = modelFixture();
  const result = await runWorkflow({ request, model, retrieveKnowledge: async query => { queries++; return retrieved(query); }, checkpoint: async (key, value) => { artifacts[key] = value; } });
  assert.equal(queries, 1);
  assert.equal(artifacts.knowledge.retrieval.packetId, 'test-retrieval-v1');
  assert.equal(artifacts.plan.creationPolicyVersion, 'v04-creation-1');
  assert.ok(artifacts.requestSpec.rules.v04_planning.sha256);
  assert.equal(result.review.readingObservations[0].crossScene, true);
  assert.equal(result.revisionApplied, false);
  assert.deepEqual(model.calls.map(call => call.stage), ['requirements', 'planning', 'draft:ch-1', 'draft:ch-2', 'review']);
  const second = model.calls.find(call => call.stage === 'draft:ch-2');
  assert.equal(JSON.parse(second.user).previousChapters[0].body, bodies['draft:ch-1']);
  assert.match(second.system, /来源角色和剧情替换新作事实/);
  assert.deepEqual(JSON.parse(second.user).requirements.requiredElements, ['小禾是修钟师傅']);
  const material = JSON.parse(second.user).knowledge.materials.find(item => item.kind === 'retrieved');
  assert.equal(material.references[0].textVersion, 'text-v1');
  assert.equal(material.use, 'reviewed_analysis');
  assert.equal(material.references[0].reviewRecordId, 'review-test-1');
  assert.match(material.limitations[0], /first_four/);
  assert.deepEqual(Object.keys(JSON.parse(model.calls.find(call => call.stage === 'review').user)).sort(), ['chapters', 'requirements']);
  assert.equal(result.checks.full15.status, 'NOT_EVALUATED');
});

test('interrupted new task resumes without query or changing frozen rules, original material versions survive', async () => {
  const artifacts = {}; const checkpoint = async (key, value) => { artifacts[key] = value; };
  let fail = true, queries = 0;
  const model = modelFixture({ 'draft:ch-2': () => { if (fail) { fail = false; throw new Error('provider interrupted'); } return bodies['draft:ch-2']; } });
  await assert.rejects(runWorkflow({ request, model, checkpoint, retrieveKnowledge: async query => { queries++; return retrieved(query); } }), /provider interrupted/);
  const original = structuredClone(artifacts.knowledge);
  const result = await runWorkflow({ request, model, artifacts, checkpoint, retrieveKnowledge: async () => { assert.fail('must not requery'); } });
  assert.equal(queries, 1);
  assert.deepEqual(result.knowledge, original);
  assert.equal(model.calls.filter(call => call.stage === 'planning').length, 1);
  assert.equal(model.calls.filter(call => call.stage === 'draft:ch-1').length, 1);
});

test('legacy task keeps its old plan and knowledge after callback injection', async () => {
  const artifacts = {}; let fail = true;
  const legacyPlan = structuredClone(plan); delete legacyPlan.characterArcs; delete legacyPlan.emotionalScenes; delete legacyPlan.materialDecisions;
  const model = modelFixture({ planning: () => JSON.stringify(legacyPlan), 'draft:ch-2': () => { if (fail) { fail = false; throw new Error('pause legacy'); } return bodies['draft:ch-2']; } });
  await assert.rejects(runWorkflow({ request, model, checkpoint: async (key, value) => { artifacts[key] = value; } }), /pause legacy/);
  delete artifacts.knowledge.retrieval; // Represents an actual pre-v04 knowledge checkpoint.
  const original = structuredClone(artifacts.knowledge);
  const result = await runWorkflow({ request, model, artifacts, retrieveKnowledge: async () => { assert.fail('must not upgrade existing packet'); } });
  assert.deepEqual(result.knowledge, original);
  assert.equal(artifacts.requestSpec.rules.v04_planning, undefined);
  assert.equal(artifacts.plan.creationPolicyVersion, undefined);
});

test('retrieval cancellation cannot persist knowledge or start planning', async () => {
  const artifacts = {}, controller = new AbortController(), model = modelFixture();
  await assert.rejects(runWorkflow({ request, model, signal: controller.signal,
    checkpoint: async (key, value) => { artifacts[key] = value; },
    retrieveKnowledge: async query => { controller.abort(new Error('cancel retrieval')); return retrieved(query); } }), /cancel retrieval/);
  assert.ok(artifacts.requestSpec);
  assert.equal(artifacts.knowledge, undefined);
  assert.equal(model.calls.length, 1);
});

test('v04 selected revision preserves repeated text and adjacent chapter despite whole-reading diagnosis', async () => {
  const quote = '门没有关。', body = `😀${quote}她站了一会。${quote}`;
  const input = { kind: 'revise', instruction: '只改第二处选段', quote, quoteSource: { chapterId: 'ch-1', start: body.lastIndexOf(quote) }, baseRevision: 8,
    chapters: [{ id: 'ch-1', title: '门', body }, { id: 'ch-2', title: '钟', body: '这章保持原样。' }] };
  const before = structuredClone(input);
  const model = modelFixture({ requestedRevision: () => JSON.stringify({ replacement: '她合上了门。' }) });
  const result = await runWorkflow({ request: input, model, retrieveKnowledge: async query => retrieved(query) });
  assert.equal(result.chapters[0].body, body.slice(0, input.quoteSource.start) + '她合上了门。');
  assert.equal(result.chapters[1].body, input.chapters[1].body);
  assert.equal(result.baseRevision, 8);
  assert.deepEqual(input, before);
  assert.equal(result.review.readingObservations[0].status, 'needs_evidence');
  assert.equal(model.calls.length, 3);
});

test('missing psychology gets one bounded repair; unknown material adoption cannot complete planning', async () => {
  let attempts = 0;
  const model = modelFixture({ planning: () => { attempts++; return JSON.stringify({ ...plan, characterArcs: [] }); } });
  const artifacts = {};
  await assert.rejects(runWorkflow({ request, model, retrieveKnowledge: async query => retrieved(query),
    checkpoint: async (key, value) => { artifacts[key] = value; } }), /心理规划/);
  assert.equal(attempts, 2);
  assert.equal(artifacts.plan, undefined);
  assert.equal(model.calls.some(call => call.stage.startsWith('draft:')), false);
  const phantom = modelFixture({ planning: () => JSON.stringify({ ...plan, materialDecisions: [{ materialId: 'not-provided', decision: 'adopt', reason: '不能声明' }] }) });
  await assert.rejects(runWorkflow({ request, model: phantom, retrieveKnowledge: async query => retrieved(query) }), /未提供的材料/);
});

test('missing whole-reading output fails recoverably rather than becoming an empty successful diagnosis', async () => {
  const artifacts = {};
  const model = modelFixture({ review: () => JSON.stringify({ summary: '没有结构化观察', issues: [] }) });
  await assert.rejects(runWorkflow({ request, model, retrieveKnowledge: async query => retrieved(query),
    checkpoint: async (key, value) => { artifacts[key] = value; } }), /readingObservations/);
  assert.ok(artifacts['draft:ch-2']);
  assert.equal(artifacts.review, undefined);
  const resumed = await runWorkflow({ request, artifacts, model: modelFixture(), retrieveKnowledge: async () => { assert.fail('frozen packet'); } });
  assert.equal(resumed.review.readingObservations.length, 1);
});

test('alias resolutions survive interrupted workflow recovery without requery or relabelling source records', async () => {
  const input = { ...request, sourceIds: ['alias'] }, artifacts = {};
  let fail = true;
  const model = modelFixture({ 'draft:ch-2': () => { if (fail) { fail = false; throw new Error('alias pause'); } return bodies['draft:ch-2']; } });
  const checkpoint = async (key, value) => { artifacts[key] = value; };
  await assert.rejects(runWorkflow({ request: input, model, checkpoint, retrieveKnowledge: async query => {
    const result = retrieved(query), ref = result.materials[0].references[0];
    result.sourceResolutions = [{ requestedSourceId: 'alias', canonicalSourceId: ref.sourceId, textVersion: ref.textVersion, sourceSha256: ref.sourceSha256 }];
    return result;
  } }), /alias pause/);
  const original = structuredClone(artifacts.knowledge);
  const resumed = await runWorkflow({ request: input, model, artifacts, retrieveKnowledge: async () => { assert.fail('do not re-resolve aliases'); } });
  assert.deepEqual(resumed.knowledge, original);
  assert.equal(resumed.knowledge.retrieval.query.sourceIds[0], 'alias');
  assert.equal(resumed.knowledge.retrieval.sourceResolutions[0].canonicalSourceId, 's1');
  assert.equal(resumed.knowledge.materials[0].references[0].reviewRecordId, 'review-test-1');
});
