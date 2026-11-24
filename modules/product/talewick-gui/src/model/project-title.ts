import { createId } from './seed.ts';
import { runtimeBusy } from './runtime.ts';
import { prepareCheckpoint, canApplyCheckpoint } from './version-checkpoint.ts';
import type { Chapter, Project, Version } from './types.ts';

export interface ProjectTitlePlan {
  projectId: string;
  title: string;
  chapters: Chapter[];
  beforeVersionId: string;
  afterVersionId: string;
}

export function prepareProjectTitle(project: Project): ProjectTitlePlan | null {
  if (runtimeBusy(project)) return null;
  const checkpoint = prepareCheckpoint(project);
  if (!checkpoint) return null;
  const plan: ProjectTitlePlan = {
    projectId: checkpoint.projectId, title: checkpoint.title, chapters: checkpoint.chapters,
    beforeVersionId: checkpoint.versionId, afterVersionId: createId('version'),
  };
  return canApplyProjectTitle(project, plan) ? plan : null;
}

export function canApplyProjectTitle(project: Project, plan: ProjectTitlePlan): boolean {
  return !runtimeBusy(project)
    && typeof plan.afterVersionId === 'string' && Boolean(plan.afterVersionId)
    && plan.beforeVersionId !== plan.afterVersionId
    && !project.versions.some(version => version.id === plan.afterVersionId)
    && canApplyCheckpoint(project, { ...plan, versionId: plan.beforeVersionId });
}

export function applyProjectTitle(project: Project, plan: ProjectTitlePlan, newTitle: string): boolean {
  const title = newTitle.trim();
  if (!title || title === plan.title || !canApplyProjectTitle(project, plan)) return false;
  const date = new Date().toISOString();
  const before: Version = { id: plan.beforeVersionId, label: '改名前的稿件',
    title: plan.title, date, chapters: structuredClone(plan.chapters) };
  const after: Version = { id: plan.afterVersionId, label: '修改书名后的稿件',
    title, date, chapters: structuredClone(plan.chapters) };
  project.versions.push(before, after);
  project.title = title;
  project.updatedAt = date;
  return true;
}
