import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, createProject } from '../src/model/seed.ts';
import { prepareVersionFork, canApplyVersionFork, appendVersionFork } from '../src/model/version-fork.ts';
import { loadState, saveState, updateChapter } from '../src/model/store.ts';

const copy = value => structuredClone(value);
function fixture() {
  const project = createProject('合成原作品');
  project.title = '当前题名';
  project.chapters = [{ id: 'current', title: '当前章', body: '当前稿' }];
  project.versions = [{
    id: 'saved', label: '合成存稿', date: '2026-01-01', title: '存稿题名',
    chapters: [{ id: 'old-a', title: '旧甲', body: '合成存稿正文' }, { id: 'old-b', title: '旧乙', body: '' }],
  }];
  project.runtime = { task: { id: 'synthetic-task' } };
  project.runtimeHistory = [{ id: 'synthetic-history' }];
  project.importedBaseline = { sourceTaskId: 'synthetic-source' };
  project.attachments = [{ id: 'attachment', name: '合成材料', content: '合成文本' }];
  project.libraryIds = ['material'];
  project.styleId = 'style';
  project.pendingEdits = [{ id: 'edit', chapterId: 'current', before: '当前稿', after: '合成建议' }];
  project.editorBaseline = copy(project.chapters);
  const state = createInitialState();
  state.projects = [project];
  state.activeProjectId = project.id;
  state.page = 'library';
  state.quote = '当前稿';
  state.quoteSource = { chapterId: 'current', start: 0 };
  return { state, project };
}

test('prepare freezes the unique valid source and rejects malformed snapshots', () => {
  const { project } = fixture(), before = copy(project);
  const plan = prepareVersionFork(project, 'saved');
  assert.equal(plan.projectId, project.id);
  assert.equal(plan.fallbackTitle, '存稿题名');
  assert.notEqual(plan.newProjectId, project.id);
  assert.deepEqual(plan.source, project.versions[0]);
  plan.source.chapters[0].body = '预览变化';
  assert.deepEqual(project, before);
  for (const change of [
    p => { p.versions = []; },
    p => { p.versions.push(copy(p.versions[0])); },
    p => { p.versions[0].chapters = []; },
    p => { p.versions[0].chapters = null; },
    p => { p.versions[0].chapters.push(copy(p.versions[0].chapters[0])); },
    p => { p.versions[0].chapters[0] = null; },
    p => { p.versions[0].chapters[0].id = ''; },
    p => { p.versions[0].chapters[0].title = null; },
    p => { p.versions[0].chapters[0].body = 3; },
    p => { p.versions[0].title = 3; },
  ]) {
    const { project: invalid } = fixture();
    change(invalid);
    assert.equal(prepareVersionFork(invalid, 'saved'), null);
  }
});

test('confirmation binds the full source and project, while allowing current manuscript edits', () => {
  const { project } = fixture();
  const plan = prepareVersionFork(project, 'saved');
  project.chapters[0].body += '继续编辑';
  project.title = '当前改名';
  assert.equal(canApplyVersionFork(project, plan), true);
  for (const change of [
    p => { p.id += '-other'; },
    p => { p.versions = []; },
    p => { p.versions.push(copy(p.versions[0])); },
    p => { p.versions[0].label += '改名'; },
    p => { p.versions[0].date += '变更'; },
    p => { p.versions[0].title += '改题'; },
    p => { p.versions[0].chapters.reverse(); },
    p => { p.versions[0].chapters[0].body += '改字'; },
  ]) {
    const { state, project: changed } = fixture();
    const stale = prepareVersionFork(changed, 'saved');
    change(changed);
    const before = copy(state);
    assert.equal(canApplyVersionFork(changed, stale), false);
    assert.equal(appendVersionFork(state, stale, '新作品'), null);
    assert.deepEqual(state, before);
  }
});

test('legacy and empty stored titles bind the fallback title but accept empty chapter bodies', () => {
  for (const title of [undefined, '']) {
    const { state, project } = fixture();
    project.versions[0].title = title;
    const plan = prepareVersionFork(project, 'saved');
    assert.equal(plan.fallbackTitle, '当前题名');
    project.title = '改名';
    assert.equal(canApplyVersionFork(project, plan), false);
    project.title = '当前题名';
    assert.equal(appendVersionFork(state, plan, '新作品'), plan.newProjectId);
    assert.equal(state.projects[1].chapters[1].body, '');
  }
});

test('invalid names, source ambiguity and destination collision are atomic failures', () => {
  for (const invalidate of [
    (_s, _p, plan) => { plan.newProjectId = ''; },
    (s, p) => { s.projects.push(copy(p)); },
    (s, p, plan) => { plan.newProjectId = p.id; },
    (s, _p, plan) => { s.projects.push({ ...createProject('合成冲突'), id: plan.newProjectId }); },
  ]) {
    const { state, project } = fixture(), plan = prepareVersionFork(project, 'saved');
    invalidate(state, project, plan);
    const before = copy(state);
    assert.equal(appendVersionFork(state, plan, '新作品'), null);
    assert.deepEqual(state, before);
  }
  for (const title of ['', ' \t\n　']) {
    const { state, project } = fixture(), plan = prepareVersionFork(project, 'saved'), before = copy(state);
    assert.equal(appendVersionFork(state, plan, title), null);
    assert.deepEqual(state, before);
  }
});

test('fork is clean, independent, navigable, persisted and cannot be appended twice', () => {
  const { state, project } = fixture(), original = copy(project);
  const settings = state.settings;
  const plan = prepareVersionFork(project, 'saved');
  const id = appendVersionFork(state, plan, '  新作品  ');
  const fork = state.projects[1];
  assert.equal(id, plan.newProjectId);
  assert.equal(state.activeProjectId, id);
  assert.equal(state.page, 'create');
  assert.equal(state.quote, '');
  assert.equal(state.quoteSource, undefined);
  assert.equal(state.settings, settings);
  assert.deepEqual(project, original);
  assert.equal(fork.title, '新作品');
  assert.equal(fork.mode, 'auto');
  assert.equal(fork.phase, 'done');
  assert.equal(fork.status, 'ready');
  assert.equal(fork.docOpen, true);
  assert.equal(fork.docMode, 'read');
  for (const field of ['runtime', 'runtimeHistory', 'importedBaseline', 'editorBaseline']) assert.equal(fork[field], undefined);
  for (const field of ['attachments', 'libraryIds', 'pendingEdits']) assert.deepEqual(fork[field], []);
  assert.equal(fork.styleId, null);
  assert.equal(fork.messages.length, 1);
  assert.equal(fork.messages[0].role, 'assistant');
  assert.match(fork.messages[0].text, /从存稿创建/);
  assert.equal(fork.versions.length, 1);
  assert.notEqual(fork.versions[0].id, plan.source.id);
  assert.equal(fork.versions[0].title, '新作品');
  assert.equal(new Set(fork.chapters.map(c => c.id)).size, 2);
  for (const [index, chapter] of fork.chapters.entries()) {
    assert.notEqual(chapter.id, plan.source.chapters[index].id);
    assert.equal(chapter.body, plan.source.chapters[index].body);
    assert.equal(chapter.title, plan.source.chapters[index].title);
    assert.notEqual(chapter, fork.versions[0].chapters[index]);
  }
  const once = copy(state);
  assert.equal(appendVersionFork(state, plan, '重复作品'), null);
  assert.deepEqual(state, once);
  updateChapter(fork, fork.chapters[0].id, { body: '独立新正文' });
  assert.deepEqual(project, original);
  assert.equal(fork.versions[0].chapters[0].body, '合成存稿正文');
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  assert.deepEqual(saveState(state, storage), { ok: true });
  const restored = loadState(storage);
  const loaded = restored.projects.find(p => p.id === id);
  assert.equal(restored.activeProjectId, id);
  assert.equal(loaded.chapters[0].body, '独立新正文');
  assert.equal(loaded.versions[0].chapters[0].body, '合成存稿正文');
  assert.equal(loaded.runtime, undefined);
  assert.deepEqual(loaded.runtimeHistory, []);
  assert.equal(loaded.importedBaseline, undefined);
  restored.activeProjectId = project.id;
  const originalAgain = restored.projects.find(p => p.id === restored.activeProjectId);
  assert.deepEqual(originalAgain.chapters, original.chapters);
  assert.deepEqual(originalAgain.versions, original.versions);
});
