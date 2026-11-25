import { exportManuscript } from './store.ts';
import type { Project, Version } from './types.ts';

export interface VersionExportPlan {
  projectId: string;
  version: Version;
}

function readExportVersion(project: Project, versionId: string): Version | null {
  const matches = project.versions.filter(version => version?.id === versionId);
  if (matches.length !== 1) return null;
  const version = matches[0];
  if (typeof version.id !== 'string' || !version.id ||
      typeof version.label !== 'string' || typeof version.date !== 'string' ||
      (version.title !== undefined && typeof version.title !== 'string') ||
      !Array.isArray(version.chapters) || !version.chapters.length) return null;
  const ids = new Set<string>();
  for (const chapter of version.chapters) {
    if (!chapter || typeof chapter.id !== 'string' || !chapter.id || ids.has(chapter.id) ||
        typeof chapter.title !== 'string' || typeof chapter.body !== 'string') return null;
    ids.add(chapter.id);
  }
  return version;
}

export function prepareVersionExport(project: Project, versionId: string): VersionExportPlan | null {
  const version = readExportVersion(project, versionId);
  return version ? { projectId: project.id, version: structuredClone(version) } : null;
}

export function canExportVersion(project: Project, plan: VersionExportPlan): boolean {
  if (project.id !== plan.projectId) return false;
  const version = readExportVersion(project, plan.version.id);
  return version !== null && JSON.stringify(version) === JSON.stringify(plan.version);
}

function filenamePart(value: string, fallback: string): string {
  const clean = value.replace(/[<>:"/\\|?*\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .trim().replace(/^[. ]+|[. ]+$/g, '');
  const encoder = new TextEncoder();
  let result = '';
  let bytes = 0;
  // Two 100-byte parts leave room for the separator and extension on common filesystems.
  for (const character of clean) {
    const size = encoder.encode(character).length;
    if (bytes + size > 100) break;
    result += character;
    bytes += size;
  }
  return result.replace(/[. ]+$/g, '') || fallback;
}

export function renderVersionExport(
  project: Project, plan: VersionExportPlan, format: 'txt' | 'md', missingTitle?: string,
): { filename: string; text: string } | null {
  if ((format !== 'txt' && format !== 'md') || !canExportVersion(project, plan)) return null;
  const title = plan.version.title?.trim() ? plan.version.title : missingTitle?.trim();
  if (!title) return null;
  return {
    filename: filenamePart(title, '稿件') + '-' + filenamePart(plan.version.label, '存稿') + '.' + format,
    text: exportManuscript({ ...project, title }, format, plan.version.chapters),
  };
}
