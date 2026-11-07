import test from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fixture} from './fixture.mjs';
import {openEvidenceStore} from '../src/evidence-store.mjs';
import {renderIsolatedReport} from '../src/isolated-report.mjs';
import {buildReadingPlan, validateResponse} from '../../isolated-anchor-reading/review-tools.mjs';
import {chapterIds, manuscripts, makeResponse} from '../../isolated-anchor-reading/synthetic-fixture.mjs';

// Exercise the public disk store as an embedding application would. No captured data.
test('render a partial reading from a sealed disk store; refuse a substituted response', async () => {
  const plan = buildReadingPlan({chapterIds, manuscripts});
  const planPin = plan.planSHA256;
  const bundle = await fixture({baseline:JSON.stringify(manuscripts.A), candidate:JSON.stringify(manuscripts.B)});
  const source = 'synthetic-reader';
  const raw = JSON.stringify(makeResponse(plan.requests[0].packet));
  await bundle.put('plan', source, 'evidence', plan);
  await bundle.put('s1-raw', source, 'evidence', raw);
  await bundle.put('s1-check', source, 'evidence', validateResponse({
    packet: plan.requests[0].packet, expectedPacketSHA256: plan.requests[0].packetSHA256, raw,
  }));
  await bundle.put('reading-index', source, 'evidence', {
    planSHA256:planPin, requests:[{requestId:'S1', rawId:'s1-raw', inspectionId:'s1-check'},
      {requestId:'S2'}, {requestId:'C1'}],
  });
  const storePin = await bundle.seal();
  async function renderStored() {
    const store = await openEvidenceStore(bundle.dir, storePin);
    const get = id => store.get(id, source, 'evidence');
    return renderIsolatedReport({plan:JSON.parse(get('plan').bytes), expectedPlanSHA256:planPin,
      manifest:JSON.parse(get('reading-index').bytes), get, ref:id=>store.ref(id, source)});
  }
  const html = await renderStored();
  assert.ok(html.includes('访客把伞靠在门边。'));
  assert.ok(html.includes('协议与冻结锚点校验通过'));
  assert.ok(!html.includes('合成演示 · 无真实评阅')); // default label does not claim provenance
  const entry = bundle.manifest.entries.find(item => item.id === 's1-raw');
  await writeFile(path.join(bundle.dir, entry.path), 'new bytes');
  await assert.rejects(renderStored, /Evidence hash mismatch/);
});
