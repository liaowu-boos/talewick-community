import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Full15Service, manuscriptText, productManuscriptRevision } from './full15-service.mjs';
import * as full15Adapter from '../../../validation/runtime/full15-task.mjs';

// Real local adapter/Python/checks with synthetic analysis only; no provider calls.
test('real adapter and product service preserve live progress through a noncanonical system temp root', { timeout: 15000 }, async () => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'full15-cross-progress-'));
  const chapters = [{ id: 'c1', title: '第一章', body: '张三拿起钥匙。他要去学校。' }];
  const title = '题';
  const frozenText = manuscriptText(title, chapters);
  const quote = '张三拿起钥匙。';
  const start = frozenText.indexOf(quote);
  const questions = ['actor', 'event', 'goal_or_risk'].map(question => ({
    question, answer: question === 'actor' ? '张三' : '张三拿起钥匙准备去学校',
    citations: [{ source_id: 'draft', quote, start_char: start, end_char: start + quote.length }],
  }));
  let release;
  let checkEntered;
  const gate = new Promise(resolve => { release = resolve; });
  const checkSeen = new Promise(resolve => { checkEntered = resolve; });
  const analyze = async input => {
    if (input.stage === 'check') { checkEntered(); await gate; }
    const indices = input.chunks.map(chunk => chunk.index);
    const output = input.stage === 'cold_read'
      ? { schema_version: 'full15-cold-read-1', source_sha256: input.sourceSha256, scope: { full_text_read: true, read_chunks: indices }, questions, candidates: [], limitations: [] }
      : { schema_version: 'full15-analysis-1', source_sha256: input.sourceSha256, scope: { full_text_read: true, read_chunks: indices }, checks: {
        C02: { status: 'checked', summary: '开篇可识别人物和动作。', answers: questions },
        C03: { status: 'checked', summary: '未发现明确互斥知情表述。' },
        C04: { status: 'checked', summary: '未发现明确互斥物件状态。' },
        C05: { status: 'not_applicable', summary: '未声明四五章切口。', data: { action_done_in_ch4: null, pending_result_or_cost: null, actual_ch5_continuation: null }, citations: [] },
      }, issues: [], limitations: [], reference_use: [] };
    return { outputText: JSON.stringify(output), receipt: { provider: 'fixture-only', invocationId: `inv-${input.stage}`, contextId: `ctx-${input.stage}`, packetSha256: input.packetSha256, deliveredChunkIndices: indices } };
  };
  const service = await new Full15Service({
    rootDir, adapter: full15Adapter, analyze,
    inputForManuscript: async () => ({ requirements: {}, references: { sources: [] }, profile: 'no_corpus' }),
  }).init();
  try {
    const queued = await service.start({
      projectId: 'p', requestId: 'q', title, chapters,
      manuscriptRevision: productManuscriptRevision(title, chapters),
    });
    await checkSeen;
    const live = service.get(queued.id);
    assert.equal(live.progress.completedStages, 1, JSON.stringify(live));
    assert.equal(live.status, 'running');
    assert.equal(live.progress.completedStages, 1);
    assert.ok(live.progress.completedChunks > 0);
    assert.ok(live.progress.totalChunks > live.progress.completedChunks, JSON.stringify(live.progress));
    release();
    while (service.busy) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(service.get(queued.id).status, 'complete');
  } finally {
    release?.();
    await service.close();
    await rm(rootDir, { recursive: true, force: true });
  }
});
