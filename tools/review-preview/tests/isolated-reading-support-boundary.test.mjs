import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReadingPlan, validateResponse, inspectExecution, sha256} from '../../isolated-anchor-reading/review-tools.mjs';
import {adaptIsolatedReading} from '../src/isolated-reading.mjs';

// Independent synthetic texts and response builder; no provider calls or private fixtures.
function manuscriptsFor(chapterIds) {
  const make = version => chapterIds.map((id, i) => ({
    id, title: '合成章节 ' + (i + 1),
    body: version === 'A'
      ? '访客把印有甲稿独有编号 Q' + i + ' 的纸伞留在门廊。\n\n风吹过空院子。'
      : '访客把印有乙稿独有编号 Z' + i + ' 的纸伞带出了门廊。\n\n风吹过空院子。',
  }));
  return {A: make('A'), B: make('B')};
}
const dims = ['consequence_credibility', 'character_pressure', 'pacing', 'ending_force', 'causal_continuity'];

// Uses fixed documented response fields, our expected chapter list and source text.
// It never imports the package fixture or reads responseContract to invent an answer.
function responseFor(request, chapterIds) {
  const single = request.requestId !== 'C1';
  const versions = single ? ['X'] : ['A', 'B'];
  const evidence = request.packet.anchors.filter(a => a.field === 'body').map((a, i) => ({
    id: 'E' + (i + 1), version: a.version, chapterId: a.chapterId, anchorId: a.anchorId,
    supports: '合成原段中呈现纸伞或院子的动作与环境；不认证动机。',
  }));
  const refs = (version, chapterId) => evidence.filter(e => e.version === version &&
    (chapterId === undefined || e.chapterId === chapterId)).map(e => e.id);
  const all = versions.flatMap(v => refs(v));
  const assessment = evidenceIds => ({assessment: '此处只核对合成响应的记录结构。', evidenceIds});
  return {
    kind: single ? 'single_reading' : 'assisted_comparison',
    freeReading: '纸伞的去向发生变化，环境描写仍可分别阅读。',
    ...(!single ? {textIdentity: 'different'} : {}),
    overall: {...assessment(all), ...(!single ? {preference: 'no_clear_preference'} : {})},
    dimensions: dims.map(id => single
      ? {id, ...assessment(refs('X'))}
      : {id, A: assessment(refs('A')), B: assessment(refs('B')), comparison: '不从形式通过推断阅读优劣。'}),
    chapterReadings: versions.flatMap(version => chapterIds.map(chapterId => ({
      ...(!single ? {version} : {}), chapterId,
      observation: '此章有纸伞动作及院子环境。', evidenceIds: refs(version, chapterId),
    }))),
    ...(!single ? {changeReadings: request.packet.differences.map(d => ({
      differenceId: d.differenceId, description: '纸伞动作的文字不同。',
      effect: 'uncertain', assessment: '差别的文学意义不由测试决定。',
      counterReading: '环境相同也不证明两稿读感相同。',
      // Cite every available body anchor in this chapter. Missing/incorrect source
      // catalogs are detected independently before a positive validation is accepted.
      evidenceIds: versions.flatMap(v => refs(v, d.chapterId)),
    }))} : {}),
    factualChecks: (single ? ['X', 'X', 'X'] : ['A', 'B', 'both', 'both']).map((scope, i) => ({
      id: 'F' + (i + 1), ...(!single ? {scope} : {}),
      kind: 'observation', claim: '当前合成章节写到了纸伞或院子。',
      evidenceIds: scope === 'both' ? all : refs(scope),
      uncertainty: '不推断未呈现的事件或人物内心。',
    })),
    counterReading: assessment(all), evidence,
    scopeLimit: '仅限显式 chapterIds 所列章节，不代表全稿验收。',
  };
}

const chapterIds = ['arrival', 'middle', 'ending'];
const unsupportedClaim = '从第一章到末章，访客逐步原谅了所有人，末章公开道歉。';

function firstBodyEvidence(response, version) {
  return response.evidence.find(e => e.version === version && e.chapterId === chapterIds[0]).id;
}

function round(mutate = () => {}) {
  const plan = buildReadingPlan({manuscripts: manuscriptsFor(chapterIds), chapterIds});
  const entries = new Map();
  const put = (id, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    entries.set(id, {entry: {sha256: sha256(bytes)}, bytes});
  };
  const responses = {}, inspections = {};
  const executions = plan.requests.map(request => {
    const response = responseFor(request, chapterIds), single = request.packet.mode === 'single';
    const versions = single ? ['X'] : ['A', 'B'];
    response.overall.assessment = unsupportedClaim;
    response.overall.evidenceIds = versions.map(v => firstBodyEvidence(response, v));
    for (const dimension of response.dimensions) for (const version of versions) {
      const assessment = single ? dimension : dimension[version];
      assessment.assessment = unsupportedClaim;
      assessment.evidenceIds = [firstBodyEvidence(response, version)];
    }
    // Deliberately false prose: later chapters and their body anchors remain available.
    response.scopeLimit = '契约只允许引用各版本第一章的第一个正文锚点，后续章节没有可引用锚点。';
    mutate(response, request);
    responses[request.requestId] = response;
    const raw = JSON.stringify(response);
    const inspection = validateResponse({packet: request.packet, expectedPacketSHA256: request.packetSHA256, raw});
    inspections[request.requestId] = inspection;
    const receipt = {contextId: 'synthetic-context-' + request.requestId, invocationId: 'synthetic-call-' + request.requestId};
    for (const [suffix, value] of Object.entries({raw, inspection, receipt, messages: request.messages})) {
      put(request.requestId + '-' + suffix, value);
    }
    return {requestId: request.requestId, raw, messages: request.messages, receipt};
  });
  put('execution', inspectExecution({plan, executions}));
  const manifest = {planSHA256: plan.planSHA256, executionId: 'execution', requests: plan.requests.map(r => ({
    requestId: r.requestId, rawId: r.requestId + '-raw', inspectionId: r.requestId + '-inspection',
    receiptId: r.requestId + '-receipt', messagesId: r.requestId + '-messages',
  }))};
  const input = {plan, expectedPlanSHA256: plan.planSHA256, manifest,
    get: id => { assert(entries.has(id)); return entries.get(id); }, ref: id => ({id})};
  return {plan, responses, inspections, executions, manifest, put, view: () => adaptIsolatedReading(input)};
}

for (const requestId of ['S1', 'C1']) test(`${requestId}: complete chapter evidence with opening-only global claims stays semantic pending`, () => {
  const f = round(), response = f.responses[requestId], inspection = f.inspections[requestId];
  const single = requestId !== 'C1', versions = single ? ['X'] : ['A', 'B'];
  const packet = f.plan.requests.find(r => r.requestId === requestId).packet;
  assert.equal(response.chapterReadings.length, versions.length * chapterIds.length);
  for (const version of versions) for (const chapterId of chapterIds) {
    const reading = response.chapterReadings.find(c => c.chapterId === chapterId && (single || c.version === version));
    assert(reading.evidenceIds.length > 0);
    for (const id of reading.evidenceIds) {
      const evidence = response.evidence.find(e => e.id === id);
      const anchor = packet.anchors.find(a => a.anchorId === evidence.anchorId);
      assert.equal(anchor.version, version); assert.equal(anchor.chapterId, chapterId); assert.equal(anchor.field, 'body');
    }
  }
  assert.deepEqual(response.overall.evidenceIds, versions.map(v => firstBodyEvidence(response, v)));
  for (const dimension of response.dimensions) for (const version of versions) {
    assert.deepEqual((single ? dimension : dimension[version]).evidenceIds, [firstBodyEvidence(response, version)]);
  }
  // This is a known synthetic counterexample, not a semantic classification algorithm.
  for (const manuscript of packet.manuscripts) for (const chapter of manuscript.chapters) {
    assert(!chapter.body.includes('公开道歉'));
  }
  assert.equal(inspection.valid, true); assert.equal(inspection.evidenceContractValid, true);
  assert.equal(inspection.factJudgment, 'requires_human_review');
  assert.equal(inspection.literaryJudgment, 'requires_human_review');
  if (!single) {
    assert(inspection.differenceCoverage.length > 0);
    assert(inspection.differenceCoverage.every(d => d.covered));
  }
  const view = f.view(), row = view.requests.find(r => r.requestId === requestId);
  assert.equal(row.protocolValidation.status, 'passed'); assert.equal(row.semanticReview.status, 'pending');
  assert.equal(row.originalResponse.overall.assessment, unsupportedClaim);
  assert.equal(row.originalResponse.scopeLimit, response.scopeLimit);
  assert.equal(row.rawText, f.executions.find(r => r.requestId === requestId).raw);
  assert.equal(view.editorialDecision.status, 'pending'); assert.equal(view.adoptionExecuted, false);
  assert.equal(view.fullManuscriptAccepted, false);
});

test('opening-only evidence in later chapter observations fails despite valid anchors', () => {
  const f = round((response, request) => {
    if (request.requestId === 'S1') for (const reading of response.chapterReadings) {
      reading.evidenceIds = [firstBodyEvidence(response, 'X')];
    }
  });
  const inspection = f.inspections.S1;
  assert.equal(inspection.anchorsValid, true); assert.equal(inspection.valid, false);
  for (const code of ['WRONG_SOURCE', 'REQUIRED_SOURCE_MISSING']) assert(inspection.errors.some(e => e.code === code));
  const row = f.view().requests[0];
  assert.equal(row.protocolValidation.status, 'failed'); assert.equal(row.semanticReview.status, 'pending');
  assert.equal(row.rawText, f.executions[0].raw); assert.equal(row.fullManuscriptAccepted, false);
});

test('human failed support review coexists with mechanically passed opening-only global claims', () => {
  const f = round(), request = f.plan.requests.find(r => r.requestId === 'C1');
  const raw = f.executions.find(r => r.requestId === 'C1').raw;
  // Explicit simulated human sidecar; never generated from the mechanical inspection.
  f.put('human-review', {schemaVersion: 'isolated-reading-semantic-review-2', requestId: 'C1',
    planSHA256: f.plan.planSHA256, packetSHA256: request.packetSHA256, rawSHA256: sha256(raw),
    status: 'failed', scope: '合成总体主张与所选首段的支持关系',
    summary: '原文仅有纸伞动作和院子环境，没有所声称的公开道歉。', fullManuscriptAccepted: false});
  f.manifest.requests.find(r => r.requestId === 'C1').semanticReviewId = 'human-review';
  const view = f.view(), row = view.requests.find(r => r.requestId === 'C1');
  assert.equal(row.protocolValidation.status, 'passed'); assert.equal(row.semanticReview.status, 'failed');
  assert.equal(row.preference.validated, 'no_clear_preference');
  assert.equal(row.rawText, raw); assert.equal(row.originalResponse.overall.assessment, unsupportedClaim);
  assert.equal(view.editorialDecision.status, 'pending'); assert.equal(view.adoptionExecuted, false);
  assert.equal(view.fullManuscriptAccepted, false);
});
