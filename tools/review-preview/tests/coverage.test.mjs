import test from 'node:test';
import assert from 'node:assert/strict';
import {projectCoverage} from '../src/project-coverage.mjs';

test('a stopped run keeps verified mappings, unknown total and original non-success state', () => {
  const coverage=projectCoverage({status:'needs_attention',externalRequests:3},2,7,9);
  assert.equal(coverage.process.status,'partial');
  assert.match(coverage.process.summary,/needs_attention/);
  assert.equal(coverage.citations.checked,9);
  assert.equal(coverage.citations.total,null);
  assert.equal(coverage.citations.originalPassed,null);
});
test('a zero-seal failure cannot produce a citation pass', () => {
  const coverage=projectCoverage({status:'needs_attention',externalRequests:1},0,7,0);
  assert.equal(coverage.process.status,'failed');
  assert.equal(coverage.citations.originalPassed,null);
});
test('complete requires every seal', () => {
  assert.throws(()=>projectCoverage({status:'complete',externalRequests:7},6,7,7));
  assert.equal(projectCoverage({status:'complete',externalRequests:7},7,7,10).citations.total,10);
});
