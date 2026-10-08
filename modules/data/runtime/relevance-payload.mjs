import {buildBoundedEvidenceView,expandBoundedEvidenceView,BOUNDED_EVIDENCE_VIEW_VERSION} from './relevance-evidence-ids.mjs';
import {buildCompactEvidenceView,expandCompactEvidenceView,COMPACT_EVIDENCE_VIEW_VERSION} from './relevance-evidence-selections.mjs';
import { createHash } from 'node:crypto';
const hash = text => createHash('sha256').update(text).digest('hex');
const scope = candidate => [candidate.sourceId, candidate.sourceSha256, candidate.textVersion];
const analysisScope = candidate => [...scope(candidate), candidate.analysisVersion];
const key = (candidate, text) => JSON.stringify([...scope(candidate), text]);
const limitationKey = (candidate, values) => JSON.stringify(['limitations', ...analysisScope(candidate), values]);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|');
const nonempty = value => typeof value === 'string' && value.length > 0;
const notes = value => Array.isArray(value) && value.every(note => typeof note === 'string');
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const inputDigest = input => hash(JSON.stringify(canonical(input)));

/** Share exact repeated notes, coalescing only invariant adjacent runs.
 * An A -> B join is allowed only if every A is followed by B and every B is preceded by A.
 * Boundaries, order, duplicate notes, whitespace and candidate-specific notes stay intact.
 */
function packLimitations(input, textPacked) {
  const counts = new Map();
  const lists = textPacked.candidates.map(c => {
    if (c.limitations === undefined) return [];
    if (!notes(c.limitations)) throw Error('invalid candidate limitations');
    if (!analysisScope(c).every(nonempty)) return []; // Old candidates lack analysisVersion: never infer one.
    const keys = c.limitations.map(note => limitationKey(c, [note]));
    keys.forEach((k, i) => {
      if (!counts.has(k)) counts.set(k, { count: 0, previous: new Set(), next: new Set() });
      const stat = counts.get(k); stat.count++;
      stat.previous.add(keys[i - 1] ?? null); stat.next.add(keys[i + 1] ?? null);
    });
    return keys;
  });
  const shared = new Map();
  const candidates = textPacked.candidates.map((c, index) => {
    const keys = lists[index];
    if (!keys.some(k => counts.get(k).count > 1)) return structuredClone(c);
    const { limitations, ...metadata } = structuredClone(c), limitationsParts = [];
    for (let i = 0; i < keys.length;) {
      if (counts.get(keys[i]).count < 2) { limitationsParts.push(limitations[i++]); continue; }
      const start = i++;
      while (i < keys.length) {
        const previous = counts.get(keys[i - 1]), next = counts.get(keys[i]);
        if (next.count < 2 || previous.next.size !== 1 || !previous.next.has(keys[i]) || next.previous.size !== 1 || !next.previous.has(keys[i - 1])) break;
        i++;
      }
      const values = limitations.slice(start, i), k = limitationKey(c, values);
      if (!shared.has(k)) shared.set(k, { id: hash(k), sourceId: c.sourceId, sourceSha256: c.sourceSha256, textVersion: c.textVersion, analysisVersion: c.analysisVersion, values });
      limitationsParts.push({ blockId: shared.get(k).id });
    }
    return { ...metadata, limitationsParts, limitationsSha256: hash(JSON.stringify(limitations)) };
  });
  if (!shared.size) return textPacked;
  return { ...textPacked, payloadFormat: 'shared-text-2', candidates, sharedText: textPacked.sharedText ?? [],
    sharedLimitations: [...shared.values()], expandedInputSha256: inputDigest(input) };
}

/** Keep each complete content string inline and in reading order. Only repeated
 * analysis-version-bound limitations may share; legacy text sharing remains read-only.
 */
function packSharedInput(input) {
  if (input.payloadFormat !== undefined || input.sharedText !== undefined || input.sharedLimitations !== undefined || input.expandedInputSha256 !== undefined
    || input.candidates.some(c => c.contentParts !== undefined || c.limitationsParts !== undefined || c.limitationsSha256 !== undefined)) throw Error('expected expanded relevance input');
  const textPacked = structuredClone(input), packed = packLimitations(input, textPacked);
  return JSON.stringify(packed).length < JSON.stringify(textPacked).length ? packed : textPacked;
}

function expandText(candidates, sharedText) {
  const blocks = new Map();
  for (const block of sharedText) {
    if (!exact(block, ['id', 'sourceId', 'sourceSha256', 'textVersion', 'text']) || !scope(block).every(nonempty)
      || typeof block.text !== 'string' || block.id !== hash(key(block, block.text)) || blocks.has(block.id)) throw Error('invalid shared text block');
    blocks.set(block.id, block);
  }
  const used = new Set();
  const expanded = candidates.map(c => {
    if (!object(c)) throw Error('invalid candidate');
    if (c.contentParts === undefined) {
      if (typeof c.content !== 'string' || hash(c.content) !== c.contentSha256 || c.content.length > 4800) throw Error('invalid inline candidate');
      return c;
    }
    if (c.content !== undefined || !Array.isArray(c.contentParts) || !c.contentParts.length) throw Error('invalid content parts');
    const content = c.contentParts.map(part => {
      if (typeof part === 'string') return part;
      if (!exact(part, ['blockId']) || typeof part.blockId !== 'string') throw Error('invalid block reference');
      const block = blocks.get(part.blockId);
      if (!block || JSON.stringify(scope(block)) !== JSON.stringify(scope(c))) throw Error('missing or cross-source block');
      used.add(block.id); return block.text;
    }).join('');
    if (hash(content) !== c.contentSha256 || content.length > 4800) throw Error('candidate reconstruction mismatch');
    const { contentParts, ...metadata } = c;
    return { ...metadata, content };
  });
  if (used.size !== blocks.size) throw Error('unused shared block');
  return expanded;
}

function expandLimitations(candidates, sharedLimitations) {
  const blocks = new Map();
  for (const block of sharedLimitations) {
    if (!exact(block, ['id', 'sourceId', 'sourceSha256', 'textVersion', 'analysisVersion', 'values'])
      || !analysisScope(block).every(nonempty) || !notes(block.values) || !block.values.length
      || block.id !== hash(limitationKey(block, block.values)) || blocks.has(block.id)) throw Error('invalid shared limitations block');
    blocks.set(block.id, block);
  }
  const used = new Set();
  const expanded = candidates.map(c => {
    if (c.limitationsParts === undefined) {
      if (c.limitationsSha256 !== undefined || (c.limitations !== undefined && !notes(c.limitations))) throw Error('invalid inline limitations');
      return c;
    }
    if (c.limitations !== undefined || !Array.isArray(c.limitationsParts) || !c.limitationsParts.length || !analysisScope(c).every(nonempty)) throw Error('invalid limitations parts');
    const limitations = c.limitationsParts.flatMap(part => {
      if (typeof part === 'string') return [part];
      if (!exact(part, ['blockId']) || typeof part.blockId !== 'string') throw Error('invalid limitations reference');
      const block = blocks.get(part.blockId);
      if (!block || JSON.stringify(analysisScope(block)) !== JSON.stringify(analysisScope(c))) throw Error('missing or cross-version limitations');
      used.add(block.id); return block.values;
    });
    if (hash(JSON.stringify(limitations)) !== c.limitationsSha256) throw Error('limitations reconstruction mismatch');
    const { limitationsParts, limitationsSha256, ...metadata } = c;
    return { ...metadata, limitations };
  });
  if (used.size !== blocks.size) throw Error('unused shared limitations');
  return expanded;
}

/** Exact inverse. Checksums detect corruption; they are not signatures or new review approvals.
 * prepareRelevance still compares the full expansion with its authenticated input, and hashes
 * the actual serialized packed envelope as inputHash for the assessor response binding.
 */
function expandSharedInput(input) {
  if (input.payloadFormat === undefined) {
    if (input.sharedText !== undefined || input.sharedLimitations !== undefined || input.expandedInputSha256 !== undefined
      || input.candidates?.some(c => c?.contentParts !== undefined || c?.limitationsParts !== undefined || c?.limitationsSha256 !== undefined)) throw Error('missing relevance payload format');
    return structuredClone(input);
  }
  if (!['shared-text-1', 'shared-text-2'].includes(input.payloadFormat) || !Array.isArray(input.sharedText) || !Array.isArray(input.candidates)) throw Error('unknown relevance payload');
  if (input.payloadFormat === 'shared-text-1') {
    if (input.sharedLimitations !== undefined || input.expandedInputSha256 !== undefined || input.candidates.some(c => c?.limitationsParts !== undefined || c?.limitationsSha256 !== undefined)) throw Error('mixed relevance payload versions');
    const { payloadFormat, sharedText, ...expanded } = structuredClone(input);
    expanded.candidates = expandText(expanded.candidates, sharedText);
    return expanded;
  }
  if (!Array.isArray(input.sharedLimitations) || !input.sharedLimitations.length || !/^[0-9a-f]{64}$/.test(input.expandedInputSha256)) throw Error('invalid shared metadata envelope');
  const { payloadFormat, sharedText, sharedLimitations, expandedInputSha256, ...expanded } = structuredClone(input);
  expanded.candidates = expandLimitations(expandText(expanded.candidates, sharedText), sharedLimitations);
  if (inputDigest(expanded) !== expandedInputSha256) throw Error('expanded input mismatch');
  return expanded;
}

export {COMPACT_EVIDENCE_VIEW_VERSION};
/** New live inputs carry each source byte once, plus selectable source-only IDs.
 * Historical shared formats retain their exact inverse and are never rewritten.
 */
export function packRelevanceInput(input) {
  if (input.evidenceViewVersion !== undefined || input.candidates?.some(c => c.evidenceParts !== undefined || c.evidenceText !== undefined)) throw Error('expected expanded evidence input');
  const packed = packSharedInput(input);
  if (input.schemaVersion === 'library-relevance-4') return {...packed,evidenceViewVersion:BOUNDED_EVIDENCE_VIEW_VERSION,candidates:packed.candidates.map(buildBoundedEvidenceView)};
  if (input.schemaVersion !== 'library-relevance-3') return packed;
  return {...packed, evidenceViewVersion: COMPACT_EVIDENCE_VIEW_VERSION, candidates: packed.candidates.map(buildCompactEvidenceView)};
}
export function expandRelevanceInput(input) {
  if (input.evidenceViewVersion === undefined) {
    if (input.candidates?.some(c => c?.evidenceParts !== undefined || c?.evidenceText !== undefined)) throw Error('missing evidence view version');
    return expandSharedInput(input);
  }
  const bounded=input.evidenceViewVersion===BOUNDED_EVIDENCE_VIEW_VERSION&&input.schemaVersion==='library-relevance-4';
  const legacy=input.evidenceViewVersion===COMPACT_EVIDENCE_VIEW_VERSION&&input.schemaVersion==='library-relevance-3';
  if ((!bounded&&!legacy)||!Array.isArray(input.candidates)) throw Error('unknown evidence view');
  const {evidenceViewVersion, ...packed} = structuredClone(input);
  packed.candidates = packed.candidates.map(bounded?expandBoundedEvidenceView:expandCompactEvidenceView);
  return expandSharedInput(packed);
}
