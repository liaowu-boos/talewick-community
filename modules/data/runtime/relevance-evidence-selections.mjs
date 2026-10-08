import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const EVIDENCE_VIEW_VERSION = 'source-evidence-1';
export const COMPACT_EVIDENCE_VIEW_VERSION = 'source-evidence-compact-1';
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
function requireValue(ok, code) {
  if (!ok) throw Object.assign(new TypeError(code), { code });
}

// Locate original blocks from the content's tail, not from header-like prose.
// This does not authenticate a candidate against a library or approve semantics.
function originalSpans(candidate) {
  requireValue(object(candidate) && typeof candidate.content === 'string'
    && hash(candidate.content) === candidate.contentSha256
    && ['raw_reference', 'reviewed_analysis'].includes(candidate.use)
    && Array.isArray(candidate.references) && candidate.references.length > 0,
  'EVIDENCE_CANDIDATE_INVALID');
  const lines = candidate.content.split('\n'), offsets = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const spans = [];
  let end = lines.length;
  for (let i = candidate.references.length - 1; i >= 0; i--) {
    const ref = candidate.references[i];
    requireValue(object(ref) && Number.isSafeInteger(ref.lineStart) && Number.isSafeInteger(ref.lineEnd)
      && ref.lineStart >= 1 && ref.lineEnd >= ref.lineStart, 'EVIDENCE_RANGE_INVALID');
    const start = end - (ref.lineEnd - ref.lineStart + 1);
    const header = candidate.use === 'raw_reference'
      ? '【原文参考；不作为已发布分析】' : `原文（${ref.lineStart}–${ref.lineEnd}）：`;
    requireValue(start >= 1 && lines[start - 1] === header, 'EVIDENCE_ORIGINAL_BLOCK_INVALID');
    spans.unshift({ start: offsets[start], end: end === lines.length ? candidate.content.length : offsets[end] - 1, block: i });
    end = start - 1;
    if (i > 0) requireValue(lines[--end] === '', 'EVIDENCE_SEPARATOR_INVALID');
  }
  if (candidate.use === 'raw_reference') {
    requireValue(candidate.references.length === 1 && end === 0, 'EVIDENCE_RAW_BLOCK_INVALID');
  }
  return spans;
}

export { originalSpans as sourceOriginalSpans };

function splitLine(line) {
  const chunks = [];
  let rest = line;
  while (rest.length > 160) {
    let size = 160;
    const unit = rest.charCodeAt(size - 1);
    if (unit >= 0xD800 && unit <= 0xDBFF) size--;
    const prefix = rest.slice(0, size);
    const endings = [...prefix.matchAll(/[。！？；，!?;,]/gu)];
    const boundary = endings.at(-1)?.index;
    if (boundary !== undefined && boundary >= 79) size = boundary + 1;
    chunks.push(rest.slice(0, size)); rest = rest.slice(size);
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function projection(candidate) {
  requireValue(candidate?.evidenceParts === undefined, 'EVIDENCE_EXPECTED_RAW_CANDIDATE');
  const spans = originalSpans(candidate), content = candidate.content;
  const parts = [], options = new Map();
  let position = 0, ordinal = 0;
  const plain = text => {
    if (!text) return;
    if (typeof parts.at(-1) === 'string') parts[parts.length - 1] += text;
    else parts.push(text);
  };
  for (const span of spans) {
    plain(content.slice(position, span.start));
    let at = span.start;
    const lines = content.slice(span.start, span.end).split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      for (const text of splitLine(lines[lineIndex])) {
        if (text.trim().length >= 1) {
          const evidenceId = `e${String(++ordinal).padStart(4, '0')}`;
          parts.push({ evidenceId, text });
          options.set(evidenceId, { start: at, end: at + text.length, block: span.block });
        } else plain(text);
        at += text.length;
      }
      if (lineIndex < lines.length - 1) { plain('\n'); at++; }
    }
    requireValue(at === span.end, 'EVIDENCE_PROJECTION_RANGE');
    position = span.end;
  }
  plain(content.slice(position));
  requireValue(parts.map(part => typeof part === 'string' ? part : part.text).join('') === content,
    'EVIDENCE_PROJECTION_CHANGED_CONTENT');
  return { parts, options };
}

/** IDs are local to this candidate. They never resolve text from another one. */
export function buildEvidenceView(candidate) {
  const { parts } = projection(candidate);
  const { content, ...metadata } = structuredClone(candidate);
  return { ...metadata, evidenceParts: parts };
}

/** Verify numbering, fragment placement and exact reconstruction, including notes. */
export function expandEvidenceView(candidate) {
  requireValue(object(candidate) && candidate.content === undefined
    && Array.isArray(candidate.evidenceParts) && candidate.evidenceParts.length > 0,
  'EVIDENCE_VIEW_INVALID');
  const content = candidate.evidenceParts.map(part => {
    if (typeof part === 'string') return part;
    requireValue(exact(part, ['evidenceId', 'text']) && typeof part.evidenceId === 'string'
      && typeof part.text === 'string', 'EVIDENCE_PART_INVALID');
    return part.text;
  }).join('');
  const { evidenceParts, ...metadata } = structuredClone(candidate);
  const raw = { ...metadata, content };
  requireValue(isDeepStrictEqual(buildEvidenceView(raw), candidate), 'EVIDENCE_VIEW_NOT_CANONICAL');
  return raw;
}

/** Extract exact original spans, without normalizing whitespace or model quotes. */
export function resolveEvidenceSelections(selections, rawCandidate) {
  requireValue(Array.isArray(selections) && selections.length >= 1 && selections.length <= 4,
    'EVIDENCE_SELECTION_COUNT');
  const { options } = projection(rawCandidate);
  const quotes = selections.map(selection => {
    requireValue(exact(selection, ['startId', 'endId'])
      && typeof selection.startId === 'string' && typeof selection.endId === 'string',
    'EVIDENCE_SELECTION_SHAPE');
    const start = options.get(selection.startId), end = options.get(selection.endId);
    requireValue(start && end && start.block === end.block && start.start <= end.start,
      'EVIDENCE_SELECTION_RANGE');
    const quote = rawCandidate.content.slice(start.start, end.end);
    requireValue(quote.trim().length >= 2 && quote.length <= 160, 'EVIDENCE_SELECTION_LENGTH');
    return quote;
  });
  requireValue(new Set(quotes).size === quotes.length, 'EVIDENCE_SELECTION_DUPLICATE');
  requireValue(quotes.reduce((total, quote) => total + quote.length, 0) <= 480, 'EVIDENCE_SELECTION_TOTAL');
  return quotes;
}

const MARK = '␞';
const escaped = text => text.replaceAll(MARK, MARK + MARK);

/** Compact transport view: text appears once; only original fragments get IDs. */
export function buildCompactEvidenceView(candidate) {
  requireValue(candidate?.evidenceText === undefined, 'EVIDENCE_EXPECTED_RAW_CANDIDATE');
  const { options } = projection(candidate), events = [], lastByBlock = new Map();
  let ordinal = 0;
  for (const option of options.values()) {
    events.push({ position: option.start, text: MARK + String(++ordinal) + ':' });
    lastByBlock.set(option.block, option.end);
  }
  for (const position of lastByBlock.values()) events.push({ position, text: MARK + ';' });
  events.sort((a, b) => a.position - b.position);
  let position = 0, evidenceText = '';
  for (const event of events) {
    evidenceText += escaped(candidate.content.slice(position, event.position)) + event.text;
    position = event.position;
  }
  evidenceText += escaped(candidate.content.slice(position));
  const { content, ...metadata } = structuredClone(candidate);
  return { ...metadata, evidenceText };
}

export function expandCompactEvidenceView(candidate) {
  requireValue(object(candidate) && candidate.content === undefined && candidate.evidenceParts === undefined
    && typeof candidate.evidenceText === 'string', 'EVIDENCE_COMPACT_VIEW_INVALID');
  let content = '';
  const encoded = candidate.evidenceText;
  for (let i = 0; i < encoded.length;) {
    if (encoded[i] !== MARK) { content += encoded[i++]; continue; }
    if (encoded[i + 1] === MARK) { content += MARK; i += 2; continue; }
    const token = /^(?:[1-9][0-9]*:|;)/u.exec(encoded.slice(i + 1));
    requireValue(token, 'EVIDENCE_COMPACT_TOKEN_INVALID');
    i += 1 + token[0].length;
  }
  const { evidenceText, ...metadata } = structuredClone(candidate);
  const raw = { ...metadata, content };
  requireValue(isDeepStrictEqual(buildCompactEvidenceView(raw), candidate), 'EVIDENCE_COMPACT_VIEW_NOT_CANONICAL');
  return raw;
}

export function resolveCompactEvidenceSelections(selections, rawCandidate) {
  requireValue(Array.isArray(selections) && selections.length >= 1 && selections.length <= 4,
    'EVIDENCE_SELECTION_COUNT');
  const expanded = selections.map(selection => {
    requireValue(exact(selection, ['startId', 'endId'])
      && typeof selection.startId === 'string' && /^[1-9][0-9]{0,3}$/u.test(selection.startId)
      && typeof selection.endId === 'string' && /^[1-9][0-9]{0,3}$/u.test(selection.endId),
    'EVIDENCE_SELECTION_SHAPE');
    return { startId: 'e' + selection.startId.padStart(4, '0'), endId: 'e' + selection.endId.padStart(4, '0') };
  });
  return resolveEvidenceSelections(expanded, rawCandidate);
}
