import assert from 'node:assert/strict';
import test from 'node:test';
import { createProject } from '../src/model/seed.ts';
import {
  applyChapterRestore, canApplyChapterRestore, canApplyPendingEdit, prepareChapterRestore, undoEditing,
} from '../src/model/store.ts';

function fixture() {
  const project = createProject('合成测试');
  project.title = '当前书名';
  project.chapters = [
    { id: 'a', title: '同名章', body: '当前甲' },
    { id: 'b', title: '同名章', body: '当前乙' },
  ];
  project.versions = [{
    id: 'old', label: '旧存稿', date: '', title: '旧书名',
    chapters: [{ id: 'b', title: '同名章', body: '旧乙' }, { id: 'a', title: '旧章名', body: '' }],
  }];
  project.selectedChapter = 1;
  return project;
}

test('prepare is read-only, binds the two chapters by unique ID and returns detached copies', () => {
  const project = fixture();
  const before = structuredClone(project);
  const plan = prepareChapterRestore(project, 'old', 'a');
  assert.deepEqual(plan, {
    projectId: project.id, versionId: 'old', versionLabel: '旧存稿',
    source: project.versions[0].chapters[1], current: project.chapters[0],
  });
  plan.current.title = '临时预览';
  plan.source.body = '临时改动';
  assert.deepEqual(project, before);
  for (const mutate of [
    p => { p.versions = []; },
    p => { p.versions.push(structuredClone(p.versions[0])); },
    p => { p.chapters.shift(); },
    p => { p.versions[0].chapters.pop(); },
    p => { p.chapters.push(structuredClone(p.chapters[0])); },
    p => { p.versions[0].chapters.push(structuredClone(p.versions[0].chapters[1])); },
    p => { p.chapters[0] = structuredClone(p.versions[0].chapters[1]); },
  ]) {
    const changed = fixture();
    mutate(changed);
    assert.equal(prepareChapterRestore(changed, 'old', 'a'), null);
  }
});

test('only the chosen chapter is restored; the complete before and after drafts are saved once', () => {
  const project = fixture();
  project.runtime = { task: { id: 'synthetic-task' } };
  project.pendingEdits = project.chapters.map(chapter => ({
    id: 'edit-' + chapter.id, chapterId: chapter.id, before: chapter.body, start: 0,
    after: '合成待审', reason: '', status: 'pending',
  }));
  const runtime = project.runtime, edits = project.pendingEdits, source = structuredClone(project.versions[0]);
  const plan = prepareChapterRestore(project, 'old', 'a');
  project.chapters.reverse();
  project.versions[0].chapters.reverse();
  project.chapters[0].body += '。';
  const before = structuredClone(project.chapters);
  assert.equal(canApplyChapterRestore(project, plan), true);
  assert.equal(applyChapterRestore(project, plan), true);
  assert.deepEqual(project.chapters, [before[0], { id: 'a', title: '旧章名', body: '' }]);
  assert.equal(project.selectedChapter, 1);
  assert.equal(project.title, '当前书名');
  assert.equal(project.editorBaseline, undefined);
  assert.equal(project.runtime, runtime);
  assert.equal(project.pendingEdits, edits);
  assert.equal(canApplyPendingEdit(edits[0], project.chapters[1]), false);
  assert.equal(canApplyPendingEdit(edits[1], project.chapters[0]), true);
  assert.equal(project.versions.length, 3);
  const [original, previous, restored] = project.versions;
  assert.deepEqual(original.chapters, source.chapters.reverse());
  assert.deepEqual(previous.chapters, before);
  assert.deepEqual(restored.chapters, project.chapters);
  assert.equal(previous.title, project.title);
  assert.equal(restored.title, project.title);
  const once = structuredClone(project);
  assert.equal(canApplyChapterRestore(project, plan), false);
  assert.equal(applyChapterRestore(project, plan), false);
  assert.deepEqual(project, once);
});

test('stale or ambiguous confirmation has no side effects', () => {
  for (const invalidate of [
    p => { p.id += '-other'; },
    p => { p.versions[0].id = 'other'; },
    p => { p.versions[0].label = '另一存稿'; },
    p => { p.versions = []; },
    p => { p.versions.push(structuredClone(p.versions[0])); },
    p => { p.chapters.push(structuredClone(p.chapters[0])); },
    p => { p.versions[0].chapters.push(structuredClone(p.versions[0].chapters[1])); },
    p => { p.chapters[0].title += '改'; },
    p => { p.chapters[0].body += '改'; },
    p => { p.versions[0].chapters[1].title += '改'; },
    p => { p.versions[0].chapters[1].body += '改'; },
    p => { p.chapters.shift(); },
    p => { p.versions[0].chapters.pop(); },
    (_p, plan) => { plan.current.id = 'b'; },
  ]) {
    const project = fixture();
    const plan = prepareChapterRestore(project, 'old', 'a');
    invalidate(project, plan);
    const before = structuredClone(project);
    assert.equal(canApplyChapterRestore(project, plan), false);
    assert.equal(applyChapterRestore(project, plan), false);
    assert.deepEqual(project, before);
  }
});

test('undo of other edits keeps the restored chapter even if it was absent from the baseline', () => {
  for (const hadTarget of [true, false]) {
    const project = fixture();
    const other = { ...project.chapters[1], body: '编辑前乙' };
    project.editorBaseline = hadTarget ? [other, structuredClone(project.chapters[0])] : [other];
    const plan = prepareChapterRestore(project, 'old', 'a');
    assert.equal(applyChapterRestore(project, plan), true);
    assert.deepEqual(project.chapters[1].body, '当前乙');
    assert.equal(undoEditing(project), true);
    assert.deepEqual(project.chapters.find(c => c.id === 'a'), plan.source);
    assert.deepEqual(project.chapters.find(c => c.id === 'b'), other);
    assert.deepEqual(project.chapters.map(c => c.id), hadTarget ? ['b', 'a'] : ['a', 'b']);
  }
});

test('either a chapter title change or a text change permits restore', () => {
  for (const field of ['title', 'body']) {
    const project = fixture();
    project.chapters[0] = { ...project.versions[0].chapters[1], [field]: '合成新值' };
    const plan = prepareChapterRestore(project, 'old', 'a');
    assert.ok(plan);
    assert.equal(applyChapterRestore(project, plan), true);
    assert.deepEqual(project.chapters[0], plan.source);
  }
});
