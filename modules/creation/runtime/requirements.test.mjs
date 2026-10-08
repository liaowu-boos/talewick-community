import test from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from './workflow.mjs';

// These tests stop at the requirements checkpoint; they do not generate a manuscript.
const request = { kind: 'create', idea: '写一篇 3000 字、3 章的小说，主角要修好村里的旧钟。', context: {}, materials: [] };
const ready = {
  status: 'ready', summary: '修好旧钟的故事', genre: '当代', pointOfView: '第三人称', setting: '山村',
  targetHanMin: 3000, targetHanMax: 3000, targetChapterCount: 3,
  requiredElements: ['修好旧钟'], prohibitions: [], assumptions: [], usesChapter4Cut: false, completeEnding: true,
};
const encode = JSON.stringify;
const stop = new Error('test stopped at the requested checkpoint');

function modelSequence(responses) {
  const calls = [];
  return {
    calls,
    async complete(args) {
      calls.push(args);
      assert.ok(calls.length <= responses.length, `unexpected extra model call: ${args.stage}`);
      const response = responses[calls.length - 1];
      if (response instanceof Error) throw response;
      return typeof response === 'function' ? response(args) : response;
    },
  };
}

async function requirementsCheckpoint(input, model) {
  const artifacts = {};
  await assert.rejects(runWorkflow({ request: input, model, checkpoint: async (key, value) => {
    assert.equal(key, 'requestSpec', 'no later stage should run during requirement verification');
    artifacts[key] = value;
    throw stop;
  } }), error => error === stop);
  return artifacts;
}

async function expectEarlyFailure(input, model, predicate, options = {}) {
  const checkpointKeys = [];
  await assert.rejects(runWorkflow({ request: input, model, ...options, checkpoint: async key => { checkpointKeys.push(key); } }), predicate);
  assert.deepEqual(checkpointKeys, [], 'invalid requirements must not become a saved success');
  assert.ok(model.calls.every(call => call.stage === 'requirements' || call.stage === 'requirements:repair'), 'writing must not start');
}

test('plain greetings need an idea before spending a model call', async t => {
  for (const idea of ['你好', 'Hi！']) await t.test(idea, async () => {
    const model = modelSequence([]);
    await expectEarlyFailure({ ...request, idea }, model, error => error.code === 'INPUT_REQUIRED');
    assert.equal(model.calls.length, 0);
  });
});

test('a greeting accompanied by story context still reaches requirement extraction', async () => {
  const input = { ...request, idea: '你好', context: { premise: '一个修钟人发现村里的人会被钟声抹去记忆。' } };
  const model = modelSequence([encode(ready)]);
  const artifacts = await requirementsCheckpoint(input, model);
  assert.equal(model.calls.length, 1);
  assert.equal(model.calls[0].stage, 'requirements');
  assert.deepEqual(JSON.parse(model.calls[0].user).context, input.context);
  assert.equal(artifacts.requestSpec.requirements.targetChapterCount, 3);
});

test('the model can ask for actual creative intent without a format retry', async () => {
  const question = '你想写一个什么故事？';
  const model = modelSequence([encode({ status: 'needs_input', question })]);
  await expectEarlyFailure({ ...request, idea: '你能做什么？' }, model, error => error.code === 'INPUT_REQUIRED' && error.message === question);
  assert.equal(model.calls.length, 1);
});

test('one bounded repair receives the original request, failed response and specific field error', async t => {
  const missing = { ...ready };
  delete missing.targetChapterCount;
  const malformed = [
    { label: 'missing chapter count', response: encode(missing), field: /targetChapterCount/ },
    { label: 'string lengths', response: encode({ ...ready, targetHanMin: '3000', targetHanMax: '3000' }), field: /targetHanMin.*targetHanMax/ },
    { label: 'chapter range', response: encode({ ...ready, targetChapterCount: '3–5' }), field: /targetChapterCount/ },
    { label: 'non JSON', response: '篇幅是三千字，分三章。', field: /JSON/ },
  ];
  for (const { label, response, field } of malformed) await t.test(label, async () => {
    const model = modelSequence([response, encode(ready)]);
    const artifacts = await requirementsCheckpoint(request, model);
    assert.deepEqual(model.calls.map(call => call.stage), ['requirements', 'requirements:repair']);
    const initial = JSON.parse(model.calls[0].user);
    const correction = JSON.parse(model.calls[1].user);
    assert.deepEqual(correction.originalRequest, initial);
    assert.equal(correction.originalRequest.idea, request.idea);
    assert.equal(correction.invalidResponse, response);
    assert.match(correction.fieldErrors, field);
    assert.deepEqual([
      artifacts.requestSpec.requirements.targetHanMin,
      artifacts.requestSpec.requirements.targetHanMax,
      artifacts.requestSpec.requirements.targetChapterCount,
    ], [3000, 3000, 3]);
  });
});

test('two invalid responses end the stage without a checkpoint or unbounded retry', async () => {
  const model = modelSequence([encode({ ...ready, targetChapterCount: null }), 'still not JSON']);
  await expectEarlyFailure(request, model, /连续两次/);
  assert.deepEqual(model.calls.map(call => call.stage), ['requirements', 'requirements:repair']);
});

test('provider and cancellation failures are not treated as repairable model fields', async t => {
  for (const message of ['模型服务返回 HTTP 429。', '模型输出达到长度上限。', '任务已取消。']) await t.test(message, async () => {
    const failure = new Error(message);
    const model = modelSequence([failure]);
    await expectEarlyFailure(request, model, error => error === failure);
    assert.equal(model.calls.length, 1);
  });
  await t.test('abort after the first response prevents repair', async () => {
    const controller = new AbortController();
    const failure = new Error('cancelled while receiving the response');
    const model = modelSequence([() => { controller.abort(failure); return '{}'; }]);
    await expectEarlyFailure(request, model, error => error === failure, { signal: controller.signal });
    assert.equal(model.calls.length, 1);
  });
});

test('unsupported or contradictory numeric specifications fail without being shrunk by a repair', async t => {
  const cases = [
    { label: 'too many characters', value: { ...ready, targetHanMin: 31000, targetHanMax: 32000 }, error: /30000/ },
    { label: 'too many chapters', value: { ...ready, targetChapterCount: 13 }, error: /章内/ },
    { label: 'reversed bounds', value: { ...ready, targetHanMin: 4000, targetHanMax: 3000 }, error: /相互冲突/ },
  ];
  for (const { label, value, error } of cases) await t.test(label, async () => {
    const model = modelSequence([encode(value)]);
    await expectEarlyFailure(request, model, error);
    assert.equal(model.calls.length, 1);
  });
});

test('explicit length and chapter choices survive extraction, with defaults handled independently', async t => {
  const cases = [
    { idea: request.idea, response: ready, expected: [3000, 3000, 3] },
    { idea: '写一个修钟人的故事，只写 3 章。', response: { ...ready, targetHanMin: 9000, targetHanMax: 11000, assumptions: ['未指定篇幅，采用默认万字规格。'] }, expected: [9000, 11000, 3] },
  ];
  for (const { idea, response, expected } of cases) await t.test(idea, async () => {
    const model = modelSequence([encode(response)]);
    const artifacts = await requirementsCheckpoint({ ...request, idea }, model);
    assert.equal(JSON.parse(model.calls[0].user).idea, idea);
    assert.match(model.calls[0].system, /分别处理篇幅与章数/);
    const requirements = artifacts.requestSpec.requirements;
    assert.deepEqual([requirements.targetHanMin, requirements.targetHanMax, requirements.targetChapterCount], expected);
  });
});

test('revision keeps the existing chapter count and a null unconstrained length', async () => {
  const chapters = [
    { id: 'a', title: '第一章', body: '钟停了。' },
    { id: 'b', title: '第二章', body: '她走进钟楼。' },
  ];
  const input = { ...request, kind: 'revise', instruction: '把第一章的钟改成旧钟。', chapters };
  const model = modelSequence([encode({ ...ready, targetHanMin: null, targetHanMax: null, targetChapterCount: null })]);
  const artifacts = await requirementsCheckpoint(input, model);
  const requirements = artifacts.requestSpec.requirements;
  assert.equal(requirements.targetHanMin, null);
  assert.equal(requirements.targetHanMax, null);
  assert.equal(requirements.targetChapterCount, chapters.length);
  assert.deepEqual(JSON.parse(model.calls[0].user).existingChapters, chapters);
  assert.equal(model.calls.length, 1);
});

test('a saved request specification resumes without another requirement call', async () => {
  const artifacts = await requirementsCheckpoint(request, modelSequence([encode(ready)]));
  const model = modelSequence([]);
  const checkpointKeys = [];
  await assert.rejects(runWorkflow({ request, model, artifacts, checkpoint: async key => {
    checkpointKeys.push(key);
    throw stop;
  } }), error => error === stop);
  assert.deepEqual(checkpointKeys, ['knowledge']);
  assert.equal(model.calls.length, 0);
});
