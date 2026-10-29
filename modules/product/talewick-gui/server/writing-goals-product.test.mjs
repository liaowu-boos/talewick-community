import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { TaskService, validateRequest } from './tasks.mjs';
import { projectImportSnapshot } from './project-import.mjs';
import { createProjectImportFixture, installProjectImportFixture } from './fixtures/project-import.mjs';
import { createWholeQualityRequestSpec } from '../../../creation/runtime/whole-manuscript-quality.mjs';

import { writingGoalRequest } from './fixtures/writing-goals.mjs';
const familyRequest = writingGoalRequest('one');
const workplaceRequest = writingGoalRequest('two');
const bundled = await build({ stdin: { contents: `export {readRuntimeBinding} from './src/model/runtime.ts';
export {parseState} from './src/model/store.ts'; export {createInitialState,createProject} from './src/model/seed.ts';
export {projectFromImportSnapshot} from './src/model/project-import.ts';`,
  resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', write: false });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

async function until(fn) {
  const end = Date.now() + 5000;
  while (!fn()) { if (Date.now() > end) throw new Error('Timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

test('request validation reuses creation writing-goal rules and preserves the exact optional payload', () => {
  for (const input of [familyRequest, workplaceRequest]) {
    const normalized = validateRequest(input);
    assert.deepEqual(normalized.writingGoals, input.writingGoals);
    assert.notEqual(normalized.writingGoals, input.writingGoals);
    assert.equal(normalized.chapters.length, 10);
  }
  const legacy = structuredClone(familyRequest); delete legacy.writingGoals;
  assert.equal(Object.hasOwn(validateRequest(legacy), 'writingGoals'), false, 'omission keeps the legacy request shape');
  const changed = mutate => { const value = structuredClone(familyRequest); mutate(value); return value; };
  for (const invalid of [
    changed(value => { value.writingGoals.schemaVersion = 'creation-writing-goals-2'; }),
    changed(value => { value.writingGoals.goals = []; }),
    changed(value => { delete value.writingGoals.goals[0].preservationBoundaries; }),
    changed(value => { value.writingGoals.goals[0].chapterIds = ['missing-chapter']; }),
    changed(value => { value.revisionMode = 'whole-manuscript-v1'; }),
    changed(value => { value.kind = 'create'; }),
  ]) assert.throws(() => validateRequest(invalid), error => error.status === 400);
});

test('saved request goals are frozen across restart and altered resume input is rejected before workflow calls', async t => {
  const runsDir = await mkdtemp(path.join(os.tmpdir(), 'talewick-writing-goals-resume-'));
  t.after(() => rm(runsDir, { recursive: true, force: true }));
  let calls = 0;
  const workflow = async ({ request, checkpoint }) => {
    calls++;
    await checkpoint('requestSpec', createWholeQualityRequestSpec(request, { deepReferenceEnabled: true }));
    throw new Error('synthetic stop after frozen request specification');
  };
  const service = await new TaskService({ runsDir, model: {}, workflow }).init();
  const created = await service.create(familyRequest);
  await until(() => service.get(created.id).status === 'failed' && !service.busy);
  const requestFile = path.join(runsDir, created.id, 'request.json');
  assert.deepEqual(JSON.parse(await readFile(requestFile, 'utf8')).writingGoals, familyRequest.writingGoals);
  await assert.rejects(service.create({ ...familyRequest, writingGoals: workplaceRequest.writingGoals }), { status: 409 });
  assert.equal(calls, 1);
  await service.close();

  const altered = JSON.parse(await readFile(requestFile, 'utf8'));
  altered.writingGoals.goals[0].problem.statement += '（已变更）';
  await writeFile(requestFile, JSON.stringify(altered, null, 2) + '\n');
  const warnings = [], originalWarn = console.warn;
  console.warn = message => warnings.push(String(message));
  let reopened;
  try { reopened = await new TaskService({ runsDir, model: {}, workflow }).init(); }
  finally { console.warn = originalWarn; }
  t.after(() => reopened?.close());
  assert.throws(() => reopened.get(created.id), { status: 404 });
  assert.equal(calls, 1, 'changed goals cannot reach workflow/model work on resume');
  assert.ok(warnings.some(message => message.includes(created.id)));
});

test('browser persistence and candidate import retain goals and reject request/spec mismatch', async () => {
  const binding = ui.readRuntimeBinding({ request: familyRequest,
    baseManuscript: { title: familyRequest.projectTitle, chapters: familyRequest.chapters } }, familyRequest.projectId);
  assert.deepEqual(binding.request.writingGoals, familyRequest.writingGoals);
  const state = ui.createInitialState(), project = ui.createProject('', 'auto');
  project.id = familyRequest.projectId; project.title = familyRequest.projectTitle; project.chapters = structuredClone(familyRequest.chapters); project.runtime = binding;
  state.projects = [project]; state.activeProjectId = project.id;
  const restored = ui.parseState(JSON.parse(JSON.stringify(state))).projects[0];
  assert.deepEqual(restored.runtime.request.writingGoals, familyRequest.writingGoals);

  const fixture = await createProjectImportFixture(), tasks = { tasks: new Map(), requests: new Map(), artifacts: new Map(),
    list(projectId) { return [...this.tasks.values()].filter(task => !projectId || task.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); } };
  installProjectImportFixture(tasks, fixture);
  const snapshot = projectImportSnapshot(tasks, fixture.task.projectId);
  const goals = structuredClone(familyRequest.writingGoals); goals.goals[0].chapterIds = [];
  snapshot.revisionRequest.writingGoals = structuredClone(goals);
  snapshot.revisionRequestSpec.writingGoals = structuredClone(goals);
  snapshot.revision.result.wholeRevision.requestSpec.writingGoals = structuredClone(goals);
  assert.deepEqual(ui.projectFromImportSnapshot(snapshot, fixture.task.projectId).runtime.request.writingGoals, goals);
  delete snapshot.revisionRequestSpec.writingGoals;
  assert.throws(() => ui.projectFromImportSnapshot(snapshot, fixture.task.projectId));
});
