import assert from 'node:assert/strict';
import test from 'node:test';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';

// Normally installed in GUI/server. TALEWICK_GUI also permits read-only auditing
// from an output directory without copying or editing the production component.
const root = process.env.TALEWICK_GUI || fileURLToPath(new URL('../', import.meta.url));
const requireFromGui = createRequire(resolve(root, 'package.json'));
const {build} = requireFromGui('esbuild');
const bundled = await build({
  stdin: {
    contents: `
      export {VersionExportPreview} from './src/features/VersionExportPreview.tsx';
      export {createElement} from 'react';
      export {renderToStaticMarkup} from 'react-dom/server';
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  banner: {js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(resolve(root, 'package.json'))});`},
});
const {VersionExportPreview, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function render(title, blocked = false) {
  const plan = {projectId: 'synthetic-project', version: {
    id: 'synthetic-saved', label: '合成旧存稿标签', date: '2026-01-01T00:00:00.000Z',
    ...(title === undefined ? {} : {title}),
    chapters: [{id: 'a', title: '甲章', body: '合成甲正文'}, {id: 'b', title: '乙章', body: '合成乙正文'}],
  }};
  const before = structuredClone(plan);
  const html = renderToStaticMarkup(createElement(VersionExportPreview, {
    plan, blocked,
    onDownload: () => { assert.fail('SSR must not trigger a download'); },
    onCancel: () => { assert.fail('SSR must not trigger navigation'); },
  }));
  assert.deepEqual(plan, before, 'rendering must preserve the source plan');
  return html;
}

function button(html, label) {
  const matches = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, , content]) => content.replace(/<[^>]*>/g, '').trim() === label);
  assert.equal(matches.length, 1, `exactly one ${label} button`);
  return matches[0][1];
}
const disabledAttribute = /\sdisabled(?:=|\s|$)/;
function assertDownloads(html, disabled) {
  for (const label of ['下载 Markdown', '下载 TXT']) {
    if (disabled) assert.match(button(html, label), disabledAttribute);
    else assert.doesNotMatch(button(html, label), disabledAttribute);
  }
  assert.doesNotMatch(button(html, '返回存稿'), disabledAttribute);
}

test('named snapshot identifies its label and original title without a title replacement input', () => {
  const html = render('合成历史原题');
  for (const text of ['合成旧存稿标签', '存稿书名「合成历史原题」', '共 2 章', '不包含修改建议或评阅报告', '不修改当前稿或原存稿']) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /aria-label="导出所选存稿"/);
  assert.doesNotMatch(html, /<input\b|存稿未记录书名|请填写导出书名/);
  assertDownloads(html, false);
});

for (const [kind, title] of [['absent', undefined], ['empty', ''], ['whitespace', ' \t\n ']]) {
  test(`${kind} snapshot title shows an empty explicit-title input and disables both downloads`, () => {
    const html = render(title);
    for (const text of ['存稿未记录书名', '导出书名', '仅用于本次导出', '不会补写存稿']) {
      assert.ok(html.includes(text), text);
    }
    const inputs = [...html.matchAll(/<input\b([^>]*)>/g)];
    assert.equal(inputs.length, 1, 'one explicit title field');
    assert.match(inputs[0][1], /\svalue=""/);
    assertDownloads(html, true);
  });
}

test('blocked named snapshot disables both downloads, explains staleness and permits return', () => {
  const html = render('合成历史原题', true);
  assertDownloads(html, true);
  assert.match(html, /role="alert"[^>]*>[^<]*所选存稿已变化或已移除/);
  assert.ok(html.includes('请返回存稿并重新打开导出'));
  assert.doesNotMatch(html, /<input\b/);
});
