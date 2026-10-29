import { createProject } from './seed';
import { manuscriptRevision, readRuntimeBinding, readRuntimeTask } from './runtime';
import type { AppState, Chapter, ImportedBaseline, Project, RuntimeRequest, RuntimeTask } from './types';

interface ImportSnapshot {
  schemaVersion: string; projectId: string; baseline: RuntimeTask | null; baselineRequest: RuntimeRequest | null;
  revision: RuntimeTask | null; revisionRequest: RuntimeRequest | null; history: RuntimeTask[]; baselineSha256: string;
  baselineManuscript?: ImportedBaseline & { chapters: Chapter[] };
  revisionRequestSpec?: Record<string, unknown>;
}

export function readImportedBaseline(value: unknown): ImportedBaseline | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (item.provenance !== 'whole_revision_source' || item.qualityCheckStatus !== 'incomplete'
    || !['sourceTaskId', 'sourceRequestId', 'title', 'baseRevision', 'sourceManuscriptSha256'].every(key => typeof item[key] === 'string' && (item[key] as string).trim())
    || !/^[a-f0-9]{64}$/.test(item.sourceManuscriptSha256 as string)) return undefined;
  return { provenance: 'whole_revision_source', sourceTaskId: item.sourceTaskId as string,
    sourceRequestId: item.sourceRequestId as string, title: item.title as string, baseRevision: item.baseRevision as string,
    sourceManuscriptSha256: item.sourceManuscriptSha256 as string, qualityCheckStatus: 'incomplete' };
}

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/** Builds a new local view only. Never writes server tasks or replaces an existing local project. */
export function projectFromImportSnapshot(value: unknown, expectedProjectId: string): Project {
  const input = value as ImportSnapshot;
  if (!input || !['talewick-project-import-snapshot-1', 'talewick-project-import-snapshot-2'].includes(input.schemaVersion) || input.projectId !== expectedProjectId
    || !Array.isArray(input.history) || input.history.some(task => task.projectId !== expectedProjectId))
    throw new Error('本机故事快照的项目或基线任务绑定无效。');
  let title: string, chapters: Chapter[], date: string, versionId: string;
  let importedBaseline: ImportedBaseline | undefined;
  if (input.schemaVersion === 'talewick-project-import-snapshot-1') {
    const baseline = readRuntimeTask(input.baseline);
    if (!baseline?.result || baseline.projectId !== expectedProjectId || baseline.kind !== 'create' || baseline.status !== 'completed')
      throw new Error('基线任务没有可读取的完整正文。');
    title = baseline.result.title; chapters = baseline.result.chapters; date = baseline.updatedAt; versionId = `import-${baseline.id}`;
  } else {
    importedBaseline = readImportedBaseline(input.baselineManuscript);
    const revision = readRuntimeTask(input.revision), request = input.revisionRequest, whole = revision?.result?.wholeRevision;
    const source = input.baselineManuscript, spec = input.revisionRequestSpec;
    if (input.baseline !== null || input.baselineRequest !== null || !source || !importedBaseline
      || !revision || revision.status !== 'completed' || revision.projectId !== expectedProjectId
      || revision.kind !== 'revise' || revision.revisionMode !== 'whole-manuscript-v2' || !request || !spec
      || source.sourceTaskId !== revision.id || source.sourceRequestId !== revision.requestId
      || request.projectId !== expectedProjectId || request.requestId !== revision.requestId
      || request.kind !== 'revise' || request.revisionMode !== 'whole-manuscript-v2'
      || request.projectTitle !== source.title || request.baseRevision !== source.baseRevision || revision.baseRevision !== source.baseRevision
      || !Array.isArray(source.chapters) || !source.chapters.length
      || !same(source.chapters, request.chapters) || !same(source.chapters, whole?.sourceChapters)
      || !same(request.writingGoals, spec.writingGoals)
      || whole?.schemaVersion !== 'whole-manuscript-quality-1' || !same(spec, whole?.requestSpec)
      || spec.sourceBaseRevision !== source.baseRevision || spec.sourceManuscriptSha256 !== source.sourceManuscriptSha256
      || !same(spec.sourceChapterIds, source.chapters.map(chapter => chapter.id))
      || !same(input.history.find(task => task.id === revision.id), input.revision))
      throw new Error('整稿任务的原始全文快照未绑定实际请求和候选，停止本次载入。');
    title = source.title; chapters = source.chapters; date = revision.updatedAt; versionId = `import-source-${revision.id}`;
  }
  const project = createProject('', 'auto');
  project.id = expectedProjectId; project.title = title; project.idea = (input.baselineRequest ?? input.revisionRequest)?.idea || '';
  project.chapters = structuredClone(chapters);
  if (input.baselineSha256 !== manuscriptRevision(project)) throw new Error('封存基线稿版本指纹无效。');
  if (importedBaseline && importedBaseline.baseRevision !== manuscriptRevision(project)) throw new Error('原始全文的标题或版本指纹不一致。');
  project.importedBaseline = importedBaseline;
  project.versions = [{ id: versionId, label: importedBaseline ? '原始全文' : '封存基线稿', date,
    title, chapters: structuredClone(chapters) }];
  project.messages = [{ role: 'assistant', text: importedBaseline
    ? '已打开整稿修订输入中的原始全文；原稿检查未完成。失败任务仍保留在历史中，候选需另行查看并明确选择。'
    : '本机已封存的完整故事、候选与独立评阅可在此查看。采纳需要你明确选择。', date: new Date().toISOString() }];
  project.docOpen = true; project.docClosedByUser = false; project.phase = 'done'; project.status = 'ready';
  project.updatedAt = date;
  project.runtimeHistory = input.history.map(readRuntimeTask).filter((task): task is RuntimeTask => Boolean(task));
  if (input.revision) {
    const revision = readRuntimeTask(input.revision);
    if (!revision || !input.revisionRequest || revision.projectId !== expectedProjectId
      || revision.status !== 'completed' || revision.kind !== 'revise' || revision.revisionMode !== 'whole-manuscript-v2'
      || input.revisionRequest.projectId !== expectedProjectId || input.revisionRequest.requestId !== revision.requestId
      || input.revisionRequest.baseRevision !== manuscriptRevision(project)
      || JSON.stringify(input.revisionRequest.chapters) !== JSON.stringify(project.chapters))
      throw new Error('候选任务与封存基线稿不一致，停止本次载入。');
    const binding = readRuntimeBinding({ request: input.revisionRequest,
      baseManuscript: { title: project.title, chapters: project.chapters }, task: revision,
      handledTaskId: revision.id, resultDisposition: revision.result?.wholeRevision?.status === 'no_change' ? 'declined' : 'whole-quality-groups' }, expectedProjectId);
    if (!binding) throw new Error('候选任务缺少可验证的产品绑定。');
    project.runtime = binding;
    project.runtimeHistory = project.runtimeHistory.filter(task => task.id !== revision.id);
    project.updatedAt = revision.updatedAt;
  }
  return project;
}

/** Handles an import completing after this same project was opened or edited locally. */
export function appendImportedProject(state: AppState, project: Project): void {
  if (!state.projects.some(item => item.id === project.id)) state.projects.unshift(project);
  state.activeProjectId = project.id; state.page = 'create';
}
