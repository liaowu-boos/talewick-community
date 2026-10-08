import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { prepareWorkflowKnowledge, retrievalQuery, validateRetrieval, knowledgeForAuthor } from './knowledge.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const request = { kind: 'create', idea: '新作人物已经决定离开，但仍受熟悉照料触动' };
const requirements = { summary: request.idea, genre: '当代', requiredElements: [], prohibitions: ['不能复合'] };
const base = { packetId: 'base', materials: [], limits: [], style: null, coverage: 'uncovered' };
const prepareKnowledge = async () => structuredClone(base); // Explicit test double for baseline merger.
const opts = { request, requirements, prepareKnowledge };
function response(query, status = 'matched') {
  const content = '只收到前四章；她接受照料仍决定离开。后文兑现未知。';
  return { contractVersion: 'v04-contract-1', packetId: 'test-packet-v1', query: structuredClone(query), status,
    materials: status === 'matched' ? [{ id: 'test-unit', title: '测试材料', content, kind: 'retrieved', use: 'reviewed_analysis', sha256: hash(content),
      references: [{ sourceId: 's1', textVersion: 't1', analysisVersion: 'a1', reviewRecordId: 'review-test-1', sourceSha256: hash('测试原文'), unitIds: ['u1'], lineStart: 2, lineEnd: 3 }],
      selectionReason: '决定不变与情绪波动可并存', limitations: ['first_four；只观察前四章，未知中后段与结局'] }] : [],
    candidates: [], usedChars: status === 'matched' ? content.length : 0, limits: ['测试替身，不证明语义相关性'] };
}

test('query is generated from normalized needs, is bounded, and respects explicit empty scope', () => {
  const query = retrievalQuery({ ...request, sourceIds: [] }, { ...requirements, summary: '长'.repeat(10000) }, 300);
  assert.equal(query.query.length, 2000);
  assert.equal(query.context.length, 6000);
  assert.deepEqual(query.sourceIds, []);
  assert.deepEqual(query.budget, { maxCandidates: 20, maxUnits: 6, maxChars: 300 });
  assert.equal(retrievalQuery({ kind: 'revise', instruction: '整体情绪平' }, requirements, 30000).stage, 'revision');
});

test('no injection, no match, service unavailable, and exhausted budget stay distinct', async () => {
  assert.equal((await prepareWorkflowKnowledge(opts)).retrieval.status, 'not_connected');
  for (const status of ['uncovered', 'unavailable']) {
    const packet = await prepareWorkflowKnowledge({ ...opts, retrieveKnowledge: async query => response(query, status) });
    assert.equal(packet.retrieval.status, status);
    assert.equal(packet.materials.length, 0);
  }
  const failure = await prepareWorkflowKnowledge({ ...opts, retrieveKnowledge: async () => { throw new Error('secret-private-provider-url'); } });
  assert.equal(failure.retrieval.status, 'unavailable');
  assert.doesNotMatch(JSON.stringify(failure), /secret-private/);
  const exhausted = await prepareWorkflowKnowledge({ ...opts, prepareKnowledge: async () => ({ ...base, materials: [{ content: '字'.repeat(30000) }] }),
    retrieveKnowledge: async () => { assert.fail('budget exhausted must not call retrieval'); } });
  assert.equal(exhausted.retrieval.status, 'skipped_budget');
});

test('baseline merger compatibility retains actual content, source version, and first-four limits', async () => {
  let received;
  const packet = await prepareWorkflowKnowledge({ ...opts, retrieveKnowledge: async query => { received = query; return response(query); } });
  assert.equal(received.budget.maxChars, 12000);
  assert.equal(packet.retrieval.mergeAdapter, 'creation-v04-compat');
  assert.equal(packet.materials[0].references[0].textVersion, 't1');
  assert.match(packet.materials[0].limitations[0], /first_four/);
  assert.equal(packet.coverage, 'partial');
  assert.deepEqual(packet.retrieval.materials[0].content, packet.materials[0].content);
});

test('new merger is called with optional result and remaining shared budget, no double append', async () => {
  const selected = { id: 'selected', kind: 'user_selected', content: '字'.repeat(29500), sha256: hash('字'.repeat(29500)) };
  let secondArgument;
  const packet = await prepareWorkflowKnowledge({ ...opts,
    prepareKnowledge: async (_, options) => { secondArgument = options;
      return { ...base, materials: [selected, ...(options?.retrievalResult.materials ?? [])] }; },
    retrieveKnowledge: async query => { assert.equal(query.budget.maxChars, 500); return response(query); } });
  assert.equal(packet.retrieval.mergeAdapter, 'data');
  assert.equal(packet.materials.length, 2);
  assert.equal(secondArgument.retrievalResult.packetId, 'test-packet-v1');
});

test('invalid hash, versions, query, candidate/unit counts, status, scope, or characters never enter author input', async () => {
  const changes = [
    result => { delete result.materials[0].use; },
    result => { delete result.materials[0].references[0].reviewRecordId; },
    result => { result.materials[0].sha256 = hash('different'); },
    result => { result.materials[0].references[0].textVersion = ''; },
    result => { result.query.query += 'changed'; },
    result => { result.candidates = Array.from({ length: 21 }, () => ({ id: 'x', sourceId: 's1', reason: 'x' })); },
    result => { result.materials[0].references[0].unitIds = ['1', '2', '3', '4', '5', '6', '7']; },
    result => { result.status = 'uncovered'; },
    result => { result.usedChars++; },
    result => { result.materials[0].references[0].lineStart = 0; },
    result => { result.materials[0].content = '字'.repeat(12001); result.materials[0].sha256 = hash(result.materials[0].content); result.usedChars = 12001; },
  ];
  for (const change of changes) {
    const packet = await prepareWorkflowKnowledge({ ...opts, retrieveKnowledge: async query => { const value = response(query); change(value); return value; } });
    assert.equal(packet.retrieval.status, 'unavailable');
    assert.equal(packet.materials.length, 0);
  }
  const query = retrievalQuery({ ...request, sourceIds: [] }, requirements, 30000);
  assert.throws(() => validateRetrieval(response(query), query), /指定来源/);
});

test('abort before, during, or from the callback propagates and never falls back', async () => {
  const aborted = new AbortController(); aborted.abort(new Error('user cancelled'));
  await assert.rejects(prepareWorkflowKnowledge({ ...opts, signal: aborted.signal }), /user cancelled/);
  const controller = new AbortController();
  await assert.rejects(prepareWorkflowKnowledge({ ...opts, signal: controller.signal, retrieveKnowledge: async (query, { signal }) => {
    assert.equal(signal, controller.signal); controller.abort(new Error('cancel in flight')); return response(query);
  } }), /cancel in flight/);
  await assert.rejects(prepareWorkflowKnowledge({ ...opts, retrieveKnowledge: async () => { throw new DOMException('cancelled', 'AbortError'); } }), /cancelled/);
});


test('author view preserves use and per-source review records without promoting old packets', () => {
  const query = retrievalQuery(request, requirements, 30000);
  const packet = { ...base, materials: response(query).materials };
  const view = knowledgeForAuthor(packet);
  assert.equal(view.materials[0].use, 'reviewed_analysis');
  assert.equal(view.materials[0].references[0].reviewRecordId, 'review-test-1');
  assert.match(view.materials[0].applicability, /不证明文学效果/);
  packet.materials[0].use = 'raw_reference';
  delete packet.materials[0].references[0].reviewRecordId;
  assert.match(knowledgeForAuthor(packet).materials[0].applicability, /仅原文/);
  delete packet.materials[0].use;
  const before = structuredClone(packet);
  assert.match(knowledgeForAuthor(packet).materials[0].applicability, /用途未核验/);
  assert.deepEqual(packet, before);
});

test('every reviewed source needs a review record, raw reference does not claim one', () => {
  const query = retrievalQuery(request, requirements, 30000);
  const result = response(query);
  result.materials[0].references.push({ ...result.materials[0].references[0], sourceId: 's2', sourceSha256: hash('第二个独立来源原文') });
  delete result.materials[0].references[1].reviewRecordId;
  assert.throws(() => validateRetrieval(result, query), /逐来源复核/);
  result.materials[0].use = 'raw_reference';
  result.materials[0].content = '测试原文。';
  result.materials[0].sha256 = hash('测试原文。'); result.usedChars = '测试原文。'.length;
  assert.equal(validateRetrieval(result, query).materials[0].use, 'raw_reference');
});
