#!/usr/bin/env node
import { constants as fsConstants } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_SOURCE_ROOT = undefined;
export const DEFAULT_TARGET_ROOT = undefined;
export const DEFAULT_PROJECT_ID = undefined;
export const DEFAULT_EXPECTED_MINIMUMS = Object.freeze({ turns: 3, independentReviews: 3, full15: 2 });

const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SAFE_ID = /^[\w-]{1,160}$/;
const MAIN_FILES = new Set(['task.json', 'request.json', 'artifacts.json', 'result.json', 'manuscript.txt']);
const ACTIVE = new Set(['queued', 'running']);

export class AppendImportError extends Error {
  constructor(code, message, details) {
    super(message); this.name = 'AppendImportError'; this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const fail = (code, message, details) => { throw new AppendImportError(code, message, details); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
const jsonBytes = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const canonicalHash = value => sha256(Buffer.from(JSON.stringify(canonical(value)), 'utf8'));
const canonicalEqual = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const inside = (root, target) => { const relative = path.relative(root, target); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const exists = target => lstat(target).then(() => true, error => error?.code === 'ENOENT' ? false : Promise.reject(error));

async function inspectLocalFile(file) {
  const info = await lstat(file);
  let flags = [];
  if (process.platform === 'darwin') {
    const { stdout } = await execFileAsync('/usr/bin/stat', ['-f', '%Sf', file], { encoding: 'utf8' });
    flags = String(stdout).trim().split(',').map(item => item.trim()).filter(Boolean);
  }
  return { info, dataless: flags.includes('dataless'), identity: {
    device: String(info.dev), inode: String(info.ino), size: info.size, mode: info.mode & 0o7777,
    mtimeMs: Math.trunc(info.mtimeMs), ctimeMs: Math.trunc(info.ctimeMs), flags,
  } };
}

async function assertLocalFile(file) {
  const inspected = await inspectLocalFile(file);
  if (!inspected.info.isFile() || inspected.info.isSymbolicLink()) fail('UNSAFE_FILE', `只允许普通本地文件：${file}`);
  if (inspected.dataless) fail('FILE_DATALESS', `文件仍是 iCloud 占位：${file}`, { statIdentity: inspected.identity });
  return inspected.info;
}

async function bytes(file) { await assertLocalFile(file); return readFile(file); }
async function json(file) {
  let value;
  try { value = JSON.parse((await bytes(file)).toString('utf8')); }
  catch (error) {
    if (error instanceof AppendImportError) throw error;
    fail('INVALID_JSON', `JSON 无法解析：${file}`, { cause: String(error?.message || error) });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_JSON', `JSON 顶层必须是对象：${file}`);
  return value;
}

async function walk(root, relative = '') {
  const info = await lstat(root).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (!info?.isDirectory() || info.isSymbolicLink()) fail('DIRECTORY_MISSING', `目录不存在或不安全：${root}`);
  const result = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const absolute = path.join(root, entry.name), child = path.join(relative, entry.name), childInfo = await lstat(absolute);
    if (childInfo.isSymbolicLink()) fail('UNSAFE_FILE', `目录中不允许符号链接：${absolute}`);
    if (childInfo.isDirectory()) result.push(...await walk(absolute, child));
    else if (childInfo.isFile()) result.push({ absolute, relative: child, mode: childInfo.mode & 0o777 });
    else fail('UNSAFE_FILE', `目录中存在非普通条目：${absolute}`);
  }
  return result;
}

async function ownedRun(task, root, label) {
  if (typeof task.runDir !== 'string' || !path.isAbsolute(task.runDir)) fail('RUN_BINDING_INVALID', `${label} 缺少绝对 runDir。`, { id: task.id });
  const resolved = await realpath(task.runDir).catch(() => fail('RUN_BINDING_INVALID', `${label} runDir 不存在。`, { id: task.id }));
  const base = await realpath(root).catch(() => fail('RUN_BINDING_INVALID', `${label} runs 根目录不存在。`));
  if (!inside(base, resolved) || base === resolved) fail('RUN_BINDING_INVALID', `${label} runDir 越出绑定根目录。`, { id: task.id });
  const relative = path.relative(base, resolved), top = relative.split(path.sep)[0];
  return { relative, top, sourceTop: path.join(base, top) };
}

async function scan(root, projectId, { allowOpaque = false } = {}) {
  const absoluteRoot = await realpath(root).catch(() => fail('ROOT_MISSING', `runs 根目录不存在：${root}`));
  const main = [], full15 = [], independentReviews = [], active = [], opaque = [];
  const record = async (file, kind, id) => {
    try { return await json(file); }
    catch (error) {
      if (!allowOpaque || error?.code !== 'FILE_DATALESS') throw error;
      const inspected = await inspectLocalFile(file);
      opaque.push({ kind, id, path: path.relative(absoluteRoot, file), statIdentity: inspected.identity });
      return null;
    }
  };
  for (const entry of await readdir(absoluteRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const folder = path.join(absoluteRoot, entry.name), task = await record(path.join(folder, 'task.json'), 'task', entry.name);
    if (!task) continue;
    if (task.projectId !== projectId) continue;
    if (task.id !== entry.name) fail('RECORD_BINDING_INVALID', '任务目录名与 task.id 不一致。', { folderId: entry.name, taskId: task.id });
    if (ACTIVE.has(task.status)) active.push({ kind: 'task', id: task.id, status: task.status });
    main.push({ id: task.id, task, folder });
  }
  const fullRoot = path.join(absoluteRoot, 'full15-product');
  for (const entry of await readdir(fullRoot, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isFile() || !entry.name.endsWith('.json') || !UUID.test(entry.name.slice(0, -5))) continue;
    const id = entry.name.slice(0, -5), file = path.join(fullRoot, entry.name), task = await record(file, 'full15', id);
    if (!task) continue;
    if (task.projectId !== projectId) continue;
    if (task.id !== entry.name.slice(0, -5)) fail('RECORD_BINDING_INVALID', 'FULL15 文件名与 task.id 不一致。', { file: entry.name, taskId: task.id });
    if (ACTIVE.has(task.status)) active.push({ kind: 'full15', id: task.id, status: task.status });
    full15.push({ id: task.id, task, file });
  }
  const reviewRoot = path.join(absoluteRoot, 'independent-reviews');
  for (const entry of await readdir(reviewRoot, { withFileTypes: true }).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
    const folder = path.join(reviewRoot, entry.name), task = await record(path.join(folder, 'task.json'), 'independent-review', entry.name);
    if (!task) continue;
    if (task.projectId !== projectId) continue;
    if (task.id !== entry.name) fail('RECORD_BINDING_INVALID', '独立评阅目录名与 task.id 不一致。', { folderId: entry.name, taskId: task.id });
    if (ACTIVE.has(task.status)) active.push({ kind: 'independent-review', id: task.id, status: task.status });
    independentReviews.push({ id: task.id, task, folder });
  }
  const conversationFile = path.join(absoluteRoot, '.conversations', `${projectId}.json`);
  const conversation = await exists(conversationFile) ? await json(conversationFile) : null;
  if (conversation && (conversation.projectId !== projectId || !Array.isArray(conversation.turns) || !Array.isArray(conversation.history))) fail('CONVERSATION_INVALID', '对话文件绑定无效。');
  if (conversation?.turns.some(turn => turn?.status === 'running')) active.push({ kind: 'conversation', status: 'running' });
  const opaqueById = new Map(opaque.map(item => [item.id, item]));
  const referenced = new Set();
  const findOpaqueReference = value => {
    if (typeof value === 'string') { if (opaqueById.has(value)) referenced.add(value); return; }
    if (Array.isArray(value)) { for (const item of value) findOpaqueReference(item); return; }
    if (value && typeof value === 'object') for (const item of Object.values(value)) findOpaqueReference(item);
  };
  for (const turn of conversation?.turns ?? []) findOpaqueReference(turn);
  if (referenced.size) fail('CONVERSATION_REFERENCES_OPAQUE', '当前项目对话引用了尚未本地化的占位记录，拒绝追加。', { opaque: [...referenced].map(id => opaqueById.get(id)) });
  opaque.sort((left, right) => left.path.localeCompare(right.path));
  return { root: absoluteRoot, main, full15, independentReviews, conversation, conversationFile, active, opaque };
}

async function snapshot(scanResult) {
  const files = [], seen = new Map();
  const addFile = async (absolute, relative) => {
    const value = await bytes(absolute), digest = sha256(value), previous = seen.get(relative);
    if (previous) { if (previous.sha256 !== digest) fail('SNAPSHOT_PATH_COLLISION', '同一项目路径绑定到不同内容。', { relative }); return; }
    const item = { absolute, relative, sha256: digest, bytes: value.length }; seen.set(relative, item); files.push(item);
  };
  const addTree = async (absolute, relative) => { for (const item of await walk(absolute)) await addFile(item.absolute, path.join(relative, item.relative)); };
  for (const item of scanResult.main) await addTree(item.folder, item.id);
  for (const item of scanResult.full15) {
    await addFile(item.file, path.join('full15-product', path.basename(item.file)));
    if (typeof item.task.runDir === 'string' && item.task.runDir) {
      const run = await ownedRun(item.task, path.join(scanResult.root, 'full15-product', 'runs'), 'FULL15');
      await addTree(run.sourceTop, path.join('full15-product', 'runs', run.top));
    }
  }
  for (const item of scanResult.independentReviews) {
    await addTree(item.folder, path.join('independent-reviews', item.id));
    if (typeof item.task.runDir === 'string' && item.task.runDir) {
      const run = await ownedRun(item.task, path.join(scanResult.root, 'independent-reviews', 'runs'), '独立评阅');
      await addTree(run.sourceTop, path.join('independent-reviews', 'runs', run.top));
    }
  }
  if (scanResult.conversation) await addFile(scanResult.conversationFile, path.join('.conversations', path.basename(scanResult.conversationFile)));
  files.sort((a, b) => a.relative.localeCompare(b.relative));
  const records = {
    taskIds: scanResult.main.map(item => item.id).sort(),
    full15Ids: scanResult.full15.map(item => item.id).sort(),
    independentReviewIds: scanResult.independentReviews.map(item => item.id).sort(),
    turnIds: (scanResult.conversation?.turns ?? []).map(item => item?.id).filter(value => typeof value === 'string').sort(),
  };
  const opaqueExcluded = structuredClone(scanResult.opaque ?? []);
  const projection = { projectId: scanResult.conversation?.projectId ?? scanResult.main[0]?.task.projectId ?? scanResult.full15[0]?.task.projectId ?? scanResult.independentReviews[0]?.task.projectId, records,
    files: files.map(({ relative, sha256: digest, bytes: size }) => ({ path: relative, sha256: digest, bytes: size })), opaqueExcluded };
  return { schemaVersion: 'talewick-project-snapshot-1', ...projection, sha256: canonicalHash(projection), files };
}

function mergeHistory(existing, incoming) {
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  if (!incoming.length || same(existing, incoming)) return structuredClone(existing);
  if (!existing.length) return structuredClone(incoming);
  const prefix = (short, long) => short.every((item, index) => same(item, long[index]));
  if (existing.length <= incoming.length && prefix(existing, incoming)) return structuredClone(incoming);
  if (incoming.length <= existing.length && prefix(incoming, existing)) return structuredClone(existing);
  fail('CONVERSATION_HISTORY_DIVERGED', '新旧对话 history 不是同一前缀，拒绝拼接。');
}

function mergeConversation(existing, incoming, projectId) {
  if (!existing) return incoming ? structuredClone(incoming) : null;
  if (!incoming) return structuredClone(existing);
  if (existing.projectId !== projectId || incoming.projectId !== projectId) fail('CONVERSATION_INVALID', '对话 projectId 不一致。');
  const turns = structuredClone(existing.turns), ids = new Set(turns.map(item => item?.id));
  let prefixIndex = 0, appending = false;
  for (const turn of incoming.turns) {
    if (!turn || typeof turn.id !== 'string') fail('CONVERSATION_TURN_COLLISION', '新对话 turnId 无效。', { turnId: turn?.id });
    if (ids.has(turn.id)) {
      const previous = existing.turns[prefixIndex];
      if (appending || previous?.id !== turn.id || !canonicalEqual(previous, turn)) fail('CONVERSATION_TURN_COLLISION', '新对话 turnId 与旧记录内容冲突。', { turnId: turn.id });
      prefixIndex += 1;
      continue;
    }
    appending = true;
    ids.add(turn.id); turns.push(structuredClone(turn));
  }
  return { version: Math.max(Number(existing.version) || 1, Number(incoming.version) || 1), projectId,
    history: mergeHistory(existing.history, incoming.history), turns };
}

async function liveOwnerPids(root) {
  const result = [];
  for (const entry of await readdir(path.join(root, '.runtime-owners')).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error))) {
    const match = entry.match(/^(\d+)-[a-f0-9-]{36}$/i); if (!match) continue;
    try { process.kill(Number(match[1]), 0); result.push(Number(match[1])); }
    catch (error) { if (error?.code !== 'ESRCH') result.push(Number(match[1])); }
  }
  return [...new Set(result)];
}

function assertMinimums(target, minimums) {
  const actual = { turns: target.conversation?.turns.length ?? 0, independentReviews: target.independentReviews.length, full15: target.full15.length };
  for (const key of Object.keys(minimums)) if (actual[key] < minimums[key]) fail('TARGET_BASELINE_INCOMPLETE', `目标旧 ${key} 少于要求，拒绝追加。`, { expectedMinimum: minimums, actual });
  return actual;
}

async function sourceGroups(source, targetRoot) {
  const groups = [], addTree = async (kind, sourceRoot, destination) => {
    const files = [];
    for (const item of await walk(sourceRoot)) { const value = await bytes(item.absolute); files.push({ source: item.absolute, relative: item.relative, sourceSha256: sha256(value), output: value, outputSha256: sha256(value), mode: item.mode }); }
    groups.push({ kind, type: 'directory', destination, files });
  };
  for (const item of source.main) {
    const files = [];
    for (const name of [...MAIN_FILES].sort()) {
      const file = path.join(item.folder, name); if (!await exists(file)) continue;
      const value = await bytes(file); files.push({ source: file, relative: name, sourceSha256: sha256(value), output: value, outputSha256: sha256(value), mode: (await lstat(file)).mode & 0o777 });
    }
    for (const name of ['task.json', 'request.json', 'artifacts.json']) if (!files.some(file => file.relative === name)) fail('SOURCE_TASK_INCOMPLETE', `新任务缺少 ${name}。`, { id: item.id });
    groups.push({ kind: 'task', type: 'directory', destination: item.id, files });
  }
  for (const item of source.full15) {
    let output = await bytes(item.file);
    if (typeof item.task.runDir === 'string' && item.task.runDir) {
      const run = await ownedRun(item.task, path.join(source.root, 'full15-product', 'runs'), 'FULL15');
      const changed = structuredClone(item.task); changed.runDir = path.join(targetRoot, 'full15-product', 'runs', run.relative); output = jsonBytes(changed);
      await addTree('full15-run', run.sourceTop, path.join('full15-product', 'runs', run.top));
    }
    const input = await bytes(item.file); groups.push({ kind: 'full15', type: 'file', destination: path.join('full15-product', path.basename(item.file)), files: [{ source: item.file, relative: '', sourceSha256: sha256(input), output, outputSha256: sha256(output), mode: (await lstat(item.file)).mode & 0o777 }] });
  }
  for (const item of source.independentReviews) {
    const run = await ownedRun(item.task, path.join(source.root, 'independent-reviews', 'runs'), '独立评阅');
    const files = [];
    for (const part of await walk(item.folder)) {
      const input = await bytes(part.absolute); let output = input;
      if (part.relative === 'task.json') { const changed = structuredClone(item.task); changed.runDir = path.join(targetRoot, 'independent-reviews', 'runs', run.relative); output = jsonBytes(changed); }
      files.push({ source: part.absolute, relative: part.relative, sourceSha256: sha256(input), output, outputSha256: sha256(output), mode: part.mode });
    }
    groups.push({ kind: 'independent-review', type: 'directory', destination: path.join('independent-reviews', item.id), files });
    await addTree('independent-review-run', run.sourceTop, path.join('independent-reviews', 'runs', run.top));
  }
  return groups;
}

function publicPlan(plan) {
  return { schemaVersion: plan.schemaVersion, mode: plan.mode, projectId: plan.projectId, sourceRoot: plan.sourceRoot, targetRoot: plan.targetRoot,
    expectedTargetSha256: plan.targetSnapshot.sha256, targetCountsBefore: plan.targetCounts, sourceCounts: plan.sourceCounts, mergedCounts: plan.mergedCounts,
    opaqueExcluded: plan.targetSnapshot.opaqueExcluded, opaqueBytesBackedUp: false, backupScope: 'local-confirmed-project-records-only',
    targetRuntimePids: plan.targetRuntimePids, backupRequired: true, destinations: plan.groups.map(group => ({ kind: group.kind, path: group.destination,
      files: group.files.map(file => ({ path: file.relative, sourceSha256: file.sourceSha256, outputSha256: file.outputSha256 })) })) };
}

export async function buildAppendPlan({ sourceRoot = DEFAULT_SOURCE_ROOT, targetRoot = DEFAULT_TARGET_ROOT, projectId = DEFAULT_PROJECT_ID, expectedMinimums = DEFAULT_EXPECTED_MINIMUMS } = {}) {
  if (!sourceRoot || !targetRoot) fail('ROOTS_REQUIRED', 'Explicit sourceRoot and targetRoot are required.');
  if (typeof projectId !== 'string' || !SAFE_ID.test(projectId)) fail('PROJECT_ID_INVALID', 'projectId 格式无效。');
  const source = await scan(path.resolve(sourceRoot), projectId), target = await scan(path.resolve(targetRoot), projectId, { allowOpaque: true });
  if (source.root === target.root || inside(source.root, target.root) || inside(target.root, source.root)) fail('ROOTS_OVERLAP', '新 runs 与正式 runs 不能重叠。');
  if (source.active.length) fail('SOURCE_ACTIVE', '新 runs 仍有运行中记录。', { active: source.active, opaqueExcluded: target.opaque });
  if (target.active.length) fail('TARGET_ACTIVE', '正式 runs 含运行中记录。', { active: target.active, opaqueExcluded: target.opaque });
  const repeatedCreation = source.main.filter(item => item.task.kind === 'create').map(item => item.id);
  if (repeatedCreation.length) fail('SOURCE_CREATE_FORBIDDEN', '追加包不能再次导入原稿创建任务；本轮只接受同一原稿的新整稿任务。', { taskIds: repeatedCreation });
  const targetCounts = assertMinimums(target, expectedMinimums), targetSnapshot = await snapshot(target);
  const collision = (kind, current, incoming) => incoming.filter(item => current.some(old => old.id === item.id)).map(item => ({ kind, id: item.id }));
  const collisions = [...collision('task', target.main, source.main), ...collision('full15', target.full15, source.full15), ...collision('independent-review', target.independentReviews, source.independentReviews)];
  if (collisions.length) fail('RECORD_ID_COLLISION', '新旧记录 ID 冲突，拒绝覆盖。', { collisions });
  const groups = await sourceGroups(source, target.root), conversation = mergeConversation(target.conversation, source.conversation, projectId);
  if (source.conversation) {
    const output = jsonBytes(conversation), input = await bytes(source.conversationFile);
    groups.push({ kind: 'conversation-merge', type: 'replace-file', destination: path.join('.conversations', `${projectId}.json`), files: [{ source: source.conversationFile, relative: '', sourceSha256: sha256(input), output, outputSha256: sha256(output), mode: 0o600 }] });
  }
  const destinations = new Set();
  for (const group of groups.filter(item => item.type !== 'replace-file')) {
    if (destinations.has(group.destination)) fail('DESTINATION_COLLISION', '追加包内部目标路径重复。', { destination: group.destination });
    destinations.add(group.destination);
    if (await exists(path.join(target.root, group.destination))) fail('DESTINATION_EXISTS', '追加目标已存在，拒绝覆盖。', { destination: group.destination });
  }
  const sourceTaskIds = new Set([...target.main, ...source.main].map(item => item.id));
  for (const turn of conversation?.turns ?? []) { const taskId = turn?.task?.task?.id; if (typeof taskId === 'string' && !sourceTaskIds.has(taskId)) fail('CONVERSATION_TASK_MISSING', '合并对话绑定了不存在的任务。', { turnId: turn.id, taskId }); }
  const sourceCounts = { tasks: source.main.length, turns: source.conversation?.turns.length ?? 0, independentReviews: source.independentReviews.length, full15: source.full15.length };
  if (!sourceCounts.tasks && !sourceCounts.turns && !sourceCounts.independentReviews && !sourceCounts.full15) fail('SOURCE_EMPTY', '新 runs 没有可追加记录。');
  const mergedCounts = { tasks: target.main.length + source.main.length, turns: conversation?.turns.length ?? 0,
    independentReviews: target.independentReviews.length + source.independentReviews.length, full15: target.full15.length + source.full15.length };
  const targetRuntimePids = await liveOwnerPids(target.root);
  const plan = { schemaVersion: 'talewick-append-import-plan-1', mode: 'dry-run', projectId, sourceRoot: source.root, targetRoot: target.root,
    source, targetSnapshot, targetCounts: { tasks: target.main.length, ...targetCounts }, sourceCounts, mergedCounts, targetRuntimePids, groups };
  return Object.assign(plan, { toJSON: () => publicPlan(plan) });
}

async function verifyFresh(plan, expectedTargetSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedTargetSha256 ?? '')) fail('EXPECTED_TARGET_HASH_REQUIRED', 'apply 必须显式提供 dry-run 输出的 expectedTargetSha256。');
  const currentTarget = await scan(plan.targetRoot, plan.projectId, { allowOpaque: true }), currentSnapshot = await snapshot(currentTarget);
  if (currentSnapshot.sha256 !== expectedTargetSha256 || currentSnapshot.sha256 !== plan.targetSnapshot.sha256) fail('TARGET_CHANGED', '正式旧数据哈希已变化，拒绝追加。', { expected: expectedTargetSha256, actual: currentSnapshot.sha256 });
  if ((await liveOwnerPids(plan.targetRoot)).length) fail('TARGET_RUNTIME_ACTIVE', '正式 runs 正被服务占用，停止服务后再导入。');
  for (const group of plan.groups) for (const file of group.files) if (file.source && sha256(await bytes(file.source)) !== file.sourceSha256) fail('SOURCE_CHANGED', '新 runs 在 dry-run 后发生变化。', { source: file.source });
  for (const group of plan.groups.filter(item => item.type !== 'replace-file')) if (await exists(path.join(plan.targetRoot, group.destination))) fail('DESTINATION_EXISTS', '追加目标在 dry-run 后出现，拒绝覆盖。', { destination: group.destination });
}

async function copyTreeFiles(root, files) {
  for (const file of files) {
    const target = path.join(root, file.relative); await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(file.absolute, target, fsConstants.COPYFILE_EXCL); await chmod(target, 0o600);
  }
}

async function stageGroups(stageRoot, groups) {
  for (const group of groups) for (const file of group.files) {
    const destination = path.join(stageRoot, group.destination, file.relative); await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.output, { flag: 'wx', mode: file.mode || 0o600 });
    if (sha256(await bytes(destination)) !== file.outputSha256) fail('STAGE_HASH_MISMATCH', '暂存哈希不一致。', { destination });
  }
}

export async function applyAppendPlan(plan, { expectedTargetSha256 } = {}) {
  await verifyFresh(plan, expectedTargetSha256);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-'), backupRelative = path.join('.append-import-backups', `${plan.projectId}-${plan.targetSnapshot.sha256.slice(0, 12)}-${stamp}`);
  const backupRoot = path.join(plan.targetRoot, backupRelative), stageRoot = path.join(plan.targetRoot, `.append-import-stage-${randomUUID()}`), installed = [];
  await mkdir(backupRoot, { recursive: true, mode: 0o700 });
  await copyTreeFiles(backupRoot, plan.targetSnapshot.files);
  const baseline = { schemaVersion: 'talewick-append-import-backup-1', projectId: plan.projectId, targetSha256: plan.targetSnapshot.sha256,
    counts: plan.targetCounts, files: plan.targetSnapshot.files.map(({ relative, sha256: digest, bytes: size }) => ({ path: relative, sha256: digest, bytes: size })),
    opaqueExcluded: plan.targetSnapshot.opaqueExcluded, opaqueBytesBackedUp: false, backupScope: 'local-confirmed-project-records-only' };
  await writeFile(path.join(backupRoot, 'BASELINE.json'), jsonBytes(baseline), { flag: 'wx', mode: 0o600 });
  await mkdir(stageRoot, { mode: 0o700 });
  const conversationGroup = plan.groups.find(group => group.type === 'replace-file');
  try {
    await stageGroups(stageRoot, plan.groups);
    await verifyFresh(plan, expectedTargetSha256);
    for (const group of plan.groups.filter(item => item.type !== 'replace-file')) {
      const from = path.join(stageRoot, group.destination), to = path.join(plan.targetRoot, group.destination); await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await rename(from, to); installed.push(to);
    }
    if (conversationGroup) {
      const destination = path.join(plan.targetRoot, conversationGroup.destination), replacement = path.join(stageRoot, conversationGroup.destination), temporary = `${destination}.append-${randomUUID()}.tmp`;
      await copyFile(replacement, temporary, fsConstants.COPYFILE_EXCL); await chmod(temporary, 0o600); await rename(temporary, destination);
    }
    const receipt = { schemaVersion: 'talewick-append-import-receipt-1', projectId: plan.projectId, expectedTargetSha256, backup: backupRelative,
      sourceRoot: plan.sourceRoot, targetRoot: plan.targetRoot, targetCountsBefore: plan.targetCounts, sourceCounts: plan.sourceCounts, mergedCounts: plan.mergedCounts,
      opaqueExcluded: plan.targetSnapshot.opaqueExcluded, opaqueBytesBackedUp: false, backupScope: 'local-confirmed-project-records-only',
      destinations: plan.groups.map(group => group.destination) };
    const receiptRelative = path.join('.append-import-receipts', `${plan.projectId}-${canonicalHash(receipt).slice(0, 20)}.json`), receiptFile = path.join(plan.targetRoot, receiptRelative);
    await mkdir(path.dirname(receiptFile), { recursive: true, mode: 0o700 }); await writeFile(receiptFile, jsonBytes(receipt), { flag: 'wx', mode: 0o600 }); installed.push(receiptFile);
    plan.mode = 'applied'; return { ...publicPlan(plan), backup: backupRelative, receipt: receiptRelative };
  } catch (error) {
    for (const destination of installed.reverse()) await rm(destination, { recursive: true, force: true }).catch(() => {});
    if (conversationGroup) {
      const backupConversation = path.join(backupRoot, conversationGroup.destination), destination = path.join(plan.targetRoot, conversationGroup.destination);
      if (await exists(backupConversation)) await copyFile(backupConversation, destination);
    }
    throw error;
  } finally { await rm(stageRoot, { recursive: true, force: true }); }
}

export async function runAppendImport(options = {}) {
  const plan = await buildAppendPlan(options);
  return options.apply ? applyAppendPlan(plan, { expectedTargetSha256: options.expectedTargetSha256 }) : publicPlan(plan);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--apply') options.apply = true;
    else if (['--source', '--target', '--project-id', '--expected-target-sha256'].includes(arg)) {
      const value = argv[++index]; if (!value) fail('ARGUMENT_INVALID', `${arg} 缺少值。`);
      options[arg === '--source' ? 'sourceRoot' : arg === '--target' ? 'targetRoot' : arg === '--project-id' ? 'projectId' : 'expectedTargetSha256'] = value;
    } else fail('ARGUMENT_INVALID', `未知参数：${arg}`);
  }
  return options;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) runAppendImport(parseArgs(process.argv.slice(2))).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)).catch(error => {
  process.stderr.write(`${JSON.stringify({ error: error.code || 'APPEND_IMPORT_FAILED', message: error.message, ...(error.details ? { details: error.details } : {}) }, null, 2)}\n`); process.exitCode = 1;
});
