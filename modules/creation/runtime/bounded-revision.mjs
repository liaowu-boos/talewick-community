import { createHash } from 'node:crypto';
const sha = body => createHash('sha256').update(body).digest('hex');
const fail = message => { throw Object.assign(new Error(`局部修订范围无效：${message}。原稿未替换。`), { code: 'BOUNDED_REVISION_SCOPE_REJECTED', revisionDispatched: false, retryableWithCorrectedScope: true }); };
const responseFail = message => { throw Object.assign(new Error(`局部修订响应无效：${message}。原稿未替换。`), { code: 'BOUNDED_REVISION_RESPONSE_REJECTED', revisionDispatched: true }); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const overlap = (a, b) => a.start < b.end && b.start < a.end;
const span = (value, body) => {
  if (!exact(value, ['start', 'end', 'quote']) || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.end)
    || value.start < 0 || value.end <= value.start || value.end > body.length
    || typeof value.quote !== 'string' || body.slice(value.start, value.end) !== value.quote) fail('范围与当前章逐字原文不符');
  return { ...value };
};

/** Paragraph context may not grant a whole chapter; a single paragraph falls back to the exact issue quote. */
function evidenceRanges(chapter, issues) {
  const body = chapter.body;
  const separators = [...body.matchAll(/\r?\n(?:[\t ]*\r?\n)*/g)].map(m => ({start:m.index,end:m.index+m[0].length}));
  const ranges = issues.map(issue => {
    const start = typeof issue?.quote === 'string' ? body.indexOf(issue.quote) : -1;
    if (!issue?.quote || start < 0 || start !== body.lastIndexOf(issue.quote)) fail('问题引文不能唯一定位，须扩大证据后重新裁定');
    const end = start+issue.quote.length;
    const left = separators.filter(s => s.end <= start).at(-1)?.end ?? 0;
    const right = separators.find(s => s.start >= end)?.start ?? body.length;
    return (body.slice(0,left)+body.slice(right)).trim() ? {start:left,end:right} : {start,end};
  }).sort((a,b) => a.start-b.start);
  const merged = [];
  for (const r of ranges) {
    const previous = merged.at(-1);
    if (previous && r.start < previous.end) previous.end = Math.max(previous.end,r.end);
    else merged.push({...r});
  }
  return merged;
}

/** Editing bounds only. The workflow must first authorize issues via independent adjudication. */
export function bindRevisionScope(chapter, issues, scope) {
  if (typeof chapter?.body !== 'string' || !exact(scope, Object.hasOwn(scope ?? {}, 'preserve')
    ? ['bodySha256', 'ranges', 'preserve'] : ['bodySha256', 'ranges']) || scope.bodySha256 !== sha(chapter.body)) fail('正文版本未绑定或已改变');
  if (!Array.isArray(scope.ranges) || !scope.ranges.length || scope.ranges.length > 12) fail('须指定 1–12 个可改片段');
  if (scope.preserve !== undefined && (!Array.isArray(scope.preserve) || scope.preserve.length > 24)) fail('保护片段须为至多 24 项的数组');
  const ranges = scope.ranges.map(x => span(x, chapter.body)).sort((a,b) => a.start-b.start);
  const preserve = (scope.preserve ?? []).map(x => span(x, chapter.body));
  if (ranges.some((r, i) => i > 0 && overlap(r, ranges[i-1]))) fail('可改片段重叠');
  if (preserve.some(p => ranges.some(r => overlap(p,r)))) fail('可改片段侵入保护范围');
  if (!Array.isArray(issues) || !issues.length || issues.some(issue => issue?.chapterId !== chapter.id
    || typeof issue.quote !== 'string' || !issue.quote || !ranges.some(r => r.quote.includes(issue.quote)))) fail('获准问题未由范围内原文覆盖');
  if (issues.some(issue => chapter.body.indexOf(issue.quote) !== chapter.body.lastIndexOf(issue.quote))) fail('问题引文在当前章有多处匹配，须扩大证据后重新裁定');
  if (ranges.some(r => !issues.some(issue => r.quote.includes(issue.quote)))) fail('范围中缺少获准问题的原文证据');
  const allowed = evidenceRanges(chapter, issues);
  if (ranges.some(r => !allowed.some(a => r.start >= a.start && r.end <= a.end))) fail('显式范围超出服务端证据所在段落，不能扩张至无证据的其他段落');
  let cursor = 0, outside = '';
  for (const r of ranges) { outside += chapter.body.slice(cursor,r.start); cursor = r.end; }
  outside += chapter.body.slice(cursor);
  if (!/[\p{L}\p{N}]/u.test(outside)) fail('不能用局部路径覆盖全部实质正文，只留分隔空白或标点');
  return { bodySha256: scope.bodySha256, ranges, preserve };
}

/** Apply exact allowed spans, leaving all text outside them byte-for-byte unchanged. */
export function applyBoundedRevision(chapter, issues, scope, response) {
  const bound = bindRevisionScope(chapter, issues, scope);
  if (!exact(response, ['replacements']) || !Array.isArray(response.replacements)
    || !response.replacements.length || response.replacements.length > bound.ranges.length) responseFail('响应须只含有界 replacements');
  const seen = new Set();
  const replacements = response.replacements.map(item => {
    if (!exact(item, ['start','end','quote','replacement']) || typeof item.replacement !== 'string') responseFail('替换字段无效');
    const index = bound.ranges.findIndex(r => r.start === item.start && r.end === item.end && r.quote === item.quote);
    if (index < 0 || seen.has(index)) responseFail('替换超出允许范围或重复');
    seen.add(index);
    return item;
  }).sort((a,b) => b.start-a.start);
  let body = chapter.body;
  for (const item of replacements) body = body.slice(0,item.start)+item.replacement+body.slice(item.end);
  if (!body.trim()) responseFail('不能清空正文');
  return { ...chapter, body };
}

export const BOUNDED_REVISION_POLICY = 'bounded-paragraph-revision-1';

/** Server-derived paragraph bounds, after issue authorization; observations only narrow protection. */
export function automaticRevisionScope(chapter, issues, readingObservations = []) {
  if (typeof chapter?.body !== 'string' || !Array.isArray(issues) || !issues.length || !Array.isArray(readingObservations)) fail('自动范围缺少正文、问题或有效观察数组');
  const body = chapter.body;
  const merged = evidenceRanges(chapter, issues);
  const preserve = [];
  for (const observation of readingObservations) {
    if (!observation?.evidenceVerified || !observation.revisionScope?.scopeVerified
      || !observation.revisionScope.chapterIds.includes(chapter.id)) continue;
    for (const quote of observation.revisionScope.preserve ?? []) {
      if (typeof quote !== 'string' || !quote) continue;
      for (let start=body.indexOf(quote);start>=0;start=body.indexOf(quote,start+1)) {
        if (!preserve.some(p => p.start===start && p.quote===quote)) preserve.push({start,end:start+quote.length,quote});
      }
    }
  }
  return bindRevisionScope(chapter,issues,{bodySha256:sha(body),ranges:merged.map(r=>({...r,quote:body.slice(r.start,r.end)})),preserve});
}
