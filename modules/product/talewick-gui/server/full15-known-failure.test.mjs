import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createFull15Analyze } from './full15-analyze.mjs';

const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex');
const sealedTool = fileURLToPath(new URL('../../../creation/novel-review/', import.meta.url));

test('known complete length response persists its real receipt without saving cold read or starting check', async () => {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), 'full15-length-receipt-')));
  try {
    const runtimeDir = path.join(temp, 'backend/modules/validation/runtime');
    const toolDir = path.join(temp, 'backend/modules/creation/novel-review');
    const runRoot = path.join(temp, 'runs');
    await mkdir(runtimeDir, { recursive: true });
    await mkdir(runRoot, { recursive: true });
    await cp(new URL('../../../validation/runtime/full15-task.mjs', import.meta.url), path.join(runtimeDir, 'full15-task.mjs'));
    await cp(sealedTool, toolDir, { recursive: true });
    const runtime = await import(`${pathToFileURL(path.join(runtimeDir, 'full15-task.mjs')).href}?test=${Date.now()}`);
    let modelCalls = 0;
    const analyze = createFull15Analyze({ model: { complete: async args => {
      modelCalls++;
      await args.onAttempt({ stage: args.stage, attempt: 1, mode: 'primary', requestedModel: 'deepseek-flash',
        maxOutputTokens: 65536, finishReason: 'length', contentCharacters: 0, hasReasoning: true, elapsedMs: 1 });
      await args.onReceipt({ provider: 'deepseek', invocationId: 'chatcmpl-persisted-length', contextId: 'chatcmpl-persisted-length' });
      throw new Error('模型输出达到长度上限（全文冷读），本步骤未完成。');
    } } });
    const text = '书名：合成持久化测试\n\n第一章：开始\n' + '这是只在本机运行时测试中使用的合成正文。'.repeat(40) + '\n';
    const result = await runtime.startFull15Review({
      runRoot, manuscript: { text, sha256: sha256(text) }, requirements: { c05_applicable: false },
      references: { sources: [] }, profile: 'no_corpus', analyze,
    });
    assert.equal(modelCalls, 1);
    assert.equal(result.status, 'needs_attention');
    assert.equal(result.error.code, 'provider_output_length_limit');
    assert.equal(result.error.stage, 'cold_read');
    assert.equal(result.stages.cold_read.status, 'dispatched');
    assert.equal(result.stages.check.status, 'waiting');
    assert.equal(result.progress.completedStages, 0);
    assert.equal(result.progress.completedChunks, 0);

    const eventPath = path.join(path.dirname(result.runDir), 'events.ndjson');
    const events = (await readFile(eventPath, 'utf8')).trim().split('\n').map(JSON.parse);
    const returned = events.filter(event => event.type === 'provider_returned');
    assert.equal(returned.length, 1);
    assert.equal(returned[0].stage, 'cold_read');
    assert.equal(returned[0].finishReason, 'length');
    assert.equal(returned[0].providerResponseComplete, true);
    assert.equal(returned[0].semanticAccepted, false);
    assert.equal(returned[0].maxOutputTokens, 65536);
    assert.equal(returned[0].receipt.provider, 'deepseek');
    assert.equal(returned[0].receipt.invocationId, 'chatcmpl-persisted-length');
    assert.equal(returned[0].receipt.contextId, 'chatcmpl-persisted-length');
    assert.match(returned[0].receipt.packetSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(returned[0].receipt.deliveredChunkIndices,
      Array.from({ length: result.stages.cold_read.chunkCount }, (_, index) => index));
    assert.equal(events.some(event => event.type === 'stage_saved'), false);
    assert.equal(events.some(event => event.type === 'dispatch_started' && event.stage === 'check'), false);
    const failed = events.at(-1);
    assert.equal(failed.type, 'failed');
    assert.equal(failed.code, 'provider_output_length_limit');
    assert.equal(failed.receipt.invocationId, 'chatcmpl-persisted-length');

    const reread = await runtime.readFull15Progress({
      runDir: result.runDir, currentManuscriptSha256: result.manuscriptSha256,
      currentRulesVersion: result.rulesVersion, currentInputVersion: result.inputVersion,
    });
    assert.equal(reread.status, 'needs_attention');
    assert.equal(reread.error.code, 'provider_output_length_limit');
    assert.equal(reread.stages.cold_read.status, 'dispatched');
    assert.equal(reread.stages.check.status, 'waiting');
    assert.equal(reread.progress.completedStages, 0);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
