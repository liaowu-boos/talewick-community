import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createNarrativeObservationService} from '../runtime/narrative-observations.mjs';
import {buildNarrativeEvidenceWindows, createNarrativeObservationBatchDriver, installNarrativeObservationPackage,
  publishNarrativeObservationBatch, recoverNarrativeObservationAnalysisFromFailedAttempt,
  resolveActiveNarrativeObservationPackage} from '../runtime/narrative-observation-batch.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
const validAnalysis = input => ({schemaVersion: 'whole-revision-narrative-analysis-v2', sourceId: input.sourceId,
  sourceSha256: input.sourceSha256, textVersion: input.textVersion, visibleTextScope: input.declaredCompleteness,
  limitations: ['只观察当前提供文本；外部母本与后续结局未观察。'],
  observations: ['intro_contract', 'chapter_1_change', 'midpoint_engine', 'prose_traits'].map((field, index) => ({
    observationId: `O${index + 1}`, field, windowId: input.evidenceWindows[index].windowId, summary: `转折观察${index + 1}`,
    psychologyChange: '人物从沉默转为开口；其他内心未观察。', emotionOrganization: '动作前后形成克制到释放的次序。',
    expressionEffect: '短句与动作相邻，使变化点可定位。', readerEffectHypothesis: '这种并置可能提示读者注意状态变化，未经真人阅读验证。',
    applicabilityBoundary: '只适用于当前动作和台词相邻的片段。', counterEvidence: '片段没有说明变化持续到后文。',
    visibilityBoundary: '只据所选窗口；外部原作完整度未知，不否认可见收束。'}))});
const validReview = input => ({schemaVersion: 'whole-revision-narrative-review-v2', sourceId: input.sourceId,
  analysisSha256: input.analysisSha256, approved: true, notes: ['逐条核对当前可见文本和证据，未验证文学质量。'],
  decisions: input.analysis.observations.map(item => ({observationId: item.observationId, windowIdUsed: item.windowId, status: 'accepted',
    evidenceSufficiency: 'sufficient', unboundEvidenceUsed: false, evidenceIndexesUsed: [0], missingSupport: [],
    notes: '只按绑定 evidence[0] 核对，事实、限定和逐字证据一致。'}))});
// Synthetic boundary and scope cases; no captured analysis or private text.
const scopeSynonymFixture = {
  visibilityBoundaries: [
    '仅据该窗口；外部完整度未知，不否认可见收束。',
    '仅据该窗口；外部完整度未知，不否认其他收束。',
    '仅据该窗口；外部完整度未知，不否认可见结果。',
    '仅据该窗口；外部完整度未知，不否认可见收束。',
  ],
  originalBookBoundary: '只据本窗口；外部原书完整度未知，不否认可见收束。',
  negativeControl: '仅据该窗口；外部完整度未知，可见收束不存在。',
};
const syntheticBoundaryFixture = {
  contexts: ['借伞', '归还', '等候', '离开'].map((name, index) => {
    const left = '甲'.repeat(140) + '。';
    const eventStart = `第${index + 1}个人准备${name}。`;
    const eventEnd = `随后他完成了${name}。`;
    const right = '乙'.repeat(140) + '。';
    const sourceText = [left, eventStart, eventEnd, right].join('\n\n');
    const auditQuote = [eventStart, eventEnd].join('\n\n');
    return {name, sourceText, auditQuote, auditQuoteUtf16Length: auditQuote.length,
      auditQuoteSha256: sha(auditQuote), originalPrimaryWindows: [
        [left, eventStart, eventEnd].join('\n\n'), right,
      ].map(quote => ({quote, bodySha256: sha(quote)}))};
  }),
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'narrative-batch-'));
  const libraryRoot = join(root, 'library'), objects = join(libraryRoot, 'objects');
  await mkdir(objects, {recursive: true});
  const sources = [], rows = [];
  for (let index = 0; index < 20; index++) {
    const sourceId = `source-${String(index + 1).padStart(2, '0')}`;
    const body = [`标题${index + 1}`, ...Array.from({length: 24}, (_, eventIndex) =>
      `人物在第${eventIndex + 1}个局部事件中完成可见动作。`)].join('\n\n');
    const sourceSha256 = sha(body), textVersion = `text-v2-lf-${sourceSha256}`;
    await writeFile(join(objects, `${sourceSha256}.bin`), body);
    await writeFile(join(objects, `${sourceSha256}.lf-v2.txt`), body);
    sources.push({ordinal: index + 1, sourceId, title: `标题${index + 1}`, sourceSha256, textVersion,
      selectionReason: '基于可见文本的结构差异抽样，不声明质量结论。'});
    rows.push({sourceId, title: `标题${index + 1}`, sourceSha256, textVersion, encoding: 'utf-8', completeness: 'unknown',
      indexIntegrity: {sourceTextSha256: sha(body)}, analysis: {version: `analysis-${index}`, textVersion, reviewStatus: 'checked',
        validation: {semanticReview: {approved: true, recordId: `review-${index}`, sourceId, textVersion, analysisVersion: `analysis-${index}`}}, units: []}});
  }
  const catalogPath = join(libraryRoot, 'catalog.json');
  await save(catalogPath, {version: 'test', sources: rows, requests: {}});
  const selection = {schemaVersion: 'whole-revision-narrative-selection-v1',
    activeBinding: {catalogPath, catalogSha256: sha(await readFile(catalogPath))},
    excludedExistingSourceIds: ['old-source'], sources};
  const basePackageRoot = join(root, 'base');
  await mkdir(join(basePackageRoot, 'sidecars'), {recursive: true});
  await mkdir(join(basePackageRoot, 'archive', 'cards'), {recursive: true});
  await mkdir(join(basePackageRoot, 'archive', 'audits'), {recursive: true});
  await save(join(basePackageRoot, 'package-manifest.json'), {schemaVersion: 'legacy-sidecars-r02-package-manifest-v1', root: basePackageRoot,
    entries: [], entryCount: 0, orderedEntryDigest: sha('')});
  return {root, libraryRoot, selection, basePackageRoot};
}

test('batch preserves raw calls, resumes completed sources, publishes and activates a queryable package', async () => {
  const f = await fixture(), runRoot = join(f.root, 'run'), calls = [];
  const model = {async complete(request) {
    calls.push(request);
    const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') {
      return JSON.stringify(validAnalysis(input));
    }
    return JSON.stringify(validReview(input));
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const first = await driver.run();
  assert.equal(first.logicalModelAttempts, 40);
  assert.equal(first.maxLogicalModelAttempts, 80);
  assert.equal(first.outcomes.filter(item => item.status === 'completed').length, 20);
  assert.equal(calls.length, 40);
  const analysisCall = calls.find(item => item.stage === 'narrative-observation-analysis');
  const reviewCall = calls.find(item => item.stage === 'narrative-observation-review');
  const analysisContract = JSON.parse(analysisCall.user).outputContract;
  const reviewUser = JSON.parse(reviewCall.user);
  const reviewContract = reviewUser.outputContract;
  assert.equal(analysisContract.evidenceWindowContract.selectionKey, 'windowId');
  assert.equal(analysisContract.evidenceWindowContract.modelMayWriteQuote, false);
  assert.equal(analysisContract.evidenceWindowContract.maxSupplementalWindows, 240);
  assert.equal(analysisContract.evidenceWindowContract.maxSupplementalQuoteUtf16Chars, 43200);
  assert.equal(analysisContract.requiredVisibleTextScope, 'unknown');
  assert.match(analysisCall.system, /本窗口未观察到人物心理变化/);
  assert.equal(reviewContract.decisionRequired.includes('notes'), true);
  assert.equal(reviewContract.reviewerContextPolicy, 'quote_only_no_full_lines');
  assert.equal(Object.hasOwn(reviewUser, 'lines'), false);
  assert.match(reviewCall.system, /不得要求它为填满字段生造结论/);
  const raw = await readFile(join(runRoot, 'sources', f.selection.sources[0].sourceId, 'status.json'), 'utf8');
  const status = JSON.parse(raw);
  const validated = JSON.parse(await readFile(join(runRoot, status.analysisPath), 'utf8'));
  assert.equal(validated.observations[0].evidence[0].windowId, validated.observations[0].windowId);
  assert.equal(validated.observations[0].evidence[0].quote, JSON.parse(calls[0].user).evidenceWindows[0].quote);
  assert.equal(validated.observations[0].projectionPreflight.chargedChars <= 2400, true);
  const second = await driver.run();
  assert.equal(second.outcomes.filter(item => item.status === 'skipped_completed').length, 20);
  assert.equal(calls.length, 40);
  const superseded = await driver.run({sourceIds: [f.selection.sources[0].sourceId], supersedeCompleted: [{
    sourceId: f.selection.sources[0].sourceId, reason: 'independent pilot audit failed strict evidence policy',
    feedback: ['核心推理只能使用 observation 已绑定 evidence。', '单条真实投影必须不超过 2400 字符。'],
  }]});
  assert.equal(superseded.outcomes[0].status, 'completed');
  assert.equal(calls.length, 42);
  const supersededStatus = JSON.parse(await readFile(join(runRoot, 'sources', f.selection.sources[0].sourceId, 'status.json')));
  assert.equal(supersededStatus.supersedesAttemptId, status.attemptId);
  const supersedeRequest = JSON.parse(await readFile(join(runRoot, 'sources', f.selection.sources[0].sourceId,
    'attempts', supersededStatus.attemptId, 'analysis.request.json'), 'utf8'));
  assert.equal(JSON.parse(supersedeRequest.user).retryFeedback.kind, 'completed_attempt_supersede');

  const outputRoot = join(f.root, 'combined');
  const publication = await publishNarrativeObservationBatch({libraryRoot: f.libraryRoot, basePackageRoot: f.basePackageRoot,
    runRoot, outputRoot, selection: f.selection});
  assert.equal(publication.publishedSourceCount, 20);
  assert.equal(publication.publishedObservationCount, 80);
  await assert.rejects(() => publishNarrativeObservationBatch({libraryRoot: f.libraryRoot, basePackageRoot: f.basePackageRoot,
    runRoot, outputRoot, selection: f.selection}), {code: 'PUBLISH_EXISTS'});

  const service = await createNarrativeObservationService({libraryRoot: f.libraryRoot, sidecarRoot: outputRoot});
  const result = await service.query({contractVersion: 'narrative-observation-query-1', query: '转折', fields: ['intro_contract'],
    sourceIds: [f.selection.sources[0].sourceId], maxResults: 10});
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].authority.readerEffectsAreHypotheses, undefined);
  assert.equal(result.results[0].value.readerEffectHypothesis.includes('未经真人阅读验证'), true);
  const projected = await service.projectMaterials({query: '转折', materials: [{id: 'material-1', references: [{
    sourceId: f.selection.sources[0].sourceId, sourceSha256: f.selection.sources[0].sourceSha256,
    textVersion: f.selection.sources[0].textVersion, lineStart: validated.observations[0].evidence[0].lineStart,
    lineEnd: validated.observations[0].evidence[0].lineEnd}]}]});
  assert.equal(projected.summary.attachedItemCount >= 1, true);
  assert.equal(projected.summary.usedChars <= 2400, true);
  assert.equal(projected.materials[0].narrativeObservations.items[0].value.summary.includes('转折观察'), true);

  const installed = await installNarrativeObservationPackage({libraryRoot: f.libraryRoot, publishedPackageRoot: outputRoot, expectedSourceCount: 20});
  const active = await resolveActiveNarrativeObservationPackage({libraryRoot: f.libraryRoot, expectedSourceCount: 20});
  assert.equal(active.packageRoot, installed.packageRoot);
  assert.equal(active.pointer.sourceCount, 20);
});

test('one format correction per stage is journaled as logical attempts and keeps every raw response', async () => {
  const f = await fixture(), runRoot = join(f.root, 'correction-run'), source = f.selection.sources[0];
  const model = {async complete(request) {
    const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') return '{}';
    if (request.stage === 'narrative-observation-analysis-format-correction') {
      return JSON.stringify(validAnalysis(input.originalRequest.user));
    }
    if (request.stage === 'narrative-observation-review') return '{';
    return JSON.stringify(validReview(input.originalRequest.user));
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model, maxLogicalModelAttempts: 80});
  const result = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(result.logicalModelAttempts, 4);
  assert.equal(result.outcomes[0].status, 'completed');
  const status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  const attempt = join(runRoot, 'sources', source.sourceId, 'attempts', status.attemptId);
  assert.equal(await readFile(join(attempt, 'analysis.response.raw.txt'), 'utf8'), '{}');
  assert.equal(await readFile(join(attempt, 'review.response.raw.txt'), 'utf8'), '{');
  assert.match(await readFile(join(attempt, 'analysis.correction.response.raw.txt'), 'utf8'), /"observations"/);
});

test('retry after review transport failure reuses validated analysis and only repeats review', async () => {
  const f = await fixture(), runRoot = join(f.root, 'reuse-run'), source = f.selection.sources[0];
  let failReview = true;
  const stages = [];
  const model = {async complete(request) {
    stages.push(request.stage); const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') return JSON.stringify(validAnalysis(input));
    if (failReview) throw new Error('temporary transport failure');
    return JSON.stringify(validReview(input));
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const first = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(first.outcomes[0].status, 'failed');
  let status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  assert.equal(status.analysisReusable, true);
  failReview = false;
  const second = await driver.run({retryFailed: true, sourceIds: [source.sourceId]});
  assert.equal(second.outcomes[0].status, 'completed');
  assert.deepEqual(stages, ['narrative-observation-analysis', 'narrative-observation-review', 'narrative-observation-review']);
  status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  assert.equal(status.status, 'completed');
});

test('substantive review rejection is preserved and explicit retry creates a new analysis', async () => {
  const f = await fixture(), runRoot = join(f.root, 'rejected-run'), source = f.selection.sources[0];
  let reject = true; const stages = [];
  const model = {async complete(request) {
    stages.push(request.stage); const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') return JSON.stringify(validAnalysis(input));
    const review = validReview(input);
    if (reject) { review.approved = false; review.decisions[0] = {...review.decisions[0], status: 'rejected',
      evidenceSufficiency: 'insufficient', missingSupport: ['缺少心理转折前状态的绑定引文。'], notes: '心理推断超出当前绑定证据。'}; }
    return JSON.stringify(review);
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  await driver.run({sourceIds: [source.sourceId]});
  let status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  assert.equal(status.code, 'BATCH_REVIEW_REJECTED');
  assert.equal(status.analysisReusable, false);
  reject = false;
  const retried = await driver.run({retryFailed: true, sourceIds: [source.sourceId]});
  assert.equal(retried.outcomes[0].status, 'completed');
  assert.deepEqual(stages, ['narrative-observation-analysis', 'narrative-observation-review',
    'narrative-observation-analysis', 'narrative-observation-review']);
  const completed = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  const retryRequest = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'attempts', completed.attemptId, 'analysis.request.json'), 'utf8'));
  const feedback = JSON.parse(retryRequest.user).retryFeedback;
  assert.equal(feedback.kind, 'failed_attempt_retry');
  assert.equal(feedback.review.decisions[0].missingSupport[0], '缺少心理转折前状态的绑定引文。');
});

test('accepted review decision cannot claim unbound evidence', async () => {
  const f = await fixture(), runRoot = join(f.root, 'accepted-unbound-run'), source = f.selection.sources[0];
  const model = {async complete(request) {
    const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') return JSON.stringify(validAnalysis(input));
    const review = validReview(input);
    review.decisions[0].unboundEvidenceUsed = true;
    return JSON.stringify(review);
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const result = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(result.outcomes[0].code, 'REVIEW_EVIDENCE_SCOPE');
  const status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  assert.equal(status.status, 'failed');
  assert.equal(status.analysisReusable, true);
  assert.equal(status.reviewPath, undefined);
});

test('rejected review decision may record unbound evidence without becoming approved', async () => {
  const f = await fixture(), runRoot = join(f.root, 'rejected-unbound-run'), source = f.selection.sources[0];
  const model = {async complete(request) {
    const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') return JSON.stringify(validAnalysis(input));
    const review = validReview(input);
    review.approved = false;
    review.decisions[0] = {...review.decisions[0], status: 'rejected', evidenceSufficiency: 'insufficient',
      unboundEvidenceUsed: true, missingSupport: ['候选使用了绑定窗口外的背景信息。'], notes: '越界依据只作为拒绝诊断。'};
    return JSON.stringify(review);
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const result = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(result.outcomes[0].code, 'BATCH_REVIEW_REJECTED');
  const status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  assert.equal(status.analysisReusable, false);
  const saved = JSON.parse(await readFile(join(runRoot, status.reviewPath), 'utf8'));
  assert.equal(saved.approved, false);
  assert.equal(saved.decisions[0].status, 'rejected');
  assert.equal(saved.decisions[0].unboundEvidenceUsed, true);
});

test('format correction cannot delete observations to satisfy the count or budget', async () => {
  const f = await fixture(), runRoot = join(f.root, 'correction-semantics-run'), source = f.selection.sources[0];
  const sourceText = await readFile(join(f.libraryRoot, 'objects', `${source.sourceSha256}.lf-v2.txt`), 'utf8');
  const input = {sourceId: source.sourceId, sourceSha256: source.sourceSha256, textVersion: source.textVersion,
    declaredCompleteness: 'unknown', evidenceWindows: buildNarrativeEvidenceWindows(sourceText)};
  const original = validAnalysis(input), template = original.observations[0];
  for (const [index, field] of ['chapter_2_change', 'chapter_3_change', 'ending_mechanism'].entries()) {
    original.observations.push({...structuredClone(template), observationId: `OX${index + 1}`, field});
  }
  const corrected = structuredClone(original); corrected.observations.pop();
  const model = {async complete(request) { return JSON.stringify(request.stage.endsWith('format-correction') ? corrected : original); }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const result = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(result.outcomes[0].code, 'ANALYSIS_CORRECTION_SEMANTICS');
  const status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  assert.equal(status.code, 'ANALYSIS_CORRECTION_SEMANTICS');
});

test('host windows are stable exact source slices and never end on a half sentence', () => {
  const sourceText = ['开头给出旧约定。', '「明天集合时，请把展板，', '带到展厅，按号排列。」', '随后他停在台阶前。',
    '因为房门开了。', ...Array.from({length: 24}, (_, index) => `第${index + 1}个相邻局部动作已经结束。`),
    '（完）', '【站点提取水印，不是叙事正文】'].join('\n\n');
  const first = buildNarrativeEvidenceWindows(sourceText), second = buildNarrativeEvidenceWindows(sourceText);
  assert.deepEqual(second, first);
  assert.equal(first.length >= 4, true);
  for (const window of first) {
    assert.equal(window.quote, sourceText.slice(window.utf16Start, window.utf16End));
    assert.equal(window.quote.length <= 180, true);
    assert.match(window.quote.trim(), /(?:[。！？!?]|\.{2,}|…{1,2}|[」』）》】])$/u);
    assert.equal(window.bodySha256, sha(window.quote));
  }
  const supplemental = first.filter(window => window.windowId.startsWith('X'));
  assert.equal(supplemental.length <= 240, true);
  assert.equal(supplemental.reduce((total, window) => total + window.quote.length, 0) <= 43200, true);
  assert.equal(first.some(window => window.quote.includes('随后他停在台阶前。')), true);
  assert.equal(first.some(window => window.quote.includes('「明天集合时，请把展板，\n\n带到展厅，按号排列。」')), true);
  assert.equal(first.some(window => window.quote.includes('站点提取水印')), false);
  const withoutTerminator = buildNarrativeEvidenceWindows('正文中的局部事件已经结束。\n【本文由栀言站点提取：https://example.invalid】');
  assert.equal(withoutTerminator.length, 1);
  assert.equal(withoutTerminator[0].quote, '正文中的局部事件已经结束。');
});

test('supplemental boundary windows preserve primary quotes and cover synthetic local events', () => {
  for (const context of syntheticBoundaryFixture.contexts) {
    const windows = buildNarrativeEvidenceWindows(context.sourceText);
    const primary = windows.filter(window => window.windowId.startsWith('W'));
    const supplemental = windows.filter(window => window.windowId.startsWith('X'));
    assert.deepEqual(primary.map(window => ({quote: window.quote, bodySha256: window.bodySha256})),
      context.originalPrimaryWindows.map(window => ({quote: window.quote, bodySha256: window.bodySha256})), context.name);
    assert.equal(sha(context.auditQuote), context.auditQuoteSha256, context.name);
    assert.equal(context.auditQuote.length, context.auditQuoteUtf16Length, context.name);
    const bridge = supplemental.find(window => window.quote.includes(context.auditQuote));
    assert.ok(bridge, `${context.name} must be fully contained in one supplemental window`);
    assert.equal(bridge.quote.length <= 180, true, context.name);
    assert.equal(bridge.quote, context.sourceText.slice(bridge.utf16Start, bridge.utf16End), context.name);
    assert.equal(bridge.bodySha256, sha(bridge.quote), context.name);
  }
});

test('legacy model-written quotes cannot enter the v2 window-bound analysis contract', async () => {
  const f = await fixture(), runRoot = join(f.root, 'legacy-quote-run'), source = f.selection.sources[0], calls = [];
  const model = {async complete(request) {
    calls.push(request.stage);
    const input = JSON.parse(request.user), analysis = validAnalysis(input);
    for (const observation of analysis.observations) {
      delete observation.windowId;
      observation.evidence = [{quote: observation.observationId === 'O01' ? '「他站在门口等候。」' : '人物在转折处开口。'}];
    }
    return JSON.stringify(analysis);
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const result = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(result.outcomes[0].code, 'ANALYSIS_WINDOW_BINDING');
  assert.deepEqual(calls, ['narrative-observation-analysis']);
});

test('independent review rejects whole-story claims that exceed the selected local window', async () => {
  const f = await fixture(), runRoot = join(f.root, 'window-overreach-run'), source = f.selection.sources[0];
  const model = {async complete(request) {
    const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') {
      const analysis = validAnalysis(input);
      analysis.observations[0].summary = '用开头一句概括多年搬家、升学选择和最终团聚。';
      return JSON.stringify(analysis);
    }
    const review = validReview(input);
    review.approved = false;
    review.decisions[0] = {...review.decisions[0], status: 'rejected', evidenceSufficiency: 'insufficient',
      missingSupport: ['所选局部窗口没有多年搬家、升学选择或团聚。'], notes: '核心概述跨出windowIdUsed绑定范围。'};
    return JSON.stringify(review);
  }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const result = await driver.run({sourceIds: [source.sourceId]});
  assert.equal(result.outcomes[0].code, 'BATCH_REVIEW_REJECTED');
  const status = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json')));
  const review = JSON.parse(await readFile(join(runRoot, status.reviewPath), 'utf8'));
  assert.equal(review.decisions[0].windowIdUsed, JSON.parse(await readFile(join(runRoot, status.analysisPath), 'utf8')).observations[0].windowId);
});

test('natural-language scope wording including 外部原书 reaches review while visible-ending denial stays rejected', async () => {
  const f = await fixture(), source = f.selection.sources[0];
  const acceptedRun = join(f.root, 'scope-synonym-accepted'), acceptedStages = [];
  const acceptedModel = {async complete(request) {
    acceptedStages.push(request.stage); const input = JSON.parse(request.user);
    if (request.stage === 'narrative-observation-analysis') {
      const analysis = validAnalysis(input);
      analysis.observations.forEach((item, index) => { item.visibilityBoundary = scopeSynonymFixture.visibilityBoundaries[index]; });
      analysis.observations.at(-1).visibilityBoundary = scopeSynonymFixture.originalBookBoundary;
      return JSON.stringify(analysis);
    }
    return JSON.stringify(validReview(input));
  }};
  const acceptedDriver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot: acceptedRun,
    selection: f.selection, model: acceptedModel});
  const accepted = await acceptedDriver.run({sourceIds: [source.sourceId]});
  assert.equal(accepted.outcomes[0].status, 'completed');
  assert.deepEqual(acceptedStages, ['narrative-observation-analysis', 'narrative-observation-review']);

  const deniedRun = join(f.root, 'scope-synonym-denied');
  const deniedModel = {async complete(request) {
    const input = JSON.parse(request.user), analysis = validAnalysis(input.originalRequest?.user ?? input);
    analysis.observations.forEach(item => { item.visibilityBoundary = scopeSynonymFixture.negativeControl; });
    return JSON.stringify(analysis);
  }};
  const deniedDriver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot: deniedRun,
    selection: f.selection, model: deniedModel});
  const denied = await deniedDriver.run({sourceIds: [source.sourceId]});
  assert.equal(denied.outcomes[0].code, 'ANALYSIS_SCOPE');
});

test('failed analysis raw recovery consumes zero attempts and the normal retry calls review only', async () => {
  const f = await fixture(), runRoot = join(f.root, 'raw-recovery-run'), source = f.selection.sources[0];
  const sourceText = await readFile(join(f.libraryRoot, 'objects', `${source.sourceSha256}.lf-v2.txt`), 'utf8');
  const evidenceWindows = buildNarrativeEvidenceWindows(sourceText);
  const input = {sourceId: source.sourceId, sourceSha256: source.sourceSha256, textVersion: source.textVersion,
    declaredCompleteness: 'unknown', evidenceWindows};
  const analysis = validAnalysis(input);
  analysis.observations.forEach((item, index) => { item.visibilityBoundary = scopeSynonymFixture.visibilityBoundaries[index]; });
  const oldAttemptId = 'synthetic-scope-failure', attemptRoot = join(runRoot, 'sources', source.sourceId, 'attempts', oldAttemptId);
  await mkdir(attemptRoot, {recursive: true});
  await save(join(runRoot, 'selection-manifest.json'), f.selection);
  await save(join(runRoot, 'logical-model-attempt-budget.json'), {schemaVersion: 'narrative-observation-logical-attempt-budget-v1',
    maxLogicalModelAttempts: 80, usedLogicalModelAttempts: 30,
    attempts: Array.from({length: 30}, (_, index) => ({ordinal: index + 1, stage: 'historical'}))});
  await save(join(attemptRoot, 'analysis.request.json'), {stage: 'narrative-observation-analysis', user: JSON.stringify({
    sourceId: source.sourceId, outputContract: {exactExample: {schemaVersion: 'whole-revision-narrative-analysis-v2'},
      evidenceWindowContract: {selectionKey: 'windowId'}}})});
  const raw = `${JSON.stringify(analysis)}\n`;
  await writeFile(join(attemptRoot, 'analysis.response.raw.txt'), raw);
  await save(join(runRoot, 'sources', source.sourceId, 'status.json'), {schemaVersion: 'whole-revision-narrative-batch-run-v1',
    sourceId: source.sourceId, status: 'failed', attemptId: oldAttemptId, phase: 'analysis', code: 'ANALYSIS_SCOPE',
    message: 'Partial or unknown inputs must explicitly bound unobserved endings'});
  const recovered = await recoverNarrativeObservationAnalysisFromFailedAttempt({libraryRoot: f.libraryRoot, runRoot,
    selection: f.selection, sourceId: source.sourceId});
  assert.equal(recovered.status, 'recovered_for_review');
  assert.equal(recovered.logicalModelAttemptsConsumed, 0);
  assert.equal(await readFile(join(attemptRoot, 'analysis.response.raw.txt'), 'utf8'), raw);
  const afterRecoveryBudget = JSON.parse(await readFile(join(runRoot, 'logical-model-attempt-budget.json'), 'utf8'));
  assert.equal(afterRecoveryBudget.usedLogicalModelAttempts, 30);
  const pending = JSON.parse(await readFile(join(runRoot, 'sources', source.sourceId, 'status.json'), 'utf8'));
  assert.equal(pending.code, 'BATCH_REVIEW_PENDING');
  assert.equal(pending.recoveredFromAttemptId, oldAttemptId);
  const stages = [];
  const model = {async complete(request) { stages.push(request.stage); return JSON.stringify(validReview(JSON.parse(request.user))); }};
  const driver = createNarrativeObservationBatchDriver({libraryRoot: f.libraryRoot, runRoot, selection: f.selection, model});
  const reviewed = await driver.run({retryFailed: true, sourceIds: [source.sourceId]});
  assert.equal(reviewed.outcomes[0].status, 'completed');
  assert.equal(reviewed.logicalModelAttempts, 31);
  assert.deepEqual(stages, ['narrative-observation-review']);
});
