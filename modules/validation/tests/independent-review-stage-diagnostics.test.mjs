import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, appendFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readIndependentReviewStageDiagnostics as diagnose } from '../runtime/independent-review-stage-diagnostics.mjs';
import { startIndependentReview, resumeIndependentReview } from '../runtime/independent-review-task.mjs';
import { withLiteraryReadingFocus } from '../runtime/focused-whole-quality-evaluation.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const chapters = [{ id:'c', title:'回信', body:'他把信封放回窗台。\n\n楼下卖花的人收了伞，回头看了一眼。' }];
const request = () => withLiteraryReadingFocus({ caseId:'offline-letters', mode:'compare', baselineChapters:chapters,
  candidate:{mode:'no_change',chapters},goals:[] });
const root = async t => {
  const dir = await mkdtemp(join(tmpdir(),'talewick-stage-diagnostics-'));
  t.after(() => rm(dir,{recursive:true,force:true})); return dir;
};
function fixture(mode) {
  let calls = 0;
  const analyze = async input => {
    calls++;
    const record = structuredClone(input.packet.responseContract.example);
    if (input.packet.taskStageId === '05-reader-1-pair') {
      if (mode === 'unknown') throw Error('synthetic transport closed');
      if (mode === 'definite') throw Object.assign(Error('synthetic pre-dispatch'),{definitelyNotDispatched:true});
      if (mode === 'invalid') record.comparisons[0].evidence[0] = {anchorId:'A'};
      if (mode === 'empty') return { outputText:'', receipt:{ provider:'local',contextId:'blank',invocationId:'blank',inputHash:input.inputHash } };
    }
    const id = randomUUID();
    return { outputText:JSON.stringify(record), receipt:{ provider:'local',contextId:id,invocationId:id,inputHash:input.inputHash } };
  };
  return { analyze, count:()=>calls };
}
async function run(t, mode) {
  const f=fixture(mode);
  const task=await startIndependentReview({runRoot:await root(t),request:request(),modelCitationMode:'paragraph_refs_v1',analyze:f.analyze});
  return { task, calls:f.count(), journal:join(dirname(task.runDir),'events.ndjson') };
}
async function tree(dir) {
  const inventory = {};
  async function visit(path) {for(const entry of await readdir(path,{withFileTypes:true})){
    const p=join(path,entry.name);if(entry.isDirectory())await visit(p);else inventory[p]=sha(await readFile(p));
  }}
  await visit(dir);return inventory;
}
const stage = (report, n) => report.stages[n-1];
const rawPath = (task, item) => join(task.runDir,'stages',item.stageId,'attempts',item.attempts[0].attemptId,'raw-response.txt');

test('same four seals and five calls distinguish a rejected returned anchor from unknown transport; no opinions or writes', async t => {
  for(const [mode,expected] of [['invalid','returned_invalid'],['unknown','unknown']]) {
    const {task,calls}=await run(t,mode);assert.equal(task.status,'needs_attention');assert.equal(calls,5);
    const before=await tree(dirname(task.runDir));const report=await diagnose(task), fifth=stage(report,5);
    assert.equal(report.counts.sealed,4);assert.equal(report.counts.not_dispatched,2);assert.equal(fifth.state,expected);
    assert.deepEqual(report.stages.slice(5).map(s=>s.state),['not_dispatched','not_dispatched']);
    const attempt=fifth.attempts[0];
    if(mode==='invalid'){
      const raw=await readFile(rawPath(task,fifth));
      assert.deepEqual(attempt.rawResponse,{sha256:sha(raw),byteLength:raw.length});assert.equal(attempt.providerReturnEvents,1);
      assert.equal(attempt.failureCode,'PARAGRAPH_REFERENCE_UNKNOWN');
    } else {assert.equal(attempt.providerReturnEvents,0);assert.equal(attempt.rawResponse,null);}
    assert.doesNotMatch(JSON.stringify(report), /preference|outputText|comparisons|\/raw-response|楼下卖花/);
    assert.deepEqual(await diagnose(task),report);assert.deepEqual(await tree(dirname(task.runDir)),before);
  }
});

test('empty saved response is distinct from missing raw bytes; an unsealed rejection never creates a seal', async t => {
  const {task}=await run(t,'empty');let item=stage(await diagnose(task),5);
  assert.equal(item.state,'returned_invalid');assert.equal(item.attempts[0].rawResponse.byteLength,0);
  await unlink(rawPath(task,item));item=stage(await diagnose(task),5);assert.equal(item.state,'unknown');
  assert.equal(item.attempts[0].providerReturnEvents,1);assert.equal(item.attempts[0].rawResponse,null);
  await assert.rejects(readFile(join(task.runDir,'stages',item.stageId,'sealed.json')),{code:'ENOENT'});
});

test('an explicit non-dispatch and a later returned rejection remain separate attempts', async t => {
  const {task}=await run(t,'definite');assert.equal(task.status,'interrupted');const before=stage(await diagnose(task),5);
  assert.equal(before.state,'not_dispatched');assert.equal(before.attempts[0].reason,'explicit_non_dispatch');
  const f=fixture('invalid');const resumed=await resumeIndependentReview({...task,analyze:f.analyze});assert.equal(f.count(),1);
  const after=stage(await diagnose(resumed),5);assert.equal(after.state,'returned_invalid');
  assert.deepEqual(after.attempts.map(a=>a.state),['not_dispatched','returned_invalid']);
});

test('stray raw bytes, displaced return and mismatched receipts do not prove a returned rejection', async t => {
  const {task,journal}=await run(t,'invalid');const item=stage(await diagnose(task),5), first=item.attempts[0];
  const receiptPath=join(dirname(rawPath(task,item)),'receipt.json');const receipt=JSON.parse(await readFile(receiptPath));
  await writeFile(receiptPath,JSON.stringify({...receipt,contextId:'different'}));assert.equal(stage(await diagnose(task),5).state,'unknown');
  await writeFile(receiptPath,JSON.stringify(receipt));
  const events=(await readFile(journal,'utf8')).trimEnd().split('\n').map(x=>JSON.parse(x));
  const e=events.find(event=>event.type==='provider_returned'&&event.attemptId===first.attemptId);e.attemptId='wrong-attempt';
  await writeFile(journal,events.map(x=>JSON.stringify(x)+'\n').join(''));assert.equal(stage(await diagnose(task),5).state,'unknown');
  const other=join(task.runDir,'stages','06-reader-2-pair','attempts','orphan');await mkdir(other,{recursive:true});
  await writeFile(join(other,'raw-response.txt'),'retained orphan');assert.equal(stage(await diagnose(task),6).state,'unknown');
});

test('modified sealed raw and a seal event without a native seal are never published as sealed', async t=>{
  const {task,journal}=await run(t,'invalid');const initial=await diagnose(task),one=stage(initial,1),five=stage(initial,5);
  await appendFile(rawPath(task,one),' ');assert.equal(stage(await diagnose(task),1).state,'unknown');
  await appendFile(journal,JSON.stringify({type:'stage_sealed',stageId:five.stageId,stage:'blind_pair',attemptId:five.attempts[0].attemptId,inputHash:five.attempts[0].inputHash})+'\n');
  assert.equal(stage(await diagnose(task),5).state,'unknown');
});

test('wrong request, active lock and truncated journal reject the snapshot', async t=>{
  const {task,journal}=await run(t,'invalid');
  await assert.rejects(diagnose({...task,requestHash:'0'.repeat(64)}),{code:'DIAGNOSTIC_TASK_BINDING'});
  const lock=join(dirname(task.runDir),'active.lock');await writeFile(lock,'test');await assert.rejects(diagnose(task),{code:'DIAGNOSTIC_TASK_ACTIVE'});await unlink(lock);
  await appendFile(journal,'{"type":');await assert.rejects(diagnose(task),{code:'DIAGNOSTIC_INCOMPLETE_SNAPSHOT'});
});

test('normal complete legacy single review retains its original result and two observed seals',async t=>{
  const f=fixture('normal');const task=await startIndependentReview({runRoot:await root(t),request:{caseId:'old-single',mode:'single',baselineChapters:chapters},analyze:f.analyze});
  assert.equal(task.status,'complete');assert.equal(f.count(),2);const before=await tree(dirname(task.runDir));
  assert.deepEqual((await diagnose(task)).counts,{sealed:2,returned_invalid:0,unknown:0,not_dispatched:0});assert.deepEqual(await tree(dirname(task.runDir)),before);
});

test('unsealed raw that no longer matches the saved parsed response is unknown', async t=>{
  const {task}=await run(t,'invalid');const item=stage(await diagnose(task),5);
  await writeFile(rawPath(task,item),'{"unrelated":true}');const changed=stage(await diagnose(task),5);
  assert.equal(changed.state,'unknown');assert.equal(changed.attempts[0].reason,'raw_parsed_mismatch');
});

test('a malformed seal remains isolated to its stage', async t=>{
  const {task}=await run(t,'invalid');const item=stage(await diagnose(task),1);
  await writeFile(join(task.runDir,'stages',item.stageId,'sealed.json'),'{');
  const report=await diagnose(task);assert.equal(stage(report,1).reason,'malformed_stage_artifact');
  assert.equal(report.counts.sealed,3);assert.equal(report.counts.returned_invalid,1);
});
