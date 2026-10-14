import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  createNarrativeObservationService,
  MATERIAL_NARRATIVE_OBSERVATION_VERSION,
  NARRATIVE_OBSERVATION_QUERY_VERSION,
  validateMaterialNarrativeObservations,
} from '../runtime/narrative-observations.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  : value;
const resignProjection = material => {
  const projection = material.narrativeObservations;
  for (const item of projection.items) {
    delete item.chargedChars;
    item.chargedChars = JSON.stringify(item).length;
  }
  projection.usedChars = projection.items.reduce((sum, item) => sum + item.chargedChars, 0);
  projection.projectionSha256 = sha(JSON.stringify(canonical({contractVersion: projection.contractVersion,
    queryHash: projection.queryHash, items: projection.items, limits: projection.limits})));
  return material;
};
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

async function fixture({damageEvidence = false, sourceFormat = 'utf8-lf', legacyObservationFields = ['midpoint_engine']} = {}) {
  const root = await mkdtemp(join(tmpdir(), 'narrative-observation-query-'));
  const libraryRoot = join(root, 'library');
  const sidecarRoot = join(root, 'sidecars-package');
  const sourceId = 'source-1';
  const storyId = 'story-1';
  const text = '她把旧钥匙放回桌上。\n雨停后，她独自签下离婚协议。\n门外没有人追来。';
  const sourceBody = sourceFormat.endsWith('crlf') ? text.replace(/\n/g, '\r\n') : text;
  const sourceBytes = sourceFormat.startsWith('utf16le')
    ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(sourceBody, 'utf16le')])
    : Buffer.from(sourceBody, 'utf8');
  const encoding = sourceFormat.startsWith('utf16le') ? 'utf-16le' : 'utf-8';
  const sourceSha256 = sha(sourceBytes);
  const normalizedTextSha256 = sha(text);
  const textVersion = `text-v2-lf-${sourceSha256}`;
  const analysisVersion = 'analysis-1';
  const reviewRecordId = 'review-1';
  const row = {
    sourceId,
    title: '雨停以后',
    sourceSha256,
    textVersion,
    encoding,
    indexIntegrity: {sourceTextSha256: normalizedTextSha256},
    analysis: {
      version: analysisVersion,
      textVersion,
      reviewStatus: 'checked',
      validation: {semanticReview: {approved: true, recordId: reviewRecordId, sourceId, textVersion, analysisVersion}},
      units: [{
        id: 'u1',
        title: '主动结束关系',
        event: '她在雨停后签下离婚协议。',
        psychology: '人物以归还钥匙和独自签字完成决断；这只描述文本呈现。',
        emotion: '克制后的决绝。',
        expression: '用连续动作替代解释。',
        readerEffectHypothesis: '可能让读者感到关系已经不可逆地结束。',
        locator: {lineStart: 1, lineEnd: 3},
        evidence: [{quote: '雨停后，她独自签下离婚协议。', lineStart: 2, lineEnd: 2}],
        relatedUnitIds: [],
      }],
    },
  };
  await mkdir(join(libraryRoot, 'objects'), {recursive: true});
  await mkdir(join(sidecarRoot, 'sidecars', sourceId), {recursive: true});
  await mkdir(join(sidecarRoot, 'archive', 'cards'), {recursive: true});
  await mkdir(join(sidecarRoot, 'archive', 'audits'), {recursive: true});
  await writeJson(join(libraryRoot, 'catalog.json'), {version: 1, sources: [row], requests: []});
  await writeFile(join(libraryRoot, 'objects', `${sourceSha256}.bin`), sourceBytes);
  await writeFile(join(libraryRoot, 'objects', `${sourceSha256}.lf-v2.txt`), text);

  const cue = '雨停后，她独自签下离婚协议。';
  const charStart = text.indexOf(cue);
  const charEnd = charStart + cue.length;
  const card = {
    schema_version: '2.0',
    story_id: storyId,
    source_sha256: sourceSha256,
    ...Object.fromEntries(legacyObservationFields.map(field => [field, `雨停后，人物主动签字结束关系（${field}）。`])),
    field_confidence: Object.fromEntries(legacyObservationFields.map(field => [field, 'high'])),
    boundary_origin: Object.fromEntries(legacyObservationFields.map(field => [field, 'analyst_simulated'])),
    evidence: [{
      evidence_id: 'E01',
      supports: [...legacyObservationFields],
      locator: {line_start: 2, line_end: 2, char_start: charStart, char_end: charEnd},
      cue,
      support_type: 'direct',
      inference: '动作发生于正文。',
    }],
  };
  const cardBytes = Buffer.from(`${JSON.stringify(card, null, 2)}\n`);
  const cardSha256 = sha(cardBytes);
  const audit = {
    story_id: storyId,
    card: {sha256: cardSha256},
    source: {sha256: sourceSha256},
    automated_checks: {status: 'pass'},
    independent_reviews: {FS: {verdict: 'PASS'}, CC: {verdict: 'PASS'}},
    aggregate: {status: 'ACCEPTED', decision: 'accepted'},
  };
  const auditBytes = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`);
  const auditSha256 = sha(auditBytes);
  await writeFile(join(sidecarRoot, 'archive', 'cards', `${storyId}.json`), cardBytes);
  await writeFile(join(sidecarRoot, 'archive', 'audits', `${storyId}.json`), auditBytes);

  const verificationSha = damageEvidence ? '0'.repeat(64) : sha(cue);
  const sidecar = {
    schemaVersion: 'narrative-observation-sidecar-v2',
    sourceBinding: {sourceId, sourceSha256, textVersion, normalizedTextSha256, currentAnalysisVersionAtGeneration: analysisVersion, currentReviewRecordIdAtGeneration: reviewRecordId},
    cardBinding: {
      storyId,
      title: '雨停以后',
      archivedCardPath: `archive/cards/${storyId}.json`,
      cardSha256,
      cardSourceSha256: sourceSha256,
      acceptedStatus: 'accepted',
      auditMatchesCurrentRevision: true,
      archivedAuditPath: `archive/audits/${storyId}.json`,
      auditSha256,
      cardSchemaVersion: '2.0',
    },
    supplyPolicy: {automaticSupply: false, retrievalIntegrated: false, grantsCheckedAnalysisStatus: false, unverifiedEvidenceSupplyAllowed: false},
    observations: legacyObservationFields.map(field => ({
      field,
      value: `雨停后，人物主动签字结束关系（${field}）。`,
      classification: 'observable_narrative_choice',
      authorIntentClaimed: false,
      originalFieldConfidence: 'high',
      boundaryOrigin: 'analyst_simulated',
      evidenceIds: ['E01'],
      evidenceVerificationStatus: 'verified',
      supplyEligibility: 'eligible_only_after_explicit_retrieval_integration_and_scope_registration',
    })),
    cardEvidence: [{
      evidenceId: 'E01',
      supports: [...legacyObservationFields],
      locator: {line_start: 2, line_end: 2, char_start: charStart, char_end: charEnd},
      cue,
      supportType: 'direct',
      inference: '动作发生于正文。',
      verification: {
        status: 'verified',
        textVersion,
        lineWindowUtf16Start: charStart,
        lineWindowUtf16End: charEnd,
        lineWindowBodySha256: verificationSha,
        charWindowUtf16Start: charStart,
        charWindowUtf16End: charEnd,
        charWindowBodySha256: sha(cue),
        intersectionUtf16Start: charStart,
        intersectionUtf16End: charEnd,
        intersectionBodySha256: sha(cue),
        matchedCueUtf16Start: charStart,
        matchedCueUtf16End: charEnd,
      },
    }],
  };
  const sidecarPath = join(sidecarRoot, 'sidecars', sourceId, `${storyId}.json`);
  await writeJson(sidecarPath, sidecar);
  return {libraryRoot, sidecarRoot, sidecarPath, sourceId, sourceSha256, normalizedTextSha256, textVersion};
}

const request = extra => ({
  contractVersion: NARRATIVE_OBSERVATION_QUERY_VERSION,
  query: '主动签字结束关系',
  ...extra,
});

test('returns explicitly queried legacy observation with exact source, archive, quote, and authority boundaries', async () => {
  const roots = await fixture();
  const service = await createNarrativeObservationService(roots);
  const result = await service.query(request({fields: ['midpoint_engine']}));
  assert.equal(result.status, 'covered');
  assert.equal(result.explicitOnly, true);
  assert.equal(result.creativeSupply, false);
  assert.deepEqual(result.scope, {kind: 'strict_bound_sidecar_sources', sourceCount: 1, catalogSourceCount: 1});
  assert.equal(result.results.length, 1);
  const observation = result.results[0];
  assert.equal(observation.recordType, 'legacy_card_observation');
  assert.equal(observation.source.sourceId, roots.sourceId);
  assert.equal(observation.quotes[0].quote, '雨停后，她独自签下离婚协议。');
  assert.equal(observation.quotes[0].matchedCueUtf16Start, 11);
  assert.equal(observation.legacyAnalysisIdentity.acceptedAtArchive, true);
  assert.equal(observation.currentReviewState.bindingValid, true);
  assert.equal(observation.authority.grantsNewCheckedAnalysisStatus, false);
  assert.equal(observation.authority.automaticCreativeSupply, false);
  assert.equal(Object.hasOwn(result, 'materials'), false);
});

test('returns only existing checked analysis identity for psychology and emotion', async () => {
  const roots = await fixture();
  const service = await createNarrativeObservationService(roots);
  const result = await service.query(request({fields: ['psychology', 'emotion']}));
  assert.equal(result.status, 'covered');
  assert.equal(result.results.length, 1);
  const unit = result.results[0];
  assert.equal(unit.recordType, 'checked_analysis_unit');
  assert.deepEqual(Object.keys(unit.values), ['psychology', 'emotion']);
  assert.equal(unit.currentReviewState.reviewRecordId, 'review-1');
  assert.equal(unit.authority.inheritsExistingCheckedAnalysisState, true);
  assert.equal(unit.authority.grantsNewCheckedAnalysisStatus, false);
});

test('uses the library LF-v2 decoder contract for CRLF UTF-8 and BOM UTF-16LE sources', async t => {
  for (const sourceFormat of ['utf8-crlf', 'utf16le-crlf']) await t.test(sourceFormat, async () => {
    const roots = await fixture({sourceFormat});
    assert.notEqual(roots.sourceSha256, roots.normalizedTextSha256);
    const service = await createNarrativeObservationService(roots);
    const result = await service.query(request({fields: ['midpoint_engine']}));
    assert.equal(result.status, 'covered');
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].quotes[0].matchedCueUtf16Start, 11);
  });
});

test('irrelevant query is uncovered and supplies nothing', async () => {
  const roots = await fixture();
  const service = await createNarrativeObservationService(roots);
  const result = await service.query(request({query: '宇宙飞船发动机', fields: ['midpoint_engine', 'emotion']}));
  assert.equal(result.status, 'uncovered');
  assert.deepEqual(result.results, []);
  assert.equal(result.counts.withheldCount, 0);
});

test('changed evidence digest is withheld instead of supplied', async () => {
  const roots = await fixture({damageEvidence: true});
  const service = await createNarrativeObservationService(roots);
  const result = await service.query(request({fields: ['midpoint_engine']}));
  assert.equal(result.status, 'uncovered');
  assert.deepEqual(result.results, []);
  assert.equal(result.withheld.length, 1);
  assert.equal(result.withheld[0].reason, 'line_window_changed');
});

test('sidecar projection changes cannot masquerade as the hashed archived card', async t => {
  const cases = [
    {
      name: 'observation value rewrite',
      mutate: sidecar => { sidecar.observations[0].value += '此结论为检查时新增，不在归档原卡中。'; },
      reason: 'card_observation_projection_mismatch',
    },
    {
      name: 'evidence supports rewrite',
      mutate: sidecar => { sidecar.cardEvidence[0].supports = ['intro_contract']; },
      reason: 'card_evidence_projection_mismatch',
    },
    {
      name: 'evidence id rebound',
      mutate: sidecar => { sidecar.cardEvidence[0].evidenceId = 'E99'; sidecar.observations[0].evidenceIds = ['E99']; },
      reason: 'card_evidence_projection_mismatch',
    },
  ];
  for (const item of cases) await t.test(item.name, async () => {
    const roots = await fixture();
    const sidecar = JSON.parse(await readFile(roots.sidecarPath, 'utf8'));
    item.mutate(sidecar);
    await writeJson(roots.sidecarPath, sidecar);
    const service = await createNarrativeObservationService(roots);
    const result = await service.query(request({fields: ['midpoint_engine']}));
    assert.equal(result.status, 'uncovered');
    assert.deepEqual(result.results, []);
    assert.equal(result.withheld[0].reason, item.reason);
  });
});

test('legacy acceptance cannot promote an unchecked current analysis', async () => {
  const roots = await fixture();
  const catalogPath = join(roots.libraryRoot, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.sources[0].analysis.reviewStatus = 'pending';
  await writeJson(catalogPath, catalog);
  const service = await createNarrativeObservationService(roots);
  const current = await service.query(request({fields: ['psychology', 'emotion']}));
  assert.equal(current.status, 'uncovered');
  assert.deepEqual(current.results, []);
  assert.equal(current.withheld[0].reason, 'current_analysis_not_checked_and_bound');
  const legacy = await service.query(request({fields: ['midpoint_engine']}));
  assert.equal(legacy.results.length, 1);
  assert.equal(legacy.results[0].currentReviewState.bindingValid, false);
  assert.equal(legacy.results[0].authority.grantsNewCheckedAnalysisStatus, false);
});

test('an open service rejects a changed catalog instead of returning stale checked state', async () => {
  const roots = await fixture();
  const service = await createNarrativeObservationService(roots);
  const first = await service.query(request({fields: ['psychology', 'emotion']}));
  assert.equal(first.results[0].currentReviewState.bindingValid, true);
  assert.equal(first.snapshot.catalogSha256, service.snapshot.catalogSha256);
  const catalogPath = join(roots.libraryRoot, 'catalog.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.sources[0].analysis.reviewStatus = 'pending';
  await writeJson(catalogPath, catalog);
  await assert.rejects(
    service.query(request({fields: ['psychology', 'emotion']})),
    error => error.code === 'NARRATIVE_OBSERVATION_SNAPSHOT_STALE'
      && error.snapshot.catalogSha256 === service.snapshot.catalogSha256
      && error.changedFiles.includes('catalog.json'),
  );
});

test('contract rejects unknown fields and never mutates the sidecar', async () => {
  const roots = await fixture();
  const sidecarPath = join(roots.sidecarRoot, 'sidecars', roots.sourceId, 'story-1.json');
  const before = sha(await readFile(sidecarPath));
  const service = await createNarrativeObservationService(roots);
  await assert.rejects(service.query(request({fields: ['author_intent']})), /Invalid narrative observation fields/);
  assert.equal(sha(await readFile(sidecarPath)), before);
});

const materialFor = (roots, lineStart = 2, lineEnd = 2, overrides = {}) => {
  const content = '【原文参考；不作为已发布分析】\n雨停后，她独自签下离婚协议。';
  return {
    id: 'selected-window', title: '本次已选原文窗', kind: 'retrieved', use: 'raw_reference', content, sha256: sha(content),
    references: [{sourceId: roots.sourceId, sourceSha256: roots.sourceSha256, textVersion: roots.textVersion,
      analysisVersion: 'analysis-1', lineStart, lineEnd, unitIds: []}], selectionReason: '当前问题相关', limitations: ['局部窗口'], ...overrides,
  };
};

test('projects a bounded legacy observation only onto the selected source and complete evidence window', async () => {
  const roots = await fixture();
  const service = await createNarrativeObservationService(roots);
  const original = materialFor(roots);
  const projected = await service.projectMaterials({query: '主动签字结束关系', materials: [original]});
  assert.equal(projected.summary.status, 'attached');
  assert.equal(projected.summary.attachedItemCount, 1);
  const material = projected.materials[0];
  assert.equal(material.id, original.id); assert.equal(material.content, original.content); assert.equal(material.sha256, original.sha256);
  assert.deepEqual(material.references, original.references);
  assert.equal(material.narrativeObservations.contractVersion, MATERIAL_NARRATIVE_OBSERVATION_VERSION);
  assert.equal(material.narrativeObservations.items.length, 1);
  const observation = material.narrativeObservations.items[0];
  assert.equal(observation.analysisStatus.kind, 'archived_ai_narrative_observation');
  assert.equal(observation.analysisStatus.grantsCurrentCheckedAnalysisStatus, false);
  assert.equal(observation.source.sourceSha256, roots.sourceSha256);
  assert.equal(observation.source.normalizedTextSha256, roots.normalizedTextSha256);
  assert.equal(observation.evidence[0].quote, '雨停后，她独自签下离婚协议。');
  assert.deepEqual(observation.evidence[0].lineWindow.slice(0, 2), [11, 25]);
  assert.deepEqual(observation.evidence[0].charWindow.slice(0, 2), [11, 25]);
  assert.deepEqual(observation.evidence[0].intersection.slice(0, 2), [11, 25]);
  assert.deepEqual(observation.evidence[0].matched, [11, 25]);
  assert.equal(observation.materialBinding.materialId, original.id);
  assert.deepEqual(observation.materialBinding.referenceIndexes, [0]);
  assert.equal(observation.materialBinding.allEvidenceInsideSelectedWindows, true);
  assert.equal(validateMaterialNarrativeObservations(material), material);
  assert(projected.summary.usedChars <= projected.summary.budget.maxChars);
});

test('reports selected sources outside sidecar scope separately from window and budget exclusions', async () => {
  const roots = await fixture(); const service = await createNarrativeObservationService(roots);
  const material = materialFor(roots, 2, 2, {references: [{...materialFor(roots).references[0], sourceId: 'source-without-sidecar'}]});
  const projected = await service.projectMaterials({query: '主动签字结束关系', materials: [material]});
  assert.deepEqual(projected.summary.sourceCoverage, {coveredSourceCount: 0, uncoveredSourceCount: 1,
    uncoveredSourceIds: ['source-without-sidecar']});
  assert.equal(projected.summary.reason, 'selected_sources_outside_observation_scope');
  assert.deepEqual(projected.summary.skipped, {outsideSelectedWindows: 0, perMaterialBudget: 0, totalItemBudget: 0, totalCharBudget: 0});
});

test('many relevant legacy observations stay bounded instead of entering the material wholesale', async () => {
  const roots = await fixture({legacyObservationFields: ['intro_contract', 'chapter_1_change', 'chapter_2_change', 'chapter_3_change',
    'chapter_4_paywall', 'first_paid_payoff', 'midpoint_engine', 'ending_mechanism', 'prose_traits']});
  const service = await createNarrativeObservationService(roots);
  const projected = await service.projectMaterials({query: '主动签字结束关系', materials: [materialFor(roots)]});
  assert.equal(projected.summary.candidateCount, 9);
  assert(projected.summary.attachedItemCount > 0);
  assert(projected.summary.attachedItemCount <= projected.summary.budget.maxPerMaterial);
  assert(projected.summary.attachedItemCount < projected.summary.candidateCount);
  assert(projected.summary.usedChars <= projected.summary.budget.maxChars);
});

test('window mismatch, source binding mismatch, irrelevant question and zero budget preserve the original material', async t => {
  const roots = await fixture(); const service = await createNarrativeObservationService(roots);
  const cases = [
    ['evidence outside selected window', {query: '主动签字结束关系', materials: [materialFor(roots, 1, 1)]}],
    ['wrong source hash', {query: '主动签字结束关系', materials: [materialFor(roots, 2, 2, {references: [{...materialFor(roots).references[0], sourceSha256: '0'.repeat(64)}]})]}],
    ['irrelevant question', {query: '宇宙飞船发动机', materials: [materialFor(roots)]}],
    ['zero budget', {query: '主动签字结束关系', materials: [materialFor(roots)], budget: {maxItems: 0, maxChars: 0, maxPerMaterial: 0}}],
  ];
  for (const [name, input] of cases) await t.test(name, async () => {
    const before = structuredClone(input.materials); const result = await service.projectMaterials(input);
    assert.deepEqual(result.materials, before); assert.equal(result.summary.attachedItemCount, 0);
  });
});

test('projection metadata cannot escape its material window or silently change accounting', async () => {
  const roots = await fixture(); const service = await createNarrativeObservationService(roots);
  const projected = await service.projectMaterials({query: '主动签字结束关系', materials: [materialFor(roots)]});
  const escaped = structuredClone(projected.materials[0]); escaped.narrativeObservations.items[0].evidence[0].lineEnd = 3;
  assert.throws(() => validateMaterialNarrativeObservations(escaped), /Invalid|escaped|changed/);
  const relabeled = structuredClone(projected.materials[0]); relabeled.narrativeObservations.items[0].analysisStatus.kind = 'current_checked_analysis';
  assert.throws(() => validateMaterialNarrativeObservations(relabeled), /Invalid/);
  const shiftedMatch = structuredClone(projected.materials[0]);
  shiftedMatch.narrativeObservations.items[0].evidence[0].matched = [12, 26];
  assert.throws(() => validateMaterialNarrativeObservations(resignProjection(shiftedMatch)), /escaped/);
  const narrowedWindow = structuredClone(projected.materials[0]);
  narrowedWindow.narrativeObservations.items[0].evidence[0].lineWindow[0] = 12;
  assert.throws(() => validateMaterialNarrativeObservations(resignProjection(narrowedWindow)), /escaped/);
});

test('material projection refuses an open-service stale snapshot', async () => {
  const roots = await fixture(); const service = await createNarrativeObservationService(roots);
  const catalogPath = join(roots.libraryRoot, 'catalog.json'); const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  catalog.sources[0].title = '改变后的标题'; await writeJson(catalogPath, catalog);
  await assert.rejects(service.projectMaterials({query: '主动签字结束关系', materials: [materialFor(roots)]}),
    error => error.code === 'NARRATIVE_OBSERVATION_SNAPSHOT_STALE');
});
