import test from 'node:test';
import assert from 'node:assert/strict';
import { manuscripts, makeResponse } from './synthetic-fixture.mjs';
import { PROTOCOL_VERSION, buildReadingPrompts, validateReading, inspectChangeCoverage, inspectExecution } from './review-tools.mjs';

test('invalid version names return validation failures instead of accessing inherited properties', () => {
  for (const version of ['__proto__', 'constructor', 'toString', [], {}]) {
    const response = makeResponse();
    response.evidence[0].version = version;
    assert.equal(validateReading({ manuscripts, raw: JSON.stringify(response) }).valid, false);
  }
});

test('top-level field types are checked without repairing the response', () => {
  for (const key of Object.keys(makeResponse())) {
    for (const value of [null, [], {}, 0, true, 'x']) {
      const response = makeResponse();
      response[key] = value;
      const result = validateReading({ manuscripts, raw: JSON.stringify(response) });
      assert.equal(result.valid, key === 'scopeLimit' && value === 'x');
    }
  }
});

test('change coverage rejects a caller-supplied uniqueness flag for a repeated quote', () => {
  const input = structuredClone(manuscripts);
  input.A[0].body = '重复。\n\n重复。';
  const result = inspectChangeCoverage({ manuscripts: input, citations: [
    { id: 'E', version: 'A', chapterId: 'ch-1', quote: '重复。', start: 0, end: 3, exactUnique: true }
  ] });
  assert(result.units.filter(u => u.version === 'A' && u.chapterId === 'ch-1').every(u => u.citationIds.length === 0));
});

test('version-prefixed IDs work but do not override the actual evidence source', () => {
  const response = makeResponse();
  const ids = new Map(response.evidence.map(e => [e.id, e.version + '_E' + e.id.slice(1)]));
  response.evidence.forEach(e => { e.id = ids.get(e.id); });
  function rewrite(value) {
    if (Array.isArray(value)) value.forEach(rewrite);
    else if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        if (key === 'evidenceIds') value[key] = value[key].map(id => ids.get(id));
        else rewrite(value[key]);
      }
    }
  }
  rewrite(response);
  assert(validateReading({ manuscripts, raw: JSON.stringify(response) }).valid);
  response.dimensions[0].A.evidenceIds = ['B_E2'];
  assert(validateReading({ manuscripts, raw: JSON.stringify(response) }).errors.some(e => e.code === 'WRONG_SOURCE'));
});

test('stable public identifiers and local chapter labels appear in the output contract', () => {
  const reading = validateReading({ manuscripts, raw: JSON.stringify(makeResponse()) });
  const planned = buildReadingPrompts({ manuscripts });
  const executions = planned.map((p, i) => ({ readerId: p.readerId, messages: p.messages,
    raw: JSON.stringify(makeResponse()), receipt: { contextId: 'context-' + i, invocationId: 'invocation-' + i } }));
  assert.equal(PROTOCOL_VERSION, 'continuous-review-1');
  assert.equal(reading.schemaVersion, 'continuous-review-reading-inspection-1');
  assert.equal(reading.changeCoverage.schemaVersion, 'continuous-review-change-coverage-1');
  assert.equal(inspectExecution({ planned, executions }).schemaVersion, 'continuous-review-execution-inspection-1');
  const publicInput = JSON.parse(planned[0].user);
  assert.deepEqual(publicInput.manuscripts[0].chapters.map(c => c.id), ['ch-1', 'ch-2', 'ch-3']);
});
