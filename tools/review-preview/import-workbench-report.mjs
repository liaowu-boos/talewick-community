// Import a trusted, already frozen archive from disk. All routing metadata lives
// inside the hash-pinned manifest; a browser cannot supply paths or report HTML.
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {openEvidenceStore, isId} from './src/evidence-store.mjs';
import {registerWorkbenchReport} from './register-workbench-report.mjs';

export async function importWorkbenchReport(bundle, storePin, planPin, runsDir) {
  const store = await openEvidenceStore(bundle, storePin);
  const config = store.manifest.workbenchReport;
  assert(config && isId(config.sourceId) && ['A','B'].includes(config.baselineVersion) &&
    ['baseline','candidate'].includes(config.target), 'Invalid workbench registration');
  const get = id => store.get(id, config.sourceId, 'evidence');
  const plan = JSON.parse(get(config.planId).bytes);
  assert.equal(plan.planSHA256, planPin, 'Trusted plan hash mismatch');
  const reading = JSON.parse(get(config.readingId).bytes);
  const pair = plan.requests.find(request => request.requestId === 'C1').packet.manuscripts;
  const sources = {};
  for (const role of ['baseline','candidate']) {
    const version = role === 'baseline' ? config.baselineVersion : config.baselineVersion === 'A' ? 'B' : 'A';
    const doc = JSON.parse(store.get(store.manifest[role+'Id'],'manuscript','manuscript').bytes);
    assert.deepEqual(doc.chapters, pair.find(item => item.version === version)?.chapters, 'Archive manuscript differs from planned chapters');
    sources[role] = {version, manuscript:doc};
  }
  return registerWorkbenchReport({runsDir, projectId:config.projectId, ...sources[config.target],
    createdAt:config.createdAt, synthetic:config.synthetic === true,
    adapterInput:{plan, expectedPlanSHA256:planPin, manifest:reading, get, ref:id=>store.ref(id,config.sourceId)}});
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    assert(args.length === 4, 'Usage: node import-workbench-report.mjs BUNDLE STORE_SHA256 PLAN_SHA256 RUNS_DIR');
    const row = await importWorkbenchReport(...args);
    console.log('已登记报告',row.id);
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
