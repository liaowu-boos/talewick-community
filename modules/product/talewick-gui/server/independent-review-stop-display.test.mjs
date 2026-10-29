import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundled = await build({ stdin: { contents: `export {IndependentReviewStopReason} from './src/features/IndependentReviewPanel.tsx';
export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});` } });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
test('raw stop path is retained only inside closed details with a plain partial-review explanation', () => {
  const error = { code: 'QUOTE_NOT_FOUND', message: '$.goalAssessments[0].baselineEvidence[0] at /private/synthetic/raw.json', recoverable: false };
  const markup = ui.renderToStaticMarkup(ui.createElement(ui.IndependentReviewStopReason, { error, partial: true }));
  const [visible, details] = markup.split('<details');
  assert.match(visible, /目标核查未完成，已保留全文盲评记录/); assert.ok(!visible.includes(error.message));
  assert.match(details, /查看停止原因/); assert.ok(details.includes(error.message)); assert.ok(!/^\s+open(?:\s|=|>)/.test(details));
});
