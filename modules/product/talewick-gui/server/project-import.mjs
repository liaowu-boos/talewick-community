import { isDeepStrictEqual } from 'node:util';
import { productManuscriptRevision } from './full15-service.mjs';
import { assertWholeQualityResult, createWholeQualityRequestSpec } from '../../../creation/runtime/whole-manuscript-quality.mjs';

const fail = (message, status = 409) => Object.assign(new Error(message), { status, code: 'PROJECT_IMPORT_SOURCE_INVALID' });
const wholeTask = task => task.kind === 'revise' && task.revisionMode === 'whole-manuscript-v2' && task.status === 'completed';

/** Recover only the immutable source of a real, validated completed revision.
 * This is a manuscript snapshot, never a substitute completed creation task.
 */
function wholeRevisionSource(tasks, projectId, task) {
  const request = tasks.requests.get(task.id), requestSpec = tasks.artifacts.get(task.id)?.requestSpec;
  if (!wholeTask(task) || task.projectId !== projectId || request?.projectId !== projectId
    || request?.requestId !== task.requestId || request?.kind !== 'revise' || request?.revisionMode !== task.revisionMode
    || typeof request.projectTitle !== 'string' || !request.projectTitle.trim()
    || !Array.isArray(request.chapters) || !request.chapters.length
    || task.baseRevision !== request.baseRevision || !requestSpec
    || productManuscriptRevision(request.projectTitle, request.chapters) !== request.baseRevision
    || !isDeepStrictEqual(request.chapters, task.result?.wholeRevision?.sourceChapters))
    throw fail('整稿任务的原始全文与保存的请求不一致，未恢复作品。');
  try {
    // The workflow adds these execution bindings before checkpointing requestSpec.
    const rebuilt = createWholeQualityRequestSpec({ ...request,
      ...(requestSpec.crossChapterReview ? { crossChapterReview: requestSpec.crossChapterReview } : {}) },
    { deepReferenceEnabled: requestSpec.deepReferencePolicyVersion !== undefined });
    if (!isDeepStrictEqual(rebuilt, requestSpec) || task.result.title !== request.projectTitle) throw new Error('request binding');
    assertWholeQualityResult(task.result, requestSpec);
  } catch { throw fail('整稿任务的原始全文、请求规格或候选结果未通过绑定校验。'); }
  return { request, requestSpec, manuscript: {
    provenance: 'whole_revision_source', sourceTaskId: task.id, sourceRequestId: task.requestId,
    title: request.projectTitle, chapters: structuredClone(request.chapters), baseRevision: request.baseRevision,
    sourceManuscriptSha256: requestSpec.sourceManuscriptSha256, qualityCheckStatus: 'incomplete',
  } };
}

export function projectImportSnapshot(tasks, projectId) {
  const history = tasks.list(projectId);
  const baseline = [...history].reverse().find(item => item.kind === 'create' && item.status === 'completed' && item.result?.chapters?.length);
  if (baseline) {
    // Preserve the original completed-create response contract and selection order.
    const baselineTitle = baseline.result.title, baselineChapters = baseline.result.chapters;
    const revision = history.find(item => wholeTask(item) && item.result?.chapters?.length
      && tasks.requests.get(item.id)?.baseRevision === productManuscriptRevision(baselineTitle, baselineChapters)
      && isDeepStrictEqual(tasks.requests.get(item.id)?.chapters, baselineChapters));
    return { schemaVersion: 'talewick-project-import-snapshot-1', projectId, baseline,
      baselineRequest: tasks.requests.get(baseline.id), revision: revision ?? null,
      revisionRequest: revision ? tasks.requests.get(revision.id) ?? null : null, history,
      baselineSha256: productManuscriptRevision(baselineTitle, baselineChapters) };
  }
  let invalidSource;
  for (const revision of history.filter(wholeTask)) {
    try {
      const source = wholeRevisionSource(tasks, projectId, revision);
      return { schemaVersion: 'talewick-project-import-snapshot-2', projectId, baseline: null, baselineRequest: null,
        baselineManuscript: source.manuscript, revision, revisionRequest: source.request,
        revisionRequestSpec: source.requestSpec, history, baselineSha256: source.manuscript.baseRevision };
    } catch (error) { invalidSource = error; }
  }
  if (invalidSource) throw invalidSource;
  throw fail('这个项目还没有可恢复的完整作品或已完成整稿任务的原始全文。', 404);
}

export function listImportableProjects(tasks) {
  const projects = [];
  for (const projectId of new Set(tasks.list().map(task => task.projectId))) {
    try {
      const snapshot = projectImportSnapshot(tasks, projectId);
      projects.push({ id: projectId, title: snapshot.baseline?.result.title ?? snapshot.baselineManuscript.title,
        updatedAt: snapshot.history[0].updatedAt,
        ...(snapshot.baseline ? { baselineTaskId: snapshot.baseline.id } : {
          baselineProvenance: 'whole_revision_source', sourceTaskId: snapshot.revision.id, baselineQualityCheckStatus: 'incomplete',
        }) });
    } catch { /* Incomplete or invalid tasks remain in history, but cannot supply an import. */ }
  }
  return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
