import { createHash } from 'node:crypto';
import { manuscriptFingerprint } from './checks.mjs';

export const EMOTION_PROGRESSION_VERSION = 'emotion-progression-evidence-1';
/** Optional checklist only: append to existing review, without changing its schema or authorizing edits. */
export const EMOTION_PROGRESSION_ADDENDUM = `情绪推进检查：沿完整正文比较前后场景的叙事作用，不按相同动作、意象、句式或情绪词计数判错。再次递钱、沉默、擦拭等可能加深羞耻、执念、关系压力或读者认识；心理活动、抒情、克制和留白也可推进。只有具体比较了前因、当前理解、行动约束、关系与后果，并排查反证，才能提出功能停滞的疑点；不强制每章反转或新增事件。
区分人物早已知道、读者首次得知、回忆和重新理解，不能把同一人物已确认的事实无解释地当首次发现，也不能把读者后知误诊为人物失忆。人物宣言不等于实际承担代价；但结局的承诺、克制或未决选择也不自动失败，须说明原文已建立的具体责任为何尚未得到有意义回应。
每个疑点引用足以定位的前后场景和反证，写清功能是否真的相同、有何其他读法、修订会损伤哪些有效表达。不能以作者采用声明、读者分数或字段齐全作为正文效果证据。不为追求改进删去有意义的反复，不把分析观察自动升格为must_fix。沿用现有review及独立adjudication门槛；无法排除合理解释时保留optional/uncertain，不自动改稿。`;
const sha = value => createHash('sha256').update(value).digest('hex');
const need = (ok, code) => { if (!ok) throw new Error(code); };
const text = (v, max = 4000) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
function exact(v, keys, optional = []) {
  need(v && typeof v === 'object' && !Array.isArray(v), 'OBJECT_REQUIRED');
  need(keys.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => keys.includes(k) || optional.includes(k)), 'INVALID_FIELDS');
}
function manuscript(chapters) {
  need(Array.isArray(chapters) && chapters.length > 0 && chapters.length <= 64, 'CHAPTER_COUNT');
  const ids = new Set(); let total = 0;
  for (const c of chapters) { need(text(c.id, 200) && typeof c.body === 'string' && c.body.length > 0 && !ids.has(c.id), 'CHAPTER_FIELDS'); ids.add(c.id); total += c.body.length; }
  need(total <= 160000, 'MANUSCRIPT_LIMIT');
}
/** Literal location check, never an assessment of whether the quote proves the interpretation. */
export function locateProgressionEvidence(chapters, citation) {
  exact(citation, ['chapterId','quote'], ['start']);
  const chapter = chapters.find(c => c.id === citation.chapterId);
  need(chapter && text(citation.quote, 1600), 'EVIDENCE_FIELDS');
  const start = citation.start ?? chapter.body.indexOf(citation.quote);
  need(Number.isSafeInteger(start) && start >= 0 && chapter.body.slice(start, start + citation.quote.length) === citation.quote, 'EVIDENCE_LITERAL');
  if (citation.start === undefined) need(chapter.body.indexOf(citation.quote, start + 1) === -1, 'EVIDENCE_AMBIGUOUS');
  return { ...citation, start, end: start + citation.quote.length, chapterSha256: sha(chapter.body) };
}
/** Development/reader sidecar. It cannot create issues or grant mutation rights. */
export function inspectProgressionObservation({ chapters, observation }) {
  manuscript(chapters);
  exact(observation, ['kind','assessment','earlier','later','counterEvidence','reason']);
  need(['functional_stall','meaningful_repetition','rediscovery','declared_cost','restraint','revision_damage'].includes(observation.kind), 'OBSERVATION_KIND');
  need(['concern','protected','uncertain'].includes(observation.assessment) && text(observation.reason), 'OBSERVATION_ASSESSMENT');
  const earlier = locateProgressionEvidence(chapters, observation.earlier), later = locateProgressionEvidence(chapters, observation.later);
  need(earlier.chapterId !== later.chapterId || earlier.start !== later.start, 'DISTINCT_SCENES_REQUIRED');
  need(Array.isArray(observation.counterEvidence) && observation.counterEvidence.length <= 12, 'COUNTER_EVIDENCE_LIMIT');
  const counterEvidence = observation.counterEvidence.map(c => locateProgressionEvidence(chapters, c));
  return { schemaVersion: EMOTION_PROGRESSION_VERSION, manuscriptSha256: manuscriptFingerprint(chapters),
    observation: { ...observation, earlier, later, counterEvidence }, semanticValidity: 'not_programmatically_verified',
    readingCoverage: 'not_proven', revisionEligible: false, modelReviewPassed: false };
}
/** Audit an explicitly supplied patch against bound spans. NOT issue/adjudication authorization. */
export function auditBoundedRevision({ before, after, bodySha256, replacements, preserve = [] }) {
  need(typeof before === 'string' && typeof after === 'string' && sha(before) === bodySha256, 'STALE_REVISION_BODY');
  need(Array.isArray(replacements) && replacements.length > 0 && replacements.length <= 12 && Array.isArray(preserve) && preserve.length <= 24, 'PATCH_LIMIT');
  const span = (s, replacement) => {
    exact(s, ['start','end','quote', ...(replacement ? ['replacement'] : [])]);
    need(Number.isSafeInteger(s.start) && Number.isSafeInteger(s.end) && s.start >= 0 && s.end > s.start && s.end <= before.length && before.slice(s.start,s.end) === s.quote, 'PATCH_LITERAL');
    if (replacement) need(typeof s.replacement === 'string', 'REPLACEMENT_TEXT');
    return { ...s };
  };
  const patches = replacements.map(s => span(s, true)).sort((a,b) => a.start-b.start), protectedSpans = preserve.map(s => span(s, false));
  need(patches.every((p,i) => i === 0 || patches[i-1].end <= p.start), 'PATCH_OVERLAP');
  need(!protectedSpans.some(p => patches.some(r => p.start < r.end && r.start < p.end)), 'PROTECTED_SPAN_CHANGED');
  let expected = before;
  for (const p of [...patches].reverse()) expected = expected.slice(0,p.start)+p.replacement+expected.slice(p.end);
  need(expected === after, 'OUTSIDE_SCOPE_CHANGED');
  return { beforeSha256: sha(before), afterSha256: sha(after), outsideScopeUnchanged: true,
    protectedSpansUnchanged: true, revisionAuthorized: false, literaryEffect: 'requires_independent_reading' };
}
