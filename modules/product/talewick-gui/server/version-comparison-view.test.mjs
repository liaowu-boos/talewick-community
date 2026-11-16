import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {VersionComparison} from './src/features/VersionComparison.tsx';
      export {createElement} from 'react';
      export {renderToStaticMarkup} from 'react-dom/server';
    `,
    resolveDir: fileURLToPath(new URL('../', import.meta.url)),
    loader: 'tsx',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  banner: {js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});`},
});
const {VersionComparison, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function render(before, after, beforeLabel = '原稿', afterLabel = '完整候选') {
  const chapter = body => ({id: 'door', title: '门前', body});
  return renderToStaticMarkup(createElement(VersionComparison, {
    previous: {id: 'saved', label: '存稿', date: '2026-01-01', chapters: [chapter(before)]},
    current: [chapter(after)],
    beforeLabel,
    afterLabel,
  }));
}

const original = '她推开门。\n灯下压着一张字条。\n“还来吗？”';
const candidate = '她拉开门。\n灯下压着一张字条。\n“还来吗。”';

for (const [beforeLabel, afterLabel, before, after, removed, added] of [
  ['原稿', '完整候选', original, candidate, ['推', '？'], ['拉', '。']],
  ['完整候选', '原稿', candidate, original, ['拉', '。'], ['推', '？']],
]) {
  test(`comparison renders deletions under ${beforeLabel} and insertions under ${afterLabel}`, () => {
    const html = render(before, after, beforeLabel, afterLabel);
    assert.ok(html.includes(`从${beforeLabel}到${afterLabel}`));
    const sides = [...html.matchAll(/<section aria-label="([^"]+正文)"[^>]*>([\s\S]*?)<\/section>/g)];
    assert.deepEqual(sides.map(side => side[1]), [beforeLabel + '正文', afterLabel + '正文']);
    assert.deepEqual([...sides[0][2].matchAll(/<del>(.*?)<\/del>/gs)].map(match => match[1]), removed);
    assert.deepEqual([...sides[1][2].matchAll(/<ins>(.*?)<\/ins>/gs)].map(match => match[1]), added);
    assert.doesNotMatch(sides[0][2], /<ins\b/);
    assert.doesNotMatch(sides[1][2], /<del\b/);
  });
}

test('identical candidate text is described in the context of the compared versions', () => {
  const html = render(original, original);
  assert.ok(html.includes('从原稿到完整候选'));
  assert.match(html, /章节顺序、章名和正文均相同/);
  assert.doesNotMatch(html, /当前稿件|<(?:ins|del)\b/);
});

test('a long changed chapter offers a closed disclosure without rendering either body', () => {
  const paragraph = '灯芯又短了一截。\n'.repeat(200);
  const html = render('信封朝上。' + paragraph, '信封朝下。' + paragraph);
  const details = html.match(/<details\b([^>]*)>/);
  assert.ok(details, 'expected a chapter disclosure');
  assert.doesNotMatch(details[1], /\bopen\b/);
  assert.match(html, /<summary\b[^>]*>查看整章正文差异<\/summary>/);
  assert.doesNotMatch(html, /信封|灯芯|<(?:del|ins)\b/);
});
