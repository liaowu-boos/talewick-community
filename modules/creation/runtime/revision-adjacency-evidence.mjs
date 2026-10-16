import { createHash } from 'node:crypto';

export const REVISION_ADJACENCY_EVIDENCE_VERSION = 'revision-adjacency-evidence-1';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ensure = (condition, code, message) => {
  if (!condition) throw Object.assign(new Error(message), { code });
};
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const sha256 = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
const manuscriptSha256 = chapters => createHash('sha256').update(JSON.stringify(chapters.map(({ id, title, body }) => ({ id, title, body })))).digest('hex');

function validateChapters(chapters, label) {
  ensure(Array.isArray(chapters) && chapters.length > 0, 'ADJACENCY_CHAPTERS', `${label}章节无效。`);
  const ids = new Set();
  return chapters.map(chapter => {
    ensure(object(chapter) && typeof chapter.id === 'string' && chapter.id
      && typeof chapter.title === 'string' && typeof chapter.body === 'string' && chapter.body
      && !ids.has(chapter.id), 'ADJACENCY_CHAPTERS', `${label}章节字段无效或重复。`);
    ids.add(chapter.id);
    return structuredClone(chapter);
  });
}

/**
 * Produce exact before/after windows for attribution review. This function only
 * proves text and offsets; it never declares pronouns, speakers, or POV safe.
 */
export function buildRevisionAdjacencyEvidence({ sourceChapters, candidateChapters, replacements, contextUtf16 = 160 } = {}) {
  const source = validateChapters(sourceChapters, '原稿'), candidate = validateChapters(candidateChapters, '候选稿');
  ensure(source.length === candidate.length && source.every((chapter, index) => chapter.id === candidate[index].id),
    'ADJACENCY_TOPOLOGY', '原稿与候选稿章节拓扑不一致。');
  ensure(Number.isSafeInteger(contextUtf16) && contextUtf16 >= 40 && contextUtf16 <= 1000,
    'ADJACENCY_CONTEXT', '邻接窗口须为40–1000个UTF-16单位。');
  ensure(Array.isArray(replacements), 'ADJACENCY_REPLACEMENTS', '替换列表无效。');

  const chapterById = new Map(source.map((chapter, index) => [chapter.id, { source: chapter, candidate: candidate[index] }]));
  const ordered = replacements.map(item => {
    ensure(object(item) && typeof item.targetId === 'string' && item.targetId
      && typeof item.chapterId === 'string' && typeof item.sourceQuote === 'string'
      && typeof item.replacement === 'string' && Number.isSafeInteger(item.sourceStart) && item.sourceStart >= 0,
    'ADJACENCY_REPLACEMENT', '替换记录字段无效。');
    const pair = chapterById.get(item.chapterId);
    ensure(pair && pair.source.body.slice(item.sourceStart, item.sourceStart + item.sourceQuote.length) === item.sourceQuote,
      'ADJACENCY_SOURCE_BINDING', '替换记录没有绑定原稿指定位置。');
    return structuredClone(item);
  }).sort((a, b) => a.chapterId.localeCompare(b.chapterId) || a.sourceStart - b.sourceStart);

  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1], current = ordered[index];
    ensure(previous.chapterId !== current.chapterId || previous.sourceStart + previous.sourceQuote.length <= current.sourceStart,
      'ADJACENCY_OVERLAP', '替换范围重叠。');
  }

  const deltas = new Map();
  const windows = ordered.map(item => {
    const pair = chapterById.get(item.chapterId), delta = deltas.get(item.chapterId) ?? 0;
    const candidateStart = item.sourceStart + delta;
    ensure(pair.candidate.body.slice(candidateStart, candidateStart + item.replacement.length) === item.replacement,
      'ADJACENCY_CANDIDATE_BINDING', '候选稿没有在派生位置包含替换文本。');
    const sourceLeftStart = Math.max(0, item.sourceStart - contextUtf16);
    const sourceRightEnd = Math.min(pair.source.body.length, item.sourceStart + item.sourceQuote.length + contextUtf16);
    const candidateLeftStart = Math.max(0, candidateStart - contextUtf16);
    const candidateRightEnd = Math.min(pair.candidate.body.length, candidateStart + item.replacement.length + contextUtf16);
    const sourceLeft = pair.source.body.slice(sourceLeftStart, item.sourceStart);
    const sourceRight = pair.source.body.slice(item.sourceStart + item.sourceQuote.length, sourceRightEnd);
    const candidateLeft = pair.candidate.body.slice(candidateLeftStart, candidateStart);
    const candidateRight = pair.candidate.body.slice(candidateStart + item.replacement.length, candidateRightEnd);
    deltas.set(item.chapterId, delta + item.replacement.length - item.sourceQuote.length);
    return {
      targetId: item.targetId,
      chapterId: item.chapterId,
      sourceStartUtf16: item.sourceStart,
      candidateStartUtf16: candidateStart,
      source: { left: sourceLeft, target: item.sourceQuote, right: sourceRight },
      candidate: { left: candidateLeft, target: item.replacement, right: candidateRight },
      boundaryChecks: {
        leftPreserved: sourceLeft.endsWith(candidateLeft) || candidateLeft.endsWith(sourceLeft),
        rightPreserved: sourceRight.startsWith(candidateRight) || candidateRight.startsWith(sourceRight),
      },
      semanticStatus: 'requires_independent_attribution_review',
      requiredChecks: ['pronoun_referent', 'dialogue_speaker', 'point_of_view_owner'],
    };
  });

  const body = {
    schemaVersion: REVISION_ADJACENCY_EVIDENCE_VERSION,
    sourceManuscriptSha256: manuscriptSha256(source),
    candidateManuscriptSha256: manuscriptSha256(candidate),
    contextUtf16,
    windows,
    boundary: '逐字邻接窗口只证明送审上下文与位置；不证明代词指向、说话人或视角归属正确。',
  };
  return { ...body, evidenceSha256: sha256(body) };
}
