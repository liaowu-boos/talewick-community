import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const release = 'e68f56d4b840cda7d31926b7d07d0e1e444031cd';

// Exercise the old writer itself. Only the synthetic input and the generation
// recipe are checked in. CI checks out history so this test runs offline.
export async function buildReleasedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'talewick-historical-writer-'));
  try {
    const directory = 'modules/validation/runtime';
    const cwd = fileURLToPath(new URL('../../../../', import.meta.url));
    const archive = execFileSync('git', ['archive', release, directory], { cwd, maxBuffer: 8 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', root], { input: archive });
    const load = filename => import(pathToFileURL(join(root, directory, filename)));
    const runtime = await load('independent-review-task.mjs');
    const { withLiteraryReadingFocus } = await load('focused-whole-quality-evaluation.mjs');
    const runRoot = join(root, 'evidence');
    await mkdir(runRoot);
    const request = withLiteraryReadingFocus({ caseId: 'synthetic-release-test', mode: 'single',
      baselineChapters: [{ id: 'c', title: '试纸', body: '台面放着两张试纸。\n\n左侧的试纸标有圆点，右侧的试纸标有一个方块。' }] });
    let ordinal = 0;
    const analyze = quote => async input => {
      const response = structuredClone(input.packet.responseContract.example);
      if (quote) response.entries[0].focusAssessments[0].evidence[0] = { blindId: 'M', chapterId: 'c', quote, start: null };
      const id = 'synthetic-' + (++ordinal);
      return { outputText: JSON.stringify(response), receipt: { provider: 'fixture', contextId: id, invocationId: id, inputHash: input.inputHash } };
    };
    const failed = await runtime.startIndependentReview({ runRoot, request, analyze: analyze('合成文本没有这句话。') });
    assert.equal(failed.error.code, 'QUOTE_NOT_FOUND');
    const args = { ...failed, stageId: failed.error.stage };
    const inspection = await runtime.inspectInvalidIndependentReadingRetry(args);
    const retried = await runtime.retryInvalidIndependentReading({ ...args, inspectionHash: inspection.inspectionHash, analyze: analyze() });
    const second = await runtime.resumeIndependentReview({ ...retried, analyze: analyze('台面放着两张试纸。左侧的试纸标有圆点，') });
    assert.equal(second.error.code, 'QUOTE_NOT_FOUND');
    const recovered = await runtime.recoverIndependentReviewPositions({ ...second, mode: 'whitespace_only' });
    assert.equal(recovered.status, 'complete');
    const parent = dirname(recovered.runDir), files = {};
    for (const entry of await readdir(parent, { recursive: true, withFileTypes: true })) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        files[relative(parent, path)] = await readFile(path, 'utf8');
      }
    }
    return { origin: release, files };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
