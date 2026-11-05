import test from 'node:test';
import assert from 'node:assert/strict';
import {scopedReaders} from '../src/scoped-review.mjs';
import {sha256, buildReadingPrompts, validateReading, inspectExecution} from '../../continuous-review/review-tools.mjs';
import {manuscripts, makeResponse} from '../../continuous-review/synthetic-fixture.mjs';

function fixture(response = makeResponse()) {
  const planned = buildReadingPrompts({manuscripts});
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
  const inspection = validateReading({manuscripts, raw});
  const execution = inspectExecution({planned, executions});
  put('execution', execution);
  const manifest = {executionId: 'execution', readers: planned.map((plan, i) => {
    put(`raw-${i}`, raw);
    put(`inspection-${i}`, inspection);
    put(`receipt-${i}`, executions[i].receipt);
    return {id: plan.readerId, order: plan.order, rawId: `raw-${i}`, inspectionId: `inspection-${i}`, receiptId: `receipt-${i}`};
  })};
  const input = {manifest, planned, manuscripts, get: id => entries.get(id), ref: id => ({id})};
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
