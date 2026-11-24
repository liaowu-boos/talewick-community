import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';

const task = {
  id: 'synthetic-recheck',
  projectId: 'synthetic-project',
  sourceTaskId: 'synthetic-source',
  candidateSha256: 'a'.repeat(64),
  checkerVersion: 'candidate-recheck-cross-chapter-review-r08-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  status: 'reviewed_no_reported_conflict',
  gate: {eligible: true, reason: 'replay_required_on_selection'},
  error: null,
  report: {
    checkedChapterIds: ['door'],
    counts: {confirmed_conflict: 0, ambiguous: 0, resolved: 1},
    findings: [{
      groupId: 'synthetic-finding',
      status: 'resolved',
      summary: '合成历史记录：来信与开门发生在同一天。',
      evidence: [{chapterId: 'door', role: 'evidence', quote: '她把信放在门边。'}],
    }],
  },
};

const bundled = await build({
  stdin: {
    contents: `
      export {CandidateRecheckPanel} from './src/features/CandidateRecheckPanel.tsx';
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
  plugins: [{
    name: 'seed-loaded-recheck-for-ssr',
    setup(builder) {
      builder.onLoad({filter: /[/\\]CandidateRecheckPanel\.tsx$/}, async ({path}) => {
        const source = await readFile(path, 'utf8');
        // SSR does not run the effect that loads history. Seed only that state;
        // the production JSX, selection gate and button components render normally.
        const initializer = 'useState<CandidateRecheckTask[]>([])';
        assert.equal(source.split(initializer).length, 2, 'update the SSR history seed if the state initializer changes');
        return {
          contents: source.replace(initializer, 'useState<CandidateRecheckTask[]>(' + JSON.stringify([task]) + ')'),
          loader: 'tsx',
        };
      });
    },
  }],
});
const {CandidateRecheckPanel, createElement, renderToStaticMarkup} = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
);

function render(props = {}) {
  return renderToStaticMarkup(createElement(CandidateRecheckPanel, {
    project: {id: task.projectId, runtime: {task: {id: task.sourceTaskId}}},
    onSelect: async () => {},
    ...props,
  }));
}

function button(html, name) {
  const found = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .find(([, , content]) => content.replace(/<[^>]*>/g, '').trim() === name);
  assert.ok(found, 'expected button: ' + name);
  return {disabled: /\sdisabled(?:\s|=|$)/.test(found[1])};
}

for (const [name, props] of [['omitted', {}], ['false', {sourceChanged: false}]]) {
  test('sourceChanged ' + name + ' retains existing recheck and selection actions', () => {
    const html = render(props);
    assert.equal(button(html, '新建候选复查').disabled, false);
    assert.equal(button(html, '明确选择完整候选').disabled, false);
    assert.doesNotMatch(html, /当前书名或正文已变化/);
  });
}

test('a changed source disables both actions and explains the old manuscript binding', () => {
  const html = render({sourceChanged: true});
  assert.equal(button(html, '新建候选复查').disabled, true);
  assert.equal(button(html, '明确选择完整候选').disabled, true);
  assert.match(html, /role="status"[^>]*>当前书名或正文已变化，此候选对应旧稿/);
  assert.doesNotMatch(html, /未保存|草稿/);
});

test('a changed source still renders the historical report and quoted evidence', () => {
  const html = render({sourceChanged: true});
  assert.match(html, /<details\b/);
  assert.match(html, /<summary\b[^>]*>复查事实与分歧/);
  assert.ok(html.includes(task.report.findings[0].summary));
  assert.ok(html.includes(task.report.findings[0].evidence[0].quote));
  assert.ok(html.includes(task.sourceTaskId));
});
