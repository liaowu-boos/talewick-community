import test from 'node:test';
import assert from 'node:assert/strict';
import {adaptResult} from '../src/result-adapter.mjs';
import {stageReturnFixture} from './stage-return-fixture.mjs';

const rows=async f=>adaptResult(await f.open()).sources[0].stageReturns;
test('response failures do not replace sealed preferences or change other decision axes',async()=>{
  const f=await stageReturnFixture(), view=adaptResult(await f.open()),r=view.sources[0].stageReturns;
  assert.deepEqual(r.map(s=>s.state),['returned_invalid','unknown','not_dispatched','sealed']);
  assert.deepEqual(r.map(s=>s.rawPreference),['first',null,null,null]);
  assert.deepEqual(r.map(s=>s.sealedPreference),[null,null,null,'second']);
  assert.equal(view.conclusion.literaryQuality.status,'tradeoff');assert.equal(view.adopted,false);
});
test('missing journal or source registration is unknown; a missing raw cannot prove return',async()=>{
  const f=await stageReturnFixture(),spec=f.source.stageDiagnostics;delete spec.attachments[0].rawId;
  assert.equal((await rows(f))[0].state,'unknown');delete spec.journalId;assert.deepEqual(await rows(f),[]);
});
test('an observed seal without native validation has no effective preference',async()=>{
  const f=await stageReturnFixture();delete f.source.stageDiagnostics.attachments[1].validationId;
  assert.equal((await rows(f))[3].sealedPreference,null);
});
test('generic rejection is not attributed to citations',async()=>{
  const f=await stageReturnFixture();f.diagnostic.stages[0].attempts[0].failureCode='MODEL_OUTPUT_INVALID';await f.save(f.journal.replace('PARAGRAPH_REFERENCE_UNKNOWN','MODEL_OUTPUT_INVALID'));
  assert.equal((await rows(f))[0].statusLabel,'原回包已保存，校验失败');
});
for(const [title,corrupt] of [
 ['request',f=>{f.source.stageDiagnostics.requestHash='0'.repeat(64);}],
 ['metadata',f=>{f.source.stageDiagnostics.taskMetadataSHA256='0'.repeat(64);}],
 ['journal',f=>{f.source.stageDiagnostics.journalId='accepted-raw';}],
 ['raw',f=>{f.source.stageDiagnostics.attachments[0].rawId='accepted-raw';}],
 ['seal',f=>{f.sealRecord.record={preference:'first',readerId:'other'};}],
 ['validation',f=>{f.validation.recordSha256='0'.repeat(64);}],
 ['attempt',f=>{f.source.stageDiagnostics.attachments[1].attemptId='foreign';}],
])test(`mismatched ${title} rejected`,async()=>{const f=await stageReturnFixture();corrupt(f);await f.save();await assert.rejects(rows(f));});

test('a later unknown attempt does not erase a proven earlier rejected return or become an effective preference',async()=>{
  const f=await stageReturnFixture(), stage=f.diagnostic.stages[0];
  stage.state='unknown';stage.reason='attempt_history';stage.attempts.push({...f.diagnostic.stages[1].attempts[0],attemptId:'a-next'});await f.save();
  const history=(await rows(f)).filter(row=>row.label.startsWith(stage.stageId));
  assert.deepEqual(history.map(r=>r.state),['unknown','returned_invalid','unknown']);
  assert.deepEqual(history.map(r=>r.rawPreference),[null,'first',null]);assert(history.every(r=>r.sealedPreference===null));
});

test('saved bytes without a corresponding provider-return event stay unknown',async()=>{
  const f=await stageReturnFixture();await f.save(f.journal.replace('provider_returned','unrelated_event'));
  const r=(await rows(f))[0];assert.equal(r.state,'unknown');assert.equal(r.rawPreference,null);
});
