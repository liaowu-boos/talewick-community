import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateRetrieval, prepareWorkflowKnowledge } from './knowledge.mjs';
const hash = value => createHash('sha256').update(value).digest('hex');
const binding = { canonicalSourceId: 'canonical', textVersion: 'text-1', sourceSha256: hash('synthetic source') };
const resolution = requestedSourceId => ({ requestedSourceId, ...binding });
const query = sourceIds => ({ contractVersion: 'v04-contract-1', query: '留恋', context: '合成合同测试', stage: 'planning',
  ...(sourceIds === undefined ? {} : { sourceIds }), budget: { maxCandidates: 20, maxUnits: 6, maxChars: 12000 } });
function packet(q) {
  const content = '合成参考正文';
  return { contractVersion: 'v04-contract-1', packetId: 'synthetic-alias-packet', query: structuredClone(q), status: 'matched',
    ...(q.sourceIds === undefined ? {} : { sourceResolutions: [...new Set(q.sourceIds)].map(resolution) }),
    materials: [{ id: 'material-1', title: '合成材料', content, kind: 'retrieved', use: 'reviewed_analysis', sha256: hash(content),
      references: [{ sourceId: binding.canonicalSourceId, textVersion: binding.textVersion, sourceSha256: binding.sourceSha256,
        analysisVersion: 'analysis-1', reviewRecordId: 'synthetic-review-1', unitIds: ['unit-1'], lineStart: 1, lineEnd: 1 }],
      selectionReason: '合同替身', limitations: ['不证明 registry 真实性或文学效果'] }],
    candidates: [{ id: 'candidate-1', sourceId: 'canonical', reason: '合同替身' }], usedChars: content.length, limits: [] };
}

test('alias and direct canonical scopes bind canonical refs without rewriting the echoed query', () => {
  for (const ids of [['alias'], ['canonical'], ['alias', 'alias'], ['alias', 'canonical'], ['alias', 'alias-2']]) {
    const q = query(ids), result = packet(q), original = structuredClone(result);
    const checked = validateRetrieval(result, q);
    assert.deepEqual(checked, original);
    assert.deepEqual(result, original);
    assert.equal(checked.materials[0].references[0].sourceId, 'canonical');
    assert.equal(checked.materials[0].references[0].reviewRecordId, 'synthetic-review-1');
    checked.sourceResolutions[0].canonicalSourceId = 'local mutation';
    assert.equal(result.sourceResolutions[0].canonicalSourceId, 'canonical');
  }
});

test('missing, extra, duplicate, malformed and partially-null resolution fields are rejected', () => {
  const mutations = [
    r => { r.sourceResolutions = null; },
    r => { r.sourceResolutions = []; },
    r => { r.sourceResolutions.push(resolution('unrequested')); },
    r => { r.sourceResolutions[0].requestedSourceId = 'unrequested'; },
    r => { r.sourceResolutions[0].canonicalSourceId = 123; },
    r => { r.sourceResolutions[0].textVersion = ''; },
    r => { r.sourceResolutions[0].sourceSha256 = 'forged-hash'; },
    r => { r.sourceResolutions[0].canonicalSourceId = null; },
    r => { r.sourceResolutions[0].textVersion = null; },
    r => { delete r.sourceResolutions[0].sourceSha256; },
    r => { r.sourceResolutions[0].trusted = true; },
    r => { r.sourceResolutions[0] = []; },
  ];
  for (const change of mutations) {
    const q = query(['alias']), result = packet(q); change(result);
    assert.throws(() => validateRetrieval(result, q), /来源映射/);
  }
  const q = query(['alias', 'alias-2']), result = packet(q);
  result.sourceResolutions[1] = resolution('alias');
  assert.throws(() => validateRetrieval(result, q), /重复/);
});

test('every material reference must match mapped canonical identity, version and source hash', () => {
  for (const [key, value] of [['sourceId', 'other'], ['sourceId', 'alias'], ['textVersion', 'text-2'], ['sourceSha256', hash('other')]]) {
    const q = query(['alias']), result = packet(q);
    result.materials[0].references.push({ ...result.materials[0].references[0], [key]: value });
    assert.throws(() => validateRetrieval(result, q), /指定来源映射|不匹配/);
  }
  const q = query(['alias']), result = packet(q); result.candidates[0].sourceId = 'unrequested';
  assert.throws(() => validateRetrieval(result, q), /候选超出/);
});

test('aliases cannot disagree on canonical version/hash or form a canonical-to-alias chain', () => {
  for (const [key, value] of [['textVersion', 'other-version'], ['sourceSha256', hash('other')]]) {
    const q = query(['alias', 'alias-2']), result = packet(q);
    result.sourceResolutions[1][key] = value;
    assert.throws(() => validateRetrieval(result, q), /冲突/);
  }
  const q = query(['alias', 'canonical']), result = packet(q);
  result.sourceResolutions[1].canonicalSourceId = 'another-canonical';
  assert.throws(() => validateRetrieval(result, q), /继续映射/);
});

test('unknown and explicit empty scope preserve their empty results and grant no fallback scope', () => {
  for (const ids of [[], ['unknown']]) {
    const q = query(ids), result = packet(q);
    result.sourceResolutions = ids.map(requestedSourceId => ({ requestedSourceId, canonicalSourceId: null, textVersion: null, sourceSha256: null }));
    assert.throws(() => validateRetrieval(result, q), /指定来源映射/);
    result.materials = []; result.usedChars = 0; result.status = 'uncovered';
    assert.throws(() => validateRetrieval(result, q), /候选超出/);
    result.candidates = [];
    assert.deepEqual(validateRetrieval(result, q), result);
    result.status = 'unavailable';
    assert.deepEqual(validateRetrieval(result, q), result);
  }
});

test('unscoped fresh responses need no mapping and cannot carry unsolicited mappings', () => {
  const q = query(), result = packet(q);
  assert.deepEqual(validateRetrieval(result, q), result);
  result.sourceResolutions = [];
  assert.throws(() => validateRetrieval(result, q), /须省略/);
  result.sourceResolutions = [resolution('unsolicited')];
  assert.throws(() => validateRetrieval(result, q), /须省略/);
});

test('knowledge preserves the complete alias map; invalid binding degrades without author materials', async () => {
  const prepareKnowledge = async () => ({ packetId: 'base', materials: [], style: null, limits: [] });
  const args = { request: { kind: 'create', idea: '离开仍有留恋', sourceIds: ['alias'] }, requirements: { summary: '离开' }, prepareKnowledge };
  const valid = await prepareWorkflowKnowledge({ ...args, retrieveKnowledge: async q => packet(q) });
  assert.deepEqual(valid.retrieval.sourceResolutions, [resolution('alias')]);
  assert.equal(valid.retrieval.query.sourceIds[0], 'alias');
  assert.equal(valid.materials[0].references[0].sourceId, 'canonical');
  const invalid = await prepareWorkflowKnowledge({ ...args, retrieveKnowledge: async q => {
    const result = packet(q); result.sourceResolutions[0].textVersion = 'wrong'; return result;
  } });
  assert.equal(invalid.retrieval.status, 'unavailable');
  assert.equal(invalid.materials.length, 0);
});

test('empty analysis units are allowed only for raw windows, whose ranges still consume unit budget', () => {
  const q = query(['alias']), result = packet(q), material = result.materials[0];
  material.references[0].unitIds = [];
  assert.throws(() => validateRetrieval(result, q), /来源版本或行号无效/);
  material.use = 'raw_reference'; delete material.references[0].reviewRecordId;
  assert.deepEqual(validateRetrieval(result, q), result);
  material.references = Array.from({ length: 7 }, (_, i) => ({ ...material.references[0], lineStart: i + 1, lineEnd: i + 1 }));
  assert.throws(() => validateRetrieval(result, q), /单元预算/);
});


test('historical missing resolutions preserve direct scope without inferring alias relationships', () => {
  const directQuery = query(['canonical']), direct = packet(directQuery); delete direct.sourceResolutions;
  const before = structuredClone(direct);
  assert.deepEqual(validateRetrieval(direct, directQuery), before);
  assert.deepEqual(direct, before);
  assert.equal(Object.hasOwn(direct, 'sourceResolutions'), false);
  const aliasQuery = query(['alias']), alias = packet(aliasQuery); delete alias.sourceResolutions;
  assert.throws(() => validateRetrieval(alias, aliasQuery), /指定来源映射/);
  const emptyQuery = query([]), empty = packet(emptyQuery); delete empty.sourceResolutions;
  assert.throws(() => validateRetrieval(empty, emptyQuery), /指定来源映射/);
  empty.status = 'uncovered'; empty.materials = []; empty.candidates = []; empty.usedChars = 0;
  assert.deepEqual(validateRetrieval(empty, emptyQuery), empty);
});
