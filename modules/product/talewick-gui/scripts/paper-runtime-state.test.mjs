/**
 * Targeted state compatibility and edit-position checks for the Paper Canvas merge.
 * Node 22.13+ transforms TypeScript syntax in the actual model modules;
 * no browser, build, server, model call, fixture generation, or dependency install.
 * Run alongside the existing node:test runtime suite.
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { stripTypeScriptTypes } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../src/model/', import.meta.url));
const temporary = await mkdtemp(path.join(os.tmpdir(), 'talewick-paper-state-test-'));
after(() => rm(temporary, { recursive: true, force: true }));
for (const name of ['seed', 'runtime', 'revision-anchor', 'store', 'conversation', 'project-link']) {
  const source = await readFile(path.join(sourceRoot, `${name}.ts`), 'utf8');
  const javascript = stripTypeScriptTypes(source, { mode: 'transform' })
    .replace(/(from\s+['"])(\.\/[^'"]+)(['"])/g, '$1$2.mjs$3');
  await writeFile(path.join(temporary, `${name}.mjs`), javascript, { flag: 'wx' });
}
const { createInitialState, createProject } = await import(pathToFileURL(path.join(temporary, 'seed.mjs')));
const { manuscriptRevision, makeRuntimeRequest, makeWholeRevisionRequest, readRuntimeTask, runtimeBusy, runtimeStage, wholeRevisionDispositionLabel, wholeRevisionRereadPresentation, wholeRevisionRereadReport } = await import(pathToFileURL(path.join(temporary, 'runtime.mjs')));
const { getEditStart } = await import(pathToFileURL(path.join(temporary, 'revision-anchor.mjs')));
const { parseState, canAdoptWholeRevisionCandidate, canApplyPendingEdit, acceptPendingEdits, acceptWholeRevisionCandidate, declineWholeRevisionCandidate, beginRuntimeTask, applyRuntimeTask, applyConversationTurn, clearSubmittedConversationQuote } = await import(pathToFileURL(path.join(temporary, 'store.mjs')));
const { conversationBusy, makeConversationSnapshot, makeConversationSubmission, readConversationTurn, streamConversation, submitConversation } = await import(pathToFileURL(path.join(temporary, 'conversation.mjs')));
const { readProjectLink, recoverLinkedProject, loadLinkedProject, installLinkedProject, selectLinkedProject } = await import(pathToFileURL(path.join(temporary, 'project-link.mjs')));
const copy = value => structuredClone(value);
const chapter = body => ({ id: 'chapter-one', title: '测试章', body });
const edit = (id, before, after, start) => ({ id, chapterId: 'chapter-one', before, after, ...(start === undefined ? {} : { start }), reason: '固定定位测试', status: 'pending' });

function projectWith(body) {
  const project = createProject('状态兼容测试', 'auto');
  project.chapters = [chapter(body)]; project.status = 'ready'; project.docOpen = true;
  project.pendingEdits = []; project.versions = [];
  return project;
}

function oldRuntimeState(status) {
  const state = createInitialState();
  const project = projectWith('旧版本已经保存的稿件。');
  const request = {
    projectId: project.id, requestId: 'legacy-request', kind: 'revise', idea: project.idea,
    context: copy(project.context), materials: [], style: null, chapters: copy(project.chapters),
    instruction: '保留正文', quote: '', baseRevision: manuscriptRevision(project),
  };
  const task = {
    id: 'legacy-task', projectId: project.id, requestId: request.requestId,
    kind: request.kind, status, stage: 'requestedRevision', baseRevision: request.baseRevision,
    createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:01:00.000Z',
  };
  project.status = 'writing';
  project.versions = [{ id: 'legacy-version', label: '旧稿', date: task.createdAt, chapters: copy(project.chapters) }];
  project.pendingEdits = [{ ...edit('legacy-edit', project.chapters[0].body, '旧版本修改建议。'), taskId: 'older-task', beforeTitle: '测试章', afterTitle: '测试章' }];
  project.runtime = { request, task, baseManuscript: { title: project.title, chapters: copy(project.chapters) }, submitting: false };
  project.runtimeHistory = [{ ...task, id: 'older-task', requestId: 'older-request', status: 'completed' }];
  state.projects = [project]; state.activeProjectId = project.id; state.page = 'create';
  return { state, project };
}

test('old runtime bindings keep task identity, history, manuscript and task edit metadata', () => {
  for (const status of ['running', 'cancelled', 'interrupted', 'failed', 'completed']) {
    const { state, project } = oldRuntimeState(status);
    const restored = parseState(JSON.parse(JSON.stringify(state))).projects[0];
    assert.deepEqual(restored.chapters, project.chapters);
    assert.deepEqual(restored.versions, project.versions);
    assert.deepEqual(restored.pendingEdits, project.pendingEdits);
    assert.deepEqual(restored.runtime.request, project.runtime.request);
    assert.equal(restored.runtime.task.id, project.runtime.task.id);
    assert.equal(restored.runtime.task.status, status);
    assert.equal(restored.runtimeHistory[0].id, 'older-task');
    assert.equal(restored.status, status === 'running' ? 'writing' : 'ready');
    assert.equal(restored.paused, false, 'A real task must not resume through the old demo timer');
  }
});

test('input questions persist without replacing existing drafts, versions or pending edits', () => {
  const { state, project } = oldRuntimeState('needs_input');
  const question = '这篇故事希望写多少字、分几章？';
  project.runtime.task.question = question;
  const restored = parseState(copy(state)).projects[0];
  assert.equal(restored.runtime.task.status, 'needs_input');
  assert.equal(restored.runtime.task.question, question);
  assert.equal(runtimeStage(restored.runtime.task), '补充创作要求');
  assert.equal(runtimeBusy(restored), false);
  assert.equal(restored.status, 'ready');
  const before = { chapters: copy(restored.chapters), versions: copy(restored.versions), pendingEdits: copy(restored.pendingEdits) };
  assert.equal(applyRuntimeTask(restored, restored.runtime.task), true);
  assert.deepEqual({ chapters: restored.chapters, versions: restored.versions, pendingEdits: restored.pendingEdits }, before);
  assert.equal(restored.runtime.resultDisposition, undefined);
  const defensive = readRuntimeTask({ ...project.runtime.task, error: '旧错误不得显示为服务故障', result: { title: '不应应用', chapters: [chapter('不应写入')], review: { summary: '' } } });
  assert.equal(defensive.error, undefined);
  assert.equal(defensive.result, undefined);
});

test('supplemented input creates a fresh request containing the original idea and all extra ideas', () => {
  const state = createInitialState();
  const project = createProject('一篇关于归还钥匙的故事', 'auto');
  state.projects = [project]; state.activeProjectId = project.id;
  const initial = makeRuntimeRequest(project, state, 'original-request', '', '');
  beginRuntimeTask(project, initial);
  const waiting = {
    id: 'question-task', projectId: project.id, requestId: initial.requestId, kind: 'create',
    status: 'needs_input', stage: 'requirements', question: '希望写多少字、分几章？',
    engine: 'ai-sdk', engineVersion: 'test-only', baseRevision: initial.baseRevision,
    createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:01:00.000Z',
  };
  assert.equal(applyRuntimeTask(project, waiting), true);
  assert.equal(runtimeBusy(project), false);
  assert.deepEqual(project.chapters, []);
  project.extraIdeas = ['写 3000 字，分 3 章。', '结尾温暖。'];
  const next = makeRuntimeRequest(project, state, 'supplemented-request', project.extraIdeas.at(-1), '');
  assert.equal(next.kind, 'create');
  assert.equal(next.idea, [project.idea, ...project.extraIdeas].join('\n\n'));
  assert.notEqual(next.requestId, initial.requestId);
  beginRuntimeTask(project, next);
  assert.equal(project.runtimeHistory.at(-1).question, waiting.question);
  assert.equal(project.runtime.request.requestId, next.requestId);
  assert.deepEqual(project.chapters, []);
});

test('stored explicit quotation anchors survive, while malformed anchors never become unanchored requests', () => {
  const { state } = oldRuntimeState('completed');
  state.quote = '旧版本'; state.quoteSource = { chapterId: 'chapter-one', start: 0 };
  assert.deepEqual(parseState(copy(state)).quoteSource, state.quoteSource);
  for (const source of [{ chapterId: 'chapter-one', start: -1 }, { chapterId: 'chapter-one', start: 0.5 }, { chapterId: '', start: 0 }]) {
    const loaded = parseState({ ...copy(state), quoteSource: source });
    assert.equal(loaded.quote, '');
    assert.equal(loaded.quoteSource, undefined);
  }
});

test('an explicit second occurrence is accepted without modifying the first occurrence', () => {
  const quote = '她把钥匙放回桌上。';
  const body = `${quote}\n\n她想了想。\n\n${quote}`;
  const start = body.lastIndexOf(quote);
  const project = projectWith(body);
  project.pendingEdits = [edit('second-occurrence', quote, '她把钥匙交给母亲。', start)];
  const state = createInitialState(); state.projects = [project]; state.activeProjectId = project.id;
  const restored = parseState(copy(state)).projects[0];
  assert.equal(restored.pendingEdits[0].start, start);
  assert.equal(canApplyPendingEdit(restored.pendingEdits[0], restored.chapters[0]), true);
  assert.deepEqual(acceptPendingEdits(restored), { accepted: 1, skipped: 0 });
  assert.equal(restored.chapters[0].body, body.slice(0, start) + '她把钥匙交给母亲。');
  assert.ok(restored.versions.some(version => version.chapters[0].body === body));
});

test('stale anchors and ambiguous old edits preserve the original manuscript', () => {
  const quote = '同一句话。';
  const body = `${quote}中间的内容。${quote}`;
  assert.equal(getEditStart(body, { before: quote }), -1, 'Old ambiguous edits require a new explicit selection');
  assert.equal(getEditStart(`唯一的${quote}`, { before: quote }), 3, 'Old unique edits stay usable');
  const stale = edit('stale', quote, '不应写入。', body.lastIndexOf(quote));
  const project = projectWith(`新增${body}`);
  project.pendingEdits = [stale];
  const before = copy(project.chapters);
  assert.equal(getEditStart(project.chapters[0].body, stale), -1);
  assert.equal(canApplyPendingEdit(stale, project.chapters[0]), false);
  assert.deepEqual(acceptPendingEdits(project), { accepted: 0, skipped: 1 });
  assert.deepEqual(project.chapters, before);
  assert.equal(project.pendingEdits[0].status, 'pending');
});

test('task suggestions retain the complete source and title guards even with an anchor', () => {
  const original = chapter('完整的原章。');
  const pending = { ...edit('task-proposal', original.body, '完整的新章。', 0), taskId: 'real-task', beforeTitle: original.title, afterTitle: original.title };
  assert.equal(canApplyPendingEdit(pending, original), true);
  assert.equal(canApplyPendingEdit(pending, { ...original, title: '用户刚改的标题' }), false);
  assert.equal(canApplyPendingEdit(pending, { ...original, body: original.body + '用户刚加的正文。' }), false);
});

test('whole manuscript candidate stays separate, persists its mode, and adopts atomically with versions', () => {
  const state = createInitialState(), project = projectWith('她在门外停了很久。');
  state.projects = [project]; state.activeProjectId = project.id;
  const request = makeWholeRevisionRequest(project, state, 'whole-request', '调整情绪递进，保留克制结尾。');
  const originalTitle = project.title;
  assert.equal(request.revisionMode, 'whole-manuscript-v1'); assert.equal(request.quote, ''); assert.equal(request.quoteSource, undefined);
  beginRuntimeTask(project, request);
  const candidate = chapter('她在门外停了很久，最后只把钥匙放在门槛上。');
  const task = { id: 'whole-task', projectId: project.id, requestId: request.requestId, kind: 'revise', revisionMode: 'whole-manuscript-v1', status: 'completed', stage: '创作完成', baseRevision: request.baseRevision,
    engine: 'fixed', engineVersion: 'fixed-workflow-2', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:01:00.000Z', result: { title: '候选标题', chapters: [candidate], review: { summary: '合成结构夹具' }, checks: {}, knowledge: {}, warnings: [], wholeRevision: { schemaVersion: 'whole-manuscript-revision-1', status: 'candidate_ready', sourceChapters: copy(project.chapters), diagnosis: {}, plan: {}, diff: { changedChapterIds: ['chapter-one'] }, reread: { schemaVersion: 'whole-revision-reread-1' }, unresolvedItems: [], adoption: { status: 'not_applied', atomicGroups: [{ planItemId: 'p-1', chapterIds: ['chapter-one'] }] } } } };
  const original = copy(project.chapters);
  assert.equal(applyRuntimeTask(project, task), true); assert.deepEqual(project.chapters, original); assert.equal(project.runtime.resultDisposition, 'whole-revision-candidate');
  assert.equal(canAdoptWholeRevisionCandidate(project), true);
  assert.equal(acceptWholeRevisionCandidate(project), true); assert.equal(project.title, '候选标题'); assert.deepEqual(project.chapters, [candidate]);
  assert.equal(project.versions.at(-2).title, originalTitle); assert.deepEqual(project.versions.at(-2).chapters, original); assert.equal(project.versions.at(-1).title, '候选标题');
  const restored = parseState(copy(state)).projects[0];
  assert.equal(restored.runtime.request.revisionMode, 'whole-manuscript-v1'); assert.equal(restored.runtime.task.revisionMode, 'whole-manuscript-v1'); assert.equal(restored.runtime.task.result.wholeRevision.status, 'candidate_ready');
});

test('whole revision presentation uses project disposition and reports bounded reread coverage', () => {
  const whole = { reread: { schemaVersion: 'whole-revision-reread-1', coverage: { status: 'bounded', omissions: ['结尾意象没有逐句复核'] } }, adoption: { status: 'not_applied' } };
  assert.equal(wholeRevisionDispositionLabel('applied'), '已整体采纳');
  assert.equal(whole.adoption.status, 'not_applied', 'immutable model evidence stays unchanged after presenting project adoption state');
  assert.deepEqual(wholeRevisionRereadPresentation(whole), { status: 'bounded', omissions: ['结尾意象没有逐句复核'] });
  assert.deepEqual(wholeRevisionRereadPresentation({ reread: { schemaVersion: 'whole-revision-reread-1', coverage: { status: 'complete', omissions: [] } } }), { status: 'complete', omissions: [] });
  assert.deepEqual(wholeRevisionRereadPresentation({ reread: { schemaVersion: 'whole-revision-reread-incomplete-1' } }), { status: 'incomplete', omissions: [] });
});

test('whole revision reread report maps questions and insufficiently supported changes without making a verdict', () => {
  const report = wholeRevisionRereadReport({ reread: { summary: '复读报告摘要。', changeChecks: [
    { planItemId: 'r1', assessment: 'supported', reason: '报告称已支持。', evidence: [], risks: [] },
    { planItemId: 'r3', assessment: 'partly_supported', reason: '仍有纸条去向疑问。', evidence: [{ chapterId: 'ch-9', quote: '包里有两张纸' }], risks: ['可能产生误读。'] },
  ], introducedIssues: [{ id: 'i1', claimType: 'textual_conflict', observation: '纸条去向含糊。', evidence: [], limitations: ['也可能是有意留白。'] }] } });
  assert.equal(report.summary, '复读报告摘要。');
  assert.equal(report.introducedIssueCount, 1);
  assert.equal(report.unsupportedChangeCount, 1);
  assert.deepEqual(report.changeChecks[1], { planItemId: 'r3', assessment: 'partly_supported', reason: '仍有纸条去向疑问。', evidence: [{ chapterId: 'ch-9', quote: '包里有两张纸' }], risks: ['可能产生误读。'] });
  assert.deepEqual(report.introducedIssues[0], { id: 'i1', type: 'textual_conflict', observation: '纸条去向含糊。', evidence: [], limitations: ['也可能是有意留白。'] });
});

test('whole candidate never overwrites edits made after its task started and can be declined intact', () => {
  const state = createInitialState(), project = projectWith('任务起点正文。'); state.projects = [project];
  const request = makeWholeRevisionRequest(project, state, 'whole-conflict', '整体调整。'); beginRuntimeTask(project, request);
  project.chapters[0].body = '用户在任务期间修改的正文。';
  const task = { id: 'whole-conflict-task', projectId: project.id, requestId: request.requestId, kind: 'revise', revisionMode: 'whole-manuscript-v1', status: 'completed', stage: '创作完成', baseRevision: request.baseRevision,
    engine: 'fixed', engineVersion: 'fixed-workflow-2', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:01:00.000Z', result: { title: project.title, chapters: [chapter('候选正文。')], review: { summary: '' }, checks: {}, knowledge: {}, warnings: [], wholeRevision: { status: 'candidate_ready' } } };
  assert.equal(applyRuntimeTask(project, task), true); assert.equal(project.runtime.resultDisposition, 'held'); assert.equal(canAdoptWholeRevisionCandidate(project), false); assert.equal(project.chapters[0].body, '用户在任务期间修改的正文。');
  const clean = projectWith('干净原稿。'); state.projects = [clean]; const cleanRequest = makeWholeRevisionRequest(clean, state, 'whole-decline', '整体调整。'); beginRuntimeTask(clean, cleanRequest);
  const cleanTask = { ...task, id: 'whole-decline-task', projectId: clean.id, requestId: cleanRequest.requestId, baseRevision: cleanRequest.baseRevision, result: { ...task.result, chapters: [chapter('未采纳候选。')] } };
  assert.equal(applyRuntimeTask(clean, cleanTask), true); assert.equal(declineWholeRevisionCandidate(clean), true); assert.equal(clean.chapters[0].body, '干净原稿。'); assert.equal(clean.runtime.resultDisposition, 'declined');
});

test('whole no-change result preserves the manuscript without offering a meaningless adoption', () => {
  const state = createInitialState(), project = projectWith('已经成立的原稿。'); state.projects = [project];
  const request = makeWholeRevisionRequest(project, state, 'whole-no-change', '只修改有充分证据的问题。'); beginRuntimeTask(project, request);
  const task = { id: 'whole-no-change-task', projectId: project.id, requestId: request.requestId, kind: 'revise', revisionMode: 'whole-manuscript-v1', status: 'completed', stage: '创作完成', baseRevision: request.baseRevision,
    engine: 'fixed', engineVersion: 'fixed-workflow-2', createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:01:00.000Z', result: { title: project.title, chapters: copy(project.chapters), warnings: [], revisionApplied: false, baseRevision: request.baseRevision, wholeRevision: { schemaVersion: 'whole-manuscript-revision-1', status: 'no_change', sourceChapters: copy(project.chapters), diagnosis: {}, plan: {}, diff: { changedChapterIds: [] }, reread: { schemaVersion: 'whole-revision-reread-1' }, unresolvedItems: [], adoption: { status: 'not_applied', atomicGroups: [] } } } };
  const parsed = readRuntimeTask(task);
  assert.ok(parsed); assert.equal(parsed.result.wholeRevision.status, 'no_change'); assert.equal(parsed.result.review.summary, '');
  const original = copy(project.chapters);
  assert.equal(applyRuntimeTask(project, parsed), true);
  assert.deepEqual(project.chapters, original);
  assert.equal(project.runtime.resultDisposition, 'declined');
  assert.equal(canAdoptWholeRevisionCandidate(project), false);
  assert.match(project.runtime.message, /保留原稿/);
});

test('multiple anchored edits use original positions and skip overlapping replacements', () => {
  const project = projectWith('甲句。乙句。丙句。');
  project.pendingEdits = [edit('first', '甲句。', '展开后的第一句。', 0), edit('third', '丙句。', '最后一句。', 6)];
  assert.deepEqual(acceptPendingEdits(project), { accepted: 2, skipped: 0 });
  assert.equal(project.chapters[0].body, '展开后的第一句。乙句。最后一句。');
  const overlap = projectWith('甲句。乙句。丙句。');
  overlap.pendingEdits = [edit('wide', '甲句。乙句。', '合并。', 0), edit('inside', '乙句。', '替换。', 3)];
  const result = acceptPendingEdits(overlap);
  assert.deepEqual(result, { accepted: 1, skipped: 1 });
  assert.ok(['合并。丙句。', '甲句。替换。丙句。'].includes(overlap.chapters[0].body));
});

test('conversation messages preserve partial replies, task links and status across refresh', () => {
  const state = createInitialState(), project = createProject('你好', 'auto');
  project.messages = []; state.projects = [project]; state.activeProjectId = project.id;
  const turn = { id: 'conversation-turn', projectId: project.id, userText: '你好', assistantText: '你好，想写', status: 'running', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:01.000Z' };
  applyConversationTurn(project, turn);
  applyConversationTurn(project, { ...turn, assistantText: '你好，想写怎样的故事？' });
  assert.equal(project.messages.filter(message => message.role === 'user').length, 1);
  assert.equal(project.messages.filter(message => message.role === 'assistant').length, 1);
  assert.equal(conversationBusy(project), true);
  const restored = parseState(copy(state)).projects[0];
  assert.equal(restored.messages[1].turnId, turn.id);
  assert.equal(restored.messages[1].text, '你好，想写怎样的故事？');
  assert.equal(conversationBusy(restored), true);
  applyConversationTurn(restored, { ...turn, assistantText: '你好，想写怎样的故事？', status: 'cancelled' });
  assert.equal(conversationBusy(restored), false);
  assert.equal(restored.messages[1].text, '你好，想写怎样的故事？');
});

test('conversation task snapshots keep source guards while background creation does not block chat', () => {
  const state = createInitialState(), project = createProject('写一章钥匙故事', 'auto');
  project.messages = [];
  const request = makeRuntimeRequest(project, state, 'conversation-task-request', '', '');
  const task = { id: 'tool-task', projectId: project.id, requestId: request.requestId, kind: 'create', status: 'running', stage: 'draft:ch-1', engine: 'ai-sdk', engineVersion: 'test-only', baseRevision: request.baseRevision, createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:01.000Z' };
  const turn = { id: 'tool-turn', projectId: project.id, userText: '开始创作', assistantText: '已经开始创作。', status: 'completed', createdAt: task.createdAt, updatedAt: task.updatedAt, task: { request, task } };
  applyConversationTurn(project, readConversationTurn(turn));
  assert.equal(project.runtime.task.id, task.id);
  assert.equal(project.messages[1].taskId, task.id);
  assert.equal(runtimeBusy(project), true);
  assert.equal(conversationBusy(project), false, 'a completed chat turn must not block follow-up discussion while its novel task runs');
  project.title = '用户刚修改的标题';
  const completed = { ...task, status: 'completed', updatedAt: '2026-09-08T00:00:02.000Z', result: { title: '返回标题', chapters: [chapter('返回的正文。')], review: { summary: '明确测试稿件' }, checks: {}, warnings: [], knowledge: {} } };
  applyConversationTurn(project, { ...turn, task: { request, task: completed } });
  assert.equal(project.runtime.resultDisposition, 'held');
  assert.equal(project.title, '用户刚修改的标题');
  assert.deepEqual(project.chapters, []);
  assert.ok(project.runtime.task.result, 'the result stays available for inspection');
});

test('NDJSON reconnect replaces the snapshot before adding new deltas and never duplicates users', async () => {
  const project = createProject('你好', 'auto'); project.messages = [];
  const turn = { id: 'stream-turn', projectId: project.id, userText: '你好', assistantText: '你', status: 'running', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:01.000Z' };
  const response = events => new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(events.map(event => JSON.stringify(event)).join('\n') + '\n');
    // Split inside UTF-8 characters as real HTTP packet boundaries may do.
    for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
    controller.close();
  } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
  const emit = event => {
    if (event.type === 'snapshot' || event.type === 'done') applyConversationTurn(project, event.turn);
    else if (event.type === 'text') project.messages.find(message => message.role === 'assistant').text += event.delta;
  };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => response([{ type: 'snapshot', turn }, { type: 'text', delta: '好' }]);
    await assert.rejects(streamConversation(project.id, turn.id, new AbortController().signal, emit), /连接已断开/);
    assert.equal(project.messages[1].text, '你好');
    globalThis.fetch = async () => response([{ type: 'snapshot', turn: { ...turn, assistantText: '你好啊' } }, { type: 'heartbeat' }, { type: 'text', delta: '！' }, { type: 'done', turn: { ...turn, assistantText: '你好啊！', status: 'completed' } }]);
    await streamConversation(project.id, turn.id, new AbortController().signal, emit);
    assert.equal(project.messages[1].text, '你好啊！');
    assert.equal(project.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(conversationBusy(project), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('long chat and legacy extra ideas stay outside the creation snapshot idea', () => {
  const state = createInitialState();
  const project = createProject('甲'.repeat(8000), 'auto');
  project.extraIdeas = ['旧要求'.repeat(6000)];
  const first = makeConversationSnapshot(project, state, 'long-chat-1', '乙'.repeat(8000), '');
  const second = makeConversationSnapshot(project, state, 'long-chat-2', '丙'.repeat(8000), '');
  assert.equal(first.idea, project.idea);
  assert.equal(second.idea, project.idea);
  assert.equal(second.idea.length, 8000);
  assert.equal(second.instruction.length, 8000);
  assert.deepEqual(project.extraIdeas, ['旧要求'.repeat(6000)], 'legacy requirements remain stored without inflating new conversation snapshots');
});

test('submitted conversation requests carry the project mode and current editor tool permission', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      const submission = JSON.parse(init.body);
      requests.push({ url, method: init.method, submission });
      return Response.json({ turn: { id: submission.turnId, projectId: submission.snapshot.projectId, userText: submission.text, assistantText: '', status: 'running', createdAt: '', updatedAt: '' } });
    };
    for (const [mode, allowTools] of [['auto', true], ['auto', false], ['light', false], ['pro', false]]) {
      const state = createInitialState();
      state.homeMode = mode;
      const project = createProject('海边修船的人，遇到一艘没有主人的船。', state.homeMode);
      project.messages = [{ role: 'user', text: '故事背景设在海边。' }, { role: 'assistant', text: '记住了。' }];
      // Existing projects retain their own generation mode when the home selector changes.
      state.homeMode = mode === 'auto' ? 'pro' : 'auto';
      const submission = makeConversationSubmission(project, state, `turn-${mode}-${allowTools}`, 'mode-request', '按这个想法写吧。', '', allowTools);
      const turn = await submitConversation(project.id, submission);
      const sent = requests.at(-1);
      assert.equal(sent.url, `/api/conversations/${encodeURIComponent(project.id)}/turns`);
      assert.equal(sent.method, 'POST');
      assert.equal(sent.submission.mode, mode);
      assert.equal(sent.submission.allowTools, allowTools);
      assert.equal(sent.submission.snapshot.projectId, project.id);
      assert.equal(sent.submission.snapshot.idea, project.idea);
      assert.deepEqual(sent.submission.history, project.messages);
      assert.equal(turn.id, submission.turnId);
      project.messages[0].turnId = 'existing-durable-turn';
      const followUp = makeConversationSubmission(project, state, 'next-turn', 'next-request', '继续。', '', allowTools);
      assert.equal(followUp.history, undefined, 'durable server context must not be imported again');
      assert.equal(followUp.mode, mode);
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('blocked conversation requests retain quoted discussion without granting a writable anchor', () => {
  const state = createInitialState(), project = projectWith('海风吹过甲板。');
  state.quote = project.chapters[0].body;
  state.quoteSource = { chapterId: project.chapters[0].id, start: 0 };
  const before = copy({ state, project });
  const submission = makeConversationSubmission(project, state, 'blocked-turn', 'blocked-request', '先讨论这里。', state.quote, false);
  assert.equal(submission.allowTools, false);
  assert.equal(submission.snapshot.quote, state.quote);
  assert.equal(submission.snapshot.quoteSource, undefined);
  assert.deepEqual({ state, project }, before, 'submission assembly must not clear the user’s editor selection or manuscript');
});

test('excerpt discussions keep the anchor until its task is submitted and do not consume a newer selection', () => {
  const state = createInitialState();
  const quote = '同一句话。';
  const project = projectWith(`${quote}中间内容。${quote}`);
  state.projects = [project]; state.activeProjectId = project.id;
  state.quote = quote; state.quoteSource = { chapterId: 'chapter-one', start: 0 };
  const discussion = makeConversationSnapshot(project, state, 'discuss-selection', '先讨论这一句怎么改。', state.quote);
  const edit = makeConversationSnapshot(project, state, 'edit-selection', '就按刚刚说的改。', state.quote);
  assert.deepEqual(discussion.quoteSource, edit.quoteSource);
  assert.equal(edit.quote, quote);
  const task = { id: 'selection-tool-task', projectId: project.id, requestId: edit.requestId, kind: 'revise', baseRevision: edit.baseRevision };
  const newer = { chapterId: 'chapter-one', start: project.chapters[0].body.lastIndexOf(quote) };
  state.quoteSource = newer;
  clearSubmittedConversationQuote(state, project, edit, task);
  assert.deepEqual(state.quoteSource, newer, 'a late task event cannot clear a newly selected occurrence');
  state.quoteSource = discussion.quoteSource;
  clearSubmittedConversationQuote(state, project, edit, task);
  assert.equal(state.quote, ''); assert.equal(state.quoteSource, undefined);
  project.messages.push({ role: 'assistant', text: '已提交修改', taskId: task.id });
  state.quote = quote; state.quoteSource = discussion.quoteSource;
  clearSubmittedConversationQuote(state, project, edit, task);
  assert.equal(state.quote, quote, 'reconnecting an already linked task cannot consume a later selection');
});

function mockBrowserSockets(t, hostname = 'isolated-fixture.trycloudflare.com') {
  const previous = Object.fromEntries(['window', 'WebSocket', 'fetch'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const sockets = [], httpCalls = [];
  class BrowserSocket {
    readyState = 0; closed = false; sent = [];
    constructor(url) { this.url = String(url); sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.({ type: 'open' }); }
    message(event) { this.onmessage?.({ data: typeof event === 'string' ? event : JSON.stringify(event) }); }
    serverClose() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
    serverError() { this.onerror?.({ type: 'error' }); }
    close() { this.closed = true; this.readyState = 3; this.onclose?.({ code: 1000 }); }
    send(value) { this.sent.push(value); throw new Error('Read-only subscriptions must not send client messages'); }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { location: new URL(`https://${hostname}/workbench`) } });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: BrowserSocket });
  Object.defineProperty(globalThis, 'fetch', { configurable: true, writable: true, value: async (...args) => { httpCalls.push(args); throw new Error('A socket subscription must not POST or fetch'); } });
  t.after(() => { for (const name of Object.keys(previous)) { if (previous[name]) Object.defineProperty(globalThis, name, previous[name]); else delete globalThis[name]; } });
  return { sockets, httpCalls };
}
const socketTurn = extra => ({ id: 'socket-turn', projectId: 'socket-project', userText: '你好', assistantText: '你', status: 'running', createdAt: '2026-09-08T00:00:00.000Z', updatedAt: '2026-09-08T00:00:01.000Z', ...extra });

test('Cloudflare uses a credential-free same-origin native socket and emits real deltas before completion', async t => {
  const { sockets, httpCalls } = mockBrowserSockets(t);
  const events = [];
  const done = streamConversation('socket-project', 'socket-turn', new AbortController().signal, event => events.push(event));
  const socket = sockets[0];
  assert.equal(socket.url, 'wss://isolated-fixture.trycloudflare.com/api/conversations/socket-project/turns/socket-turn/socket');
  const url = new URL(socket.url);
  assert.equal(url.username, ''); assert.equal(url.password, ''); assert.equal(url.search, '');
  socket.open(); socket.message({ type: 'snapshot', turn: socketTurn() });
  socket.message({ type: 'text', delta: '好' }); socket.message({ type: 'heartbeat' });
  assert.deepEqual(events.map(event => event.type), ['snapshot', 'text']);
  assert.equal(events[1].delta, '好'); assert.equal(socket.closed, false, 'the visible text must precede terminal completion');
  socket.message({ type: 'done', turn: socketTurn({ assistantText: '你好', status: 'completed' }) });
  await done;
  assert.equal(socket.closed, true); assert.deepEqual(socket.sent, []); assert.deepEqual(httpCalls, []);
});

test('WebSocket reconnection uses a fresh snapshot without repeating the user or starting generation', async t => {
  const { sockets, httpCalls } = mockBrowserSockets(t);
  const project = createProject('你好', 'auto'); project.id = 'socket-project'; project.messages = [];
  const emit = event => {
    if (event.type === 'snapshot' || event.type === 'done') applyConversationTurn(project, event.turn);
    else if (event.type === 'text') project.messages.find(message => message.role === 'assistant').text += event.delta;
  };
  const first = streamConversation(project.id, 'socket-turn', new AbortController().signal, emit);
  const closed = assert.rejects(first, /连接已断开/);
  sockets[0].message({ type: 'snapshot', turn: socketTurn() }); sockets[0].message({ type: 'text', delta: '好' }); sockets[0].serverClose();
  await closed; assert.equal(project.messages[1].text, '你好');
  const second = streamConversation(project.id, 'socket-turn', new AbortController().signal, emit);
  assert.equal(sockets[1].url, sockets[0].url);
  sockets[1].message({ type: 'snapshot', turn: socketTurn({ assistantText: '你好啊' }) }); sockets[1].message({ type: 'text', delta: '！' });
  sockets[1].message({ type: 'done', turn: socketTurn({ assistantText: '你好啊！', status: 'completed' }) });
  await second;
  assert.equal(project.messages[1].text, '你好啊！'); assert.equal(project.messages.filter(message => message.role === 'user').length, 1);
  assert.deepEqual(httpCalls, []);
});

test('WebSocket subscriptions require the first snapshot identity and reject oversized UTF-8 messages', async t => {
  const { sockets } = mockBrowserSockets(t);
  for (const [event, expected] of [
    [{ type: 'text', delta: '不应显示' }, /缺少恢复快照/],
    [{ type: 'snapshot', turn: socketTurn({ id: 'another-turn' }) }, /身份不匹配/],
    [{ type: 'snapshot', turn: socketTurn({ projectId: 'another-project' }) }, /身份不匹配/],
    ['你'.repeat(2 * 1024 * 1024), /对话消息过长/],
  ]) {
    const events = [];
    const promise = streamConversation('socket-project', 'socket-turn', new AbortController().signal, value => events.push(value));
    const rejected = assert.rejects(promise, expected);
    sockets.at(-1).message(event); await rejected;
    assert.deepEqual(events, []); assert.equal(sockets.at(-1).closed, true);
  }
});

test('WebSocket abort resolves and closes its read-only subscription while errors request reconnection', async t => {
  const { sockets, httpCalls } = mockBrowserSockets(t);
  const controller = new AbortController();
  const promise = streamConversation('socket-project', 'socket-turn', controller.signal, () => {});
  sockets[0].message({ type: 'snapshot', turn: socketTurn() }); controller.abort(); await promise;
  assert.equal(sockets[0].closed, true);
  await streamConversation('socket-project', 'socket-turn', controller.signal, () => {});
  assert.equal(sockets.length, 1, 'an already aborted subscription cannot open another connection');
  const broken = streamConversation('socket-project', 'socket-turn', new AbortController().signal, () => {});
  const rejected = assert.rejects(broken, /订阅连接中断/); sockets[1].serverError(); await rejected;
  assert.equal(sockets[1].closed, true); assert.deepEqual(httpCalls, []);
});

test('WebSocket idle timeout closes the connection so the same turn can reconnect', async t => {
  const { sockets } = mockBrowserSockets(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const promise = streamConversation('socket-project', 'socket-turn', new AbortController().signal, () => {});
  const rejected = assert.rejects(promise, /订阅暂时中断/);
  sockets[0].message({ type: 'snapshot', turn: socketTurn() });
  t.mock.timers.tick(44999); assert.equal(sockets[0].closed, false);
  sockets[0].message({ type: 'heartbeat' });
  t.mock.timers.tick(44999); assert.equal(sockets[0].closed, false);
  t.mock.timers.tick(1); await rejected; assert.equal(sockets[0].closed, true);
});

function linkedFixture(status = 'running', sourceChapters = []) {
  const state = createInitialState(), project = createProject('一个明确的链接恢复测试故事。', 'auto');
  project.id = 'project-linked-fixture';
  project.title = '提交时的标题'; project.chapters = copy(sourceChapters);
  project.context.world = '提交时的海边背景';
  project.attachments = [{ id: 'material-one', name: '所选资料', content: '只恢复实际提交的资料。' }];
  const style = { id: 'original-style', name: '简洁', description: '少用形容词', rules: '用动作表现人物', traits: ['克制'], sourceIds: [], active: true, date: '2026-09-09' };
  state.styles = [style]; project.styleId = style.id;
  const request = makeRuntimeRequest(project, state, 'linked-request', '直接写', '');
  const task = { id: 'linked-task', projectId: project.id, requestId: request.requestId, kind: request.kind, status, stage: 'draft:ch-1', engine: 'ai-sdk', engineVersion: 'fixture', baseRevision: request.baseRevision, createdAt: '2026-09-09T00:00:00.000Z', updatedAt: '2026-09-09T00:01:00.000Z', ...(status === 'failed' ? { error: '测试服务超时' } : {}), ...(status === 'completed' ? { result: { title: '创作返回的标题', chapters: [chapter('已经完成的测试正文。')], review: { summary: '检查完成' }, checks: {}, knowledge: {}, warnings: [] } } : {}) };
  const turn = { id: 'linked-turn', projectId: project.id, userText: '开始创作', assistantText: '已提交创作。', status: 'completed', createdAt: task.createdAt, updatedAt: task.updatedAt, task: { request, task } };
  return { project, request, task, turn };
}

test('project links require exactly one explicit safe id and ordinary home URLs do nothing', () => {
  assert.deepEqual(readProjectLink(''), {});
  assert.deepEqual(readProjectLink('?view=home'), {});
  assert.deepEqual(readProjectLink('?project=project-linked_fixture&view=home'), { projectId: 'project-linked_fixture' });
  for (const search of ['?project=', '?project=../private', '?project=a&project=b', '?project=' + 'x'.repeat(161)]) assert.ok(readProjectLink(search).error);
});

test('linked recovery supports running, failed and completed tasks with their original source guard', () => {
  for (const status of ['running', 'failed', 'completed']) {
    const { project: original, request, task, turn } = linkedFixture(status);
    const before = copy(turn);
    const recovered = recoverLinkedProject(original.id, [turn]);
    const project = recovered.project;
    assert.equal(project.id, original.id); assert.equal(project.mode, 'auto');
    assert.equal(project.runtime.task.id, task.id); assert.equal(project.runtime.task.status, status);
    assert.equal(project.runtime.request.baseRevision, request.baseRevision);
    assert.deepEqual(project.runtime.baseManuscript, { title: original.title, chapters: [] });
    assert.deepEqual(project.context, original.context);
    assert.deepEqual(project.attachments, original.attachments);
    assert.equal(recovered.style.rules, request.style.rules);
    assert.equal(project.styleId, recovered.style.id);
    assert.equal(project.messages.filter(message => message.role === 'user').length, 1);
    assert.deepEqual(turn, before, 'recovery must not mutate the received task or conversation');
    if (status === 'running') { assert.equal(runtimeBusy(project), true); assert.equal(project.status, 'writing'); }
    if (status === 'failed') { assert.equal(project.runtime.task.error, task.error); assert.equal(project.status, 'draft'); }
    if (status === 'completed') { assert.deepEqual(project.chapters, task.result.chapters); assert.equal(project.runtime.resultDisposition, 'applied'); assert.equal(project.versions.length, 1); }
  }
});

test('recovery preserves the latest submitted manuscript and retains revision suggestions for review', () => {
  const { project: original, request, turn } = linkedFixture('completed', [chapter('用户已经提交的改稿前正文。')]);
  const earlier = linkedFixture('completed').turn;
  earlier.id = 'earlier-turn'; earlier.task.task.id = 'earlier-task'; earlier.task.task.createdAt = '2026-09-08T00:00:00.000Z';
  earlier.task.task.updatedAt = earlier.task.task.createdAt;
  const recovered = recoverLinkedProject(original.id, [earlier, turn]);
  assert.deepEqual(recovered.project.chapters, request.chapters, 'revision results remain proposals instead of replacing submitted text');
  assert.equal(recovered.project.title, request.projectTitle);
  assert.equal(recovered.project.runtime.resultDisposition, 'proposals');
  assert.equal(recovered.project.pendingEdits.length, 1);
  assert.equal(recovered.project.pendingEdits[0].before, request.chapters[0].body);
  assert.equal(recovered.project.pendingEdits[0].status, 'pending');
  assert.equal(recovered.project.runtimeHistory[0].id, 'earlier-task');
  assert.equal(recovered.project.versions[0].label, '上次提交的稿件');
  const changed = copy(recovered.project); changed.chapters[0].body += '新的本机编辑。';
  assert.deepEqual(acceptPendingEdits(changed), { accepted: 0, skipped: 1 });
});

test('link recovery rejects missing tasks, mismatched projects and damaged manuscript baselines', () => {
  const { project, turn } = linkedFixture();
  assert.throws(() => recoverLinkedProject(project.id, []), /未找到/);
  assert.throws(() => recoverLinkedProject(project.id, [{ ...turn, task: undefined }]), /未找到/);
  assert.throws(() => recoverLinkedProject('another-project', [turn]), /不匹配/);
  const damaged = copy(turn); damaged.task.request.projectTitle += '不匹配';
  assert.throws(() => recoverLinkedProject(project.id, [damaged]), /基线不完整/);
});

test('a matching local project wins over recovery, including newer edits, versions and quoted selections', () => {
  const state = createInitialState(), { project, turn } = linkedFixture('completed');
  const recovered = recoverLinkedProject(project.id, [turn]);
  project.chapters = [chapter('本机未提交的正文。')]; project.title = '本机未提交的标题';
  project.draftInput = '本机输入'; project.versions = [{ id: 'local-version', label: '本机版本', date: '', chapters: copy(project.chapters) }];
  state.projects.unshift(project); state.activeProjectId = project.id;
  state.quote = '本机未提交'; state.quoteSource = { chapterId: 'chapter-one', start: 0 };
  const before = copy({ project, styles: state.styles, quote: state.quote, quoteSource: state.quoteSource });
  assert.equal(installLinkedProject(state, recovered, true), false);
  selectLinkedProject(state, project.id);
  assert.deepEqual(state.projects[0], before.project);
  assert.deepEqual(state.styles, before.styles);
  assert.equal(state.quote, before.quote); assert.deepEqual(state.quoteSource, before.quoteSource);
  assert.equal(state.projects.filter(item => item.id === project.id).length, 1);
});

test('late recovery adds only its named project and does not steal focus from another local project', () => {
  const state = createInitialState(), { project, turn } = linkedFixture('running');
  state.activeProjectId = state.projects[0].id;
  const active = state.activeProjectId, local = copy(state.projects);
  state.quote = '原有选段'; state.quoteSource = { chapterId: 'local-chapter', start: 0 };
  const recovered = recoverLinkedProject(project.id, [turn]);
  assert.equal(installLinkedProject(state, recovered, false), true);
  assert.equal(state.activeProjectId, active); assert.equal(state.quote, '原有选段');
  assert.deepEqual(state.projects.slice(1), local);
  assert.equal(state.styles.filter(style => style.id === recovered.style.id).length, 1);
  const stored = parseState(copy(state));
  assert.equal(stored.projects[0].runtime.task.id, turn.task.task.id);
  assert.equal(stored.projects[0].styleId, recovered.style.id);
  selectLinkedProject(state, project.id);
  assert.equal(state.activeProjectId, project.id); assert.equal(state.quote, '');
});

test('explicit recovery reads only its conversation, never submits tasks, and rejects 404 or service failures', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [], { project, turn } = linkedFixture('running');
  try {
    globalThis.fetch = async (url, init) => { calls.push({ url, method: init?.method ?? 'GET' }); return Response.json({ turns: [turn] }); };
    const recovered = await loadLinkedProject(project.id);
    assert.equal(recovered.project.id, project.id);
    assert.deepEqual(calls, [{ url: `/api/conversations/${project.id}`, method: 'GET' }]);
    await assert.rejects(loadLinkedProject('../invalid'), /标识无效/);
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => Response.json({ error: '不存在' }, { status: 404 });
    await assert.rejects(loadLinkedProject(project.id), /未找到/);
    globalThis.fetch = async () => Response.json({ error: '暂时不可用' }, { status: 503 });
    await assert.rejects(loadLinkedProject(project.id), /暂时不可用/);
  } finally { globalThis.fetch = originalFetch; }
});

test('partial draft parser is strict and applying a failed task preserves user manuscript', () => {
  const { project } = oldRuntimeState('failed');
  project.runtime.request.kind = 'create';
  project.runtime.task.kind = 'create';
  project.chapters[0].body = '用户在任务失败后继续编辑的正文。';
  const original = copy(project.chapters);
  const source = {...project.runtime.task, kind:'create', partialDraft:{status:'unreviewed_partial',chapters:[chapter('独立保存的未完成草稿。')],availableChapterCount:1,expectedChapterCount:8}};
  const parsed = readRuntimeTask(source);
  assert.equal(parsed.partialDraft.expectedChapterCount,8);
  applyRuntimeTask(project, parsed);
  assert.deepEqual(project.chapters,original);
  for(const partialDraft of [null,{}, {...source.partialDraft,availableChapterCount:8}, {...source.partialDraft,expectedChapterCount:0}, {...source.partialDraft,chapters:[chapter(' ')]}, {...source.partialDraft,chapters:[chapter('a'),chapter('b')],availableChapterCount:2}])assert.equal(readRuntimeTask({...source,partialDraft}).partialDraft,undefined);
  for(const status of ['completed','running','queued','needs_input'])assert.equal(readRuntimeTask({...source,status}).partialDraft,undefined);
});
