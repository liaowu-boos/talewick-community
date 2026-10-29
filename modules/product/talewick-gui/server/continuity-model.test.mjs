import test from 'node:test';
import assert from 'node:assert/strict';
import { createModel } from './model.mjs';
import { isBusinessStage, isLibraryStage, outputTokenLimit } from './model-policy.mjs';

// Every request uses injected fake fetch; no environment/config files or real keys.
const config = { baseURL: 'https://example.invalid', agentProvider: 'deepseek', model: 'deepseek-flash', apiKey: 'synthetic-continuity-key', timeoutMs: 3000, idleTimeoutMs: 2500 };
const input = { stage: 'continuity-review', system: 'JSON synthetic-private-system', user: 'synthetic-private-manuscript', maxTokens: 24576 };
const reasoning = 'synthetic-private-reasoning';
const partial = '{"syntheticPartial":true}';
const complete = ' \n{"syntheticReport":"transport fixture only"}\n ';
const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
function response(content = complete, finish = 'stop', thought) {
  return new Response(chunk({ content, ...(thought === undefined ? {} : { reasoning_content: thought }) })
    + chunk({}, finish) + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
function fixture(respond, override = {}) {
  const sent = [], attempts = [];
  const model = createModel({ ...config, ...override }, async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return respond(sent.length, init);
  });
  return { sent, attempts, run: (options = {}) => model.complete({ ...input, onAttempt: a => attempts.push(a), ...options }) };
}
function assertPrivate(value) {
  const text = JSON.stringify(value);
  for (const marker of [config.apiKey, input.system, input.user, reasoning, partial, complete]) {
    assert.equal(text.includes(marker), false, 'diagnostics must exclude private data');
  }
}

test('continuity is an exact opt-in business stage, not a library stage or a default', () => {
  assert.equal(isBusinessStage(input.stage), true);
  assert.equal(isLibraryStage(input.stage), false);
  for (const stage of ['continuity-review:repair', 'continuity-review ', ' continuity-review', 'continuity-review-extra']) {
    assert.equal(isBusinessStage(stage), false);
    assert.equal(outputTokenLimit(config, 24576, stage), 32768);
  }
  assert.equal(outputTokenLimit(config, 24576), 32768);
  for (const budget of [0, -1, NaN, Infinity]) assert.throws(() => outputTokenLimit(config, budget, input.stage), /正数/);
});

test('native thinking aliases send 65536 and JSON only on opt-in, preserving primary thinking and exact returned text', async t => {
  for (const model of ['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-pro']) await t.test(model, async () => {
    const f = fixture(() => response(complete, 'stop', reasoning), { model });
    assert.equal(await f.run(), complete);
    assert.equal(f.sent.length, 1);
    const body = f.sent[0].body;
    assert.equal(body.max_tokens, 65536);
    assert.equal(body.model, model);
    assert.equal(body.stream, true);
    assert.equal(body.thinking, undefined);
    assert.equal(body.reasoning_effort, 'low');
    assert.equal(body.tools, undefined);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.deepEqual(body.messages, [{ role: 'system', content: input.system }, { role: 'user', content: input.user }]);
    assert.equal(f.attempts[0].stage, input.stage);
    assert.equal(f.attempts[0].maxOutputTokens, 65536);
    assertPrivate(f.attempts);
  });
});

test('official-host inference opts in without requiring an explicit provider flag', async () => {
  const f = fixture(() => response(), { baseURL: 'https://api.deepseek.com', agentProvider: undefined });
  await f.run();
  assert.equal(f.sent[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(f.sent[0].body.max_tokens, 65536);
});

test('wire recovery retains the requested visible allowance with a 32768 ceiling and the original input', async t => {
  for (const [requested, expected] of [[12000, 12000], [24576, 24576], [32768, 32768], [1000000, 32768], [1, 512], [6000.1, 6001]]) await t.test(String(requested), async () => {
    const f = fixture(call => call === 1 ? response(partial, 'length', reasoning) : response());
    assert.equal(await f.run({ maxTokens: requested }), complete);
    assert.equal(f.sent.length, 2);
    assert.deepEqual(f.sent.map(x => x.body.max_tokens), [65536, expected]);
    assert.equal(f.sent[0].signal, f.sent[1].signal);
    assert.deepEqual(f.sent[1].body, { ...Object.fromEntries(Object.entries(f.sent[0].body).filter(([key]) => key !== 'reasoning_effort')), max_tokens: expected, thinking: { type: 'disabled' } });
    assert.deepEqual(f.attempts.map(a => [a.stage, a.attempt, a.mode, a.maxOutputTokens, a.finishReason, a.hasReasoning]), [
      [input.stage, 1, 'primary', 65536, 'length', true],
      [input.stage, 2, 'recovery', expected, 'stop', false],
    ]);
    assertPrivate(f.attempts);
  });
});

test('parseable length output never succeeds; length and empty-stop share at most one recovery', async t => {
  for (const [first, second, pattern] of [
    [[partial, 'length'], [partial, 'length'], /长度上限（连续性核查）.*未完成/],
    [['', 'stop'], [partial, 'length'], /长度上限（连续性核查）.*未完成/],
    [[partial, 'length'], ['', 'stop'], /没有返回正文/],
    [['', 'stop'], ['', 'stop'], /没有返回正文/],
  ]) await t.test(`${first[1]}/${second[1]}`, async () => {
    const f = fixture(call => response(...(call === 1 ? first : second), reasoning));
    await assert.rejects(f.run(), error => { assert.match(error.message, pattern); assertPrivate(error.message); return true; });
    assert.equal(f.sent.length, 2);
    assert.equal(f.attempts.length, 2);
    assertPrivate(f.attempts);
  });
  const f = fixture(call => call === 1 ? response('', 'stop', reasoning) : response());
  assert.equal(await f.run(), complete);
  assert.deepEqual(f.sent.map(x => x.body.max_tokens), [65536, 24576]);
});

test('a native length response without reasoning fails after one call', async t => {
  for (const thought of [undefined, ' \n ']) await t.test(String(thought), async () => {
    const f = fixture(() => response(partial, 'length', thought));
    await assert.rejects(f.run(), /长度上限（连续性核查）/);
    assert.equal(f.sent.length, 1);
  });
});

test('compatible providers and older native models keep 16000, existing JSON mode, and no recovery', async t => {
  for (const override of [{ agentProvider: 'openai-compatible' }, { agentProvider: 'openai-compatible', baseURL: 'https://api.deepseek.com' }, { agentProvider: undefined }, { model: 'deepseek-chat' }]) await t.test(JSON.stringify(override), async () => {
    const f = fixture(() => Response.json({ choices: [{ message: { content: partial, reasoning_content: reasoning }, finish_reason: 'length' }] }), override);
    await assert.rejects(f.run(), /长度上限（连续性核查）/);
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0].body.max_tokens, 16000);
    assert.equal(f.sent[0].body.stream, false);
    assert.equal(f.sent[0].body.thinking, undefined);
    assert.deepEqual(f.sent[0].body.response_format, override.model === 'deepseek-chat' ? { type: 'json_object' } : undefined);
  });
});

test('ordinary review still sends 32768 then 12000, while unknown stages do not recover length', async () => {
  const review = fixture(call => call === 1 ? response(partial, 'length', reasoning) : response());
  await review.run({ stage: 'review', maxTokens: 12000 });
  assert.deepEqual(review.sent.map(x => x.body.max_tokens), [32768, 12000]);
  assert.deepEqual(review.sent[0].body.response_format, { type: 'json_object' });
  const unknown = fixture(() => response(partial, 'length', reasoning));
  await assert.rejects(unknown.run({ stage: 'continuity-review:repair' }), /长度上限/);
  assert.equal(unknown.sent.length, 1);
  assert.equal(unknown.sent[0].body.max_tokens, 32768);
  assert.equal(unknown.sent[0].body.response_format, undefined);
});

test('deadline expiry or caller cancellation after primary prevents recovery', async t => {
  for (const mode of ['deadline', 'cancel']) await t.test(mode, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const caller = new AbortController();
    const f = fixture(() => response(partial, 'length', reasoning), { timeoutMs: 100, idleTimeoutMs: 1000 });
    await assert.rejects(f.run({ signal: caller.signal, onAttempt: () => {
      if (mode === 'deadline') t.mock.timers.tick(100);
      else caller.abort();
    } }), mode === 'deadline' ? /已达到本步骤等待上限/ : { name: 'AbortError' });
    assert.equal(f.sent.length, 1);
  });
});

test('recovery consumes the remaining original deadline, even while thinking/content idle time remains', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let cancelled = false;
  const pending = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-type': 'text/event-stream' } });
  const f = fixture(call => call === 1 ? response(partial, 'length', reasoning) : pending, { timeoutMs: 100, idleTimeoutMs: 1000 });
  const rejected = assert.rejects(f.run({ onAttempt: () => t.mock.timers.tick(70) }), /已达到本步骤等待上限/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].signal, f.sent[1].signal);
  t.mock.timers.tick(29);
  assert.equal(f.sent[1].signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(f.sent.length, 2);
  assert.equal(cancelled, true);
});

test('recovery HTTP/network errors never expose keys or return the first parseable length output', async t => {
  for (const failure of ['HTTP', 'network']) await t.test(failure, async () => {
    const f = fixture(call => {
      if (call === 1) return response(partial, 'length', reasoning);
      if (failure === 'network') throw new Error(config.apiKey);
      return new Response(config.apiKey, { status: 401 });
    });
    await assert.rejects(f.run(), error => {
      assert.match(error.message, failure === 'HTTP' ? /HTTP 401/ : /无法连接/);
      assertPrivate(error.message);
      return true;
    });
    assert.equal(f.sent.length, 2);
    assertPrivate(f.attempts);
  });
});

test('transport passes stopped text verbatim and does not repair or validate report structure/semantics', async () => {
  const malformed = ' \n{"unclosed":';
  const f = fixture(() => response(malformed));
  assert.equal(await f.run(), malformed);
  assert.equal(f.sent.length, 1);
});
