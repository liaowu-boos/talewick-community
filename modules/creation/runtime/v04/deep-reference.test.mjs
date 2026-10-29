import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateRetrieval } from './knowledge.mjs';
import { DEEP_REFERENCE_QUERY_VERSION, resolveDeepReferenceLayer, queryDeepReferences as queryInstalledDeepReferences } from '../../../data/runtime/deep-reference-layer.mjs';
import { validateWholeQualityRetrievalPacket } from '../../../data/runtime/whole-quality-retrieval.mjs';
import { DEEP_REFERENCE_DECISION_POLICY, normalizePsychology } from './psychology.mjs';
import { MATERIAL_USE_EVIDENCE_POLICY } from './material-use-evidence.mjs';
import { runWorkflow } from '../workflow.mjs';
import { resolveDeepReferenceCallback, createDeepReferenceRetrievalAdapter, createFinalTextEvidenceInput, buildCreateFinalTextEvidence,
  emptyCreateFinalTextEvidence, buildCreateDeepReferenceBundle, buildWholeQualityDeepReferenceBundle } from './deep-reference.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const sourceSha = sha('frozen source bytes');
const candidateSha = sha('candidate');
const packetSha = sha('packet');
const reportSha = sha('review');
const quote = '她看到票根后，没有立刻原谅，只把旧约定重新抄了一遍。';
const afterQuote = '抄完以后，她仍把空白留给对方自己说明。';
const referenceId = `deepref:source-1:${candidateSha.slice(0,16)}:${reportSha.slice(0,16)}`;

function dataResponse(request, results = [dataResult()]) {
  const normalizedRequest = { problem: { ...structuredClone(request.problem),
      searchTerms: [...new Set((request.problem.searchTerms ?? []).map(term => String(term).trim()).filter(Boolean))],
      requiredTermGroups: (request.problem.requiredTermGroups ?? []).map(group => [...new Set(group)]) },
    dimensions: structuredClone(request.dimensions), sourceIds: request.sourceIds ?? null, limit: request.limit,
    maxFunctionsPerResult: request.maxFunctionsPerResult, maxEvidenceRefsPerResult: request.maxEvidenceRefsPerResult };
  const installId = 'combined-99-v1-test';
  const queryId = `deepref-query-${sha(`${JSON.stringify({ installId, request: normalizedRequest }, null, 2)}\n`)}`;
  return { schemaVersion: DEEP_REFERENCE_QUERY_VERSION, queryId,
    installId, request: normalizedRequest, status: results.length ? 'covered' : 'uncovered', resultCount: results.length,
    limits: { maxResults: 8 }, boundary: 'retrieval is not use', retrievalIsUse: false,
    requiresExplicitAdoption: true, results };
}

function dataResult() {
  return { referenceId, source: { sourceId: 'source-1', sourceSha256: sourceSha, sourceTextSha256: sha('text'),
      textVersion: 'text-v1', title: '证据源' },
    analysis: { analysisId: 'analysis-1', analysisVersion: 'deep-v1', candidateSha256: candidateSha,
      packetSha256: packetSha, candidateStatus: 'candidate_unreviewed', approved: false, checked: false, active: false },
    semanticReview: { reportPath: 'reviews/source-1.json', reportSha256: reportSha, verdict: 'retain_with_caveats',
      caveats: ['只是一项证据约束假说'], blockingDefects: [], approvalGranted: false, activeProductionChanged: false },
    match: { matchedTerms: ['选择','代价'], matchedTermCount: 2, requiredMatchedTermCount: 2, lexicalScore: 2,
      semanticSimilarityClaimed: false },
    borrowableWritingFunctions: [{ functionId: 'psychology:before:after', dimension: 'psychologicalChangeDrivers',
      status: 'evidence_bound_hypothesis', observablePattern: '看见物证后先做有限行动',
      borrowableFunction: '用有限选择而不是彻底改口表现心理变化', alternatives: ['也可能只是暂缓冲突'],
      limitation: '不能证明原谅', evidenceIds: ['ev-1','ev-2'], unitIds: ['unit-1','unit-2'] }],
    exactReferences: [{ evidenceId: 'ev-1', unitId: 'unit-1', locator: { lineStart: 7, lineEnd: 7, charStart: 10, charEnd: 38 },
      quoteSha256: sha(quote), textVersion: 'text-v1', quote, sourceId: 'source-1', sourceSha256: sourceSha,
      sourceTextSha256: sha('text') }, { evidenceId: 'ev-2', unitId: 'unit-2', locator: { lineStart: 9, lineEnd: 9, charStart: 40, charEnd: 61 },
      quoteSha256: sha(afterQuote), textVersion: 'text-v1', quote: afterQuote, sourceId: 'source-1', sourceSha256: sourceSha,
      sourceTextSha256: sha('text') }],
    limits: { visibility: '只见当前证据窗', statements: ['不可迁入人物与情节'] }, retrievalIsUse: false,
    requiresExplicitAdoption: true };
}

const productionQuery = { contractVersion: 'v04-contract-1', evidenceType: 'narrative',
  query: '人物在新证据出现后怎样通过选择与代价改变旧理解，同时保留未解决关系？', stage: 'planning',
  context: JSON.stringify({ targetUse: { requirements: { genre: '现实家庭', pointOfView: '第一人称限知', prohibitions: ['不能一次坦白消除旧账'] } } }),
  recall: { focus: 'scene', queries: ['新证据改变选择','保留关系分歧'] }, budget: { maxCandidates: 20, maxUnits: 6, maxChars: 12000 } };

const creativeUse = { functionalChoice: '以有限行动承载认知变化', intendedChapter: '第1章核对票根场景',
  psychologicalChange: '从确信被遗忘转为承认旧判断有缺口', characterChoice: '重新抄写约定但不承诺原谅',
  consequence: '她承担继续核对关系旧账的麻烦', caveat: '不迁入来源人物、情节或和解方向' };

const analysisRoot = new URL('../../../../../', import.meta.url);

test('DATA problem callback is converted to the exact production packet and keeps the complete response', async () => {
  let captured;
  const adapter = createDeepReferenceRetrievalAdapter(async request => { captured = structuredClone(request); return dataResponse(request); }, { path: 'create' });
  const packet = await adapter(productionQuery);
  assert.equal(captured.problem.statement, productionQuery.query);
  assert.equal(captured.problem.context.path, 'create');
  assert.deepEqual(captured.problem.requiredTermGroups, []);
  assert.ok(captured.problem.searchTerms.includes('选择'));
  assert.deepEqual(captured.dimensions, ['emotionalProgression','psychologicalChangeDrivers']);
  assert.equal(captured.maxFunctionsPerResult, 2);
  assert.equal(captured.maxEvidenceRefsPerResult, 6);
  assert.equal(packet.status, 'matched');
  assert.equal(packet.materials.length, 1);
  assert.equal(packet.materials[0].id, referenceId);
  assert.equal(packet.materials[0].sha256, sha(packet.materials[0].content));
  assert.equal(packet.materials[0].references.length, 2);
  assert.equal(packet.deepReference.response.schemaVersion, DEEP_REFERENCE_QUERY_VERSION);
  assert.deepEqual(validateRetrieval(packet, productionQuery), packet);
  assert.deepEqual(validateWholeQualityRetrievalPacket(packet, productionQuery), packet);
});


test('an unavailable DATA callback is visible and never becomes uncovered', async () => {
  const adapter = createDeepReferenceRetrievalAdapter(async () => { throw new Error('offline'); }, { path: 'whole_manuscript_quality' });
  const packet = await adapter({ ...productionQuery, stage: 'revision' });
  assert.equal(packet.status, 'unavailable');
  assert.equal(packet.deepReference.response, null);
  assert.match(packet.limits[0], /失败不表示/);
  assert.deepEqual(validateRetrieval(packet, { ...productionQuery, stage: 'revision' }), packet);
});

test('optional known DATA matchingPolicy is retained exactly and unknown metadata fails closed', async () => {
  const policy = request => ({ version: 'analysis99-positive-function-fields-1',
    positiveFields: ['observablePattern','borrowableFunction'],
    excludedFields: ['alternatives','limitation','uncertainty','counterEvidenceOrGap','identifiers','context','reviewCaveats'],
    ignoredSearchTerms: [], effectiveSearchTerms: request.problem.searchTerms,
    effectiveRequiredTermGroups: request.problem.requiredTermGroups, candidatePoolCount: 99, positiveCandidateCount: 1,
    noResultReason: null, boundary: 'Positive lexical support only; not semantic suitability.' });
  const explicit = { problemId: 'known-metadata', statement: '选择与代价', searchTerms: ['选择','代价'], requiredTermGroups: [['选择']], context: {} };
  let supplied;
  const response = request => { supplied = { ...dataResponse(request), matchingPolicy: policy(request) }; return supplied; };
  const valid = await createDeepReferenceRetrievalAdapter(async request => response(request), { problem: explicit })(productionQuery);
  assert.equal(valid.status, 'matched'); assert.deepEqual(valid.deepReference.response, supplied);
  for (const mutate of [r => { r.unknownTopLevel = true; }, r => { r.matchingPolicy.unknown = true; },
    r => { r.matchingPolicy.version = 'future-policy'; }, r => { r.matchingPolicy.positiveFields.push('limitation'); },
    r => { r.matchingPolicy.effectiveSearchTerms = ['unbound']; }, r => { r.matchingPolicy.noResultReason = 'no_eligible_positive_function_bundle'; },
    r => { r.matchingPolicy.candidatePoolCount = 0; }]) {
    const invalid = await createDeepReferenceRetrievalAdapter(async request => { const r = response(request); mutate(r); return r; }, { problem: explicit })(productionQuery);
    assert.equal(invalid.status, 'unavailable'); assert.equal(invalid.deepReference.response, null);
  }
});

test('goal-only budget projection retains complete functions and before/after refs, without changing the raw DATA response', async () => {
  const result = dataResult();
  for (let i = 3; i <= 7; i++) result.exactReferences.push({ ...result.exactReferences[0], evidenceId: `ev-${i}`, unitId: `unit-${i}` });
  result.borrowableWritingFunctions.push({ ...result.borrowableWritingFunctions[0], functionId: 'oversized-addition',
    evidenceIds: ['ev-3','ev-4','ev-5','ev-6','ev-7'], unitIds: ['unit-3','unit-4','unit-5','unit-6','unit-7'] });
  let raw;
  const packet = await createDeepReferenceRetrievalAdapter(async request => { raw = dataResponse(request, [result]); return raw; },
    { path: 'whole_manuscript_writing_goal', maxFunctionsPerResult: 3, maxEvidenceRefsPerResult: 10 })(productionQuery);
  assert.equal(packet.status, 'matched'); assert.equal(packet.materials.length, 1);
  assert.deepEqual(packet.deepReference.response, raw);
  const choice = packet.deepReference.functionSelection.selections[0];
  assert.deepEqual(choice.selectedFunctionIds, ['psychology:before:after']);
  assert.deepEqual(choice.budgetExcludedFunctionIds, ['oversized-addition']);
  assert.equal(packet.materials[0].references.length, 2);
  assert(packet.materials[0].content.includes(quote)); assert(packet.materials[0].content.includes(afterQuote));
  assert(!packet.materials[0].content.includes('oversized-addition'));
  const legacy = await createDeepReferenceRetrievalAdapter(async request => dataResponse(request, [result]))(productionQuery);
  assert.equal(legacy.materials.length, 0); assert.equal(Object.hasOwn(legacy.deepReference, 'functionSelection'), false);
});

test('new create writing goals fail explicitly before any model stage instead of being silently ignored', async () => {
  let calls = 0;
  await assert.rejects(runWorkflow({ request: { kind: 'create', idea: '一个故事', writingGoals: { schemaVersion: 'creation-writing-goals-1', goals: [] } },
    model: { complete: async () => { calls++; throw Error('must not run'); } } }), { code: 'WRITING_GOALS_MODE_REQUIRED' });
  assert.equal(calls, 0);
});

test('mutated DATA request, install binding or selected source SHA fails closed as unavailable', async () => {
  const mutations = [
    response => { response.request.limit = 1; },
    response => { response.installId = 'forged-install'; },
    response => { response.results[0].source.sourceSha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const adapter = createDeepReferenceRetrievalAdapter(async request => { const response = dataResponse(request); mutate(response); return response; }, { path: 'create' });
    const packet = await adapter(productionQuery);
    assert.equal(packet.status, 'unavailable');
    assert.equal(packet.materials.length, 0);
    assert.equal(packet.deepReference.response, null);
  }
  const unavailableDeep = createDeepReferenceRetrievalAdapter(async request => { const response = dataResponse(request);
    response.results[0].source.sourceSha256 = '0'.repeat(64); return response; }, { path: 'create' });
  const uncoveredLegacy = async query => ({ contractVersion: 'v04-contract-1', packetId: 'legacy-empty', query,
    status: 'uncovered', materials: [], candidates: [], usedChars: 0, limits: ['既有136本题未命中'] });
  const composed = await resolveDeepReferenceCallback(unavailableDeep, uncoveredLegacy)(productionQuery);
  assert.equal(composed.deepReference.composition.deepStatus, 'unavailable');
  assert.equal(composed.deepReference.composition.legacyStatus, 'uncovered');
  assert.equal(composed.status, 'unavailable');
  assert.deepEqual(validateRetrieval(composed, productionQuery), composed);
});

test('deep references compose with existing 136 retrieval under one budget and retain exact DATA metadata', async () => {
  const deep = createDeepReferenceRetrievalAdapter(async request => dataResponse(request), { path: 'create' });
  const legacyContent = '既有136材料：人物在核对后保留分歧。';
  const legacyMaterial = { id: 'legacy-136-1', title: '既有材料', kind: 'retrieved', use: 'raw_reference',
    content: legacyContent, sha256: sha(legacyContent), references: [{ sourceId: 'legacy-source', sourceSha256: sha('legacy-source'),
      textVersion: 'legacy-text-v1', analysisVersion: 'legacy-analysis-v1', unitIds: [], lineStart: 3, lineEnd: 3 }],
    selectionReason: '既有136有界命中', limitations: ['仍须判断适用性'] };
  let legacyCalls = 0;
  const legacy = async query => { legacyCalls += 1; return { contractVersion: 'v04-contract-1', packetId: 'legacy-packet', query,
    status: 'matched', materials: [legacyMaterial], candidates: [{ id: 'legacy-candidate', sourceId: 'legacy-source', reason: '既有136候选' }],
    usedChars: legacyContent.length, limits: ['既有136命中不等于采用'] }; };
  const composed = await resolveDeepReferenceCallback(deep, legacy)(productionQuery);
  assert.equal(legacyCalls, 1);
  assert.deepEqual(composed.materials.map(item => item.id), ['legacy-136-1', referenceId]);
  assert.deepEqual(composed.deepReference.composition.selectedLegacyMaterialIds, ['legacy-136-1']);
  assert.deepEqual(composed.deepReference.composition.selectedDeepMaterialIds, [referenceId]);
  assert.equal(composed.deepReference.response.schemaVersion, DEEP_REFERENCE_QUERY_VERSION);
  assert.deepEqual(validateRetrieval(composed, productionQuery), composed);
  assert.deepEqual(validateWholeQualityRetrievalPacket(composed, productionQuery), composed);
});

test('create decisions require function, chapter, psychological change, choice, consequence and caveat', async () => {
  const adapter = createDeepReferenceRetrievalAdapter(async request => dataResponse(request), { path: 'create' });
  const packet = await adapter(productionQuery), material = packet.materials[0];
  const chapters = [{ id: 'ch-1', scenes: ['核对票根'] }];
  const base = { characterArcs: [{ character: '她', experience: '看到票根', belief: '自己被遗忘', desire: '核对旧约', fear: '再次被敷衍', change: '承认判断有缺口', expression: '重新抄写约定' }],
    emotionalScenes: [{ experience: '核对', cognition: '旧判断有缺口', action: '抄写', expression: '动作', development: '展开', echo: '保留未决' }],
    choiceCausality: [{ id: 'choice-1', chapterNumber: 1, character: '她', pressure: '要真相又怕被敷衍', choice: '抄写但不原谅', immediateConsequence: '继续承担核对', carryForward: '关系未决', unresolvedBoundary: '是否原谅未定' }], psychologyLimitations: ['关系仍未决'] };
  const decision = { materialId: referenceId, decision: 'adopt', reason: '适合有限改口', limitations: ['不迁入来源关系'],
    mechanism: '证据触发有限行动', sourceQuotes: [quote], target: { chapterNumber: 1, sceneNumber: 1 }, creativeUse };
  const normalized = normalizePsychology({ ...base, materialDecisions: [decision] }, chapters,
    { materialEvidencePolicyVersion: MATERIAL_USE_EVIDENCE_POLICY, deepReferencePolicyVersion: DEEP_REFERENCE_DECISION_POLICY,
      materialSources: [material] });
  assert.deepEqual(normalized.materialDecisions[0].creativeUse, creativeUse);
  assert.throws(() => normalizePsychology({ ...base, materialDecisions: [{ ...decision, creativeUse: { ...creativeUse, consequence: '' } }] }, chapters,
    { materialEvidencePolicyVersion: MATERIAL_USE_EVIDENCE_POLICY, deepReferencePolicyVersion: DEEP_REFERENCE_DECISION_POLICY,
      materialSources: [material] }), /creativeUse\.consequence/);
});

test('all cross-genre candidates may be declined and remain visible as unused', async () => {
  const adapter = createDeepReferenceRetrievalAdapter(async request => dataResponse(request), { path: 'create' });
  const packet = await adapter(productionQuery), material = packet.materials[0];
  const chapters = [{ id: 'ch-1', title: '合照', scenes: ['整理家庭合照'], body: '她把合照放回原处，没有替任何人补写解释。' }];
  const declineCreativeUse = {
    functionalChoice: '未采用：来源机制依赖本篇没有的戏剧性背叛与复仇',
    intendedChapter: '未采用，不指定章节', psychologicalChange: '未采用，不主张心理变化',
    characterChoice: '未采用，不主张人物选择', consequence: '未采用，不主张正文后果',
    caveat: '冻结家庭简报禁止迁入背叛、疾病、复仇、来源人物关系与事件链',
  };
  const normalized = normalizePsychology({
    characterArcs: [{ character: '她', experience: '整理合照', belief: '家人各自保留解释', desire: '保留事实边界', fear: '替别人强行和解', change: '承认未决也可持续', expression: '把合照放回原处' }],
    emotionalScenes: [{ experience: '整理合照', cognition: '她不知道照片外的全部原因', action: '放回原处', expression: '动作与留白', development: '保留歧义', echo: '关系仍未决' }],
    choiceCausality: [{ id: 'choice-1', chapterNumber: 1, character: '她', pressure: '想说明又缺少证据', choice: '不补写解释', immediateConsequence: '合照保留原样', carryForward: '家人仍可各自说明', unresolvedBoundary: '旧事原因未知' }],
    materialDecisions: [{ materialId: referenceId, decision: 'decline', reason: '跨题材结果的核心功能依赖被冻结简报禁止的背叛与复仇，不能仅为展示99而采用', limitations: ['可迁移的尊重选择过于宽泛，不足以授权引用该情节机制'], creativeUse: declineCreativeUse }],
    psychologyLimitations: ['没有材料被采用；正文沿用冻结简报与原创场景因果'],
  }, chapters, { materialEvidencePolicyVersion: MATERIAL_USE_EVIDENCE_POLICY,
    deepReferencePolicyVersion: DEEP_REFERENCE_DECISION_POLICY, materialSources: [material] });
  const finalTextEvidence = emptyCreateFinalTextEvidence({ chapters, materialDecisions: normalized.materialDecisions });
  const bundle = buildCreateDeepReferenceBundle({ retrieval: packet, materials: [material],
    materialDecisions: normalized.materialDecisions, finalTextEvidence, chapters });
  assert.deepEqual(bundle.unusedMaterialIds, [referenceId]);
  assert.deepEqual(bundle.notProvenMaterialIds, []);
  assert.deepEqual(bundle.exactTextLocatedMaterialIds, []);
  assert.equal(bundle.candidates[0].resolution, 'reject');
  assert.equal(bundle.candidates[0].status, 'unused');
  assert.equal(bundle.candidates[0].manuscriptEvidence.length, 0);
  assert.match(bundle.candidates[0].caveat, /背叛、疾病、复仇/);
});

test('exact final text spans and not-proven adoption are kept separate from planning intent', async () => {
  const adapter = createDeepReferenceRetrievalAdapter(async request => dataResponse(request), { path: 'create' });
  const packet = await adapter(productionQuery), material = packet.materials[0];
  const body = `夜里，她又核了一遍。${quote}门外仍有人等。`, start = body.indexOf(quote);
  const chapters = [{ id: 'ch-1', title: '核对', body }];
  const decision = { materialId: referenceId, decision: 'adopt', reason: '适合有限行动', limitations: ['不证明效果'],
    mechanism: '证据触发有限行动', sourceQuotes: [quote], target: { chapterNumber: 1, sceneNumber: 1 },
    sourceMaterialSha256: material.sha256, creativeUse, status: 'author_declared_not_text_verified' };
  const input = createFinalTextEvidenceInput({ chapters, materialDecisions: [decision], materials: [material] });
  const located = buildCreateFinalTextEvidence({ claims: [{ materialId: referenceId, status: 'located',
    manuscriptEvidence: [{ chapterId: 'ch-1', start, quote, purpose: '有限行动逐字落点' }], limitations: ['逐字存在不证明文学改善'] }] }, input, [decision]);
  assert.equal(located.items[0].verificationStatus, 'literal_text_located_not_literary_effect_verified');
  const notProven = buildCreateFinalTextEvidence({ claims: [{ materialId: referenceId, status: 'not_proven', manuscriptEvidence: [],
    reason: '候选正文没有唯一且准确的功能落点', limitations: ['保留作者曾声明采用的事实'] }] }, input, [decision]);
  assert.equal(notProven.items[0].verificationStatus, 'not_proven');
  const deep = buildCreateDeepReferenceBundle({ retrieval: packet, materials: [material], materialDecisions: [decision], finalTextEvidence: notProven, chapters });
  assert.deepEqual(deep.notProvenMaterialIds, [referenceId]);
  assert.equal(deep.candidates[0].manuscriptEvidence.length, 0);
});

test('create evidence resolves unique multiline quotes after surrogate pairs and fails closed on ambiguity or changed text', async () => {
  const adapter = createDeepReferenceRetrievalAdapter(async request => dataResponse(request), { path: 'create' });
  const packet = await adapter(productionQuery), material = packet.materials[0];
  const exactQuote = '她把票根翻到背面。\n又把日期逐字抄下。';
  const decision = { materialId: referenceId, decision: 'adopt', reason: '测试唯一逐字落点', limitations: ['只核对文字'],
    mechanism: '以动作承担核对', sourceQuotes: [quote], target: { chapterNumber: 1, sceneNumber: 1 },
    sourceMaterialSha256: material.sha256, creativeUse, status: 'author_declared_not_text_verified' };
  const chapters = [{ id: 'ch-1', title: '核对', body: `😀先停了一会儿。\n${exactQuote}\n关系仍未决。` }];
  const input = createFinalTextEvidenceInput({ chapters, materialDecisions: [decision], materials: [material] });
  assert.equal(input.responseContract.claim.manuscriptEvidence[1], 'start:null');
  const located = buildCreateFinalTextEvidence({ claims: [{ materialId: referenceId, status: 'located',
    manuscriptEvidence: [{ chapterId: 'ch-1', start: null, quote: exactQuote, purpose: '跨行有限行动' }],
    limitations: ['逐字存在不证明效果'] }] }, input, [decision]);
  assert.equal(located.items[0].manuscriptEvidence[0].start, chapters[0].body.indexOf(exactQuote));
  assert.equal(located.items[0].manuscriptEvidence[0].quote, exactQuote);

  const repeatedChapters = [{ id: 'ch-1', title: '核对', body: `${exactQuote}\n---\n${exactQuote}` }];
  const repeatedInput = createFinalTextEvidenceInput({ chapters: repeatedChapters, materialDecisions: [decision], materials: [material] });
  const ambiguous = buildCreateFinalTextEvidence({ claims: [{ materialId: referenceId, status: 'located',
    manuscriptEvidence: [{ chapterId: 'ch-1', start: null, quote: exactQuote, purpose: '重复引文' }],
    limitations: ['重复时不猜位置'] }] }, repeatedInput, [decision]);
  assert.equal(ambiguous.items[0].verificationStatus, 'not_proven');
  assert.match(ambiguous.items[0].reason, /出现 2 次/);

  const changed = buildCreateFinalTextEvidence({ claims: [{ materialId: referenceId, status: 'located',
    manuscriptEvidence: [{ chapterId: 'ch-1', start: null, quote: `${exactQuote}改`, purpose: '被改写的引文' }],
    limitations: ['不做模糊匹配'] }] }, input, [decision]);
  assert.equal(changed.items[0].verificationStatus, 'not_proven');
  assert.match(changed.items[0].reason, /未在指定章节逐字出现/);
});

test('enhanced create path sends only bounded DATA references into the real planning input', async () => {
  const request = { kind: 'create', idea: '写她看到票根后重新理解旧约定的一章现实故事。' };
  const requirements = { status: 'ready', summary: request.idea, genre: '现实家庭', pointOfView: '第一人称限知', setting: '当代',
    targetHanMin: 1000, targetHanMax: 1200, targetChapterCount: 1, requiredElements: [], prohibitions: [], assumptions: [], usesChapter4Cut: false,
    completeEnding: true, referenceQuestion: productionQuery.query,
    referenceIntent: { purpose: 'expression', basis: ['/idea'], evidenceNeeds: ['新证据如何改变选择'], contextNeeds: ['保留未解决关系'] },
    retrievalHints: { focus: 'scene', queries: ['新证据改变选择','保留关系分歧'] } };
  const plan = { title: '票根', premise: '她核对票根', ending: '她抄写约定但不原谅', constraints: [],
    chapters: [{ title: '核对', goal: '核对并作出有限选择', scenes: ['核对票根'], continuity: '本章完成', targetHanMin: 1000, targetHan: 1100, targetHanMax: 1200 }],
    characterArcs: [{ character: '她', experience: '看到票根', belief: '自己被遗忘', desire: '核对旧约', fear: '再次被敷衍', change: '承认判断有缺口', expression: '重新抄写约定' }],
    emotionalScenes: [{ experience: '核对', cognition: '旧判断有缺口', action: '抄写', expression: '动作', development: '展开', echo: '保留未决' }],
    choiceCausality: [{ id: 'choice-1', chapterNumber: 1, character: '她', pressure: '要真相又怕被敷衍', choice: '抄写但不原谅', immediateConsequence: '继续承担核对', carryForward: '关系未决', unresolvedBoundary: '是否原谅未定' }],
    materialDecisions: [{ materialId: referenceId, decision: 'adopt', reason: '适合有限行动', limitations: ['不迁入来源关系'], mechanism: '证据触发有限行动', sourceQuotes: [quote], target: { chapterNumber: 1, sceneNumber: 1 }, creativeUse }], psychologyLimitations: ['关系仍未决'] };
  let planningInput, callbackRequest;
  const stop = new Error('draft reached');
  await assert.rejects(runWorkflow({ request, followupMode: 'fixed_materials',
    queryDeepReferences: async dataRequest => { callbackRequest = structuredClone(dataRequest); return dataResponse(dataRequest); },
    prepareKnowledge: async () => ({ schemaVersion: 2, packetId: 'empty', materials: [], style: null, limits: [] }),
    model: { complete: async input => {
      if (input.stage === 'requirements') return JSON.stringify(requirements);
      if (input.stage === 'planning') { planningInput = JSON.parse(input.user); return JSON.stringify(plan); }
      if (input.stage === 'draft:ch-1') throw stop;
      assert.fail(`unexpected stage ${input.stage}`);
    } } }), error => error === stop);
  assert.equal(callbackRequest.problem.statement, productionQuery.query);
  assert.deepEqual(planningInput.knowledge.materials.map(item => item.id), [referenceId]);
  assert.equal(planningInput.knowledge.materials[0].references[0].reviewRecordId, reportSha);
});

test('whole-quality product bundle retains unused and not-proven candidates with functional targets', () => {
  const supply = { supplyId: `issue-1:${referenceId}`, issueId: 'issue-1', materialId: referenceId, contentSha256: sha('material'), evidenceIds: ['ev-1'], reviewBoundary: 'reviewed hypothesis' };
  const retrieval = { byIssue: [{ issueId: 'issue-1', status: 'matched', result: { packet: { deepReference: { response: dataResponse({ problem: { problemId: 'p', statement: 's', searchTerms: ['选择','代价'], context: {} } }) } } } }], supplies: [supply] };
  const applicability = { assessments: [{ supplyId: supply.supplyId, fit: 'direct_fit' }] };
  const plan = { materialDecisions: [{ supplyId: supply.supplyId, materialId: supply.materialId, issueId: 'issue-1', decision: 'used', planItemIds: ['plan-1'], evidenceIds: ['ev-1'], reason: '用于有限选择', appliedAs: '现场触发改变选择', applicabilityBoundary: '不迁入情节', limitations: ['只是一项假说'] }],
    items: [{ id: 'plan-1', affectedChapterIds: ['ch-1'], expectedEffect: '心理变化有行动桥梁', actionRequirements: [{ description: '让她选择签下自己的责任', expectedVisibleChange: '她承担补录与关系代价' }] }] };
  const materialUse = { ledgers: [], unavailableIssueIds: [], notConnectedIssueIds: [] };
  const finalTextMaterialEvidence = { byIssue: [{ issueId: 'issue-1', records: [{ materialId: referenceId, status: 'not_located', findings: [], reason: '没有唯一落点' }] }] };
  const sourceChapters = [{ id: 'ch-1', title: '一', body: '原稿' }], candidateChapters = [{ id: 'ch-1', title: '一', body: '候选稿' }];
  const bundle = buildWholeQualityDeepReferenceBundle({ retrieval, applicability, plan, materialUse, finalTextMaterialEvidence, sourceChapters, candidateChapters });
  assert.deepEqual(bundle.notProvenMaterialIds, [referenceId]);
  assert.deepEqual(bundle.candidates[0].intendedChapters, ['ch-1']);
  assert.equal(bundle.candidates[0].characterChoice, '让她选择签下自己的责任');
  assert.equal(bundle.candidates[0].consequence, '她承担补录与关系代价');
  assert.equal(bundle.dataQueries[0].query.response.schemaVersion, DEEP_REFERENCE_QUERY_VERSION);
});
