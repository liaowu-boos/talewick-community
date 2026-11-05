import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptResult} from '../src/result-adapter.mjs';
import {comparisonFixture} from './comparison-fixture.mjs';

test('actual coverage export keeps support, counterevidence, title and original preference separate', async () => {
  const f=await comparisonFixture();const view=adaptResult(await f.open());
  const [shared,changed,title]=view.sources[0].comparisons;
  assert.deepEqual([shared.exact,shared.changedParagraphCount,shared.sharedOnly,shared.preference],[2,0,true,'second']);
  assert.deepEqual([shared.secondary[0].channel,shared.secondary[0].changedParagraphCount],['counterEvidence',1]);
  assert.deepEqual([changed.exact,changed.changedParagraphCount,changed.sharedOnly],[2,2,false]);
  assert.deepEqual([title.exact,title.changedParagraphCount,title.sharedOnly],[1,0,false]);
  assert.equal(view.conclusion.literaryQuality.status,'tradeoff');assert.equal(view.adopted,false);
});
test('absent coverage and unclassified body are pending, never the shared-only result', async () => {
  const f=await comparisonFixture(); f.a.comparisons[0].coverageId=null; f.a.comparisons[0].exact=2;
  const row=f.coverage.citations.find(r=>r.pointer==='/comparisons/1/evidence/0');
  row.coverage='unresolved';f.coverage.units[row.unitIds[0]].state='unresolved';await f.save();
  const [missing,partial]=adaptResult(await f.open()).sources[0].comparisons;
  assert.deepEqual([missing.exact,missing.changedParagraphCount,missing.sharedOnly,missing.preference],[2,null,false,'second']);
  assert.deepEqual([partial.exact,partial.knownChanged,partial.changedParagraphCount,partial.sharedOnly],[2,1,null,false]);
});
test('two distinct occurrences of one changed paragraph count once', async () => {
  const f=await comparisonFixture();const rows=f.coverage.citations.filter(r=>r.pointer.startsWith('/comparisons/1/evidence/'));
  rows[1]={...rows[0], pointer:rows[1].pointer};
  const original=f.original.comparisons;original[1].evidence[1]=structuredClone(original[1].evidence[0]);
  Object.assign(f.coverage.citations.find(r=>r.pointer===rows[1].pointer),rows[1]);
  const {sha256}=await import('../src/evidence-store.mjs');f.coverage.binding.comparisonsSHA256=sha256(JSON.stringify(original));
  await f.save();const changed=adaptResult(await f.open()).sources[0].comparisons[1];
  assert.deepEqual([changed.exact,changed.changedParagraphCount],[2,1]);
});
for (const [name,change] of [
  ['wrong candidate',f=>{f.coverage.binding.candidateSHA256='0'.repeat(64);}],
  ['another opinion array',f=>{f.original.comparisons[0].statement+='!';}],
  ['reversed blind roles',f=>{f.a.comparisons[0].rolesByBlindId={A:'baseline',B:'candidate'};}],
  ['unknown occurrence',f=>{f.coverage.citations[0].pointer+='/bad';}],
]) test(`reject coverage for ${name}`,async()=>{const f=await comparisonFixture();change(f);await f.save();const store=await f.open();assert.throws(()=>adaptResult(store));});
