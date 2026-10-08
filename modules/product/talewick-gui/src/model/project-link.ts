import { getConversation } from './conversation';
import { createId, createProject } from './seed';
import { manuscriptRevision } from './runtime';
import { applyConversationTurn } from './store';
import type { AppState, ConversationTurn, Project, StyleProfile } from './types';

export interface ProjectLink { projectId?: string; error?: string }
export interface RecoveredProject { project: Project; style?: StyleProfile }
const validId = (value: string): boolean => /^[\w-]{1,160}$/.test(value);

/** Only an explicitly named project is eligible; the ordinary home URL does nothing. */
export function readProjectLink(search: string): ProjectLink {
  const values = new URLSearchParams(search).getAll('project');
  if (!values.length) return {};
  if (values.length !== 1 || !validId(values[0])) return { error: '创作链接中的项目标识无效，现有项目已保留。' };
  return { projectId: values[0] };
}

/** Restore the last submitted manuscript, never infer edits from another browser. */
export function recoverLinkedProject(projectId: string, turns: ConversationTurn[]): RecoveredProject {
  if (!validId(projectId) || turns.some(turn => turn.projectId !== projectId)) throw new Error('创作链接与对话记录不匹配，现有项目已保留。');
  const latest = [...turns].reverse().find(turn => turn.task)?.task;
  if (!latest) throw new Error('未找到这条链接对应的创作任务。请确认链接及当前服务；现有项目已保留。');
  const request = latest.request;
  const project = createProject(request.idea, 'auto');
  project.id = projectId;
  project.title = request.projectTitle ?? project.title;
  project.chapters = structuredClone(request.chapters);
  // This is the same guard used when a live result arrives. Do not weaken it for recovery.
  if (manuscriptRevision(project) !== request.baseRevision) throw new Error('此前提交的稿件基线不完整，无法安全恢复项目。现有项目已保留。');
  project.context = structuredClone(request.context);
  project.attachments = request.materials.map(item => ({ id: item.id, name: item.title, content: item.content }));
  project.messages = [];
  project.docOpen = project.chapters.length > 0;
  project.phase = project.chapters.length ? 'done' : 'direction';
  project.status = project.chapters.length ? 'ready' : 'draft';
  if (project.chapters.length) project.versions = [{ id: createId('version'), label: '上次提交的稿件', date: latest.task.createdAt, chapters: structuredClone(project.chapters) }];
  project.runtime = { request: structuredClone(request), baseManuscript: { title: project.title, chapters: structuredClone(project.chapters) }, task: structuredClone(latest.task) };
  // Older completed turns must not apply their output over the latest submitted snapshot.
  project.runtimeHistory = [...new Map(turns.flatMap(turn => turn.task && turn.task.task.id !== latest.task.id ? [[turn.task.task.id, structuredClone(turn.task.task)] as const] : [])).values()];
  for (const turn of turns) applyConversationTurn(project, turn);
  let style: StyleProfile | undefined;
  if (request.style) {
    style = { ...structuredClone(request.style), id: createId('style'), sourceIds: [], active: true, date: latest.task.createdAt };
    project.styleId = style.id;
  }
  return { project, style };
}

export async function loadLinkedProject(projectId: string): Promise<RecoveredProject> {
  if (!validId(projectId)) throw new Error('创作链接中的项目标识无效，现有项目已保留。');
  return recoverLinkedProject(projectId, await getConversation(projectId));
}

/** A local copy always wins, including edits made while the recovery GET was pending. */
export function installLinkedProject(state: AppState, recovered: RecoveredProject, activate: boolean): boolean {
  const exists = state.projects.some(project => project.id === recovered.project.id);
  if (!exists) {
    state.projects.unshift(structuredClone(recovered.project));
    if (recovered.style) state.styles.push(structuredClone(recovered.style));
  }
  if (activate) selectLinkedProject(state, recovered.project.id);
  return !exists;
}

export function selectLinkedProject(state: AppState, projectId: string): void {
  if (!state.projects.some(project => project.id === projectId)) return;
  if (state.activeProjectId !== projectId) { state.quote = ''; state.quoteSource = undefined; }
  state.activeProjectId = projectId;
  state.page = 'create';
}
