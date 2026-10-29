import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { manuscriptFingerprint } from '../../validation/runtime/checks.mjs';
import { buildWholeQualityQuery, retrieveWholeQualityEvidence, retrieveWholeQualityEvidenceWithObservationRecall,
  addWholeQualityObservationRecall, buildWholeQualityMaterialUseLedger, buildWholeQualityApplicabilityReview,
  buildWholeQualityFinalTextUseEvidence, buildWholeQualityC06ReferenceList,
  validateWholeQualityRetrievalPacket, assertWholeQualityEvidenceBundle } from '../../data/runtime/whole-quality-retrieval.mjs';
import { DEEP_REFERENCE_INTEGRATION_VERSION, resolveDeepReferenceCallback, createDeepReferenceRetrievalAdapter,
  buildWholeQualityDeepReferenceBundle, assertGoalDeepReferencePacket } from './v04/deep-reference.mjs';
import { validateWritingGoals, writingGoalSubjects, writingGoalSubjectId, writingGoalQuerySubject,
  wholeQualityRetrievalEntries, WRITING_GOAL_DATA_OPTIONS } from './writing-goals.mjs';

export const WHOLE_QUALITY_MODE = 'whole-manuscript-v2';
export const WHOLE_QUALITY_REQUEST_VERSION = 'whole-manuscript-quality-request-1';
export const WHOLE_QUALITY_RESULT_VERSION = 'whole-manuscript-quality-1';
export const WHOLE_QUALITY_READING_VERSION = 'whole-quality-reading-1';
export const WHOLE_QUALITY_READING_REPAIR_VERSION = 'whole-quality-reading-format-repair-2';
export const WHOLE_QUALITY_READING_FEEDBACK_VERSION = 'whole-quality-reading-literal-feedback-1';
export const WHOLE_QUALITY_READING_FEEDBACK_LIMITS = Object.freeze({ locations: 24, locationChars: 24000, quoteChars: 2000 });
export const WHOLE_QUALITY_PLAN_VERSION = 'whole-quality-plan-1';
export const WHOLE_QUALITY_FEASIBILITY_VERSION = 'whole-quality-feasibility-1';
export const WHOLE_QUALITY_CANDIDATE_VERSION = 'whole-quality-candidate-1';
export const WHOLE_QUALITY_REREAD_VERSION = 'whole-quality-reread-1';
export const WHOLE_QUALITY_REREAD_INCOMPLETE_VERSION = 'whole-quality-reread-incomplete-1';
export const WHOLE_QUALITY_PLAN_PROVENANCE_VERSION = 'whole-quality-plan-provenance-1';
export const WHOLE_QUALITY_APPLICABILITY_STAGE_VERSION = 'whole-quality-applicability-stage-1';
export const WHOLE_QUALITY_APPLICABILITY_BUNDLE_VERSION = 'whole-quality-applicability-bundle-1';
export const WHOLE_QUALITY_FINAL_TEXT_STAGE_VERSION = 'whole-quality-final-text-stage-1';
export const WHOLE_QUALITY_FINAL_TEXT_BUNDLE_VERSION = 'whole-quality-final-text-bundle-1';
export const WHOLE_QUALITY_CROSS_CHAPTER_BUNDLE_VERSION = 'whole-quality-cross-chapter-bundle-1';
export const WHOLE_QUALITY_CROSS_CHAPTER_OUTCOME_VERSION = 'whole-quality-cross-chapter-outcome-1';

const LIMITS = Object.freeze({ chapters: 30, manuscriptChars: 200000, scenes: 80, issues: 24,
  majorIssues: 6, planItems: 10, evidence: 10, materialsPerIssue: 6, text: 8000,
  responseChars: 500000, notes: 16 });
const hex64 = /^[0-9a-f]{64}$/;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hashText = value => createHash('sha256').update(value).digest('hex');
const fingerprint = value => hashText(JSON.stringify(canonical(value)));
const bodyFingerprint = body => hashText(body);
const CROSS_CHAPTER_INTEGRATION_VERSION = 'whole-quality-cross-chapter-integration-1';
const CROSS_CHAPTER_PROTOCOL_FAILURE_VERSION = 'whole-quality-cross-chapter-protocol-failure-1';
const CROSS_CHAPTER_ATTEMPT_VERSION = 'whole-quality-cross-chapter-attempt-1';
const CROSS_CHAPTER_RETRY_BINDING_VERSION = 'whole-quality-cross-chapter-retry-binding-1';
const CROSS_CHAPTER_RETRYABLE_FAILURES = new Set(['FORMAT_REPAIR_FAILED','FORMAT_REPAIR_SEMANTIC_DRIFT']);
const CROSS_CHAPTER_STAGE_ORDER = ['whole-quality:cross-chapter:extract','whole-quality:cross-chapter:adjudicate'];

export class WholeQualityError extends Error {
  constructor(code, message) { super(message); this.name = 'WholeQualityError'; this.code = code; }
}
const fail = (code, message) => { throw new WholeQualityError(code, message); };
const requireThat = (condition, code, message) => { if (!condition) fail(code, message); };
function exact(value, required, optional = [], code = 'WHOLE_QUALITY_FIELDS') {
  requireThat(record(value), code, '对象格式无效。');
  const keys = Object.keys(value);
  requireThat(required.every(key => Object.hasOwn(value, key))
    && keys.every(key => required.includes(key) || optional.includes(key)), code, '对象字段不完整或包含未知字段。');
}
function text(value, code = 'WHOLE_QUALITY_TEXT', limit = LIMITS.text) {
  requireThat(typeof value === 'string' && value.trim().length > 0 && value.length <= limit, code, '文字字段为空或超限。');
  return value;
}
function stringList(value, code, max = LIMITS.notes, allowEmpty = true) {
  requireThat(Array.isArray(value) && value.length <= max && (allowEmpty || value.length > 0), code, '文字列表数量无效。');
  value.forEach(item => text(item, code, 2000)); return clone(value);
}
function abortIfNeeded(signal) {
  if (typeof signal?.throwIfAborted === 'function') signal.throwIfAborted();
  else if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('任务已取消。');
}
function jsonCopy(value) { try { return JSON.parse(JSON.stringify(value)); } catch { fail('WHOLE_QUALITY_JSON', '输入含不能保存的值。'); } }
function validateChapters(value, code = 'WHOLE_QUALITY_CHAPTERS') {
  requireThat(Array.isArray(value) && value.length > 0 && value.length <= LIMITS.chapters, code, '完整稿章节数量无效。');
  const ids = new Set(); let total = 0;
  const chapters = value.map(chapter => {
    exact(chapter, ['id', 'title', 'body'], [], code); text(chapter.id, code, 200); text(chapter.title, code, 1000); text(chapter.body, code, 100000);
    requireThat(!ids.has(chapter.id), code, '章节标识重复。'); ids.add(chapter.id); total += chapter.body.length;
    return clone(chapter);
  });
  requireThat(total <= LIMITS.manuscriptChars, code, '完整稿超过字符上限。'); return chapters;
}
function sameIds(actual, expected, code, message = '标识范围不完整或顺序不一致。') {
  requireThat(Array.isArray(actual) && actual.length === expected.length && actual.every((id, i) => id === expected[i]), code, message);
}
function quoteStarts(body, quote) { const starts = []; for (let i = body.indexOf(quote); i >= 0; i = body.indexOf(quote, i + 1)) starts.push(i); return starts; }
function evidenceFailure(code, message, fieldPath, value, chapter) {
  const error = new WholeQualityError(code, message);
  error.location = { fieldPath, chapterId: value?.chapterId ?? null, quote: value?.quote ?? null,
    ...(typeof value?.quote === 'string' ? { quoteSha256: hashText(value.quote) } : {}),
    ...(Number.isSafeInteger(value?.start) ? { start: value.start } : {}),
    ...(Number.isSafeInteger(value?.occurrence) ? { occurrence: value.occurrence } : {}),
    ...(chapter ? { chapterBodySha256: bodyFingerprint(chapter.body) } : {}) };
  throw error;
}
function evidence(value, chapters, code, fieldPath = 'evidence') {
  requireThat(record(value), code, '证据格式无效。'); const normalized = Object.hasOwn(value, 'start');
  exact(value, normalized ? ['chapterId', 'start', 'quote', 'purpose'] : ['chapterId', 'quote', 'purpose'], normalized ? [] : ['occurrence'], code);
  const chapter = chapters.find(item => item.id === value.chapterId); if (!chapter) evidenceFailure(code, '证据章节无效。', fieldPath, value);
  text(value.quote, code, 2000); text(value.purpose, code, 2000);
  if (normalized) {
    if (!Number.isSafeInteger(value.start) || value.start < 0 || chapter.body.slice(value.start, value.start + value.quote.length) !== value.quote)
      evidenceFailure(code, '证据不是对应章指定 UTF-16 位置的逐字原文。', fieldPath, value, chapter);
    return clone(value);
  }
  const starts = quoteStarts(chapter.body, value.quote); if (!starts.length) evidenceFailure(code, '证据引文未逐字出现。', fieldPath, value, chapter);
  if (starts.length > 1 && (!Number.isSafeInteger(value.occurrence) || value.occurrence < 1 || value.occurrence > starts.length))
    evidenceFailure(code, '重复引文须给 occurrence。', fieldPath, value, chapter);
  if (starts.length === 1 && value.occurrence !== undefined && value.occurrence !== 1)
    evidenceFailure(code, '唯一引文 occurrence 无效。', fieldPath, value, chapter);
  return { chapterId: value.chapterId, start: starts[(value.occurrence ?? 1) - 1], quote: value.quote, purpose: value.purpose };
}
function evidenceList(value, chapters, code, { min = 0, max = LIMITS.evidence, path = 'evidence' } = {}) {
  requireThat(Array.isArray(value) && value.length >= min && value.length <= max, code, '证据数量无效。');
  const checked = value.map((item, index) => evidence(item, chapters, code, `${path}[${index}]`));
  requireThat(new Set(checked.map(item => `${item.chapterId}:${item.start}:${item.quote.length}`)).size === checked.length, code, '证据位置重复。');
  return checked;
}
function coverage(value, code) {
  exact(value, ['status', 'omissions'], [], code); requireThat(['complete', 'bounded'].includes(value.status), code, '覆盖状态无效。');
  stringList(value.omissions, code, 16, value.status === 'complete');
  requireThat((value.status === 'bounded') === (value.omissions.length > 0), code, '覆盖状态与遗漏不一致。'); return clone(value);
}
function rangesOverlap(a, b) { return a.chapterId === b.chapterId && a.start < b.start + b.quote.length && b.start < a.start + a.quote.length; }
function responseExampleEvidence(chapter) {
  const line = chapter.body.split('\n').find(part => part.length) ?? chapter.body;
  const quote = line.slice(0, Math.min(line.length, 120)); return { chapterId: chapter.id, quote, purpose: '字段结构示例；不是诊断',
    ...(quoteStarts(chapter.body, quote).length > 1 ? { occurrence: 1 } : {}) };
}

function requestCore(request, chapters) {
  const objective = typeof request.instruction === 'string' && request.instruction.trim() ? request.instruction : typeof request.idea === 'string' ? request.idea : '';
  text(objective, 'WHOLE_QUALITY_OBJECTIVE', 12000);
  requireThat(request.kind === 'revise' && request.revisionMode === WHOLE_QUALITY_MODE, 'WHOLE_QUALITY_MODE_REQUIRED', '需要 whole-manuscript-v2 revise 请求。');
  requireThat(!request.quote && request.quoteSource === undefined, 'WHOLE_QUALITY_SELECTION_FORBIDDEN', '整稿模式不能携带选段。');
  requireThat(typeof request.baseRevision === 'string' && request.baseRevision.length <= 200000, 'WHOLE_QUALITY_BASE_REVISION', '起点版本无效。');
  let sourceIds;
  if (request.sourceIds !== undefined) {
    requireThat(Array.isArray(request.sourceIds) && request.sourceIds.length <= 100 && request.sourceIds.every(id => typeof id === 'string' && id.trim()),
      'WHOLE_QUALITY_SOURCE_IDS', '指定来源无效。'); sourceIds = [...new Set(request.sourceIds)];
  }
  let crossChapterReview;
  if (request.crossChapterReview !== undefined) {
    exact(request.crossChapterReview, ['enabled','contractVersion','integrationVersion','modelPolicy'], [], 'WHOLE_QUALITY_CROSS_CHAPTER_BINDING');
    requireThat(request.crossChapterReview.enabled === true && request.crossChapterReview.contractVersion === 'cross-chapter-review-result-1'
      && request.crossChapterReview.integrationVersion === CROSS_CHAPTER_INTEGRATION_VERSION, 'WHOLE_QUALITY_CROSS_CHAPTER_BINDING', '跨章核对请求绑定版本无效。');
    text(request.crossChapterReview.modelPolicy, 'WHOLE_QUALITY_CROSS_CHAPTER_BINDING', 300); crossChapterReview = clone(request.crossChapterReview);
  }
  return { kind: 'revise', revisionMode: WHOLE_QUALITY_MODE, sourceBaseRevision: request.baseRevision, objective, chapters,
    ...(sourceIds !== undefined ? { sourceIds } : {}), ...(crossChapterReview !== undefined ? { crossChapterReview } : {}),
    ...(request.writingGoals === undefined ? {} : { writingGoals: validateWritingGoals(request.writingGoals, chapters) }) };
}
export function createWholeQualityRequestSpec(request, { deepReferenceEnabled = false } = {}) {
  requireThat(record(request), 'WHOLE_QUALITY_REQUEST', '请求格式无效。'); const chapters = validateChapters(request.chapters); const core = requestCore(request, chapters);
  requireThat(typeof deepReferenceEnabled === 'boolean', 'WHOLE_QUALITY_REQUEST', '深层参考策略开关无效。');
  const boundCore = { ...core, ...(deepReferenceEnabled ? { deepReferencePolicyVersion: DEEP_REFERENCE_INTEGRATION_VERSION } : {}) };
  return { schemaVersion: WHOLE_QUALITY_REQUEST_VERSION, kind: core.kind, revisionMode: core.revisionMode,
    inputFingerprint: fingerprint(boundCore), sourceManuscriptSha256: manuscriptFingerprint(chapters), sourceChapterIds: chapters.map(c => c.id),
    sourceBaseRevision: core.sourceBaseRevision, objective: core.objective, ...(core.sourceIds !== undefined ? { sourceIds: core.sourceIds } : {}),
    ...(core.crossChapterReview !== undefined ? { crossChapterReview: core.crossChapterReview } : {}),
    ...(deepReferenceEnabled ? { deepReferencePolicyVersion: DEEP_REFERENCE_INTEGRATION_VERSION } : {}),
    ...(core.writingGoals === undefined ? {} : { writingGoals: core.writingGoals }) };
}
function validateRequestSpec(value, chapters) {
  exact(value, ['schemaVersion', 'kind', 'revisionMode', 'inputFingerprint', 'sourceManuscriptSha256', 'sourceChapterIds', 'sourceBaseRevision', 'objective'], ['sourceIds','crossChapterReview','deepReferencePolicyVersion','writingGoals'], 'WHOLE_QUALITY_REQUEST_SPEC');
  requireThat(value.schemaVersion === WHOLE_QUALITY_REQUEST_VERSION && value.kind === 'revise' && value.revisionMode === WHOLE_QUALITY_MODE,
    'WHOLE_QUALITY_REQUEST_SPEC', '请求规格版本无效。'); requireThat(hex64.test(value.inputFingerprint) && hex64.test(value.sourceManuscriptSha256), 'WHOLE_QUALITY_REQUEST_SPEC', '请求指纹无效。');
  sameIds(value.sourceChapterIds, chapters.map(c => c.id), 'WHOLE_QUALITY_REQUEST_SPEC'); text(value.objective, 'WHOLE_QUALITY_REQUEST_SPEC', 12000);
  if (value.crossChapterReview !== undefined) {
    exact(value.crossChapterReview, ['enabled','contractVersion','integrationVersion','modelPolicy'], [], 'WHOLE_QUALITY_REQUEST_SPEC');
    requireThat(value.crossChapterReview.enabled === true && value.crossChapterReview.contractVersion === 'cross-chapter-review-result-1'
      && value.crossChapterReview.integrationVersion === CROSS_CHAPTER_INTEGRATION_VERSION, 'WHOLE_QUALITY_REQUEST_SPEC', '跨章核对请求规格无效。');
    text(value.crossChapterReview.modelPolicy, 'WHOLE_QUALITY_REQUEST_SPEC', 300);
  }
  if (value.deepReferencePolicyVersion !== undefined) requireThat(value.deepReferencePolicyVersion === DEEP_REFERENCE_INTEGRATION_VERSION,
    'WHOLE_QUALITY_REQUEST_SPEC', '深层参考请求策略版本无效。');
  if (value.writingGoals !== undefined) {
    validateWritingGoals(value.writingGoals, chapters);
    requireThat(value.deepReferencePolicyVersion === DEEP_REFERENCE_INTEGRATION_VERSION, 'WHOLE_QUALITY_REQUEST_SPEC', '写作目标查询必须绑定深层参考策略。');
  }
  const core = { kind: value.kind, revisionMode: value.revisionMode, sourceBaseRevision: value.sourceBaseRevision, objective: value.objective, chapters,
    ...(value.sourceIds !== undefined ? { sourceIds: clone(value.sourceIds) } : {}),
    ...(value.crossChapterReview !== undefined ? { crossChapterReview: clone(value.crossChapterReview) } : {}),
    ...(value.deepReferencePolicyVersion !== undefined ? { deepReferencePolicyVersion: value.deepReferencePolicyVersion } : {}),
    ...(value.writingGoals === undefined ? {} : { writingGoals: clone(value.writingGoals) }) };
  requireThat(manuscriptFingerprint(chapters) === value.sourceManuscriptSha256 && fingerprint(core) === value.inputFingerprint,
    'WHOLE_QUALITY_REQUEST_SPEC', '请求规格与原稿不一致。'); return clone(value);
}

const textFieldContract = (maxLength = LIMITS.text) => ({ type: 'string', minLength: 1, maxLength });
const stringArrayContract = (maxItems, { minItems = 0, itemMaxLength = 2000, uniqueItems = false } = {}) => ({
  type: 'array', minItems, maxItems, uniqueItems, items: textFieldContract(itemMaxLength),
});
const rawEvidenceContract = { type: 'object', additionalProperties: false, required: ['chapterId', 'quote', 'purpose'], optional: ['occurrence'],
  properties: { chapterId: { type: 'string', enumFrom: 'input.chapters[].id' }, quote: textFieldContract(2000), purpose: textFieldContract(2000),
    occurrence: { type: 'integer', minimum: 1, requiredWhen: 'quote occurs more than once verbatim in the selected chapter' } },
  constraints: ['quote must occur verbatim in chapterId', 'omit start; host derives the exact UTF-16 start', 'occurrence must be omitted or 1 when quote is unique'] };
const coverageContract = { type: 'object', additionalProperties: false, required: ['status','omissions'],
  properties: { status: { type: 'string', enum: ['complete','bounded'] }, omissions: stringArrayContract(16) },
  constraints: ['complete requires omissions=[]', 'bounded requires at least one omission'] };
const bindingContract = { type: 'host_binding', constraints: ['copy every responseBindings value exactly', 'copy top-level inputHash exactly', 'do not calculate hashes'] };
const readingContract = { schemaVersion: 'whole-quality-reading-response-contract-2', additionalProperties: false, binding: bindingContract,
  required: ['schemaVersion','inputHash','sourceManuscriptSha256','checkedChapterIds','coverage','synopsis','sceneChanges','issues','strengths','unresolved'],
  scene: ['id','chapterId','sequence','entryEvidence','exitEvidence','beforeState','trigger','action','afterState','cost','narrativeFunction','preservedStrengths'],
  issue: ['id','claimType','area','priority','disposition','observation','readerEffectHypothesis','suspectedCause','sceneIds','evidence','counterEvidence','preservation','expectedEffect','failureCriteria','limitations'], evidence: rawEvidenceContract,
  properties: { schemaVersion: { constFrom: 'responseBindings.schemaVersion' }, inputHash: { constFrom: 'top-level inputHash' },
    sourceManuscriptSha256: { constFrom: 'responseBindings.sourceManuscriptSha256' }, checkedChapterIds: { type: 'array', exactCopyFrom: 'responseBindings.checkedChapterIds' },
    coverage: coverageContract, synopsis: textFieldContract(),
    sceneChanges: { type: 'array', minItems: 1, maxItems: LIMITS.scenes, itemsRef: 'sceneSchema' },
    issues: { type: 'array', minItems: 0, maxItems: LIMITS.issues, itemsRef: 'issueSchema' },
    strengths: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract },
    unresolved: stringArrayContract(LIMITS.issues) },
  sceneSchema: { type: 'object', additionalProperties: false, required: ['id','chapterId','sequence','entryEvidence','exitEvidence','beforeState','trigger','action','afterState','cost','narrativeFunction','preservedStrengths'],
    properties: { id: textFieldContract(200), chapterId: { type: 'string', enumFrom: 'input.chapters[].id' }, sequence: { type: 'integer', minimum: 1 },
      entryEvidence: rawEvidenceContract, exitEvidence: rawEvidenceContract, beforeState: textFieldContract(), trigger: textFieldContract(), action: textFieldContract(),
      afterState: textFieldContract(), cost: textFieldContract(), narrativeFunction: textFieldContract(),
      preservedStrengths: { type: 'array', minItems: 0, maxItems: 4, items: rawEvidenceContract } },
    constraints: ['id is unique', 'chapterId+sequence is unique', 'entryEvidence and exitEvidence use chapterId', 'entry starts no later than exit'] },
  issueSchema: { type: 'object', additionalProperties: false, required: ['id','claimType','area','priority','disposition','observation','readerEffectHypothesis','suspectedCause','sceneIds','evidence','counterEvidence','preservation','expectedEffect','failureCriteria','limitations'],
    properties: { id: textFieldContract(200), claimType: { type: 'string', enum: ['textual_conflict','reader_effect_hypothesis','editorial_preference'] },
      area: { type: 'string', enum: ['emotion_progression','meaningful_repetition','knowledge_continuity','causality','ending_cost','structure','other'] },
      priority: { type: 'string', enum: ['major','secondary','preserve'] }, disposition: { type: 'string', enum: ['investigate','preserve','needs_evidence'] },
      observation: textFieldContract(), readerEffectHypothesis: textFieldContract(), suspectedCause: textFieldContract(),
      sceneIds: { type: 'array', minItems: 1, maxItems: LIMITS.scenes, uniqueItems: true, items: { type: 'string', enumFrom: 'sceneChanges[].id' } },
      evidence: { type: 'array', minItems: 1, maxItems: LIMITS.evidence, items: rawEvidenceContract },
      counterEvidence: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract },
      preservation: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract }, expectedEffect: textFieldContract(),
      failureCriteria: textFieldContract(), limitations: stringArrayContract(12, { minItems: 1 }) },
    conditionalConstraints: [{ if: { priority: 'major', disposition: 'investigate' }, then: ['sceneIds contains at least 2 scenes','evidence contains at least 2 quotes located across at least 2 declared scenes','counterEvidence contains at least 1 quote'] }],
    boundary: 'The two-scene evidence threshold applies only to an issue you choose to label major+investigate. Returning no major issue, or issues=[] when justified by the full reading, is valid; never invent or promote an issue to satisfy a quota.' },
  globalConstraints: ['sceneChanges covers every input chapter with at least one scene','scene IDs and issue IDs are unique','at most 6 issues may be major+investigate'],
  legalEmptyResult: { meaning: 'no safe issue found', shape: { issues: [], strengths: [], unresolved: [] }, stillRequired: ['one or more sceneChanges covering every chapter','coverage','synopsis'] } };
const FACT_READING_VERSION = 'whole-quality-reading-2';
const factReadingContract = { ...readingContract, schemaVersion: 'whole-quality-reading-response-contract-3',
  issueSchema: { ...readingContract.issueSchema,
    conditionalConstraints: [
      { if: { priority: 'major', disposition: 'investigate', claimType: 'textual_conflict' }, then: ['evidence contains at least 2 distinct non-overlapping verbatim positions inside the declared scenes; both may be in one scene', 'the quoted assertions must be mutually incompatible for the same fact, not merely different wording', 'counterEvidence contains at least 1 quote; explain why normal change, different rounds or dialogue uncertainty do not resolve the contradiction'] },
      { if: { priority: 'major', disposition: 'investigate', claimType: ['reader_effect_hypothesis','editorial_preference'] }, then: ['sceneIds contains at least 2 scenes','evidence contains at least 2 quotes located across at least 2 declared scenes','counterEvidence contains at least 1 quote'] },
    ],
    boundary: 'A local textual contradiction can be evidenced within one scene. Cross-scene reader-effect or editorial-pattern claims still require two scenes. Exact quotation checks establish location, not semantic truth. Never invent scenes or promote claims to satisfy a quota.' } };
function readingInput(requestSpec, chapters, version = WHOLE_QUALITY_READING_VERSION) {
  requireThat([WHOLE_QUALITY_READING_VERSION, FACT_READING_VERSION].includes(version), 'WHOLE_QUALITY_READING_VERSION', '阅读证据策略版本无效。');

  const bindings = { schemaVersion: version, sourceManuscriptSha256: requestSpec.sourceManuscriptSha256,
    checkedChapterIds: chapters.map(c => c.id) }; const example = responseExampleEvidence(chapters[0]);
  return { schemaVersion: version === FACT_READING_VERSION ? 'whole-quality-reading-input-2' : 'whole-quality-reading-input-1', requestSpec, chapters, responseBindings: bindings, responseContract: version === FACT_READING_VERSION ? factReadingContract : readingContract,
    responseExample: { ...bindings, inputHash: 'COPY_TOP_LEVEL_INPUT_HASH', coverage: { status: 'complete', omissions: [] }, synopsis: '全文梗概',
      sceneChanges: [{ id: 'scene-1', chapterId: chapters[0].id, sequence: 1, entryEvidence: example, exitEvidence: example,
        beforeState: '结构占位', trigger: '结构占位', action: '结构占位', afterState: '结构占位', cost: '结构占位', narrativeFunction: '结构占位', preservedStrengths: [example] }],
      issues: [], strengths: [example], unresolved: [] }, limits: { maxScenes: LIMITS.scenes, maxIssues: LIMITS.issues, maxMajorIssues: LIMITS.majorIssues } };
}
function validateReading(value, input) {
  const code = 'WHOLE_QUALITY_READING', chapters = input.chapters, chapterIds = chapters.map(c => c.id);
  exact(value, readingContract.required, [], code); requireThat(value.schemaVersion === input.responseBindings.schemaVersion
    && value.inputHash === fingerprint(input) && value.sourceManuscriptSha256 === input.responseBindings.sourceManuscriptSha256, code, '全文阅读绑定无效。');
  sameIds(value.checkedChapterIds, input.responseBindings.checkedChapterIds, code); coverage(value.coverage, code); text(value.synopsis, code);
  requireThat(Array.isArray(value.sceneChanges) && value.sceneChanges.length > 0 && value.sceneChanges.length <= LIMITS.scenes, code, '场景变化数量无效。');
  const sceneIds = new Set(), sceneById = new Map(), sequences = new Map();
  const sceneChanges = value.sceneChanges.map((item, sceneIndex) => {
    exact(item, readingContract.scene, [], code); text(item.id, code, 200); requireThat(!sceneIds.has(item.id), code, '场景 ID 重复。'); sceneIds.add(item.id);
    requireThat(chapterIds.includes(item.chapterId) && Number.isSafeInteger(item.sequence) && item.sequence >= 1, code, '场景章节或序号无效。');
    const sequenceKey = `${item.chapterId}:${item.sequence}`; requireThat(!sequences.has(sequenceKey), code, '章内场景序号重复。'); sequences.set(sequenceKey, true);
    const entryEvidence = evidence(item.entryEvidence, chapters, code, `sceneChanges[${sceneIndex}].entryEvidence`),
      exitEvidence = evidence(item.exitEvidence, chapters, code, `sceneChanges[${sceneIndex}].exitEvidence`);
    requireThat(entryEvidence.chapterId === item.chapterId && exitEvidence.chapterId === item.chapterId && entryEvidence.start <= exitEvidence.start, code, '场景边界无效。');
    ['beforeState','trigger','action','afterState','cost','narrativeFunction'].forEach(key => text(item[key], code));
    const preservedStrengths = evidenceList(item.preservedStrengths, chapters, code, { max: 4, path: `sceneChanges[${sceneIndex}].preservedStrengths` });
    const checked = { ...clone(item), entryEvidence, exitEvidence, preservedStrengths }; sceneById.set(item.id, checked); return checked;
  });
  requireThat(chapterIds.every(id => sceneChanges.some(scene => scene.chapterId === id)), code, '独立阅读须覆盖每章至少一个场景变化。');
  requireThat(Array.isArray(value.issues) && value.issues.length <= LIMITS.issues, code, '问题数量无效。');
  const issueIds = new Set();
  const issues = value.issues.map((item, issueIndex) => {
    exact(item, readingContract.issue, [], code); text(item.id, code, 200); requireThat(!issueIds.has(item.id), code, '问题 ID 重复。'); issueIds.add(item.id);
    requireThat(['textual_conflict','reader_effect_hypothesis','editorial_preference'].includes(item.claimType), code, '主张类型无效。');
    requireThat(['emotion_progression','meaningful_repetition','knowledge_continuity','causality','ending_cost','structure','other'].includes(item.area), code, '问题领域无效。');
    requireThat(['major','secondary','preserve'].includes(item.priority) && ['investigate','preserve','needs_evidence'].includes(item.disposition), code, '优先级或处置无效。');
    ['observation','readerEffectHypothesis','suspectedCause','expectedEffect','failureCriteria'].forEach(key => text(item[key], code));
    requireThat(Array.isArray(item.sceneIds) && item.sceneIds.length > 0 && new Set(item.sceneIds).size === item.sceneIds.length
      && item.sceneIds.every(id => sceneById.has(id)), code, '问题场景引用无效。');
    const investigate = item.priority === 'major' && item.disposition === 'investigate';
    const itemEvidence = evidenceList(item.evidence, chapters, code, { min: investigate ? 2 : 1, path: `issues[${issueIndex}].evidence` });
    const counterEvidence = evidenceList(item.counterEvidence, chapters, code, { min: investigate ? 1 : 0, path: `issues[${issueIndex}].counterEvidence` });
    const preservation = evidenceList(item.preservation, chapters, code, { path: `issues[${issueIndex}].preservation` }); stringList(item.limitations, code, 12, false);
    if (investigate) {
      const containingScenes = itemEvidence.map(e => item.sceneIds.find(id => { const scene = sceneById.get(id);
        return scene.chapterId === e.chapterId && e.start >= scene.entryEvidence.start
          && e.start + e.quote.length <= scene.exitEvidence.start + scene.exitEvidence.quote.length;
      }));
      if (input.responseBindings.schemaVersion === FACT_READING_VERSION && item.claimType === 'textual_conflict') {
        requireThat(containingScenes.every(Boolean), code, '事实矛盾的全部证据须在声明场景内。');
        requireThat(itemEvidence.some((left,index) => itemEvidence.slice(index+1).some(right => !rangesOverlap(left,right))), code, '事实矛盾须有两处不重叠的逐字证据，允许位于同一场景。');
      } else {
        // Keep the legacy containment test byte-for-byte in meaning for saved v1 artifacts.
        const legacyScenes = itemEvidence.map(e => item.sceneIds.find(id => { const scene = sceneById.get(id);
          return scene.chapterId === e.chapterId && e.start >= scene.entryEvidence.start && e.start <= scene.exitEvidence.start + scene.exitEvidence.quote.length;
        }));
        requireThat(new Set(item.sceneIds).size >= 2 && new Set(legacyScenes.filter(Boolean)).size >= 2, code, '主要候选问题须有至少两个场景的原文依据。');
      }
    }
    return { ...clone(item), evidence: itemEvidence, counterEvidence, preservation };
  });
  requireThat(issues.filter(item => item.priority === 'major' && item.disposition === 'investigate').length <= LIMITS.majorIssues, code, '主要问题超过上限。');
  const strengths = evidenceList(value.strengths, chapters, code, { path: 'strengths' }); stringList(value.unresolved, code, LIMITS.issues);
  return { ...clone(value), sceneChanges, issues, strengths };
}

function collectCrossChapterEvidence(value, chapters, path = 'finding', output = [], seen = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectCrossChapterEvidence(item, chapters, `${path}[${index}]`, output, seen));
    return output;
  }
  if (!record(value)) return output;
  if (typeof value.chapterId === 'string' && typeof value.quote === 'string' && Number.isSafeInteger(value.start)) {
    const chapter = chapters.find(item => item.id === value.chapterId), key = `${value.chapterId}:${value.start}:${value.quote.length}`;
    requireThat(chapter && value.start >= 0 && chapter.body.slice(value.start, value.start + value.quote.length) === value.quote,
      'WHOLE_QUALITY_CROSS_CHAPTER', `跨章核对证据未逐字绑定：${path}`);
    if (!seen.has(key)) {
      seen.add(key);
      output.push({ chapterId: value.chapterId, start: value.start, quote: value.quote,
        purpose: typeof value.purpose === 'string' && value.purpose.trim() ? value.purpose : `跨章事实核对证据：${path}` });
    }
  }
  for (const [key, child] of Object.entries(value)) collectCrossChapterEvidence(child, chapters, `${path}.${key}`, output, seen);
  return output;
}
function lineParagraphs(body) {
  return [...body.matchAll(/[^\r\n]+/g)]
    .filter(match => match[0].trim())
    .map(match => ({ start: match.index, end: match.index + match[0].length }));
}
function crossScopeOptions(conflictId, evidenceItems, chapters) {
  const options = [], seen = new Set();
  const add = (chapter, start, end, paragraphCount, evidenceKeys) => {
    const quote = chapter.body.slice(start, end), key = `${chapter.id}:${start}:${end}`;
    if (!quote.trim() || quote.length > 2000 || seen.has(key)) return;
    seen.add(key); options.push({ id: `${conflictId}:scope-${options.length + 1}`, chapterId: chapter.id, start, quote, paragraphCount,
      evidenceKeys: [...new Set(evidenceKeys)] });
  };
  for (const item of evidenceItems) {
    const chapter = chapters.find(value => value.id === item.chapterId), spans = lineParagraphs(chapter.body), evidenceEnd = item.start + item.quote.length;
    const indexes = spans.map((span, index) => ({ span, index })).filter(({ span }) => span.start < evidenceEnd && item.start < span.end).map(({ index }) => index);
    const evidenceKey = `${item.chapterId}:${item.start}:${item.quote.length}`;
    if (!indexes.length) { add(chapter, item.start, evidenceEnd, 1, [evidenceKey]); continue; }
    const first = indexes[0], last = indexes.at(-1);
    if (last - first + 1 <= 2) add(chapter, spans[first].start, spans[last].end, last - first + 1, [evidenceKey]);
    if (first === last && first > 0) add(chapter, spans[first - 1].start, spans[first].end, 2, [evidenceKey]);
    if (first === last && first + 1 < spans.length) add(chapter, spans[first].start, spans[first + 1].end, 2, [evidenceKey]);
    add(chapter, item.start, evidenceEnd, 1, [evidenceKey]);
  }
  return options.slice(0, LIMITS.evidence * 3);
}
function crossFindingClaim(finding, id) {
  for (const key of ['claim','observation','summary','reason','description']) if (typeof finding[key] === 'string' && finding[key].trim()) return finding[key];
  return `跨章核对确认了事实冲突 ${id}。`;
}
function retryAttemptRecords(protocolFailure, review) {
  return [
    { schemaVersion: CROSS_CHAPTER_ATTEMPT_VERSION, attempt: 0, artifactNamespace: 'primary', status: 'protocol_failed',
      protocolFailureSha256: fingerprint(protocolFailure) },
    { schemaVersion: CROSS_CHAPTER_ATTEMPT_VERSION, attempt: 1, artifactNamespace: 'retry-1', status: 'completed',
      reviewSha256: fingerprint(review), stageReceipts: clone(review.stageReceipts) },
  ];
}
function validateCrossProtocolFailure(value, expectedAttempt) {
  const code = 'WHOLE_QUALITY_CROSS_CHAPTER';
  exact(value, ['schemaVersion','attempt','artifactNamespace','code','stage','inputHash','requestSha256','rawResponseSha256',
    'formatRepairInputHash','formatRepairRequestSha256','formatRepairResponseSha256','completedStageReceipts'], ['causeCode'], code);
  requireThat(value.schemaVersion === CROSS_CHAPTER_PROTOCOL_FAILURE_VERSION && value.attempt === expectedAttempt
    && value.artifactNamespace === (expectedAttempt === 0 ? 'primary' : `retry-${expectedAttempt}`)
    && CROSS_CHAPTER_RETRYABLE_FAILURES.has(value.code) && CROSS_CHAPTER_STAGE_ORDER.includes(value.stage), code, '跨章协议失败记录身份无效。');
  for (const key of ['inputHash','requestSha256','rawResponseSha256','formatRepairInputHash','formatRepairRequestSha256','formatRepairResponseSha256'])
    requireThat(hex64.test(value[key]), code, '跨章协议失败哈希无效。');
  requireThat(value.causeCode === undefined || typeof value.causeCode === 'string', code, '跨章协议失败原因无效。');
  requireThat(Array.isArray(value.completedStageReceipts), code, '跨章协议失败的已完成阶段无效。');
  const failedIndex = CROSS_CHAPTER_STAGE_ORDER.indexOf(value.stage);
  requireThat(value.completedStageReceipts.length === failedIndex, code, '跨章协议失败前的阶段数量无效。');
  value.completedStageReceipts.forEach((receipt,index) => {
    exact(receipt, ['stage','primaryResponseSha256'], ['formatRepairResponseSha256'], code);
    requireThat(receipt.stage === CROSS_CHAPTER_STAGE_ORDER[index] && hex64.test(receipt.primaryResponseSha256)
      && (receipt.formatRepairResponseSha256 === undefined || hex64.test(receipt.formatRepairResponseSha256)), code, '跨章协议失败前的阶段回执无效。');
  });
  return clone(value);
}
function validateCrossRetryMetadata(protocolFailures, attempts, review) {
  const code = 'WHOLE_QUALITY_CROSS_CHAPTER';
  requireThat(Array.isArray(protocolFailures) && protocolFailures.length === 1, code, '跨章协议重试必须只保留一次原失败。');
  const failure = validateCrossProtocolFailure(protocolFailures[0], 0);
  requireThat(Array.isArray(attempts) && attempts.length === 2, code, '跨章协议尝试记录数量无效。');
  exact(attempts[0], ['schemaVersion','attempt','artifactNamespace','status','protocolFailureSha256'], [], code);
  requireThat(attempts[0].schemaVersion === CROSS_CHAPTER_ATTEMPT_VERSION && attempts[0].attempt === 0
    && attempts[0].artifactNamespace === 'primary' && attempts[0].status === 'protocol_failed'
    && attempts[0].protocolFailureSha256 === fingerprint(failure), code, '跨章原失败尝试记录无效。');
  exact(attempts[1], ['schemaVersion','attempt','artifactNamespace','status','reviewSha256','stageReceipts'], [], code);
  requireThat(attempts[1].schemaVersion === CROSS_CHAPTER_ATTEMPT_VERSION && attempts[1].attempt === 1
    && attempts[1].artifactNamespace === 'retry-1' && attempts[1].status === 'completed'
    && attempts[1].reviewSha256 === fingerprint(review) && isDeepStrictEqual(attempts[1].stageReceipts, review.stageReceipts), code, '跨章成功重试记录无效。');
  return { protocolFailures: [failure], attempts: clone(attempts) };
}
function normalizeCrossChapterReview(review, chapters, retryEvidence) {
  const code = 'WHOLE_QUALITY_CROSS_CHAPTER';
  requireThat(record(review) && review.schemaVersion === 'cross-chapter-review-result-1' && Array.isArray(review.findings), code, '跨章核对结果版本无效。');
  requireThat(Array.isArray(review.stageReceipts) && review.stageReceipts.length === 2, code, '跨章核对必须保留抽取与裁定两阶段回执。');
  review.stageReceipts.forEach(receipt => requireThat(record(receipt) && typeof receipt.stage === 'string' && hex64.test(receipt.primaryResponseSha256)
    && (receipt.formatRepairResponseSha256 === undefined || hex64.test(receipt.formatRepairResponseSha256)), code, '跨章核对阶段回执无效。'));
  const allowed = new Set(['confirmed_conflict','ambiguous','resolved']), ids = new Set();
  const findings = review.findings.map((finding, index) => {
    requireThat(record(finding) && allowed.has(finding.status), code, '跨章核对 finding 状态无效。');
    const findingId = typeof finding.id === 'string' && finding.id.trim() ? finding.id
      : typeof finding.groupId === 'string' && finding.groupId.trim() ? finding.groupId : `finding-${index + 1}`;
    requireThat(!ids.has(findingId), code, '跨章核对 finding ID 重复。'); ids.add(findingId);
    return { finding, findingId };
  });
  const confirmedConflicts = findings.filter(item => item.finding.status === 'confirmed_conflict').map(({ finding, findingId }) => {
    const evidenceItems = collectCrossChapterEvidence(finding, chapters);
    if (evidenceItems.length < 2 && Array.isArray(review.comparisons)) {
      const refs = new Set([finding.comparisonId, ...(Array.isArray(finding.comparisonIds) ? finding.comparisonIds : []),
        ...(Array.isArray(finding.candidateIds) ? finding.candidateIds : [])].filter(value => typeof value === 'string'));
      const related = review.comparisons.filter(item => refs.has(item?.id) || item?.findingId === findingId
        || (Array.isArray(item?.findingIds) && item.findingIds.includes(findingId)));
      related.forEach((item, index) => collectCrossChapterEvidence(item, chapters, `comparisons[${index}]`, evidenceItems,
        new Set(evidenceItems.map(value => `${value.chapterId}:${value.start}:${value.quote.length}`))));
    }
    requireThat(evidenceItems.length >= 2, code, 'confirmed_conflict 必须带有至少两侧逐字证据。');
    const id = `cross-chapter:${findingId}`, scopeOptions = crossScopeOptions(id, evidenceItems, chapters);
    requireThat(scopeOptions.length > 0, code, 'confirmed_conflict 没有可绑定的最小连续修订范围。');
    return { id, findingId, claim: crossFindingClaim(finding, findingId), evidence: evidenceItems, scopeOptions,
      limitations: Array.isArray(finding.limitations) ? finding.limitations.filter(value => typeof value === 'string' && value.trim()).slice(0, 12) : [] };
  });
  const bundle = { schemaVersion: WHOLE_QUALITY_CROSS_CHAPTER_BUNDLE_VERSION, sourceManuscriptSha256: manuscriptFingerprint(chapters),
    review: clone(review), confirmedConflicts };
  if (retryEvidence !== undefined) {
    const protocolFailure = validateCrossProtocolFailure(retryEvidence, 0), attempts = retryAttemptRecords(protocolFailure, review);
    return { ...bundle, protocolFailures: [protocolFailure], attempts };
  }
  return bundle;
}
function validateCrossChapterBundle(value, chapters) {
  const code = 'WHOLE_QUALITY_CROSS_CHAPTER';
  exact(value, ['schemaVersion','sourceManuscriptSha256','review','confirmedConflicts'], ['protocolFailures','attempts'], code);
  requireThat(value.schemaVersion === WHOLE_QUALITY_CROSS_CHAPTER_BUNDLE_VERSION && value.sourceManuscriptSha256 === manuscriptFingerprint(chapters), code, '跨章核对包与原稿不一致。');
  const rebuilt = normalizeCrossChapterReview(value.review, chapters);
  requireThat(isDeepStrictEqual({ schemaVersion:value.schemaVersion, sourceManuscriptSha256:value.sourceManuscriptSha256,
    review:value.review, confirmedConflicts:value.confirmedConflicts }, rebuilt), code, '跨章核对冻结目标不能由原始核对结果重建。');
  const hasFailures = value.protocolFailures !== undefined, hasAttempts = value.attempts !== undefined;
  requireThat(hasFailures === hasAttempts, code, '跨章协议失败与尝试记录必须同时存在。');
  if (hasFailures) validateCrossRetryMetadata(value.protocolFailures,value.attempts,value.review);
  return clone(value);
}
function crossConflictGoals(bundle, reading) {
  if (!bundle) return [];
  return bundle.confirmedConflicts.map(conflict => {
    const chapterIds = new Set(conflict.evidence.map(item => item.chapterId));
    const sceneIds = reading.sceneChanges.filter(scene => chapterIds.has(scene.chapterId)).map(scene => scene.id);
    requireThat(sceneIds.length > 0, 'WHOLE_QUALITY_CROSS_CHAPTER', '跨章冲突证据没有对应的全文阅读场景。');
    return { id: conflict.id, source: 'cross_chapter_confirmed', hardIssue: true, claimType: 'textual_conflict',
      requiredDisposition: 'revise_or_unresolved', priority: 'major', disposition: 'investigate', area: 'knowledge_continuity',
      observation: conflict.claim, sceneIds, evidence: clone(conflict.evidence), preservation: [],
      limitations: conflict.limitations.length ? clone(conflict.limitations) : ['跨章事实核对只确认文本冲突，不预设唯一改法。'], scopeOptions: clone(conflict.scopeOptions) };
  });
}

function retrievalIssue(issue, requestSpec) {
  if (issue.writingGoal) return writingGoalQuerySubject(issue.writingGoal, requestSpec.sourceIds);
  const sceneQueries = [...new Set([issue.area.replaceAll('_', ' '), issue.observation.slice(0, 120)].map(v => v.trim()).filter(Boolean))].slice(0, 3);
  return { issueId: issue.id, question: issue.observation, storyProblem: issue.suspectedCause, expectedEffect: issue.expectedEffect,
    failureCriterion: issue.failureCriteria, counterConsideration: issue.counterEvidence.map(e => e.purpose).join('；').slice(0, 2000)
      || '反证可能说明原稿的克制与留白更有效；若修改损伤它们，应保留原稿。', sceneQueries,
    ...(requestSpec.sourceIds === undefined ? {} : { sourceIds: clone(requestSpec.sourceIds) }) };
}
function issueQuery(issue, requestSpec) { return buildWholeQualityQuery(retrievalIssue(issue, requestSpec)); }
function checkedRetrievalResult(value, issue, requestSpec) {
  const code = 'WHOLE_QUALITY_RETRIEVAL', baseQuery = issueQuery(issue, requestSpec);
  const query = value?.observationRecall === undefined ? baseQuery : addWholeQualityObservationRecall(baseQuery, value.observationRecall);
  requireThat(record(value) && value.schemaVersion === 'whole-quality-retrieval-1' && value.issueId === issue.id
    && isDeepStrictEqual(value.query, query), code, 'DATA 检索结果绑定无效。');
  const packet = validateWholeQualityRetrievalPacket(value.packet, query);
  if (issue.writingGoal) assertGoalDeepReferencePacket(packet, issue.writingGoal.problem, WRITING_GOAL_DATA_OPTIONS);
  const evidenceBundle = assertWholeQualityEvidenceBundle(value.evidenceBundle, packet, issue.id);
  return { schemaVersion: value.schemaVersion, issueId: value.issueId, query: clone(query), packet, evidenceBundle,
    ...(value.observationRecall === undefined ? {} : { observationRecall: clone(value.observationRecall) }) };
}
function validateRetrievalBundle(value, reading, requestSpec) {
  const code = 'WHOLE_QUALITY_RETRIEVAL', goals = writingGoalSubjects(requestSpec);
  exact(value, ['schemaVersion','byIssue','supplies','callbackCalls', ...(goals.length ? ['byGoal'] : [])], [], code);
  requireThat(value.schemaVersion === (goals.length ? 'whole-quality-retrieval-bundle-2' : 'whole-quality-retrieval-bundle-1'), code, '检索包版本无效。');
  const diagnosticIssues = reading.issues.filter(item => item.priority === 'major' && item.disposition === 'investigate');
  const issues = [...diagnosticIssues, ...goals];
  requireThat(Array.isArray(value.byIssue) && value.byIssue.length === diagnosticIssues.length
    && (!goals.length || Array.isArray(value.byGoal) && value.byGoal.length === goals.length), code, '检索问题或写作目标覆盖不完整。');
  const supplies = [], seenSupply = new Set(); let calls = 0;
  const entries = wholeQualityRetrievalEntries(value).map((item, index) => {
    const issue = issues[index];
    validateRetrievalItem(item, issue, requestSpec);
    requireThat(item.issueId === issue.id && isDeepStrictEqual(item.query, issueQuery(issue, requestSpec)) && item.queryHash === fingerprint(item.query), code, '检索问题绑定无效。');
    requireThat(['matched','uncovered','unavailable','not_connected'].includes(item.status) && typeof item.callbackInvoked === 'boolean', code, '检索状态无效。');
    if (item.callbackInvoked) calls++;
    if (record(item.result)) {
      requireThat(item.callbackInvoked, code, '检索响应须来自真实回调。'); const checked = checkedRetrievalResult(item.result, issue, requestSpec);
      requireThat(checked.packet.status === item.status, code, '检索响应状态不一致。');
      for (const material of checked.evidenceBundle.materials) {
        const supplyId = `${issue.id}:${material.materialId}`; requireThat(!seenSupply.has(supplyId), code, '供应身份重复。'); seenSupply.add(supplyId);
        supplies.push({ supplyId, issueId: issue.id, materialId: material.materialId, evidenceIds: material.evidence.map(e => e.evidenceId),
          contentSha256: material.contentSha256, reviewBoundary: material.reviewBoundary,
          ...(issue.writingGoal ? { goalId: issue.writingGoal.id, origin: 'writing_goal' } : {}) });
      }
      return { ...clone(item), result: checked };
    }
    requireThat(item.result === null && item.status === (item.callbackInvoked ? 'unavailable' : 'not_connected'), code, '缺失检索状态不一致。');
    stringList(item.limits, code, 4, false); return clone(item);
  });
  requireThat(value.callbackCalls === calls && isDeepStrictEqual(value.supplies, supplies), code, '检索调用或供应派生不一致。');
  return { ...clone(value), byIssue: entries.slice(0, diagnosticIssues.length), supplies,
    ...(goals.length ? { byGoal: entries.slice(diagnosticIssues.length) } : {}) };
}

const legacyPlanContract = { schemaVersion: 'whole-quality-plan-response-contract-2', additionalProperties: false, binding: bindingContract,
  required: ['schemaVersion','inputHash','sourceManuscriptSha256','readingSha256','retrievalSha256','decision','summary','items','materialDecisions','unresolved'],
  item: ['id','issueIds','decision','scope','affectedChapterIds','sceneIds','targets','actionRequirements','action','rationale','expectedEffect','failureCriteria','risks','preserve','adoptedSupplyIds','independentAdoption'],
  target: ['id','sceneId','chapterId','quote','purpose'], requirement: ['id','description','targetIds','expectedVisibleChange','failureCriterion'], evidence: rawEvidenceContract,
  properties: { schemaVersion: { constFrom: 'responseBindings.schemaVersion' }, inputHash: { constFrom: 'top-level inputHash' },
    sourceManuscriptSha256: { constFrom: 'responseBindings.sourceManuscriptSha256' }, readingSha256: { constFrom: 'responseBindings.readingSha256' },
    retrievalSha256: { constFrom: 'responseBindings.retrievalSha256' }, decision: { type: 'string', enum: ['revise','preserve_original'] },
    summary: textFieldContract(), items: { type: 'array', minItems: 0, maxItems: LIMITS.planItems, itemsRef: 'itemSchema' },
    materialDecisions: { type: 'array', exactItemCountFrom: 'input.retrieval.supplies.length', itemsRef: 'materialDecisionSchema' },
    unresolved: { type: 'array', minItems: 0, maxItems: LIMITS.issues, items: { type: 'object', additionalProperties: false,
      required: ['issueId','reason'], properties: { issueId: { type: 'string', enumFrom: 'input.reading.issues[].id' }, reason: textFieldContract() } } } },
  itemSchema: { type: 'object', additionalProperties: false, required: ['id','issueIds','decision','scope','affectedChapterIds','sceneIds','targets','actionRequirements','action','rationale','expectedEffect','failureCriteria','risks','preserve','adoptedSupplyIds','independentAdoption'],
    properties: { id: textFieldContract(200), issueIds: { type: 'array', minItems: 1, maxItems: LIMITS.issues, uniqueItems: true, items: { type: 'string', enumFrom: 'input.reading.issues[].id' } },
      decision: { type: 'string', enum: ['revise','preserve'] }, scope: { type: 'string', const: 'linked_scenes' },
      affectedChapterIds: { type: 'array', minItems: 0, maxItems: LIMITS.chapters, uniqueItems: true, items: { type: 'string', enumFrom: 'input.chapters[].id' } },
      sceneIds: { type: 'array', minItems: 0, maxItems: LIMITS.scenes, uniqueItems: true, items: { type: 'string', enumFrom: 'input.reading.sceneChanges[].id' } },
      targets: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, itemsRef: 'targetSchema' },
      actionRequirements: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, itemsRef: 'requirementSchema' },
      action: textFieldContract(), rationale: textFieldContract(), expectedEffect: textFieldContract(), failureCriteria: textFieldContract(),
      risks: stringArrayContract(12, { minItems: 1 }), preserve: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract },
      adoptedSupplyIds: { type: 'array', minItems: 0, maxItemsFrom: 'input.retrieval.supplies.length', uniqueItems: true, items: { type: 'string', enumFrom: 'input.retrieval.supplies[].supplyId' } },
      independentAdoption: textFieldContract() },
    conditionalConstraints: [{ if: { decision: 'revise' }, then: ['issueIds refer only to major+investigate issues','sceneIds has at least 1 item','affectedChapterIds has at least 1 item','targets has at least 1 item','actionRequirements has at least 1 item','preserve has at least 1 item','every declared scene and affected chapter has a target','every target is referenced by an actionRequirement'] }],
    constraints: ['item id is unique','the same major issue cannot be split across revise items','mutually dependent targets belong to this one atomic item','independentAdoption explains why this group stands without other items'] },
  targetSchema: { type: 'object', additionalProperties: false, required: ['id','sceneId','chapterId','quote','purpose'], optional: ['occurrence'],
    properties: { id: textFieldContract(200), sceneId: { type: 'string', enumFrom: 'current item.sceneIds' }, chapterId: { type: 'string', enumFrom: 'input.chapters[].id' },
      quote: textFieldContract(2000), purpose: textFieldContract(2000), occurrence: { type: 'integer', minimum: 1, requiredWhen: 'quote repeats in chapter' } },
    constraints: ['omit start; host derives UTF-16 start','quote occurs verbatim inside the declared scene','target must not overlap reading preservation evidence or item preserve evidence','target id is globally unique'] },
  requirementSchema: { type: 'object', additionalProperties: false, required: ['id','description','targetIds','expectedVisibleChange','failureCriterion'],
    properties: { id: textFieldContract(200), description: textFieldContract(), targetIds: { type: 'array', minItems: 1, maxItems: LIMITS.evidence, uniqueItems: true, items: { type: 'string', enumFrom: 'current item.targets[].id' } },
      expectedVisibleChange: textFieldContract(), failureCriterion: textFieldContract() }, constraints: ['requirement id is globally unique'] },
  materialDecisionSchema: { type: 'object', additionalProperties: false, required: ['supplyId','materialId','issueId','decision','planItemIds','evidenceIds','reason','applicabilityBoundary','limitations'], optional: ['appliedAs'],
    properties: { supplyId: { type: 'string', enumFrom: 'input.retrieval.supplies[].supplyId' }, materialId: { type: 'string', exactFrom: 'matching supply.materialId' },
      issueId: { type: 'string', exactFrom: 'matching supply.issueId' }, decision: { type: 'string', enum: ['used','not_used'] },
      planItemIds: { type: 'array', minItems: 0, maxItems: LIMITS.planItems, uniqueItems: true, items: { type: 'string', enumFrom: 'items[].id' } },
      evidenceIds: { type: 'array', minItems: 0, maxItemsFrom: 'matching supply.evidenceIds.length', uniqueItems: true, items: { type: 'string', enumFrom: 'matching supply.evidenceIds' } },
      reason: textFieldContract(), appliedAs: textFieldContract(), applicabilityBoundary: textFieldContract(), limitations: stringArrayContract(8, { minItems: 1 }) },
    conditionalConstraints: [{ if: { decision: 'used' }, then: ['planItemIds has at least 1 item','evidenceIds has at least 1 item','appliedAs is required'] },
      { if: { decision: 'not_used' }, then: ['planItemIds=[]','evidenceIds=[]','appliedAs must be omitted'] }] },
  globalConstraints: ['decision=revise requires at least one revise item','decision=preserve_original permits items=[] and forbids revise items','every major+investigate issue is covered by an item or unresolved','every supplied material has exactly one materialDecision','each item.adoptedSupplyIds exactly matches used decisions naming that item'],
  legalEmptyResult: { meaning: 'preserve original and no supplies', shape: { decision: 'preserve_original', items: [], materialDecisions: [], unresolved: [] }, note: 'If major issues exist, list each in unresolved or a preserve item; if supplies exist, materialDecisions cannot be empty.' } };
const planContract = clone(legacyPlanContract);
planContract.schemaVersion = 'whole-quality-plan-response-contract-3';
planContract.optional = ['origin'];
planContract.properties.origin = { type: 'string', enum: ['model'], guidance: 'A model-dispatched plan may set model or omit this compatibility field; host plans are never model output.' };
planContract.inputBoundary = { eligibleIssueIds: { type: 'array', exactValueFrom: 'reading issues where priority=major and disposition=investigate',
  meaning: 'Only these issue IDs may appear in a revise item. An empty list is a host terminal preserve condition; the plan model is not called.' } };
planContract.itemSchema.properties.issueIds.items.enumFrom = 'input.eligibleIssueIds for revise items; input.reading.issues[].id for preserve items';
planContract.globalConstraints = [...planContract.globalConstraints,
  'revise item issueIds must be drawn only from input.eligibleIssueIds; secondary, preserve, and needs_evidence issues cannot be promoted by planning'];
const crossPlanContract = clone(planContract);
crossPlanContract.globalConstraints = [...crossPlanContract.globalConstraints,
  'every input.confirmedConflicts item must be covered by a revise item or input-bound unresolved entry; confirmed conflicts cannot be silently preserved'];
crossPlanContract.inputBoundary.confirmedConflicts = { type: 'array', exactValueFrom: 'host-normalized confirmed_conflict findings',
  meaning: 'These are frozen factual repair goals. Targets for them must exactly match a supplied scopeOptions span; one- or two-paragraph options allow a necessary adjacent question/answer pair.' };
function activePlanContractFor(input) {
  const base=input.confirmedConflicts===undefined?planContract:crossPlanContract;
  if(!input.writingGoals)return base;
  const contract=clone(base);contract.schemaVersion='whole-quality-goal-plan-response-contract-1';
  contract.required.push('goalDispositions');contract.item.push('goalIds');contract.itemSchema.required.push('goalIds');
  contract.itemSchema.properties.issueIds.minItems=0;
  contract.itemSchema.properties.goalIds={type:'array',uniqueItems:true,minItems:0,maxItems:3,items:{type:'string',enumFrom:'input.eligibleGoalIds'}};
  contract.materialDecisionSchema.optional.push('goalId');
  contract.materialDecisionSchema.properties.goalId={type:'string',exactFrom:'matching supply.goalId; required only for writing_goal supplies'};
  contract.properties.goalDispositions={type:'array',exactItemCountFrom:'input.writingGoals.goals.length',items:{type:'object',additionalProperties:false,
    required:['goalId','decision','planItemIds','reason'],properties:{goalId:{type:'string',enumFrom:'input.eligibleGoalIds'},decision:{type:'string',enum:['attempt','preserve']},
      planItemIds:{type:'array',uniqueItems:true,items:{type:'string',enumFrom:'items[].id'}},reason:textFieldContract()}}};
  contract.inputBoundary.eligibleIssueIds.meaning='Only these diagnosed issue IDs may enter revise items. Zero issues does not disable planning when explicit writing goals exist.';
  contract.inputBoundary.writingGoals={meaning:'Explicit user aims, never diagnosed defects. Each item needs at least one valid issueId OR goalId. Preserve all goals with reasons if no safe useful change exists.'};
  contract.globalConstraints.push('goalDispositions exactly covers eligibleGoalIds in order; attempt lists precisely the revise items with that goalId; preserve lists no revise items',
    'goals cannot be invented, silently omitted, split across revise groups, or used to promote noneligible diagnosed issues',
    'goal-linked targets must stay in the goal chapterIds scope (empty means the full work); preservation boundaries and existing literal protections still apply',
    'used writing_goal supplies must name that goalId and only revise plan items containing it; no suitable material and zero adoption are valid');
  return contract;
}
function eligibleIssueIds(reading, confirmedConflicts = []) {
  return [...reading.issues.filter(i => i.priority === 'major' && i.disposition === 'investigate').map(i => i.id), ...confirmedConflicts.map(item => item.id)];
}
function legacyPlanInput(requestSpec, chapters, reading, retrieval) {
  const bindings = { schemaVersion: WHOLE_QUALITY_PLAN_VERSION, sourceManuscriptSha256: requestSpec.sourceManuscriptSha256,
    readingSha256: fingerprint(reading), retrievalSha256: fingerprint(retrieval) };
  return { schemaVersion: 'whole-quality-plan-input-1', requestSpec, chapters, reading, retrieval, responseBindings: bindings,
    responseContract: legacyPlanContract, responseExample: { ...bindings, inputHash: 'COPY_TOP_LEVEL_INPUT_HASH', decision: 'preserve_original',
      summary: '没有安全的场景联动修改，保留原稿。', items: [], materialDecisions: retrieval.supplies.map(s => ({ supplyId: s.supplyId,
        materialId: s.materialId, issueId: s.issueId, decision: 'not_used', planItemIds: [], evidenceIds: [], reason: '结构占位',
        applicabilityBoundary: '结构占位', limitations: ['结构占位'] })), unresolved: [] },
    limits: { maxPlanItems: LIMITS.planItems, linkedSceneMinimum: 1, maxTargetsPerItem: LIMITS.evidence,
      boundary: '按问题需要使用一个或多个场景；跨场景影响必须全部列出，不得为满足数量而添加修改。' } };
}
function planInput(requestSpec, chapters, reading, retrieval, applicability, crossChapterBundle) {
  const writingGoals=requestSpec.writingGoals;
  const bindings = { schemaVersion: writingGoals?'whole-quality-goal-plan-1':WHOLE_QUALITY_PLAN_VERSION, sourceManuscriptSha256: requestSpec.sourceManuscriptSha256,
    readingSha256: fingerprint(reading), retrievalSha256: fingerprint(retrieval) };
  const confirmedConflicts = crossConflictGoals(crossChapterBundle, reading);
  return { schemaVersion: writingGoals?'whole-quality-plan-input-3':'whole-quality-plan-input-2', requestSpec, chapters, reading, retrieval,
    ...(applicability === undefined ? {} : { applicability: clone(applicability) }),
    ...(crossChapterBundle === undefined ? {} : { confirmedConflicts }), eligibleIssueIds: eligibleIssueIds(reading, confirmedConflicts), responseBindings: bindings,
    ...(writingGoals?{writingGoals:clone(writingGoals),eligibleGoalIds:writingGoals.goals.map(goal=>goal.id)}:{}),
    responseContract: activePlanContractFor({writingGoals,confirmedConflicts:crossChapterBundle===undefined?undefined:confirmedConflicts}), responseExample: { ...bindings, inputHash: 'COPY_TOP_LEVEL_INPUT_HASH', decision: 'preserve_original',
      summary: '没有安全的场景联动修改，保留原稿。', items: [], materialDecisions: retrieval.supplies.map(s => ({ supplyId: s.supplyId,
        materialId: s.materialId, issueId: s.issueId, ...(s.goalId?{goalId:s.goalId}:{}),decision: 'not_used', planItemIds: [], evidenceIds: [], reason: '结构占位',
        applicabilityBoundary: '结构占位', limitations: ['结构占位'] })), unresolved: [],
      ...(writingGoals?{goalDispositions:writingGoals.goals.map(goal=>({goalId:goal.id,decision:'preserve',planItemIds:[],reason:'结构占位；保留目标和原稿，不强制改写或采用。'}))}:{}) },
    limits: { maxPlanItems: LIMITS.planItems, linkedSceneMinimum: 1, maxTargetsPerItem: LIMITS.evidence,
      boundary: '按问题需要使用一个或多个场景；跨场景影响必须全部列出，不得为满足数量而添加修改。' } };
}
function validatePlan(value, input) {
  const code = 'WHOLE_QUALITY_PLAN', chapters = input.chapters, reading = input.reading, sceneById = new Map(reading.sceneChanges.map(s => [s.id, s]));
  const activePlanContract = activePlanContractFor(input), goals=input.writingGoals?.goals??[],goalById=new Map(goals.map(goal=>[goal.id,goal])),revisedGoalIds=new Set();
  if(goals.length)sameIds(input.eligibleGoalIds,goals.map(goal=>goal.id),code,'冻结写作目标身份不一致。');
  const confirmedConflicts = input.confirmedConflicts ?? [], crossById = new Map(confirmedConflicts.map(item => [item.id, item]));
  const derivedEligibleIssueIds = eligibleIssueIds(reading, confirmedConflicts), frozenEligibleIssueIds = input.eligibleIssueIds ?? derivedEligibleIssueIds;
  sameIds(frozenEligibleIssueIds, derivedEligibleIssueIds, code, '可修问题冻结列表与独立阅读不一致。');
  exact(value, activePlanContract.required, input.eligibleIssueIds === undefined ? [] : ['origin'], code); requireThat(value.schemaVersion === input.responseBindings.schemaVersion
    && value.inputHash === fingerprint(input) && value.sourceManuscriptSha256 === input.responseBindings.sourceManuscriptSha256
    && value.readingSha256 === input.responseBindings.readingSha256 && value.retrievalSha256 === input.responseBindings.retrievalSha256, code, '方案绑定无效。');
  if (value.origin !== undefined) requireThat(['model','host_no_eligible_issues'].includes(value.origin), code, '方案来源无效。');
  requireThat(['revise','preserve_original'].includes(value.decision), code, '方案决定无效。'); text(value.summary, code);
  requireThat(Array.isArray(value.items) && value.items.length <= LIMITS.planItems, code, '方案项数量无效。');
  const majorIssues = [...reading.issues.filter(i => i.priority === 'major' && i.disposition === 'investigate'), ...confirmedConflicts];
  const issueById = new Map([...reading.issues, ...confirmedConflicts].map(i => [i.id, i]));
  const protections = reading.issues.flatMap(i => [...i.preservation, ...(i.disposition === 'preserve' ? i.evidence : [])]);
  const itemIds = new Set(), targetIds = new Set(), requirementIds = new Set(), revisedIssueIds = new Set();
  const items = value.items.map((item, itemIndex) => {
    exact(item, activePlanContract.item, [], code); text(item.id, code, 200); requireThat(!itemIds.has(item.id), code, '方案 ID 重复。'); itemIds.add(item.id);
    requireThat(['revise','preserve'].includes(item.decision) && item.scope === 'linked_scenes', code, '方案决定或范围无效。');
    if(goals.length)requireThat(Array.isArray(item.goalIds)&&new Set(item.goalIds).size===item.goalIds.length&&item.goalIds.every(id=>goalById.has(id)),code,'方案引用未知或重复写作目标。');
    requireThat(Array.isArray(item.issueIds) && (item.issueIds.length > 0 || item.goalIds?.length > 0) && new Set(item.issueIds).size === item.issueIds.length
      && item.issueIds.every(id => issueById.has(id)), code, '方案问题引用无效。');
    if (item.decision === 'revise') {
      requireThat(item.issueIds.every(id => frozenEligibleIssueIds.includes(id)), code, '修改只能处理冻结的主要候选问题。');
      requireThat(item.issueIds.every(id => !revisedIssueIds.has(id)), code, '同一主要问题的相互依赖目标不能拆到多个原子采纳组。');
      item.issueIds.forEach(id => revisedIssueIds.add(id));
      for(const id of item.goalIds??[]){requireThat(!revisedGoalIds.has(id),code,'同一目标不能拆到多个原子修改组。');revisedGoalIds.add(id);}
    } else requireThat(item.issueIds.every(id => !crossById.has(id)), code, 'confirmed_conflict 不能以 preserve 项静默结案。');
    requireThat(Array.isArray(item.sceneIds) && new Set(item.sceneIds).size === item.sceneIds.length && item.sceneIds.every(id => sceneById.has(id))
      && (item.decision !== 'revise' || item.sceneIds.length >= 1), code, '修改方案必须列出实际需要处理的一个或多个场景。');
    requireThat(Array.isArray(item.affectedChapterIds) && new Set(item.affectedChapterIds).size === item.affectedChapterIds.length
      && item.affectedChapterIds.every(id => chapters.some(c => c.id === id)), code, '受影响章节无效。');
    requireThat(Array.isArray(item.targets) && item.targets.length <= LIMITS.evidence && (item.decision !== 'revise' || item.targets.length >= 1), code, '方案 target 数量无效。');
    const targets = item.targets.map((target, targetIndex) => {
      requireThat(record(target), code, 'target 格式无效。'); exact(target, ['id','sceneId','chapterId','quote','purpose'], ['occurrence','start'], code);
      text(target.id, code, 200); requireThat(!targetIds.has(target.id), code, 'target ID 重复。'); targetIds.add(target.id);
      requireThat(item.sceneIds.includes(target.sceneId), code, 'target 场景不属于方案。');
      const checked = { id: target.id, sceneId: target.sceneId, ...evidence(Object.fromEntries(Object.entries(target).filter(([k]) => !['id','sceneId'].includes(k))), chapters, code, `items[${itemIndex}].targets[${targetIndex}]`) };
      const scene = sceneById.get(target.sceneId), matchingCrossScopes = item.issueIds.filter(id => crossById.has(id)).flatMap(id => crossById.get(id).scopeOptions)
        .filter(scope => scope.chapterId === checked.chapterId && scope.start === checked.start && scope.quote === checked.quote);
      requireThat((scene.chapterId === checked.chapterId && checked.start >= scene.entryEvidence.start
        && checked.start <= scene.exitEvidence.start + scene.exitEvidence.quote.length) || matchingCrossScopes.length > 0, code, 'target 不在声明场景或冻结跨章范围内。');
      requireThat(protections.every(p => !rangesOverlap(p, checked)), code, 'target 侵入独立阅读保护范围。'); return checked;
    });
    if (item.decision === 'revise') {
      for(const id of item.goalIds??[]){const scope=goalById.get(id).chapterIds;requireThat(!scope.length||targets.every(target=>scope.includes(target.chapterId)),code,'写作目标修改超出冻结章范围。');}
      requireThat(item.sceneIds.every(id => targets.some(t => t.sceneId === id)), code, '每个联动场景都须有 target。');
      requireThat(item.affectedChapterIds.length > 0 && item.affectedChapterIds.every(id => targets.some(t => t.chapterId === id)), code, '每个受影响章都须有 target。');
      for (const conflictId of item.issueIds.filter(id => crossById.has(id))) requireThat(targets.some(target => crossById.get(conflictId).scopeOptions
        .some(scope => scope.chapterId === target.chapterId && scope.start === target.start && scope.quote === target.quote)), code, 'confirmed_conflict 缺少冻结连续段落 target。');
    }
    requireThat(Array.isArray(item.actionRequirements) && (item.decision !== 'revise' || item.actionRequirements.length >= 1)
      && item.actionRequirements.length <= LIMITS.evidence, code, '可见行动要求数量无效。');
    const actionRequirements = item.actionRequirements.map(req => {
      exact(req, planContract.requirement, [], code); text(req.id, code, 200); requireThat(!requirementIds.has(req.id), code, '行动要求 ID 重复。'); requirementIds.add(req.id);
      ['description','expectedVisibleChange','failureCriterion'].forEach(k => text(req[k], code));
      requireThat(Array.isArray(req.targetIds) && req.targetIds.length > 0 && new Set(req.targetIds).size === req.targetIds.length
        && req.targetIds.every(id => targets.some(t => t.id === id)), code, '行动要求 target 引用无效。'); return clone(req);
    });
    if (item.decision === 'revise') requireThat(targets.every(t => actionRequirements.some(r => r.targetIds.includes(t.id))), code, '每个 target 都须承担明确行动要求。');
    ['action','rationale','expectedEffect','failureCriteria','independentAdoption'].forEach(k => text(item[k], code)); stringList(item.risks, code, 12, false);
    const preserve = evidenceList(item.preserve, chapters, code, { min: item.decision === 'revise' ? 1 : 0, path: `items[${itemIndex}].preserve` });
    for (const target of targets) requireThat(preserve.every(p => !rangesOverlap(p, target)), code, 'target 侵入方案保护范围。');
    requireThat(Array.isArray(item.adoptedSupplyIds) && new Set(item.adoptedSupplyIds).size === item.adoptedSupplyIds.length, code, '采用供应 ID 重复。');
    return { ...clone(item), targets, actionRequirements, preserve };
  });
  requireThat(value.decision === 'revise' ? items.some(i => i.decision === 'revise') : items.every(i => i.decision === 'preserve'), code, '总决定与方案项不一致。');
  if (value.origin === 'host_no_eligible_issues') requireThat(frozenEligibleIssueIds.length === 0 && goals.length === 0 && value.decision === 'preserve_original', code, 'Host 保留方案只能用于零可修问题且没有显式写作目标。');
  requireThat(Array.isArray(value.unresolved) && value.unresolved.length <= LIMITS.issues, code, '未决列表无效。');
  const unresolved = value.unresolved.map(item => { exact(item, ['issueId','reason'], [], code); requireThat(issueById.has(item.issueId), code, '未决问题未知。'); text(item.reason, code); return clone(item); });
  const accounted = new Set([...items.flatMap(i => i.issueIds), ...unresolved.map(i => i.issueId)]);
  requireThat(majorIssues.every(i => accounted.has(i.id)), code, '每个主要候选问题都须修改、保留或列为未决。');
  if(goals.length){requireThat(Array.isArray(value.goalDispositions),code,'写作目标缺少显式处置。');
    sameIds(value.goalDispositions.map(item=>item.goalId),goals.map(goal=>goal.id),code,'写作目标处置须逐项覆盖且顺序一致。');
    for(const disposition of value.goalDispositions){exact(disposition,['goalId','decision','planItemIds','reason'],[],code);text(disposition.reason,code);
      const owners=items.filter(item=>item.decision==='revise'&&item.goalIds.includes(disposition.goalId)).map(item=>item.id);
      sameIds(disposition.planItemIds,owners,code,'目标处置与实际方案组不一致。');
      requireThat(disposition.decision===(owners.length?'attempt':'preserve'),code,'目标处置不得把保留伪装成执行。');}}
  requireThat(Array.isArray(value.materialDecisions) && value.materialDecisions.length === input.retrieval.supplies.length, code, '材料决定须逐供应记录。');
  const supplyById = new Map(input.retrieval.supplies.map(s => [s.supplyId, s])), seenSupply = new Set();
  const materialDecisions = value.materialDecisions.map(decision => {
    exact(decision, ['supplyId','materialId','issueId','decision','planItemIds','evidenceIds','reason','applicabilityBoundary','limitations'], goals.length?['appliedAs','goalId']:['appliedAs'], code);
    const supply = supplyById.get(decision.supplyId); requireThat(supply && !seenSupply.has(decision.supplyId)
      && decision.materialId === supply.materialId && decision.issueId === supply.issueId, code, '材料决定绑定无效。'); seenSupply.add(decision.supplyId);
    requireThat(decision.goalId===supply.goalId,code,'材料决定须保持写作目标身份。');
    requireThat(['used','not_used'].includes(decision.decision), code, '材料决定无效。');
    if (input.applicability !== undefined && decision.decision === 'used') requireThat(input.applicability.directSupplyIds.includes(decision.supplyId), code, '只有功能适用层的direct_fit供应可以声明used。');
    requireThat(Array.isArray(decision.planItemIds) && new Set(decision.planItemIds).size === decision.planItemIds.length
      && decision.planItemIds.every(id => items.some(i => i.id === id)), code, '材料方案引用无效。');
    if(supply.goalId&&decision.decision==='used')requireThat(decision.planItemIds.every(id=>items.some(item=>item.id===id&&item.decision==='revise'&&item.goalIds.includes(supply.goalId))),code,'目标材料采用必须关联同目标的实际修改方案。');
    requireThat(Array.isArray(decision.evidenceIds) && new Set(decision.evidenceIds).size === decision.evidenceIds.length, code, '材料证据引用无效。');
    requireThat(decision.decision === 'used' ? decision.planItemIds.length > 0 && decision.evidenceIds.length > 0 && typeof decision.appliedAs === 'string'
      : decision.planItemIds.length === 0 && decision.evidenceIds.length === 0 && decision.appliedAs === undefined, code, '材料采用与方案、证据引用不一致。');
    text(decision.reason, code); if (decision.appliedAs !== undefined) text(decision.appliedAs, code); text(decision.applicabilityBoundary, code); stringList(decision.limitations, code, 8, false); return clone(decision);
  });
  for (const item of items) {
    const expected = materialDecisions.filter(d => d.decision === 'used' && d.planItemIds.includes(item.id)).map(d => d.supplyId);
    requireThat(new Set(item.adoptedSupplyIds).size === expected.length && expected.every(id => item.adoptedSupplyIds.includes(id)), code, '方案采用材料与决定不一致。');
  }
  for (const entry of wholeQualityRetrievalEntries(input.retrieval).filter(i => record(i.result))) {
    const decisions = materialDecisions.filter(d => d.issueId === entry.issueId).map(d => ({ materialId: d.materialId, decision: d.decision,
      reason: d.reason, evidenceIds: d.evidenceIds, changeGroupIds: d.planItemIds, ...(d.decision === 'used' ? { appliedAs: d.appliedAs } : {}) }));
    buildWholeQualityMaterialUseLedger(entry.result, decisions);
  }
  return { ...clone(value), items, materialDecisions, unresolved };
}

function hostNoEligiblePlan(input) {
  requireThat(input.eligibleIssueIds.length === 0 && !input.eligibleGoalIds?.length && input.retrieval.supplies.length === 0, 'WHOLE_QUALITY_HOST_PLAN', 'Host 保留分支只接受零可修问题、零显式目标且无材料供应。');
  const issues = input.reading.issues, sceneIdSet = new Set(issues.flatMap(issue => issue.sceneIds));
  const sceneIds = input.reading.sceneChanges.filter(scene => sceneIdSet.has(scene.id)).map(scene => scene.id);
  const chapterIdSet = new Set(input.reading.sceneChanges.filter(scene => sceneIdSet.has(scene.id)).map(scene => scene.chapterId));
  const affectedChapterIds = input.chapters.filter(chapter => chapterIdSet.has(chapter.id)).map(chapter => chapter.id);
  const seenEvidence = new Set(), preserve = [];
  for (const item of issues.flatMap(issue => issue.preservation)) {
    const key = `${item.chapterId}:${item.start}:${item.quote.length}`;
    if (!seenEvidence.has(key) && preserve.length < LIMITS.evidence) { seenEvidence.add(key); preserve.push(clone(item)); }
  }
  const risks = [...new Set(issues.flatMap(issue => issue.limitations))].slice(0, 12);
  const items = issues.length ? [{ id: 'host-preserve-noneligible-observations', issueIds: issues.map(issue => issue.id), decision: 'preserve', scope: 'linked_scenes',
    affectedChapterIds, sceneIds, targets: [], actionRequirements: [], action: '保留原稿；次要、保留或证据不足的观察不升级为本轮改写。',
    rationale: `独立阅读没有 major+investigate 问题；保留 ${issues.length} 条非可修观察供结果展示，不由计划阶段提升优先级。`,
    expectedEffect: '避免计划阶段为产生改稿而扩大独立阅读结论，同时保留原有观察与边界。',
    failureCriteria: '若后续把这些观察当作已批准修改，或隐藏其原始优先级与处置，则 Host 保留分支失效。',
    risks: risks.length ? risks : ['没有可修问题不等于正文已获文学质量证明。'], preserve, adoptedSupplyIds: [],
    independentAdoption: '这是不修改正文的保留记录，不依赖任何采纳组，也不产生可应用 target。' }] : [];
  return { schemaVersion: input.responseBindings.schemaVersion, inputHash: fingerprint(input), sourceManuscriptSha256: input.responseBindings.sourceManuscriptSha256,
    readingSha256: input.responseBindings.readingSha256, retrievalSha256: input.responseBindings.retrievalSha256, origin: 'host_no_eligible_issues',
    decision: 'preserve_original', summary: '独立阅读没有冻结的 major+investigate 问题；Host 保留原稿并记录非可修观察，未调用计划模型。',
    items, materialDecisions: [], unresolved: [] };
}
function planProvenance(producer, input, plan) {
  return { schemaVersion: input.writingGoals?'whole-quality-goal-plan-provenance-1':WHOLE_QUALITY_PLAN_PROVENANCE_VERSION, producer,
    reason: producer === 'host' ? 'no_eligible_issues' : input.writingGoals?'explicit_writing_goals_and_eligible_issues':'eligible_issues_require_model_plan', eligibleIssueIds: clone(input.eligibleIssueIds),
    ...(input.writingGoals?{eligibleGoalIds:clone(input.eligibleGoalIds)}:{}),
    modelStageDispatched: producer === 'model', planInputSha256: fingerprint(input), planSha256: fingerprint(plan) };
}
function validatePlanProvenance(value, input, plan) {
  const code = 'WHOLE_QUALITY_PLAN_PROVENANCE'; exact(value, ['schemaVersion','producer','reason','eligibleIssueIds','modelStageDispatched','planInputSha256','planSha256',...(input.writingGoals?['eligibleGoalIds']:[])], [], code);
  requireThat(value.schemaVersion === (input.writingGoals?'whole-quality-goal-plan-provenance-1':WHOLE_QUALITY_PLAN_PROVENANCE_VERSION) && ['host','model'].includes(value.producer), code, '方案来源版本无效。');
  const expected = planProvenance(value.producer, input, plan); requireThat(isDeepStrictEqual(value, expected), code, '方案来源、输入或调用声明不一致。');
  requireThat(value.producer === 'host' ? input.eligibleIssueIds.length === 0 && !input.eligibleGoalIds?.length && plan.origin === 'host_no_eligible_issues'
    : (input.eligibleIssueIds.length > 0 || input.eligibleGoalIds?.length > 0) && plan.origin !== 'host_no_eligible_issues', code, '方案来源与可修问题或明确目标不一致。'); return clone(value);
}
async function hostPlanStage({ input, saved, checkpoint }) {
  const inputHash = fingerprint(input), inputKey = 'whole-quality:plan:host-input', resultKey = 'whole-quality:plan:host-result', bound = { inputHash, input };
  if (Object.hasOwn(saved,inputKey)) requireThat(isDeepStrictEqual(saved[inputKey],bound), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', 'Host 方案输入保存点不一致。');
  else { await checkpoint(inputKey,clone(bound)); saved[inputKey]=clone(bound); }
  const deterministic = validatePlan(hostNoEligiblePlan(input),input); let plan;
  if (Object.hasOwn(saved,resultKey)) { plan=validatePlan(saved[resultKey],input); requireThat(isDeepStrictEqual(plan,deterministic), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', 'Host 方案保存点不是确定性结果。'); }
  else { plan=deterministic; await checkpoint(resultKey,clone(plan)); saved[resultKey]=clone(plan); }
  return { value: plan, provenance: planProvenance('host',input,plan) };
}

const feasibilityContract = { schemaVersion: 'whole-quality-feasibility-response-contract-2', additionalProperties: false, binding: bindingContract,
  required: ['schemaVersion','inputHash','sourceManuscriptSha256','planSha256','checks'],
  check: ['planItemId','assessment','reason','requirementChecks','sourceEvidence','blockingReasons','limitations'],
  requirementCheck: ['requirementId','assessment','reason','targetIds'],
  properties: { schemaVersion: { constFrom: 'responseBindings.schemaVersion' }, inputHash: { constFrom: 'top-level inputHash' },
    sourceManuscriptSha256: { constFrom: 'responseBindings.sourceManuscriptSha256' }, planSha256: { constFrom: 'responseBindings.planSha256' },
    checks: { type: 'array', exactItemCountFrom: 'input.plan.items where decision=revise', orderedBy: 'that revise-item order', itemsRef: 'checkSchema' } },
  checkSchema: { type: 'object', additionalProperties: false, required: ['planItemId','assessment','reason','requirementChecks','sourceEvidence','blockingReasons','limitations'],
    properties: { planItemId: { type: 'string', exactFrom: 'corresponding revise item.id' }, assessment: { type: 'string', enum: ['feasible','infeasible','uncertain'] },
      reason: textFieldContract(), requirementChecks: { type: 'array', exactItemCountFrom: 'corresponding plan item.actionRequirements.length', orderedBy: 'actionRequirements order', itemsRef: 'requirementCheckSchema' },
      sourceEvidence: { type: 'array', minItems: 1, maxItems: LIMITS.evidence, items: rawEvidenceContract },
      blockingReasons: stringArrayContract(8), limitations: stringArrayContract(8, { minItems: 1 }) },
    conditionalConstraints: [{ if: { assessment: 'feasible' }, then: ['every requirementCheck.assessment=supported','blockingReasons=[]'] },
      { if: { assessment: 'infeasible' }, then: ['at least one requirementCheck.assessment=unsupported or blockingReasons has at least 1 item'] },
      { if: { assessment: 'uncertain' }, then: ['at least one requirementCheck.assessment=uncertain'] }] },
  requirementCheckSchema: { type: 'object', additionalProperties: false, required: ['requirementId','assessment','reason','targetIds'],
    properties: { requirementId: { type: 'string', exactFrom: 'corresponding actionRequirement.id' }, assessment: { type: 'string', enum: ['supported','unsupported','uncertain'] },
      reason: textFieldContract(), targetIds: { type: 'array', exactCopyFrom: 'corresponding actionRequirement.targetIds' } },
    constraints: ['do not add or remove targets','judge whether authorized target text can visibly realize the requirement; noun-only coverage cannot support an action/relationship claim'] },
  legalEmptyResult: { shape: { checks: [] }, validOnlyWhen: 'there are no revise items; runtime normally skips this model stage in that case' } };
function feasibilityInput(requestSpec, chapters, reading, plan) {
  const bindings = { schemaVersion: WHOLE_QUALITY_FEASIBILITY_VERSION, sourceManuscriptSha256: requestSpec.sourceManuscriptSha256, planSha256: fingerprint(plan) };
  return { schemaVersion: 'whole-quality-feasibility-input-1', requestSpec, chapters, reading, plan, responseBindings: bindings,
    responseContract: feasibilityContract, responseExample: { ...bindings, inputHash: 'COPY_TOP_LEVEL_INPUT_HASH', checks: plan.items.filter(i => i.decision === 'revise').map(i => ({
      planItemId: i.id, assessment: 'uncertain', reason: '必须核对目标范围能否呈现行动要求', requirementChecks: i.actionRequirements.map(r => ({ requirementId: r.id,
        assessment: 'uncertain', reason: '结构占位', targetIds: r.targetIds })), sourceEvidence: [responseExampleEvidence(chapters[0])], blockingReasons: [], limitations: ['结构占位'] })) } };
}
function validateFeasibility(value, input) {
  const code = 'WHOLE_QUALITY_FEASIBILITY', revise = input.plan.items.filter(i => i.decision === 'revise');
  exact(value, feasibilityContract.required, [], code); requireThat(value.schemaVersion === input.responseBindings.schemaVersion && value.inputHash === fingerprint(input)
    && value.sourceManuscriptSha256 === input.responseBindings.sourceManuscriptSha256 && value.planSha256 === input.responseBindings.planSha256, code, '可行性检查绑定无效。');
  requireThat(Array.isArray(value.checks) && value.checks.length === revise.length, code, '可行性检查未逐项覆盖。');
  const checks = value.checks.map((item, index) => {
    exact(item, feasibilityContract.check, [], code); const planItem = revise[index]; requireThat(item.planItemId === planItem.id, code, '可行性检查顺序或 ID 无效。');
    requireThat(['feasible','infeasible','uncertain'].includes(item.assessment), code, '可行性判断无效。'); text(item.reason, code);
    requireThat(Array.isArray(item.requirementChecks) && item.requirementChecks.length === planItem.actionRequirements.length, code, '行动要求核对不完整。');
    const requirementChecks = item.requirementChecks.map((check, i) => {
      exact(check, feasibilityContract.requirementCheck, [], code); const req = planItem.actionRequirements[i];
      requireThat(check.requirementId === req.id && ['supported','unsupported','uncertain'].includes(check.assessment), code, '行动要求核对无效。');
      text(check.reason, code); sameIds(check.targetIds, req.targetIds, code, '行动要求 target 不能在预检中改写。'); return clone(check);
    });
    const sourceEvidence = evidenceList(item.sourceEvidence, input.chapters, code, { min: 1, path: `checks[${index}].sourceEvidence` }); stringList(item.blockingReasons, code, 8); stringList(item.limitations, code, 8, false);
    const assessments = requirementChecks.map(c => c.assessment);
    requireThat(item.assessment === 'feasible' ? assessments.every(a => a === 'supported') && item.blockingReasons.length === 0
      : item.assessment === 'infeasible' ? assessments.includes('unsupported') || item.blockingReasons.length > 0
      : assessments.includes('uncertain'), code, '总可行性与行动要求不一致。');
    return { ...clone(item), requirementChecks, sourceEvidence };
  });
  return { ...clone(value), checks };
}

const candidateContract = { schemaVersion: 'whole-quality-candidate-response-contract-2', additionalProperties: false, binding: bindingContract,
  required: ['schemaVersion','inputHash','sourceManuscriptSha256','planSha256','feasibilitySha256','replacements','skippedPlanItems'],
  properties: { schemaVersion: { constFrom: 'responseBindings.schemaVersion' }, inputHash: { constFrom: 'top-level inputHash' },
    sourceManuscriptSha256: { constFrom: 'responseBindings.sourceManuscriptSha256' }, planSha256: { constFrom: 'responseBindings.planSha256' },
    feasibilitySha256: { constFrom: 'responseBindings.feasibilitySha256' },
    replacements: { type: 'array', minItems: 0, maxItemsFrom: 'all targets owned by input.eligiblePlanItemIds', itemsRef: 'replacementSchema' },
    skippedPlanItems: { type: 'array', minItems: 0, maxItemsFrom: 'input.eligiblePlanItemIds.length', itemsRef: 'skippedSchema' } },
  replacementSchema: { type: 'object', additionalProperties: false, required: ['targetId','chapterId','sourceQuote','replacement','appliedPlanItemIds','notes'], optional: ['sourceStart'],
    properties: { targetId: { type: 'string', enumFrom: 'targets owned by input.eligiblePlanItemIds' }, chapterId: { type: 'string', exactFrom: 'matching target.chapterId' },
      sourceQuote: { type: 'string', exactFrom: 'matching target.quote' }, replacement: { type: 'string', minLength: 0, maxLength: 100000 },
      appliedPlanItemIds: { type: 'array', exactItemCount: 1, exactValueFrom: '[owner plan item.id]' }, notes: stringArrayContract(12, { minItems: 1 }),
      sourceStart: { type: 'integer', minimum: 0, exactFrom: 'matching target.start', guidance: 'omit this field; host derives it' } },
    constraints: ['targetId is unique','replacement ranges cannot overlap','never return a whole chapter unless the authorized target itself is the whole chapter'] },
  skippedSchema: { type: 'object', additionalProperties: false, required: ['planItemId','reason'], properties: {
    planItemId: { type: 'string', enumFrom: 'input.eligiblePlanItemIds' }, reason: textFieldContract() } },
  globalConstraints: ['For each eligible plan item choose exactly one: return replacements for every one of its targets, or return one skippedPlanItems entry.','An applied group must change at least one target; unchanged replacements for every target are invalid.','Do not return replacements for blocked, uncertain, unknown, or skipped groups.'],
  legalEmptyResult: { meaning: 'skip every eligible group safely', shape: { replacements: [], skippedPlanItems: [{ planItemId: 'each eligiblePlanItemId exactly once', reason: 'nonempty reason' }] }, note: 'If eligiblePlanItemIds is empty, runtime skips this model stage.' } };
function revisionInput(requestSpec, chapters, plan, feasibility) {
  const eligiblePlanItemIds = feasibility.checks.filter(c => c.assessment === 'feasible').map(c => c.planItemId);
  const bindings = { schemaVersion: WHOLE_QUALITY_CANDIDATE_VERSION, sourceManuscriptSha256: requestSpec.sourceManuscriptSha256,
    planSha256: fingerprint(plan), feasibilitySha256: fingerprint(feasibility) };
  return { schemaVersion: 'whole-quality-candidate-input-1', requestSpec, chapters, plan, feasibility, eligiblePlanItemIds, responseBindings: bindings,
    responseContract: candidateContract, responseExample: { ...bindings, inputHash: 'COPY_TOP_LEVEL_INPUT_HASH', replacements: [],
      skippedPlanItems: eligiblePlanItemIds.map(planItemId => ({ planItemId, reason: '没有安全的具体写法，保留整组原文' })) } };
}
function validateCandidate(value, input) {
  const code = 'WHOLE_QUALITY_CANDIDATE'; exact(value, candidateContract.required, [], code);
  requireThat(value.schemaVersion === input.responseBindings.schemaVersion && value.inputHash === fingerprint(input)
    && value.sourceManuscriptSha256 === input.responseBindings.sourceManuscriptSha256 && value.planSha256 === input.responseBindings.planSha256
    && value.feasibilitySha256 === input.responseBindings.feasibilitySha256, code, '候选修订绑定无效。');
  const eligible = input.plan.items.filter(i => input.eligiblePlanItemIds.includes(i.id));
  const targetMap = new Map(eligible.flatMap(item => item.targets.map(target => [target.id, { planItem: item, target }])));
  requireThat(Array.isArray(value.replacements) && value.replacements.length <= targetMap.size, code, '替换数量无效。'); const seen = new Set(), ranges = [];
  const replacements = value.replacements.map(item => {
    exact(item, ['targetId','chapterId','sourceQuote','replacement','appliedPlanItemIds','notes'], ['sourceStart'], code); const bound = targetMap.get(item.targetId);
    requireThat(bound && !seen.has(item.targetId) && item.chapterId === bound.target.chapterId && item.sourceQuote === bound.target.quote, code, '替换 target 绑定无效。'); seen.add(item.targetId);
    requireThat(item.sourceStart === undefined || item.sourceStart === bound.target.start, code, '替换位置无效。'); requireThat(typeof item.replacement === 'string' && item.replacement.length <= 100000, code, '替换正文无效。');
    sameIds(item.appliedPlanItemIds, [bound.planItem.id], code); stringList(item.notes, code, 12, false);
    const checked = { ...clone(item), sourceStart: bound.target.start }; ranges.push({ ...bound.target, quote: item.sourceQuote }); return checked;
  });
  const ordered = ranges.slice().sort((a,b) => a.chapterId.localeCompare(b.chapterId) || a.start - b.start);
  requireThat(ordered.every((r,i) => !i || !rangesOverlap(r, ordered[i-1])), code, '替换范围重叠。');
  requireThat(Array.isArray(value.skippedPlanItems) && value.skippedPlanItems.length <= eligible.length, code, '跳过列表无效。'); const skipped = new Set();
  const skippedPlanItems = value.skippedPlanItems.map(item => { exact(item, ['planItemId','reason'], [], code); requireThat(input.eligiblePlanItemIds.includes(item.planItemId) && !skipped.has(item.planItemId), code, '跳过方案无效。'); skipped.add(item.planItemId); text(item.reason, code); return clone(item); });
  for (const planItem of eligible) {
    const applied = replacements.filter(r => r.appliedPlanItemIds[0] === planItem.id); const isSkipped = skipped.has(planItem.id);
    requireThat(isSkipped !== (applied.length > 0), code, '可行方案须整组应用或整组跳过。');
    if (!isSkipped) requireThat(applied.length === planItem.targets.length && planItem.targets.every(t => applied.some(r => r.targetId === t.id))
      && applied.some(r => r.replacement !== r.sourceQuote), code, '应用组须覆盖全部 target 且至少产生一处实际变化。');
  }
  const checked = { ...clone(value), replacements, skippedPlanItems }; validateChapters(assembleCandidate(input.chapters, checked), code); return checked;
}

function assembleCandidate(source, candidateRevision) {
  if (!candidateRevision) return clone(source); const byChapter = new Map();
  for (const item of candidateRevision.replacements) { const list = byChapter.get(item.chapterId) ?? []; list.push(item); byChapter.set(item.chapterId, list); }
  return source.map(chapter => { let body = chapter.body; for (const item of (byChapter.get(chapter.id) ?? []).slice().sort((a,b) => b.sourceStart - a.sourceStart)) {
    requireThat(body.slice(item.sourceStart, item.sourceStart + item.sourceQuote.length) === item.sourceQuote, 'WHOLE_QUALITY_CANDIDATE', '候选拼接原文不一致。');
    body = body.slice(0,item.sourceStart) + item.replacement + body.slice(item.sourceStart + item.sourceQuote.length); }
    return { ...chapter, body }; });
}
function commonEdges(before, after) { let prefix = 0; while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0; while (suffix < before.length-prefix && suffix < after.length-prefix && before[before.length-1-suffix] === after[after.length-1-suffix]) suffix++;
  return { unchangedPrefixUtf16: prefix, unchangedSuffixUtf16: suffix, beforeChangedRange: { start: prefix, end: before.length-suffix }, afterChangedRange: { start: prefix, end: after.length-suffix } }; }
function buildChanges(source, candidate, plan) {
  const chapters = source.map((chapter,i) => { const after = candidate[i], planItemIds = plan.items.filter(p => p.decision === 'revise' && p.affectedChapterIds.includes(chapter.id)).map(p => p.id);
    return { chapterId: chapter.id, changed: chapter.body !== after.body, beforeBodySha256: bodyFingerprint(chapter.body), afterBodySha256: bodyFingerprint(after.body),
      beforeUtf16Length: chapter.body.length, afterUtf16Length: after.body.length, planItemIds, ...commonEdges(chapter.body, after.body) }; });
  return { actualChanges: chapters.filter(c => c.planItemIds.length), diff: { sourceManuscriptSha256: manuscriptFingerprint(source), candidateManuscriptSha256: manuscriptFingerprint(candidate),
    changedChapterIds: chapters.filter(c => c.changed).map(c => c.chapterId), unchangedChapterIds: chapters.filter(c => !c.changed).map(c => c.chapterId), chapters } };
}

function executionRows(plan, feasibility, candidateRevision) {
  const checkById = new Map(feasibility.checks.map(c => [c.planItemId, c])); const skipped = new Set(candidateRevision?.skippedPlanItems.map(i => i.planItemId) ?? []);
  return plan.items.filter(i => i.decision === 'revise').map(item => ({ planItemId: item.id,
    status: checkById.get(item.id)?.assessment !== 'feasible' ? 'blocked' : skipped.has(item.id) ? 'skipped' : 'applied' }));
}
const rereadContract = { schemaVersion: 'whole-quality-reread-response-contract-2', additionalProperties: false, binding: bindingContract,
  required: ['schemaVersion','inputHash','sourceManuscriptSha256','candidateManuscriptSha256','checkedChapterIds','coverage','summary','changeChecks','introducedIssues','unresolvedItems','preservedStrengths'],
  changeCheck: ['planItemId','executionStatus','goalAssessment','coherenceAssessment','reason','requirementChecks','risks','recommendation'],
  requirementCheck: ['requirementId','assessment','reason','evidence'], issue: ['id','severity','claimType','relatedPlanItemIds','observation','evidence','limitations'],
  properties: { schemaVersion: { constFrom: 'responseBindings.schemaVersion' }, inputHash: { constFrom: 'top-level inputHash' },
    sourceManuscriptSha256: { constFrom: 'responseBindings.sourceManuscriptSha256' }, candidateManuscriptSha256: { constFrom: 'responseBindings.candidateManuscriptSha256' },
    checkedChapterIds: { type: 'array', exactCopyFrom: 'responseBindings.checkedChapterIds' }, coverage: coverageContract, summary: textFieldContract(),
    changeChecks: { type: 'array', exactItemCountFrom: 'input.plan.items where decision=revise', orderedBy: 'that revise-item order', itemsRef: 'changeCheckSchema' },
    introducedIssues: { type: 'array', minItems: 0, maxItems: LIMITS.issues, itemsRef: 'introducedIssueSchema' },
    unresolvedItems: stringArrayContract(LIMITS.issues), preservedStrengths: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract } },
  changeCheckSchema: { type: 'object', additionalProperties: false, required: ['planItemId','executionStatus','goalAssessment','coherenceAssessment','reason','requirementChecks','risks','recommendation'],
    properties: { planItemId: { type: 'string', exactFrom: 'corresponding revise item.id' }, executionStatus: { type: 'string', enum: ['applied','blocked','skipped'], exactFrom: 'corresponding input.execution.status' },
      goalAssessment: { type: 'string', enum: ['implemented','partly_implemented','not_implemented','uncertain','not_attempted'] },
      coherenceAssessment: { type: 'string', enum: ['consistent','inconsistent','uncertain','not_checked'] }, reason: textFieldContract(),
      requirementChecks: { type: 'array', exactItemCountFrom: 'corresponding plan item.actionRequirements.length', orderedBy: 'actionRequirements order', itemsRef: 'requirementCheckSchema' },
      risks: stringArrayContract(12), recommendation: { type: 'string', enum: ['eligible_for_user_choice','not_recommended','needs_judgment'] } },
    conditionalConstraints: [{ if: { executionStatus: ['blocked','skipped'] }, then: ['goalAssessment=not_attempted','coherenceAssessment=not_checked','every requirementCheck.assessment=not_attempted','recommendation=not_recommended'] },
      { if: { recommendation: 'eligible_for_user_choice' }, then: ['executionStatus=applied','goalAssessment=implemented','coherenceAssessment=consistent','every requirementCheck.assessment=supported'] },
      { if: { any: ['goalAssessment=partly_implemented','goalAssessment=not_implemented','coherenceAssessment=inconsistent','any requirementCheck.assessment=not_supported'] }, then: ['recommendation=not_recommended'] }] },
  requirementCheckSchema: { type: 'object', additionalProperties: false, required: ['requirementId','assessment','reason','evidence'],
    properties: { requirementId: { type: 'string', exactFrom: 'corresponding actionRequirement.id' }, assessment: { type: 'string', enum: ['supported','not_supported','uncertain','not_attempted'] },
      reason: textFieldContract(), evidence: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract } },
    conditionalConstraints: [{ if: { assessment: ['supported','not_supported'] }, then: ['evidence has at least 1 exact candidate-text quote'] }] },
  introducedIssueSchema: { type: 'object', additionalProperties: false, required: ['id','severity','claimType','relatedPlanItemIds','observation','evidence','limitations'],
    properties: { id: textFieldContract(200), severity: { type: 'string', enum: ['serious','moderate','minor'] },
      claimType: { type: 'string', enum: ['textual_conflict','reader_effect_hypothesis','editorial_preference'] },
      relatedPlanItemIds: { type: 'array', minItems: 0, items: { type: 'string', enumFrom: 'revise plan item ids' } },
      observation: textFieldContract(), evidence: { type: 'array', minItems: 1, maxItems: LIMITS.evidence, items: rawEvidenceContract },
      limitations: stringArrayContract(8, { minItems: 1 }) }, constraints: ['a serious issue prevents eligible_for_user_choice for every related plan item'] },
  globalConstraints: ['Read all candidate chapters before judging.','Factual coherence and goal implementation are separate fields; consistency alone does not prove implementation.','A replacement existing in the candidate does not prove the intended visible effect.'],
  legalEmptyResult: { meaning: 'no revise items or no newly introduced issues', shape: { changeChecks: [], introducedIssues: [], unresolvedItems: [], preservedStrengths: [] }, note: 'changeChecks may be empty only when the plan has no revise items; coverage and summary remain required.' } };
const crossRereadContract = clone(rereadContract);
crossRereadContract.optional = ['crossChapterChecks'];
crossRereadContract.crossChapterCheck = ['conflictId','assessment','reason','evidence'];
crossRereadContract.properties.crossChapterChecks = { type: 'array', exactItemCountFrom: 'input.confirmedConflicts.length', orderedBy: 'input.confirmedConflicts order', itemsRef: 'crossChapterCheckSchema' };
crossRereadContract.crossChapterCheckSchema = { type: 'object', additionalProperties: false, required: ['conflictId','assessment','reason','evidence'],
  properties: { conflictId: { type: 'string', exactFrom: 'corresponding input.confirmedConflicts[].id' },
    assessment: { type: 'string', enum: ['resolved','unresolved','uncertain','not_attempted'] }, reason: textFieldContract(),
    evidence: { type: 'array', minItems: 0, maxItems: LIMITS.evidence, items: rawEvidenceContract } },
  conditionalConstraints: [{ if: { assessment: 'resolved' }, then: ['evidence has at least 1 exact candidate-text quote','owning revise group executionStatus=applied','owning changeCheck is implemented and consistent'] },
    { if: { assessment: ['unresolved','uncertain','not_attempted'] }, then: ['owning revise group recommendation=not_recommended when a group exists'] }] };
function rereadInput(requestSpec, sourceChapters, candidateChapters, reading, plan, feasibility, candidateRevision, actualChanges, diff, crossChapterBundle) {
  const execution = executionRows(plan, feasibility, candidateRevision); const bindings = { schemaVersion: WHOLE_QUALITY_REREAD_VERSION,
    sourceManuscriptSha256: requestSpec.sourceManuscriptSha256, candidateManuscriptSha256: manuscriptFingerprint(candidateChapters), checkedChapterIds: candidateChapters.map(c => c.id) };
  const confirmedConflicts = crossConflictGoals(crossChapterBundle, reading);
  return { schemaVersion: 'whole-quality-reread-input-1', requestSpec, sourceChapters, candidateChapters, reading, plan, feasibility, execution, actualChanges, diff,
    ...(crossChapterBundle === undefined ? {} : { confirmedConflicts }),
    responseBindings: bindings, responseContract: crossChapterBundle === undefined ? rereadContract : crossRereadContract, responseExample: { ...bindings, inputHash: 'COPY_TOP_LEVEL_INPUT_HASH', coverage: { status: 'complete', omissions: [] },
      summary: '全文复读摘要', changeChecks: plan.items.filter(i => i.decision === 'revise').map(i => { const status = execution.find(e => e.planItemId === i.id)?.status ?? 'blocked';
        return { planItemId: i.id, executionStatus: status, goalAssessment: status === 'applied' ? 'uncertain' : 'not_attempted', coherenceAssessment: status === 'applied' ? 'uncertain' : 'not_checked',
          reason: '结构占位', requirementChecks: i.actionRequirements.map(r => ({ requirementId: r.id, assessment: status === 'applied' ? 'uncertain' : 'not_attempted', reason: '结构占位', evidence: [] })),
          risks: ['AI 阅读判断具有不确定性'], recommendation: status === 'applied' ? 'needs_judgment' : 'not_recommended' }; }), introducedIssues: [], unresolvedItems: [], preservedStrengths: [],
      ...(crossChapterBundle === undefined ? {} : { crossChapterChecks: confirmedConflicts.map(conflict => { const owner = plan.items.find(item => item.decision === 'revise' && item.issueIds.includes(conflict.id));
        const status = owner ? execution.find(item => item.planItemId === owner.id)?.status : undefined;
        return { conflictId: conflict.id, assessment: status === 'applied' ? 'uncertain' : 'not_attempted',
          reason: status === 'applied' ? '须在候选全文中重新核对冲突两侧。' : '冲突未执行安全修订，明确保留为未决。', evidence: [] }; }) }) } };
}
function validateReread(value, input) {
  const code = 'WHOLE_QUALITY_REREAD', candidate = input.candidateChapters, revise = input.plan.items.filter(i => i.decision === 'revise');
  const activeRereadContract = input.confirmedConflicts === undefined ? rereadContract : crossRereadContract;
  exact(value, activeRereadContract.required, input.confirmedConflicts === undefined ? [] : activeRereadContract.optional, code); requireThat(value.schemaVersion === input.responseBindings.schemaVersion && value.inputHash === fingerprint(input)
    && value.sourceManuscriptSha256 === input.responseBindings.sourceManuscriptSha256 && value.candidateManuscriptSha256 === input.responseBindings.candidateManuscriptSha256
    && manuscriptFingerprint(candidate) === value.candidateManuscriptSha256, code, '复读绑定无效。');
  sameIds(value.checkedChapterIds, input.responseBindings.checkedChapterIds, code); coverage(value.coverage, code); text(value.summary, code);
  requireThat(Array.isArray(value.changeChecks) && value.changeChecks.length === revise.length, code, '复读未逐组检查。');
  const changeChecks = value.changeChecks.map((item,index) => {
    exact(item, rereadContract.changeCheck, [], code); const planItem = revise[index], expectedExecution = input.execution[index];
    requireThat(item.planItemId === planItem.id && item.executionStatus === expectedExecution.status, code, '复读执行状态无效。');
    requireThat(['implemented','partly_implemented','not_implemented','uncertain','not_attempted'].includes(item.goalAssessment)
      && ['consistent','inconsistent','uncertain','not_checked'].includes(item.coherenceAssessment), code, '目标或事实核对状态无效。'); text(item.reason, code);
    requireThat(Array.isArray(item.requirementChecks) && item.requirementChecks.length === planItem.actionRequirements.length, code, '目标要求复核不完整。');
    const requirementChecks = item.requirementChecks.map((check,i) => {
      exact(check, rereadContract.requirementCheck, [], code); const req = planItem.actionRequirements[i];
      requireThat(check.requirementId === req.id && ['supported','not_supported','uncertain','not_attempted'].includes(check.assessment), code, '目标要求复核无效。');
      text(check.reason, code); const checkedEvidence = evidenceList(check.evidence, candidate, code, { min: ['supported','not_supported'].includes(check.assessment) ? 1 : 0,
        path: `changeChecks[${index}].requirementChecks[${i}].evidence` });
      return { ...clone(check), evidence: checkedEvidence };
    });
    stringList(item.risks, code, 12); requireThat(['eligible_for_user_choice','not_recommended','needs_judgment'].includes(item.recommendation), code, '采纳建议无效。');
    if (item.executionStatus !== 'applied') requireThat(item.goalAssessment === 'not_attempted' && item.coherenceAssessment === 'not_checked'
      && requirementChecks.every(c => c.assessment === 'not_attempted') && item.recommendation === 'not_recommended', code, '未执行组不能宣称目标落实。');
    if (item.recommendation === 'eligible_for_user_choice') requireThat(item.executionStatus === 'applied' && item.goalAssessment === 'implemented'
      && item.coherenceAssessment === 'consistent' && requirementChecks.every(c => c.assessment === 'supported'), code, '可选采纳组未满足目标落实或事实自洽。');
    if (item.executionStatus === 'applied' && (item.goalAssessment === 'not_implemented' || item.goalAssessment === 'partly_implemented' || item.coherenceAssessment === 'inconsistent'
      || requirementChecks.some(c => c.assessment === 'not_supported'))) requireThat(item.recommendation === 'not_recommended', code, '失败或误伤组不能进入采纳。');
    return { ...clone(item), requirementChecks };
  });
  requireThat(Array.isArray(value.introducedIssues) && value.introducedIssues.length <= LIMITS.issues, code, '新增问题数量无效。');
  const introducedIssues = value.introducedIssues.map((item, issueIndex) => {
    exact(item, rereadContract.issue, [], code); text(item.id, code, 200); requireThat(['serious','moderate','minor'].includes(item.severity)
      && ['textual_conflict','reader_effect_hypothesis','editorial_preference'].includes(item.claimType), code, '新增问题类型无效。');
    requireThat(Array.isArray(item.relatedPlanItemIds) && item.relatedPlanItemIds.every(id => revise.some(p => p.id === id)), code, '新增问题关联组无效。'); text(item.observation, code);
    const checkedEvidence = evidenceList(item.evidence, candidate, code, { min: 1, path: `introducedIssues[${issueIndex}].evidence` }); stringList(item.limitations, code, 8, false); return { ...clone(item), evidence: checkedEvidence };
  });
  for (const issue of introducedIssues.filter(i => i.severity === 'serious')) for (const id of issue.relatedPlanItemIds) {
    requireThat(changeChecks.find(c => c.planItemId === id)?.recommendation !== 'eligible_for_user_choice', code, '严重误伤组不能进入推荐采纳。');
  }
  let crossChapterChecks;
  if (input.confirmedConflicts !== undefined) {
    requireThat(Array.isArray(value.crossChapterChecks) && value.crossChapterChecks.length === input.confirmedConflicts.length, code, 'confirmed_conflict 复读未逐项覆盖。');
    crossChapterChecks = value.crossChapterChecks.map((item, index) => {
      exact(item, crossRereadContract.crossChapterCheck, [], code); const conflict = input.confirmedConflicts[index];
      requireThat(item.conflictId === conflict.id && ['resolved','unresolved','uncertain','not_attempted'].includes(item.assessment), code, '跨章冲突复读状态无效。'); text(item.reason, code);
      const checkedEvidence = evidenceList(item.evidence, candidate, code, { min: item.assessment === 'resolved' ? 1 : 0, path: `crossChapterChecks[${index}].evidence` });
      const owner = revise.find(planItem => planItem.issueIds.includes(conflict.id)), ownerCheck = owner && changeChecks.find(check => check.planItemId === owner.id);
      if (item.assessment === 'resolved') requireThat(ownerCheck?.executionStatus === 'applied' && ownerCheck.goalAssessment === 'implemented'
        && ownerCheck.coherenceAssessment === 'consistent', code, '跨章冲突没有完成修订、目标复核和事实复核，不能标 resolved。');
      else if (ownerCheck) requireThat(ownerCheck.recommendation === 'not_recommended', code, '跨章冲突仍未解决的修改组不能进入推荐采纳。');
      if (!owner || ownerCheck?.executionStatus !== 'applied') requireThat(item.assessment !== 'resolved', code, '未执行跨章冲突不能标 resolved。');
      return { ...clone(item), evidence: checkedEvidence };
    });
  } else requireThat(value.crossChapterChecks === undefined, code, '无跨章核对输入时不能伪造冲突复读。');
  stringList(value.unresolvedItems, code, LIMITS.issues); const preservedStrengths = evidenceList(value.preservedStrengths, candidate, code, { path: 'preservedStrengths' });
  return { ...clone(value), changeChecks, introducedIssues, preservedStrengths, ...(crossChapterChecks === undefined ? {} : { crossChapterChecks }) };
}
function validateIncompleteReread(value, input) {
  const code = 'WHOLE_QUALITY_REREAD_INCOMPLETE'; exact(value, ['schemaVersion','status','inputHash','sourceManuscriptSha256','candidateManuscriptSha256','failureCode','diagnostics'], [], code);
  requireThat(value.schemaVersion === WHOLE_QUALITY_REREAD_INCOMPLETE_VERSION && value.status === 'incomplete' && value.inputHash === fingerprint(input)
    && value.sourceManuscriptSha256 === input.requestSpec.sourceManuscriptSha256 && value.candidateManuscriptSha256 === manuscriptFingerprint(input.candidateChapters), code, '未完成复读绑定无效。');
  text(value.failureCode, code, 200); stringList(value.diagnostics, code, 4, false); return clone(value);
}

export function createWholeQualityDraftGuidance({ premise, ending, sceneChanges, priorities = [], materialDecisions = [], unresolved = [] } = {}) {
  const code = 'WHOLE_QUALITY_DRAFT_GUIDANCE'; text(premise, code); text(ending, code);
  requireThat(Array.isArray(sceneChanges) && sceneChanges.length > 0 && sceneChanges.length <= LIMITS.scenes, code, '新稿场景变化无效。'); const ids = new Set();
  const checkedScenes = sceneChanges.map(scene => { exact(scene, ['id','beforeState','trigger','action','afterState','cost','failureCriterion'], [], code); text(scene.id, code, 200);
    requireThat(!ids.has(scene.id), code, '新稿场景 ID 重复。'); ids.add(scene.id); ['beforeState','trigger','action','afterState','cost','failureCriterion'].forEach(k => text(scene[k], code)); return clone(scene); });
  requireThat(Array.isArray(priorities) && priorities.length <= LIMITS.issues, code, '新稿优先项无效。'); const checkedPriorities = priorities.map(item => {
    exact(item, ['id','problem','expectedEffect','failureCriterion'], [], code); ['id','problem','expectedEffect','failureCriterion'].forEach(k => text(item[k], code)); return clone(item); });
  requireThat(Array.isArray(materialDecisions) && materialDecisions.length <= 60, code, '新稿材料决定无效。'); const checkedMaterials = materialDecisions.map(item => {
    exact(item, ['materialId','decision','reason','applicabilityBoundary'], [], code); text(item.materialId, code, 300); requireThat(['adopt','decline'].includes(item.decision), code, '新稿材料决定枚举无效。');
    text(item.reason, code); text(item.applicabilityBoundary, code); return clone(item); }); stringList(unresolved, code, LIMITS.issues);
  const core = { premise, ending, sceneChanges: checkedScenes, priorities: checkedPriorities, materialDecisions: checkedMaterials, unresolved: clone(unresolved) };
  return { schemaVersion: 'whole-quality-draft-guidance-1', guidanceSha256: fingerprint(core), ...core,
    boundary: '这是规划约束，不证明未写正文已经产生预期效果；成稿后仍须独立全文阅读。' };
}
function materialUseObject(retrieval,plan){return { schemaVersion: 'whole-quality-material-use-bundle-1', ledgers: wholeQualityRetrievalEntries(retrieval).filter(i => record(i.result)).map(entry => {
    const decisions = plan.materialDecisions.filter(d => d.issueId === entry.issueId).map(d => ({ materialId: d.materialId,
      decision: d.decision, reason: d.reason, evidenceIds: d.evidenceIds, changeGroupIds: d.planItemIds,
      ...(d.decision === 'used' ? { appliedAs: d.appliedAs } : {}) }));
    return buildWholeQualityMaterialUseLedger(entry.result, decisions);
  }),
    unavailableIssueIds: retrieval.byIssue.filter(i => i.status === 'unavailable').map(i => i.issueId),
    notConnectedIssueIds: retrieval.byIssue.filter(i => i.status === 'not_connected').map(i => i.issueId),
    boundary: '逐问题保留 DATA 供应与用材账本；未连接或不可用不等于无相关材料，used 也不证明正文效果。' };}
function candidateConflictRelation(source, candidate) {
  const sharedEvidenceKeys = candidate.evidence.flatMap(item => source.evidence
    .filter(original => original.chapterId === item.chapterId && original.quote === item.quote)
    .map(original => `${original.chapterId}:${original.start}:${original.quote.length}`));
  if (sharedEvidenceKeys.length) return { matchedBy: 'shared_verbatim_evidence', evidenceKeys: [...new Set(sharedEvidenceKeys)] };
  if (candidate.claim === source.claim) return { matchedBy: 'exact_source_claim', evidenceKeys: [] };
  return null;
}
function crossChapterOutcome(bundle, recheckBundle, reading, plan, feasibility, candidateRevision, reread, incomplete, crossRecheckIncomplete) {
  if (!bundle) return undefined;
  const goals = crossConflictGoals(bundle, reading), checkById = new Map((reread.crossChapterChecks ?? []).map(item => [item.conflictId, item]));
  const feasibilityById = new Map(feasibility.checks.map(item => [item.planItemId, item])), skipped = new Map((candidateRevision?.skippedPlanItems ?? []).map(item => [item.planItemId, item.reason]));
  const relatedCandidateConflicts = source => (recheckBundle?.confirmedConflicts ?? []).flatMap(candidate => {
    const relation = candidateConflictRelation(source,candidate); return relation ? [{ candidate, relation }] : [];
  });
  const items = goals.map(goal => {
    const source = bundle.confirmedConflicts.find(item => item.id === goal.id), related = relatedCandidateConflicts(source);
    const owner = plan.items.find(item => item.decision === 'revise' && item.issueIds.includes(goal.id)), planUnresolved = plan.unresolved.find(item => item.issueId === goal.id), check = checkById.get(goal.id);
    let repairStatus = 'unresolved', reason = planUnresolved?.reason;
    if (!reason && crossRecheckIncomplete) reason = CROSS_RECHECK_INCOMPLETE_MESSAGE;
    if (!reason && incomplete) reason = '修后全文复读未完成，confirmed_conflict 不能视为已修复。';
    if (!reason && !owner) reason = 'confirmed_conflict 没有进入修订组，明确保留为未决。';
    if (!reason && feasibilityById.get(owner.id)?.assessment !== 'feasible') reason = feasibilityById.get(owner.id)?.reason || '冻结修订范围未通过可行性检查。';
    if (!reason && skipped.has(owner.id)) reason = skipped.get(owner.id);
    if (!reason && check?.assessment === 'resolved' && recheckBundle && related.length === 0) { repairStatus = 'resolved_in_candidate'; reason = check.reason; }
    else if (!reason && related.length) reason = `候选稿事实复查仍检出与原冲突相关的 confirmed_conflict（${related.map(item => item.candidate.findingId).join('、')}），原冲突不能结案。`;
    else if (!reason) reason = check?.reason || 'confirmed_conflict 没有获得 resolved 复读结论。';
    return { conflictId: goal.id, findingId: source.findingId, hardIssue: true, repairStatus, reason,
      planItemIds: owner ? [owner.id] : [], targetIds: owner ? owner.targets.map(target => target.id) : [],
      rereadAssessment: check?.assessment ?? (incomplete ? 'incomplete' : 'not_attempted'), candidateRelatedFindingIds: related.map(item => item.candidate.findingId),
      candidateRelations: related.map(item => ({ findingId: item.candidate.findingId, ...item.relation })) };
  });
  return { schemaVersion: WHOLE_QUALITY_CROSS_CHAPTER_OUTCOME_VERSION, sourceManuscriptSha256: bundle.sourceManuscriptSha256,
    candidateReviewManuscriptSha256: recheckBundle?.sourceManuscriptSha256 ?? null,
    confirmedCount: items.length, resolvedInCandidateCount: items.filter(item => item.repairStatus === 'resolved_in_candidate').length,
    unresolvedCount: items.filter(item => item.repairStatus === 'unresolved').length, items,
    candidateConfirmedRisks: (recheckBundle?.confirmedConflicts ?? []).map(candidate => { const sourceRelations = bundle.confirmedConflicts.flatMap(source => {
      const relation = candidateConflictRelation(source,candidate); return relation ? [{ conflictId: source.id, ...relation }] : [];
    }); return { findingId: candidate.findingId, claim: candidate.claim, sourceConflictIds: sourceRelations.map(item => item.conflictId), sourceRelations }; }),
    boundary: 'no_change、跳过、未执行、复读不确定或复读失败均不算修复；每个 confirmed_conflict 独立结案，候选稿其他 confirmed 风险另行保留，不能抹掉已修项。' };
}
function writingGoalsReport(writingGoals,retrieval,applicability,plan,finalTextMaterialEvidence,reread){
  if(!writingGoals)return undefined;
  return{schemaVersion:'whole-quality-writing-goals-report-1',writingGoalsSha256:fingerprint(writingGoals),planSha256:fingerprint(plan),
    candidateManuscriptSha256:finalTextMaterialEvidence.candidateManuscriptSha256,
    goals:writingGoals.goals.map(goal=>{const disposition=plan.goalDispositions.find(item=>item.goalId===goal.id),query=retrieval.byGoal.find(item=>item.goalId===goal.id);
      const materials=retrieval.supplies.filter(supply=>supply.goalId===goal.id).map(supply=>{
        const decision=plan.materialDecisions.find(item=>item.supplyId===supply.supplyId),assessment=applicability.assessments.find(item=>item.supplyId===supply.supplyId);
        const final=finalTextMaterialEvidence.byIssue.find(item=>item.issueId===supply.issueId)?.records.find(item=>item.materialId===supply.materialId);
        return{supplyId:supply.supplyId,materialId:supply.materialId,contentSha256:supply.contentSha256,evidenceIds:clone(supply.evidenceIds),
          fit:assessment.fit,decision:decision.decision,reason:decision.reason,caveat:decision.applicabilityBoundary,planItemIds:clone(decision.planItemIds),
          status:decision.decision==='not_used'?'unused':final?.status==='located'?'used_exact_text_located':'not_proven',manuscriptEvidence:clone(final?.findings??[])};});
      const response=query.result?.packet?.deepReference?.response,deepIds=new Set((response?.results??[]).map(item=>item.referenceId)),deepMaterials=materials.filter(item=>deepIds.has(item.materialId));
      const deepMaterialOutcome=!response?'query_unavailable':response.resultCount===0?'no_hits':!deepMaterials.length?'hits_not_supplied_budget'
        :deepMaterials.every(item=>item.decision==='not_used')?'supplied_all_declined':deepMaterials.some(item=>item.status==='not_proven')?'use_not_proven':'used_exact_text_located';
      return{goal:clone(goal),querySubjectId:writingGoalSubjectId(goal),queryStatus:query.status,
        deepQuery:{status:response?.status??'unavailable',queryId:response?.queryId??null,responseSha256:response?fingerprint(response):null,
          matchingPolicy:clone(response?.matchingPolicy??null),returnedCandidateCount:response?.resultCount??null,suppliedMaterialCount:deepMaterials.length},
        deepMaterialOutcome,disposition:clone(disposition),materials,
        rereadChecks:clone((reread.changeChecks??[]).filter(check=>disposition.planItemIds.includes(check.planItemId)))};}),
    boundary:'显式写作目标不是诊断问题；尝试、来源命中和正文逐字落点均不证明目标实现或文学改善。允许全部不用并保留原稿。'};
}
function qualityObject(reading, retrieval, plan, feasibility, reread, {applicability,finalTextMaterialEvidence,c06References,deepReference,writingGoals,crossChapterBundle,crossChapterRecheck,crossRecheckIncomplete,crossChapterResolution,candidateRevision}={}) {
  const priorities = reading.issues.map(({ id, priority, disposition, area, observation, expectedEffect, failureCriteria }) => ({ id, priority, disposition, area, observation, expectedEffect, failureCriteria }));
  const legacyUnresolved = [...reading.unresolved, ...plan.unresolved.map(i => i.reason), ...feasibility.checks.filter(c => c.assessment !== 'feasible').flatMap(c => [c.reason, ...c.blockingReasons]), ...(reread.unresolvedItems ?? [])];
  const unresolved = crossChapterResolution === undefined ? legacyUnresolved : [...new Set([...legacyUnresolved,
    ...(crossRecheckIncomplete ? [CROSS_RECHECK_INCOMPLETE_MESSAGE] : []),
    ...(candidateRevision?.skippedPlanItems?.map(item => item.reason) ?? []),
    ...crossChapterResolution.items.filter(item => item.repairStatus === 'unresolved').map(item => item.reason)])];
  const materialUse = materialUseObject(retrieval,plan);
  const last = reading.sceneChanges.at(-1); const guidance = createWholeQualityDraftGuidance({ premise: reading.synopsis, ending: last.afterState,
    sceneChanges: reading.sceneChanges.map(s => ({ id: s.id, beforeState: s.beforeState, trigger: s.trigger, action: s.action, afterState: s.afterState, cost: s.cost,
      failureCriterion: `成稿须在 ${s.id} 的正文行动与后果中可见，不能只由说明句宣称。` })),
    priorities: reading.issues.map(i => ({ id: i.id, problem: i.observation, expectedEffect: i.expectedEffect, failureCriterion: i.failureCriteria })),
    materialDecisions: plan.materialDecisions.map(d => ({ materialId: d.materialId, decision: d.decision === 'used' ? 'adopt' : 'decline', reason: d.reason, applicabilityBoundary: d.applicabilityBoundary })), unresolved });
  return { independentReading: clone(reading), sceneChanges: clone(reading.sceneChanges), issuePriorities: priorities,
    ...(crossChapterBundle===undefined?{}:{crossChapterReview:clone(crossChapterBundle)}),
    ...(crossChapterRecheck===undefined?{}:{crossChapterRecheck:clone(crossChapterRecheck)}),
    ...(crossRecheckIncomplete===undefined?{}:{crossChapterRecheckIncomplete:clone(crossRecheckIncomplete)}),
    ...(crossChapterResolution===undefined?{}:{crossChapterResolution:clone(crossChapterResolution)}),
    retrieval: clone(retrieval), ...(applicability===undefined?{}:{applicability:clone(applicability)}), materialUse,
    ...(finalTextMaterialEvidence===undefined?{}:{finalTextMaterialEvidence:clone(finalTextMaterialEvidence)}),
    ...(c06References===undefined?{}:{c06References:clone(c06References)}),
    ...(deepReference===undefined?{}:{deepReference:clone(deepReference)}),
    ...(writingGoals?{writingGoals:writingGoalsReport(writingGoals,retrieval,applicability,plan,finalTextMaterialEvidence,reread)}:{}),
    feasibility: clone(feasibility), unresolved, newDraftGuidance: guidance };
}

const finalTextContract={schemaVersion:'whole-quality-final-text-response-contract-1',additionalProperties:false,binding:bindingContract,
  required:['schemaVersion','inputHash','candidateManuscriptSha256','materialUseSha256','recordsByIssue'],
  properties:{schemaVersion:{constFrom:'responseBindings.schemaVersion'},inputHash:{constFrom:'top-level inputHash'},candidateManuscriptSha256:{constFrom:'responseBindings.candidateManuscriptSha256'},
    materialUseSha256:{constFrom:'responseBindings.materialUseSha256'},recordsByIssue:{type:'array',exactItemCountFrom:'input.activeLedgers.length',orderedBy:'input.activeLedgers order',itemsRef:'issueRecordsSchema'}},
  issueRecordsSchema:{type:'object',additionalProperties:false,required:['issueId','records'],properties:{issueId:{type:'string',exactFrom:'corresponding active ledger.issueId'},
    records:{type:'array',exactItemCountFrom:'corresponding ledger.usedMaterialIds.length',itemsRef:'recordSchema'}}},
  recordSchema:{type:'object',additionalProperties:false,required:['materialId','status','findings'],optional:['reason'],properties:{materialId:{type:'string',enumFrom:'corresponding ledger.usedMaterialIds'},
    status:{type:'string',enum:['located','not_located']},findings:{type:'array',itemsRef:'findingSchema'},reason:textFieldContract()},
    conditionalConstraints:[{if:{status:'located'},then:['findings has at least 1 item','reason omitted']},{if:{status:'not_located'},then:['findings=[]','reason required']}]},
  findingSchema:{type:'object',additionalProperties:false,required:['chapterId','start','quote','changeGroupId','sourceEvidenceIds','textRole','explanation'],
    properties:{chapterId:{type:'string',enumFrom:'input.candidateChapters[].id'},start:{type:'integer',minimum:0},quote:textFieldContract(2000),
      changeGroupId:{type:'string',enumFrom:'corresponding used decision.changeGroupIds'},sourceEvidenceIds:{type:'array',minItems:1,uniqueItems:true,items:{type:'string',enumFrom:'corresponding used decision.evidenceIds'}},
      textRole:{type:'string',enum:['visible_application','context_only']},explanation:textFieldContract()},constraints:['quote must occur verbatim at start in chapterId','literal location does not prove literary effect']},
  globalConstraints:['cover every used material exactly once','if no exact final-text trace exists use not_located with a concrete reason','do not infer effect from the author declaration or source similarity']};

function finalTextInput(requestSpec,candidateChapters,materialUse){const activeLedgers=materialUse.ledgers.filter(ledger=>ledger.usedMaterialIds.length>0),bindings={schemaVersion:WHOLE_QUALITY_FINAL_TEXT_STAGE_VERSION,
  candidateManuscriptSha256:manuscriptFingerprint(candidateChapters),materialUseSha256:fingerprint(materialUse)};
  return{schemaVersion:'whole-quality-final-text-input-1',requestSpec,candidateChapters,materialUse,activeLedgers,responseBindings:bindings,responseContract:finalTextContract,
    responseExample:{...bindings,inputHash:'COPY_TOP_LEVEL_INPUT_HASH',recordsByIssue:activeLedgers.map(ledger=>({issueId:ledger.issueId,records:ledger.usedMaterialIds.map(materialId=>({materialId,status:'not_located',findings:[],reason:'结构占位；找不到精确正文落点时须如实记录。'}))}))}};}

function buildFinalTextBundle({candidateChapters,materialUse,recordsByIssue,modelStageDispatched}){const byIssue=materialUse.ledgers.map(ledger=>{
  const records=recordsByIssue.find(item=>item.issueId===ledger.issueId)?.records??[];return buildWholeQualityFinalTextUseEvidence({materialUseLedger:ledger,chapters:candidateChapters,records});});
  return{schemaVersion:WHOLE_QUALITY_FINAL_TEXT_BUNDLE_VERSION,candidateManuscriptSha256:manuscriptFingerprint(candidateChapters),materialUseSha256:fingerprint(materialUse),
    modelStageDispatched,recordsByIssue:clone(recordsByIssue),byIssue,allUsedMaterialsLocated:byIssue.every(item=>item.allUsedMaterialsLocated),automaticEffectClaim:false,literaryEffect:'NOT_COMPUTED',
    boundary:'最终正文逐字落点与作者声明分开保存；located不证明材料造成该文本或实现文学目标，not_located也不会被隐藏。'};}

function validateFinalTextResponse(value,input){const code='WHOLE_QUALITY_FINAL_TEXT_EVIDENCE';exact(value,finalTextContract.required,[],code);
  requireThat(value.schemaVersion===input.responseBindings.schemaVersion&&value.inputHash===fingerprint(input)
    &&value.candidateManuscriptSha256===input.responseBindings.candidateManuscriptSha256&&value.materialUseSha256===input.responseBindings.materialUseSha256,code,'最终正文用材响应绑定无效。');
  requireThat(Array.isArray(value.recordsByIssue)&&value.recordsByIssue.length===input.activeLedgers.length,code,'最终正文用材记录未逐账本覆盖。');
  const recordsByIssue=value.recordsByIssue.map((item,index)=>{const ledger=input.activeLedgers[index];exact(item,['issueId','records'],[],code);requireThat(item.issueId===ledger.issueId&&Array.isArray(item.records),code,'最终正文用材问题身份无效。');
    const checked=buildWholeQualityFinalTextUseEvidence({materialUseLedger:ledger,chapters:input.candidateChapters,records:item.records});return{issueId:item.issueId,records:clone(item.records),checked};});
  return buildFinalTextBundle({candidateChapters:input.candidateChapters,materialUse:input.materialUse,recordsByIssue:recordsByIssue.map(({issueId,records})=>({issueId,records})),modelStageDispatched:true});}

function validateFinalTextBundle(value,candidateChapters,materialUse){const code='WHOLE_QUALITY_FINAL_TEXT_EVIDENCE';requireThat(record(value),code,'最终正文用材证据包无效。');
  const expected=buildFinalTextBundle({candidateChapters,materialUse,recordsByIssue:value.recordsByIssue??[],modelStageDispatched:value.modelStageDispatched});
  requireThat(isDeepStrictEqual(value,expected),code,'最终正文用材证据与正文、账本或记录不一致。');return clone(value);}

async function runFinalTextEvidence({requestSpec,candidateChapters,materialUse,model,saved,checkpoint,progress,signal}){const input=finalTextInput(requestSpec,candidateChapters,materialUse);
  if(input.activeLedgers.length){const run=await structuredStage({prefix:'whole-quality:material-evidence',stage:'whole-quality:material-evidence',input,
    system:FINAL_TEXT_SYSTEM,maxTokens:10000,validate:validateFinalTextResponse,
    validateSavedResult:value=>validateFinalTextBundle(value,candidateChapters,materialUse),model,saved,checkpoint,progress,signal});return{value:run.value,receipt:run.receipt};}
  const deterministic=buildFinalTextBundle({candidateChapters,materialUse,recordsByIssue:[],modelStageDispatched:false}),key='whole-quality:material-evidence:host-result';
  if(Object.hasOwn(saved,key))requireThat(isDeepStrictEqual(validateFinalTextBundle(saved[key],candidateChapters,materialUse),deterministic),'WHOLE_QUALITY_CHECKPOINT_MISMATCH','Host最终正文用材保存点不一致。');
  else{await checkpoint(key,clone(deterministic));saved[key]=clone(deterministic);}return{value:deterministic};}

function c06ReferenceBundle(retrieval,materialUse){const lists=[];for(const ledger of materialUse.ledgers){const entry=wholeQualityRetrievalEntries(retrieval).find(item=>item.issueId===ledger.issueId);
  requireThat(record(entry?.result),'WHOLE_QUALITY_C06','用材账本缺少绑定检索结果。');lists.push(buildWholeQualityC06ReferenceList({retrieval:entry.result,materialUseLedger:ledger}));}
  return{schemaVersion:'whole-quality-c06-reference-bundle-1',lists,completeLibraryComparison:false,
    boundary:'每项清单仅含本次声明使用的固定材料片段；不能描述为已比较完整资料库。'};}

function parseResponse(raw, label) { requireThat(typeof raw === 'string' && raw.trim() && raw.length <= LIMITS.responseChars, 'WHOLE_QUALITY_RESPONSE_INVALID', `${label}响应为空或超限。`);
  let value; try { value = JSON.parse(raw); } catch { fail('WHOLE_QUALITY_RESPONSE_INVALID', `${label}响应不是完整 JSON。`); } requireThat(record(value), 'WHOLE_QUALITY_RESPONSE_INVALID', `${label}响应不是对象。`); return value; }
function responseRecord(value, inputHash, code) { exact(value, ['inputHash','rawResponse','responseSha256'], [], code); requireThat(value.inputHash === inputHash && typeof value.rawResponse === 'string'
  && value.rawResponse.trim() && value.rawResponse.length <= LIMITS.responseChars && value.responseSha256 === hashText(value.rawResponse), code, '保存响应与输入不一致。'); return clone(value); }
function validateReceipt(value, stage, inputHash) { exact(value, ['stage','inputHash','primaryResponseSha256'], ['formatRepairResponseSha256'], 'WHOLE_QUALITY_RECEIPT');
  requireThat(value.stage === stage && value.inputHash === inputHash && hex64.test(value.primaryResponseSha256)
    && (value.formatRepairResponseSha256 === undefined || hex64.test(value.formatRepairResponseSha256)), 'WHOLE_QUALITY_RECEIPT', '阶段回执无效。'); return clone(value); }
function safeDiagnostic(error) { return String(error?.message || error?.code || '未知格式错误').slice(0,1000); }
function safeErrorLocation(error) {
  const location = error?.location;
  if (!record(location)) return undefined;
  const allowed = ['fieldPath','chapterId','quote','quoteSha256','start','occurrence','chapterBodySha256'];
  return Object.fromEntries(allowed.filter(key => Object.hasOwn(location, key)).map(key => [key, clone(location[key])]));
}
// Diagnostics only: visit the reading contract's literal locations independently
// of its first-error validator. Never normalize a quote or change a judgment.
export function collectWholeQualityReadingEvidenceFeedback({rawResponse, input}) {
  const code='WHOLE_QUALITY_READING_FEEDBACK',chapters=validateChapters(input?.chapters,code);
  validateRequestSpec(input?.requestSpec,chapters);
  requireThat([WHOLE_QUALITY_READING_VERSION,FACT_READING_VERSION].includes(input?.responseBindings?.schemaVersion)
    &&input.responseBindings.sourceManuscriptSha256===manuscriptFingerprint(chapters),code,'阅读反馈输入未绑定当前正文。');
  sameIds(input.responseBindings.checkedChapterIds,chapters.map(c=>c.id),code);
  requireThat(typeof rawResponse==='string',code,'阅读反馈需要原始响应字符串。');
  const inputHash=fingerprint(input),base={schemaVersion:WHOLE_QUALITY_READING_FEEDBACK_VERSION,inputHash,
    sourceManuscriptSha256:manuscriptFingerprint(chapters),invalidResponseSha256:hashText(rawResponse),
    limits:clone(WHOLE_QUALITY_READING_FEEDBACK_LIMITS),automaticAcceptance:false};
  const notScanned=(reason,diagnostic)=>({...base,scanStatus:'not_scanned',reason,diagnostic,checkedLocationCount:0,
    totalInvalidCount:null,listedCount:0,remainingCount:null,locations:[]});
  let value;try{value=parseResponse(rawResponse,'阅读字面证据诊断');}catch(error){
    if(!(error instanceof WholeQualityError))throw error;
    return notScanned('invalid_json_response',safeDiagnostic(error));
  }
  if(value.inputHash!==inputHash||value.sourceManuscriptSha256!==base.sourceManuscriptSha256
    ||value.schemaVersion!==input.responseBindings.schemaVersion)return notScanned('response_binding_mismatch','响应未绑定这份阅读输入；没有扫描或接受其证据。');
  const locations=[],cache=new Map(),byChapter=new Map(chapters.map(c=>[c.id,c])),bodyHashes=new Map();
  let checkedLocationCount=0,totalInvalidCount=0,locationChars=2;
  const visit=(item,fieldPath)=>{
    checkedLocationCount++;
    // Non-literal fields are left to validateReading. Use the same exact locator
    // with a fixed diagnostic purpose so a bad purpose cannot hide a bad quote.
    const probe={chapterId:item?.chapterId,quote:item?.quote,purpose:'字面位置诊断',
      ...(record(item)&&Object.hasOwn(item,'start')?{start:item.start}:record(item)&&Object.hasOwn(item,'occurrence')?{occurrence:item.occurrence}:{})};
    const key=JSON.stringify(probe);let diagnostic=cache.get(key);
    if(!cache.has(key)){
      try{evidence(probe,chapters,'WHOLE_QUALITY_READING',fieldPath);diagnostic=null;}
      catch(error){if(!(error instanceof WholeQualityError))throw error;diagnostic=safeDiagnostic(error);}
      cache.set(key,diagnostic);
    }
    if(diagnostic===null)return;
    totalInvalidCount++;
    if(locations.length>=WHOLE_QUALITY_READING_FEEDBACK_LIMITS.locations)return;
    const chapter=byChapter.get(probe.chapterId),location={fieldPath,diagnostic,
      chapterId:typeof probe.chapterId==='string'&&probe.chapterId.length<=200?probe.chapterId:null};
    if(typeof probe.chapterId==='string'&&probe.chapterId.length>200)Object.assign(location,{chapterIdOmitted:true,chapterIdSha256:hashText(probe.chapterId),chapterIdLength:probe.chapterId.length});
    if(typeof probe.quote==='string')Object.assign(location,{quoteSha256:hashText(probe.quote),quoteLength:probe.quote.length,
      ...(probe.quote.length<=WHOLE_QUALITY_READING_FEEDBACK_LIMITS.quoteChars?{quote:probe.quote}:{quoteOmitted:true})});
    else location.quote=null;
    for(const name of ['start','occurrence'])if(Number.isSafeInteger(probe[name]))location[name]=probe[name];
    if(chapter){if(!bodyHashes.has(chapter.id))bodyHashes.set(chapter.id,bodyFingerprint(chapter.body));location.chapterBodySha256=bodyHashes.get(chapter.id);}
    const size=JSON.stringify(location).length+(locations.length?1:0);
    if(locationChars+size<=WHOLE_QUALITY_READING_FEEDBACK_LIMITS.locationChars){locations.push(location);locationChars+=size;}
  };
  const list=(items,path)=>{if(Array.isArray(items))items.forEach((item,index)=>visit(item,`${path}[${index}]`));};
  if(Array.isArray(value.sceneChanges))value.sceneChanges.forEach((scene,index)=>{
    if(!record(scene))return;
    visit(scene.entryEvidence,`sceneChanges[${index}].entryEvidence`);visit(scene.exitEvidence,`sceneChanges[${index}].exitEvidence`);
    list(scene.preservedStrengths,`sceneChanges[${index}].preservedStrengths`);
  });
  if(Array.isArray(value.issues))value.issues.forEach((issue,index)=>{
    if(!record(issue))return;
    for(const name of ['evidence','counterEvidence','preservation'])list(issue[name],`issues[${index}].${name}`);
  });
  list(value.strengths,'strengths');
  return {...base,scanStatus:'complete',checkedLocationCount,totalInvalidCount,listedCount:locations.length,
    remainingCount:totalInvalidCount-locations.length,locations};
}
function formatRepairInput(stage, inputHash, primaryResponseSha256, error) {
  const errorLocation = safeErrorLocation(error);
  return { schemaVersion: 'whole-quality-format-repair-1', stage, inputHash, invalidResponseSha256: primaryResponseSha256,
    errorCode: error?.code ?? 'WHOLE_QUALITY_RESPONSE_INVALID', error: safeDiagnostic(error),
    ...(errorLocation === undefined ? {} : { errorLocation }) };
}
function stageFormatRepairInput(stage,input,primary,error,savedRecord) {
  const legacy=formatRepairInput(stage,fingerprint(input),primary.responseSha256,error);
  if(stage!=='whole-quality:reading'||savedRecord?.repairInput?.schemaVersion==='whole-quality-format-repair-1')return legacy;
  return {...legacy,schemaVersion:WHOLE_QUALITY_READING_REPAIR_VERSION,
    literalEvidenceFeedback:collectWholeQualityReadingEvidenceFeedback({rawResponse:primary.rawResponse,input})};
}
function checkedRepairInputRecord(value, expected, code = 'WHOLE_QUALITY_CHECKPOINT_MISMATCH') {
  exact(value, ['repairInputHash','repairInput'], [], code); requireThat(record(value.repairInput), code, '格式纠正输入保存点无效。');
  const extended=expected.schemaVersion===WHOLE_QUALITY_READING_REPAIR_VERSION;
  exact(value.repairInput, ['schemaVersion','stage','inputHash','invalidResponseSha256','errorCode','error',...(extended?['literalEvidenceFeedback']:[])], ['errorLocation'], code);
  requireThat(value.repairInputHash === fingerprint(value.repairInput), code, '格式纠正输入保存点哈希无效。');
  const comparable = extended||Object.hasOwn(value.repairInput, 'errorLocation') ? expected
    : Object.fromEntries(Object.entries(expected).filter(([key]) => key !== 'errorLocation'));
  requireThat(isDeepStrictEqual(value.repairInput, comparable), code, '格式纠正输入与主响应失败不一致。'); return clone(value);
}
async function recoverStageReceipt({ prefix, stage, inputHash, saved, checkpoint }) {
  const primary = responseRecord(saved[`${prefix}:primary-response`], inputHash, 'WHOLE_QUALITY_CHECKPOINT_MISMATCH'); let repair;
  if (Object.hasOwn(saved, `${prefix}:repair-response`)) { const ri = saved[`${prefix}:repair-input`]; requireThat(record(ri) && ri.repairInputHash === fingerprint(ri.repairInput), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '格式纠正输入保存点无效。');
    repair = responseRecord(saved[`${prefix}:repair-response`], ri.repairInputHash, 'WHOLE_QUALITY_CHECKPOINT_MISMATCH'); }
  const rebuilt = { stage, inputHash, primaryResponseSha256: primary.responseSha256, ...(repair ? { formatRepairResponseSha256: repair.responseSha256 } : {}) }; const key = `${prefix}:receipt`;
  if (Object.hasOwn(saved,key)) { const existing = validateReceipt(saved[key],stage,inputHash); requireThat(isDeepStrictEqual(existing,rebuilt), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '回执与保存响应不一致。'); return existing; }
  await checkpoint(key,clone(rebuilt)); saved[key]=clone(rebuilt); return rebuilt;
}
function recoverStoredStageValue({ prefix, stage, input, inputHash, validate, saved }) {
  const code='WHOLE_QUALITY_CHECKPOINT_MISMATCH',primary=responseRecord(saved[`${prefix}:primary-response`],inputHash,code);let primaryError,checked;
  try{checked=validate(parseResponse(primary.rawResponse,stage),input);}catch(error){primaryError=error;}
  if(checked!==undefined){requireThat(!Object.hasOwn(saved,`${prefix}:repair-input`)&&!Object.hasOwn(saved,`${prefix}:repair-response`),code,'有效主响应不能附带格式纠正保存点。');return checked;}
  requireThat(primaryError?.code==='WHOLE_QUALITY_RESPONSE_INVALID'||String(primaryError?.code??'').startsWith('WHOLE_QUALITY_'),code,'保存的主响应失败类型无效。');
  const expectedRepairInput=stageFormatRepairInput(stage,input,primary,primaryError,saved[`${prefix}:repair-input`]),savedRi=checkedRepairInputRecord(saved[`${prefix}:repair-input`],expectedRepairInput,code);
  const repair=responseRecord(saved[`${prefix}:repair-response`],savedRi.repairInputHash,code);
  try{checked=validate(parseResponse(repair.rawResponse,`${stage}格式纠正`),input);}catch{}
  requireThat(checked!==undefined,code,'保存的纠正响应不能重建有效结果。');return checked;
}
async function structuredStage({ prefix, stage, input, system, maxTokens, validate, validateSavedResult=validate, model, saved, checkpoint, progress, signal }) {
  const inputHash=fingerprint(input), inputKey=`${prefix}:input`, resultKey=`${prefix}:result`, bound={inputHash,input};
  if(Object.hasOwn(saved,inputKey)) requireThat(isDeepStrictEqual(saved[inputKey],bound),'WHOLE_QUALITY_CHECKPOINT_MISMATCH',`${stage}输入保存点不一致。`); else {await checkpoint(inputKey,clone(bound));saved[inputKey]=clone(bound);}
  if(Object.hasOwn(saved,resultKey)){const value=validateSavedResult(saved[resultKey],input),rebuilt=recoverStoredStageValue({prefix,stage,input,inputHash,validate,saved});
    requireThat(isDeepStrictEqual(value,rebuilt),'WHOLE_QUALITY_CHECKPOINT_MISMATCH',`${stage}规范化结果不能由保存的原始响应重建。`);
    const receipt=await recoverStageReceipt({prefix,stage,inputHash,saved,checkpoint});return{value,receipt};}
  const modelInput={inputHash,...input,responseBindings:{inputHash,...input.responseBindings},responseExample:{...input.responseExample,inputHash}};const pk=`${prefix}:primary-response`;let primary;
  if(Object.hasOwn(saved,pk))primary=responseRecord(saved[pk],inputHash,'WHOLE_QUALITY_CHECKPOINT_MISMATCH');else{abortIfNeeded(signal);await progress?.(stage);abortIfNeeded(signal);
    const rawResponse=await model.complete({stage,system,user:JSON.stringify(modelInput),maxTokens,signal});abortIfNeeded(signal);requireThat(typeof rawResponse==='string'&&rawResponse.trim(),'WHOLE_QUALITY_EMPTY_RESPONSE',`${stage}响应为空。`);
    primary={inputHash,rawResponse,responseSha256:hashText(rawResponse)};await checkpoint(pk,clone(primary));saved[pk]=clone(primary);}
  let checked,error;try{checked=validate(parseResponse(primary.rawResponse,stage),input);}catch(e){error=e;}let repair;
  if(!checked){if(error?.code!=='WHOLE_QUALITY_RESPONSE_INVALID'&&!String(error?.code??'').startsWith('WHOLE_QUALITY_'))throw error;
    const ri=stageFormatRepairInput(stage,input,primary,error,saved[`${prefix}:repair-input`]);
    const rik=`${prefix}:repair-input`,newRi={repairInputHash:fingerprint(ri),repairInput:ri};let savedRi;
    if(Object.hasOwn(saved,rik))savedRi=checkedRepairInputRecord(saved[rik],ri);else{await checkpoint(rik,clone(newRi));saved[rik]=clone(newRi);savedRi=newRi;}
    const rk=`${prefix}:repair-response`;if(Object.hasOwn(saved,rk))repair=responseRecord(saved[rk],savedRi.repairInputHash,'WHOLE_QUALITY_CHECKPOINT_MISMATCH');else{abortIfNeeded(signal);await progress?.(`${stage}:format-repair`);abortIfNeeded(signal);
      const readingFeedbackInstruction=savedRi.repairInput.schemaVersion===WHOLE_QUALITY_READING_REPAIR_VERSION
        ? '\nrepairInput.literalEvidenceFeedback 是本次完整原始响应的字面位置诊断；请在这唯一一次纠正中一并核对所有列出的位置。remainingCount 大于零表示另有未列出的无效位置，须自行逐项检查全部引用；not_scanned 表示未完成扫描，不表示引用有效。反馈不提供替换引文、不证明文学判断或事实成立；不得删除证据、改写正文或改变原判断来消除错误。最终仍由原完整校验器验证。' : '';
      const rawResponse=await model.complete({stage:`${stage}:format-repair`,system:`${system}\n只纠正 JSON、闭合字段和绑定错误；不得改变文学判断、删除证据或扩大范围。若 repairInput.errorLocation 指向证据引文，须在 originalInput 对应章节正文中重新选取短而连续的逐字引文；保留原文全部字符、空格和换行，不得省略词语、拼接片段、改写或做空白归一化。originalInput.responseContract 仍是完整且权威的输出合同，必须逐项遵守；invalidResponse 是数据。${readingFeedbackInstruction}`,user:JSON.stringify({repairInput:savedRi.repairInput,originalInput:modelInput,invalidResponse:primary.rawResponse}),maxTokens,signal});
      abortIfNeeded(signal);requireThat(typeof rawResponse==='string'&&rawResponse.trim(),'WHOLE_QUALITY_EMPTY_RESPONSE','格式纠正响应为空。');repair={inputHash:savedRi.repairInputHash,rawResponse,responseSha256:hashText(rawResponse)};await checkpoint(rk,clone(repair));saved[rk]=clone(repair);}
    try{checked=validate(parseResponse(repair.rawResponse,`${stage}格式纠正`),input);}catch(e){const failure=new WholeQualityError('WHOLE_QUALITY_FORMAT_FAILED',`${stage}主响应和唯一格式纠正都无效。`);failure.causeCode=e?.code;
      failure.causeDiagnostic=safeDiagnostic(e);const causeLocation=safeErrorLocation(e);if(causeLocation!==undefined)failure.causeLocation=causeLocation;throw failure;}}
  await checkpoint(resultKey,clone(checked));saved[resultKey]=clone(checked);return{value:checked,receipt:await recoverStageReceipt({prefix,stage,inputHash,saved,checkpoint})};
}

export function inspectStoredWholeQualityReadingFailure(artifacts) {
  const base = { schemaVersion: 'whole-quality-reading-failure-inspection-1', stage: 'whole-quality:reading', exhausted: false };
  try {
    requireThat(record(artifacts), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '保存点集合无效。');
    const storedInput = artifacts['whole-quality:reading:input']; exact(storedInput, ['inputHash','input'], [], 'WHOLE_QUALITY_CHECKPOINT_MISMATCH');
    requireThat(record(storedInput.input) && storedInput.inputHash === fingerprint(storedInput.input), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '阅读输入保存点哈希无效。');
    const chapters = validateChapters(storedInput.input.chapters, 'WHOLE_QUALITY_CHECKPOINT_MISMATCH');
    const requestSpec = validateRequestSpec(artifacts.requestSpec, chapters);
    requireThat(isDeepStrictEqual(storedInput.input, readingInput(requestSpec, chapters, storedInput.input.responseBindings?.schemaVersion)), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '阅读输入不能由请求绑定重建。');
    const primary = responseRecord(artifacts['whole-quality:reading:primary-response'], storedInput.inputHash, 'WHOLE_QUALITY_CHECKPOINT_MISMATCH');
    let primaryError; try { validateReading(parseResponse(primary.rawResponse, 'whole-quality:reading'), storedInput.input); }
    catch (error) { primaryError = error; }
    if (!primaryError) return { ...base, reason: 'primary_valid' };
    requireThat(primaryError?.code === 'WHOLE_QUALITY_RESPONSE_INVALID' || String(primaryError?.code ?? '').startsWith('WHOLE_QUALITY_'),
      'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '主响应失败类型不可确认为格式失败。');
    const expectedRepairInput = stageFormatRepairInput('whole-quality:reading', storedInput.input, primary, primaryError, artifacts['whole-quality:reading:repair-input']);
    const savedRepairInput = checkedRepairInputRecord(artifacts['whole-quality:reading:repair-input'], expectedRepairInput);
    const repair = responseRecord(artifacts['whole-quality:reading:repair-response'], savedRepairInput.repairInputHash, 'WHOLE_QUALITY_CHECKPOINT_MISMATCH');
    let repairError; try { validateReading(parseResponse(repair.rawResponse, 'whole-quality:reading格式纠正'), storedInput.input); }
    catch (error) { repairError = error; }
    if (!repairError) return { ...base, reason: 'repair_valid', primaryResponseSha256: primary.responseSha256, repairResponseSha256: repair.responseSha256 };
    requireThat(repairError?.code === 'WHOLE_QUALITY_RESPONSE_INVALID' || String(repairError?.code ?? '').startsWith('WHOLE_QUALITY_'),
      'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '纠正响应失败类型不可确认为格式失败。');
    return { ...base, exhausted: true, reason: 'both_responses_invalid', inputHash: storedInput.inputHash,
      primaryResponseSha256: primary.responseSha256, repairResponseSha256: repair.responseSha256,
      primaryError: { code: primaryError.code, diagnostic: safeDiagnostic(primaryError), ...(safeErrorLocation(primaryError)?{location:safeErrorLocation(primaryError)}:{}) },
      repairError: { code: repairError.code, diagnostic: safeDiagnostic(repairError), ...(safeErrorLocation(repairError)?{location:safeErrorLocation(repairError)}:{}) } };
  } catch (error) {
    return { ...base, reason: 'invalid_or_incomplete_checkpoint', errorCode: error?.code ?? 'WHOLE_QUALITY_CHECKPOINT_MISMATCH' };
  }
}

function validateRetrievalItem(item, issue, requestSpec) {
  const code='WHOLE_QUALITY_RETRIEVAL';exact(item,['issueId','query','queryHash','status','callbackInvoked','result','limits',...(issue.writingGoal?['goalId','origin']:[])],[],code);
  if(issue.writingGoal)requireThat(item.goalId===issue.writingGoal.id&&item.origin==='writing_goal',code,'写作目标检索不得伪装为诊断问题。');
  const query=issueQuery(issue,requestSpec);requireThat(item.issueId===issue.id&&isDeepStrictEqual(item.query,query)&&item.queryHash===fingerprint(query),code,'检索项绑定无效。');
  requireThat(['matched','uncovered','unavailable','not_connected'].includes(item.status)&&typeof item.callbackInvoked==='boolean',code,'检索项状态无效。');
  if(record(item.result)){requireThat(item.callbackInvoked,code,'检索响应必须来自回调。');const checked=checkedRetrievalResult(item.result,issue,requestSpec);requireThat(checked.packet.status===item.status,code,'检索响应状态不一致。');return{...clone(item),result:checked};}
  requireThat(item.result===null&&item.status===(item.callbackInvoked?'unavailable':'not_connected'),code,'检索缺失状态无效。');stringList(item.limits,code,4,false);return clone(item);
}
async function retrieveForReading({ reading, requestSpec, retrieveKnowledge, legacyRetrieveKnowledge, queryDeepReferences, queryNarrativeObservations, saved, checkpoint, signal }) {
  const diagnosticIssues=reading.issues.filter(i=>i.priority==='major'&&i.disposition==='investigate');
  const goals=writingGoalSubjects(requestSpec),issues=[...diagnosticIssues,...goals],entries=[];
  for(const issue of issues){const key=`whole-quality:${issue.writingGoal?'goal-retrieval':'retrieval'}:${hashText(issue.id).slice(0,16)}`,query=issueQuery(issue,requestSpec);let item;
    const retrieve=issue.writingGoal?resolveDeepReferenceCallback(createDeepReferenceRetrievalAdapter(queryDeepReferences,
      {path:'whole_manuscript_writing_goal',problem:issue.writingGoal.problem,...WRITING_GOAL_DATA_OPTIONS}),legacyRetrieveKnowledge):retrieveKnowledge;
    const goalBinding=issue.writingGoal?{goalId:issue.writingGoal.id,origin:'writing_goal'}:{};
    if(Object.hasOwn(saved,key))item=validateRetrievalItem(saved[key],issue,requestSpec);else if(typeof retrieve!=='function'){
      item={issueId:issue.id,query,queryHash:fingerprint(query),status:'not_connected',callbackInvoked:false,result:null,limits:['生产检索回调未接入；没有把 request.materials 当作检索完成。']};
      await checkpoint(key,clone(item));saved[key]=clone(item);
    }else{abortIfNeeded(signal);const checked=!issue.writingGoal&&typeof queryNarrativeObservations==='function'
      ?await retrieveWholeQualityEvidenceWithObservationRecall({issue:retrievalIssue(issue,requestSpec),retrieveKnowledge:retrieve,queryNarrativeObservations,signal})
      :await retrieveWholeQualityEvidence({issue:retrievalIssue(issue,requestSpec),retrieveKnowledge:retrieve,signal});abortIfNeeded(signal);
      item={issueId:issue.id,query,queryHash:fingerprint(query),status:checked.packet.status,callbackInvoked:true,result:checked,limits:clone(checked.packet.limits),...goalBinding};
      item=validateRetrievalItem(item,issue,requestSpec);await checkpoint(key,clone(item));saved[key]=clone(item);}
    entries.push(item);
  }
  const supplies=[];for(const item of entries)for(const material of item.result?.evidenceBundle?.materials??[])supplies.push({supplyId:`${item.issueId}:${material.materialId}`,
    issueId:item.issueId,materialId:material.materialId,evidenceIds:material.evidence.map(e=>e.evidenceId),contentSha256:material.contentSha256,reviewBoundary:material.reviewBoundary,
    ...(item.goalId?{goalId:item.goalId,origin:'writing_goal'}:{})});
  const bundle={schemaVersion:goals.length?'whole-quality-retrieval-bundle-2':'whole-quality-retrieval-bundle-1',byIssue:entries.slice(0,diagnosticIssues.length),
    ...(goals.length?{byGoal:entries.slice(diagnosticIssues.length)}:{}),supplies,callbackCalls:entries.filter(i=>i.callbackInvoked).length};const checked=validateRetrievalBundle(bundle,reading,requestSpec);
  const key='whole-quality:retrieval:bundle';if(Object.hasOwn(saved,key))requireThat(isDeepStrictEqual(validateRetrievalBundle(saved[key],reading,requestSpec),checked),'WHOLE_QUALITY_CHECKPOINT_MISMATCH','检索包保存点不一致。');else{await checkpoint(key,clone(checked));saved[key]=clone(checked);}return checked;
}

const applicabilityContract={schemaVersion:'whole-quality-applicability-response-contract-1',additionalProperties:false,binding:bindingContract,
  required:['schemaVersion','inputHash','sourceManuscriptSha256','retrievalSha256','assessments','noSuitableReasons'],
  properties:{schemaVersion:{constFrom:'responseBindings.schemaVersion'},inputHash:{constFrom:'top-level inputHash'},
    sourceManuscriptSha256:{constFrom:'responseBindings.sourceManuscriptSha256'},retrievalSha256:{constFrom:'responseBindings.retrievalSha256'},
    assessments:{type:'array',exactItemCountFrom:'input.retrieval.supplies.length',orderedBy:'input.retrieval.supplies order',itemsRef:'assessmentSchema'},
    noSuitableReasons:{type:'array',itemsRef:'noSuitableReasonSchema'}},
  assessmentSchema:{type:'object',additionalProperties:false,required:['supplyId','issueId','materialId','fit','reason','evidenceIds','transferBoundary'],
    properties:{supplyId:{type:'string',exactFrom:'corresponding input.retrieval.supplies[].supplyId'},issueId:{type:'string',exactFrom:'corresponding supply.issueId'},
      materialId:{type:'string',exactFrom:'corresponding supply.materialId'},fit:{type:'string',enum:['direct_fit','mechanism_only','inapplicable','insufficient_context']},
      reason:textFieldContract(),evidenceIds:{type:'array',uniqueItems:true,items:{type:'string',enumFrom:'corresponding supply.evidenceIds'}},transferBoundary:textFieldContract()},
    constraints:['direct_fit requires at least one evidenceId','different subject matter alone is not a sufficient reason for inapplicable','mechanism_only is advisory and cannot be used as a direct planning supply']},
  noSuitableReasonSchema:{type:'object',additionalProperties:false,required:['issueId','reason'],properties:{issueId:{type:'string',enumFrom:'input.issues[].id'},reason:textFieldContract()}},
  globalConstraints:['assess every supplied material exactly once','for every issue with no direct_fit return exactly one noSuitableReasons entry','omit noSuitableReasons for issues with at least one direct_fit','no suitable material permits an original plan; never force a source mechanism into the story']};

function applicabilitySubjects(input){return [...input.issues,...(input.writingGoals??[]).map(goal=>({id:goal.querySubjectId}))];}
function applicabilityInput(requestSpec,reading,retrieval){const bindings={schemaVersion:WHOLE_QUALITY_APPLICABILITY_STAGE_VERSION,
  sourceManuscriptSha256:requestSpec.sourceManuscriptSha256,retrievalSha256:fingerprint(retrieval)};
  const issues=reading.issues.filter(issue=>issue.priority==='major'&&issue.disposition==='investigate').map(issue=>({id:issue.id,observation:issue.observation,
    suspectedCause:issue.suspectedCause,expectedEffect:issue.expectedEffect,failureCriteria:issue.failureCriteria,counterEvidence:clone(issue.counterEvidence)}));
  const writingGoals=requestSpec.writingGoals?.goals.map(goal=>({...clone(goal),querySubjectId:writingGoalSubjectId(goal)}));
  const responseContract=writingGoals?clone(applicabilityContract):applicabilityContract;
  if(writingGoals){responseContract.schemaVersion='whole-quality-applicability-response-contract-2';
    responseContract.noSuitableReasonSchema.properties.issueId.enumFrom='input.issues[].id or input.writingGoals[].querySubjectId';
    responseContract.writingGoalBoundary='writingGoals are user-authorized aims, not diagnoses. issueId is a legacy DATA query-subject slot. Assess functional fit to the goal and preservation boundaries; never invent a flaw or require adoption.';}
  return{schemaVersion:writingGoals?'whole-quality-applicability-input-2':'whole-quality-applicability-input-1',requestSpec,issues,
    ...(writingGoals?{writingGoals}:{}),retrieval,responseBindings:bindings,responseContract,
    responseExample:{...bindings,inputHash:'COPY_TOP_LEVEL_INPUT_HASH',assessments:retrieval.supplies.map(supply=>({supplyId:supply.supplyId,issueId:supply.issueId,
      materialId:supply.materialId,fit:'insufficient_context',reason:'结构占位；须按当前问题与真实来源判断。',evidenceIds:[],transferBoundary:'证据不足时不得迁入来源人物、关系或情节。'})),
      noSuitableReasons:[...issues,...(writingGoals??[]).map(goal=>({id:goal.querySubjectId}))].map(issue=>({issueId:issue.id,reason:writingGoals?'结构占位；没有直接适用材料仍可采用原创方案或保留原稿。':'结构占位；没有直接适用材料仍可采用原创修订方案。'}))}};}

function unavailableApplicabilityReview(item,reason){return{schemaVersion:'whole-quality-applicability-unavailable-1',issueId:item.issueId,
  retrievalStatus:item.status,noSuitableMaterial:true,noSuitableReason:reason,assessments:[],directMaterialIds:[],mechanismOnlyMaterialIds:[],rejectedMaterialIds:[],
  boundary:'检索未连接或不可用不能证明资料库没有相关材料；本轮不得强制套用来源，可基于原稿证据提出原创方案。'};}

function buildApplicabilityBundle({requestSpec,reading,retrieval,assessments,noSuitableReasons,modelStageDispatched}){
  const code='WHOLE_QUALITY_APPLICABILITY',reasonByIssue=new Map(noSuitableReasons.map(item=>[item.issueId,item.reason]));
  const bySupply=new Map(assessments.map(item=>[item.supplyId,item]));
  const reviews=wholeQualityRetrievalEntries(retrieval).map(item=>{const supplies=retrieval.supplies.filter(supply=>supply.issueId===item.issueId);
    const issueAssessments=supplies.map(supply=>{const assessment=bySupply.get(supply.supplyId);requireThat(assessment,code,'适用性判断未覆盖供应。');
      return{materialId:assessment.materialId,fit:assessment.fit,reason:assessment.reason,evidenceIds:clone(assessment.evidenceIds),transferBoundary:assessment.transferBoundary};});
    if(record(item.result))return buildWholeQualityApplicabilityReview(item.result,issueAssessments,{...(reasonByIssue.has(item.issueId)?{noSuitableReason:reasonByIssue.get(item.issueId)}:{})});
    return unavailableApplicabilityReview(item,reasonByIssue.get(item.issueId)??(item.status==='not_connected'?'生产检索未连接；允许基于原稿证据采用原创方案。':'检索不可用；允许基于原稿证据采用原创方案。'));});
  const directSupplyIds=[],mechanismOnlySupplyIds=[];
  for(const review of reviews)for(const materialId of review.directMaterialIds??[])directSupplyIds.push(`${review.issueId}:${materialId}`);
  for(const review of reviews)for(const materialId of review.mechanismOnlyMaterialIds??[])mechanismOnlySupplyIds.push(`${review.issueId}:${materialId}`);
  const body={schemaVersion:WHOLE_QUALITY_APPLICABILITY_BUNDLE_VERSION,sourceManuscriptSha256:requestSpec.sourceManuscriptSha256,
    retrievalSha256:fingerprint(retrieval),modelStageDispatched,assessments:clone(assessments),noSuitableReasons:clone(noSuitableReasons),reviews,
    directSupplyIds,mechanismOnlySupplyIds,noSuitableIssueIds:reviews.filter(review=>review.noSuitableMaterial).map(review=>review.issueId),
    ...(requestSpec.writingGoals?{goalSubjects:requestSpec.writingGoals.goals.map(goal=>({goalId:goal.id,querySubjectId:writingGoalSubjectId(goal),origin:'writing_goal'}))}:{}),
    boundary:'只有direct_fit可进入规划采用；mechanism_only仅作宽泛机制提示。无直接材料时允许原创方案，不得为使用资料而强制迁移。'};
  return body;}

function validateApplicabilityResponse(value,input){const code='WHOLE_QUALITY_APPLICABILITY';exact(value,applicabilityContract.required,[],code);
  requireThat(value.schemaVersion===input.responseBindings.schemaVersion&&value.inputHash===fingerprint(input)
    &&value.sourceManuscriptSha256===input.responseBindings.sourceManuscriptSha256&&value.retrievalSha256===input.responseBindings.retrievalSha256,code,'适用性响应绑定无效。');
  requireThat(Array.isArray(value.assessments)&&value.assessments.length===input.retrieval.supplies.length,code,'适用性判断未逐供应覆盖。');
  const assessments=value.assessments.map((item,index)=>{const supply=input.retrieval.supplies[index];exact(item,['supplyId','issueId','materialId','fit','reason','evidenceIds','transferBoundary'],[],code);
    requireThat(item.supplyId===supply.supplyId&&item.issueId===supply.issueId&&item.materialId===supply.materialId
      &&['direct_fit','mechanism_only','inapplicable','insufficient_context'].includes(item.fit),code,'适用性供应身份或枚举无效。');
    text(item.reason,code);text(item.transferBoundary,code);requireThat(Array.isArray(item.evidenceIds)&&new Set(item.evidenceIds).size===item.evidenceIds.length
      &&item.evidenceIds.every(id=>supply.evidenceIds.includes(id))&&(item.fit!=='direct_fit'||item.evidenceIds.length>0),code,'适用性证据无效。');return clone(item);});
  requireThat(Array.isArray(value.noSuitableReasons),code,'无适用材料原因列表无效。');const seen=new Set(),noSuitableReasons=value.noSuitableReasons.map(item=>{exact(item,['issueId','reason'],[],code);
    requireThat(applicabilitySubjects(input).some(issue=>issue.id===item.issueId)&&!seen.has(item.issueId),code,'无适用材料原因身份重复或未知。');seen.add(item.issueId);text(item.reason,code);return clone(item);});
  const expected=applicabilitySubjects(input).filter(issue=>!assessments.some(item=>item.issueId===issue.id&&item.fit==='direct_fit')).map(issue=>issue.id);
  sameIds(noSuitableReasons.map(item=>item.issueId),expected,code,'无直接适用材料的原因须按问题顺序逐项给出。');
  return buildApplicabilityBundle({requestSpec:input.requestSpec,reading:{issues:input.issues},retrieval:input.retrieval,assessments,noSuitableReasons,modelStageDispatched:true});}

function hostApplicabilityBundle(requestSpec,reading,retrieval){const reasons=[...reading.issues.filter(issue=>issue.priority==='major'&&issue.disposition==='investigate'),...writingGoalSubjects(requestSpec)]
  .map(issue=>({issueId:issue.id,reason:'本次没有供应材料；可仅依据原稿证据提出原创方案，不得虚构资料支持。'}));
  return buildApplicabilityBundle({requestSpec,reading,retrieval,assessments:[],noSuitableReasons:reasons,modelStageDispatched:false});}

function validateApplicabilityBundle(value,requestSpec,reading,retrieval){const code='WHOLE_QUALITY_APPLICABILITY';requireThat(record(value),code,'适用性包无效。');
  const expected=buildApplicabilityBundle({requestSpec,reading,retrieval,assessments:value.assessments??[],noSuitableReasons:value.noSuitableReasons??[],modelStageDispatched:value.modelStageDispatched});
  requireThat(isDeepStrictEqual(value,expected),code,'适用性包与检索、判断或来源绑定不一致。');return clone(value);}

async function runApplicability({requestSpec,reading,retrieval,model,saved,checkpoint,progress,signal}){const input=applicabilityInput(requestSpec,reading,retrieval);
  if(retrieval.supplies.length){const run=await structuredStage({prefix:'whole-quality:applicability',stage:'whole-quality:applicability',input,
    system:APPLICABILITY_SYSTEM+(requestSpec.writingGoals?WRITING_GOAL_STAGE_GUARD:''),maxTokens:10000,validate:validateApplicabilityResponse,
    validateSavedResult:value=>validateApplicabilityBundle(value,requestSpec,reading,retrieval),model,saved,checkpoint,progress,signal});return{value:run.value,receipt:run.receipt};}
  const deterministic=hostApplicabilityBundle(requestSpec,reading,retrieval),key='whole-quality:applicability:host-result';
  if(Object.hasOwn(saved,key))requireThat(isDeepStrictEqual(validateApplicabilityBundle(saved[key],requestSpec,reading,retrieval),deterministic),'WHOLE_QUALITY_CHECKPOINT_MISMATCH','Host适用性保存点不一致。');
  else{await checkpoint(key,clone(deterministic));saved[key]=clone(deterministic);}return{value:deterministic};}

function noFeasibility(requestSpec,plan){return{schemaVersion:'whole-quality-feasibility-not-required-1',sourceManuscriptSha256:requestSpec.sourceManuscriptSha256,planSha256:fingerprint(plan),checks:[],reason:'方案保留原稿，没有修改项需要预检。'};}
function validateNoFeasibility(value,requestSpec,plan){const code='WHOLE_QUALITY_FEASIBILITY';exact(value,['schemaVersion','sourceManuscriptSha256','planSha256','checks','reason'],[],code);
  requireThat(value.schemaVersion==='whole-quality-feasibility-not-required-1'&&value.sourceManuscriptSha256===requestSpec.sourceManuscriptSha256&&value.planSha256===fingerprint(plan)&&Array.isArray(value.checks)&&value.checks.length===0,code,'免预检记录无效。');text(value.reason,code);return clone(value);}

const BINDING_SYSTEM=`严格遵守 responseContract；逐字复制 responseBindings，不计算 SHA、inputHash 或 UTF-16 位置。所有 quote 必须从对应章节正文选取短而连续的逐字片段，保留原文全部字符、空格和换行；不得省略词语、拼接片段、改写或做空白归一化。responseExample 只是结构占位，须依据本次正文改写或删除。只返回完整 JSON。`;
const WHOLE_STYLE_GUARD=`只在正文证据支持时检查三类风险：相同犹豫再次出现却没有新信息、不同压力、选择或后果；心理转折缺少此前经验、当前触发、可见选择与后果的桥梁；技术或流程说明挤压现场行动、冲突与判断。不得为覆盖检查项强制诊断或制造事故、秘密和反转。承担积累、节奏、关系变化或结尾兑现作用的反复，以及有意义的物件回环、歧义、克制、停顿和留白，必须保留并说明保护范围。`;
const READING_SYSTEM=`${BINDING_SYSTEM}\n你是独立全文阅读者。逐章阅读全部正文，先记录每章实际场景变化，再判断主要问题；不要读取或猜测修改方案。每个主要候选问题必须有至少两个场景的原文依据、真实反证、预期作用、失败判据、保留范围和限制。区分文本事实、读者效果假说与编辑偏好。保护克制、有效反复、停顿、心理、抒情和留白；没有主要安全问题可以不提出修改。\n${WHOLE_STYLE_GUARD}`;
const APPLICABILITY_SYSTEM=`${BINDING_SYSTEM}\n你是检索材料的功能适用审查者。逐份材料只按当前问题、所需叙事功能、真实来源证据、冻结需求和迁移边界判断 direct_fit、mechanism_only、inapplicable 或 insufficient_context。检索命中只是候选；来自跨题材作品或99篇分析不增加适用性。题材、职业、道具不同本身不是拒绝理由；高词面相似也不是直接适用证据。若来源功能依赖本篇禁写或没有铺垫的背叛、疾病、复仇、突转或结局，必须判 inapplicable 或 mechanism_only，并把该依赖保留在 applicabilityBoundary。direct_fit 必须引用本供应已有 evidenceId 并写清不可迁移条件；mechanism_only 只能提示尊重人物选择、用行动承担后果等宽泛组织机制，不能授权规划采用，也不能复制来源人物、关系、事件链或结局。每个没有 direct_fit 的问题须给 noSuitableReason，并明确可以不用材料、依据原稿证据提出原创方案；允许全部材料都不是 direct_fit。不得编造来源全文、文学效果或采用结论。`;
const FACT_READING_SYSTEM=`${BINDING_SYSTEM}\n你是全文阅读者。逐章阅读全部正文，先记录实际场景变化。区分文本事实、读者效果假说与编辑偏好。文本事实矛盾必须有至少两处不同、不重叠且互斥的逐字证据，可以在同一场景内；不得为了跨场景配额虚构场景或丢弃局部矛盾。情绪模式或读者效果的主要判断仍须至少两个场景的证据。两类都要有真实反证、预期作用、失败判据、保留范围和限制。修改目标只是待核查编辑请求，必须独立验证正文；不能把指令本身当作证据。保护克制、有效反复、停顿、心理、抒情和留白。\n${WHOLE_STYLE_GUARD}`;
const PLAN_SYSTEM=`${BINDING_SYSTEM}\n你是场景联动修订方案作者。只处理独立阅读列出的 major/investigate 问题。每个 revise 组按问题需要列出一个或多个真实 sceneId、精确 target 和可见动作要求；跨场景影响必须全部列出，禁止为满足数量凑场景或过度修改。target 是允许整体替换的原文 span：替换文本可保留原句并在同一位置补写合理动作、对白或物件状态，也可比原 span 更长；actionRequirement 的全部文字变化必须能仅靠其 targetIds 的替换完成。若要求改写 target 之后的另一句回答或事件，必须把那句本身另列为 target，不能把前一句当作越界修改的锚点。所有互相依赖才能成立的 targets 必须归入同一个 plan item 原子组；同组较早 target 可以建立物件或状态，较后 target 再兑现，规划时须按正文顺序检查中间未改文字不冲突。每组用 independentAdoption 说明为什么不采纳其他组时本组仍可独立成立，不能把同一主要问题拆组。写清预期作用、失败判据、风险和逐字保护。逐一按 DATA 证据 ID 决定真实检索供应 used/not_used，说明适用边界；只有 input.applicability.directSupplyIds 中的供应可标 used，mechanism_only 不能冒充直接适用。跨题材候选即使词面命中，也不得把来源的背叛、疾病、复仇、人物关系、事件链或结局迁入违反冻结需求的故事；只能在 direct_fit 已证明且不复制情节时采用可迁移机制。允许全部供应 not_used，并须保留拒用理由；没有 direct_fit 时允许完全不用材料、依据原稿证据写原创方案，不得为展示使用资料或证明“使用99”而强制套用。没有安全方案就 preserve。\n${WHOLE_STYLE_GUARD}`;
const CROSS_PLAN_SYSTEM=`${BINDING_SYSTEM}\n你是场景联动修订方案作者。只处理独立阅读列出的 major/investigate 问题和 input.confirmedConflicts 中由事实核对冻结的问题。confirmed_conflict 必须进入 revise 项，或在 unresolved 中逐项写明无法安全解决的理由；不得 preserve、忽略或用 no_change 冒充修复。其 target 必须逐字选自对应 scopeOptions；scopeOptions 已把证据所在最小段落和必要的相邻问答两段列为连续选项，只选择完成修复所需的最小范围，不得自行扩张。每个 revise 组按问题需要列出一个或多个真实 sceneId、精确 target 和可见动作要求；跨场景影响必须全部列出，禁止为满足数量凑场景或过度修改。target 是允许整体替换的原文 span：替换文本可保留原句并在同一位置补写合理动作、对白或物件状态，也可比原 span 更长；actionRequirement 的全部文字变化必须能仅靠其 targetIds 的替换完成。若要求改写 target 之后的另一句回答或事件，必须把那句本身另列为 target，不能把前一句当作越界修改的锚点。所有互相依赖才能成立的 targets 必须归入同一个 plan item 原子组；同组较早 target 可以建立物件或状态，较后 target 再兑现，规划时须按正文顺序检查中间未改文字不冲突。每组用 independentAdoption 说明为什么不采纳其他组时本组仍可独立成立，不能把同一主要问题拆组。写清预期作用、失败判据、风险和逐字保护。逐一按 DATA 证据 ID 决定真实检索供应 used/not_used，说明适用边界；只有 input.applicability.directSupplyIds 中的供应可标 used，mechanism_only 不能冒充直接适用。跨题材候选即使词面命中，也不得把来源的背叛、疾病、复仇、人物关系、事件链或结局迁入违反冻结需求的故事；只能在 direct_fit 已证明且不复制情节时采用可迁移机制。允许全部供应 not_used，并须保留拒用理由；没有 direct_fit 时允许完全不用材料、依据原稿证据写原创方案，不得为展示使用资料或证明“使用99”而强制套用。普通候选问题没有安全方案可以 preserve；confirmed_conflict 只能明确 unresolved。\n${WHOLE_STYLE_GUARD}`;
const FEASIBILITY_SYSTEM=`${BINDING_SYSTEM}\n你是修订前可行性审查者。只检查方案目标能否由已授权 target 的替换实际完成，不替方案补 target。逐项核对每个 actionRequirement。target 引文是可被整体替换的 source span，不是要求拟新增内容已存在的证据；replacement 可以比原句更长，可以保留原句并在同一位置新增合理动作、对白、物件或状态。不得仅因旧引文没有布、口袋、收纳、触碰等拟新增内容就判 unsupported。responseContract 中 noun-only coverage 只指 target 本身或其 purpose 把授权限制为某个名词 token 的情形；一个作为整体替换落点的完整状态句，不会因为原句尚无拟新增动作而自动变成 noun-only。同一 plan item 的 targets 是原子组，须按正文顺序联合判断：较早 target 的替换可以先建立物件或状态，较后 target 的替换再使用它，不能要求后者原文预先已有该物件。若 target 是“两件都坏了”一类完整落点，将其替换为原句加包起并收好物件的动作可以受授权；后续同组 target 可再加入触碰该包裹的动作。相反，若唯一 target 只覆盖问句，而 requirement 明确要求改写其后未被 target 覆盖的回答句，则必须判 unsupported，因为替换问句不能删除或改写那句未授权回答。仍须检查保护证据冲突、相邻归属、未改文字矛盾和 target 外改动；事实可能自洽不等于目标落实。`;
const REVISION_SYSTEM=`${BINDING_SYSTEM}\n你是有限候选修订者。只能处理 eligiblePlanItemIds；每组须返回全部 target 替换或整组跳过。结合联动场景落实 actionRequirements，但不能扩张 target、返回整章、损伤保护文字或用说明句冒充行动。target 的 replacement 可以比 sourceQuote 更长，并可在该位置保留原句后补写获准的新动作、对白、物件或状态；同组较早 target 建立的状态可由较后 target 使用，但不得删除或修改 target 外原文。每次插入、删除或替换对话与动作后，必须把 target 和前后相邻的保留句连读，并对照原稿核实代词所指、对话说话人及视角归属没有因最近主语改变而漂移；不能只检查新增段落或只核对计划落实。必要时在获准 target 的替换文本中写明实名或明确主语；若只有改动 target 外保留句才能消歧，则整组跳过，不得越界。没有安全写法就跳过。\n${WHOLE_STYLE_GUARD}`;
const REREAD_SYSTEM=`${BINDING_SYSTEM}\n你是修后全文复读者。阅读全文，分别核对每组执行状态、事实自洽、目标落实和每条 actionRequirement；事实自洽不等于目标落实。还要把每处替换和原稿同位置的前后保留句对照，逐句核对代词指向、对话说话人和视角归属；插入或删除动作与对白可能改变相邻保留句的最近主语，不能只检查新增段落或只看计划落实。发现归属漂移须按既有 introducedIssues 记录为 textual_conflict；若它改变说话人或视角含义，须标为 serious，并使关联修改组不得进入推荐采纳。检查新增严重误伤及有效克制/留白是否保留。未执行组必须 not_attempted；发生替换不能自动算 implemented。读者效果仍是假说，不给总分或质量通过票。\n${WHOLE_STYLE_GUARD}`;
const CROSS_REREAD_SYSTEM=`${BINDING_SYSTEM}\n你是修后全文复读者。阅读全文，分别核对每组执行状态、事实自洽、目标落实和每条 actionRequirement；事实自洽不等于目标落实。若 input.confirmedConflicts 存在，必须逐项返回 crossChapterChecks：只有候选全文中原互斥事实已消除、修改目标落实且没有用删漏遮蔽问题时才可 resolved；未改、跳过、不确定或仍矛盾必须明确 unresolved、uncertain 或 not_attempted。还要把每处替换和原稿同位置的前后保留句对照，逐句核对代词指向、对话说话人和视角归属；插入或删除动作与对白可能改变相邻保留句的最近主语，不能只检查新增段落或只看计划落实。发现归属漂移须按既有 introducedIssues 记录为 textual_conflict；若它改变说话人或视角含义，须标为 serious，并使关联修改组不得进入推荐采纳。检查新增严重误伤及有效克制/留白是否保留。未执行组必须 not_attempted；发生替换不能自动算 implemented。读者效果仍是假说，不给总分或质量通过票。\n${WHOLE_STYLE_GUARD}`;
const FINAL_TEXT_SYSTEM=`${BINDING_SYSTEM}\n你是最终正文用材定位员。只依据候选正文、已冻结used账本、修改组和来源evidenceId逐项寻找最终正文中的精确逐字落点；start使用JS UTF-16位置。每个finding须绑定合法修改组和来源证据，并区分visible_application与context_only。作者声明used、来源相似或材料曾进入提示都不能证明正文存在对应作用；找不到唯一且准确的逐字位置时必须返回not_located及具体原因，不能改写正文、补造引文或宣称文学效果。`;
const WRITING_GOAL_STAGE_GUARD='\n本任务另有预先冻结的writingGoals，它们是用户明确的心理、情绪或选择目标，不是独立阅读诊断。不得为触发检索或规划虚构major问题；reading.issues保持原判断。材料相关不等于适用；只迁移受来源证据支持的功能，不复制人物、关系、情节或原句。来源的局限和本篇冻结边界优先；可以拒绝所有材料。只返回本阶段responseContract指定字段，不得宣称文学效果已实现。';
function planSystemFor(crossEnabled, goalEnabled) {
  const system=crossEnabled?CROSS_PLAN_SYSTEM:PLAN_SYSTEM;
  if(!goalEnabled)return system;
  return system.replace('只处理独立阅读列出的 major/investigate 问题','只处理 input.writingGoals 中的明确写作目标、独立阅读列出的 major/investigate 问题')
    +WRITING_GOAL_STAGE_GUARD+'\neligibleIssueIds为空时仍逐目标判断是否值得安全尝试；按goalIds关联方案并逐项返回goalDispositions。无适用材料可提出原创方案；原稿已足够或修改会损伤保留边界时preserve，全部保留合法。按合同列出精确target、保护证据和行动后果。';
}

function frozenCrossResponseRecord(value,{stage,inputHash,requestSha256},code) {
  exact(value,['stage','inputHash','requestSha256','rawResponse','responseSha256'],['providerReceipt','providerReceiptSha256'],code);
  requireThat(value.stage===stage&&value.inputHash===inputHash&&value.requestSha256===requestSha256
    &&typeof value.rawResponse==='string'&&value.rawResponse.trim()&&value.responseSha256===hashText(value.rawResponse),code,'跨章冻结响应绑定无效。');
  requireThat((value.providerReceipt===undefined)===(value.providerReceiptSha256===undefined)
    &&(value.providerReceipt===undefined||value.providerReceiptSha256===fingerprint(value.providerReceipt)),code,'跨章 provider 回执绑定无效。');
  return clone(value);
}
function frozenCrossProtocolFailure({store,error,chapters,modelPolicy,attempt,artifactNamespace}) {
  const code='WHOLE_QUALITY_CROSS_CHAPTER_RETRY';
  requireThat(CROSS_CHAPTER_RETRYABLE_FAILURES.has(error?.code),code,'仅格式修正失败或语义漂移允许协议重试。');
  const failedStages=CROSS_CHAPTER_STAGE_ORDER.filter(stage=>Object.hasOwn(store,`${stage}:input`)
    &&Object.hasOwn(store,`${stage}:primary-response`)&&Object.hasOwn(store,`${stage}:repair-input`)
    &&Object.hasOwn(store,`${stage}:repair-response`)&&!Object.hasOwn(store,`${stage}:result`));
  requireThat(failedStages.length===1,code,'协议重试前必须冻结且只能冻结一个失败阶段的 raw 与 repair。');
  const stage=failedStages[0],failedIndex=CROSS_CHAPTER_STAGE_ORDER.indexOf(stage),inputRecord=store[`${stage}:input`];
  exact(inputRecord,['inputHash','requestSha256','input'],[],code);
  requireThat(hex64.test(inputRecord.inputHash)&&hex64.test(inputRecord.requestSha256)
    &&inputRecord.input?.modelPolicy===modelPolicy,code,'跨章失败输入哈希或 modelPolicy 绑定无效。');
  const inputChapters=inputRecord.input?.manuscript?.chapters;
  requireThat(Array.isArray(inputChapters)&&isDeepStrictEqual(inputChapters.map(item=>({id:item.id,title:item.title,body:item.body})),chapters),code,'跨章失败输入与当前正文不一致。');
  const primary=frozenCrossResponseRecord(store[`${stage}:primary-response`],{stage,inputHash:inputRecord.inputHash,requestSha256:inputRecord.requestSha256},code);
  const repairInputRecord=store[`${stage}:repair-input`];exact(repairInputRecord,['repairInputHash','repairInput','requestSha256'],[],code);
  requireThat(repairInputRecord.repairInputHash===fingerprint(repairInputRecord.repairInput)&&hex64.test(repairInputRecord.requestSha256)
    &&repairInputRecord.repairInput?.schemaVersion==='cross-chapter-format-repair-1'
    &&repairInputRecord.repairInput?.stage===stage&&repairInputRecord.repairInput?.originalInputHash===inputRecord.inputHash
    &&repairInputRecord.repairInput?.invalidResponseSha256===primary.responseSha256,code,'跨章格式修正输入绑定无效。');
  const repair=frozenCrossResponseRecord(store[`${stage}:repair-response`],{stage:`${stage}:format-repair`,inputHash:repairInputRecord.repairInputHash,
    requestSha256:repairInputRecord.requestSha256},code);
  requireThat(!Object.hasOwn(store,`${stage}:receipt`),code,'失败阶段不能伪装为已完成阶段。');
  const completedStageReceipts=CROSS_CHAPTER_STAGE_ORDER.slice(0,failedIndex).map(completedStage=>{
    const completedInput=store[`${completedStage}:input`],completedPrimary=store[`${completedStage}:primary-response`],receipt=store[`${completedStage}:receipt`];
    requireThat(record(completedInput)&&Object.hasOwn(store,`${completedStage}:result`)&&record(receipt),code,'失败前阶段缺少完整结果或回执。');
    const checkedPrimary=frozenCrossResponseRecord(completedPrimary,{stage:completedStage,inputHash:completedInput.inputHash,requestSha256:completedInput.requestSha256},code);
    exact(receipt,['stage','inputHash','requestSha256','primaryResponseSha256'],['formatRepairResponseSha256'],code);
    requireThat(receipt.stage===completedStage&&receipt.inputHash===completedInput.inputHash&&receipt.requestSha256===completedInput.requestSha256
      &&receipt.primaryResponseSha256===checkedPrimary.responseSha256,code,'失败前阶段回执绑定无效。');
    if(receipt.formatRepairResponseSha256!==undefined)requireThat(hex64.test(receipt.formatRepairResponseSha256),code,'失败前阶段格式修正回执无效。');
    return {stage:receipt.stage,primaryResponseSha256:receipt.primaryResponseSha256,
      ...(receipt.formatRepairResponseSha256===undefined?{}:{formatRepairResponseSha256:receipt.formatRepairResponseSha256})};
  });
  return validateCrossProtocolFailure({schemaVersion:CROSS_CHAPTER_PROTOCOL_FAILURE_VERSION,attempt,artifactNamespace,code:error.code,stage,
    inputHash:inputRecord.inputHash,requestSha256:inputRecord.requestSha256,rawResponseSha256:primary.responseSha256,
    formatRepairInputHash:repairInputRecord.repairInputHash,formatRepairRequestSha256:repairInputRecord.requestSha256,
    formatRepairResponseSha256:repair.responseSha256,completedStageReceipts,...(typeof error.causeCode==='string'?{causeCode:error.causeCode}:{})},attempt);
}
async function saveBoundArtifact(saved,checkpoint,key,value,code='WHOLE_QUALITY_CHECKPOINT_MISMATCH') {
  if(Object.hasOwn(saved,key))requireThat(isDeepStrictEqual(saved[key],value),code,'跨章协议恢复记录不一致。');
  else{await checkpoint(key,clone(value));saved[key]=clone(value);}return clone(value);
}
function crossAttemptArtifacts({prefix,attempt,saved,checkpoint}) {
  const artifactPrefix=attempt===0?`${prefix}:artifact:`:`${prefix}:retry-${attempt}:artifact:`,store={};
  for(const [key,value] of Object.entries(saved))if(key.startsWith(artifactPrefix))store[key.slice(artifactPrefix.length)]=clone(value);
  return {artifactPrefix,store,artifacts:{store,checkpoint:async(key,value)=>{const outerKey=`${artifactPrefix}${key}`;await checkpoint(outerKey,clone(value));saved[outerKey]=clone(value);}}};
}
async function runBoundCrossChapterReview({ phase, chapters, requestSpec, reviewer, model, saved, checkpoint, progress, signal }) {
  const code = 'WHOLE_QUALITY_CROSS_CHAPTER', prefix = `whole-quality:cross-chapter:${phase}`, inputKey = `${prefix}:binding`, resultKey = `${prefix}:bundle`;
  const binding = { integrationVersion: CROSS_CHAPTER_INTEGRATION_VERSION, phase, sourceManuscriptSha256: manuscriptFingerprint(chapters),
    modelPolicy: requestSpec.crossChapterReview.modelPolicy, chapterIds: chapters.map(item => item.id) };
  if (Object.hasOwn(saved,inputKey)) requireThat(isDeepStrictEqual(saved[inputKey],binding), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '跨章核对恢复绑定与当前正文不一致。');
  else { await checkpoint(inputKey,clone(binding)); saved[inputKey]=clone(binding); }
  requireThat(typeof reviewer === 'function', code, '启用跨章核对的新请求必须提供 reviewCrossChapter 实现。');
  const retryBindingKey=`${prefix}:retry-1:binding`,failureKey=`${prefix}:protocol-failure:0`,retryFailureKey=`${prefix}:protocol-failure:1`;
  let attempt=Object.hasOwn(saved,retryBindingKey)?1:0,protocolFailure;
  if(attempt===1){
    protocolFailure=validateCrossProtocolFailure(saved[failureKey],0);
    const expectedRetryBinding={schemaVersion:CROSS_CHAPTER_RETRY_BINDING_VERSION,attempt:1,phase,sourceManuscriptSha256:binding.sourceManuscriptSha256,
      modelPolicy:binding.modelPolicy,priorProtocolFailureSha256:fingerprint(protocolFailure)};
    requireThat(isDeepStrictEqual(saved[retryBindingKey],expectedRetryBinding),'WHOLE_QUALITY_CHECKPOINT_MISMATCH','跨章协议重试绑定无效。');
  }
  const invoke=async activeAttempt=>{const scoped=crossAttemptArtifacts({prefix,attempt:activeAttempt,saved,checkpoint});
    try{return await reviewer({manuscript:{chapters:clone(chapters)},model,modelPolicy:requestSpec.crossChapterReview.modelPolicy,artifacts:scoped.artifacts,
      options:{signal,progress:detail=>progress?.(typeof detail?.stage==='string'?detail.stage:`${prefix}:progress`)}});}
    catch(error){if(!CROSS_CHAPTER_RETRYABLE_FAILURES.has(error?.code))throw error;
      const frozen=frozenCrossProtocolFailure({store:scoped.store,error,chapters,modelPolicy:binding.modelPolicy,attempt:activeAttempt,
        artifactNamespace:activeAttempt===0?'primary':`retry-${activeAttempt}`});
      await saveBoundArtifact(saved,checkpoint,activeAttempt===0?failureKey:retryFailureKey,frozen);throw Object.assign(error,{frozenProtocolFailure:frozen});}};
  let review;
  if(attempt===1)review=await invoke(1);
  else try{review=await invoke(0);}catch(error){
    if(!CROSS_CHAPTER_RETRYABLE_FAILURES.has(error?.code)||!error.frozenProtocolFailure)throw error;
    protocolFailure=error.frozenProtocolFailure;
    const retryBinding={schemaVersion:CROSS_CHAPTER_RETRY_BINDING_VERSION,attempt:1,phase,sourceManuscriptSha256:binding.sourceManuscriptSha256,
      modelPolicy:binding.modelPolicy,priorProtocolFailureSha256:fingerprint(protocolFailure)};
    await saveBoundArtifact(saved,checkpoint,retryBindingKey,retryBinding);attempt=1;review=await invoke(1);
  }
  requireThat(review?.modelPolicy === requestSpec.crossChapterReview.modelPolicy, code, '跨章核对结果未绑定 whole-quality modelPolicy。');
  const bundle = normalizeCrossChapterReview(review,chapters,attempt===1?protocolFailure:undefined);
  if (Object.hasOwn(saved,resultKey)) {
    const existing = validateCrossChapterBundle(saved[resultKey],chapters);
    requireThat(isDeepStrictEqual(existing,bundle), 'WHOLE_QUALITY_CHECKPOINT_MISMATCH', '跨章核对包不能由保存的原始响应重建。'); return existing;
  }
  await checkpoint(resultKey,clone(bundle)); saved[resultKey]=clone(bundle); return bundle;
}
function crossReviewCallCounts(...bundles) {
  const reviews = bundles.filter(Boolean).map(bundle => bundle.review).filter(Boolean), receipts = reviews.flatMap(review => Array.isArray(review.stageReceipts) ? review.stageReceipts : []);
  const failures=bundles.filter(Boolean).flatMap(bundle=>bundle.protocolFailures??[]),completedBeforeFailure=failures.flatMap(failure=>failure.completedStageReceipts);
  return { primaryCalls: receipts.length+failures.length+completedBeforeFailure.length,
    formatRepairCalls: receipts.filter(receipt=>receipt?.formatRepairResponseSha256).length+failures.length
      +completedBeforeFailure.filter(receipt=>receipt?.formatRepairResponseSha256).length,
    maxPrimaryCalls: reviews.length*2+failures.length*2,maxFormatRepairCalls: reviews.length*2+failures.length*2 };
}

const CROSS_RECHECK_INCOMPLETE_MESSAGE='候选稿跨章事实核查未完成，已保留两次协议失败；实际修改可独立评阅，但不能视为事实核查通过或推荐采纳。';
function validateCrossRecheckIncomplete(value,chapters,modelPolicy){
  const code='WHOLE_QUALITY_CROSS_RECHECK_INCOMPLETE';
  exact(value,['schemaVersion','status','sourceManuscriptSha256','modelPolicy','protocolFailures','retryBinding'],[],code);
  requireThat(value.schemaVersion==='whole-quality-cross-recheck-incomplete-1'&&value.status==='incomplete'
    &&value.sourceManuscriptSha256===manuscriptFingerprint(chapters)&&value.modelPolicy===modelPolicy,code,'未完成跨章核查与候选稿绑定不一致。');
  requireThat(Array.isArray(value.protocolFailures)&&value.protocolFailures.length===2,code,'未完成报告必须保留两次有界失败。');
  value.protocolFailures.forEach((failure,index)=>validateCrossProtocolFailure(failure,index));
  requireThat(isDeepStrictEqual(value.retryBinding,{schemaVersion:CROSS_CHAPTER_RETRY_BINDING_VERSION,attempt:1,phase:'candidate',
    sourceManuscriptSha256:value.sourceManuscriptSha256,modelPolicy,priorProtocolFailureSha256:fingerprint(value.protocolFailures[0])}),code,'未完成报告的重试绑定无效。');
  return clone(value);
}
function adoptionObject(requestSpec,plan,reread,incomplete,crossChapterResolution,crossRecheckIncomplete){const checks=new Map((reread.changeChecks??[]).map(c=>[c.planItemId,c])),crossByPlan=new Map((crossChapterResolution?.items??[]).flatMap(item=>item.planItemIds.map(id=>[id,item])));return{status:'not_applied',requiredBaseRevision:requestSpec.sourceBaseRevision,
  sourceManuscriptSha256:requestSpec.sourceManuscriptSha256,atomicGroups:plan.items.filter(i=>i.decision==='revise').map(item=>{const c=checks.get(item.id);return{planItemId:item.id,chapterIds:clone(item.affectedChapterIds),targetIds:item.targets.map(t=>t.id),
    independentAdoption:item.independentAdoption,recommendation:crossRecheckIncomplete||incomplete||crossByPlan.get(item.id)?.repairStatus==='unresolved'?'not_recommended':c?.recommendation??'not_recommended',
    reason:crossRecheckIncomplete?CROSS_RECHECK_INCOMPLETE_MESSAGE:incomplete?'修后全文复读未完成。':crossByPlan.get(item.id)?.repairStatus==='unresolved'?crossByPlan.get(item.id).reason:c?.reason??'该组未完成复读。'};})};}
function warningsFor(changed,incomplete,crossChapterResolution,crossRecheckIncomplete){return['整稿质量结果是独立候选，未自动覆盖当前工作稿；采纳前须核对起点版本和当前用户编辑。','独立阅读、材料适用性和读者效果仍是 AI 编辑判断；逐字引文或检索命中不证明文学改善。',
  ...(crossRecheckIncomplete?[CROSS_RECHECK_INCOMPLETE_MESSAGE]:[]),
  ...(!changed?['本轮没有形成安全的正文改动；原稿已逐字保留。']:[]),...(incomplete?['候选稿已生成，但目标落实复读未完成；所有修改组均不得进入推荐采纳。']:[]),
  ...(crossChapterResolution?.unresolvedCount?['仍有 confirmed_conflict 未解决；no_change、跳过或不确定复读均未被记作修复。']:[])];}

export async function runWholeManuscriptQualityRevision({request,model,retrieveKnowledge,queryDeepReferences,queryNarrativeObservations,reviewCrossChapter,artifacts={},checkpoint=async()=>{},progress=async()=>{},signal}={}){
  const deepReferenceEnabled=typeof queryDeepReferences==='function';
  if(request?.writingGoals!==undefined){validateWritingGoals(request.writingGoals,request.chapters);requireThat(deepReferenceEnabled,'WRITING_GOALS_CALLBACK_REQUIRED','显式写作目标需要DATA深层参考回调，不能静默跳过查询。');}
  const legacyRetrieveKnowledge=retrieveKnowledge;
  retrieveKnowledge=resolveDeepReferenceCallback(deepReferenceEnabled
    ?createDeepReferenceRetrievalAdapter(queryDeepReferences,{path:'whole_manuscript_quality'}):undefined,retrieveKnowledge);
  requireThat(typeof model?.complete==='function'&&typeof checkpoint==='function','WHOLE_QUALITY_RUNTIME','需要模型适配器和保存点回调。');const sourceChapters=validateChapters(request?.chapters),requestSpec=createWholeQualityRequestSpec(request,{deepReferenceEnabled}),saved=jsonCopy(artifacts);
  if(Object.keys(saved).length&&!saved.requestSpec)fail('WHOLE_QUALITY_CHECKPOINT_MISMATCH','进度缺少请求绑定。');if(saved.requestSpec&&!isDeepStrictEqual(saved.requestSpec,requestSpec))fail('WHOLE_QUALITY_CHECKPOINT_MISMATCH','恢复请求与原稿、目标或模式不一致。');
  if(saved.requestSpec)validateRequestSpec(saved.requestSpec,sourceChapters);else{await checkpoint('requestSpec',clone(requestSpec));saved.requestSpec=clone(requestSpec);}
  const readingVersion=saved['whole-quality:reading:input']?.input?.responseBindings?.schemaVersion ?? (requestSpec.crossChapterReview ? FACT_READING_VERSION : WHOLE_QUALITY_READING_VERSION);
  const readingBound=readingInput(requestSpec,sourceChapters,readingVersion),readingRun=await structuredStage({prefix:'whole-quality:reading',stage:'whole-quality:reading',input:readingBound,system:readingVersion===FACT_READING_VERSION?FACT_READING_SYSTEM:READING_SYSTEM,maxTokens:14000,validate:validateReading,model,saved,checkpoint,progress,signal}),reading=readingRun.value;
  const crossChapterBundle=requestSpec.crossChapterReview===undefined?undefined:await runBoundCrossChapterReview({phase:'source',chapters:sourceChapters,requestSpec,reviewer:reviewCrossChapter,model,saved,checkpoint,progress,signal});
  const retrieval=await retrieveForReading({reading,requestSpec,retrieveKnowledge,legacyRetrieveKnowledge,queryDeepReferences,queryNarrativeObservations,saved,checkpoint,signal});
  const applicabilityRun=await runApplicability({requestSpec,reading,retrieval,model,saved,checkpoint,progress,signal}),applicability=applicabilityRun.value,
    planBound=planInput(requestSpec,sourceChapters,reading,retrieval,applicability,crossChapterBundle);
  let plan,planReceipt,planProvenanceRecord;
  if(planBound.eligibleIssueIds.length===0&&!planBound.eligibleGoalIds?.length){const run=await hostPlanStage({input:planBound,saved,checkpoint});plan=run.value;planProvenanceRecord=run.provenance;}
  else {const run=await structuredStage({prefix:'whole-quality:plan',stage:'whole-quality:plan',input:planBound,system:planSystemFor(crossChapterBundle!==undefined,!!requestSpec.writingGoals),maxTokens:14000,validate:validatePlan,model,saved,checkpoint,progress,signal});plan=run.value;planReceipt=run.receipt;planProvenanceRecord=planProvenance('model',planBound,plan);}
  let feasibility,feasibilityReceipt;if(plan.decision==='revise'){const bound=feasibilityInput(requestSpec,sourceChapters,reading,plan),run=await structuredStage({prefix:'whole-quality:feasibility',stage:'whole-quality:feasibility',input:bound,system:FEASIBILITY_SYSTEM,maxTokens:10000,validate:validateFeasibility,model,saved,checkpoint,progress,signal});feasibility=run.value;feasibilityReceipt=run.receipt;}else feasibility=noFeasibility(requestSpec,plan);
  const eligible=feasibility.checks.filter(c=>c.assessment==='feasible').map(c=>c.planItemId);let candidateRevision=null,revisionReceipt;
  if(eligible.length){const bound=revisionInput(requestSpec,sourceChapters,plan,feasibility),run=await structuredStage({prefix:'whole-quality:revision',stage:'whole-quality:revision',input:bound,system:REVISION_SYSTEM,maxTokens:16000,validate:validateCandidate,model,saved,checkpoint,progress,signal});candidateRevision=run.value;revisionReceipt=run.receipt;}
  const candidateChapters=assembleCandidate(sourceChapters,candidateRevision),{actualChanges,diff}=buildChanges(sourceChapters,candidateChapters,plan),rereadBound=rereadInput(requestSpec,sourceChapters,candidateChapters,reading,plan,feasibility,candidateRevision,actualChanges,diff,crossChapterBundle);
  let reread,rereadReceipt;if(saved['whole-quality:reread:incomplete']){reread=validateIncompleteReread(saved['whole-quality:reread:incomplete'],rereadBound);rereadReceipt=await recoverStageReceipt({prefix:'whole-quality:reread',stage:'whole-quality:reread',inputHash:fingerprint(rereadBound),saved,checkpoint});}
  else try{const run=await structuredStage({prefix:'whole-quality:reread',stage:'whole-quality:reread',input:rereadBound,system:crossChapterBundle===undefined?REREAD_SYSTEM:CROSS_REREAD_SYSTEM,maxTokens:16000,validate:validateReread,model,saved,checkpoint,progress,signal});reread=run.value;rereadReceipt=run.receipt;}catch(error){if(error?.code!=='WHOLE_QUALITY_FORMAT_FAILED')throw error;
    reread=validateIncompleteReread({schemaVersion:WHOLE_QUALITY_REREAD_INCOMPLETE_VERSION,status:'incomplete',inputHash:fingerprint(rereadBound),sourceManuscriptSha256:requestSpec.sourceManuscriptSha256,candidateManuscriptSha256:manuscriptFingerprint(candidateChapters),failureCode:error.code,diagnostics:[safeDiagnostic(error)]},rereadBound);
    await checkpoint('whole-quality:reread:incomplete',clone(reread));saved['whole-quality:reread:incomplete']=clone(reread);rereadReceipt={stage:'whole-quality:reread',inputHash:fingerprint(rereadBound),primaryResponseSha256:saved['whole-quality:reread:primary-response']?.responseSha256,...(saved['whole-quality:reread:repair-response']?{formatRepairResponseSha256:saved['whole-quality:reread:repair-response'].responseSha256}:{})};validateReceipt(rereadReceipt,'whole-quality:reread',fingerprint(rereadBound));await checkpoint('whole-quality:reread:receipt',clone(rereadReceipt));saved['whole-quality:reread:receipt']=clone(rereadReceipt);}
  let crossChapterRecheck,crossRecheckIncomplete;
  if(crossChapterBundle&&diff.changedChapterIds.length>0)try{
    crossChapterRecheck=await runBoundCrossChapterReview({phase:'candidate',chapters:candidateChapters,requestSpec,reviewer:reviewCrossChapter,model,saved,checkpoint,progress,signal});
  }catch(error){
    const prefix='whole-quality:cross-chapter:candidate';
    if(!CROSS_CHAPTER_RETRYABLE_FAILURES.has(error?.code)||!error.frozenProtocolFailure||!saved[`${prefix}:protocol-failure:1`])throw error;
    crossRecheckIncomplete=validateCrossRecheckIncomplete({schemaVersion:'whole-quality-cross-recheck-incomplete-1',status:'incomplete',
      sourceManuscriptSha256:manuscriptFingerprint(candidateChapters),modelPolicy:requestSpec.crossChapterReview.modelPolicy,
      protocolFailures:[saved[`${prefix}:protocol-failure:0`],saved[`${prefix}:protocol-failure:1`]],retryBinding:saved[`${prefix}:retry-1:binding`]},candidateChapters,requestSpec.crossChapterReview.modelPolicy);
    await saveBoundArtifact(saved,checkpoint,`${prefix}:incomplete`,crossRecheckIncomplete);
  }
  const materialUse=materialUseObject(retrieval,plan),finalTextRun=await runFinalTextEvidence({requestSpec,candidateChapters,materialUse,model,saved,checkpoint,progress,signal}),
    finalTextMaterialEvidence=finalTextRun.value,c06References=c06ReferenceBundle(retrieval,materialUse),
    deepReference=deepReferenceEnabled?buildWholeQualityDeepReferenceBundle({retrieval,applicability,plan,materialUse,finalTextMaterialEvidence,sourceChapters,candidateChapters}):undefined;
  const incomplete=reread.schemaVersion===WHOLE_QUALITY_REREAD_INCOMPLETE_VERSION,changed=diff.changedChapterIds.length>0,stageReceipts=[readingRun.receipt,
    ...(applicabilityRun.receipt?[applicabilityRun.receipt]:[]),...(planReceipt?[planReceipt]:[]),...(feasibilityReceipt?[feasibilityReceipt]:[]),...(revisionReceipt?[revisionReceipt]:[]),rereadReceipt,
    ...(finalTextRun.receipt?[finalTextRun.receipt]:[])];
  const crossChapterResolution=crossChapterOutcome(crossChapterBundle,crossChapterRecheck,reading,plan,feasibility,candidateRevision,reread,incomplete,crossRecheckIncomplete);
  const quality=qualityObject(reading,retrieval,plan,feasibility,reread,{applicability,finalTextMaterialEvidence,c06References,deepReference,writingGoals:requestSpec.writingGoals,crossChapterBundle,crossChapterRecheck,crossRecheckIncomplete,crossChapterResolution,candidateRevision}),unresolvedItems=clone(quality.unresolved),adoption=adoptionObject(requestSpec,plan,reread,incomplete,crossChapterResolution,crossRecheckIncomplete);
  const crossCalls=crossReviewCallCounts(crossChapterBundle,crossChapterRecheck,crossRecheckIncomplete),baseMax=applicability!==undefined?7:5;
  const wholeRevision={schemaVersion:WHOLE_QUALITY_RESULT_VERSION,status:crossRecheckIncomplete?'candidate_ready_cross_check_incomplete':incomplete?'candidate_ready_reread_incomplete':changed?'candidate_ready':'no_change',requestSpec,sourceChapters,plan,planProvenance:planProvenanceRecord,candidateRevision,actualChanges,diff,reread,unresolvedItems,stageReceipts,
    modelCalls:{primaryCalls:stageReceipts.length+crossCalls.primaryCalls,formatRepairCalls:stageReceipts.filter(r=>r.formatRepairResponseSha256).length+crossCalls.formatRepairCalls,
      maxPrimaryCalls:baseMax+crossCalls.maxPrimaryCalls,maxFormatRepairCalls:baseMax+crossCalls.maxFormatRepairCalls,
      ...(crossChapterBundle===undefined?{}:{crossChapterPrimaryCalls:crossCalls.primaryCalls,crossChapterFormatRepairCalls:crossCalls.formatRepairCalls})},adoption,quality};
  const result={title:typeof request.projectTitle==='string'&&request.projectTitle.trim()?request.projectTitle:'整稿质量修订候选',chapters:candidateChapters,warnings:warningsFor(changed,incomplete,crossChapterResolution,crossRecheckIncomplete),baseRevision:requestSpec.sourceBaseRevision,revisionApplied:changed,...(incomplete||crossRecheckIncomplete?{qualityCheckStatus:'incomplete'}:{}),wholeRevision};
  return assertWholeQualityResult(result,requestSpec);
}

export async function runCrossChapterAwareWholeManuscriptQualityRevision({ request, modelPolicy, reviewCrossChapter, artifacts = {}, ...options } = {}) {
  if (artifacts?.requestSpec && artifacts.requestSpec.crossChapterReview === undefined) {
    return runWholeManuscriptQualityRevision({ request, artifacts, ...options });
  }
  text(modelPolicy, 'WHOLE_QUALITY_CROSS_CHAPTER_BINDING', 300);
  const binding = { enabled: true, contractVersion: 'cross-chapter-review-result-1', integrationVersion: CROSS_CHAPTER_INTEGRATION_VERSION, modelPolicy };
  const boundRequest = { ...clone(request), crossChapterReview: binding };
  if (request?.crossChapterReview !== undefined) requireThat(isDeepStrictEqual(request.crossChapterReview,binding), 'WHOLE_QUALITY_CROSS_CHAPTER_BINDING', '请求中的跨章核对绑定与运行时 modelPolicy 不一致。');
  let reviewer = reviewCrossChapter;
  if (typeof reviewer !== 'function') ({ reviewCrossChapter: reviewer } = await import('../../validation/runtime/cross-chapter-review.mjs'));
  return runWholeManuscriptQualityRevision({ request: boundRequest, modelPolicy, reviewCrossChapter: reviewer, model: options.model ?? undefined, artifacts, ...options });
}

export function assertWholeQualityResult(result,suppliedRequestSpec){const before=clone(result),code='WHOLE_QUALITY_RESULT';exact(result,['title','chapters','warnings','baseRevision','revisionApplied','wholeRevision'],['qualityCheckStatus'],code);text(result.title,code,2000);const candidateChapters=validateChapters(result.chapters,code);stringList(result.warnings,code,12,false);requireThat(typeof result.baseRevision==='string'&&typeof result.revisionApplied==='boolean',code,'结果状态无效。');
  const whole=result.wholeRevision;exact(whole,['schemaVersion','status','requestSpec','sourceChapters','plan','candidateRevision','actualChanges','diff','reread','unresolvedItems','stageReceipts','modelCalls','adoption','quality'],['planProvenance'],code);requireThat(whole.schemaVersion===WHOLE_QUALITY_RESULT_VERSION&&['candidate_ready','candidate_ready_reread_incomplete','candidate_ready_cross_check_incomplete','no_change'].includes(whole.status),code,'结果版本或状态无效。');
  const sourceChapters=validateChapters(whole.sourceChapters,code),requestSpec=validateRequestSpec(whole.requestSpec,sourceChapters);requireThat(isDeepStrictEqual(requestSpec,suppliedRequestSpec),code,'请求规格不一致。');
  exact(whole.quality,['independentReading','sceneChanges','issuePriorities','retrieval','materialUse','feasibility','unresolved','newDraftGuidance'],['applicability','finalTextMaterialEvidence','c06References','deepReference','writingGoals','crossChapterReview','crossChapterRecheck','crossChapterRecheckIncomplete','crossChapterResolution'],code);const reading=validateReading(whole.quality.independentReading,readingInput(requestSpec,sourceChapters,whole.quality.independentReading?.schemaVersion));
  requireThat(isDeepStrictEqual(whole.quality.sceneChanges,reading.sceneChanges),code,'场景变化派生不一致。');const retrieval=validateRetrievalBundle(whole.quality.retrieval,reading,requestSpec);
  const crossEnabled=requestSpec.crossChapterReview!==undefined;
  requireThat(crossEnabled===Object.hasOwn(whole.quality,'crossChapterReview'),code,'跨章核对结果与请求绑定不一致。');
  const crossChapterBundle=crossEnabled?validateCrossChapterBundle(whole.quality.crossChapterReview,sourceChapters):undefined;
  if(crossEnabled)requireThat(crossChapterBundle.review.modelPolicy===requestSpec.crossChapterReview.modelPolicy,code,'跨章核对 modelPolicy 与请求规格不一致。');
  const hasDataStages=whole.quality.applicability!==undefined;
  requireThat(hasDataStages===(whole.quality.finalTextMaterialEvidence!==undefined&&whole.quality.c06References!==undefined),code,'DATA适用性、最终正文证据与C06清单须作为同一版本交付。');
  const applicability=hasDataStages?validateApplicabilityBundle(whole.quality.applicability,requestSpec,reading,retrieval):undefined;
  const currentPlanBound=planInput(requestSpec,sourceChapters,reading,retrieval,applicability,crossChapterBundle),legacyPlanBound=legacyPlanInput(requestSpec,sourceChapters,reading,retrieval),hasPlanProvenance=whole.planProvenance!==undefined;
  const boundPlanInput=hasPlanProvenance?currentPlanBound:legacyPlanBound,plan=validatePlan(whole.plan,boundPlanInput);
  const checkedPlanProvenance=hasPlanProvenance?validatePlanProvenance(whole.planProvenance,currentPlanBound,plan):null;
  const feasibility=plan.decision==='revise'?validateFeasibility(whole.quality.feasibility,feasibilityInput(requestSpec,sourceChapters,reading,plan)):validateNoFeasibility(whole.quality.feasibility,requestSpec,plan);const eligible=feasibility.checks.filter(c=>c.assessment==='feasible').map(c=>c.planItemId);
  const candidateRevision=eligible.length?validateCandidate(whole.candidateRevision,revisionInput(requestSpec,sourceChapters,plan,feasibility)):null;requireThat(eligible.length||whole.candidateRevision===null,code,'无可行组时不能含候选修订。');
  const rebuilt=assembleCandidate(sourceChapters,candidateRevision);requireThat(isDeepStrictEqual(candidateChapters,rebuilt),code,'候选含未授权变化。');const changes=buildChanges(sourceChapters,rebuilt,plan);requireThat(isDeepStrictEqual(whole.actualChanges,changes.actualChanges)&&isDeepStrictEqual(whole.diff,changes.diff),code,'差异派生不一致。');
  const rereadBound=rereadInput(requestSpec,sourceChapters,rebuilt,reading,plan,feasibility,candidateRevision,changes.actualChanges,changes.diff,crossChapterBundle),incomplete=whole.reread?.schemaVersion===WHOLE_QUALITY_REREAD_INCOMPLETE_VERSION;
  const reread=incomplete?validateIncompleteReread(whole.reread,rereadBound):validateReread(whole.reread,rereadBound),changed=changes.diff.changedChapterIds.length>0;requireThat(result.revisionApplied===changed&&result.baseRevision===requestSpec.sourceBaseRevision,code,'修改状态或起点不一致。');
  const materialUse=materialUseObject(retrieval,plan);requireThat(isDeepStrictEqual(whole.quality.materialUse,materialUse),code,'用材账本派生不一致。');
  const finalTextMaterialEvidence=hasDataStages?validateFinalTextBundle(whole.quality.finalTextMaterialEvidence,rebuilt,materialUse):undefined;
  const c06References=hasDataStages?c06ReferenceBundle(retrieval,materialUse):undefined;
  if(hasDataStages)requireThat(isDeepStrictEqual(whole.quality.c06References,c06References),code,'C06有限参考清单派生不一致。');
  let rebuiltDeepReference;
  if(whole.quality.deepReference!==undefined){rebuiltDeepReference=buildWholeQualityDeepReferenceBundle({retrieval,applicability,plan,materialUse,finalTextMaterialEvidence,sourceChapters,candidateChapters:rebuilt});
    requireThat(isDeepStrictEqual(whole.quality.deepReference,rebuiltDeepReference),code,'深层参考包与检索、决定或最终正文证据不一致。');}
  const expectsRecheck=Boolean(crossChapterBundle&&changed),hasRecheck=Object.hasOwn(whole.quality,'crossChapterRecheck'),hasIncomplete=Object.hasOwn(whole.quality,'crossChapterRecheckIncomplete');
  requireThat(expectsRecheck===(hasRecheck||hasIncomplete)&&!(hasRecheck&&hasIncomplete),code,'候选跨章复查必须恰有一份完整报告或明确失败记录。');
  const crossChapterRecheck=hasRecheck?validateCrossChapterBundle(whole.quality.crossChapterRecheck,rebuilt):undefined;
  const crossRecheckIncomplete=hasIncomplete?validateCrossRecheckIncomplete(whole.quality.crossChapterRecheckIncomplete,rebuilt,requestSpec.crossChapterReview.modelPolicy):undefined;
  requireThat(whole.status===(crossRecheckIncomplete?'candidate_ready_cross_check_incomplete':incomplete?'candidate_ready_reread_incomplete':changed?'candidate_ready':'no_change')&&((incomplete||crossRecheckIncomplete)?result.qualityCheckStatus==='incomplete':result.qualityCheckStatus===undefined),code,'完成状态不一致。');
  if(crossChapterRecheck)requireThat(crossChapterRecheck.review.modelPolicy===requestSpec.crossChapterReview.modelPolicy,code,'候选跨章复查 modelPolicy 与请求规格不一致。');
  const crossChapterResolution=crossChapterOutcome(crossChapterBundle,crossChapterRecheck,reading,plan,feasibility,candidateRevision,reread,incomplete,crossRecheckIncomplete);
  requireThat((crossEnabled&&Object.hasOwn(whole.quality,'crossChapterResolution'))||(!crossEnabled&&!Object.hasOwn(whole.quality,'crossChapterResolution')),code,'跨章修复结果与请求绑定不一致。');
  const quality=qualityObject(reading,retrieval,plan,feasibility,reread,{applicability,finalTextMaterialEvidence,c06References,deepReference:rebuiltDeepReference,writingGoals:requestSpec.writingGoals,crossChapterBundle,crossChapterRecheck,crossRecheckIncomplete,crossChapterResolution,candidateRevision});requireThat(isDeepStrictEqual(whole.quality,quality)&&isDeepStrictEqual(whole.unresolvedItems,quality.unresolved),code,'质量证据或未决项不一致。');requireThat(isDeepStrictEqual(whole.adoption,adoptionObject(requestSpec,plan,reread,incomplete,crossChapterResolution,crossRecheckIncomplete)),code,'采纳组派生不一致。');
  requireThat(isDeepStrictEqual(result.warnings,warningsFor(changed,incomplete,crossChapterResolution,crossRecheckIncomplete)),code,'警告不一致。');
  const expectedStages=[['whole-quality:reading',fingerprint(readingInput(requestSpec,sourceChapters,reading.schemaVersion))],
    ...(applicability?.modelStageDispatched?[['whole-quality:applicability',fingerprint(applicabilityInput(requestSpec,reading,retrieval))]]:[]),
    ...(!hasPlanProvenance||checkedPlanProvenance.producer==='model'?[['whole-quality:plan',fingerprint(boundPlanInput)]]:[]),
    ...(plan.decision==='revise'?[['whole-quality:feasibility',fingerprint(feasibilityInput(requestSpec,sourceChapters,reading,plan))]]:[]),...(eligible.length?[['whole-quality:revision',fingerprint(revisionInput(requestSpec,sourceChapters,plan,feasibility))]]:[]),['whole-quality:reread',fingerprint(rereadBound)],
    ...(finalTextMaterialEvidence?.modelStageDispatched?[['whole-quality:material-evidence',fingerprint(finalTextInput(requestSpec,rebuilt,materialUse))]]:[])];
  requireThat(Array.isArray(whole.stageReceipts)&&whole.stageReceipts.length===expectedStages.length,code,'阶段回执数量无效。');expectedStages.forEach(([stage,h],i)=>validateReceipt(whole.stageReceipts[i],stage,h));
  exact(whole.modelCalls,['primaryCalls','formatRepairCalls','maxPrimaryCalls','maxFormatRepairCalls'],crossEnabled?['crossChapterPrimaryCalls','crossChapterFormatRepairCalls']:[],code);
  const maxCalls=hasDataStages?7:5,crossCalls=crossReviewCallCounts(crossChapterBundle,crossChapterRecheck,crossRecheckIncomplete);
  requireThat(whole.modelCalls.primaryCalls===expectedStages.length+crossCalls.primaryCalls
    &&whole.modelCalls.formatRepairCalls===whole.stageReceipts.filter(r=>r.formatRepairResponseSha256).length+crossCalls.formatRepairCalls
    &&whole.modelCalls.maxPrimaryCalls===maxCalls+crossCalls.maxPrimaryCalls&&whole.modelCalls.maxFormatRepairCalls===maxCalls+crossCalls.maxFormatRepairCalls
    &&(!crossEnabled||(whole.modelCalls.crossChapterPrimaryCalls===crossCalls.primaryCalls&&whole.modelCalls.crossChapterFormatRepairCalls===crossCalls.formatRepairCalls)),code,'模型计数无效。');
  requireThat(isDeepStrictEqual(result,before),code,'结果门不应修改输入。');return clone(result);}
