import assert from 'node:assert/strict';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const bundled = await build({
  stdin: {
    contents: `
      export {VersionComparison} from './src/features/VersionComparison.tsx';
      export {ChapterRestorePreview} from './src/features/ChapterRestorePreview.tsx';
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
const {ChapterRestorePreview, VersionComparison, createElement, renderToStaticMarkup} =
  await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const source = {id: 'door', title: '门前', body: '她推开门。'};
const current = {...source, body: '她拉开门。'};
const landing = {id: 'landing', title: '楼梯', body: '脚步停了。'};
const noop = () => {};

function comparison(savedChapters, currentChapters, props = {}) {
  return renderToStaticMarkup(createElement(VersionComparison, {
    previous: {id: 'saved', label: '合成存稿', date: '2026-01-01', chapters: savedChapters},
    current: currentChapters,
    ...props,
  }));
}

function buttons(html) {
  return Array.from(html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g), ([, attrs, content]) => ({
    text: content.replace(/<[^>]*>/g, '').trim(),
    disabled: /\sdisabled(?:\s|=|$)/.test(attrs),
  }));
}

test('default, candidate and read-only saved comparisons offer no chapter restore', () => {
  for (const labels of [{}, {beforeLabel: '原稿', afterLabel: '完整候选'}, {beforeLabel: '存稿', afterLabel: '当前稿件'}]) {
    const html = comparison([source], [current], labels);
    assert.match(html, /<del>推<\/del>/);
    assert.deepEqual(buttons(html).filter(button => button.text.includes('恢复')), []);
  }
});

test('editable history offers restore for body or title edits, but not a move, addition or deletion', () => {
  const editable = {onRestoreChapter: noop};
  for (const changed of [current, {...source, title: '门后'}]) {
    const actions = buttons(comparison([source], [changed], editable)).filter(button => button.text.includes('恢复'));
    assert.equal(actions.length, 1);
    assert.equal(actions[0].disabled, false);
  }
  for (const [before, after] of [
    [[source, landing], [landing, source]],
    [[source], [source, landing]],
    [[source, landing], [source]],
  ]) {
    assert.deepEqual(buttons(comparison(before, after, editable)).filter(button => button.text.includes('恢复')), []);
  }
});

function preview(blocked) {
  return renderToStaticMarkup(createElement(ChapterRestorePreview, {
    plan: {projectId: 'synthetic', versionId: 'saved', versionLabel: '合成存稿', source, current},
    pendingCount: 0, onConfirm: noop, onCancel: noop, blocked,
  }));
}

test('restore preview removes current text and inserts the selected saved text', () => {
  const html = preview(false);
  assert.deepEqual([...html.matchAll(/<del>(.*?)<\/del>/gs)].map(match => match[1]), ['拉']);
  assert.deepEqual([...html.matchAll(/<ins>(.*?)<\/ins>/gs)].map(match => match[1]), ['推']);
});

test('blocking the restore disables confirmation while leaving cancellation available', () => {
  for (const blocked of [false, true]) {
    const actions = buttons(preview(blocked));
    const confirm = actions.find(action => action.text === '确认恢复本章');
    const cancel = actions.find(action => action.text === '取消恢复');
    assert.ok(confirm, 'missing restore confirmation');
    assert.ok(cancel, 'missing cancel action');
    assert.equal(confirm.disabled, blocked);
    assert.equal(cancel.disabled, false);
  }
});
