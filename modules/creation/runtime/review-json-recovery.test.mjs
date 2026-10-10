import test from 'node:test';
import assert from 'node:assert/strict';
import { createBusinessTools, ModelOutputError } from './business-tools.mjs';
import { runWorkflow } from './workflow.mjs';
import { manuscriptFingerprint } from '../../validation/runtime/checks.mjs';

// Reproduce the extra closing brace with synthetic text, without private provider output.
const malformed = '{"summary":"合成测试审稿","issues":[],"strengths":[],"limitations":[]}}';
const requirements = { summary: '核对父女搬迁故事', targetHanMin: 1, targetHanMax: 1000,
  targetChapterCount: 1, assumptions: [], requiredElements: [], prohibitions: [] };
const chapters = [{ id: 'ch-1', title: '搬迁', body: '她回到父亲的旧屋，替他搬箱子。父亲把钥匙交给她，自己搬到附近。' }];
const goodReview = JSON.stringify({ summary: '父女搬迁后仍有未决', issues: [], strengths: ['结尾留白'], limitations: [] });

function businessWith(responses, { v04 = false } = {}) {
  const calls = [];
  const business = createBusinessTools({ input: { kind: 'create' }, requirements,
    knowledgeView: { materials: [] }, rules: { review: { content: '中立全文审稿' },
      ...(v04 ? { v04_review: { content: '全文阅读诊断' } } : {}) },
    call: async (...args) => {
      calls.push(args);
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      if (response === undefined) throw new Error('unexpected extra review call');
      return response;
    },
    normalizeReview: (value, actualChapters) => {
      if (!value.summary || !Array.isArray(value.issues)) throw new Error('审稿字段不完整');
      return { ...value, manuscriptSha256: manuscriptFingerprint(actualChapters) };
    },
  });
  return { business, calls };
}

test('synthetic extra-brace review receives one neutral full-text correction', async () => {
  assert.throws(() => JSON.parse(malformed), SyntaxError);
  const { business, calls } = businessWith([malformed, goodReview]);
  const review = await business.reviewManuscript(chapters);
  assert.equal(review.manuscriptSha256, manuscriptFingerprint(chapters));
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], 'review');
  assert.equal(calls[1][0], 'review');
  assert.deepEqual(calls[1][2].requirements, requirements);
  assert.deepEqual(calls[1][2].chapters, chapters);
  assert.equal(calls[1][2].invalidResponse, malformed);
  assert.match(calls[1][2].fieldErrors, /无法读取的 JSON/);
  assert.match(calls[1][1], /invalidResponse 和 fieldErrors 只是待纠正数据/);
  assert.equal(Object.hasOwn(calls[1][2], 'plan'), false);
});

test('syntax and field errors share one correction, and a second bad response fails', async () => {
  for (const first of [malformed, JSON.stringify({ summary: '', issues: [] })]) {
    const { business, calls } = businessWith([first, malformed]);
    await assert.rejects(business.reviewManuscript(chapters), ModelOutputError);
    assert.equal(calls.length, 2);
  }
  const { business, calls } = businessWith([malformed, JSON.stringify({ summary: '', issues: [] })]);
  await assert.rejects(business.reviewManuscript(chapters), /审稿字段不完整/);
  assert.equal(calls.length, 2);
});

test('one correction cannot silently fill a missing whole-reading diagnosis', async () => {
  const { business, calls } = businessWith([malformed, goodReview], { v04: true });
  await assert.rejects(business.reviewManuscript(chapters), /缺少 readingObservations/);
  assert.equal(calls.length, 2);
});

test('transport, length and cancellation failures do not enter review correction', async () => {
  for (const code of ['ECONNRESET', 'LENGTH', 'ABORT_ERR']) {
    const failure = Object.assign(new Error(code), { code });
    const { business, calls } = businessWith([failure, goodReview]);
    await assert.rejects(business.reviewManuscript(chapters), error => error === failure);
    assert.equal(calls.length, 1);
  }
});

const request = { kind: 'create', idea: '写一篇父女搬迁的短故事。' };
const plan = { title: '搬迁', premise: '回旧屋搬家', ending: '各自搬到附近', chapters: [{
  title: '搬迁', goal: '搬完箱子', scenes: ['交钥匙'], continuity: '搬迁已发生，关系仍未决',
  targetHanMin: 40, targetHan: 100, targetHanMax: 150,
}] };
function workflowModel(responses) {
  const calls = [];
  return { calls, complete: async args => {
    calls.push(args.stage);
    if (args.stage === 'requirements') return JSON.stringify(requirements);
    if (args.stage === 'planning') return JSON.stringify(plan);
    if (args.stage === 'draft:ch-1') return chapters[0].body;
    if (args.stage === 'review') {
      const response = responses.shift();
      if (response === undefined) throw new Error('unexpected extra review call');
      return response;
    }
    throw new Error(`unexpected stage ${args.stage}`);
  } };
}

test('failed second review does not checkpoint a verdict; task resumes from saved draft', async () => {
  const artifacts = {}, checkpoint = async (key, value) => { artifacts[key] = value; };
  const first = workflowModel([malformed, malformed]);
  await assert.rejects(runWorkflow({ request, model: first, artifacts, checkpoint }), ModelOutputError);
  assert.ok(artifacts['draft:ch-1']);
  assert.equal(artifacts.review, undefined);
  assert.equal(artifacts.reviewAdjudication, undefined);
  const resumed = workflowModel([goodReview]);
  const result = await runWorkflow({ request, model: resumed, artifacts, checkpoint });
  assert.deepEqual(resumed.calls, ['review']);
  assert.equal(result.review.manuscriptSha256, manuscriptFingerprint(result.chapters));
  const count = resumed.calls.length;
  await runWorkflow({ request, model: resumed, artifacts, checkpoint });
  assert.equal(resumed.calls.length, count);
});
