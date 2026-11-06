import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedReaders} from '../src/scoped-review.mjs';
import {compareFrozenBodies} from '../src/scoped-review-facts.mjs';
import {sha256, buildReadingPrompts, validateReading, inspectExecution} from '../../continuous-review/review-tools.mjs';
import {manuscripts, makeResponse} from '../../continuous-review/synthetic-fixture.mjs';

function fixture(response = makeResponse(), texts = manuscripts) {
  const planned = buildReadingPrompts({manuscripts: texts});
  const raw = typeof response === 'string' ? response : JSON.stringify(response);
  const executions = planned.map((plan, i) => ({
    readerId: plan.readerId, messages: plan.messages, raw,
    receipt: {contextId: `synthetic-context-${i}`, invocationId: `synthetic-invocation-${i}`},
  }));
  const entries = new Map();
  const put = (id, value) => {
    const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    entries.set(id, {entry: {sha256: sha256(bytes)}, bytes});
  };
  const inspection = validateReading({manuscripts: texts, raw});
  const execution = inspectExecution({planned, executions});
  put('execution', execution);
  const manifest = {executionId: 'execution', readers: planned.map((plan, i) => {
    put(`raw-${i}`, raw);
    put(`inspection-${i}`, inspection);
    put(`receipt-${i}`, executions[i].receipt);
    return {id: plan.readerId, order: plan.order, rawId: `raw-${i}`, inspectionId: `inspection-${i}`, receiptId: `receipt-${i}`};
  })};
  const input = {manifest, planned, manuscripts: texts, get: id => entries.get(id), ref: id => ({id})};
  return {input, raw, inspection, execution, entries, put, run: () => scopedReaders(input)};
}

test('fully bound validator output exposes scoped preference and human-review limits', () => {
  const f = fixture();
  assert.equal(f.inspection.valid, true);
  assert.equal(f.execution.valid, true);
  for (const row of f.run()) {
    assert.equal(row.state, 'validated');
    assert.equal(row.effectivePreference, 'tradeoff');
    assert.equal(row.rawText, f.raw);
    assert.match(row.reason, /另行复核/);
    assert.equal(new Set(row.references.map(ref => ref.id)).size, row.references.length);
  }
});

for (const [name, mutate] of [
  ['missing quote', response => { response.evidence[0].quote = 'A deliberately absent synthetic sentence.'; }],
  ['invalid structure', response => { delete response.freeReading; }],
  ['exact quotes with incorrect evidence scope', response => { response.dimensions[0].A.evidenceIds = ['B2']; }],
]) test(`${name} retains all original opinions without an effective preference`, () => {
  const response = makeResponse();
  mutate(response);
  const f = fixture(response);
  assert.equal(f.inspection.valid, false);
  if (name.startsWith('exact')) assert.equal(f.inspection.citationsExact, true);
  for (const row of f.run()) {
    assert.equal(row.state, 'returned_invalid');
    assert.equal(row.rawPreference, response.overall.preference);
    assert.equal(row.effectivePreference, null);
    assert.equal(row.assessment, response.overall.assessment);
    assert.equal(row.counterReading, response.counterReading.assessment);
    assert.equal(row.scopeLimit, response.scopeLimit);
    assert.equal(row.rawText, f.raw);
    assert.deepEqual(row.inspection.errors, f.inspection.errors);
  }
});

test('malformed JSON remains readable after validation failure', () => {
  const f = fixture('{ malformed synthetic response\n');
  const [row] = f.run();
  assert.equal(row.state, 'returned_invalid');
  assert.equal(row.rawText, f.raw);
  assert.equal(row.rawPreference, null);
  assert.equal(row.effectivePreference, null);
});

for (const field of ['rawId', 'inspectionId', 'receiptId']) test(`missing ${field} stays unknown`, () => {
  const f = fixture();
  delete f.input.manifest.readers[0][field];
  const [row] = f.run();
  assert.equal(row.state, 'unknown');
  assert.equal(row.effectivePreference, null);
  assert.equal(row.rawText, field === 'rawId' ? null : f.raw);
});

test('missing or invalid execution never promotes an otherwise valid opinion', () => {
  const f = fixture();
  delete f.input.manifest.executionId;
  assert(f.run().every(row => row.state === 'unknown' && row.effectivePreference === null));
  f.input.manifest.executionId = 'execution';
  f.put('execution', {...f.execution, valid: false, errors: ['CONTEXTS_NOT_DISTINCT']});
  assert(f.run().every(row => row.state === 'unknown' && row.effectivePreference === null));
});

for (const [field, value] of [
  ['rawSHA256', sha256('other synthetic raw')],
  ['rawByteLength', 0],
  ['manuscriptsSHA256', sha256('other synthetic manuscripts')],
  ['schemaVersion', 'unsupported-reading-schema'],
  ['protocolVersion', 'unsupported-review-protocol'],
  ['fullManuscriptAccepted', true],
]) test(`mismatched inspection ${field} is rejected`, () => {
  const f = fixture();
  f.put('inspection-0', {...f.inspection, [field]: value});
  assert.throws(f.run);
});

test('contradictory validity flags cannot expose preference', () => {
  const f = fixture();
  f.put('inspection-0', {...f.inspection, evidenceContractValid: false});
  assert.throws(f.run);
  f.put('inspection-0', {...f.inspection, valid: false});
  assert.throws(f.run);
});

test('quote offsets and changed paragraph hashes are rechecked', () => {
  const f = fixture();
  const check = structuredClone(f.inspection);
  check.references[0].start++;
  f.put('inspection-0', check);
  assert.throws(f.run);
  const changed = structuredClone(f.inspection);
  assert(changed.changeCoverage.units.length > 0);
  changed.changeCoverage.units[0].paragraphSHA256 = sha256('different paragraph');
  f.put('inspection-0', changed);
  assert.throws(f.run);
});

for (const field of ['rawSHA256', 'messagesSHA256', 'contextId', 'invocationId']) test(`execution ${field} mismatch is rejected`, () => {
  const f = fixture();
  f.execution.records[0][field] = 'different-synthetic-value';
  f.put('execution', f.execution);
  assert.throws(f.run);
});

test('reader order mismatch and altered stored bytes are rejected', () => {
  const f = fixture();
  f.input.manifest.readers[0].order = ['B', 'A'];
  assert.throws(f.run);
  f.input.manifest.readers[0].order = ['A', 'B'];
  f.entries.get('raw-0').bytes = Buffer.from('{}');
  assert.throws(f.run);
});

// Local protocol IDs map to original chapters 8, 9, 10 outside model messages.
function identityFixture(assessment) {
  const texts = structuredClone(manuscripts);
  texts.B[0].body = '访客把账本收进抽屉。\n\n门外的雨已经停了。';
  texts.B[2].body = texts.A[2].body;
  const response = makeResponse();
  response.overall.assessment = assessment;
  for (const evidence of response.evidence) {
    evidence.quote = texts[evidence.version].find(c => c.id === evidence.chapterId).body.split('\n\n')[0];
  }
  return fixture(response, texts);
}

function addSemanticReview(f, {status = 'pending', scope = 'all_provided_chapters', chapterId} = {}) {
  const text = JSON.parse(f.raw).overall.assessment;
  const report = {schemaVersion: 'scoped-semantic-review-1', rawSHA256: sha256(f.raw),
    manuscriptsSHA256: sha256(JSON.stringify(f.input.manuscripts)), status,
    summary: '合成的独立复核记录，仅检查声明范围。',
    identityClaims: [{path: '/overall/assessment', text, assertion: 'bodies_equal', scope,
      ...(chapterId ? {chapterId} : {})}]};
  f.put('semantic-0', report);
  f.input.manifest.readers[0].semanticReviewId = 'semantic-0';
  return report;
}

test('empty factual warnings never complete semantic review or establish factual truth', () => {
  const f = identityFixture('各章的文字都一样，因此人物的全部判断一定正确。');
  assert.equal(f.inspection.valid, true);
  assert.deepEqual(f.inspection.factualWarnings, []);
  const [row] = f.run();
  assert.equal(row.machineCitations.status, 'passed');
  assert.equal(row.semanticReview.status, 'pending');
  assert.deepEqual(row.semanticReview.identityClaims, []);
  assert.match(row.factualWarningMeaning, /空列表不代表事实正确/);
  assert.equal(row.textComparison.allBodiesEqual, false);
});

test('global identical-text claim contradicts changed chapters 8/9 despite identical chapter 10', () => {
  const f = identityFixture('第8至10章的正文完全相同。');
  addSemanticReview(f, {status: 'failed'});
  const [row] = f.run();
  assert.deepEqual(row.textComparison.chapters.map(c => c.bodiesEqual), [false, false, true]);
  assert.equal(row.machineCitations.status, 'passed');
  assert.equal(row.semanticReview.status, 'failed');
  assert.equal(row.semanticReview.identityClaims[0].scope, 'all_provided_chapters');
  assert.equal(row.semanticReview.identityClaims[0].comparison, 'contradicts_frozen_bodies');
  assert.equal(row.effectivePreference, 'tradeoff'); // Mechanical validity stays separate.
  assert.equal(row.rawText, f.raw);
});

test('local chapter-10 identity matches only its body and does not prove all prose true', () => {
  const f = identityFixture('第10章正文完全相同，所以所有人物的动机都一样。');
  assert(f.inspection.factualWarnings.length > 0); // Broad upstream hint cannot decide scope.
  addSemanticReview(f, {scope: 'chapter', chapterId: 'ch-3'});
  const [row] = f.run();
  assert.equal(row.textComparison.allBodiesEqual, false);
  assert.equal(row.semanticReview.identityClaims[0].comparison, 'matches_frozen_bodies');
  assert.equal(row.semanticReview.identityClaims[0].scope, 'chapter');
  assert.equal(row.semanticReview.status, 'pending');
  assert.match(row.semanticReview.identityClaims[0].limitation, /不判定同一句中的其他事实/);
});

test('warning phrases alone do not assign global or local claim scope', () => {
  for (const assessment of ['第8至10章完全相同。', '只有第10章完全相同。']) {
    const f = identityFixture(assessment);
    const [row] = f.run();
    assert.equal(row.semanticReview.status, 'pending');
    assert.deepEqual(row.semanticReview.identityClaims, []);
    assert.deepEqual(row.textComparison.chapters.map(c => c.bodiesEqual), [false, false, true]);
  }
});

test('explicit reviewed scope remains distinct from full manuscript acceptance', () => {
  const f = identityFixture('第10章正文相同。');
  addSemanticReview(f, {status: 'reviewed', scope: 'chapter', chapterId: 'ch-3'});
  const [row] = f.run();
  assert.equal(row.semanticReview.status, 'reviewed');
  assert.match(row.semanticReview.statusLabel, /声明范围/);
  assert.equal(row.textComparison.scope, 'provided_chapters_only');
  assert.equal(f.inspection.fullManuscriptAccepted, false);
});

test('semantic failure remains visible when machine inspection has not arrived', () => {
  const f = identityFixture('所有章节正文相同。');
  addSemanticReview(f, {status: 'failed'});
  delete f.input.manifest.readers[0].inspectionId;
  const [row] = f.run();
  assert.equal(row.machineCitations.status, 'pending');
  assert.equal(row.semanticReview.status, 'failed');
  assert.equal(row.effectivePreference, null);
});

for (const field of ['rawSHA256', 'manuscriptsSHA256', 'schemaVersion']) test(`semantic ${field} binding mismatch is rejected`, () => {
  const f = identityFixture('正文一致。');
  const report = addSemanticReview(f);
  report[field] = 'different-synthetic-value';
  f.put('semantic-0', report);
  assert.throws(f.run);
});

test('semantic claim must point to unchanged original text and an explicit valid scope', () => {
  const f = identityFixture('正文一致。');
  const original = addSemanticReview(f);
  for (const patch of [{text: '替换后的主张'}, {path: '/missing'}, {scope: 'all'},
    {scope: 'chapter', chapterId: 'missing'}, {scope: 'all_provided_chapters', chapterId: 'ch-3'}]) {
    const report = structuredClone(original);
    Object.assign(report.identityClaims[0], patch);
    f.put('semantic-0', report);
    assert.throws(f.run);
  }
});

test('a global body contradiction cannot be recorded as reviewed without failure', () => {
  const f = identityFixture('全文正文一致。');
  addSemanticReview(f, {status: 'reviewed'});
  assert.throws(f.run);
});

test('body comparison uses exact frozen text, including whitespace, without assuming full-book coverage', () => {
  const chapters = [8, 9, 10].map(id => ({id: `ch-${id}`, title: '合成章节', body: `合成正文${id}。`}));
  const texts = {A: chapters, B: structuredClone(chapters)};
  texts.B[0].body += '新增。';
  texts.B[1].body += ' ';
  texts.B[2].title = '另一标题';
  const result = compareFrozenBodies(texts);
  assert.deepEqual(result.chapters.map(c => [c.chapterId, c.bodiesEqual]), [['ch-8', false], ['ch-9', false], ['ch-10', true]]);
  assert.equal(result.allBodiesEqual, false);
  assert.equal(result.scope, 'provided_chapters_only');
  assert.equal(result.chapters[2].ABodySHA256, result.chapters[2].BBodySHA256);
  texts.B.reverse();
  assert.throws(() => compareFrozenBodies(texts));
});
