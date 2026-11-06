import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptIsolatedReading} from '../src/isolated-reading.mjs';
import {buildReadingPlan, validateResponse, inspectExecution, sha256, valueSHA256} from '../../isolated-anchor-reading/review-tools.mjs';
import {manuscripts, chapterIds as fixtureChapterIds, makeResponse} from '../../isolated-anchor-reading/synthetic-fixture.mjs';

function fixture(mutate = () => {}, texts = manuscripts, chapterIds = fixtureChapterIds) {
  const plan = buildReadingPlan({manuscripts: texts, chapterIds});
  const entries = new Map();
  function put(id, value) {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    entries.set(id, {entry: {sha256: sha256(bytes)}, bytes});
  }
  const raws = {}, inspections = {}, executions = [];
  const requests = plan.requests.map(request => {
    const id = request.requestId;
    let response = makeResponse(request.packet);
    response = mutate(response, request) ?? response;
    const raw = typeof response === 'string' ? response : JSON.stringify(response);
    raws[id] = raw;
    const inspection = validateResponse({packet: request.packet, expectedPacketSHA256: request.packetSHA256, raw});
    inspections[id] = inspection;
    const receipt = {contextId: `synthetic-context-${id}`, invocationId: `synthetic-call-${id}`};
    put(`${id}-raw`, raw); put(`${id}-inspection`, inspection);
    put(`${id}-receipt`, receipt); put(`${id}-messages`, request.messages);
    executions.push({requestId: id, raw, messages: request.messages, receipt});
    return {requestId: id, rawId: `${id}-raw`, inspectionId: `${id}-inspection`,
      messagesId: `${id}-messages`, receiptId: `${id}-receipt`};
  });
  const execution = inspectExecution({plan, executions});
  put('execution', execution);
  const manifest = {planSHA256: plan.planSHA256, requests, executionId: 'execution'};
  const input = {plan, expectedPlanSHA256: plan.planSHA256, manifest,
    get: id => { assert(entries.has(id)); return entries.get(id); }, ref: id => ({id})};
  return {input, raws, inspections, executions, execution, put, entries, run: () => adaptIsolatedReading(input)};
}

function semantic(f, requestId = 'C1', overrides = {}) {
  const report = {schemaVersion: 'isolated-reading-semantic-review-2', requestId,
    planSHA256: f.input.plan.planSHA256,
    packetSHA256: f.input.plan.requests.find(r => r.requestId === requestId).packetSHA256,
    rawSHA256: sha256(f.raws[requestId]), status: 'failed', scope: '合成主张的支持关系',
    summary: '定位精确但原文未支持该因果推断。', fullManuscriptAccepted: false, ...overrides};
  f.put('semantic', report);
  f.input.manifest.requests.find(r => r.requestId === requestId).semanticReviewId = 'semantic';
}

function editorial(f, overrides = {}) {
  f.put('editorial', {schemaVersion: 'isolated-reading-editorial-decision-2', planSHA256: f.input.plan.planSHA256,
    rawSHA256ByRequest: Object.fromEntries(Object.entries(f.raws).map(([id, raw]) => [id, sha256(raw)])),
    status: 'retain_baseline', scope: '当前三章工作底稿选择', summary: '独立编辑判断仍保留基线。',
    fullManuscriptAccepted: false, ...overrides});
  f.input.manifest.editorialDecisionId = 'editorial';
}

test('three routes retain distinct reading methods without manufacturing three preference votes', () => {
  const f = fixture(), view = f.run();
  assert.deepEqual(view.requests.map(r => r.requestId), ['S1', 'S2', 'C1']);
  for (const row of view.requests.slice(0, 2)) {
    assert.equal(row.mode, 'single');
    assert.deepEqual(row.preference, {applicable: false, raw: null, validated: null, label: '单稿阅读不适用稿间偏好'});
    assert.equal(Object.hasOwn(row.opinion.overall, 'preference'), false);
    assert.equal(row.semanticReview.status, 'pending');
  }
  const c1 = view.requests[2];
  assert.match(c1.label, /差异辅助比较/);
  assert.equal(c1.preference.validated, 'no_clear_preference');
  assert.equal(view.execution.status, 'passed');
  assert.equal(view.editorialDecision.status, 'pending');
  assert.equal(view.fullManuscriptAccepted, false);
  assert.equal(view.adoptionExecuted, false);
  assert.deepEqual(view.textIdentity.chapters.map(c => c.bodyEqual), [false, false, true]);
});

test('every independent opinion field and exact original text remain available', () => {
  const f = fixture(), view = f.run();
  for (const row of view.requests) {
    assert.equal(row.rawText, f.raws[row.requestId]);
    const original = JSON.parse(row.rawText);
    for (const [key, value] of Object.entries(row.opinion)) assert.deepEqual(value, original[key]);
    assert.deepEqual(row.originalResponse, original);
  }
});

test('a forbidden single-reader preference remains rejection evidence, never a vote', () => {
  const f = fixture((response, request) => { if (request.requestId === 'S1') response.overall.preference = 'A'; });
  const [row] = f.run().requests;
  assert.equal(row.protocolValidation.status, 'failed');
  assert.equal(row.originalResponse.overall.preference, 'A');
  assert.equal(Object.hasOwn(row.opinion.overall, 'preference'), false);
  assert.equal(row.preference.applicable, false);
  assert.equal(row.preference.raw, null);
  assert.equal(row.preference.validated, null);
});

for (const invalid of ['{invalid synthetic JSON\n', 'null', '[]', '17']) test(`invalid raw ${invalid.trim()} is readable without an effective preference`, () => {
  const f = fixture((response, request) => request.requestId === 'C1' ? invalid : response);
  const c1 = f.run().requests[2];
  assert.equal(c1.returnState, 'returned');
  assert.equal(c1.rawText, invalid);
  assert.equal(c1.protocolValidation.status, 'failed');
  assert.equal(c1.preference.validated, null);
});

test('structured global identity contradiction fails while local chapter identity remains visible', () => {
  const f = fixture((response, request) => { if (request.requestId === 'C1') response.textIdentity = 'identical'; });
  const view = f.run(), c1 = view.requests[2];
  assert.equal(c1.protocolValidation.status, 'failed');
  assert.equal(c1.protocolValidation.inspection.identityCheck.consistent, false);
  assert.equal(view.textIdentity.chapters[2].bodyEqual, true);
  assert.equal(c1.preference.raw, 'no_clear_preference');
  assert.equal(c1.preference.validated, null);
});

test('common-context citations cannot hide missing change-region coverage', () => {
  const f = fixture((response, request) => {
    if (request.requestId !== 'C1') return;
    const common = request.packet.anchors.filter(a => a.chapterId === 'ending' && a.field === 'body');
    response.changeReadings.forEach(change => {
      change.evidenceIds = common.map(a => response.evidence.find(e => e.anchorId === a.anchorId).id);
    });
  });
  const c1 = f.run().requests[2], inspection = c1.protocolValidation.inspection;
  assert.equal(inspection.anchorsValid, true);
  assert.equal(c1.protocolValidation.status, 'failed');
  assert(inspection.differenceCoverage.some(d => d.sides.some(s => s.missingRegionAnchorIds.length)));
  assert.equal(c1.preference.validated, null);
});

test('wrong reader anchors fail independently of another route succeeding', () => {
  const f = fixture((response, request) => {
    if (request.requestId === 'S1') response.evidence[0].anchorId = response.evidence[0].anchorId.replace('S1-', 'S2-');
  });
  const view = f.run();
  assert.equal(view.requests[0].protocolValidation.status, 'failed');
  assert.equal(view.requests[1].protocolValidation.status, 'passed');
  assert.equal(view.requests[2].protocolValidation.status, 'passed');
  assert.equal(view.fullManuscriptAccepted, false);
});

test('mechanical success, semantic failure and editorial choice remain separate', () => {
  const f = fixture(); semantic(f); editorial(f);
  const view = f.run(), c1 = view.requests[2];
  assert.equal(c1.protocolValidation.status, 'passed');
  assert.equal(c1.semanticReview.status, 'failed');
  assert.equal(c1.preference.validated, 'no_clear_preference');
  assert.equal(view.editorialDecision.status, 'retain_baseline');
  assert.equal(view.adoptionExecuted, false);
});

test('semantic failure survives missing protocol inspection and cannot repair invalid raw', () => {
  const f = fixture((response, request) => request.requestId === 'C1' ? '{}' : response);
  semantic(f);
  delete f.input.manifest.requests[2].inspectionId;
  const row = f.run().requests[2];
  assert.equal(row.protocolValidation.status, 'pending');
  assert.equal(row.semanticReview.status, 'failed');
  assert.equal(row.rawText, '{}');
  assert.equal(row.preference.validated, null);
});

test('missing response remains unknown and does not claim not-dispatched or failed', () => {
  const f = fixture();
  delete f.input.manifest.requests[0].rawId;
  delete f.input.manifest.executionId;
  const view = f.run();
  assert.equal(view.requests[0].returnState, 'unknown');
  assert.equal(view.requests[0].rawText, null);
  assert.equal(view.execution.status, 'pending');
  assert.equal(view.requests[2].preference.validated, null);
});

test('no execution inspection means no mechanically validated comparison preference', () => {
  const f = fixture(); delete f.input.manifest.executionId;
  const row = f.run().requests[2];
  assert.equal(row.protocolValidation.status, 'passed');
  assert.equal(row.preference.raw, 'no_clear_preference');
  assert.equal(row.preference.validated, null);
});

for (const field of ['packetSHA256', 'rawSHA256', 'rawByteLength', 'requestId', 'resolvedEvidence', 'valid']) {
  test(`altered inspection ${field} preserves original and fails binding`, () => {
    const f = fixture(), saved = structuredClone(f.inspections.C1);
    saved[field] = field === 'resolvedEvidence' ? [] : field === 'valid' ? false : 'different';
    f.put('C1-inspection', saved);
    const row = f.run().requests[2];
    assert.equal(row.protocolValidation.status, 'binding_error');
    assert.equal(row.preference.validated, null);
    assert.equal(row.rawText, f.raws.C1);
  });
}

for (const field of ['planSHA256', 'packetSHA256', 'rawSHA256', 'requestId']) test(`semantic ${field} mismatch cannot become a reviewed result`, () => {
  const f = fixture(); semantic(f, 'C1', {[field]: 'wrong', status: 'reviewed'});
  const row = f.run().requests[2];
  assert.equal(row.semanticReview.status, 'binding_error');
  assert.equal(row.protocolValidation.status, 'passed');
});

test('editorial decision is bound to exact raw snapshot and cannot grant full acceptance', () => {
  const f = fixture(); editorial(f, {rawSHA256ByRequest: {}});
  assert.equal(f.run().editorialDecision.status, 'binding_error');
  editorial(f, {fullManuscriptAccepted: true});
  assert.equal(f.run().editorialDecision.status, 'binding_error');
  editorial(f, {status: 'use_as_working_draft'});
  assert.equal(f.run().editorialDecision.status, 'use_as_working_draft');
  assert.equal(f.run().fullManuscriptAccepted, false);
});

test('actual message mismatch is exposed even when its saved execution check is honestly failed', () => {
  const f = fixture();
  f.executions[0].messages = [{role: 'user', content: 'different synthetic history'}];
  f.put('S1-messages', f.executions[0].messages);
  f.put('execution', inspectExecution({plan: f.input.plan, executions: f.executions}));
  const view = f.run();
  assert.equal(view.execution.status, 'failed');
  assert.equal(view.requests[2].preference.validated, null);
});

test('duplicate contexts, forged successful execution, and incomplete receipts cannot promote preference', () => {
  const f = fixture();
  f.executions[1].receipt.contextId = f.executions[0].receipt.contextId;
  f.put('S2-receipt', f.executions[1].receipt);
  assert.equal(f.run().execution.status, 'binding_error');
  f.put('execution', inspectExecution({plan: f.input.plan, executions: f.executions}));
  assert.equal(f.run().execution.status, 'failed');
  delete f.input.manifest.requests[0].receiptId;
  assert.equal(f.run().execution.status, 'binding_error');
  assert.equal(f.run().requests[2].preference.validated, null);
});

test('frozen plan, packet, manifest and raw tampering fail closed', () => {
  for (const alter of [
    f => { f.input.expectedPlanSHA256 = sha256('wrong plan'); },
    f => { f.input.manifest.planSHA256 = sha256('wrong manifest'); },
    f => { f.input.plan.requests[0].packet.anchors[0].text += 'changed'; },
    f => { f.input.plan.requests[0].messages[0].content += 'changed'; },
    f => { f.input.manifest.requests.reverse(); },
    f => { f.entries.get('C1-raw').bytes = Buffer.from('{}'); },
  ]) {
    const f = fixture(); alter(f); assert.throws(f.run);
  }
});

test('canonical value digests are distinct from file byte digests', () => {
  const f = fixture();
  const body = structuredClone(f.input.plan); delete body.planSHA256;
  assert.equal(valueSHA256(body), f.input.plan.planSHA256);
  assert.notEqual(sha256(JSON.stringify(body, null, 2)), f.input.plan.planSHA256);
  const reordered = Object.fromEntries(Object.entries(f.input.plan).reverse());
  f.input.plan = reordered;
  assert.equal(f.run().execution.status, 'passed');
});

test('identity labels include titles without conflating unchanged chapter bodies', () => {
  const texts = {A: structuredClone(manuscripts.A), B: structuredClone(manuscripts.A)};
  texts.B[2].title += '副题';
  const view = fixture(() => {}, texts).run();
  assert.equal(view.textIdentity.identical, false);
  assert(view.textIdentity.chapters.every(c => c.bodyEqual));
  assert.equal(view.textIdentity.chapters[2].titleEqual, false);
  assert.match(view.textIdentityScope, /标题及正文/);
});

for(const chapterIds of [['single'],['section-B','section-A'],['p1','p2','p3','p4','p5']]){
  test(`adapter retains explicit ordered scope ${chapterIds.join(',')}`, () => {
    const A=chapterIds.map((id,i)=>({id,title:`合成标题${i}`,body:`原段${i}。`}));
    const B=A.map((chapter,i)=>({...chapter,body:i===0?'不同段落。':chapter.body}));
    const f=fixture(()=>{},{A,B},chapterIds),view=f.run();
    assert.equal(view.schemaVersion,'isolated-reading-view-2');
    assert.deepEqual(view.chapterIds,chapterIds);
    assert.equal(view.execution.status,'passed');
    assert(view.requests.every(row=>row.protocolValidation.status==='passed'));
    assert.equal(view.requests[0].preference.applicable,false);
    assert.equal(view.requests[2].preference.validated,'no_clear_preference');
  });
}
test('adapter rejects legacy plans and quarantines old inspection and human-sidecar schemas',()=>{
  const old=fixture();old.input.plan.protocolVersion='isolated-anchor-reading-1';
  assert.throws(old.run,/Unsupported reading protocol/);
  const f=fixture();f.put('C1-inspection',{...f.inspections.C1,schemaVersion:'isolated-anchor-reading-inspection-1'});
  assert.equal(f.run().requests[2].protocolValidation.status,'binding_error');
  semantic(f,'C1',{schemaVersion:'isolated-reading-semantic-review-1',status:'reviewed'});
  assert.equal(f.run().requests[2].semanticReview.status,'binding_error');
  editorial(f,{schemaVersion:'isolated-reading-editorial-decision-1'});
  assert.equal(f.run().editorialDecision.status,'binding_error');
});
test('adapter rejects plan range changes even when the caller updates its visible plan digest',()=>{
  const f=fixture();f.input.plan.chapterIds.reverse();
  const body=structuredClone(f.input.plan);delete body.planSHA256;
  f.input.plan.planSHA256=valueSHA256(body);f.input.expectedPlanSHA256=f.input.plan.planSHA256;
  f.input.manifest.planSHA256=f.input.plan.planSHA256;
  assert.throws(f.run);
});
