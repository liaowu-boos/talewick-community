import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {fixture} from './fixture.mjs';
import {createDemoInput} from '../demo-isolated-input.mjs';
import {importWorkbenchReport} from '../import-workbench-report.mjs';
import {isolatedReportRouter, listReports, receiptName, bytesHash} from '../../../modules/product/talewick-gui/server/isolated-report-history.mjs';
import {manuscripts} from '../../isolated-anchor-reading/synthetic-fixture.mjs';

async function frozenBundle() {
  const demo = createDemoInput();
  const doc = chapters => ({title:'纸伞',chapters});
  const bundle = await fixture({baseline:JSON.stringify(doc(manuscripts.A)),candidate:JSON.stringify(doc(manuscripts.B))});
  const put = (id, data) => bundle.put(id, 'reader', 'evidence', data);
  await put('plan', demo.plan);
  await put('reading', demo.manifest);
  for (const row of demo.manifest.requests) {
    for (const id of [row.rawId,row.inspectionId,row.semanticReviewId].filter(Boolean)) {
      await put(id,demo.get(id).bytes.toString());
    }
  }
  bundle.manifest.workbenchReport = {projectId:'paper',sourceId:'reader',planId:'plan',readingId:'reading',
    baselineVersion:'A',target:'baseline',synthetic:true,createdAt:'2026-01-01T00:00:00.000Z'};
  return {bundle, planPin:demo.expectedPlanSHA256, baseline:doc(manuscripts.A)};
}

test('imported history opens only the registered project and full manuscript, and checks HTML at open',async t => {
  const runsDir = await mkdtemp(path.join(tmpdir(),'history-'));
  t.after(()=>rm(runsDir,{recursive:true,force:true}));
  const {bundle,planPin,baseline} = await frozenBundle();
  const pin = await bundle.seal();
  const register = () => importWorkbenchReport(bundle.dir,pin,planPin,runsDir);
  const [r,again] = await Promise.all([register(),register()]);
  assert.equal(again.id,r.id);
  const root = path.join(runsDir,'isolated-reports');
  const history = await listReports(root,'paper');
  assert.equal(history.length,1);
  assert.deepEqual(Object.keys(history[0]).sort(),['id','title','synthetic','createdAt','manuscriptRevision'].sort());
  const openReport = async (extra={}) => {
    let html, status;
    const router = isolatedReportRouter({root,bodyJSON:async()=>({projectId:'paper',manuscriptRevision:r.manuscriptRevision,...baseline,...extra})});
    await router({method:'POST'},{writeHead:s=>{status=s;},end:b=>{html=b.toString();}},new URL('http://localhost/api/isolated-reports/'+r.id+'/open'));
    return {html,status};
  };
  const ok=await openReport();assert.equal(ok.status,200);assert.match(ok.html,/人工语义复核未通过/);
  for(const extra of [{title:'纸伞。'},{chapters:manuscripts.B},{chapters:baseline.chapters.toReversed()},
    {chapters:baseline.chapters.slice(1)},{manuscriptRevision:'forged'}]) {
    await assert.rejects(openReport(extra),{status:409});
  }
  await assert.rejects(openReport({projectId:'foreign'}),{status:404});
  const {id, ...metadata} = r;
  const invalid = Buffer.from(JSON.stringify({...metadata,createdAt:42}));
  await writeFile(path.join(root,receiptName('paper',bytesHash(invalid))),invalid);
  assert.deepEqual(await listReports(root,'paper'),history);
  await writeFile(path.join(root,r.htmlSHA256+'.html'),'substituted bytes');
  await assert.rejects(openReport(),{status:409});
  await writeFile(path.join(root,receiptName('paper',r.id)),JSON.stringify({...r,title:'forged'}));
  assert.deepEqual(await listReports(root,'paper'),[]);
  await assert.rejects(openReport(),{status:409});
});

test('import refuses swapped sides, another source and an untrusted plan digest',async t=>{
  const runsDir=await mkdtemp(path.join(tmpdir(),'history-binding-'));
  t.after(()=>rm(runsDir,{recursive:true,force:true}));
  const {bundle,planPin}=await frozenBundle();
  const run=async pin=>importWorkbenchReport(bundle.dir,await bundle.seal(),pin,runsDir);
  await assert.rejects(run('0'.repeat(64)),/plan hash mismatch/);
  bundle.manifest.workbenchReport.baselineVersion='B';
  await assert.rejects(run(planPin),/differs from planned chapters/);
  bundle.manifest.workbenchReport.sourceId='foreign';
  await assert.rejects(run(planPin),/source mismatch/);
  assert.deepEqual(await listReports(path.join(runsDir,'isolated-reports'),'paper'),[]);
});
