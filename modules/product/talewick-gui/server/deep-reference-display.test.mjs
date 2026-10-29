import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { buildWholeQualityDeepReferenceBundle } from '../../../creation/runtime/v04/deep-reference.mjs';

const bundled = await build({ stdin: { contents: `export {DeepReferenceDetails} from './src/features/ManuscriptPanel.tsx';
export {createElement} from 'react'; export {renderToStaticMarkup} from 'react-dom/server';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import {createRequire} from 'node:module'; const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});` } });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const render = value => ui.renderToStaticMarkup(ui.createElement(ui.DeepReferenceDetails, { value }));

function actualBundle(byIssue = []) {
  const chapters = [{ id: 'ch-1', title: '收据', body: '她收好收据，关上抽屉。' }];
  return buildWholeQualityDeepReferenceBundle({
    retrieval: { byIssue, supplies: [], callbackCalls: byIssue.length }, applicability: { assessments: [] },
    plan: { decision: 'preserve_original', items: [], materialDecisions: [] }, materialUse: {},
    finalTextMaterialEvidence: { byIssue: [] }, sourceChapters: chapters, candidateChapters: chapters,
  });
}

test('actual whole bundle with no queries renders no-query; a nonempty uncovered query remains queried without mutating results', () => {
  const zero = actualBundle(), queried = actualBundle([{ issueId: 'issue-1', status: 'uncovered' }]);
  assert.equal(zero.callbackStatus, 'uncovered'); assert.deepEqual(zero.dataQueries, []);
  assert.equal(queried.callbackStatus, 'uncovered'); assert.equal(queried.dataQueries.length, 1);
  for (const [value, expected, excluded] of [
    [zero, '本轮未发起深层参考查询', '已查询，当前问题无可用命中'],
    [queried, '已查询，当前问题无可用命中', '本轮未发起深层参考查询'],
  ]) {
    const before = structuredClone(value), html = render(value);
    assert.ok(html.includes(expected)); assert.ok(!html.includes(excluded));
    assert.ok(html.includes('逐字落点不证明文学改善'));
    assert.deepEqual(value, before, 'display does not rewrite the saved query status or evidence');
  }
});

test('missing or malformed query lists and create records keep their prior presentation', () => {
  const legacy = actualBundle(); delete legacy.dataQueries;
  for (const value of [legacy, { ...legacy, dataQueries: undefined }, { ...legacy, dataQueries: null },
    { ...legacy, dataQueries: {} }, { ...legacy, path: 'create' }, { ...legacy, path: 'create', dataQueries: [] }]) {
    const html = render(value);
    assert.ok(html.includes('已查询，当前问题无可用命中'));
    assert.ok(!html.includes('本轮未发起深层参考查询'));
  }
  assert.ok(render({ ...legacy, path: 'create', callbackStatus: 'not_connected' }).includes('深层参考未接通'));
});
