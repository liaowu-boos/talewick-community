import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { validateRetrieval, prepareWorkflowKnowledge } from './knowledge.mjs';
// Explicitly opt into real data-service code, with synthetic source and model double only.
const runtime = process.env.TALEWICK_DATA_RUNTIME;
if (!runtime) throw new Error('Set TALEWICK_DATA_RUNTIME to the data runtime directory for this integration test.');
const { createLibraryService } = await import(pathToFileURL(join(runtime, 'library.mjs')));
const { prepareKnowledge } = await import(pathToFileURL(join(runtime, 'knowledge.mjs')));

test('real library alias retrieval supplies an uncovered raw window without invented analysis unit IDs', async t => {
  const rootDir = await mkdtemp(join(tmpdir(), 'creation-raw-gap-'));
  let modelCalls = 0;
  const lib = await createLibraryService({ rootDir, reviewAnalysis: null, model: { complete: async () => {
    modelCalls++;
    return JSON.stringify({ overview: '只分析开头', coverage: { scope: 'unknown', notes: ['合成测试'] },
      units: [{ id: 'unit-opening', title: '开头', locator: { lineStart: 1, lineEnd: 1 }, event: '起点',
        psychology: '未明确', emotion: '未明确', expression: '叙述', readerEffectHypothesis: '未验证',
        evidence: [{ quote: '起点。', lineStart: 1, lineEnd: 1 }], relatedUnitIds: [] }], limitations: ['确定性模型替身'] });
  } } });
  t.after(async () => { await lib.close(); await rm(rootDir, { recursive: true, force: true }); });
  const bytes = Buffer.from(`起点。${'甲'.repeat(1390)}\n她走到灯塔，停下。`);
  const canonical = await lib.importSource({ requestId: 'first', fileName: 'synthetic.txt', bytes });
  const alias = await lib.importSource({ requestId: 'duplicate', fileName: 'alias.txt', bytes });
  assert.equal(alias.duplicateOf, canonical.sourceId);
  let detail;
  for (let i = 0; i < 200; i++) {
    detail = await lib.get(canonical.sourceId);
    if (!['queued', 'running'].includes(detail.status)) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal(detail.indexStatus, 'ready');
  const query = { contractVersion: 'v04-contract-1', query: '灯塔', context: '', stage: 'planning',
    sourceIds: [alias.sourceId], budget: { maxCandidates: 20, maxUnits: 6, maxChars: 12000 } };
  const result = await lib.retrieve(query);
  assert.equal(result.status, 'matched');
  assert.deepEqual(result.sourceResolutions, [{ requestedSourceId: alias.sourceId, canonicalSourceId: canonical.sourceId,
    textVersion: canonical.textVersion, sourceSha256: canonical.sourceSha256 }]);
  assert.deepEqual(validateRetrieval(result, query), result);
  const material = result.materials[0], ref = material.references[0];
  assert.equal(material.use, 'raw_reference');
  assert.deepEqual(ref.unitIds, []);
  assert.equal(ref.lineStart, 2); assert.equal(ref.lineEnd, 2);
  assert.equal(ref.sourceId, canonical.sourceId);
  const source = await lib.readSource(ref.sourceId, { textVersion: ref.textVersion });
  assert.equal(source.sourceSha256, ref.sourceSha256);
  assert.match(material.content, /她走到灯塔，停下。/);
  assert.equal(source.text.split('\n')[1], '她走到灯塔，停下。');
  const knowledge = await prepareWorkflowKnowledge({ request: { kind: 'create', idea: '灯塔', sourceIds: [alias.sourceId] },
    requirements: { summary: '灯塔' }, prepareKnowledge, retrieveKnowledge: lib.retrieve });
  assert.equal(knowledge.retrieval.status, 'matched');
  assert.equal(knowledge.retrieval.mergeAdapter, 'data');
  assert.deepEqual(knowledge.retrieval.sourceResolutions, result.sourceResolutions);
  assert.deepEqual(knowledge.materials[0].references[0].unitIds, []);
  assert.equal(modelCalls, 1, 'duplicate import, retrieval and merge do not reanalyze');
  const emptyQuery = { ...query, sourceIds: [] };
  const empty = await lib.retrieve(emptyQuery);
  assert.deepEqual(empty.sourceResolutions, []);
  assert.deepEqual(validateRetrieval(empty, emptyQuery), empty);
});
