import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.mjs';
import { isBusinessStage, outputTokenLimit } from './model-policy.mjs';
import { agentCallSettings } from './agent-ai-sdk.mjs';

const config = { baseURL: 'https://api.deepseek.com', apiKey: 'synthetic-stage-private-key', model: 'deepseek-v4-flash', timeoutMs: 3000, idleTimeoutMs: 2500 };
const stages = [
  ['requirements', 2500, true], ['requirements:repair', 2500, true],
  ['planning', 6000, true], ['agent:replan', 6000, true],
  ['draft:ch-1', 6500, false], ['draft:ch-6', 6500, false], ['draft:ch-10', 6500, false],
  ['revision:ch-6', 6500, false], ['agent:reviseChapter:ch-10', 6500, false],
  ['review', 6000, true], ['agent:reviewManuscript', 6000, true], ['revisionReview', 6000, true],
  ['requestedRevision', 20000, true], ['review-adjudication', 10000, true], ['review-adjudication:repair', 10000, true],
];
const system = '本调用仅返回指定阶段产物；完整保留原有题材、篇幅和章节要求。synthetic-private-prompt';
const user = JSON.stringify({ requirements: { targetHanMin: 9000, targetHanMax: 11000, targetChapterCount: 10 }, currentChapter: { id: 'ch-6', targetHan: 1000 }, previousChapters: [{ id: 'ch-5', body: 'synthetic-private-previous-chapter' }] });
const privateReasoning = 'synthetic-private-reasoning';
const partial = 'synthetic-discarded-partial';
const completeText = '第六章完整合成正文，独立于已丢弃的截断响应。';
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
function response(content, finish = 'stop', reasoning = undefined) {
  return new Response(event({ content, ...(reasoning === undefined ? {} : { reasoning_content: reasoning }) })
    + event({}, finish) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
}
const input = (stage, maxTokens = 6500) => ({ stage, system, user, maxTokens });

test('business-stage recognition is exact and includes late chapters and real agent revision names', () => {
  for (const [stage] of stages) assert.equal(isBusinessStage(stage), true, stage);
  for (const stage of ['draft:chapter_10', 'revision:book-2', 'agent:reviseChapter:chapter_10']) assert.equal(isBusinessStage(stage), true, stage);
  for (const stage of [undefined, null, 10, {}, '', 'agent:controller', 'draft', 'draft:', 'draft:ch-6:extra', 'draft:ch-6/extra', 'revision: ch-6', 'agent:reviseChapter', 'agent:reviseChapter:', 'unknown-review-stage', 'review:ch-1', ' planning']) {
    assert.equal(isBusinessStage(stage), false, String(stage));
  }
});

test('flash and pro use the full bounded thinking allowance throughout a novel and its controller', async t => {
  for (const name of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) await t.test(name, async () => {
    const sent = [];
    const model = createModel({ ...config, model: name }, async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return response(completeText, 'stop', privateReasoning);
    });
    for (const [stage, maxTokens, json] of stages) {
      assert.equal(await model.complete(input(stage, maxTokens)), completeText);
      const body = sent.at(-1);
      assert.equal(body.max_tokens, 32768, stage);
      assert.equal(body.stream, true, stage);
      assert.equal(body.thinking, undefined, 'the successful first pass must retain its thinking mode');
      assert.equal(body.reasoning_effort, undefined, 'the first pass must not silently lower reasoning effort');
      assert.deepEqual(body.messages, [{ role: 'system', content: system }, { role: 'user', content: user }]);
      assert.deepEqual(body.response_format, json ? { type: 'json_object' } : undefined, stage);
      assert.equal(body.tools, undefined);
    }
    assert.equal(sent.length, stages.length, 'successful stages need exactly one provider call each');
    assert.equal(agentCallSettings({ ...config, model: name }).maxOutputTokens, 32768);
    assert.equal(outputTokenLimit({ ...config, model: name }, 1800, 'agent:controller'), 32768);
  });
});

test('non-business defaults and compatible or older model budgets retain their existing ceilings', () => {
  for (const stage of [undefined, 'unknown-review-stage']) {
    assert.equal(outputTokenLimit(config, 6500, stage), 16384);
    assert.equal(outputTokenLimit(config, 20000, stage), 28192);
  }
  for (const override of [{ agentProvider: 'openai-compatible' }, { model: 'deepseek-chat' }]) {
    for (const [stage, requested] of [...stages, ['agent:controller', 1800]]) {
      assert.equal(outputTokenLimit({ ...config, ...override }, requested, stage), Math.min(16000, requested), stage);
    }
  }
});

test('every native business stage recovers truncation once from the untouched input, never from partial output', async t => {
  for (const [stage, maxTokens, json] of stages) await t.test(stage, async () => {
    const sent = [];
    const expected = json ? JSON.stringify({ completed: true, syntheticStage: stage }) : completeText;
    const first = json ? JSON.stringify({ completed: false, partial }) : partial;
    const model = createModel(config, async (_url, init) => {
      sent.push({ body: JSON.parse(init.body), signal: init.signal });
      return sent.length === 1 ? response(first, 'length', privateReasoning) : response(expected);
    });
    assert.equal(await model.complete(input(stage, maxTokens)), expected);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].signal, sent[1].signal, 'recovery shares cancellation and the original deadline');
    assert.deepEqual(sent[0].body.messages, sent[1].body.messages, 'recovery must not continue or paraphrase partial results');
    assert.doesNotMatch(JSON.stringify(sent[1].body.messages), /synthetic-discarded-partial|synthetic-private-reasoning/);
    assert.equal(sent[0].body.max_tokens, 32768);
    assert.equal(sent[0].body.thinking, undefined);
    assert.deepEqual(sent[1].body.thinking, { type: 'disabled' });
    assert.equal(sent[1].body.max_tokens, ['planning', 'agent:replan'].includes(stage) ? Math.max(16000, maxTokens) : maxTokens, 'planning recovery has a bounded 16K floor; other visible budgets, including 20K revision, stay unchanged');
    assert.deepEqual(sent[1].body.response_format, json ? { type: 'json_object' } : undefined);
    assert.equal(sent[1].body.stream, true);
    assert.equal(sent[1].body.model, config.model);
  });
});

test('pro also recovers a later drafting chapter without changing the story request', async () => {
  const sent = [];
  const model = createModel({ ...config, model: 'deepseek-v4-pro' }, async (_url, init) => {
    sent.push(JSON.parse(init.body));
    return sent.length === 1 ? response(partial, 'length', privateReasoning) : response(completeText);
  });
  assert.equal(await model.complete(input('draft:ch-10')), completeText);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].messages, sent[1].messages);
});

test('a second truncated response never succeeds, even when its JSON parses, and never causes a third call', async t => {
  for (const [stage, maxTokens, json] of stages) await t.test(stage, async () => {
    let calls = 0;
    const model = createModel(config, async () => {
      calls++;
      return response(json ? JSON.stringify({ completed: true, partial }) : partial, 'length', privateReasoning);
    });
    await assert.rejects(model.complete(input(stage, maxTokens)), error => {
      assert.match(error.message, /长度上限/);
      if (stage === 'draft:ch-6') assert.match(error.message, /第 6 章写作/);
      if (stage === 'draft:ch-10') assert.match(error.message, /第 10 章写作/);
      assert.doesNotMatch(error.message, /synthetic-discarded-partial|synthetic-private/);
      return true;
    });
    assert.equal(calls, 2);
  });
});

test('empty-stop and length failures share a single recovery allowance in late drafting', async t => {
  for (const [first, second, pattern] of [
    [['', 'stop'], [partial, 'length'], /长度上限/],
    [[partial, 'length'], ['', 'stop'], /没有返回正文/],
  ]) await t.test(`${first[1]} then ${second[1]}`, async () => {
    let calls = 0;
    const model = createModel(config, async () => {
      const [content, finish] = calls++ === 0 ? first : second;
      return response(content, finish, privateReasoning);
    });
    await assert.rejects(model.complete(input('draft:ch-6')), pattern);
    assert.equal(calls, 2);
  });
});

test('native business recovery clamps oversized and tiny visible budgets without dropping the original request', async t => {
  for (const [requested, expected] of [[20000, 20000], [1, 512], [1000000, 32768]]) await t.test(String(requested), async () => {
    const sent = [];
    const model = createModel(config, async (_url, init) => {
      sent.push(JSON.parse(init.body));
      return sent.length === 1 ? response(partial, 'length', privateReasoning) : response('{"chapters":[]}');
    });
    await model.complete(input('requestedRevision', requested));
    assert.equal(sent.length, 2);
    assert.equal(sent[0].max_tokens, 32768);
    assert.equal(sent[1].max_tokens, expected);
    assert.deepEqual(sent[0].messages, sent[1].messages);
  });
});

test('length recovery excludes unknown stages, controller decisions, non-native providers and absent reasoning', async t => {
  const excluded = [
    ...[undefined, 'unknown-review-stage', 'draft:', 'draft:ch-6:extra', 'agent:reviseChapter', 'agent:controller'].map(stage => ({ name: String(stage), stage })),
    { name: 'no reasoning', stage: 'draft:ch-6', reasoning: undefined },
    { name: 'blank reasoning', stage: 'draft:ch-10', reasoning: ' \n ' },
    { name: 'compatible V4', stage: 'draft:ch-6', override: { agentProvider: 'openai-compatible' } },
    { name: 'older native', stage: 'review', override: { model: 'deepseek-chat' } },
  ];
  for (const item of excluded) await t.test(item.name, async () => {
    let calls = 0;
    const reasoning = Object.hasOwn(item, 'reasoning') ? item.reasoning : privateReasoning;
    const model = createModel({ ...config, ...item.override }, async () => {
      calls++;
      return item.override ? Response.json({ choices: [{ finish_reason: 'length', message: { content: partial, reasoning_content: reasoning } }] })
        : response(partial, 'length', reasoning);
    });
    await assert.rejects(model.complete(input(item.stage)), /长度上限/);
    assert.equal(calls, 1);
  });
});

test('attempt diagnostics await persistence and report recovery without retaining prompts, prose or reasoning', async () => {
  const attempts = [];
  let calls = 0;
  const model = createModel(config, async () => ++calls === 1 ? response(partial, 'length', privateReasoning) : response(completeText));
  const result = await model.complete({ ...input('draft:ch-6'), onAttempt: async attempt => {
    await new Promise(resolve => setImmediate(resolve));
    attempts.push(structuredClone(attempt));
  } });
  assert.equal(result, completeText);
  assert.equal(attempts.length, 2, 'both completed attempts must be recorded before the step returns');
  assert.deepEqual(attempts.map(item => item.attempt), [1, 2]);
  assert.deepEqual(attempts.map(item => item.mode), ['primary', 'recovery']);
  assert.deepEqual(attempts.map(item => item.finishReason), ['length', 'stop']);
  assert.deepEqual(attempts.map(item => item.maxOutputTokens), [32768, 6500]);
  assert.deepEqual(attempts.map(item => item.hasReasoning), [true, false]);
  for (const attempt of attempts) {
    assert.equal(attempt.stage, 'draft:ch-6');
    assert.ok(Number.isFinite(attempt.contentCharacters) && attempt.contentCharacters > 0);
    assert.ok(Number.isFinite(attempt.elapsedMs) && attempt.elapsedMs >= 0);
  }
  const serialized = JSON.stringify(attempts);
  for (const secret of [config.apiKey, system, user, privateReasoning, partial, completeText]) assert.equal(serialized.includes(secret), false);
});
