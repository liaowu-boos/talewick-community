import assert from 'node:assert/strict';
import test from 'node:test';
import { createInitialState, createProject } from '../src/model/seed.ts';
import { prepareProjectTitle, canApplyProjectTitle, applyProjectTitle } from '../src/model/project-title.ts';
import { manuscriptRevision } from '../src/model/runtime.ts';
import { findReportVersions } from '../src/model/report-version.ts';
import { loadState, saveState } from '../src/model/store.ts';

const copy = value => structuredClone(value);
function fixture() {
  const p = createProject('合成改名测试', 'auto');
  p.title = '旧书名';
  p.chapters = [{ id: 'a', title: '甲', body: '合成正文甲' }, { id: 'b', title: '乙', body: '' }];
  p.versions = [{ id: 'old', title: p.title, label: '原存稿', date: '2026-01-01', chapters: copy(p.chapters) }];
  p.editorBaseline = [{ id: 'a', title: '甲', body: '编辑前正文' }, copy(p.chapters[1])];
  p.pendingEdits = [{ id: 'edit', chapterId: 'a', before: '正文', after: '建议', reason: '合成', status: 'pending' }];
  p.runtime = { task: { id: 'synthetic-task', status: 'completed' } };
  p.runtimeHistory = [{ id: 'synthetic-history' }];
  p.updatedAt = '2000-01-01T00:00:00.000Z';
  return p;
}

test('preparation is detached, allocates two unused IDs, and rejects malformed manuscripts', () => {
  const p = fixture(), before = copy(p), plan = prepareProjectTitle(p);
  assert.deepEqual(plan.chapters, p.chapters);
  assert.notEqual(plan.beforeVersionId, plan.afterVersionId);
  assert.ok(!p.versions.some(v => [plan.beforeVersionId, plan.afterVersionId].includes(v.id)));
  plan.chapters[0].body = '改预览';
  assert.deepEqual(p, before);
  assert.equal(canApplyProjectTitle(p, plan), false);
  for (const mutate of [
    p => { p.chapters = []; }, p => { p.chapters = null; },
    p => { p.chapters.push(copy(p.chapters[0])); }, p => { p.chapters[0] = null; },
    p => { p.chapters[0].id = ''; }, p => { p.chapters[0].body = 1; },
    p => { p.chapters[0].title = null; }, p => { p.title = null; },
  ]) {
    const invalid = fixture(); mutate(invalid); const original = copy(invalid);
    assert.equal(prepareProjectTitle(invalid), null);
    assert.deepEqual(invalid, original);
  }
});

test('both preparation and confirmation block submitting, queued and running tasks', () => {
  for (const binding of [{ submitting: true }, { task: { status: 'queued' } }, { task: { status: 'running' } }]) {
    const p = fixture(), plan = prepareProjectTitle(p);
    p.runtime = binding;
    const before = copy(p);
    assert.equal(prepareProjectTitle(p), null);
    assert.equal(canApplyProjectTitle(p, plan), false);
    assert.equal(applyProjectTitle(p, plan, '新书名'), false);
    assert.deepEqual(p, before);
  }
});

test('stale content, wrong project and snapshot ID conflicts refuse with zero writes', () => {
  for (const mutate of [
    p => { p.id += '-other'; }, p => { p.title += '改'; },
    p => { p.chapters.reverse(); }, p => { p.chapters[0].id += '改'; },
    p => { p.chapters[0].title += '改'; }, p => { p.chapters[0].body += '改'; },
    p => { p.chapters.pop(); },
    (p, plan) => { p.versions.push({ ...p.versions[0], id: plan.beforeVersionId }); },
    (p, plan) => { p.versions.push({ ...p.versions[0], id: plan.afterVersionId }); },
    (_p, plan) => { plan.afterVersionId = plan.beforeVersionId; },
    (_p, plan) => { plan.beforeVersionId = ''; },
    (_p, plan) => { plan.afterVersionId = ''; },
  ]) {
    const p = fixture(), plan = prepareProjectTitle(p); mutate(p, plan); const before = copy(p);
    assert.equal(canApplyProjectTitle(p, plan), false);
    assert.equal(applyProjectTitle(p, plan, '新书名'), false);
    assert.deepEqual(p, before);
  }
});

test('blank and normalized same names fail, while successful rename writes exactly two independent snapshots', () => {
  const p = fixture(), plan = prepareProjectTitle(p), initial = copy(p);
  for (const title of ['', ' \n　\t', p.title, '  ' + p.title + '  ']) {
    assert.equal(applyProjectTitle(p, plan, title), false);
    assert.deepEqual(p, initial);
  }
  p.pendingEdits[0].after = '后来建议';
  const before = copy(p), chapters = p.chapters, baseline = p.editorBaseline;
  const runtime = p.runtime, history = p.runtimeHistory, edits = p.pendingEdits, originalVersion = p.versions[0];
  assert.equal(applyProjectTitle(p, plan, '  新 书名  '), true);
  assert.equal(p.title, '新 书名');
  assert.equal(p.chapters, chapters); assert.equal(p.editorBaseline, baseline);
  assert.equal(p.runtime, runtime); assert.equal(p.runtimeHistory, history); assert.equal(p.pendingEdits, edits);
  assert.equal(p.versions[0], originalVersion);
  assert.deepEqual({ ...p, title: before.title, updatedAt: before.updatedAt, versions: before.versions }, before);
  const [pre, post] = p.versions.slice(1);
  assert.equal(pre.id, plan.beforeVersionId); assert.equal(post.id, plan.afterVersionId);
  assert.equal(pre.label, '改名前的稿件'); assert.equal(post.label, '修改书名后的稿件');
  assert.equal(pre.title, '旧书名'); assert.equal(post.title, p.title);
  assert.deepEqual(pre.chapters, before.chapters); assert.deepEqual(post.chapters, before.chapters);
  assert.equal(pre.date, p.updatedAt); assert.equal(post.date, p.updatedAt);
  assert.equal(new Date(p.updatedAt).toISOString(), p.updatedAt);
  const once = copy(p);
  assert.equal(applyProjectTitle(p, plan, '再次改名'), false);
  assert.deepEqual(p, once);
  p.chapters[0].body = '后续正文'; plan.chapters[1].body = '改预览'; pre.chapters[0].title = '改前快照';
  assert.deepEqual(post.chapters, before.chapters);
});

test('saved state reloads renamed text and snapshots, and old report stays bound to the pre-rename manuscript', () => {
  const p = fixture(); delete p.runtime; p.runtimeHistory = [];
  const report = { id: 'synthetic-report', title: p.title, manuscriptRevision: manuscriptRevision(p),
    createdAt: '2026-01-01', synthetic: true };
  const plan = prepareProjectTitle(p);
  assert.equal(applyProjectTitle(p, plan, '新书名'), true);
  assert.notEqual(manuscriptRevision(p), report.manuscriptRevision);
  assert.equal(manuscriptRevision(p.versions[1]), report.manuscriptRevision);
  assert.notEqual(manuscriptRevision(p.versions[2]), report.manuscriptRevision);
  assert.equal(findReportVersions(p.versions, [report]).get(report.id).id, plan.beforeVersionId);
  assert.equal(findReportVersions([p.versions[2]], [report]).size, 0);
  const state = createInitialState(); state.projects = [p]; state.activeProjectId = p.id;
  const data = new Map(), storage = { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) };
  assert.deepEqual(saveState(state, storage), { ok: true });
  const loaded = loadState(storage).projects[0];
  assert.equal(loaded.title, p.title); assert.deepEqual(loaded.chapters, p.chapters);
  assert.deepEqual(loaded.versions, p.versions); assert.deepEqual(loaded.editorBaseline, p.editorBaseline);
  assert.deepEqual(JSON.parse(JSON.stringify(loaded.pendingEdits)), p.pendingEdits);
  assert.equal(findReportVersions(loaded.versions, [report]).get(report.id).id, plan.beforeVersionId);
});
