import {createId} from './seed.ts';
import type {Chapter, Project} from './types.ts';

export interface CheckpointPlan {
  projectId: string;
  title: string;
  chapters: Chapter[];
  versionId: string;
}

function validManuscript(project: Pick<Project, 'title' | 'chapters'>): boolean {
  if (typeof project.title !== 'string' || !Array.isArray(project.chapters) || !project.chapters.length) return false;
  const ids = new Set<string>();
  for (const chapter of project.chapters) {
    if (!chapter || typeof chapter.id !== 'string' || !chapter.id || ids.has(chapter.id) ||
        typeof chapter.title !== 'string' || typeof chapter.body !== 'string') return false;
    ids.add(chapter.id);
  }
  return true;
}

export function prepareCheckpoint(project: Project): CheckpointPlan | null {
  if (!project.id || !validManuscript(project)) return null;
  return {projectId: project.id, title: project.title, chapters: structuredClone(project.chapters), versionId: createId('version')};
}

export function canApplyCheckpoint(project: Project, plan: CheckpointPlan): boolean {
  return project.id === plan.projectId && validManuscript(project) &&
    typeof plan.versionId === 'string' && Boolean(plan.versionId) &&
    !project.versions.some(version => version.id === plan.versionId) &&
    project.title === plan.title && JSON.stringify(project.chapters) === JSON.stringify(plan.chapters);
}

/** Capture saved text only. Suggestions, runtime bindings and editor baselines stay intact. */
export function applyCheckpoint(project: Project, plan: CheckpointPlan, label: string): boolean {
  const name = label.trim();
  if (!name || !canApplyCheckpoint(project, plan)) return false;
  const date = new Date().toISOString();
  project.versions.push({id: plan.versionId, label: name, title: plan.title, date, chapters: structuredClone(plan.chapters)});
  project.updatedAt = date;
  return true;
}
