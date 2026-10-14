import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from './workflow.mjs';
import { prepareKnowledge } from '../../data/runtime/knowledge.mjs';
import { runChecks, manuscriptFingerprint } from '../../validation/runtime/checks.mjs';
import { ADJUDICATION_VERSION, ADJUDICATION_STAGE, createAdjudicationInput, normalizeAdjudication } from '../../validation/runtime/review-adjudication.mjs';
import { syntheticAdjudicationResponse } from '../../validation/tests/fixtures/synthetic-adjudication.mjs';

// Fixed stubs verify orchestration and boundaries only. They do not prove real novel quality.
const request = { projectId: 'test-project', kind: 'create', idea: '写一个关于山村旧钟的短故事。', context: {}, materials: [], style: null };
const requirements = { summary: '关于旧钟的短故事', targetHanMin: 1, targetHanMax: 1000, targetChapterCount: 2, assumptions: [], requiredElements: [], prohibitions: [] };
const plan = { title: '旧钟', premise: '旧钟停摆', ending: '钟修好了', chapters: [
  { title: '停钟', goal: '发现停钟并决定修理', scenes: ['进入钟楼检查并决定修理'], continuity: '把修钟决定交给下一章', targetHanMin: 80, targetHan: 100, targetHanMax: 120 },
  { title: '钟声', goal: '修好钟并付出代价', scenes: ['装好齿轮并付出铜钱'], continuity: '承接修钟行动，钟响后收束', targetHanMin: 80, targetHan: 100, targetHanMax: 120 },
] };
const bodies = { 'draft:ch-1': '小禾听不见钟声，她推开门，决定修好旧钟。', 'draft:ch-2': '小禾重新装好齿轮。钟响了，她把最后一枚铜钱留给师傅。' };
const review = { summary: '小禾修好了停摆的钟。', issues: [], strengths: ['行动明确'], limitations: [] };
const encode = JSON.stringify;
// New requests use the bounded protocol; this stub changes only the authorized door quote.
function doorRevision({ user }) {
  const input = JSON.parse(user);
  assert.equal(input.revisionScope?.ranges.length, 1);
  const range = input.revisionScope.ranges[0];
  assert.equal(range.quote, '她推开门');
  assert.equal(input.currentChapter.body.slice(range.start, range.end), range.quote);
  return encode({ replacements: [{ ...range, replacement: '她推开钟楼的门' }] });
}

function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    async complete(args) {
      calls.push(args);
      if (overrides[args.stage]) return overrides[args.stage](args);
      if (args.stage === 'requirements') return encode(requirements);
      if (args.stage === 'planning') return encode(plan);
      if (bodies[args.stage]) return bodies[args.stage];
      if (['review', 'revisionReview'].includes(args.stage)) return encode(review);
      if (args.stage === ADJUDICATION_STAGE) return syntheticAdjudicationResponse(JSON.parse(args.user));
      throw new Error(`Unexpected stage: ${args.stage}`);
    },
  };
}

function anchoredRevision() {
  const quote = '门还开着。';
  const body = `  😀序：${quote}\n过了一会。\n${quote}\n收尾。  `;
  return { ...request, kind: 'revise', projectTitle: '重复的门', instruction: '只改选中的第二处，保留其他文字。', baseRevision: 'anchor-base',
    quote, quoteSource: { chapterId: 'repeat-chapter', start: body.lastIndexOf(quote) },
    chapters: [{ id: 'repeat-chapter', title: '  原章名  ', body }, { id: 'unchanged-chapter', title: '原第二章', body: '\n😀这一章完全不改。\n' }] };
}

const locatedIssue = (chapterId = 'ch-1') => ({ chapterId, severity: 'must_fix',
  quote: chapterId === 'ch-1' ? '她推开门' : '最后一枚铜钱',
  explanation: '合成测试指定的问题，不代表真实语义结论。', suggestion: '有界修订。' });

test('rejected or uncertain synthetic must-fix stays in the original review without revision', async () => {
  for (const decision of ['reject', 'uncertain']) {
    const source = { ...review, issues: [locatedIssue()] }, before = structuredClone(source);
    const model = fixture({ review: () => encode(source),
      [ADJUDICATION_STAGE]: ({ user }) => syntheticAdjudicationResponse(JSON.parse(user), decision) });
    const result = await runWorkflow({ request, model });
    assert.equal(model.calls.filter(c => c.stage.startsWith('revision:')).length, 0);
    assert.deepEqual(result.chapters.map(c => c.body), Object.values(bodies));
    assert.equal(result.revisionApplied, false);
    assert.equal(result.review.issues[0].severity, 'must_fix');
    assert.deepEqual(result.reviewAdjudication.sourceReview, result.review);
    assert.deepEqual(source, before);
    assert.equal(result.reviewAdjudication.modelReviewPassed, false);
    assert.ok(result.warnings.some(w => /争议/.test(w)));
  }
});

test('one chapter revision requires fresh full review and adjudication before another chapter', async () => {
  let adjudications = 0;
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue(), locatedIssue('ch-2')] }),
    [ADJUDICATION_STAGE]: ({ user }) => syntheticAdjudicationResponse(JSON.parse(user), ++adjudications === 1 ? 'confirm' : 'uncertain'),
    'revision:ch-1': doorRevision,
    revisionReview: () => encode({ ...review, issues: [locatedIssue('ch-2')] }),
  });
  const result = await runWorkflow({ request, model });
  assert.deepEqual(model.calls.filter(c => ['review', ADJUDICATION_STAGE, 'revisionReview'].includes(c.stage) || c.stage.startsWith('revision:')).map(c => c.stage),
    ['review', ADJUDICATION_STAGE, 'revision:ch-1', 'revisionReview', ADJUDICATION_STAGE]);
  const adjudicationInputs = model.calls.filter(c => c.stage === ADJUDICATION_STAGE).map(c => JSON.parse(c.user));
  assert.notEqual(adjudicationInputs[0].manuscriptSha256, adjudicationInputs[1].manuscriptSha256);
  assert.deepEqual(adjudicationInputs[1].chapters, result.chapters);
  assert.equal(result.chapters[1].body, bodies['draft:ch-2']);
  assert.equal(result.review.issues[0].severity, 'must_fix');
  assert.equal(result.reviewAdjudication.decisions[0].decision, 'uncertain');
  assert.equal(result.adjudicationHistory.length, 2);
});

test('resume after a revision failure reuses the completed adjudication without another model call', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  let attempts = 0;
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    'revision:ch-1': args => { if (++attempts === 1) throw new Error('synthetic revision interruption'); return doorRevision(args); } });
  await assert.rejects(runWorkflow({ request, model, artifacts, checkpoint }), /synthetic revision interruption/);
  const savedReview = structuredClone(artifacts.review);
  assert.equal(Object.keys(artifacts).filter(k => k.startsWith('reviewAdjudication:')).length, 1);
  assert.equal(artifacts.result, undefined);
  const result = await runWorkflow({ request, model, artifacts, checkpoint });
  assert.equal(model.calls.filter(c => c.stage === ADJUDICATION_STAGE).length, 1);
  assert.equal(model.calls.filter(c => c.stage === 'review').length, 1);
  assert.deepEqual(artifacts.review, savedReview);
  assert.equal(result.revisionApplied, true);
  const calls = model.calls.length;
  assert.deepEqual(await runWorkflow({ request, model, artifacts, checkpoint }), result);
  assert.equal(model.calls.length, calls);
});

test('tampered cached adjudication is rejected before any resumed model call or false completion', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    'revision:ch-1': () => { throw new Error('pause before revision'); } });
  await assert.rejects(runWorkflow({ request, model, artifacts, checkpoint }), /pause before revision/);
  const key = Object.keys(artifacts).find(k => k.startsWith('reviewAdjudication:'));
  for (const edit of [a => { a.modelReviewPassed = true; }, a => { a.decisions[0].revisionEligible = false; },
    a => { a.sourceReview.issues[0].suggestion += '改'; }]) {
    const changed = structuredClone(artifacts); edit(changed[key]);
    const resumed = fixture();
    await assert.rejects(runWorkflow({ request, model: resumed, artifacts: changed }));
    assert.equal(resumed.calls.length, 0);
    assert.equal(changed.result, undefined);
  }
});

test('missing or different review policy version fails resume before model calls and checkpoints', async () => {
  const artifacts = {};
  await assert.rejects(runWorkflow({ request, model: fixture({ planning: () => { throw new Error('stop after request binding'); } }),
    checkpoint: async (key, value) => { artifacts[key] = value; } }), /stop after request binding/);
  for (const version of [undefined, 'review-adjudication-1', 'future-policy']) {
    const changed = structuredClone(artifacts);
    if (version === undefined) delete changed.requestSpec.reviewPolicyVersion;
    else changed.requestSpec.reviewPolicyVersion = version;
    const model = fixture(); let writes = 0;
    await assert.rejects(runWorkflow({ request, model, artifacts: changed, checkpoint: async () => { writes++; } }));
    assert.equal(model.calls.length, 0);
    assert.equal(writes, 0);
  }
});

test('controller resume reuses both successful full-review adjudications and the actual revision', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  let interrupted = false, adjudications = 0;
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    'agent:reviseChapter:ch-1': doorRevision,
    'agent:reviewManuscript': () => encode({ ...review, issues: [locatedIssue('ch-2')] }),
    [ADJUDICATION_STAGE]: ({ user }) => syntheticAdjudicationResponse(JSON.parse(user), ++adjudications === 1 ? 'confirm' : 'reject'),
  });
  const controller = { runtimeVersion: 'synthetic-resume-adjudication-2', async review(ctx) {
    // Same effect-state envelope as the production SDK journal.
    const effect = await ctx.step('tool:revision', async () => {
      const changed = await ctx.reviseChapter({ chapters: ctx.chapters, review: ctx.review,
        reviewAdjudication: ctx.reviewAdjudication, chapterId: 'ch-1', issues: ctx.review.issues });
      return { state: { chapters: ctx.chapters.map(c => c.id === changed.id ? changed : c) } };
    });
    const chapters = effect.state.chapters;
    const reread = await ctx.reviewManuscript(chapters, ctx.review.issues);
    const reviewAdjudication = await ctx.adjudicateReview(chapters, reread);
    if (!interrupted) { interrupted = true; throw new Error('controller interrupted after completed adjudication'); }
    return { chapters, review: reread, reviewAdjudication, trace: [{ action: 'synthetic_revision_and_reread' }] };
  } };
  await assert.rejects(runWorkflow({ request, model, controller, artifacts, checkpoint }), /controller interrupted after completed adjudication/);
  assert.equal(artifacts.agentReview, undefined);
  assert.equal(artifacts.result, undefined);
  const calls = model.calls.length;
  assert.equal(model.calls.filter(c => c.stage === ADJUDICATION_STAGE).length, 2);
  const result = await runWorkflow({ request, model, controller, artifacts, checkpoint });
  assert.equal(model.calls.length, calls, 'all completed business calls and both adjudications are cached');
  assert.equal(model.calls.filter(c => c.stage === 'agent:reviseChapter:ch-1').length, 1);
  assert.equal(model.calls.filter(c => c.stage === 'agent:reviewManuscript').length, 1);
  assert.equal(result.review.issues[0].severity, 'must_fix');
  assert.equal(result.reviewAdjudication.decisions[0].decision, 'reject');
  assert.equal(result.reviewAdjudication.modelReviewPassed, false);
});

test('adjudication transport failure after controller rereading resumes without paying for another reread', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  let adjudications = 0;
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    'agent:reviseChapter:ch-1': doorRevision,
    'agent:reviewManuscript': () => encode({ ...review, issues: [locatedIssue('ch-2')] }),
    [ADJUDICATION_STAGE]: ({ user }) => {
      if (++adjudications === 2) throw new Error('synthetic adjudication transport failure');
      return syntheticAdjudicationResponse(JSON.parse(user), adjudications === 1 ? 'confirm' : 'reject');
    },
  });
  const controller = { runtimeVersion: 'synthetic-reread-cache-2', async review(ctx) {
    const effect = await ctx.step('tool:revision', async () => {
      const revised = await ctx.reviseChapter({ chapters: ctx.chapters, review: ctx.review,
        reviewAdjudication: ctx.reviewAdjudication, chapterId: 'ch-1', issues: ctx.review.issues });
      return { state: { chapters: ctx.chapters.map(c => c.id === revised.id ? revised : c) } };
    });
    const chapters = effect.state.chapters;
    const reread = await ctx.reviewManuscript(chapters, ctx.review.issues);
    const reviewAdjudication = await ctx.adjudicateReview(chapters, reread);
    return { chapters, review: reread, reviewAdjudication };
  } };
  await assert.rejects(runWorkflow({ request, model, controller, artifacts, checkpoint }), /synthetic adjudication transport failure/);
  assert.equal(Object.keys(artifacts).filter(k => k.startsWith('agentReviewReading:')).length, 1);
  assert.equal(artifacts.agentReview, undefined); assert.equal(artifacts.result, undefined);
  const result = await runWorkflow({ request, model, controller, artifacts, checkpoint });
  assert.equal(model.calls.filter(c => c.stage === 'agent:reviewManuscript').length, 1);
  assert.equal(model.calls.filter(c => c.stage === 'agent:reviseChapter:ch-1').length, 1);
  assert.equal(model.calls.filter(c => c.stage === ADJUDICATION_STAGE).length, 3, 'initial success, failed new version, resumed new version');
  assert.equal(model.calls.filter(c => c.stage === 'review-adjudication:repair').length, 0, 'transport does not trigger field correction');
  assert.equal(result.reviewAdjudication.decisions[0].decision, 'reject');
});

test('controller cannot replace the retained provider review with a fabricated passing review', async () => {
  const artifacts = {};
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    [ADJUDICATION_STAGE]: ({ user }) => syntheticAdjudicationResponse(JSON.parse(user), 'reject') });
  await assert.rejects(runWorkflow({ request, model, checkpoint: async (key, value) => { artifacts[key] = value; },
    controller: { runtimeVersion: 'synthetic-forged-review-2',
      review: async ctx => ({ chapters: ctx.chapters, review: { ...ctx.review, issues: [], summary: 'fabricated pass' } }) } }));
  assert.equal(artifacts.review.issues[0].severity, 'must_fix');
  assert.equal(artifacts.agentReview, undefined);
  assert.equal(artifacts.result, undefined);
  assert.equal(model.calls.filter(c => c.stage.includes('reviseChapter')).length, 0);
});

test('controller cannot replace a registered reject with a different well-formed confirm response', async () => {
  const artifacts = {};
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    [ADJUDICATION_STAGE]: ({ user }) => syntheticAdjudicationResponse(JSON.parse(user), 'reject') });
  await assert.rejects(runWorkflow({ request, model, checkpoint: async (key, value) => { artifacts[key] = value; },
    controller: { runtimeVersion: 'synthetic-forged-adjudication-2', review: async ctx => {
      const input = createAdjudicationInput({ chapters: ctx.chapters, review: ctx.review, requirements: ctx.requirements });
      // A format-valid fabrication is not the response obtained by this workflow.
      const fabricated = normalizeAdjudication(syntheticAdjudicationResponse(JSON.parse(input.user), 'confirm'), input);
      return { chapters: ctx.chapters, review: ctx.review, reviewAdjudication: fabricated };
    } } }));
  assert.equal(artifacts.agentReview, undefined);
  assert.equal(artifacts.result, undefined);
});

test('resumed agentReview must match the actual registered adjudication, not only its manuscript binding', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue()] }),
    [ADJUDICATION_STAGE]: ({ user }) => syntheticAdjudicationResponse(JSON.parse(user), 'reject') });
  const controller = { runtimeVersion: 'synthetic-resumed-adjudication-origin-2',
    review: async ctx => ({ chapters: ctx.chapters, review: ctx.review, reviewAdjudication: ctx.reviewAdjudication }) };
  await runWorkflow({ request, model, controller, artifacts, checkpoint });
  const changed = structuredClone(artifacts);
  delete changed.result; delete changed.checks;
  const input = createAdjudicationInput({ chapters: changed.agentReview.chapters, review: changed.agentReview.review,
    requirements: changed.requestSpec.requirements });
  changed.agentReview.reviewAdjudication = normalizeAdjudication(syntheticAdjudicationResponse(JSON.parse(input.user), 'confirm'), input);
  const resumed = fixture();
  await assert.rejects(runWorkflow({ request, model: resumed, controller, artifacts: changed }));
  assert.equal(resumed.calls.length, 0);
});

test('controller cannot reuse an old full-manuscript adjudication to revise a second chapter', async () => {
  const model = fixture({ review: () => encode({ ...review, issues: [locatedIssue(), locatedIssue('ch-2')] }),
    'agent:reviseChapter:ch-1': doorRevision });
  const controller = { runtimeVersion: 'synthetic-stale-second-revision-2', async review(ctx) {
    const changed = await ctx.reviseChapter({ chapters: ctx.chapters, review: ctx.review,
      reviewAdjudication: ctx.reviewAdjudication, chapterId: 'ch-1', issues: [ctx.review.issues[0]] });
    const chapters = ctx.chapters.map(c => c.id === changed.id ? changed : c);
    const before = model.calls.length;
    await assert.rejects(ctx.reviseChapter({ chapters, review: ctx.review, reviewAdjudication: ctx.reviewAdjudication,
      chapterId: 'ch-2', issues: [ctx.review.issues[1]] }));
    assert.equal(model.calls.length, before);
    throw new Error('bounded test stops before rereading');
  } };
  await assert.rejects(runWorkflow({ request, model, controller }), /bounded test stops before rereading/);
  assert.equal(model.calls.filter(c => c.stage.includes('reviseChapter')).length, 1);
});

test('resume skips completed model calls and binds the exact request', async () => {
  const artifacts = {};
  let failed = false;
  const model = fixture({ 'draft:ch-2': () => {
    if (!failed) { failed = true; throw new Error('temporary provider failure'); }
    return bodies['draft:ch-2'];
  } });
  const checkpoint = async (key, value) => { artifacts[key] = value; };
  await assert.rejects(runWorkflow({ request, model, artifacts, checkpoint }), /temporary provider failure/);
  assert.equal(artifacts['draft:ch-1'].body, bodies['draft:ch-1']);
  assert.equal(artifacts['draft:ch-2'], undefined);
  const result = await runWorkflow({ request, model, artifacts, checkpoint });
  assert.equal(result.chapters.length, 2);
  assert.equal(result.runtimeVersion, 'fixed-workflow-2');
  assert.equal(artifacts.requestSpec.reviewPolicyVersion, ADJUDICATION_VERSION);
  assert.equal(Object.hasOwn(result, 'agentTrace'), false);
  assert.equal(model.calls.filter(({ stage }) => stage === 'requirements').length, 1);
  assert.equal(model.calls.filter(({ stage }) => stage === 'draft:ch-1').length, 1);
  assert.equal(model.calls.filter(({ stage }) => stage === 'draft:ch-2').length, 2);
  const count = model.calls.length;
  assert.deepEqual(await runWorkflow({ request, model, artifacts, checkpoint }), result);
  assert.equal(model.calls.length, count);
  await assert.rejects(runWorkflow({ request: { ...request, idea: '另一篇故事' }, model, artifacts, checkpoint }), /输入或执行版本已变化/);
  const reviewInput = JSON.parse(model.calls.find(({ stage }) => stage === 'review').user);
  assert.deepEqual(Object.keys(reviewInput).sort(), ['chapters', 'requirements']);
  assert.equal(result.checks.full15.status, 'NOT_EVALUATED');
});

test('targeted revision returns a separate copy and preserves unaffected chapters', async () => {
  const input = { ...request, kind: 'revise', projectTitle: '旧钟', instruction: '把第二章的铜钱改成银币', baseRevision: 7,
    chapters: [{ id: 'original-a', title: '停钟', body: bodies['draft:ch-1'] }, { id: 'original-b', title: '钟声', body: bodies['draft:ch-2'] }] };
  const before = structuredClone(input);
  const model = fixture({ requestedRevision: () => encode({ chapters: [{ id: 'original-b', body: bodies['draft:ch-2'].replace('铜钱', '银币') }] }) });
  const result = await runWorkflow({ request: input, model });
  assert.deepEqual(input, before);
  assert.equal(result.chapters[0].body, input.chapters[0].body);
  assert.match(result.chapters[1].body, /银币/);
  assert.equal(result.review.manuscriptSha256, manuscriptFingerprint(result.chapters));
  assert.equal(result.review.phase, 'after_requested_revision');
  assert.equal(result.baseRevision, 7);
  assert.equal(result.title, '旧钟');
  assert.equal(model.calls.filter(({ stage }) => stage === 'requestedRevision').length, 1);
});

test('invalid or stale explicit anchors fail before any model call or checkpoint', async () => {
  const input = anchoredRevision();
  const model = fixture();
  let checkpoints = 0;
  const invalid = [null, [], {},
    { chapterId: input.quoteSource.chapterId, start: String(input.quoteSource.start) },
    { chapterId: input.quoteSource.chapterId, start: -1 },
    { chapterId: input.quoteSource.chapterId, start: 1.5 },
    { chapterId: input.quoteSource.chapterId, start: Number.MAX_SAFE_INTEGER + 1 },
    { chapterId: 'missing-chapter', start: input.quoteSource.start },
    { chapterId: input.quoteSource.chapterId, start: 0 },
  ];
  for (const quoteSource of invalid) {
    await assert.rejects(runWorkflow({ request: { ...input, quoteSource }, model, checkpoint: async () => { checkpoints++; } }), /选段位置与本次原稿不一致/);
  }
  assert.equal(model.calls.length, 0);
  assert.equal(checkpoints, 0);
});

test('UTF-16 selected second occurrence is spliced without changing any other text or title', async () => {
  const input = anchoredRevision();
  const before = structuredClone(input);
  const replacement = '\n  她终于合上了门。😀  \n';
  let received;
  const model = fixture({ requestedRevision: ({ user }) => { received = JSON.parse(user); return encode({ replacement }); } });
  const output = await runWorkflow({ request: input, model });
  const source = input.chapters[0].body;
  const start = input.quoteSource.start;
  assert.notEqual([...source.slice(0, start)].length, start, 'the leading emoji makes UTF-16 different from code-point offsets');
  assert.deepEqual(received.selection, { chapterId: input.quoteSource.chapterId, start, end: start + input.quote.length, text: input.quote });
  assert.equal(output.chapters[0].body, source.slice(0, start) + replacement + source.slice(start + input.quote.length));
  assert.equal(output.chapters[0].body.indexOf(input.quote), source.indexOf(input.quote));
  assert.equal(output.chapters[0].title, input.chapters[0].title);
  assert.equal(output.title, input.projectTitle);
  assert.deepEqual(output.chapters[1], input.chapters[1]);
  assert.deepEqual(input, before);
  assert.equal(output.review.manuscriptSha256, manuscriptFingerprint(output.chapters));
});

test('missing replacement remains recoverable and another valid anchor cannot reuse that checkpoint', async () => {
  const input = anchoredRevision();
  const artifacts = {};
  let attempts = 0;
  const model = fixture({ requestedRevision: () => encode(++attempts === 1 ? { chapters: [] } : { replacement: '这次门关好了。' }) });
  const checkpoint = async (key, value) => { artifacts[key] = value; };
  await assert.rejects(runWorkflow({ request: input, model, artifacts, checkpoint }), /没有返回有效替换正文/);
  assert.ok(artifacts.requestSpec);
  assert.equal(artifacts.requestedRevision, undefined);
  assert.equal(artifacts.review, undefined);
  const callsBefore = model.calls.length;
  const anotherValidAnchor = { ...input, quoteSource: { ...input.quoteSource, start: input.chapters[0].body.indexOf(input.quote) } };
  await assert.rejects(runWorkflow({ request: anotherValidAnchor, model, artifacts, checkpoint }), /输入或执行版本已变化/);
  assert.equal(model.calls.length, callsBefore);
  const output = await runWorkflow({ request: input, model, artifacts, checkpoint });
  assert.equal(model.calls.filter(({ stage }) => stage === 'requirements').length, 1);
  assert.equal(attempts, 2);
  assert.equal(output.chapters[0].body.indexOf(input.quote), input.chapters[0].body.indexOf(input.quote));
  assert.equal(artifacts.result.checks.manuscriptSha256, manuscriptFingerprint(output.chapters));
});

test('incomplete plan or review responses fail without checkpointing false completion', async () => {
  const planArtifacts = {};
  const badPlanModel = fixture({ planning: () => encode({ ...plan, ending: '' }) });
  await assert.rejects(runWorkflow({ request, model: badPlanModel, checkpoint: async (key, value) => { planArtifacts[key] = value; } }), /规划缺少明确前提或结局/);
  assert.equal(planArtifacts.plan, undefined);
  assert.equal(badPlanModel.calls.some(({ stage }) => stage.startsWith('draft:')), false);

  const reviewArtifacts = {};
  const badReviewModel = fixture({ review: () => encode({}) });
  await assert.rejects(runWorkflow({ request, model: badReviewModel, checkpoint: async (key, value) => { reviewArtifacts[key] = value; } }), /不能记为已完成复核/);
  assert.ok(reviewArtifacts['draft:ch-2']);
  assert.equal(reviewArtifacts.review, undefined);
  assert.equal(reviewArtifacts.result, undefined);
});

test('only a located issue confirmed by the synthetic adjudicator triggers revision and rereading', async () => {
  const model = fixture({
    review: () => encode({ ...review, issues: [
      { chapterId: 'ch-1', severity: 'must_fix', quote: '她推开门', explanation: '门的前后位置需要明确', suggestion: '补足位置' },
      { chapterId: 'ch-2', severity: 'must_fix', quote: '稿件没有这句话', explanation: '不可信问题', suggestion: '改写' },
    ] }),
    'revision:ch-1': doorRevision,
  });
  const result = await runWorkflow({ request, model });
  assert.equal(model.calls.filter(({ stage }) => stage.startsWith('revision:')).length, 1);
  assert.equal(model.calls.filter(({ stage }) => stage === ADJUDICATION_STAGE).length, 1);
  assert.deepEqual(result.adjudicationHistory[0].decisions.map(item => item.issueIndex), [0]);
  assert.equal(result.adjudicationHistory[0].sourceReview.issues[1].severity, 'optional');
  assert.ok(model.calls.some(({ stage }) => stage === 'revisionReview'));
  assert.match(result.chapters[0].body, /钟楼的门/);
  assert.equal(result.review.manuscriptSha256, manuscriptFingerprint(result.chapters));
  assert.equal(result.review.phase, 'after_one_revision');
});

test('cancelled model result is not checkpointed', async () => {
  const artifacts = {};
  const controller = new AbortController();
  const model = fixture({ 'draft:ch-1': () => { controller.abort(new Error('cancelled')); return bodies['draft:ch-1']; } });
  await assert.rejects(runWorkflow({ request, model, signal: controller.signal, checkpoint: async (key, value) => { artifacts[key] = value; } }), /cancelled/);
  assert.ok(artifacts.plan);
  assert.equal(artifacts['draft:ch-1'], undefined);
});

test('mechanical checks use this request only and never imply literary or Full15 acceptance', () => {
  const chapters = [{ id: 'x', title: '标题不计', body: '中文 A 😄\n' }];
  const checks = runChecks({ chapters, requirements: { targetHanMin: 2, targetHanMax: 2 } });
  assert.equal(checks.bodyHanCount, 2);
  assert.equal(checks.bodyNonWhitespaceCount, 4);
  assert.equal(checks.status, 'MECHANICAL_CHECKS_OK');
  assert.deepEqual(checks.requestConformance, {
    status: 'MET',
    length: { status: 'MET', actualHan: 2, min: 2, max: 2, belowMinimumBy: 0, aboveMaximumBy: 0 },
    chapterCount: { status: 'NOT_EVALUATED', actual: 1, requested: null },
    meaning: '只判定本次明确篇幅与章数要求；不代表文学质量、语义完整性或 Full15 通过。',
  });
  assert.equal(checks.literaryQuality, 'NOT_ASSESSED');
  assert.equal(checks.full15.status, 'NOT_EVALUATED');
  assert.equal(checks.systemGo, false);
  assert.equal(runChecks({ chapters }).issues.length, 0);
  assert.equal(runChecks({ chapters }).requestConformance.status, 'NOT_EVALUATED');
  const above = runChecks({ chapters, requirements: { targetHanMin: 1, targetHanMax: 1, targetChapterCount: 2 } });
  assert.equal(above.requestConformance.status, 'NOT_MET');
  assert.equal(above.requestConformance.length.status, 'ABOVE_MAXIMUM');
  assert.equal(above.requestConformance.length.aboveMaximumBy, 1);
  assert.equal(above.requestConformance.chapterCount.status, 'DIFFERS');
  const below = runChecks({ chapters, requirements: { targetHanMin: 3, targetHanMax: 4, targetChapterCount: 1 } });
  assert.equal(below.requestConformance.status, 'NOT_MET');
  assert.equal(below.requestConformance.length.status, 'BELOW_MINIMUM');
  assert.equal(below.requestConformance.length.belowMinimumBy, 1);
  assert.equal(below.requestConformance.chapterCount.status, 'MET');
  assert.ok(runChecks({ chapters: [{ id: 'x', title: '空', body: '' }] }).issues.some(({ code }) => code === 'EMPTY_CHAPTER'));
});

test('knowledge uses selected content, preserves limits and rejects oversized material', async () => {
  const packet = await prepareKnowledge({ ...request, materials: [{ id: 'm', title: '地点', content: '村里有一座钟楼。' }] });
  assert.equal(packet.materials.length, 1);
  assert.equal(packet.materials[0].id, 'm');
  assert.equal(packet.coverage, 'partial');
  assert.equal(packet.evidence_status, 'UNPROVEN');
  assert.equal((await prepareKnowledge(request)).coverage, 'uncovered');
  const builtin = await prepareKnowledge({ ...request, idea: '写一个经营旧钟修理铺的故事。' });
  assert.equal(builtin.materials.length, 0);
  assert.equal(builtin.coverage, 'uncovered');
  await assert.rejects(prepareKnowledge({ materials: [{ content: '字'.repeat(30_001) }] }), /超过 3 万字符/);
});

test('controller tools change the actual plan and manuscript, resume from journal, and preserve neutral review input', async () => {
  const artifacts = {};
  const checkpoint = async (key, value) => { artifacts[key] = value; };
  const originalRequest = structuredClone(request);
  let planningTurns = 0, reviewTurns = 0;
  const problem = { chapterId: 'ch-1', severity: 'must_fix', quote: '她推开门', explanation: '需要交代是哪一扇门', suggestion: '明确钟楼位置' };
  const model = fixture({
    'agent:replan': ({ user }) => { assert.equal(JSON.parse(user).request.idea, request.idea); return encode({ ...plan, title: '重新规划的旧钟', ending: '小禾修好旧钟，留下修理记录' }); },
    review: () => encode({ ...review, issues: [problem] }),
    'agent:reviseChapter:ch-1': doorRevision,
    'agent:reviewManuscript': () => encode(review),
  });
  const controller = {
    runtimeVersion: 'test-tool-controller-1',
    async plan(context) {
      planningTurns++;
      const journal = context.loadState('journal');
      assert.equal(context.input.idea, request.idea);
      context.input.idea = 'controller-local mutation';
      if (journal) {
        assert.equal(journal.phase, 'replanned');
        journal.phase = 'local mutation';
        assert.equal(context.loadState('journal').phase, 'replanned');
      }
      const selected = await context.step('tool:replan-1', () => context.replan('补全结局行动'));
      if (!journal) {
        await context.saveState('journal', { phase: 'replanned', tool: 'replan-1' });
        throw new Error('simulated controller interruption');
      }
      assert.throws(() => context.loadState('requestSpec'), /journal/);
      await assert.rejects(context.saveState('result', {}), /journal/);
      return { plan: selected, trace: [{ phase: 'plan', action: 'replan' }] };
    },
    async review(context) {
      reviewTurns++;
      assert.equal(context.loadState('journal'), undefined, 'plan journal must not leak into review state');
      const changed = await context.step('tool:revise-1', () => context.reviseChapter({ chapters: context.chapters, chapterId: 'ch-1', issues: context.review.issues,
        review: context.review, reviewAdjudication: context.reviewAdjudication }));
      const chapters = context.chapters.map(chapter => chapter.id === changed.id ? changed : chapter);
      const reread = await context.step('tool:reread-1', () => context.reviewManuscript(chapters, context.review.issues));
      const reviewAdjudication = await context.adjudicateReview(chapters, reread);
      await context.saveState('journal', { phase: 'reread', manuscriptSha256: reread.manuscriptSha256 });
      return { chapters, review: reread, reviewAdjudication, trace: [{ phase: 'review', action: 'revise_and_reread' }] };
    },
  };
  await assert.rejects(runWorkflow({ request, model, controller, artifacts, checkpoint }), /simulated controller interruption/);
  assert.equal(artifacts.agentPlan, undefined);
  assert.ok(artifacts['agent:plan:tool:replan-1']);
  assert.equal(artifacts['agent:plan:state:journal'].phase, 'replanned');
  const output = await runWorkflow({ request, model, controller, artifacts, checkpoint });
  assert.deepEqual(request, originalRequest);
  assert.equal(output.runtimeVersion, controller.runtimeVersion);
  assert.equal(output.title, '重新规划的旧钟');
  assert.match(output.chapters[0].body, /钟楼的门/);
  assert.equal(output.chapters[1].body, bodies['draft:ch-2']);
  assert.deepEqual(output.agentTrace.map(entry => entry.action), ['replan', 'revise_and_reread']);
  assert.equal(output.review.manuscriptSha256, manuscriptFingerprint(output.chapters));
  assert.equal(model.calls.filter(({ stage }) => stage === 'agent:replan').length, 1);
  assert.equal(model.calls.filter(({ stage }) => stage.startsWith('revision:')).length, 0);
  const draftedPlan = JSON.parse(model.calls.find(({ stage }) => stage === 'draft:ch-1').user).plan;
  assert.equal(draftedPlan.title, output.title);
  const rereadInput = JSON.parse(model.calls.find(({ stage }) => stage === 'agent:reviewManuscript').user);
  assert.deepEqual(Object.keys(rereadInput).sort(), ['chapters', 'previousIssues', 'requirements']);
  const count = model.calls.length;
  assert.deepEqual(await runWorkflow({ request, model, controller, artifacts, checkpoint }), output);
  assert.equal(model.calls.length, count);
  assert.equal(planningTurns, 2);
  assert.equal(reviewTurns, 1);
  await assert.rejects(runWorkflow({ request, model, artifacts, checkpoint }), /输入或执行版本已变化/);
});

test('controller cannot turn an invalid plan, stale review or changed chapter title into a completed result', async () => {
  const model = fixture();
  await assert.rejects(runWorkflow({ request, model, controller: {
    runtimeVersion: 'test-invalid-plan-1', plan: async ({ plan }) => ({ plan: { ...plan, ending: '' } }),
  } }), /规划缺少明确前提或结局/);
  assert.equal(model.calls.some(({ stage }) => stage.startsWith('draft:')), false);
  for (const change of ['body', 'title']) {
    const artifacts = {};
    await assert.rejects(runWorkflow({ request, model: fixture(), artifacts, checkpoint: async (key, value) => { artifacts[key] = value; }, controller: {
      runtimeVersion: `test-invalid-${change}-1`,
      review: async ({ chapters, review }) => {
        chapters[0][change] += '控制器修改';
        return { chapters, review };
      },
    } }), change === 'body' ? /复核报告与最终稿件版本不匹配/ : /章节结构、标题变化或空正文/);
    assert.equal(artifacts.agentReview, undefined);
    assert.equal(artifacts.result, undefined);
  }
});

test('anchored revisions let a controller review or stop, but forbid further rewriting', async () => {
  const input = anchoredRevision();
  const original = structuredClone(input);
  const makeModel = () => fixture({ requestedRevision: () => encode({ replacement: '她轻轻合上门。' }) });
  const output = await runWorkflow({ request: input, model: makeModel(), controller: {
    runtimeVersion: 'test-anchor-controller-1',
    async review({ chapters, review, reviseChapter }) {
      await assert.rejects(reviseChapter({ chapters, chapterId: chapters[0].id, issues: [{ chapterId: chapters[0].id, quote: input.quote, explanation: '不能扩大修订' }] }), /不能扩大为整章修订/);
      return { chapters, review, trace: [{ action: 'stop_after_selected_revision' }] };
    },
  } });
  assert.equal(output.chapters[1].body, input.chapters[1].body);
  assert.equal(output.chapters[0].body.indexOf(input.quote), input.chapters[0].body.indexOf(input.quote));
  assert.deepEqual(input, original);
  await assert.rejects(runWorkflow({ request: input, model: makeModel(), controller: {
    runtimeVersion: 'test-anchor-controller-1',
    review: async ({ chapters, review }) => { chapters[1].body += '擅自新增'; return { chapters, review }; },
  } }), /不能扩大原授权修改范围/);
});
