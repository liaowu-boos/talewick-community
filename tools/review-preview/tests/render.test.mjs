import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture } from './fixture.mjs';

test('render the synthetic bundle with the built GUI and verify escaped and pending states', async t => {
  const tool = fileURLToPath(new URL('../', import.meta.url));
  const gui = path.resolve(tool, '../../modules/product/talewick-gui');
  const out = await mkdtemp(path.join(tmpdir(), 'review-preview-render-'));
  t.after(() => rm(out, { recursive: true, force: true }));
  const bundle = await fixture();
  execFileSync(process.execPath, ['src/build-preview.mjs', bundle.dir, await bundle.seal(), path.join(out, 'site'), gui], { cwd: tool });
  execFileSync(process.execPath, ['tests/ui-check.mjs', path.join(out, 'render-preview.cjs')], { cwd: tool });
});
