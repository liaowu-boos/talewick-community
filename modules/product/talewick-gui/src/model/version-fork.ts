import { createId, createProject } from './seed.ts';
import { snapshotProject } from './store.ts';
import type { AppState, Project, Version } from './types.ts';

export interface VersionForkPlan {
  projectId: string;
  source: Version;
  fallbackTitle: string;
  newProjectId: string;
}

function readForkSource(project: Project, versionId: string): Version | null {
  const matches = project.versions.filter(version => version.id === versionId);
  if (matches.length !== 1) return null;
  const source = matches[0];
  if (typeof source.id !== 'string' || !source.id ||
      typeof source.label !== 'string' || typeof source.date !== 'string' ||
      (source.title !== undefined && typeof source.title !== 'string') ||
      !Array.isArray(source.chapters) || !source.chapters.length) return null;
  const ids = new Set<string>();
  for (const chapter of source.chapters) {
    if (!chapter || typeof chapter.id !== 'string' || !chapter.id || ids.has(chapter.id) ||
        typeof chapter.title !== 'string' || typeof chapter.body !== 'string') return null;
    ids.add(chapter.id);
  }
  return source;
}

export function prepareVersionFork(project: Project, versionId: string): VersionForkPlan | null {
  const source = readForkSource(project, versionId);
  if (!source) return null;
  return { projectId: project.id, source: structuredClone(source),
    fallbackTitle: source.title || project.title, newProjectId: createId('project') };
}

export function canApplyVersionFork(project: Project, plan: VersionForkPlan): boolean {
  if (project.id !== plan.projectId) return false;
  const source = readForkSource(project, plan.source.id);
  return source !== null && (source.title || project.title) === plan.fallbackTitle
    && JSON.stringify(source) === JSON.stringify(plan.source);
}

export function appendVersionFork(state: AppState, plan: VersionForkPlan, title: string): string | null {
  const name = title.trim();
  const sources = state.projects.filter(project => project.id === plan.projectId);
  if (!name || sources.length !== 1 || !canApplyVersionFork(sources[0], plan) ||
      typeof plan.newProjectId !== 'string' || !plan.newProjectId ||
      state.projects.some(project => project.id === plan.newProjectId)) return null;

  const project = createProject('', 'auto');
  project.id = plan.newProjectId;
  project.title = name;
  project.chapters = plan.source.chapters.map(chapter => ({
    id: createId('chapter'), title: chapter.title, body: chapter.body,
  }));
  project.phase = 'done';
  project.status = 'ready';
  project.docOpen = true;
  project.docMode = 'read';
  project.messages = [{ id: createId('message'), role: 'assistant',
    text: '已从存稿创建独立作品，可以继续编辑。', date: project.updatedAt }];
  snapshotProject(project, '从存稿创建');

  state.projects.push(project);
  state.activeProjectId = project.id;
  state.page = 'create';
  state.quote = '';
  state.quoteSource = undefined;
  return project.id;
}
