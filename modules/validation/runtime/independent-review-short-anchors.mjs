import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = x => createHash('sha256').update(typeof x === 'string' || Buffer.isBuffer(x) ? x : JSON.stringify(x)).digest('hex');
const OBJECT = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const TEXT = { type: 'string', minLength: 1 }, ARRAY = (items, minItems = 0) => ({ type: 'array', items, minItems });
export const CODEX_ANCHOR_VERSION = 'independent-codex-short-anchor-1';
export const ANCHOR_LIMIT = 240, QUOTE_LIMIT = 160;
export function codexResponseSchema() {
  const citation = OBJECT({ anchorId: { type: 'string', pattern: '^C[0-9]{5,}$' }, quote: { type: 'string', minLength: 1, maxLength: QUOTE_LIMIT } });
  return OBJECT({ caseId: TEXT,
    manuscriptAssessments: { ...ARRAY(OBJECT({ blindId: { type: 'string', enum: ['A', 'B'] }, assessment: TEXT, evidence: ARRAY(citation, 1), counterEvidence: ARRAY(citation) }), 2), maxItems: 2 },
    preference: { type: 'string', enum: ['A', 'B', 'tradeoff', 'no_clear_preference'] }, rationale: TEXT,
    keyFindings: ARRAY(OBJECT({ claimType: { type: 'string', enum: ['hard_fact', 'editorial_hypothesis'] }, claim: TEXT,
      evidence: ARRAY(citation, 1), counterEvidence: ARRAY(citation), uncertainty: { type: 'string' } })) });
}
function splitBody(body) {
  const spans = []; let start = 0;
  while (start < body.length) {
    let end = Math.min(start + ANCHOR_LIMIT, body.length);
    if (end < body.length && ((/[\uD800-\uDBFF]/.test(body[end - 1]) && /[\uDC00-\uDFFF]/.test(body[end])) || (body[end - 1] === '\r' && body[end] === '\n'))) end--;
    spans.push({ start, text: body.slice(start, end) }); start = end;
  }
  assert.equal(spans.map(s => s.text).join(''), body); return spans;
}
export function prepareCodexAnchorPacket(pair) {
  const entries = [];
  const manuscripts = pair.manuscripts.map(m => ({ blindId: m.blindId, chapters: m.chapters.map(c => {
    const paragraphs = splitBody(c.body).map(s => {
      const anchorId = `C${String(entries.length + 1).padStart(5, '0')}`, citable = Boolean(s.text.trim());
      entries.push({ anchorId, blindId: m.blindId, chapterId: c.id, start: s.start, text: s.text, citable });
      return { anchorId, text: s.text, citable };
    });
    return { id: c.id, title: c.title, bodySHA256: hash(c.body), bodyUTF16Length: c.body.length, paragraphs };
  }) }));
  const catalog = { schemaVersion: CODEX_ANCHOR_VERSION, entries, catalogSHA256: hash(entries) };
  const core = { schemaVersion: CODEX_ANCHOR_VERSION, caseId: pair.caseId, manuscripts,
    readingFocusDefinitions: pair.readingFocusDefinitions, instructions: { identityHidden: true, goalsHidden: true, priorReviewsHidden: true,
      readAllParagraphs: true, anchorUTF16Limit: ANCHOR_LIMIT, quoteUTF16Limit: QUOTE_LIMIT, offsetDerivedLocally: true }, catalogSHA256: catalog.catalogSHA256 };
  return { packet: { ...core, packetSha256: hash(core) }, catalog };
}
function schemaErrors(schema, value, at = '') {
  const errors = [], fail = code => errors.push({ code, JSONPointer: at });
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) { fail('OBJECT_REQUIRED'); return errors; }
    for (const key of schema.required) if (!Object.hasOwn(value, key)) errors.push({ code: 'MISSING_FIELD', JSONPointer: `${at}/${key}` });
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties, key)) errors.push({ code: 'EXTRA_FIELD', JSONPointer: `${at}/${key}` });
      else errors.push(...schemaErrors(schema.properties[key], value[key], `${at}/${key}`));
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) { fail('ARRAY_REQUIRED'); return errors; }
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) fail('ARRAY_LENGTH');
    value.forEach((v, i) => errors.push(...schemaErrors(schema.items, v, `${at}/${i}`)));
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') { fail('STRING_REQUIRED'); return errors; }
    if (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? Infinity) || (schema.minLength && !value.trim())) fail('STRING_LENGTH');
    if (schema.enum && !schema.enum.includes(value)) fail('STRING_ENUM');
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('STRING_PATTERN');
  }
  return errors;
}
function reconstructCatalog(packet) {
  const { packetSha256, ...core } = packet; assert.equal(hash(core), packetSha256, 'Prompt packet hash mismatch');
  assert.equal(packet.schemaVersion, CODEX_ANCHOR_VERSION); assert.equal(packet.manuscripts.length, 2);
  const entries = [], ids = new Set(), blindIds = new Set();
  for (const m of packet.manuscripts) {
    assert(['A', 'B'].includes(m.blindId) && !blindIds.has(m.blindId)); blindIds.add(m.blindId);
    const chapterIds = new Set();
    for (const c of m.chapters) {
      assert(!chapterIds.has(c.id)); chapterIds.add(c.id); let start = 0;
      for (const p of c.paragraphs) {
        assert(/^C[0-9]{5,}$/.test(p.anchorId) && !ids.has(p.anchorId)); ids.add(p.anchorId);
        assert(typeof p.text === 'string' && p.text.length > 0 && p.text.length <= ANCHOR_LIMIT);
        assert.equal(p.citable, Boolean(p.text.trim()));
        entries.push({ anchorId: p.anchorId, blindId: m.blindId, chapterId: c.id, start, text: p.text, citable: p.citable }); start += p.text.length;
      }
      assert.equal(start, c.bodyUTF16Length); assert.equal(hash(c.paragraphs.map(p => p.text).join('')), c.bodySHA256);
    }
  }
  assert.equal(hash(entries), packet.catalogSHA256); return entries;
}
export function resolveCodexAnchorResponse({ promptText, rawResponse }) {
  const report = { schemaVersion: 'codex-short-anchor-inspection-1', promptSHA256: hash(promptText), responseSHA256: hash(rawResponse),
    passed: false, rawResponseChanged: false, derivedLocationsOnly: true, jsonClosed: false, schemaValid: false, exactCitationIntegrity: false,
    semanticSupportVerified: false, qualityPass: 'NOT_COMPUTED', errors: [], mappings: [] };
  let packet, response, entries;
  try { packet = JSON.parse(JSON.parse(promptText).user).packet; entries = reconstructCatalog(packet); }
  catch (e) { report.errors.push({ code: 'INVALID_PROMPT_BINDING', message: e.message }); return report; }
  try { response = JSON.parse(rawResponse); report.jsonClosed = true; }
  catch (e) { report.errors.push({ code: 'RESPONSE_NOT_CLOSED_JSON', message: e.message }); return report; }
  report.errors.push(...schemaErrors(codexResponseSchema(), response)); report.schemaValid = report.errors.length === 0;
  if (!report.schemaValid) return report;
  if (response.caseId !== packet.caseId) report.errors.push({ code: 'CASE_ID_MISMATCH' });
  if (new Set(response.manuscriptAssessments.map(a => a.blindId)).size !== 2) report.errors.push({ code: 'ASSESSMENT_COVERAGE' });
  const byId = new Map(entries.map(e => [e.anchorId, e]));
  const derived = structuredClone(response);
  function citations(list, at, blindId) {
    const seen = new Set();
    return list.map((ref, i) => {
      const location = `${at}/${i}`, entry = byId.get(ref.anchorId);
      const fail = code => report.errors.push({ code, JSONPointer: location, anchorId: ref.anchorId });
      const key = JSON.stringify([ref.anchorId, ref.quote]);
      if (seen.has(key)) { fail('DUPLICATE_CITATION_IN_LIST'); return null; }
      seen.add(key);
      if (!entry || !entry.citable) { fail('UNKNOWN_OR_NONCITABLE_ANCHOR'); return null; }
      if (blindId && entry.blindId !== blindId) { fail('WRONG_MANUSCRIPT_ANCHOR'); return null; }
      const localStart = entry.text.indexOf(ref.quote);
      if (localStart < 0) { fail('QUOTE_NOT_IN_ANCHOR'); return null; }
      if (entry.text.indexOf(ref.quote, localStart + 1) !== -1) { fail('QUOTE_AMBIGUOUS_WITHIN_ANCHOR'); return null; }
      const cite = { blindId: entry.blindId, chapterId: entry.chapterId, quote: ref.quote, start: entry.start + localStart };
      report.mappings.push({ JSONPointer: location, anchorId: ref.anchorId, anchorStart: entry.start, localStart, ...cite,
        quoteSHA256: hash(ref.quote), source: 'exact-unique-substring-of-frozen-anchor' }); return cite;
    });
  }
  derived.manuscriptAssessments.forEach((a, i) => { for (const key of ['evidence', 'counterEvidence']) a[key] = citations(a[key], `/manuscriptAssessments/${i}/${key}`, a.blindId); });
  derived.keyFindings.forEach((f, i) => { for (const key of ['evidence', 'counterEvidence']) f[key] = citations(f[key], `/keyFindings/${i}/${key}`); });
  report.exactCitationIntegrity = report.errors.length === 0;
  report.passed = report.schemaValid && report.exactCitationIntegrity;
  report.catalogSHA256 = packet.catalogSHA256;
  if (report.passed) { report.derivedResponse = derived; report.derivedResponseSHA256 = hash(derived); }
  return report;
}
export async function checkCodexAnchorFiles({ promptPath, responsePath }) {
  const [p, r] = await Promise.all([readFile(promptPath), readFile(responsePath)]);
  return { ...resolveCodexAnchorResponse({ promptText: p.toString('utf8'), rawResponse: r.toString('utf8') }),
    promptPath, responsePath, promptSHA256: hash(p), responseSHA256: hash(r) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 4, 'Usage: node independent-review-short-anchors.mjs /absolute/prompt.json /absolute/raw-response.txt');
    const result = await checkCodexAnchorFiles({ promptPath: path.resolve(process.argv[2]), responsePath: path.resolve(process.argv[3]) });
    console.log(JSON.stringify(result, null, 2)); process.exitCode = result.passed ? 0 : 1;
  } catch (e) { console.log(JSON.stringify({ status: 'input_unavailable', message: e.message, passed: false })); process.exitCode = 2; }
}
