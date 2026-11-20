import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/model/seed.ts';
import { prepareVersionRestore, canApplyVersionRestore, applyVersionRestore, restoreVersion } from '../src/model/store.ts';

const copy = value => structuredClone(value);
function fixture() {
  const project = createProject('合成整稿恢复');
  project.title = '当前书名';
  project.chapters = [
    { id: 'a', title: '当前甲', body: '正文甲' },
    { id: 'b', title: '当前乙', body: '正文乙' },
  ];
  project.versions = [{ id: 'old', label: '旧名称', date: '2026-01-01', title: '旧书名',
    chapters: [{ id: 'b', title: '旧乙', body: '' }, { id: 'a', title: '旧甲', body: '旧正文' }] }];
  project.pendingEdits = [
    { id: 'edit-a', chapterId: 'a', before: '正文甲', after: '待审甲', reason: '合成', status: 'pending' },
    { id: 'edit-b', chapterId: 'b', before: '正文乙', after: '待审乙', reason: '合成', status: 'pending' },
  ];
  project.editorBaseline = copy(project.chapters);
  project.docMode = 'edit';
  project.selectedChapter = 1;
  project.runtime = { task: { id: 'synthetic-task' } };
  return project;
}

test('preview contains detached source, current manuscript and every pending edit without mutation', () => {
  const project = fixture(), before = copy(project);
  const plan = prepareVersionRestore(project, 'old');
  assert.deepEqual(plan, { projectId: project.id, source: project.versions[0],
    current: { title: project.title, chapters: project.chapters }, pendingEdits: project.pendingEdits });
  assert.equal(canApplyVersionRestore(project, plan), true);
  plan.source.chapters[0].body = '预览改动';
  plan.current.chapters[0].body = '预览改动';
  plan.pendingEdits[0].after = '预览改动';
  assert.deepEqual(project, before);
  assert.equal(canApplyVersionRestore(project, plan), false);
});

test('preparation rejects missing, ambiguous, empty and malformed snapshots', () => {
  for (const change of [
    p => { p.versions = []; },
    p => { p.versions.push(copy(p.versions[0])); },
    p => { p.versions[0].chapters = []; },
    p => { p.versions[0].chapters = null; },
    p => { p.versions[0].chapters.push(copy(p.versions[0].chapters[0])); },
    p => { p.versions[0].chapters[0] = null; },
    p => { p.versions[0].chapters[0].id = ''; },
    p => { p.versions[0].chapters[0].id = 1; },
    p => { p.versions[0].chapters[0].title = null; },
    p => { p.versions[0].chapters[0].body = 1; },
    p => { p.versions[0].title = 1; },
  ]) {
    const project = fixture(); change(project);
    const before = copy(project);
    assert.equal(prepareVersionRestore(project, 'old'), null);
    assert.deepEqual(project, before);
  }
});

test('only actual manuscript changes permit preparation, including title and order', () => {
  const project = fixture();
  project.versions[0].title = project.title;
  project.versions[0].chapters = copy(project.chapters);
  assert.equal(prepareVersionRestore(project, 'old'), null);
  project.versions[0].title = '另一书名';
  assert.ok(prepareVersionRestore(project, 'old'));
  project.versions[0].title = project.title;
  project.versions[0].chapters.reverse();
  assert.ok(prepareVersionRestore(project, 'old'));
});

test('any source, current manuscript or pending-edit change expires confirmation with zero writes', () => {
  for (const change of [
    p => { p.id += '-other'; },
    p => { p.versions = []; },
    p => { p.versions.push(copy(p.versions[0])); },
    p => { p.versions[0].id += '-other'; },
    p => { p.versions[0].label += '改名'; },
    p => { p.versions[0].date += '改日期'; },
    p => { p.versions[0].title += '改'; },
    p => { p.versions[0].chapters.reverse(); },
    p => { p.versions[0].chapters[0].body += '改'; },
    p => { p.versions[0].chapters[0].title += '改'; },
    p => { p.title += '改'; },
    p => { p.chapters.reverse(); },
    p => { p.chapters[0].body += '改'; },
    p => { p.chapters[0].title += '改'; },
    p => { p.pendingEdits.reverse(); },
    p => { p.pendingEdits.pop(); },
    p => { p.pendingEdits[0].status = 'accepted'; },
    p => { p.pendingEdits[0].after += '改'; },
    p => { p.pendingEdits.push({ ...p.pendingEdits[0], id: 'edit-c' }); },
  ]) {
    const project = fixture(), plan = prepareVersionRestore(project, 'old');
    change(project);
    const before = copy(project);
    assert.equal(canApplyVersionRestore(project, plan), false);
    assert.equal(applyVersionRestore(project, plan), false);
    assert.deepEqual(project, before);
  }
});

test('confirmed restore saves both manuscripts and performs the existing full-restore cleanup once', () => {
  const project = fixture(), before = copy(project), runtime = project.runtime;
  const plan = prepareVersionRestore(project, 'old');
  assert.equal(applyVersionRestore(project, plan), true);
  assert.equal(project.title, plan.source.title);
  assert.deepEqual(project.chapters, plan.source.chapters);
  assert.notEqual(project.chapters, plan.source.chapters);
  assert.equal(project.versions.length, 3);
  assert.deepEqual(project.versions[0], before.versions[0]);
  assert.deepEqual(project.versions[1].chapters, before.chapters);
  assert.equal(project.versions[1].title, before.title);
  assert.deepEqual(project.versions[2].chapters, project.chapters);
  assert.equal(project.versions[2].title, project.title);
  assert.deepEqual(project.pendingEdits, []);
  assert.equal(project.editorBaseline, null);
  assert.equal(project.docMode, 'read');
  assert.equal(project.runtime, runtime);
  const restored = copy(project);
  assert.equal(applyVersionRestore(project, plan), false);
  assert.deepEqual(project, restored);
});

test('legacy or empty saved titles inherit current title, with existing selection clamping', () => {
  for (const title of [undefined, '']) {
    const project = fixture();
    project.versions[0].title = title;
    project.versions[0].chapters = [project.versions[0].chapters[0]];
    const plan = prepareVersionRestore(project, 'old');
    assert.ok(plan);
    assert.equal(applyVersionRestore(project, plan), true);
    assert.equal(project.title, '当前书名');
    assert.equal(project.selectedChapter, 0);
    assert.equal(project.chapters[0].body, '');
  }
});

test('old direct restore keeps its no-change success behavior', () => {
  const project = fixture();
  project.versions[0].title = project.title;
  project.versions[0].chapters = copy(project.chapters);
  assert.equal(prepareVersionRestore(project, 'old'), null);
  assert.equal(restoreVersion(project, 'old'), true);
  assert.equal(project.versions.length, 3);
  assert.deepEqual(project.pendingEdits, []);
});
