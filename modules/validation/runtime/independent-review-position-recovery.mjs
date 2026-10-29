import { createHash } from 'node:crypto';

export const POSITION_RECOVERY_VERSION = 'independent-review-position-recovery-1';
const sha = text => createHash('sha256').update(text).digest('hex');
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const whitespace = character => /[ \t\r\n]/u.test(character);
const manuscripts = packet => packet.manuscripts ?? [packet.baseline, packet.candidate].filter(Boolean);
const pointerPart = key => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

function citations(packet, response) {
  const items = [];
  const visit = (value, pointer = '') => {
    if (Array.isArray(value)) return value.forEach((item, index) => visit(item, `${pointer}/${index}`));
    if (!object(value)) return;
    if (['blindId', 'chapterId', 'quote'].every(key => Object.hasOwn(value, key))) {
      const manuscript = manuscripts(packet).find(item => item.blindId === value.blindId);
      const chapter = manuscript?.chapters.find(item => item.id === value.chapterId);
      if (!chapter || typeof value.quote !== 'string' || !value.quote.trim()) fail('POSITION_RECOVERY_LOCATION', pointer);
      items.push({ value, pointer, chapter });
    }
    Object.entries(value).forEach(([key, child]) => visit(child, `${pointer}/${pointerPart(key)}`));
  };
  visit(response);
  return items;
}

function matches(body, quote) {
  const found = [];
  for (let start = body.indexOf(quote); start >= 0; start = body.indexOf(quote, start + 1)) found.push(start);
  return found;
}

function indexedText(text) {
  let compact = ''; const offsets = [];
  // Index UTF-16 code units, including both units of a surrogate pair.
  for (let index = 0; index < text.length; index += 1) {
    if (!whitespace(text[index])) { compact += text[index]; offsets.push(index); }
  }
  return { compact, offsets };
}

/** Only ASCII whitespace may differ. Ambiguity and explicit positions are never guessed. */
export function recoverWhitespaceCitations(packet, response) {
  const restored = structuredClone(response), restorations = [];
  for (const { value, pointer, chapter } of citations(packet, restored)) {
    if (value.start !== null && value.start !== undefined) continue;
    if (matches(chapter.body, value.quote).length !== 0) continue;
    const query = indexedText(value.quote).compact, indexed = indexedText(chapter.body);
    if (!query) continue;
    const locations = matches(indexed.compact, query);
    if (locations.length !== 1) continue;
    const start = indexed.offsets[locations[0]], end = indexed.offsets[locations[0] + query.length - 1] + 1;
    const quote = chapter.body.slice(start, end);
    // No punctuation, letters, digits, zero-width characters or other Unicode normalization.
    if (indexedText(quote).compact !== query) fail('POSITION_RECOVERY_MAPPING');
    restorations.push({ JSONPointer: pointer, blindId: value.blindId, chapterId: value.chapterId,
      suppliedQuote: value.quote, suppliedStart: value.start ?? null, quote, start, end,
      normalizedMatchCount: 1, chapterBodySha256: sha(chapter.body) });
    value.quote = quote; value.start = start;
  }
  return { response: restored, restorations, policy: 'ascii-space-tab-cr-lf-only-1' };
}

export function findPositionProblems(packet, response) {
  return citations(packet, response).flatMap(({ value, pointer, chapter }) => {
    const offsets = matches(chapter.body, value.quote);
    const valid = value.start === null || value.start === undefined
      ? offsets.length === 1
      : Number.isSafeInteger(value.start) && value.start >= 0 && chapter.body.slice(value.start, value.start + value.quote.length) === value.quote;
    return valid ? [] : [{ JSONPointer: pointer, blindId: value.blindId, chapterId: value.chapterId,
      quote: value.quote, start: value.start ?? null, exactStartOffsets: offsets,
      exactCandidates: offsets.map(start => ({ start, end: start + value.quote.length,
        before: chapter.body.slice(Math.max(0, start - 48), start), quote: value.quote,
        after: chapter.body.slice(start + value.quote.length, start + value.quote.length + 48) })) }];
  });
}

/** A correction list has no writable judgment, identity, membership or preference fields. */
export function applyPositionRepairs(packet, response, correction, problems) {
  if (!object(correction) || Object.keys(correction).length !== 1 || !Array.isArray(correction.repairs)) fail('POSITION_REPAIR_FIELDS');
  if (correction.repairs.length !== problems.length || !problems.length) fail('POSITION_REPAIR_COVERAGE');
  const result = structuredClone(response), allowed = new Set(problems.map(item => item.JSONPointer));
  const entries = new Map(citations(packet, result).map(item => [item.pointer, item]));
  for (const repair of correction.repairs) {
    if (!object(repair) || Object.keys(repair).length !== 3 || !['JSONPointer', 'quote', 'start'].every(key => Object.hasOwn(repair, key))) fail('POSITION_REPAIR_FIELDS');
    if (!allowed.delete(repair.JSONPointer)) fail('POSITION_REPAIR_POINTER');
    const { value, chapter } = entries.get(repair.JSONPointer);
    if (typeof repair.quote !== 'string' || !repair.quote.trim() || !Number.isSafeInteger(repair.start) || repair.start < 0 || chapter.body.slice(repair.start, repair.start + repair.quote.length) !== repair.quote) fail('POSITION_REPAIR_EXACT_QUOTE');
    // Retain the cited text: only adjacent context may be added, never substitute evidence.
    const original = indexedText(value.quote).compact, replacement = indexedText(repair.quote).compact;
    if (!replacement.includes(original)) fail('POSITION_REPAIR_EVIDENCE_SUBSTITUTION');
    value.quote = repair.quote; value.start = repair.start;
  }
  if (allowed.size) fail('POSITION_REPAIR_COVERAGE');
  return result;
}
