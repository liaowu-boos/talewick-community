import {createHash, randomUUID} from 'node:crypto';
import {cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';

export const NARRATIVE_BATCH_SELECTION_VERSION = 'whole-revision-narrative-selection-v1';
export const NARRATIVE_BATCH_ANALYSIS_VERSION = 'whole-revision-narrative-analysis-v2';
export const NARRATIVE_BATCH_REVIEW_VERSION = 'whole-revision-narrative-review-v2';
export const NARRATIVE_BATCH_RUN_VERSION = 'whole-revision-narrative-batch-run-v1';
export const NARRATIVE_BATCH_DEFAULT_MAX_LOGICAL_MODEL_ATTEMPTS = 80;
export const NARRATIVE_OBSERVATION_PACKAGE_MANIFEST_VERSIONS = Object.freeze([
  'legacy-sidecars-r02-package-manifest-v1',
  'catalog-analysis-observation-package-manifest-v3',
]);

const FIELDS = Object.freeze(['intro_contract', 'chapter_1_change', 'chapter_2_change', 'chapter_3_change',
  'chapter_4_paywall', 'first_paid_payoff', 'midpoint_engine', 'ending_mechanism', 'prose_traits']);
const FIELD_SET = new Set(FIELDS);
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const failure = (code, message) => Object.assign(new Error(message), {code});
const check = (condition, code, message) => { if (!condition) throw failure(code, message); };

async function exists(path) { try { await stat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function readReadyFile(path, encoding = undefined) {
  const metadata = await stat(path);
  check(metadata.isFile(), 'FILE_SHAPE', 'Expected a regular file');
  return readFile(path, encoding);
}
async function readJson(path) { return JSON.parse(await readReadyFile(path, 'utf8')); }
async function atomicJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, json(value), {flag: 'wx'});
  await rename(temporary, path);
}
async function immutable(path, value) {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, typeof value === 'string' || value instanceof Uint8Array ? value : json(value), {flag: 'wx'});
}

export function inspectNarrativeBatchSelection(value) {
  check(object(value) && value.schemaVersion === NARRATIVE_BATCH_SELECTION_VERSION, 'SELECTION_SCHEMA', 'Unsupported selection manifest');
  check(Array.isArray(value.sources) && value.sources.length === 20, 'SELECTION_COUNT', 'Selection must freeze exactly 20 sources');
  check(Array.isArray(value.excludedExistingSourceIds) && new Set(value.excludedExistingSourceIds).size === value.excludedExistingSourceIds.length,
    'SELECTION_EXCLUSIONS', 'Existing coverage exclusions must be unique');
  if (value.activeBinding !== undefined) check(object(value.activeBinding) && text(value.activeBinding.catalogPath)
    && sha(value.activeBinding.catalogSha256), 'SELECTION_ACTIVE_BINDING', 'Invalid active-library binding');
  const ids = new Set(), excluded = new Set(value.excludedExistingSourceIds);
  for (const source of value.sources) {
    check(object(source) && text(source.sourceId) && text(source.title) && sha(source.sourceSha256)
      && source.textVersion === `text-v2-lf-${source.sourceSha256}` && text(source.selectionReason), 'SELECTION_SOURCE', 'Invalid frozen source');
    check(!ids.has(source.sourceId) && !excluded.has(source.sourceId), 'SELECTION_OVERLAP', 'Selected source is duplicate or already covered');
    ids.add(source.sourceId);
  }
  return structuredClone(value);
}

function parseModelOutput(value) {
  if (typeof value === 'string') return value;
  if (typeof value?.text === 'string') return value.text;
  if (typeof value?.output === 'string') return value.output;
  return JSON.stringify(value);
}

function lineIndex(sourceText) {
  const lines = sourceText.split('\n'), starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  return {lines, starts};
}

function lineAt(index, offset) {
  let low = 0, high = index.starts.length - 1;
  while (low <= high) { const middle = (low + high) >> 1; if (index.starts[middle] <= offset) low = middle + 1; else high = middle - 1; }
  return Math.max(0, high);
}

const EVIDENCE_WINDOW_MAX_CHARS = 180;
const EVIDENCE_WINDOW_MAX_BLOCKS = 6;
const EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_WINDOWS = 240;
const EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_QUOTE_CHARS =
  EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_WINDOWS * EVIDENCE_WINDOW_MAX_CHARS;
const COMPLETE_EVENT_END = /(?:[。！？!?]|\.{2,}|…{1,2}|[」』）》】])$/u;
const STORY_TERMINATOR = /^[（(]?(?:完|全文完|完结)[）)]?$/u;
const EXTRACTION_TRAILER = /^【.*(?:站点|提取|请勿传播|https?:\/\/)/u;

/**
 * Build immutable, source-derived local event windows. Windows always start
 * and end at original line boundaries, preserve intervening whitespace, and
 * end on a complete punctuation boundary. The model can select an id but
 * cannot manufacture or edit the quote behind it.
 */
export function buildNarrativeEvidenceWindows(sourceText) {
  check(typeof sourceText === 'string' && sourceText.length > 0, 'ANALYSIS_WINDOWS', 'Visible source text is required');
  const index = lineIndex(sourceText), blocks = [];
  for (let line = 0; line < index.lines.length; line++) {
    const value = index.lines[line];
    if (!value.trim()) continue;
    if (STORY_TERMINATOR.test(value.trim()) || EXTRACTION_TRAILER.test(value.trim())) break;
    blocks.push({start: index.starts[line], end: index.starts[line] + value.length});
  }
  const ranges = [];
  for (let startIndex = 0; startIndex < blocks.length;) {
    let chosen = null;
    for (let endIndex = startIndex; endIndex < Math.min(blocks.length, startIndex + EVIDENCE_WINDOW_MAX_BLOCKS); endIndex++) {
      const start = blocks[startIndex].start, end = blocks[endIndex].end, quote = sourceText.slice(start, end);
      if (quote.length > EVIDENCE_WINDOW_MAX_CHARS) break;
      const trimmed = quote.trim(), meaningfulChars = (trimmed.match(/[\p{L}\p{N}]/gu) ?? []).length;
      if (meaningfulChars < 6 || !COMPLETE_EVENT_END.test(trimmed)) continue;
      chosen = {start, end, startIndex, endIndex, quote};
    }
    if (chosen) { ranges.push(chosen); startIndex = chosen.endIndex + 1; }
    else startIndex++;
  }
  const primary = ranges.map((item, ordinal) => {
    const lineStartIndex = lineAt(index, item.start), lineEndIndex = lineAt(index, Math.max(item.start, item.end - 1));
    const bodySha256 = hash(item.quote);
    return {windowId: `W${String(ordinal + 1).padStart(4, '0')}-${bodySha256.slice(0, 12)}`, quote: item.quote,
      lineStart: lineStartIndex + 1, lineEnd: lineEndIndex + 1, utf16Start: item.start, utf16End: item.end, bodySha256};
  });
  const occupied = new Set(ranges.map(item => `${item.start}:${item.end}`)), supplementalRanges = [];
  for (let boundaryIndex = 0; boundaryIndex + 1 < ranges.length; boundaryIndex++) {
    const left = ranges[boundaryIndex], right = ranges[boundaryIndex + 1];
    // Two deterministic bridge shapes cover common turn structures without
    // enumerating every possible start/end pair: the whole right primary
    // window, and its first three blocks, each with the largest fitting suffix
    // of the left primary window. Primary W ids and quotes remain untouched.
    const endIndexes = [right.endIndex, Math.min(right.endIndex, right.startIndex + 2)];
    for (const endIndex of endIndexes) {
      let startIndex = left.endIndex;
      if (blocks[endIndex].end - blocks[startIndex].start > EVIDENCE_WINDOW_MAX_CHARS) continue;
      while (startIndex > left.startIndex
        && blocks[endIndex].end - blocks[startIndex - 1].start <= EVIDENCE_WINDOW_MAX_CHARS) startIndex--;
      const start = blocks[startIndex].start, end = blocks[endIndex].end, key = `${start}:${end}`;
      if (occupied.has(key)) continue;
      occupied.add(key);
      supplementalRanges.push({start, end, quote: sourceText.slice(start, end)});
    }
  }
  const limitedSupplemental = supplementalRanges.length <= EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_WINDOWS
    ? supplementalRanges
    : Array.from({length: EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_WINDOWS}, (_, ordinal) =>
      supplementalRanges[Math.round(ordinal * (supplementalRanges.length - 1)
        / (EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_WINDOWS - 1))]);
  const supplemental = limitedSupplemental.map((item, ordinal) => {
    const lineStartIndex = lineAt(index, item.start), lineEndIndex = lineAt(index, Math.max(item.start, item.end - 1));
    const bodySha256 = hash(item.quote);
    return {windowId: `X${String(ordinal + 1).padStart(4, '0')}-${bodySha256.slice(0, 12)}`, quote: item.quote,
      lineStart: lineStartIndex + 1, lineEnd: lineEndIndex + 1, utf16Start: item.start, utf16End: item.end, bodySha256};
  });
  return [...primary, ...supplemental];
}

function evidenceFromWindow(window) {
  const lineStart = window.lineStart, lineEnd = window.lineEnd;
  const quoteStart = window.utf16Start, quoteEnd = window.utf16End;
  const bodySha256 = window.bodySha256;
  return {windowId: window.windowId, quote: window.quote, lineStart, lineEnd,
    lineWindowUtf16Start: quoteStart, lineWindowUtf16End: quoteEnd, lineWindowBodySha256: bodySha256,
    matchedQuoteUtf16Start: quoteStart, matchedQuoteUtf16End: quoteEnd, matchedQuoteBodySha256: bodySha256};
}

function locateEvidenceWindow(windowId, windows) {
  check(text(windowId), 'ANALYSIS_WINDOW_BINDING', 'Each observation must select one evidence windowId');
  const window = windows.find(item => item.windowId === windowId);
  check(window, 'ANALYSIS_WINDOW_BINDING', `Unknown evidence windowId ${windowId}`);
  return evidenceFromWindow(window);
}

const VALUE_LIMITS = Object.freeze({summary: 70, psychologyChange: 95, emotionOrganization: 80, expressionEffect: 80,
  readerEffectHypothesis: 95, applicabilityBoundary: 80, counterEvidence: 80, visibilityBoundary: 75});
const OBSERVATION_CONTENT_BUDGET = Object.freeze({evidenceCount: 1, maxQuoteChars: 180, maxFieldAndQuoteChars: 420});

function projectedCharge(source, observation) {
  const storyId = `st_wr_${hash(source.sourceId).slice(0, 12)}`;
  const value = Object.fromEntries(Object.keys(VALUE_LIMITS).map(key => [key, observation[key]]));
  const evidence = observation.evidence.map((item, index) => ({evidenceId: `E${String(index + 1).padStart(2, '0')}`,
    quote: item.quote, supportType: 'direct', lineStart: item.lineStart, lineEnd: item.lineEnd,
    lineWindow: [item.lineWindowUtf16Start, item.lineWindowUtf16End, item.lineWindowBodySha256],
    charWindow: [item.matchedQuoteUtf16Start, item.matchedQuoteUtf16End, item.matchedQuoteBodySha256],
    intersection: [item.matchedQuoteUtf16Start, item.matchedQuoteUtf16End, item.matchedQuoteBodySha256],
    matched: [item.matchedQuoteUtf16Start, item.matchedQuoteUtf16End]}));
  const item = {id: `legacy:${source.sourceId}:${storyId}:${observation.field}`, field: observation.field, value,
    analysisStatus: {kind: 'archived_ai_narrative_observation', archiveAccepted: true, currentAnalysisBindingValid: true,
      grantsCurrentCheckedAnalysisStatus: false}, confidence: {originalFieldConfidence: 'reviewed_candidate', boundaryOrigin: 'analyst_observed'},
    source: {sourceId: source.sourceId, sourceSha256: source.sourceSha256, normalizedTextSha256: source.sourceSha256,
      textVersion: source.textVersion}, archive: {storyId, cardSha256: 'a'.repeat(64), auditSha256: 'b'.repeat(64)},
    authority: {classification: 'observable_narrative_choice', authorIntentClaimed: false, grantsNewCheckedAnalysisStatus: false},
    evidence, materialBinding: {materialId: 'm'.repeat(64), referenceIndexes: [0], allEvidenceInsideSelectedWindows: true},
    limitations: ['archived_ai_observation', 'not_current_checked_analysis', 'evidence_only_original_text', 'explicit_adoption_required']};
  return JSON.stringify(item).length;
}

function inspectAnalysis(value, source, sourceText, declaredCompleteness) {
  check(object(value) && value.schemaVersion === NARRATIVE_BATCH_ANALYSIS_VERSION && value.sourceId === source.sourceId
    && value.sourceSha256 === source.sourceSha256 && value.textVersion === source.textVersion, 'ANALYSIS_BINDING', 'Analysis source binding mismatch');
  check(['full', 'first_four', 'unknown'].includes(value.visibleTextScope), 'ANALYSIS_SCOPE', 'Analysis must state visible text scope');
  check(value.visibleTextScope === declaredCompleteness, 'ANALYSIS_SCOPE', 'Visible text scope must equal the catalog declaration');
  check(Array.isArray(value.limitations) && value.limitations.length && value.limitations.every(text), 'ANALYSIS_LIMITS', 'Analysis must state limitations');
  check(Array.isArray(value.observations) && value.observations.length >= 4 && value.observations.length <= 6, 'ANALYSIS_COUNT', 'Analysis requires 4–6 observations');
  const windows = buildNarrativeEvidenceWindows(sourceText);
  check(windows.length >= 4, 'ANALYSIS_WINDOWS', 'Visible source text must yield at least four complete local evidence windows');
  const ids = new Set(), fields = new Set(), windowIds = new Set();
  const observations = value.observations.map(observation => {
    check(object(observation) && text(observation.observationId) && !ids.has(observation.observationId)
      && FIELD_SET.has(observation.field) && !fields.has(observation.field), 'ANALYSIS_OBSERVATION', 'Observation id and field must be unique');
    ids.add(observation.observationId); fields.add(observation.field);
    check(text(observation.windowId) && !windowIds.has(observation.windowId), 'ANALYSIS_WINDOW_BINDING',
      'Every observation must select a distinct evidence windowId');
    windowIds.add(observation.windowId);
    for (const [key, maximum] of Object.entries(VALUE_LIMITS)) check(text(observation[key]) && observation[key].length <= maximum,
      'ANALYSIS_COMPACTNESS', `${key} must be nonempty and at most ${maximum} UTF-16 characters`);
    const boundEvidence = locateEvidenceWindow(observation.windowId, windows);
    const jointChars = Object.keys(VALUE_LIMITS).reduce((sum, key) => sum + observation[key].length, 0) + boundEvidence.quote.length;
    check(jointChars <= OBSERVATION_CONTENT_BUDGET.maxFieldAndQuoteChars, 'ANALYSIS_COMPACTNESS',
      `Eight observation fields plus quote must total at most ${OBSERVATION_CONTENT_BUDGET.maxFieldAndQuoteChars} UTF-16 characters`);
    const {evidence: ignoredModelEvidence, projectionPreflight: ignoredProjection, ...candidate} = structuredClone(observation);
    const located = {...candidate, evidence: [boundEvidence]};
    const chargedChars = projectedCharge(source, located);
    check(chargedChars <= 2400, 'ANALYSIS_PROJECTION_BUDGET', `Observation ${observation.observationId} projects to ${chargedChars} characters`);
    return {...located, projectionPreflight: {contractVersion: 'narrative-observation-projection-preflight-v1', chargedChars,
      maxChars: 2400, assumedMaterialIdChars: 64, fieldAndQuoteChars: jointChars}};
  });
  if (value.visibleTextScope === 'unknown') check(observations.every(item =>
    !/(?:可见|已提供|当前文本).{0,8}(?:结局|收束).{0,8}(?:未观察|不存在)/.test(item.visibilityBoundary)),
  'ANALYSIS_SCOPE', 'Unknown external completeness cannot deny a visible ending or closure');
  return {...structuredClone(value), observations};
}

function inspectReview(value, analysis) {
  check(object(value) && value.schemaVersion === NARRATIVE_BATCH_REVIEW_VERSION && value.sourceId === analysis.sourceId
    && value.analysisSha256 === hash(JSON.stringify(analysis)) && typeof value.approved === 'boolean'
    && Array.isArray(value.notes) && value.notes.length && value.notes.every(text), 'REVIEW_BINDING', 'Review binding or conclusion invalid');
  check(Array.isArray(value.decisions) && value.decisions.length === analysis.observations.length, 'REVIEW_COUNT', 'Review must decide every observation');
  const expected = new Set(analysis.observations.map(item => item.observationId)), seen = new Set();
  for (const decision of value.decisions) {
    const observation = analysis.observations.find(item => item.observationId === decision?.observationId);
    check(object(decision) && expected.has(decision.observationId) && !seen.has(decision.observationId)
      && ['accepted', 'rejected'].includes(decision.status) && text(decision.notes)
      && decision.windowIdUsed === observation.windowId
      && ['sufficient', 'insufficient'].includes(decision.evidenceSufficiency) && typeof decision.unboundEvidenceUsed === 'boolean'
      && Array.isArray(decision.evidenceIndexesUsed) && decision.evidenceIndexesUsed.length
      && new Set(decision.evidenceIndexesUsed).size === decision.evidenceIndexesUsed.length
      && decision.evidenceIndexesUsed.every(index => Number.isSafeInteger(index) && index >= 0 && index < observation.evidence.length)
      && Array.isArray(decision.missingSupport) && decision.missingSupport.every(text), 'REVIEW_DECISION', 'Invalid review decision');
    check(decision.status === 'accepted'
      ? decision.evidenceSufficiency === 'sufficient' && decision.unboundEvidenceUsed === false && decision.missingSupport.length === 0
      : decision.evidenceSufficiency === 'insufficient' && decision.missingSupport.length > 0,
    'REVIEW_EVIDENCE_SCOPE', 'Accepted observations require sufficient bound evidence; rejected observations require concrete missing support');
    seen.add(decision.observationId);
  }
  check(value.approved === value.decisions.every(item => item.status === 'accepted'), 'REVIEW_CONCLUSION', 'Review conclusion conflicts with decisions');
  return structuredClone(value);
}

function analysisExample(source, completeness, windowId) {
  return {schemaVersion: NARRATIVE_BATCH_ANALYSIS_VERSION, sourceId: source.sourceId, sourceSha256: source.sourceSha256,
    textVersion: source.textVersion, visibleTextScope: completeness,
    limitations: ['只分析当前提供文本；外部母本完整度与未提供内容未观察。'], observations: [{observationId: 'O01',
      field: 'intro_contract', windowId, summary: '只概括所选窗口内可见的一个局部事件或变化。', psychologyChange: '只写该窗口足以支持的心理变化；未观察到则明确写未观察。',
      emotionOrganization: '简述情绪如何按动作或信息组织。', expressionEffect: '简述叙述、对白或意象的可观察作用。',
      readerEffectHypothesis: '这种表达可能引导注意某变化；只是假说，未获真人反馈。',
      applicabilityBoundary: '只适用于该引文呈现的具体场景，不外推成规则。', counterEvidence: '写出同一绑定引文内的限制或替代解释。',
      visibilityBoundary: completeness === 'full' ? '只据所选窗口与声明为全文的提供工件；外部母本未另行核验。' : '只据所选窗口；外部原作完整度未知，不否认可见收束。'}]};
}

function analysisRequest(source, sourceText, completeness, retryFeedback = null) {
  const evidenceWindows = buildNarrativeEvidenceWindows(sourceText);
  check(evidenceWindows.length >= 4, 'ANALYSIS_WINDOWS', 'Visible source text must yield at least four complete local evidence windows');
  const example = analysisExample(source, completeness, evidenceWindows[0].windowId);
  return {stage: 'narrative-observation-analysis', maxTokens: 16000,
    system: `只分析提供的可见小说文本，不生成或续写小说，不调用外部母本。只输出一个 JSON 对象，不加 Markdown。主机已从原文生成带稳定 windowId 的连续局部事件窗口；你只能为每条观察选择一个 windowId，禁止抄写、改写或自造 evidence.quote，主机会从 windowId 派生逐字引文、位置和SHA。每条观察的八个文字字段都只能描述所选窗口内可直接观察的同一个局部事件或变化：不得用一个开头句概括三个年龄段，不得用遗言碎片概括整本日记、头七和结尾，不得依赖其他窗口或完整 lines 补足核心判断。若窗口不足以支撑八字段，改选更完整的已有窗口或缩小观察范围。八字段允许如实写“本窗口未观察到人物心理变化”或“本窗口未给出反证”，禁止为填字段虚构心理活动；人物心理、叙述信息反转与读者可能感受必须分别表述。每条必须填写心理变化、情绪组织、表达作用、读者作用假说、适用边界、反证和可见范围边界；读者作用只能是假说，未观察项是合格边界而非缺失键。八个内容字段字符数加所选窗口 quote 字符数合计不得超过420。observations 必须有4至6项，并选择4至6个不同且有意义的局部事件 windowId；observationId 必须唯一；field 只能从 ${FIELDS.join(',')} 中选择且不重复。字段字符上限为 ${JSON.stringify(VALUE_LIMITS)}，完整投影预检不得超过2400字符，禁止靠截断或用无意义的一句话填满八字段。visibleTextScope 必须严格等于 ${JSON.stringify(completeness)}，禁止把 unknown 或 first_four 自升为 full；unknown 只表示外部原作完整度未知，不能声称提供工件内可见的收束不存在。完整 lines 仅供理解全篇与选择事件，不是任何观察的额外证据。所有示例占位文字都必须替换。完整输出合同示例：${JSON.stringify(example)}`,
    user: JSON.stringify({sourceId: source.sourceId, title: source.title, sourceSha256: source.sourceSha256,
      textVersion: source.textVersion, declaredCompleteness: completeness, externalMasterVerified: false,
      outputContract: {topLevelRequired: ['schemaVersion', 'sourceId', 'sourceSha256', 'textVersion', 'visibleTextScope', 'limitations', 'observations'],
        visibleTextScopeEnum: ['full', 'first_four', 'unknown'], requiredVisibleTextScope: completeness, observationCount: {minimum: 4, maximum: 6},
        observationFields: FIELDS, fieldUtf16Limits: VALUE_LIMITS, evidenceWindowContract: {selectionKey: 'windowId', distinctPerObservation: true,
          hostDerivedQuote: true, maxQuoteUtf16Chars: EVIDENCE_WINDOW_MAX_CHARS, modelMayWriteQuote: false,
          primaryWindowIdPrefix: 'W', supplementalWindowIdPrefix: 'X',
          maxSupplementalWindows: EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_WINDOWS,
          maxSupplementalQuoteUtf16Chars: EVIDENCE_WINDOW_MAX_SUPPLEMENTAL_QUOTE_CHARS},
        jointContentBudget: OBSERVATION_CONTENT_BUDGET, projectionBudget: {maxChars: 2400, truncationAllowed: false}, observationRequired: ['observationId', 'field', 'summary', 'psychologyChange', 'emotionOrganization',
          'expressionEffect', 'readerEffectHypothesis', 'applicabilityBoundary', 'counterEvidence', 'visibilityBoundary', 'windowId'],
        evidenceRule: 'select_one_host_generated_window_id; all_fields_bound_to_same_window; host_derives_quote_line_utf16_sha', exactExample: example},
      ...(retryFeedback ? {retryFeedback} : {}),
      evidenceWindowStats: {primaryCount: evidenceWindows.filter(item => item.windowId.startsWith('W')).length,
        supplementalCount: evidenceWindows.filter(item => item.windowId.startsWith('X')).length,
        supplementalQuoteUtf16Chars: evidenceWindows.filter(item => item.windowId.startsWith('X'))
          .reduce((total, item) => total + item.quote.length, 0), totalCount: evidenceWindows.length},
      evidenceWindows,
      lines: sourceText.split('\n').map((line, index) => ({line: index + 1, text: line}))})};
}

function reviewRequest(source, analysis) {
  const analysisSha256 = hash(JSON.stringify(analysis));
  const example = {schemaVersion: NARRATIVE_BATCH_REVIEW_VERSION, sourceId: source.sourceId, analysisSha256, approved: true,
    notes: ['总体复核依据和仍未验证的文学效果。'], decisions: analysis.observations.map(item => ({observationId: item.observationId,
      windowIdUsed: item.windowId, status: 'accepted', evidenceSufficiency: 'sufficient', unboundEvidenceUsed: false, evidenceIndexesUsed: [0], missingSupport: [],
      notes: '只依据该观察 evidence[0]，说明事实、推断、边界和证据为何一致。'}))};
  return {stage: 'narrative-observation-review', maxTokens: 8000,
    system: `独立语义复核候选观察，不改写候选，不生成小说。对每条观察核对事实归属、心理推断强度、情绪与表达依据、读者作用的假说限定、适用边界、反证、可见文本范围和逐字证据。每项 decision 必须原样回填该 observation.windowId 为 windowIdUsed，明确复核同一窗口。复核输入有意不提供完整 lines；accepted 的全部正面依据只能来自该 observation 已绑定的 evidence[0]，缺少上下文时必须判为缺证，禁止援引其他窗口或背景常识补足候选。候选如实写“本窗口未观察到人物心理变化”或“本窗口未给出反证”可以合格，不得要求它为填满字段生造结论；人物心理、叙述信息反转与读者可能感受必须分别核对。若 summary 或任一字段跨越所选窗口，例如用开头一句概括多个年龄段，或用遗言碎片概括整本日记、头七和结尾，必须 status=rejected、evidenceSufficiency=insufficient，并在 missingSupport 写明越界事实；此时 unboundEvidenceUsed=true 表示候选使用了绑定窗口外的依据，false 表示绑定证据本身不足但未识别到具体外部依据，两者都只是拒绝诊断，不能授权外部证据。不得自行换 windowId 或把外部事实当作已绑定证据。只输出一个 JSON 对象，不加 Markdown。decisions 必须逐项覆盖候选 observationId，不能遗漏、重复或增加；status 只能是 accepted 或 rejected；evidenceIndexesUsed 只能是[0]；accepted 必须 unboundEvidenceUsed=false 且 missingSupport=[]，有任一 rejected 时 approved=false。顶层 notes 和每项 notes 都必须是具体非空依据。sourceId 与 analysisSha256 必须原样回填。完整输出合同示例：${JSON.stringify(example)}`,
    user: JSON.stringify({sourceId: source.sourceId, sourceSha256: source.sourceSha256, textVersion: source.textVersion,
      analysisSha256, outputContract: {topLevelRequired: ['schemaVersion', 'sourceId', 'analysisSha256', 'approved', 'notes', 'decisions'],
        statusEnum: ['accepted', 'rejected'], requiredObservationIds: analysis.observations.map(item => item.observationId),
        decisionRequired: ['observationId', 'windowIdUsed', 'status', 'evidenceSufficiency', 'unboundEvidenceUsed', 'evidenceIndexesUsed', 'missingSupport', 'notes'],
        evidenceSufficiencyEnum: ['sufficient', 'insufficient'],
        unboundEvidenceRule: 'accepted_requires_false; rejected_allows_boolean_diagnostic_only',
        acceptedRule: 'use_bound_evidence_only; sufficient; unboundEvidenceUsed_false; missingSupport_empty',
        reviewerContextPolicy: 'quote_only_no_full_lines', exactExample: example}, analysis})};
}

function correctionRequest(role, originalRequest, originalResponse, error) {
  return {stage: `narrative-observation-${role}-format-correction`, maxTokens: originalRequest.maxTokens,
    system: '只修复候选 JSON 的语法、缺失键、枚举、字段长度、联合字符预算、唯一性或固定绑定格式。保持原有实质判断、observationId/field/windowId集合和顺序，不删除整条观察，不新增小说内容，不选择或更换证据窗口，不改写被语义复核拒绝的观点。若无法在这些边界内修复，应原样返回而让本次尝试失败。只返回一个满足原请求 outputContract 的完整 JSON 对象，不加 Markdown。',
    user: JSON.stringify({role, validationError: {code: error.code ?? `${role.toUpperCase()}_JSON_FORMAT`, message: error.message},
      originalRequest: {...originalRequest, user: JSON.parse(originalRequest.user)}, originalResponse})};
}

const FORMAT_CODES = Object.freeze({
  analysis: new Set(['ANALYSIS_JSON_FORMAT', 'ANALYSIS_BINDING', 'ANALYSIS_SCOPE', 'ANALYSIS_LIMITS', 'ANALYSIS_COUNT',
    'ANALYSIS_OBSERVATION', 'ANALYSIS_COMPACTNESS', 'ANALYSIS_PROJECTION_BUDGET']),
  review: new Set(['REVIEW_JSON_FORMAT', 'REVIEW_BINDING', 'REVIEW_COUNT', 'REVIEW_DECISION', 'REVIEW_CONCLUSION']),
});

function parsed(raw, role) {
  try { return JSON.parse(raw); } catch { throw failure(`${role.toUpperCase()}_JSON_FORMAT`, `${role} response is not valid JSON`); }
}

export function createNarrativeObservationBatchDriver({libraryRoot, runRoot, selection, model,
  maxLogicalModelAttempts = NARRATIVE_BATCH_DEFAULT_MAX_LOGICAL_MODEL_ATTEMPTS, now = () => new Date().toISOString()} = {}) {
  const frozen = inspectNarrativeBatchSelection(selection);
  check(text(libraryRoot) && text(runRoot) && typeof model?.complete === 'function', 'BATCH_CONFIG', 'Library, run root and injected model are required');
  check(Number.isSafeInteger(maxLogicalModelAttempts) && maxLogicalModelAttempts >= 40 && maxLogicalModelAttempts <= 200,
    'BATCH_CONFIG', 'Logical model attempt ceiling must be an integer from 40 to 200');
  const library = resolve(libraryRoot), root = resolve(runRoot);
  const budgetPath = join(root, 'logical-model-attempt-budget.json');
  async function readBudget() {
    return await exists(budgetPath) ? await readJson(budgetPath) : {schemaVersion: 'narrative-observation-logical-attempt-budget-v1',
      maxLogicalModelAttempts, usedLogicalModelAttempts: 0, attempts: []};
  }
  async function consumeLogicalAttempt(stage, sourceId, attemptId) {
    const budget = await readBudget();
    check(budget.maxLogicalModelAttempts === maxLogicalModelAttempts
      && budget.usedLogicalModelAttempts < budget.maxLogicalModelAttempts,
      'BATCH_CALL_BUDGET', 'Logical model attempt ceiling exceeded');
    budget.usedLogicalModelAttempts++;
    budget.attempts.push({ordinal: budget.usedLogicalModelAttempts, stage, sourceId, attemptId, consumedAt: now(),
      accountingBoundary: 'logical_model_attempt; actual_HTTP_POST_is_counted_only_by_main_provider_ledger'});
    await atomicJson(budgetPath, budget);
    return budget.usedLogicalModelAttempts;
  }
  async function correctionAlreadyUsed(sourceId, role) {
    const budget = await readBudget();
    return budget.attempts.some(item => item.sourceId === sourceId && item.stage === `narrative-observation-${role}-format-correction`);
  }
  async function invokeValidated({role, source, attemptId, attemptRoot, request, validate}) {
    await immutable(join(attemptRoot, `${role}.request.json`), request);
    await consumeLogicalAttempt(request.stage, source.sourceId, attemptId);
    const raw = parseModelOutput(await model.complete(request));
    await immutable(join(attemptRoot, `${role}.response.raw.txt`), raw);
    let originalValue = null;
    try { originalValue = parsed(raw, role); return validate(originalValue); }
    catch (error) {
      if (!FORMAT_CODES[role].has(error.code) || await correctionAlreadyUsed(source.sourceId, role)) throw error;
      const correction = correctionRequest(role, request, raw, error);
      await immutable(join(attemptRoot, `${role}.correction.request.json`), correction);
      await consumeLogicalAttempt(correction.stage, source.sourceId, attemptId);
      const correctedRaw = parseModelOutput(await model.complete(correction));
      await immutable(join(attemptRoot, `${role}.correction.response.raw.txt`), correctedRaw);
      const correctedValue = parsed(correctedRaw, role);
      if (role === 'analysis' && Array.isArray(originalValue?.observations)) {
        const before = originalValue.observations.map(item => [item?.observationId, item?.field, item?.windowId]);
        const after = Array.isArray(correctedValue?.observations)
          ? correctedValue.observations.map(item => [item?.observationId, item?.field, item?.windowId]) : null;
        check(JSON.stringify(after) === JSON.stringify(before), 'ANALYSIS_CORRECTION_SEMANTICS',
          'Format correction cannot add, delete, reorder or rebind observations or evidence windows');
      }
      return validate(correctedValue);
    }
  }
  return {maxLogicalModelAttempts,
    async run({retryFailed = false, sourceIds, supersedeCompleted = []} = {}) {
      await mkdir(root, {recursive: true});
      const frozenPath = join(root, 'selection-manifest.json');
      if (await exists(frozenPath)) check(JSON.stringify(await readJson(frozenPath)) === JSON.stringify(frozen),
        'BATCH_SELECTION_CHANGED', 'Run selection is already frozen to different bytes');
      else await immutable(frozenPath, frozen);
      const selectedIds = sourceIds === undefined ? null : new Set(sourceIds);
      if (selectedIds) check([...selectedIds].every(id => frozen.sources.some(item => item.sourceId === id)), 'BATCH_SOURCE', 'Unknown requested source');
      check(Array.isArray(supersedeCompleted) && supersedeCompleted.every(item => object(item) && text(item.sourceId)
        && text(item.reason) && Array.isArray(item.feedback) && item.feedback.length && item.feedback.every(text)),
      'BATCH_SUPERSEDE', 'Completed-source supersede requires sourceId, reason and concrete feedback');
      const supersedeById = new Map(supersedeCompleted.map(item => [item.sourceId, structuredClone(item)]));
      check(supersedeById.size === supersedeCompleted.length && [...supersedeById.keys()].every(id => frozen.sources.some(item => item.sourceId === id)),
        'BATCH_SUPERSEDE', 'Supersede source must be unique and frozen');
      const catalogBytes = await readReadyFile(join(library, 'catalog.json'));
      if (frozen.activeBinding) check(hash(catalogBytes) === frozen.activeBinding.catalogSha256,
        'BATCH_ACTIVE_CATALOG', 'Active catalog digest differs from frozen selection binding');
      const catalog = JSON.parse(catalogBytes);
      const rows = new Map(catalog.sources.map(row => [row.sourceId, row]));
      const outcomes = [];
      for (const source of frozen.sources) {
        if (selectedIds && !selectedIds.has(source.sourceId)) continue;
        const sourceRoot = join(root, 'sources', source.sourceId), statusPath = join(sourceRoot, 'status.json');
        const prior = await exists(statusPath) ? await readJson(statusPath) : null;
        const supersede = supersedeById.get(source.sourceId);
        if (prior?.status === 'completed' && !supersede) { outcomes.push({sourceId: source.sourceId, status: 'skipped_completed'}); continue; }
        if (prior?.status === 'failed' && !retryFailed) { outcomes.push({sourceId: source.sourceId, status: 'skipped_failed'}); continue; }
        check(!supersede || prior?.status === 'completed', 'BATCH_SUPERSEDE', 'Only a completed source may be superseded');
        const row = rows.get(source.sourceId);
        check(row && row.sourceSha256 === source.sourceSha256 && row.textVersion === source.textVersion, 'BATCH_CATALOG_BINDING', `Catalog changed for ${source.sourceId}`);
        const bytes = await readReadyFile(join(library, 'objects', `${source.sourceSha256}.bin`));
        check(hash(bytes) === source.sourceSha256, 'BATCH_SOURCE_SHA', `Source bytes changed for ${source.sourceId}`);
        const sourceText = await readReadyFile(join(library, 'objects', `${source.sourceSha256}.lf-v2.txt`), 'utf8');
        check(hash(sourceText) === (row.indexIntegrity?.sourceTextSha256 ?? source.sourceSha256), 'BATCH_TEXT_SHA', `Normalized text changed for ${source.sourceId}`);
        const attemptId = `${Date.now()}-${randomUUID()}`, attemptRoot = join(sourceRoot, 'attempts', attemptId);
        await mkdir(attemptRoot, {recursive: true});
        await atomicJson(statusPath, {schemaVersion: NARRATIVE_BATCH_RUN_VERSION, sourceId: source.sourceId, status: 'running', attemptId, startedAt: now(),
          ...(supersede ? {supersedesAttemptId: prior.attemptId, supersedeReason: supersede.reason} : {})});
        let analysis = null, analysisPath = null, phase = 'analysis';
        try {
          const declaredCompleteness = row.completeness ?? 'unknown';
          if (prior?.status === 'failed' && prior.analysisReusable === true && text(prior.analysisPath)) {
            analysis = await readJson(join(root, prior.analysisPath));
            analysis = inspectAnalysis(analysis, source, sourceText, declaredCompleteness);
            analysisPath = prior.analysisPath;
            await immutable(join(attemptRoot, 'analysis.reused.json'), {sourceAttemptId: prior.attemptId, analysisPath});
          } else {
            let priorReview = null;
            if (prior?.reviewPath) priorReview = await readJson(join(root, prior.reviewPath)).catch(() => null);
            const retryFeedback = supersede ? {kind: 'completed_attempt_supersede', priorAttemptId: prior.attemptId,
              reason: supersede.reason, findings: supersede.feedback}
              : prior?.status === 'failed' ? {kind: 'failed_attempt_retry', priorAttemptId: prior.attemptId, code: prior.code,
                message: prior.message, phase: prior.phase, ...(priorReview ? {review: priorReview} : {})} : null;
            const requestA = analysisRequest(source, sourceText, declaredCompleteness, retryFeedback);
            analysis = await invokeValidated({role: 'analysis', source, attemptId, attemptRoot, request: requestA,
              validate: value => inspectAnalysis(value, source, sourceText, declaredCompleteness)});
            analysisPath = relative(root, join(attemptRoot, 'analysis.validated.json'));
            await immutable(join(root, analysisPath), analysis);
          }
          phase = 'review';
          const requestR = reviewRequest(source, analysis);
          const review = await invokeValidated({role: 'review', source, attemptId, attemptRoot, request: requestR,
            validate: value => inspectReview(value, analysis)});
          const reviewPath = relative(root, join(attemptRoot, 'review.validated.json'));
          await immutable(join(root, reviewPath), review);
          check(review.approved, 'BATCH_REVIEW_REJECTED', 'Independent review rejected one or more observations');
          const completed = {schemaVersion: NARRATIVE_BATCH_RUN_VERSION, sourceId: source.sourceId, status: 'completed', attemptId,
            completedAt: now(), analysisPath, reviewPath, ...(supersede ? {supersedesAttemptId: prior.attemptId,
              supersedeReason: supersede.reason} : {})};
          await atomicJson(statusPath, completed); outcomes.push({sourceId: source.sourceId, status: 'completed'});
        } catch (error) {
          const reviewCandidatePath = relative(root, join(attemptRoot, 'review.validated.json'));
          await atomicJson(statusPath, {schemaVersion: NARRATIVE_BATCH_RUN_VERSION, sourceId: source.sourceId, status: 'failed', attemptId,
            failedAt: now(), phase, code: error.code ?? 'BATCH_FAILED', message: error.message,
            ...(analysisPath ? {analysisPath, analysisReusable: phase === 'review' && error.code !== 'BATCH_REVIEW_REJECTED'} : {}),
            ...(await exists(join(root, reviewCandidatePath)) ? {reviewPath: reviewCandidatePath} : {}),
            ...(supersede ? {supersedesAttemptId: prior.attemptId, supersedeReason: supersede.reason} : {})});
          outcomes.push({sourceId: source.sourceId, status: 'failed', code: error.code ?? 'BATCH_FAILED'});
        }
      }
      const budget = await readBudget();
      return {schemaVersion: NARRATIVE_BATCH_RUN_VERSION, logicalModelAttempts: budget.usedLogicalModelAttempts,
        maxLogicalModelAttempts, actualProviderPosts: 'counted_only_by_main_provider_ledger', outcomes};
    }};
}

/**
 * Revalidate a terminal failed analysis raw after a host-validator correction.
 * This performs no model call and preserves the original attempt directory.
 * A new recovery receipt makes the validated analysis reusable by the normal
 * retry path, which will then call only the independent review stage.
 */
export async function recoverNarrativeObservationAnalysisFromFailedAttempt({libraryRoot, runRoot, selection, sourceId,
  now = () => new Date().toISOString()} = {}) {
  check(text(libraryRoot) && text(runRoot) && text(sourceId), 'RECOVERY_CONFIG', 'Library, run root and sourceId are required');
  const library = resolve(libraryRoot), root = resolve(runRoot);
  const frozen = inspectNarrativeBatchSelection(selection ?? await readJson(join(root, 'selection-manifest.json')));
  const frozenPath = join(root, 'selection-manifest.json');
  check(await exists(frozenPath) && JSON.stringify(await readJson(frozenPath)) === JSON.stringify(frozen),
    'RECOVERY_SELECTION', 'Run selection differs from the supplied frozen selection');
  const source = frozen.sources.find(item => item.sourceId === sourceId);
  check(source, 'RECOVERY_SOURCE', 'Source is absent from the frozen selection');
  const sourceRoot = join(root, 'sources', sourceId), statusPath = join(sourceRoot, 'status.json');
  const statusBytes = await readReadyFile(statusPath), prior = JSON.parse(statusBytes);
  if (prior.status === 'failed' && prior.code === 'BATCH_REVIEW_PENDING' && prior.analysisReusable === true && text(prior.analysisPath)) {
    return {schemaVersion: 'narrative-observation-analysis-raw-recovery-v1', sourceId, status: 'already_recovered',
      recoveryAttemptId: prior.attemptId, recoveredFromAttemptId: prior.recoveredFromAttemptId,
      analysisPath: prior.analysisPath, logicalModelAttemptsConsumed: 0, actualProviderPostsByRecovery: 0};
  }
  check(prior.status === 'failed' && prior.phase === 'analysis' && text(prior.attemptId), 'RECOVERY_STATUS',
    'Only a terminal failed analysis attempt can be recovered');
  const originalAttemptRoot = join(sourceRoot, 'attempts', prior.attemptId);
  const requestPath = join(originalAttemptRoot, 'analysis.request.json'), rawPath = join(originalAttemptRoot, 'analysis.response.raw.txt');
  const requestBytes = await readReadyFile(requestPath), rawBytes = await readReadyFile(rawPath), request = JSON.parse(requestBytes);
  let requestUser;
  try { requestUser = JSON.parse(request.user); } catch { throw failure('RECOVERY_REQUEST', 'Original analysis request user payload is invalid'); }
  check(request.stage === 'narrative-observation-analysis' && requestUser.sourceId === sourceId
    && requestUser.outputContract?.exactExample?.schemaVersion === NARRATIVE_BATCH_ANALYSIS_VERSION
    && requestUser.outputContract?.evidenceWindowContract?.selectionKey === 'windowId',
  'RECOVERY_REQUEST', 'Original attempt did not use the current window-bound analysis contract');
  const catalogBytes = await readReadyFile(join(library, 'catalog.json'));
  if (frozen.activeBinding) check(hash(catalogBytes) === frozen.activeBinding.catalogSha256,
    'RECOVERY_CATALOG', 'Active catalog digest differs from the frozen selection binding');
  const catalog = JSON.parse(catalogBytes), row = catalog.sources.find(item => item.sourceId === sourceId);
  check(row && row.sourceSha256 === source.sourceSha256 && row.textVersion === source.textVersion,
    'RECOVERY_CATALOG', 'Catalog source binding changed');
  const objectBytes = await readReadyFile(join(library, 'objects', `${source.sourceSha256}.bin`));
  check(hash(objectBytes) === source.sourceSha256, 'RECOVERY_SOURCE', 'Source bytes changed');
  const sourceText = await readReadyFile(join(library, 'objects', `${source.sourceSha256}.lf-v2.txt`), 'utf8');
  check(hash(sourceText) === (row.indexIntegrity?.sourceTextSha256 ?? source.sourceSha256),
    'RECOVERY_SOURCE', 'Normalized text changed');
  const analysis = inspectAnalysis(parsed(rawBytes.toString('utf8'), 'analysis'), source, sourceText, row.completeness ?? 'unknown');
  const budgetPath = join(root, 'logical-model-attempt-budget.json');
  const budgetBefore = await readJson(budgetPath);
  const recoveryAttemptId = `${Date.now()}-${randomUUID()}-raw-recovery`, recoveryRoot = join(sourceRoot, 'attempts', recoveryAttemptId);
  const analysisPath = relative(root, join(recoveryRoot, 'analysis.recovered-from-raw.json'));
  const receiptPath = relative(root, join(recoveryRoot, 'recovery-receipt.json'));
  await immutable(join(root, analysisPath), analysis);
  const receipt = {schemaVersion: 'narrative-observation-analysis-raw-recovery-v1', sourceId,
    recoveryAttemptId, recoveredFromAttemptId: prior.attemptId, recoveredFromStatusSha256: hash(statusBytes),
    requestPath: relative(root, requestPath), requestSha256: hash(requestBytes), rawPath: relative(root, rawPath),
    rawSha256: hash(rawBytes), analysisPath, analysisSha256: hash(JSON.stringify(analysis)), recoveredAt: now(),
    recoveryReason: {failedCode: prior.code, failedMessage: prior.message,
      validatorChange: 'remove_positive_natural-language_scope_whitelist_while_preserving_catalog_scope_and_visible-ending-denial'},
    logicalModelAttemptsBefore: budgetBefore.usedLogicalModelAttempts,
    logicalModelAttemptsAfter: budgetBefore.usedLogicalModelAttempts, logicalModelAttemptsConsumed: 0,
    actualProviderPostsByRecovery: 0, nextRequiredStage: 'narrative-observation-review'};
  await immutable(join(root, receiptPath), receipt);
  await atomicJson(statusPath, {schemaVersion: NARRATIVE_BATCH_RUN_VERSION, sourceId, status: 'failed', attemptId: recoveryAttemptId,
    failedAt: now(), phase: 'review', code: 'BATCH_REVIEW_PENDING',
    message: 'Analysis raw passed current strict validation; independent review is still required', analysisPath,
    analysisReusable: true, recoveredFromAttemptId: prior.attemptId, recoveredRawPath: relative(root, rawPath),
    recoveredRawSha256: hash(rawBytes), recoveryReceiptPath: receiptPath, recoveryLogicalModelAttempts: 0});
  const budgetAfter = await readJson(budgetPath);
  check(budgetAfter.usedLogicalModelAttempts === budgetBefore.usedLogicalModelAttempts
    && budgetAfter.attempts.length === budgetBefore.attempts.length, 'RECOVERY_BUDGET', 'Raw recovery changed the logical model budget');
  return {schemaVersion: receipt.schemaVersion, sourceId, status: 'recovered_for_review', recoveryAttemptId,
    recoveredFromAttemptId: prior.attemptId, analysisPath, recoveryReceiptPath: receiptPath,
    logicalModelAttemptsConsumed: 0, actualProviderPostsByRecovery: 0};
}

function archiveEvidence(item, field, id, textVersion) {
  const locator = {unit: `${item.lineStart}-${item.lineEnd}`, line_start: item.lineStart, line_end: item.lineEnd,
    paragraph_start: item.lineStart, paragraph_end: item.lineEnd, char_start: item.matchedQuoteUtf16Start, char_end: item.matchedQuoteUtf16End};
  return {evidence_id: id, supports: [field], locator, cue: item.quote, support_type: 'direct',
    inference: '候选观察所引用的当前可见文本。', verification: {status: 'verified', reasons: [],
      basis: 'host_derived_from_bound_local_event_window_id', textVersion, evidenceWindowId: item.windowId,
      lineWindowUtf16Start: item.lineWindowUtf16Start, lineWindowUtf16End: item.lineWindowUtf16End,
      lineWindowBodySha256: item.lineWindowBodySha256, charWindowUtf16Start: item.matchedQuoteUtf16Start,
      charWindowUtf16End: item.matchedQuoteUtf16End, charWindowBodySha256: item.matchedQuoteBodySha256,
      intersectionUtf16Start: item.matchedQuoteUtf16Start, intersectionUtf16End: item.matchedQuoteUtf16End,
      intersectionBodySha256: item.matchedQuoteBodySha256, matchedCueUtf16Start: item.matchedQuoteUtf16Start,
      matchedCueUtf16End: item.matchedQuoteUtf16End}};
}

async function walkFiles(root, current = root) {
  const paths = [];
  for (const entry of await readdir(current, {withFileTypes: true})) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) paths.push(...await walkFiles(root, path));
    else if (entry.isFile() && relative(root, path) !== 'package-manifest.json') paths.push(path);
  }
  return paths;
}

export async function publishNarrativeObservationBatch({libraryRoot, basePackageRoot, runRoot, outputRoot, selection} = {}) {
  const frozen = inspectNarrativeBatchSelection(selection), library = resolve(libraryRoot), base = resolve(basePackageRoot), run = resolve(runRoot), output = resolve(outputRoot);
  check(!(await exists(output)), 'PUBLISH_EXISTS', 'Publication output already exists');
  const catalogBytes = await readReadyFile(join(library, 'catalog.json'));
  if (frozen.activeBinding) check(hash(catalogBytes) === frozen.activeBinding.catalogSha256,
    'PUBLISH_ACTIVE_CATALOG', 'Active catalog digest differs from frozen selection binding');
  const catalog = JSON.parse(catalogBytes), rows = new Map(catalog.sources.map(row => [row.sourceId, row]));
  const parent = dirname(output); await mkdir(parent, {recursive: true});
  const temporaryRoot = await mkdtemp(join(parent, '.narrative-publish-'));
  const temporary = join(temporaryRoot, 'package');
  try {
    await cp(base, temporary, {recursive: true, force: false, errorOnExist: true});
    const published = [];
    for (const source of frozen.sources) {
      const status = await readJson(join(run, 'sources', source.sourceId, 'status.json'));
      check(status.status === 'completed', 'PUBLISH_INCOMPLETE', `Source ${source.sourceId} is not completed`);
      const row = rows.get(source.sourceId);
      check(row && row.sourceSha256 === source.sourceSha256 && row.textVersion === source.textVersion, 'PUBLISH_CATALOG', 'Catalog binding changed');
      const sourceText = await readReadyFile(join(library, 'objects', `${source.sourceSha256}.lf-v2.txt`), 'utf8');
      const analysis = inspectAnalysis(await readJson(join(run, status.analysisPath)), source, sourceText, row.completeness ?? 'unknown');
      const review = inspectReview(await readJson(join(run, status.reviewPath)), analysis);
      check(review.approved && review.analysisSha256 === hash(JSON.stringify(analysis)), 'PUBLISH_REVIEW', 'Approved strict-evidence review binding changed');
      const storyId = `st_wr_${hash(source.sourceId).slice(0, 12)}`, evidence = [], observationIds = new Map();
      for (const observation of analysis.observations) {
        const ids = observation.evidence.map(item => { const id = `E${String(evidence.length + 1).padStart(2, '0')}`; evidence.push(archiveEvidence(item, observation.field, id, source.textVersion)); return id; });
        observationIds.set(observation.observationId, ids);
      }
      const card = {schema_version: '2.0', story_id: storyId, source_path: `library/objects/${source.sourceSha256}.lf-v2.txt`,
        source_sha256: source.sourceSha256, source_stats: {chars: sourceText.length, line_count: sourceText.split('\n').length,
          source_integrity: row.completeness ?? 'unknown', integrity_scope: 'provided_artifact', external_master_verified: false},
        title: source.title, ...Object.fromEntries(analysis.observations.map(item => [item.field, {summary: item.summary,
          psychologyChange: item.psychologyChange, emotionOrganization: item.emotionOrganization, expressionEffect: item.expressionEffect,
          readerEffectHypothesis: item.readerEffectHypothesis, applicabilityBoundary: item.applicabilityBoundary,
          counterEvidence: item.counterEvidence, visibilityBoundary: item.visibilityBoundary}])),
        boundary_origin: Object.fromEntries(analysis.observations.map(item => [item.field, 'analyst_observed'])),
        field_confidence: Object.fromEntries(analysis.observations.map(item => [item.field, 'reviewed_candidate'])),
        evidence: evidence.map(({verification, ...item}) => item), production: {batch: 'whole-revision-r01-data', revision: 'r01', status: 'accepted', worker: 'injected-provider-batch'}};
      const cardBytes = Buffer.from(json(card)), cardSha256 = hash(cardBytes);
      const audit = {schema_version: 'whole-revision-narrative-audit-1.0', story_id: storyId,
        card: {path: `archive/cards/${storyId}.json`, sha256: cardSha256, creator_id: 'whole-revision-r01-data', revision: 'r01'},
        source: {path: card.source_path, sha256: source.sourceSha256}, automated_checks: {status: 'pass'},
        independent_reviews: {semantic: {reviewer_id: 'injected-independent-review', verdict: 'PASS', notes: review.notes}},
        review_summary: {disposition: 'ELIGIBLE_FOR_OBSERVATION_PUBLICATION'}, findings: [],
        aggregate: {status: 'ACCEPTED', decision: 'accepted', blocking_finding_ids: []}};
      const auditBytes = Buffer.from(json(audit)), auditSha256 = hash(auditBytes);
      const projectedEvidence = evidence.map(item => ({evidenceId: item.evidence_id, supports: item.supports, locator: item.locator,
        cue: item.cue, supportType: item.support_type, inference: item.inference, verification: item.verification}));
      const referenced = new Set([...observationIds.values()].flat());
      const sidecar = {schemaVersion: 'narrative-observation-sidecar-v2', status: 'offline_generated_not_installed',
        sourceBinding: {sourceId: source.sourceId, sourceSha256: source.sourceSha256, textVersion: source.textVersion,
          normalizedTextSha256: row.indexIntegrity?.sourceTextSha256 ?? source.sourceSha256,
          currentAnalysisVersionAtGeneration: row.analysis?.version ?? null,
          currentReviewRecordIdAtGeneration: row.analysis?.validation?.semanticReview?.recordId ?? null},
        cardBinding: {storyId, title: source.title, originalCardPath: null, archivedCardPath: `archive/cards/${storyId}.json`, cardSha256,
          cardSourcePath: card.source_path, cardSourceSha256: source.sourceSha256, acceptedStatus: 'accepted', auditMatchesCurrentRevision: true,
          originalAuditPath: null, archivedAuditPath: `archive/audits/${storyId}.json`, auditSha256, cardSchemaVersion: '2.0'},
        originalValidationState: {schemaVersion: audit.schema_version, automatedChecks: audit.automated_checks,
          independentReviews: audit.independent_reviews, reviewSummary: audit.review_summary, aggregate: audit.aggregate, findings: []},
        evidenceCounts: {totalCardEvidence: evidence.length, observationReferencedEvidence: referenced.size,
          unreferencedEvidence: evidence.length - referenced.size, verifiedCardEvidence: evidence.length, unverifiedCardEvidence: 0},
        cardEvidence: projectedEvidence,
        observations: analysis.observations.map(item => ({field: item.field, value: card[item.field], classification: 'observable_narrative_choice',
          authorIntentClaimed: false, originalFieldConfidence: 'reviewed_candidate', boundaryOrigin: 'analyst_observed',
          evidenceIds: observationIds.get(item.observationId), evidenceVerificationStatus: 'verified',
          supplyEligibility: 'eligible_only_after_explicit_retrieval_integration_and_scope_registration'})),
        supplyPolicy: {automaticSupply: false, retrievalIntegrated: false, grantsCheckedAnalysisStatus: false, unverifiedEvidenceSupplyAllowed: false},
        boundaries: {literaryQualityValidated: false, readerEffectsAreHypotheses: true, universalWritingRuleClaimed: false,
          visibleTextScope: analysis.visibleTextScope, externalMasterVerified: false, limitations: analysis.limitations}};
      await immutable(join(temporary, 'archive', 'cards', `${storyId}.json`), cardBytes);
      await immutable(join(temporary, 'archive', 'audits', `${storyId}.json`), auditBytes);
      await immutable(join(temporary, 'sidecars', source.sourceId, `${storyId}.json`), sidecar);
      published.push({sourceId: source.sourceId, storyId, observationCount: analysis.observations.length});
    }
    const files = (await walkFiles(temporary)).sort((a, b) => relative(temporary, a).localeCompare(relative(temporary, b)));
    const entries = [];
    for (const path of files) { const bytes = await readReadyFile(path); entries.push({path: relative(temporary, path), bytes: bytes.length, sha256: hash(bytes)}); }
    const manifest = {schemaVersion: 'legacy-sidecars-r02-package-manifest-v1', root: output, entries, entryCount: entries.length,
      orderedEntryDigest: hash(entries.map(item => `${item.path}\t${item.bytes}\t${item.sha256}`).join('\n'))};
    await writeFile(join(temporary, 'package-manifest.json'), json(manifest));
    await rename(temporary, output);
    await rm(temporaryRoot, {recursive: true, force: true});
    return {outputRoot: output, publishedSourceCount: published.length,
      publishedObservationCount: published.reduce((sum, item) => sum + item.observationCount, 0), published, packageManifest: manifest};
  } catch (error) { await rm(temporaryRoot, {recursive: true, force: true}); throw error; }
}

async function verifyPackageManifest(packageRoot) {
  const root = resolve(packageRoot), manifestPath = join(root, 'package-manifest.json');
  const manifestBytes = await readReadyFile(manifestPath), manifest = JSON.parse(manifestBytes);
  check(NARRATIVE_OBSERVATION_PACKAGE_MANIFEST_VERSIONS.includes(manifest.schemaVersion) && Array.isArray(manifest.entries),
    'PACKAGE_MANIFEST', 'Unsupported narrative observation package manifest');
  const files = (await walkFiles(root)).sort((a, b) => relative(root, a).localeCompare(relative(root, b)));
  const actual = [];
  for (const path of files) { const bytes = await readReadyFile(path); actual.push({path: relative(root, path), bytes: bytes.length, sha256: hash(bytes)}); }
  check(JSON.stringify(actual) === JSON.stringify(manifest.entries), 'PACKAGE_CONTENT', 'Narrative observation package entries changed');
  check(manifest.entryCount === actual.length
    && manifest.orderedEntryDigest === hash(actual.map(item => `${item.path}\t${item.bytes}\t${item.sha256}`).join('\n')),
    'PACKAGE_DIGEST', 'Narrative observation package digest changed');
  const sidecarFiles = files.filter(path => relative(root, path).startsWith(`sidecars${sep}`) && path.endsWith('.json'));
  const sourceIds = new Set();
  for (const path of sidecarFiles) {
    const sidecar = await readJson(path);
    check(text(sidecar?.sourceBinding?.sourceId) && !sourceIds.has(sidecar.sourceBinding.sourceId),
      'PACKAGE_SIDECARS', 'Duplicate or invalid sidecar source binding');
    sourceIds.add(sidecar.sourceBinding.sourceId);
  }
  return {root, manifest, manifestSha256: hash(manifestBytes), sourceCount: sourceIds.size};
}

/**
 * Install a verified immutable package below the library without changing
 * catalog.json, source objects, indexes or aliases. The only mutable file is
 * the atomically replaced active pointer.
 */
export async function installNarrativeObservationPackage({libraryRoot, publishedPackageRoot, expectedSourceCount = 37} = {}) {
  const library = resolve(libraryRoot), checked = await verifyPackageManifest(publishedPackageRoot);
  check(checked.sourceCount === expectedSourceCount, 'PACKAGE_SOURCE_COUNT', `Expected ${expectedSourceCount} bound sources`);
  const packageId = checked.manifest.orderedEntryDigest;
  const store = join(library, 'narrative-observations'), packages = join(store, 'packages'), destination = join(packages, packageId);
  await mkdir(packages, {recursive: true});
  if (!(await exists(destination))) {
    const staging = join(packages, `.${packageId}.${randomUUID()}.tmp`);
    await cp(checked.root, staging, {recursive: true, force: false, errorOnExist: true});
    await rename(staging, destination);
  }
  const installed = await verifyPackageManifest(destination);
  check(installed.manifestSha256 === checked.manifestSha256, 'PACKAGE_INSTALL', 'Installed package differs from publication');
  const pointer = {schemaVersion: 'narrative-observation-active-v1', packageId,
    relativePackagePath: `packages/${packageId}`, packageManifestSha256: installed.manifestSha256,
    orderedEntryDigest: installed.manifest.orderedEntryDigest, sourceCount: installed.sourceCount};
  await atomicJson(join(store, 'active.json'), pointer);
  return {pointer, packageRoot: destination};
}

/** Resolve and fully verify the active package before product injection. */
export async function resolveActiveNarrativeObservationPackage({libraryRoot, expectedSourceCount = 37} = {}) {
  const library = resolve(libraryRoot), store = join(library, 'narrative-observations'), pointer = await readJson(join(store, 'active.json'));
  check(pointer.schemaVersion === 'narrative-observation-active-v1' && text(pointer.relativePackagePath), 'ACTIVE_POINTER', 'Invalid active pointer');
  const packageRoot = resolve(store, pointer.relativePackagePath), rel = relative(store, packageRoot);
  check(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'ACTIVE_POINTER', 'Active package escapes its store');
  const checked = await verifyPackageManifest(packageRoot);
  check(pointer.packageId === checked.manifest.orderedEntryDigest && pointer.orderedEntryDigest === checked.manifest.orderedEntryDigest
    && pointer.packageManifestSha256 === checked.manifestSha256 && pointer.sourceCount === checked.sourceCount
    && checked.sourceCount === expectedSourceCount, 'ACTIVE_POINTER', 'Active package binding changed');
  return {packageRoot, pointer: structuredClone(pointer)};
}
