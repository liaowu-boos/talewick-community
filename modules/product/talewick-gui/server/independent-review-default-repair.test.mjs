import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRuntime } from './index.mjs';
import { independentReviewRequestHash as hash } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

const chapters = [{ id: 'c1', title: '记录', body: '同一句。同一句。' }];
const input = { projectId: 'default-repair', requestId: 'default-once', caseId: 'default-case', mode: 'single', title: '记录', chapters,
  manuscriptRevision: productManuscriptRevision('记录', chapters) };
async function settled(service, id) {
  for (let i = 0; i < 400; i++) { const task = service.get(id); if (!['queued', 'running'].includes(task.status) && !service.busy) return task; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Synthetic task did not settle');
}
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'talewick-default-position-')), calls = [];
  const model = { complete: async args => {
    calls.push(args); args.onReceipt({ provider: 'synthetic', contextId: 'new-context', invocationId: 'only-invocation' });
    return JSON.stringify({ repairs: [] });
  } };
  let state;
  const packet = { schemaVersion: 'synthetic-position-packet', invalidCitations: [] }, inputHash = hash(packet);
  const adapter = { getIndependentReviewVersions: () => ({ protocolVersion: 'synthetic' }),
    startIndependentReview: async args => {
      const runDir = path.join(args.runRoot, 'synthetic', 'run'); await mkdir(runDir, { recursive: true });
      state = { runDir, requestHash: hash(args.request), status: 'needs_attention', report: null,
        progress: { phase: 'stage_needs_attention', completedStages: 0, totalStages: 2 },
        error: { code: 'QUOTE_POSITION_NOT_UNIQUE', stage: '01-reader-1-first', message: 'Ambiguous quote', recoverable: false } };
      return structuredClone(state);
    },
    readIndependentReviewProgress: () => structuredClone(state),
    recoverIndependentReviewPositions: async args => {
      await args.analyzePositionRepair({ stage: 'position_repair', packet, inputHash, instruction: 'Only locate the listed quotation.' });
      state.status = 'queued'; state.error = null; return structuredClone(state);
    },
    resumeIndependentReview: () => ({ ...state, status: 'complete', progress: { phase: 'complete', completedStages: 2, totalStages: 2 }, report: { automaticAdoption: false } }),
  };
  const runtime = await createRuntime({ config: { baseURL: 'http://127.0.0.1:1', apiKey: extra.unconfigured ? '' : 'synthetic-only',
    model: 'synthetic', engine: 'fixed', agentProvider: 'openai-compatible', runsDir: path.join(root, 'runs'), libraryDir: path.join(root, 'library'), port: 0 },
    model, library: null, full15Adapter: null, independentReviewAdapter: adapter, ...extra });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  return { runtime, calls, packet, inputHash };
}

test('configured default runtime waits for explicit position recovery then calls its own model once with separate stage and receipt', async t => {
  const f = await fixture(t), service = f.runtime.independentReviews;
  assert.equal(service.recoveryCapabilities().position_repair, true); assert.equal(service.auditedRecoveryAvailable(), false);
  const task = await service.start(input); await settled(service, task.id); await service.read(task.id); await service.readList();
  assert.equal(f.calls.length, 0, 'startup, failed review and GET never auto-repair');
  await service.recover(task.id, { requestId: 'explicit-user-action', stageId: '01-reader-1-first', mode: 'position_repair' });
  assert.equal((await settled(service, task.id)).status, 'complete'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].stage, 'independent-review:position-repair'); assert.equal(f.calls[0].allowRecovery, false);
  assert.deepEqual(JSON.parse(f.calls[0].user), { inputHash: f.inputHash, packet: f.packet });
});

test('explicit injected repair callback wins over default factory', async t => {
  let invoked = 0; const override = async () => { invoked++; };
  const f = await fixture(t, { independentReviewPositionRepairAnalyze: override });
  assert.equal(f.runtime.independentReviews.analyzePositionRepair, override);
  const task = await f.runtime.independentReviews.start(input); await settled(f.runtime.independentReviews, task.id);
  await f.runtime.independentReviews.recover(task.id, { requestId: 'override-action', stageId: '01-reader-1-first', mode: 'position_repair' });
  await settled(f.runtime.independentReviews, task.id); assert.equal(invoked, 1); assert.equal(f.calls.length, 0);
});

test('unconfigured runtime and explicit null keep position repair disabled', async t => {
  for (const options of [{ unconfigured: true }, { independentReviewPositionRepairAnalyze: null }]) {
    const f = await fixture(t, options); assert.equal(f.runtime.independentReviews.recoveryCapabilities().position_repair, false);
    assert.equal(f.runtime.independentReviews.auditedRecoveryAvailable(), false); assert.equal(f.calls.length, 0);
  }
});
