// Optional joint verification. Run with the integrated FULL15 diagnostic module as argv[2].
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {adaptResult,labels} from '../src/result-adapter.mjs';
import {sha256} from '../src/evidence-store.mjs';
import {fixture} from './fixture.mjs';

test('native stopped snapshots through FULL15 diagnostics, the allowlist, and rendered preference sections', async t=>{
  const modulePath=path.resolve(process.argv[2]),moduleURL=pathToFileURL(modulePath);
  const {readIndependentReviewStageDiagnostics:diagnose}=await import(moduleURL);
  const {startIndependentReview}=await import(new URL('./independent-review-task.mjs',moduleURL));
  const {withLiteraryReadingFocus}=await import(new URL('./focused-whole-quality-evaluation.mjs',moduleURL));
  const tool=fileURLToPath(new URL('../',import.meta.url)),out=await mkdtemp(path.join(tmpdir(),'return-preview-'));
  t.after(()=>rm(out,{recursive:true,force:true}));
  const chapters=[{id:'c',title:'末班船',body:'灯还亮着。\n\n她站起来，扶住了栏杆。'}];
  const docs={baseline:JSON.stringify({chapters}),candidate:JSON.stringify({chapters})};
  const req=withLiteraryReadingFocus({caseId:'synthetic-story',mode:'compare',baselineChapters:chapters,candidate:{mode:'no_change',chapters},goals:[]});
  let render;const observations=[];
  for(const mode of ['invalid','unknown','definite','valid']) {
    const runRoot=await mkdtemp(path.join(out,'tasks-'));let calls=0;
    const native=await startIndependentReview({request:req,runRoot,modelCitationMode:'paragraph_refs_v1',analyze:async({packet,inputHash})=>{
      calls++;const raw=structuredClone(packet.responseContract.example);
      if(packet.taskStageId==='05-reader-1-pair'){
        if(mode==='unknown')throw Error('offline transport interruption');
        if(mode==='definite')throw Object.assign(Error('offline explicit nondispatch'),{definitelyNotDispatched:true});
        raw.preference=mode==='invalid'?'first':'second';
        if(mode==='invalid') raw.comparisons[0].evidence[0]={anchorId:'A'};
      }
      return {outputText:JSON.stringify(raw),receipt:{provider:'fixture',contextId:`context-${calls}`,invocationId:`call-${calls}`,inputHash}};
    }});
    const d=await diagnose(native),f=await fixture(docs),s=f.manifest.sources[0];
    f.manifest.sources=[s];f.manifest.conclusionId=null;
    f.a.process={status:native.status==='complete'?'complete':'partial',completed:d.counts.sealed,total:d.stages.length,summary:'Synthetic native snapshot'};
    await f.put('a',s.id,'source-report',f.a);
    const root=path.dirname(native.runDir),journal=await readFile(path.join(root,'events.ndjson'),'utf8');
    s.stageDiagnostics={requestHash:native.requestHash,taskMetadataSHA256:sha256(await readFile(path.join(root,'task.json'))),journalId:'events',diagnosticId:'diagnosis',attachments:[]};
    await f.put('diagnosis',s.id,'evidence',d);await f.put('events',s.id,'evidence',journal);
    for(const [i,stage] of d.stages.entries()) for(const attempt of stage.attempts){
      if(!attempt.rawResponse)continue;
      const dir=path.join(native.runDir,'stages',stage.stageId),a=path.join(dir,'attempts',attempt.attemptId);
      const item={stageId:stage.stageId,attemptId:attempt.attemptId,rawId:`raw-${i}`};
      await f.put(item.rawId,s.id,'evidence',await readFile(path.join(a,'raw-response.txt'),'utf8'));
      if(stage.state==='sealed'){
        item.sealId=`seal-${i}`;item.validationId=`validation-${i}`;
        await f.put(item.sealId,s.id,'evidence',await readFile(path.join(dir,'sealed.json'),'utf8'));
        await f.put(item.validationId,s.id,'evidence',await readFile(path.join(a,'validation.json'),'utf8'));
      }
      s.stageDiagnostics.attachments.push(item);
    }
    const view=adaptResult(await f.open()),rows=view.sources[0].stageReturns;
    if(!render){execFileSync(process.execPath,['src/build-preview.mjs',f.dir,await f.seal(),path.join(out,'site'),path.resolve(tool,'../../modules/product/talewick-gui')],{cwd:tool});render=createRequire(import.meta.url)(path.join(out,'render-preview.cjs')).render;}
    const html=render(view,labels),fifth=rows.find(r=>r.label==='05-reader-1-pair');
    assert.equal(fifth.state,d.stages[4].state);
    if(mode==='definite'){assert.equal(fifth.state,'not_dispatched');assert(html.includes('存在明确未派发记录'));}
    assert.equal(fifth.rawPreference,mode==='invalid'?'first':null);
    assert.equal(fifth.sealedPreference,mode==='valid'?'second':null);
    if(mode!=='valid')assert.deepEqual(rows.slice(5).map(row=>row.state),['not_dispatched','not_dispatched']);
    const effective=html.match(/<section aria-label="有效封存偏好">(.*?)<\/section>/s)[1];
    assert(!effective.includes('（first）'));assert.equal(effective.includes('（second）'),mode==='valid');
    assert.equal(html.includes('原回包已保存，引用校验失败'),mode==='invalid');assert.equal(html.includes('未封存原回包自报：倾向先读稿（first）'),mode==='invalid');
    assert.equal(html.includes('05-reader-1-pair</strong> · 返回未知'),mode==='unknown');
    observations.push({mode,nativeStatus:native.status,callbacks:calls,counts:d.counts,fifth:fifth.state,raw:fifth.rawPreference,sealed:fifth.sealedPreference});
  }
  console.log(JSON.stringify({externalModelRequests:0,checkerSHA256:sha256(await readFile(modulePath)),observations}));
});
