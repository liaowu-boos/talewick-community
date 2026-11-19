import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, createProject } from '../src/model/seed.ts';
import { loadState, renameVersion, saveState } from '../src/model/store.ts';
import { findReportVersions } from '../src/model/report-version.ts';
import { manuscriptRevision } from '../src/model/runtime.ts';

function fixture() {
  const project = createProject('合成命名测试');
  project.title = '当前书名';
  project.chapters = [{ id: 'chapter', title: '当前章节', body: '当前正文' }];
  project.versions = [
    { id: 'saved-a', label: '原名称', date: '2026-01-01T00:00:00.000Z', title: '封存书名',
      chapters: [{ id: 'chapter', title: '封存章节', body: '封存正文' }] },
    { id: 'saved-b', label: '另一名称', date: '2026-01-02T00:00:00.000Z',
      chapters: [{ id: 'chapter', title: '旧版章节', body: '旧版正文' }] },
  ];
  project.editorBaseline = [{ id: 'chapter', title: '编辑前章名', body: '编辑前正文' }];
  project.pendingEdits = [{ id: 'edit', chapterId: 'chapter', before: '当前正文',
    after: '待审正文', start: 0, reason: '合成建议', status: 'pending' }];
  project.runtime = { task: { id: 'synthetic-task' } };
  project.updatedAt = '2000-01-01T00:00:00.000Z';
  return project;
}

test('rename trims only outer whitespace and mutates only the label and project timestamp', () => {
  const project = fixture();
  const before = structuredClone(project);
  const versions = project.versions, saved = versions[0], chapters = saved.chapters;
  const current = project.chapters, baseline = project.editorBaseline;
  const edits = project.pendingEdits, runtime = project.runtime;
  assert.equal(renameVersion(project, 'saved-a', ' \n  第一稿  修订版  \t', '原名称'), true);
  assert.equal(project.versions, versions);
  assert.equal(project.versions[0], saved);
  assert.equal(saved.chapters, chapters);
  assert.equal(project.chapters, current);
  assert.equal(project.editorBaseline, baseline);
  assert.equal(project.pendingEdits, edits);
  assert.equal(project.runtime, runtime);
  assert.notEqual(project.updatedAt, before.updatedAt);
  assert.equal(new Date(project.updatedAt).toISOString(), project.updatedAt);
  before.versions[0].label = '第一稿  修订版';
  before.updatedAt = project.updatedAt;
  assert.deepEqual(project, before);
});

test('empty, missing, stale and duplicate identities fail without writing anything', () => {
  for (const [id, label, expected] of [
    ['saved-a', '', '原名称'], ['saved-a', ' \n\t　', '原名称'],
    ['missing', '新名称', '原名称'], ['saved-a', '新名称', '过期名称'],
    ['saved-a', '原名称', '过期名称'], ['saved-a', '新名称', ' 原名称 '],
  ]) {
    const project = fixture();
    const before = structuredClone(project);
    Object.freeze(project.versions[0]);
    Object.freeze(project);
    assert.equal(renameVersion(project, id, label, expected), false);
    assert.deepEqual(project, before);
  }
  for (const label of ['新名称', '原名称']) {
    const project = fixture();
    project.versions.push(structuredClone(project.versions[0]));
    const before = structuredClone(project);
    assert.equal(renameVersion(project, 'saved-a', label, '原名称'), false);
    assert.deepEqual(project, before);
  }
});

test('same normalized label is a successful no-op and a stale retry cannot overwrite a later name', () => {
  const project = fixture();
  assert.equal(renameVersion(project, 'saved-a', '新名称', '原名称'), true);
  const before = structuredClone(project);
  Object.freeze(project.versions[0]);
  Object.freeze(project);
  assert.equal(renameVersion(project, 'saved-a', '  新名称  ', '新名称'), true);
  assert.equal(renameVersion(project, 'saved-a', '新名称', '原名称'), false);
  assert.deepEqual(project, before);
});

test('different snapshots can share a label and labels have no added length limit', () => {
  const project = fixture();
  assert.equal(renameVersion(project, 'saved-a', '另一名称', '原名称'), true);
  assert.deepEqual(project.versions.map(version => version.label), ['另一名称', '另一名称']);
  const longLabel = '合成长名称'.repeat(1000);
  assert.equal(renameVersion(project, 'saved-b', longLabel, '另一名称'), true);
  assert.equal(project.versions[1].label, longLabel);
});

test('named and legacy snapshots retain report matches and revisions after rename and persistence', () => {
  const project = fixture();
  // Runtime preservation is covered above; this test stores a normal project without a task.
  delete project.runtime;
  const reports = project.versions.map((version, index) => {
    const title = version.title ?? '旧版封存书名';
    return { id: 'report-' + index, title, manuscriptRevision: manuscriptRevision({title, chapters: version.chapters}),
      createdAt: '2026-01-03T00:00:00.000Z', synthetic: true };
  });
  const ids = versions => [...findReportVersions(versions, reports)].map(([id, version]) => [id, version.id]);
  const beforeMatches = ids(project.versions);
  assert.equal(beforeMatches.length, 2);
  for (const version of project.versions) {
    assert.equal(renameVersion(project, version.id, '同一新名称', version.label), true);
  }
  assert.deepEqual(ids(project.versions), beforeMatches);
  const state = createInitialState();
  state.projects = [project];
  state.activeProjectId = project.id;
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(saveState(state, storage), {ok: true});
  const reloaded = loadState(storage).projects.find(item => item.id === project.id);
  assert.ok(reloaded);
  assert.deepEqual(reloaded.versions, project.versions);
  assert.equal(reloaded.updatedAt, project.updatedAt);
  assert.deepEqual(ids(reloaded.versions), beforeMatches);
  for (const [index, version] of reloaded.versions.entries()) {
    assert.equal(manuscriptRevision({ title: reports[index].title, chapters: version.chapters }),
      reports[index].manuscriptRevision);
  }
});
