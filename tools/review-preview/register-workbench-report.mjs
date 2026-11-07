// Trusted local producer API. Only the verified renderer can supply the report HTML.
import {isDeepStrictEqual} from 'node:util';
import {randomUUID} from 'node:crypto';
import {mkdir, writeFile, link, unlink, readFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {renderIsolatedReport} from './src/isolated-report.mjs';
import {bytesHash, manuscriptBinding, receiptName} from '../../modules/product/talewick-gui/server/isolated-report-history.mjs';

async function publishFile(dir, name, bytes) {
  const temporary = path.join(dir, '.' + randomUUID());
  await writeFile(temporary, bytes, {flag:'wx', mode:0o600});
  try {
    await link(temporary, path.join(dir, name));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    assert.deepEqual(await readFile(path.join(dir,name)), bytes, 'Existing archive differs');
  } finally { await unlink(temporary); }
}

export async function registerWorkbenchReport({runsDir, projectId, manuscript, version, adapterInput, createdAt, synthetic=false}) {
  assert(['A','B'].includes(version), 'Expected frozen version A or B');
  assert(typeof createdAt === 'string' && new Date(createdAt).toISOString() === createdAt, 'Expected ISO archive date');
  const html = Buffer.from(renderIsolatedReport(adapterInput,{synthetic}));
  assert(html.length <= 32*1024*1024, 'Report is too large');
  const compared = adapterInput.plan.requests.find(r => r.requestId === 'C1').packet.manuscripts;
  const selected = compared.find(m => m.version === version);
  assert(isDeepStrictEqual(selected.chapters, manuscript.chapters), 'Report chapters differ from registered full manuscript');
  const row = {schemaVersion:'workbench-isolated-report-1', projectId, title:manuscript.title, createdAt,
    ...manuscriptBinding(manuscript.title, manuscript.chapters), version, planSHA256:adapterInput.expectedPlanSHA256,
    htmlSHA256:bytesHash(html), synthetic:synthetic === true};
  const receipt = Buffer.from(JSON.stringify(row));
  assert(receipt.length <= 32*1024, 'Registration is too large');
  const id = bytesHash(receipt), name = receiptName(projectId, id), dir = path.join(runsDir,'isolated-reports');
  await mkdir(dir,{recursive:true,mode:0o700});
  await publishFile(dir, row.htmlSHA256 + '.html', html);
  await publishFile(dir, name, receipt);
  return {id, ...row};
}
