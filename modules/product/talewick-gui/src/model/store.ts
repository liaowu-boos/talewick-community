import { createId, createInitialState, createProject, directions, emptyContext, makeChapters } from './seed';
import { manuscriptRevision, readRuntimeBinding, readRuntimeTask, taskActive } from './runtime';
import { getEditStart } from './revision-anchor';
import type {
  AppState, Attachment, Chapter, CompareMode, ConversationTurn, DocMode, EditResult, FlowResult,
  GenerationKind, InspirationContext, LibraryItem, Message, Mode, Page, PendingEdit,
  Phase, Project, QuoteSource, RuntimeRequest, RuntimeTask, SaveResult, StyleProfile, Version,
} from './types';

/** A new namespace: neither of the previous HTML prototypes is read or overwritten. */
export const STORAGE_KEY = 'talewick.boardui.gui.v1';
export const SCHEMA_VERSION = 1 as const;
export const RECOVERY_KEY = `${STORAGE_KEY}.recovery`;
type StorageAdapter = Pick<Storage, 'getItem' | 'setItem'>;
type UnknownRecord = Record<string, unknown>;
const clone = <T>(value: T): T => structuredClone(value);
const now = (): string => new Date().toISOString();
const record = (value: unknown): value is UnknownRecord => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const flag = (value: unknown, fallback = false): boolean => typeof value === 'boolean' ? value : fallback;
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const strings = (value: unknown): string[] => list(value).filter((item): item is string => typeof item === 'string');
const choice = <T extends string>(value: unknown, choices: readonly T[], fallback: T): T =>
  typeof value === 'string' && choices.includes(value as T) ? value as T : fallback;
const modes: Mode[] = ['auto', 'light', 'pro'];
const phases: Phase[] = ['direction', 'premise', 'turn', 'opening', 'complete', 'revision', 'done'];
const pages: Page[] = ['create', 'publication-feedback', 'library', 'styles', 'settings', 'account'];
const docModes: DocMode[] = ['read', 'edit', 'review'];
const comparisons: CompareMode[] = ['after', 'diff', 'before'];

function browserStorage(): StorageAdapter | undefined {
  try { return globalThis.localStorage; } catch { return undefined; }
}

export function characterCount(value: string): number { return Array.from(value.replace(/\s/g, '')).length; }
export function hanCharacterCount(value: string): number { return value.match(/\p{Script=Han}/gu)?.length ?? 0; }

function readContext(value: unknown): InspirationContext {
  const data = record(value) ? value : {};
  return { character: text(data.character), world: text(data.world), plot: text(data.plot), theme: text(data.theme) };
}

function readAttachments(value: unknown): Attachment[] {
  return list(value).filter(record).filter(item => typeof item.name === 'string' && typeof item.content === 'string')
    .map(item => ({ id: text(item.id) || undefined, name: text(item.name), content: text(item.content), size: typeof item.size === 'number' ? item.size : undefined, type: text(item.type) || undefined }));
}

function readChapters(value: unknown): Chapter[] {
  const ids = new Set<string>();
  return list(value).filter(record).filter(item => {
    if (!text(item.id) || ids.has(text(item.id)) || typeof item.body !== 'string') return false;
    ids.add(text(item.id)); return true;
  }).map(item => ({ id: text(item.id), title: text(item.title, '未命名章节'), body: text(item.body) }));
}

function readVersions(value: unknown): Version[] {
  return list(value).filter(record).filter(item => text(item.id) && Array.isArray(item.chapters))
    .map(item => ({ id: text(item.id), label: text(item.label, '保存稿件'), date: text(item.date, now()), ...(text(item.title) ? { title: text(item.title) } : {}), chapters: readChapters(item.chapters) }));
}

function readEdits(value: unknown): PendingEdit[] {
  return list(value).filter(record).filter(item => text(item.id) && text(item.chapterId) && text(item.before) && typeof item.after === 'string'
    && (item.start === undefined || (typeof item.start === 'number' && Number.isSafeInteger(item.start) && item.start >= 0)))
    .map(item => ({ id: text(item.id), chapterId: text(item.chapterId), before: text(item.before), after: text(item.after),
      ...(typeof item.start === 'number' ? { start: item.start } : {}),
      reason: text(item.reason), status: choice(item.status, ['pending', 'accepted', 'rejected'] as const, 'pending'), taskId: text(item.taskId) || undefined, beforeTitle: typeof item.beforeTitle === 'string' ? item.beforeTitle : undefined, afterTitle: typeof item.afterTitle === 'string' ? item.afterTitle : undefined }));
}

function readQuoteSource(value: unknown): QuoteSource | undefined {
  if (!record(value) || !text(value.chapterId) || typeof value.start !== 'number' || !Number.isSafeInteger(value.start) || value.start < 0) return undefined;
  return { chapterId: text(value.chapterId), start: value.start };
}

function readMessages(value: unknown): Message[] {
  return list(value).filter(record).filter(item => typeof item.text === 'string' && ['user', 'assistant'].includes(text(item.role)))
    .map(item => ({ id: text(item.id) || undefined, role: choice(item.role, ['user', 'assistant'] as const, 'assistant'), text: text(item.text), quote: text(item.quote) || undefined, artifact: flag(item.artifact), date: text(item.date) || undefined,
      turnId: text(item.turnId) || undefined,
      ...(typeof item.turnStatus === 'string' && ['running', 'completed', 'cancelled', 'failed', 'interrupted'].includes(item.turnStatus) ? { turnStatus: item.turnStatus as Message['turnStatus'] } : {}),
      turnError: text(item.turnError) || undefined, connectionError: text(item.connectionError) || undefined, taskId: text(item.taskId) || undefined }));
}

function readProject(value: unknown): Project | null {
  if (!record(value) || !text(value.id)) return null;
  const project = createProject(text(value.idea), choice(value.mode, modes, 'light'));
  const chapters = readChapters(value.chapters);
  const interrupted = value.status === 'writing';
  const runtime = readRuntimeBinding(value.runtime, text(value.id));
  return {
    ...project, id: text(value.id), title: text(value.title, '未命名的故事'),
    phase: choice(value.phase, phases, project.phase),
    status: taskActive(runtime?.task) ? 'writing' : interrupted ? (chapters.length ? 'ready' : 'draft') : choice(value.status, ['draft', 'ready'] as const, 'draft'),
    messages: readMessages(value.messages), chapters, versions: readVersions(value.versions), pendingEdits: readEdits(value.pendingEdits),
    docOpen: flag(value.docOpen) && chapters.length > 0, docClosedByUser: flag(value.docClosedByUser), docExpanded: flag(value.docExpanded),
    docMode: choice(value.docMode, docModes, 'read'), compare: choice(value.compare, comparisons, 'diff'),
    selectedChapter: Math.max(0, Math.min(chapters.length - 1, Number.isInteger(value.selectedChapter) ? Number(value.selectedChapter) : 0)),
    updatedAt: text(value.updatedAt, now()), context: readContext(value.context),
    libraryIds: strings(value.libraryIds), styleId: text(value.styleId) || null, attachments: readAttachments(value.attachments),
    draftInput: text(value.draftInput), direction: text(value.direction) || undefined, extraIdeas: strings(value.extraIdeas),
    paused: runtime ? false : interrupted || flag(value.paused), generationKind: choice(value.generationKind, ['opening', 'full'] as const, 'full'),
    beforeGenerationPhase: choice(value.beforeGenerationPhase, phases, project.phase), docUpdated: flag(value.docUpdated),
    editorBaseline: Array.isArray(value.editorBaseline) ? readChapters(value.editorBaseline) : null,
    editorVersionId: text(value.editorVersionId) || null, editorVersionCompare: flag(value.editorVersionCompare),
    runtime,
    runtimeHistory: list(value.runtimeHistory).map(readRuntimeTask).filter((task): task is RuntimeTask => Boolean(task && task.projectId === text(value.id))),
  };
}

function readLibrary(value: unknown): LibraryItem[] {
  return list(value).filter(record).filter(item => text(item.id) && typeof item.content === 'string').map(item => ({
    id: text(item.id), title: text(item.title, '未命名素材'), type: choice(item.type, ['小说', '素材', '设定'] as const, '素材'),
    content: text(item.content), chars: Array.from(text(item.content)).length,
    status: item.status === 'processing' ? 'error' : choice(item.status, ['ready', 'error'] as const, 'ready'),
    date: text(item.date, now()), tags: strings(item.tags), fileName: text(item.fileName) || undefined,
    error: item.status === 'processing' ? '上次导入已中断，请重新导入文本。' : text(item.error) || undefined,
  }));
}

function readStyles(value: unknown): StyleProfile[] {
  return list(value).filter(record).filter(item => text(item.id)).map(item => ({
    id: text(item.id), name: text(item.name, '未命名风格'), description: text(item.description),
    sourceIds: strings(item.sourceIds), traits: strings(item.traits), rules: text(item.rules), active: flag(item.active), date: text(item.date, now()),
  }));
}

/** Normalize storage/import data without evaluating it. Missing optional fields get safe defaults. */
export function parseState(value: unknown): AppState | null {
  if (!record(value) || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.projects)) return null;
  const defaults = createInitialState();
  const ids = new Set<string>();
  const projects = value.projects.map(readProject).filter((item): item is Project => {
    if (!item || ids.has(item.id)) return false; ids.add(item.id); return true;
  });
  const library = readLibrary(value.library);
  const styles = readStyles(value.styles);
  const settings = record(value.settings) ? value.settings : {};
  const account = record(value.account) ? value.account : {};
  const fontSize = typeof settings.fontSize === 'number' && Number.isFinite(settings.fontSize) ? Math.max(14, Math.min(28, settings.fontSize)) : 18;
  const quoteSource = readQuoteSource(value.quoteSource);
  // Corrupt explicit anchors must not silently become unanchored requests.
  const quote = value.quoteSource !== undefined && !quoteSource ? '' : text(value.quote);
  return {
    ...defaults, schemaVersion: SCHEMA_VERSION, page: choice(value.page, pages, 'create'),
    activeProjectId: projects.some(project => project.id === value.activeProjectId) ? text(value.activeProjectId) : null,
    projects, library, styles,
    settings: { reduceMotion: flag(settings.reduceMotion), autoSave: flag(settings.autoSave, true), fontSize },
    account: { name: text(account.name, '林晚'), email: text(account.email, 'linwan@example.com'), signedIn: flag(account.signedIn, true), avatar: text(account.avatar) || undefined },
    homeIdea: text(value.homeIdea), homeMode: choice(value.homeMode, modes, 'light'), context: readContext(value.context), quote,
    ...(quote && quoteSource ? { quoteSource } : {}),
    selectedLibrary: strings(value.selectedLibrary).filter(id => library.some(item => item.id === id)),
    selectedStyle: styles.some(style => style.id === value.selectedStyle) ? text(value.selectedStyle) : null,
    attachments: readAttachments(value.attachments),
  };
}

export function loadStateDetailed(storage = browserStorage()): { state: AppState; warning?: string } {
  if (!storage) return { state: createInitialState(), warning: '当前环境无法使用本地存储。' };
  let raw: string | null = null;
  try {
    raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { state: createInitialState() };
    const state = parseState(JSON.parse(raw));
    if (state) return { state };
  } catch { /* Keep the original payload below before falling back to demo data. */ }
  let recovered = false;
  if (raw) {
    try { storage.setItem(RECOVERY_KEY, raw); recovered = true; } catch { /* A full/unavailable store must not prevent startup. */ }
  }
  return { state: createInitialState(), warning: recovered ? '本地数据无法读取，原始内容已保留在恢复备份中。' : '本地数据无法读取，已打开演示工作台。' };
}

export function loadState(storage = browserStorage()): AppState { return loadStateDetailed(storage).state; }

/** Explicit persistence always saves. The caller controls whether a keystroke should call it. */
export function saveState(state: AppState, storage = browserStorage()): SaveResult {
  if (!storage) return { ok: false, error: '浏览器无法使用本地存储，请先导出重要稿件。' };
  try { storage.setItem(STORAGE_KEY, JSON.stringify({ ...state, schemaVersion: SCHEMA_VERSION })); return { ok: true }; }
  catch { return { ok: false, error: '本地存储已满或不可用。请先导出重要稿件，再清理素材。' }; }
}

/** MUTATION CONTRACT: project helpers below mutate the given project only.
 * React callers must pass a project inside their cloned update draft, never live state.
 * No helper saves storage, starts a timer, renders UI, or changes another project.
 */
export function snapshotProject(project: Project, label: string): Version | null {
  if (!project.chapters.length) return null;
  const version: Version = { id: createId('version'), label: label.trim() || '保存稿件', date: now(), title: project.title, chapters: clone(project.chapters) };
  project.versions.push(version);
  project.updatedAt = version.date;
  return version;
}

export function restoreVersion(project: Project, versionId: string): boolean {
  const selected = project.versions.find(version => version.id === versionId);
  if (!selected) return false;
  const restored = clone(selected.chapters);
  snapshotProject(project, '恢复历史前的稿件');
  if (selected.title) project.title = selected.title;
  project.chapters = restored;
  snapshotProject(project, `恢复：${selected.label}`);
  project.pendingEdits = [];
  project.editorBaseline = null;
  project.docMode = 'read';
  project.selectedChapter = Math.max(0, Math.min(project.selectedChapter, restored.length - 1));
  project.updatedAt = now();
  return true;
}

export function beginEditing(project: Project): void {
  project.editorBaseline ??= clone(project.chapters);
  project.docMode = 'edit';
}

export function updateChapter(project: Project, chapterId: string, changes: Partial<Pick<Chapter, 'title' | 'body'>>): boolean {
  const chapter = project.chapters.find(item => item.id === chapterId);
  if (!chapter) return false;
  project.editorBaseline ??= clone(project.chapters);
  if (changes.title !== undefined) chapter.title = changes.title;
  if (changes.body !== undefined) chapter.body = changes.body;
  project.updatedAt = now();
  return true;
}

export function saveEditorVersion(project: Project, label = '手动修改'): boolean {
  if (!project.editorBaseline || JSON.stringify(project.editorBaseline) === JSON.stringify(project.chapters)) return false;
  snapshotProject(project, label);
  project.editorBaseline = clone(project.chapters);
  return true;
}

export function undoEditing(project: Project): boolean {
  if (!project.editorBaseline) return false;
  project.chapters = clone(project.editorBaseline);
  project.updatedAt = now();
  return true;
}

export function pendingEdits(project: Project): PendingEdit[] { return project.pendingEdits.filter(edit => edit.status === 'pending'); }

export function beginRuntimeTask(project: Project, request: RuntimeRequest): void {
  if (project.runtime?.task) project.runtimeHistory = [...(project.runtimeHistory ?? []), clone(project.runtime.task)];
  project.runtime = { request: clone(request), baseManuscript: { title: project.title, chapters: clone(project.chapters) }, submitting: true };
  project.status = 'writing';
  project.paused = false;
  project.updatedAt = now();
}

/** Bind tool-created tasks to the exact manuscript the conversation submitted. */
export function attachConversationTask(project: Project, turnId: string, request: RuntimeRequest, task: RuntimeTask): void {
  if (request.projectId !== project.id || task.projectId !== project.id || request.requestId !== task.requestId || request.baseRevision !== task.baseRevision || request.kind !== task.kind || request.revisionMode !== task.revisionMode) return;
  const message = project.messages.find(item => item.turnId === turnId && item.role === 'assistant');
  if (message) message.taskId = task.id;
  const historical = project.runtimeHistory?.find(item => item.id === task.id);
  if (historical) {
    if (Date.parse(task.updatedAt) >= Date.parse(historical.updatedAt)) Object.assign(historical, clone(task));
    return;
  }
  const current = project.runtime?.task;
  if (current && current.id !== task.id && (taskActive(current) || Date.parse(current.createdAt) > Date.parse(task.createdAt))) {
    project.runtimeHistory = [...(project.runtimeHistory ?? []), clone(task)];
    return;
  }
  if (project.runtime?.request.requestId !== request.requestId) {
    beginRuntimeTask(project, request);
    project.runtime!.baseManuscript = { title: request.projectTitle ?? project.title, chapters: clone(request.chapters) };
  }
  applyRuntimeTask(project, task);
}

/** Consume a selected excerpt only when its new tool task arrives, never on ordinary chat sends. */
export function clearSubmittedConversationQuote(state: AppState, project: Project, request: RuntimeRequest, task: RuntimeTask): void {
  if (state.activeProjectId !== project.id || request.projectId !== project.id || task.projectId !== project.id || request.requestId !== task.requestId || request.baseRevision !== task.baseRevision || !request.quote || state.quote !== request.quote) return;
  if (state.quoteSource?.chapterId !== request.quoteSource?.chapterId || state.quoteSource?.start !== request.quoteSource?.start) return;
  if (project.runtime?.task?.id === task.id || project.runtimeHistory?.some(item => item.id === task.id) || project.messages.some(message => message.taskId === task.id)) return;
  state.quote = ''; state.quoteSource = undefined;
}

/** Server snapshots replace partial assistant text; reconnects never append the same user twice. */
export function applyConversationTurn(project: Project, turn: ConversationTurn): void {
  if (turn.projectId !== project.id) return;
  if (!project.messages.some(item => item.role === 'user' && item.turnId === turn.id)) {
    project.messages.push({ id: `turn-user-${turn.id}`, role: 'user', turnId: turn.id, text: turn.userText, date: turn.createdAt });
  }
  let message = project.messages.find(item => item.role === 'assistant' && item.turnId === turn.id);
  if (!message) { message = { id: `turn-assistant-${turn.id}`, role: 'assistant', turnId: turn.id, text: '', date: turn.createdAt }; project.messages.push(message); }
  message.text = turn.assistantText; message.turnStatus = turn.status;
  message.turnError = turn.error; message.connectionError = undefined;
  project.updatedAt = turn.updatedAt || now();
  if (turn.task) attachConversationTask(project, turn.id, turn.task.request, turn.task.task);
}

/** Result identity and the exact submitted manuscript must both match before applying anything. */
export function applyRuntimeTask(project: Project, task: RuntimeTask): boolean {
  const binding = project.runtime;
  if (!binding || task.projectId !== project.id || task.requestId !== binding.request.requestId || task.baseRevision !== binding.request.baseRevision || task.kind !== binding.request.kind || task.revisionMode !== binding.request.revisionMode || (binding.task && binding.task.id !== task.id)) {
    if (binding) {
      binding.submitting = false;
      binding.connectionError = '任务身份或稿件版本不匹配，返回结果尚未应用。';
      project.status = taskActive(binding.task) ? 'writing' : project.chapters.length ? 'ready' : 'draft';
    }
    return false;
  }
  if (binding.task && Date.parse(task.updatedAt) < Date.parse(binding.task.updatedAt)) return false;
  binding.task = clone(task);
  binding.submitting = false;
  binding.connectionError = undefined;
  project.status = taskActive(task) ? 'writing' : project.chapters.length ? 'ready' : 'draft';
  project.paused = false;
  project.updatedAt = task.updatedAt || now();
  if (task.status !== 'completed' || binding.handledTaskId === task.id) return true;
  binding.handledTaskId = task.id;
  binding.resultDisposition = 'held';
  const result = task.result;
  if (!result) { binding.message = '任务结束，但没有收到完整稿件。当前正文已保留，请检查服务端任务记录。'; return true; }
  const current = { title: project.title, chapters: project.chapters };
  if (manuscriptRevision(project) !== binding.request.baseRevision || JSON.stringify(current) !== JSON.stringify(binding.baseManuscript)) {
    binding.message = '你在任务运行期间修改了稿件。本次结果已保留供查看，当前正文未被覆盖。';
    return true;
  }
  if (task.kind === 'create') {
    if (project.chapters.length) { binding.message = '当前已有稿件，本次创作结果已单独保留。'; return true; }
    project.title = result.title || project.title;
    project.chapters = clone(result.chapters);
    snapshotProject(project, '创作初稿');
    project.phase = 'done'; project.status = 'ready';
    project.docMode = 'read';
    binding.resultDisposition = 'applied';
    binding.message = '初稿已保存，可以阅读、编辑和导出。检查范围及未覆盖项见本次结果。';
  } else if (binding.request.revisionMode === 'whole-manuscript-v1') {
    const structurallyBound = task.revisionMode === 'whole-manuscript-v1' && Boolean(result.wholeRevision) && result.chapters.length === project.chapters.length && result.chapters.every((chapter, index) => chapter.id === project.chapters[index]?.id);
    if (!structurallyBound || pendingEdits(project).length) {
      binding.message = '整稿候选与任务起点的章节结构不一致，或当前仍有待处理建议。结果已保留，当前正文未被覆盖。';
      return true;
    }
    if (result.wholeRevision?.status === 'no_change') {
      binding.resultDisposition = 'declined';
      binding.message = '整稿诊断与方案决定保留原稿，没有形成需要采纳的修改；诊断、证据和复读记录仍可查看。';
    } else {
    binding.resultDisposition = 'whole-revision-candidate';
    binding.message = '整稿修订候选已生成。方案、证据、未解决项和独立复读状态可展开查看；明确整体采纳前，当前正文保持原样。';
    }
  } else {
    if (pendingEdits(project).length || result.chapters.length !== project.chapters.length || result.chapters.some((chapter, index) => chapter.id !== project.chapters[index]?.id) || project.chapters.some(chapter => !chapter.body)) {
      binding.message = '本次结果包含章节结构变化，或当前仍有待处理建议。完整结果已保留，请查看后决定如何修改。';
      return true;
    }
    const edits = result.chapters.flatMap(chapter => {
      const before = project.chapters.find(item => item.id === chapter.id)!;
      if (before.body === chapter.body && before.title === chapter.title) return [];
      return [{ id: createId('edit'), chapterId: chapter.id, before: before.body, after: chapter.body, beforeTitle: before.title, afterTitle: chapter.title,
        reason: `${result.review.summary || '本次修改建议'}${before.title !== chapter.title ? `\n章节标题建议：${before.title} → ${chapter.title}` : ''}`,
        taskId: task.id, status: 'pending' as const }];
    });
    project.pendingEdits.push(...edits);
    project.compare = 'diff'; project.docMode = edits.length ? 'review' : 'read';
    binding.resultDisposition = 'proposals';
    binding.message = edits.length ? `已准备 ${edits.length} 章修改建议，采纳后才会更新正文。` : '本次返回的章节内容与当前稿件一致，没有待采纳修改。';
    if (result.title !== project.title) binding.message += ' 稿件标题建议保存在本次结果中，当前作品标题保留。';
  }
  if (!project.docClosedByUser) project.docOpen = true; else project.docUpdated = true;
  project.messages.push({ id: createId('message'), role: 'assistant', date: now(), artifact: Boolean(project.chapters.length), text: binding.message });
  return true;
}

export function canAdoptWholeRevisionCandidate(project: Project): boolean {
  const binding = project.runtime;
  const task = binding?.task;
  if (!binding || binding.request.revisionMode !== 'whole-manuscript-v1' || task?.status !== 'completed' || task.revisionMode !== 'whole-manuscript-v1' || !task.result?.wholeRevision || task.result.wholeRevision.status === 'no_change' || binding.resultDisposition !== 'whole-revision-candidate') return false;
  return manuscriptRevision(project) === binding.request.baseRevision && JSON.stringify({ title: project.title, chapters: project.chapters }) === JSON.stringify(binding.baseManuscript)
    && task.result.chapters.length === project.chapters.length && task.result.chapters.every((chapter, index) => chapter.id === project.chapters[index]?.id);
}

export function acceptWholeRevisionCandidate(project: Project): boolean {
  if (!canAdoptWholeRevisionCandidate(project)) return false;
  const binding = project.runtime!;
  const result = binding.task!.result!;
  snapshotProject(project, '采纳整稿修订前');
  project.title = result.title || project.title;
  project.chapters = clone(result.chapters);
  snapshotProject(project, '整稿修订候选');
  binding.resultDisposition = 'applied';
  binding.message = '已整体采纳整稿修订候选；采纳前原稿已保存在版本记录。';
  project.docMode = 'read'; project.compare = 'after'; project.updatedAt = now();
  return true;
}

export function declineWholeRevisionCandidate(project: Project): boolean {
  const binding = project.runtime;
  if (!binding || binding.request.revisionMode !== 'whole-manuscript-v1' || binding.resultDisposition !== 'whole-revision-candidate') return false;
  binding.resultDisposition = 'declined';
  binding.message = '已保留原稿。整稿修订候选仍留在任务结果中，可继续查看。';
  project.updatedAt = now();
  return true;
}

function proposedText(before: string, instruction: string): { after: string; reason: string } {
  if (/精简|简短|紧凑|啰嗦|简洁|缩短/.test(instruction)) {
    let after = before.replace(/其实|真的|似乎|仿佛|有些|慢慢地|轻轻地|不由得/g, '');
    const sentences = after.match(/[^。！？]+[。！？]?/g) || [after];
    if (sentences.length > 1) after = sentences.length > 2 ? sentences[0] + sentences[sentences.length - 1] : sentences[0];
    return { after, reason: '精简表达示例：收紧叙述，保留动作与关键信息。请结合原意决定是否采用。' };
  }
  if (/对话|对白/.test(instruction)) return { after: `${before}\n\n“你想清楚了吗？”\n“这一次，想清楚了。”`, reason: '对话示例：用一问一答表现人物的决定。此为前端预置改写。' };
  if (/悬念|紧张|反转/.test(instruction)) return { after: `${before}\n\n门外响起两下敲门声。可约好要来的人，早在昨天就失踪了。`, reason: '悬念示例：在段落末尾加入新的疑问，测试推进节奏。' };
  const replaced = before.replace('她觉得很害怕，也很想念母亲。', '她把钥匙攥紧，指节渐渐发白。')
    .replace('她把钥匙攥紧，指节渐渐发白。', '她把钥匙换到另一只手里，掌心留下一道浅红的痕。');
  return { after: replaced === before ? `${before}\n\n她没有再解释，只把那张纸折好，放进了口袋。` : replaced, reason: '动作改写示例：用具体动作承接情绪。这是预置建议，可采纳或保留原文。' };
}

/** Legacy local proposals remain isolated from the real runtime; anchors only improve targeting. */
export function proposeEdits(project: Project, quote: string, instruction: string, source?: QuoteSource): number {
  if (!project.chapters.length || pendingEdits(project).length) return 0;
  const quoted = quote.trim();
  let target = project.chapters[project.selectedChapter] || project.chapters[0];
  let start = -1;
  if (source) {
    const sourceChapter = project.chapters.find(chapter => chapter.id === source.chapterId);
    if (!quoted || !sourceChapter || !Number.isSafeInteger(source.start) || source.start < 0 || getEditStart(sourceChapter.body, { before: quoted, start: source.start }) < 0) return 0;
    target = sourceChapter;
    start = source.start;
  } else if (quoted) {
    const candidates = project.chapters.filter(chapter => chapter.body.includes(quoted));
    if (candidates.length !== 1) return 0;
    target = candidates[0];
    start = getEditStart(target.body, { before: quoted });
    if (start < 0) return 0;
  }
  if (!target) return 0; // A stale selection must not silently rewrite a different paragraph.
  const before = quoted || (target.body.split(/\n\s*\n/).find(paragraph => paragraph.trim().length > 20) || target.body).trim();
  if (!before) return 0;
  if (start < 0) start = target.body.indexOf(before);
  if (start < 0) return 0;
  const proposal = proposedText(before, instruction);
  if (proposal.after === before) return 0;
  project.pendingEdits.push({ id: createId('edit'), chapterId: target.id, before, start, ...proposal, status: 'pending' });
  project.selectedChapter = project.chapters.findIndex(chapter => chapter.id === target.id);
  project.compare = 'diff';
  project.docMode = 'review';
  if (!project.docClosedByUser) project.docOpen = true; else project.docUpdated = true;
  project.updatedAt = now();
  return 1;
}

export function canApplyPendingEdit(edit: PendingEdit, chapter?: Chapter): boolean {
  return Boolean(chapter && chapter.id === edit.chapterId && (edit.taskId
    ? chapter.body === edit.before && chapter.title === edit.beforeTitle && getEditStart(chapter.body, edit) === 0
    : getEditStart(chapter.body, edit) >= 0));
}

export function acceptPendingEdits(project: Project, editIds?: string[]): EditResult {
  const edits = pendingEdits(project).filter(edit => !editIds || editIds.includes(edit.id));
  const valid = edits.map(edit => {
    const chapter = project.chapters.find(item => item.id === edit.chapterId);
    return { edit, start: chapter && canApplyPendingEdit(edit, chapter) ? getEditStart(chapter.body, edit) : -1 };
  }).filter(item => item.start >= 0).sort((left, right) => right.start - left.start);
  if (!valid.length) return { accepted: 0, skipped: edits.length };
  snapshotProject(project, '采纳修改前');
  let accepted = 0;
  const appliedRanges = new Map<string, Array<{ start: number; end: number }>>();
  for (const { edit, start } of valid) {
    const chapter = project.chapters.find(item => item.id === edit.chapterId);
    const ranges = appliedRanges.get(edit.chapterId) || [];
    const end = start + edit.before.length;
    if (ranges.some(range => start < range.end && end > range.start)) continue;
    if (!chapter || !canApplyPendingEdit({ ...edit, start }, chapter)) continue;
    chapter.body = edit.taskId ? edit.after : chapter.body.slice(0, start) + edit.after + chapter.body.slice(end);
    if (edit.taskId && edit.afterTitle !== undefined) chapter.title = edit.afterTitle;
    ranges.push({ start, end }); appliedRanges.set(edit.chapterId, ranges);
    edit.status = 'accepted'; accepted += 1;
  }
  if (accepted) snapshotProject(project, accepted > 1 ? `采纳 ${accepted} 处修改` : '采纳修改');
  project.editorBaseline = null;
  project.updatedAt = now();
  return { accepted, skipped: edits.length - accepted };
}

export function rejectPendingEdits(project: Project, editIds?: string[]): number {
  const edits = pendingEdits(project).filter(edit => !editIds || editIds.includes(edit.id));
  for (const edit of edits) edit.status = 'rejected';
  if (edits.length) project.updatedAt = now();
  return edits.length;
}

export function beginGeneration(project: Project, kind: GenerationKind = 'full'): boolean {
  if (project.status === 'writing') return false;
  project.beforeGenerationPhase = project.phase;
  project.generationKind = kind;
  project.status = 'writing';
  project.paused = false;
  project.updatedAt = now();
  return true;
}

export function pauseGeneration(project: Project): boolean {
  if (project.status !== 'writing') return false;
  project.status = project.chapters.length ? 'ready' : 'draft';
  project.paused = true;
  project.updatedAt = now();
  return true;
}

export function resumeGeneration(project: Project): boolean {
  if (!project.paused) return false;
  return beginGeneration(project, project.generationKind || 'full');
}

export function chooseDirection(project: Project, directionId: string): boolean {
  if (project.status === 'writing' || project.chapters.length || !directions.some(direction => direction.id === directionId)) return false;
  project.direction = directionId;
  project.updatedAt = now();
  return true;
}

/** Generated chapters fill missing IDs only; existing titles, bodies and custom chapters win. */
export function mergeChaptersPreservingEdits(existing: Chapter[], incoming: Chapter[]): Chapter[] {
  if (!existing.length) return clone(incoming);
  const ids = new Set(existing.map(chapter => chapter.id));
  // A different demo story must never be inserted into an unrelated existing manuscript.
  if (!incoming.some(chapter => ids.has(chapter.id))) return clone(existing);
  return [...clone(existing), ...clone(incoming.filter(chapter => !ids.has(chapter.id)))];
}

/** Call only when the UI's current demo timer completes; paused work cannot complete itself. */
export function completeGeneration(project: Project, kind: GenerationKind = project.generationKind || 'full'): boolean {
  if (project.status !== 'writing' || project.paused) return false;
  const incoming = makeChapters();
  project.chapters = mergeChaptersPreservingEdits(project.chapters, kind === 'opening' ? incoming.slice(0, 4) : incoming);
  if (project.title === '未命名的故事') project.title = '雨停之前';
  project.status = 'ready';
  project.phase = kind === 'opening' ? 'opening' : project.mode === 'pro' ? 'complete' : 'done';
  snapshotProject(project, kind === 'opening' ? '开篇 · 前四章' : '初稿 · 完整故事');
  project.messages.push({ id: createId('message'), role: 'assistant', date: now(), artifact: true,
    text: kind === 'opening' ? '前四章已经写好。先看看开篇节奏，你可以直接修改；继续生成时会保留已经修改的内容。' : '完整初稿已就绪。你可以直接修改，也可以选中一句话，告诉我想怎么改。当前内容为预置演示稿。' });
  if (!project.docClosedByUser) project.docOpen = true; else project.docUpdated = true;
  project.updatedAt = now();
  return true;
}

/** Naming alias for UIs that pair beginGeneration() with finishGeneration(). */
export function finishGeneration(project: Project, kind?: GenerationKind): boolean {
  return completeGeneration(project, kind);
}

function requestGeneration(project: Project, kind: GenerationKind): FlowResult {
  beginGeneration(project, kind);
  return { kind: 'generation', generationKind: kind };
}

/** Advances one user-confirmed checkpoint. The caller owns timers for generation results. */
export function advanceProject(project: Project): FlowResult {
  if (project.status === 'writing') return { kind: 'blocked', reason: '稿件正在生成，请先等待或暂停。' };
  if (project.paused) return requestGeneration(project, project.generationKind || 'full');
  if (project.mode === 'auto') return project.chapters.length ? { kind: 'done' } : requestGeneration(project, 'full');
  if (project.mode === 'light') {
    if (project.chapters.length) return { kind: 'done' };
    if (!directions.some(direction => direction.id === project.direction)) return { kind: 'blocked', reason: '先选一个故事方向。' };
    return requestGeneration(project, 'full');
  }
  if (project.phase === 'premise') {
    project.phase = 'turn';
    project.messages.push({ id: createId('message'), role: 'assistant', text: '前提已确认。接下来，让第四章把故事推向一个无法回避的选择。' });
  } else if (project.phase === 'turn') return requestGeneration(project, 'opening');
  else if (project.phase === 'opening') return requestGeneration(project, 'full');
  else if (project.phase === 'complete') {
    project.phase = 'revision';
    project.messages.push({ id: createId('message'), role: 'assistant', text: '完整稿已确认。下一步可以检查节奏、人物动机与结尾；原稿会保留。' });
  } else if (project.phase === 'revision') {
    if (pendingEdits(project).length) return { kind: 'blocked', reason: '请先处理上一轮待审修改。' };
    proposeEdits(project, '', '收紧开篇描写，让异常更早出现。');
    project.phase = 'done';
    project.messages.push({ id: createId('message'), role: 'assistant', artifact: true, text: '本轮演示修改建议已准备好，可以逐条查看差异后决定是否采纳。' });
  } else return { kind: 'done' };
  project.updatedAt = now();
  return { kind: 'advanced', phase: project.phase };
}

export function exportManuscript(project: Project, format: 'txt' | 'md' = 'md', chapters = project.chapters): string {
  const markdown = format === 'md';
  return `${markdown ? '# ' : ''}${project.title}\n\n` + chapters.map(chapter => `${markdown ? '## ' : ''}${chapter.title}\n\n${chapter.body}`).join('\n\n---\n\n');
}

export function clearHomeContext(state: AppState): void {
  state.activeProjectId = null; state.page = 'create'; state.homeIdea = ''; state.quote = '';
  delete state.quoteSource;
  state.context = emptyContext(); state.attachments = [];
}
