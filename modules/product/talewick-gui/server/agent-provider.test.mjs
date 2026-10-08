import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolLoopAgent, tool, isStepCount } from 'ai';
import { z } from 'zod';
import { agentCallSettings, createAgentModel, createAIController } from './agent-ai-sdk.mjs';

for (const provider of ['deepseek', 'openai-compatible']) {
  test(`${provider} adapter uses real SDK tool messages, direct endpoint and bounded private fetch`, async () => {
    const requests = [];
    const config = { apiKey: 'private-test-key', model: provider === 'deepseek' ? 'deepseek-flash' : 'test-model',
      baseURL: 'https://model.example.invalid/v1', agentProvider: provider, timeoutMs: 3000 };
    const model = createAgentModel(config, async (url, init) => {
      requests.push({ url: String(url), ...init, body: JSON.parse(init.body) });
      if (provider === 'deepseek' && requests.at(-1).body.tool_choice !== 'auto') {
        return Response.json({ error: { message: 'Thinking mode does not support this tool_choice' } }, { status: 400 });
      }
      const number = requests.length;
      return new Response(JSON.stringify({ id: `reply-${number}`, object: 'chat.completion', created: 0, model: 'test-model',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null,
          reasoning_content: `private-reasoning-${number}`, tool_calls: [{ id: `call-${number}`, type: 'function',
            function: { name: 'inspect', arguments: JSON.stringify({ reason: `check-${number}` }) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }), { headers: { 'Content-Type': 'application/json' } });
    });
    const executed = [];
    await new ToolLoopAgent({ model, maxRetries: 0, ...agentCallSettings(config), stopWhen: isStepCount(2),
      tools: { inspect: tool({ description: 'Read current plan', inputSchema: z.object({ reason: z.string() }),
        execute: input => { executed.push(input.reason); return { seen: true }; } }) },
    }).generate({ prompt: 'Inspect twice.' });
    assert.deepEqual(executed, ['check-1', 'check-2']);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://model.example.invalid/v1/chat/completions');
    assert.equal(requests[0].redirect, 'error');
    assert.ok(requests[0].signal instanceof AbortSignal);
    assert.equal(new Headers(requests[0].headers).get('authorization'), 'Bearer private-test-key');
    assert.equal(requests[0].body.tool_choice, provider === 'deepseek' ? 'auto' : 'required');
    assert.deepEqual(requests.map(request => request.body.max_tokens), provider === 'deepseek' ? [32768, 32768] : [1800, 1800]);
    assert.ok(requests[1].body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'call-1'));
    if (provider === 'deepseek') {
      assert.notEqual(requests[0].body.thinking?.type, 'disabled');
      assert.equal(requests[1].body.messages.find(message => message.role === 'assistant').reasoning_content, 'private-reasoning-1');
    }
  });
}

test('Agent provider cannot start without a local model credential', () => {
  assert.throws(() => createAgentModel({ model: 'test', apiKey: '' }, () => { throw new Error('must not fetch'); }), /尚未配置/);
});

test('DeepSeek auto tool choice cannot mark a phase complete with a text-only reply', async () => {
  const config = { apiKey: 'private-test-key', model: 'deepseek-v4-flash', baseURL: 'https://api.deepseek.com', timeoutMs: 3000 };
  const requests = [];
  const agentModel = createAgentModel(config, async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ id: 'text-only', object: 'chat.completion', created: 0, model: config.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '已完成。' } }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } });
  });
  const states = new Map();
  const controller = createAIController({ config, agentModel });
  await assert.rejects(controller.plan({ input: {}, requirements: {}, plan: { title: '测试方案' }, knowledge: {},
    loadState: key => states.get(key), saveState: async (key, value) => states.set(key, structuredClone(value)),
    step: async () => { throw new Error('A text reply must not run a business tool'); },
  }), /未执行明确的阶段结束操作/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tool_choice, 'auto');
  assert.equal(requests[0].max_tokens, 32768, 'the production controller must not override the thinking budget with 1800');
  assert.equal(states.get('journal').state.done, false);
  assert.deepEqual(states.get('journal').trace, []);
});
