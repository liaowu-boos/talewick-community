import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLibraryService} from '../runtime/library.mjs';
import {prepareKnowledge} from '../runtime/knowledge.mjs';
import {mergeFollowupMaterials} from '../runtime/followup-materials.mjs';
import {MATERIAL_NARRATIVE_OBSERVATION_VERSION} from '../runtime/narrative-observations.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const projectionHash = value => sha(JSON.stringify(canonical(value)));
const analysis = line => ({overview: '钥匙与离开', coverage: {scope: 'unknown', notes: []}, limitations: [], units: [{
  id: 'u1', title: '放回钥匙', locator: {lineStart: 1, lineEnd: 1}, event: '她放回钥匙', psychology: '未知', emotion: '克制',
  expression: '动作', readerEffectHypothesis: '可能形成结束感', evidence: [{quote: line, lineStart: 1, lineEnd: 1}], relatedUnitIds: [],
}]});
const query = () => ({contractVersion: 'v04-contract-1', query: '放回钥匙', context: '', stage: 'planning'});
async function settled(lib, id) {
  for (let index = 0; index < 200; index++) {
    const state = await lib.get(id); if (!['queued', 'running'].includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw Error('timeout');
}

function attached(material) {
  const ref = material.references[0];
  const item = {
    id: `legacy:${ref.sourceId}:story:ending_mechanism`, field: 'ending_mechanism', value: '以放回钥匙完成关系退出。',
    analysisStatus: {kind: 'archived_ai_narrative_observation', archiveAccepted: true, currentAnalysisBindingValid: false, grantsCurrentCheckedAnalysisStatus: false},
    confidence: {originalFieldConfidence: 'high', boundaryOrigin: 'analyst_simulated'},
    source: {sourceId: ref.sourceId, title: material.title, sourceSha256: ref.sourceSha256, normalizedTextSha256: sha('她放回钥匙。'), textVersion: ref.textVersion},
    archive: {storyId: 'story', cardSha256: sha('card'), auditSha256: sha('audit')},
    authority: {classification: 'observable_narrative_choice', authorIntentClaimed: false, grantsNewCheckedAnalysisStatus: false, automaticCreativeSupply: false, retrievalIntegrated: false},
    evidence: [{quote: '她放回钥匙。', lineStart: ref.lineStart, lineEnd: ref.lineEnd}],
    materialBinding: {materialId: material.id, references: [{sourceId: ref.sourceId, sourceSha256: ref.sourceSha256, textVersion: ref.textVersion,
      analysisVersion: ref.analysisVersion, lineStart: ref.lineStart, lineEnd: ref.lineEnd, unitIds: [...ref.unitIds]}], allEvidenceInsideSelectedWindows: true},
    limitations: ['历史 AI 观察，不是当前 checked analysis。'],
  };
  const charged = {...item, chargedChars: JSON.stringify(item).length};
  const projection = {contractVersion: MATERIAL_NARRATIVE_OBSERVATION_VERSION, queryHash: sha('query'), usedChars: charged.chargedChars,
    items: [charged], limits: ['必须显式采用材料。']};
  projection.projectionSha256 = projectionHash({contractVersion: projection.contractVersion, queryHash: projection.queryHash, items: projection.items, limits: projection.limits});
  return {...material, narrativeObservations: projection};
}

async function setup(t, projector) {
  const rootDir = await mkdtemp(join(tmpdir(), 'narrative-observation-supply-'));
  const line = '她放回钥匙。';
  const lib = await createLibraryService({rootDir, reviewAnalysis: null, narrativeObservationProjector: projector,
    model: {complete: async () => JSON.stringify(analysis(line))}});
  t.after(async () => { await lib.close(); await rm(rootDir, {recursive: true, force: true}); });
  const source = await lib.importSource({requestId: 'one', fileName: 'one.txt', bytes: Buffer.from(line)});
  await settled(lib, source.sourceId);
  return lib;
}

test('actual retrieval path attaches validated observations after final material selection without changing material identity or content accounting', async t => {
  let called = 0;
  const lib = await setup(t, async ({query: text, materials}) => {
    called++; assert.equal(text, '放回钥匙'); assert.equal(materials.length, 1);
    return {materials: [attached(materials[0])], summary: {contractVersion: MATERIAL_NARRATIVE_OBSERVATION_VERSION, status: 'attached',
      attachedItemCount: 1, usedChars: attached(materials[0]).narrativeObservations.usedChars, limits: ['有限观察投影。']}};
  });
  const result = await lib.retrieve(query());
  assert.equal(called, 1); assert.equal(result.status, 'matched'); assert.equal(result.materials.length, 1);
  assert.equal(result.materials[0].narrativeObservations.items.length, 1);
  assert.equal(result.usedChars, result.materials[0].content.length);
  assert.equal(result.narrativeObservationProjection.status, 'attached');
  assert.match(result.limits.join('\n'), /有限观察投影/);
  const knowledge = await prepareKnowledge({}, {retrievalResult: result});
  assert.deepEqual(knowledge.materials[0].narrativeObservations, result.materials[0].narrativeObservations);
  const merged = mergeFollowupMaterials({active: [], result});
  assert.deepEqual(merged.active[0].narrativeObservations, result.materials[0].narrativeObservations);
  assert.equal(merged.active[0].id, result.materials[0].id); assert.equal(merged.active[0].adopted, undefined);
  const tampered = structuredClone(result); tampered.materials[0].narrativeObservations.items[0].evidence[0].lineEnd++;
  await assert.rejects(prepareKnowledge({}, {retrievalResult: tampered}), /叙事观察绑定无效/);
  assert.throws(() => mergeFollowupMaterials({active: [], result: tampered}), {code: 'INVALID_RESULT'});
});

test('stale, malformed or identity-changing projection is rejected while original retrieval material remains available', async t => {
  for (const [name, projector, reason] of [
    ['stale', async () => { throw Object.assign(Error('stale'), {code: 'NARRATIVE_OBSERVATION_SNAPSHOT_STALE'}); }, 'snapshot_stale'],
    ['identity change', async ({materials}) => ({materials: [{...materials[0], id: 'changed'}], summary: {status: 'attached'}}), 'projection_rejected'],
  ]) await t.test(name, async t => {
    const lib = await setup(t, projector); const result = await lib.retrieve(query());
    assert.equal(result.status, 'matched'); assert.equal(result.materials.length, 1); assert.equal(result.materials[0].narrativeObservations, undefined);
    assert.equal(result.narrativeObservationProjection.status, 'unavailable'); assert.equal(result.narrativeObservationProjection.reason, reason);
  });
});

test('unconfigured projector keeps the legacy retrieval response shape', async t => {
  const lib = await setup(t, undefined); const result = await lib.retrieve(query());
  assert.equal(result.status, 'matched'); assert.equal(result.narrativeObservationProjection, undefined);
  assert.equal(result.materials[0].narrativeObservations, undefined);
});
