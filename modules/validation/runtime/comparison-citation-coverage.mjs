import { createHash } from 'node:crypto';

const hash = text => createHash('sha256').update(text).digest('hex');
const sides = ['baseline', 'candidate'];
const channels = ['evidence', 'counterEvidence', 'severeHarm.evidence'];
const ensure = (ok, message) => { if (!ok) throw new TypeError(message); };

// Keep offsets in the exact body string. Blank-line separators belong to neither paragraph.
function paragraphs(body) {
  const result = [];
  let start = 0;
  const add = end => { if (end > start) result.push({ start, end, text: body.slice(start, end) }); };
  for (const gap of body.matchAll(/(?:\r\n|\r(?!\n)|(?<!\r)\n)(?:[\t ]*(?:\r\n|\r(?!\n)|(?<!\r)\n))+/g)) {
    add(gap.index); start = gap.index + gap[0].length;
  }
  add(body.length); return result;
}

// Classify against ALL longest order-preserving exact paragraph matches, never a tie-broken diff.
function align(left, right) {
  const a = left.map(p => p.text), b = right.map(p => p.text);
  if (a.length === b.length && a.every((v, i) => v === b[i])) return [a.map(() => 'shared'), b.map(() => 'shared')];
  const width = b.length + 1, size = (a.length + 1) * width;
  const aTexts = new Set(a), bTexts = new Set(b);
  if (!a.length || !b.length || size > 1_000_000) {
    return [a.map(t => bTexts.has(t) ? 'unresolved' : 'changed'), b.map(t => aTexts.has(t) ? 'unresolved' : 'changed')];
  }
  const pre = new Uint32Array(size), post = new Uint32Array(size);
  const at = (i, j) => i * width + j;
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    pre[at(i+1,j+1)] = a[i] === b[j] ? pre[at(i,j)] + 1 : Math.max(pre[at(i,j+1)], pre[at(i+1,j)]);
  }
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    post[at(i,j)] = a[i] === b[j] ? post[at(i+1,j+1)] + 1 : Math.max(post[at(i+1,j)], post[at(i,j+1)]);
  }
  const best = post[0];
  function classify(values, others, otherSet, index) {
    return values.map((value, i) => {
      if (!otherSet.has(value)) return 'changed';
      let partners = 0;
      for (let j = 0; j <= others.length; j++) {
        // Some optimal alignment can skip this occurrence, including moves and duplicate insertions.
        if (pre[index(i,j)] + post[index(i+1,j)] === best) return 'unresolved';
        if (j < others.length && value === others[j] && pre[index(i,j)] + 1 + post[index(i+1,j+1)] === best) partners++;
      }
      return partners === 1 ? 'shared' : 'unresolved';
    });
  }
  return [classify(a,b,bTexts,at), classify(b,a,aTexts,(j,i) => at(i,j))];
}

// Shared anchors are mandatory in every optimal match, so their order is the same on both sides.
// Only call a gap an insertion/deletion when the opposite gap is empty.
function bodyKinds(status, sideIndex) {
  const own = status[sideIndex], other = status[1 - sideIndex];
  const anchors = states => states.flatMap((state,i) => state === 'shared' ? [i] : []).concat(states.length);
  const otherAnchors = anchors(other), result = [...own];
  let prior = -1, priorOther = -1;
  for (const [k,next] of anchors(own).entries()) {
    const nextOther = otherAnchors[k];
    for (let i = prior + 1; i < next; i++) if (own[i] === 'changed') {
      result[i] = nextOther === priorOther + 1 ? (sideIndex === 0 ? 'paragraph_deleted' : 'paragraph_inserted') : 'replacement_region';
    }
    prior = next; priorOther = nextOther;
  }
  return result;
}

function chapterMap(chapters) {
  ensure(Array.isArray(chapters), 'chapters must be an array');
  const map = new Map();
  for (const chapter of chapters) {
    ensure(typeof chapter?.id === 'string' && chapter.id && !map.has(chapter.id), 'expected unique nonempty chapter IDs');
    ensure(typeof chapter.title === 'string' && typeof chapter.body === 'string', 'title and body must be strings');
    map.set(chapter.id, chapter);
  }
  return map;
}
function buildCatalog(maps) {
  const bySide = { baseline: new Map(), candidate: new Map() }, units = [], separatorOnlyChapterIds = [];
  for (const chapterId of new Set([...maps.baseline.keys(), ...maps.candidate.keys()])) {
    const chapters = sides.map(side => maps[side].get(chapterId));
    const ps = chapters.map(c => c ? paragraphs(c.body) : []), status = align(...ps);
    if (chapters.every(Boolean) && chapters[0].body !== chapters[1].body && ps[0].length === ps[1].length && ps[0].every((p,i) => p.text === ps[1][i].text)) separatorOnlyChapterIds.push(chapterId);
    for (const [i,side] of sides.entries()) {
      const c = chapters[i]; if (!c) continue;
      function unit(field, ordinal, start, end, state, kind) {
        const u = { unitId: units.length, side, chapterId, field, ordinal, start, end, state, kind }; units.push(u); return u;
      }
      const titleState = c.title === chapters[1-i]?.title ? 'shared' : 'changed';
      const chapterKind = !chapters[1-i] ? (i === 0 ? 'chapter_deleted' : 'chapter_inserted') : null;
      const title = unit('title', 1, 0, c.title.length, titleState, chapterKind ?? (titleState === 'changed' ? 'title_changed' : 'shared'));
      const kinds = bodyKinds(status,i);
      const bodyUnits = ps[i].map((p,k) => unit('body', k+1, p.start, p.end, status[i][k], chapterKind ?? kinds[k]));
      bySide[side].set(chapterId, { title, bodyUnits });
    }
  }
  return { bySide, units, separatorOnlyChapterIds };
}
const pending = (location, reason) => ({ location, reason, start: null, end: null, unitIds: [], coverage: 'unresolved' });
function locate(ref, roles, maps, catalog) {
  if (!ref || typeof ref.blindId !== 'string' || !Object.hasOwn(roles, ref.blindId)) return pending('invalid','unknown_blind_id');
  const side = roles[ref.blindId], chapter = maps[side].get(ref.chapterId);
  if (!chapter) return pending('invalid','unknown_chapter');
  const field = Object.hasOwn(ref,'field') ? ref.field : 'body';
  if (!['title','body'].includes(field) || typeof ref.quote !== 'string' || !ref.quote.trim()) return pending('invalid','invalid_field_or_quote');
  const text = chapter[field]; let start = ref.start;
  if (start == null) {
    start = text.indexOf(ref.quote);
    if (start < 0) return pending('inaccurate','quote_absent');
    if (text.indexOf(ref.quote, start + 1) >= 0) return pending('ambiguous','multiple_quote_locations');
  } else if (!Number.isSafeInteger(start) || start < 0 || !text.startsWith(ref.quote, start)) return pending('inaccurate','offset_mismatch');
  const end = start + ref.quote.length, group = catalog.bySide[side].get(chapter.id);
  const hits = field === 'title' ? [group.title] : group.bodyUnits.filter(u => u.start < end && start < u.end && text.slice(Math.max(start,u.start),Math.min(end,u.end)).trim());
  const coverage = hits.some(u => u.state === 'changed') ? 'changed' : hits.length && hits.every(u => u.state === 'shared') ? 'shared_only' : 'unresolved';
  return { location: 'exact', method: ref.start == null ? 'unique_substring' : 'supplied_offset', side, field, start, end,
    sameQuoteInCounterpartField: maps[side === 'baseline' ? 'candidate' : 'baseline'].get(chapter.id)?.[field].includes(ref.quote) ?? false,
    unitIds: hits.map(u => u.unitId), coverage, ...(hits.some(u => u.state === 'unresolved') ? { reason: 'paragraph_alignment_unresolved' } : {}) };
}
function summarize(rows, units) {
  const exact = rows.filter(r => r.location === 'exact'), ids = new Set(exact.flatMap(r => r.unitIds));
  const changed = [...ids].filter(id => units[id].state === 'changed');
  function covers(field) {
    if (changed.some(id => units[id].field === field)) return true;
    if (!rows.length) return null;
    const pendingField = rows.some(row => {
      const scope = row.ref && Object.hasOwn(row.ref, 'field') ? row.ref.field : 'body';
      if (['title', 'body'].includes(scope) && scope !== field) return false;
      return row.location !== 'exact' || row.unitIds.some(id => units[id].state === 'unresolved');
    });
    return pendingField ? null : false;
  }
  return { references: rows.length, exact: exact.length, sharedOnly: rows.filter(r => r.coverage === 'shared_only').length,
    sharedParagraphOnly: exact.filter(r => r.field === 'body' && r.coverage === 'shared_only').length,
    changedParagraph: exact.filter(r => r.field === 'body' && r.coverage === 'changed').length,
    changedTitle: exact.filter(r => r.field === 'title' && r.coverage === 'changed').length,
    changed: rows.filter(r => r.coverage === 'changed').length, unresolved: rows.filter(r => r.coverage === 'unresolved').length,
    changedUnitIds: changed, coversChangedParagraph: covers('body'), coversChangedTitle: covers('title') };
}

/** Post-disclosure only. Bind blind IDs from the sealed review. All intervals are UTF-16 [start,end). */
export function inspectComparisonCitationCoverage({ baselineChapters, candidateChapters, rolesByBlindId, comparisons }) {
  ensure(rolesByBlindId && Object.keys(rolesByBlindId).length === 2 && sides.every(s => Object.values(rolesByBlindId).includes(s)), 'expected a bijection of two blind IDs to baseline and candidate');
  ensure(Array.isArray(comparisons), 'comparisons must be an array');
  const maps = { baseline: chapterMap(baselineChapters), candidate: chapterMap(candidateChapters) }, catalog = buildCatalog(maps);
  const rows = [], findings = [];
  for (const [i,c] of comparisons.entries()) {
    ensure(c && Array.isArray(c.evidence), 'comparison.evidence must be an array');
    ensure(c.severeHarm === undefined || typeof c.severeHarm === 'boolean' || Array.isArray(c.severeHarm?.evidence), 'invalid severeHarm evidence list');
    const byChannel = {};
    for (const channel of channels) {
      const refs = channel === 'severeHarm.evidence' ? c.severeHarm?.evidence : c[channel];
      ensure(refs === undefined || Array.isArray(refs), `${channel} must be an array`);
      const citations = (refs ?? []).map((ref,k) => ({ pointer: `/comparisons/${i}/${channel.replace('.', '/')}/${k}`, channel, ref: structuredClone(ref), ...locate(ref,rolesByBlindId,maps,catalog) }));
      rows.push(...citations); byChannel[channel] = summarize(citations, catalog.units);
    }
    findings.push({ comparisonIndex: i, comparisonId: c.id ?? null, byChannel });
  }
  const binding = { rolesByBlindId: { ...rolesByBlindId }, comparisonsSHA256: hash(JSON.stringify(comparisons)) };
  for (const side of sides) {
    const chapters = Array.from(maps[side].values(), ({ id, title, body }) => ({ id, title, body }));
    binding[`${side}SHA256`] = hash(JSON.stringify(chapters));
  }
  return { schemaVersion: 'comparison-citation-coverage-1', binding,
    units: catalog.units, separatorOnlyChapterIds: catalog.separatorOnlyChapterIds, citations: rows, comparisons: findings,
    byChannel: Object.fromEntries(channels.map(ch => [ch,summarize(rows.filter(r => r.channel === ch),catalog.units)])),
    semanticSupport: 'NOT_COMPUTED', literaryEffect: 'NOT_COMPUTED', automaticAdoption: false };
}
