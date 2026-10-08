import { createHash } from 'node:crypto';

export function manuscriptFingerprint(chapters = []) {
  return createHash('sha256').update(JSON.stringify(chapters.map(({ id, title, body }) => ({ id, title, body })))).digest('hex');
}

/** Deterministic diagnostics only. No literary score or Full15 conformance is inferred. */
export function runChecks({ chapters = [], requirements = {} } = {}) {
  const issues = [];
  const seen = new Set();
  if (!chapters.length) issues.push({ code: 'EMPTY_MANUSCRIPT', severity: 'error', message: '没有章节正文。' });
  const measuredChapters = chapters.map((chapter, index) => {
    const body = typeof chapter.body === 'string' ? chapter.body : '';
    const hanCount = (body.match(/\p{Script=Han}/gu) ?? []).length;
    const nonWhitespaceCount = [...body.replace(/\s/gu, '')].length;
    if (!body.trim()) issues.push({ code: 'EMPTY_CHAPTER', severity: 'error', chapterId: chapter.id, message: `第 ${index + 1} 章为空。` });
    if (!chapter.id || seen.has(chapter.id)) issues.push({ code: 'CHAPTER_ID', severity: 'error', chapterId: chapter.id, message: '章节标识缺失或重复。' });
    seen.add(chapter.id);
    return { id: chapter.id, title: chapter.title, hanCount, nonWhitespaceCount };
  });
  const bodyHanCount = measuredChapters.reduce((sum, chapter) => sum + chapter.hanCount, 0);
  const bodyNonWhitespaceCount = measuredChapters.reduce((sum, chapter) => sum + chapter.nonWhitespaceCount, 0);
  const min = Number.isFinite(requirements.targetHanMin) ? requirements.targetHanMin : null;
  const max = Number.isFinite(requirements.targetHanMax) ? requirements.targetHanMax : null;
  if (min !== null && bodyHanCount < min) issues.push({ code: 'BELOW_REQUESTED_LENGTH', severity: 'warning', message: `正文 ${bodyHanCount} 汉字，低于本次目标下限 ${min}。` });
  if (max !== null && bodyHanCount > max) issues.push({ code: 'ABOVE_REQUESTED_LENGTH', severity: 'warning', message: `正文 ${bodyHanCount} 汉字，高于本次目标上限 ${max}。` });
  if (Number.isInteger(requirements.targetChapterCount) && chapters.length !== requirements.targetChapterCount) {
    issues.push({ code: 'CHAPTER_COUNT_DIFFERS', severity: 'warning', message: `实际 ${chapters.length} 章，本次规划目标为 ${requirements.targetChapterCount} 章。` });
  }
  return {
    schemaVersion: 1,
    status: issues.some((issue) => issue.severity === 'error') ? 'MECHANICAL_ISSUES' : issues.length ? 'MECHANICAL_WARNINGS' : 'MECHANICAL_CHECKS_OK',
    manuscriptSha256: manuscriptFingerprint(chapters),
    bodyHanCount, bodyNonWhitespaceCount, chapterCount: chapters.length,
    countScope: '仅章节正文；不含书名和章节标题；汉字为 Unicode Script=Han，另列非空白 Unicode 码点数。',
    requestedBounds: { min, max },
    chapters: measuredChapters, issues,
    literaryQuality: 'NOT_ASSESSED', methodGain: 'UNPROVEN', systemGo: false,
    full15: {
      mode: 'OFF', status: 'NOT_EVALUATED',
      reason: '本轮未调用完整 Full15 或既有 C01–C06 审稿程序；以下只是基础机械检查。',
      checked: [], unknowns: ['Full15 技术符合性', 'C02–C05 语义检查', '全文来源重合'],
    },
  };
}

/** Reserved sidecar input; creating it does not execute or activate Full15. */
export function createValidationRequest({ projectId, revision, chapters, checks = [] }) {
  return {
    schemaVersion: 'local-validation-input-1',
    projectId, revision, manuscriptSha256: manuscriptFingerprint(chapters),
    requestedChecks: [...checks],
    stage: 'manuscript', readOnly: true, mode: 'OFF',
    activationStatus: 'NOT_CONNECTED',
  };
}
