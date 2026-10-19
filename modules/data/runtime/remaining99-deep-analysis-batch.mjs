import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, stat, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';

export const DEEP_PACKET_VERSION = 'remaining99-evidence-packet-v1';
export const DEEP_QUEUE_VERSION = 'remaining99-deep-analysis-queue-v1';
export const DEEP_MODEL_OUTPUT_VERSION = 'remaining99-deep-analysis-model-output-v1';
export const DEEP_CANDIDATE_VERSION = 'remaining99-deep-analysis-candidate-v1';
export const DEEP_RUN_VERSION = 'remaining99-deep-analysis-run-v1';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const substantive = value => text(value) && !/^(?:not[-_ ]?used|n\/?a|none|null|unknown|待补|暂无|无)$/iu.test(value.trim());
const fail = (code, message, details) => Object.assign(new Error(message), {code, details});
const check = (condition, code, message, details) => { if (!condition) throw fail(code, message, details); };

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Every read is preceded by stat; zero-byte/dataless inputs are rejected. */
export async function readReady(path, encoding = undefined) {
  const metadata = await stat(path);
  check(metadata.isFile(), 'INPUT_NOT_FILE', `Not a regular file: ${path}`);
  check(metadata.size > 0, 'INPUT_EMPTY_OR_DATALESS', `Input is empty or unavailable: ${path}`);
  // Node Stats does not expose macOS st_flags. Native stat reads metadata only.
  const flags = process.platform === 'darwin' ? Number(execFileSync('/usr/bin/stat', ['-L','-f','%f',path], {encoding:'utf8'}).trim()) : metadata.flags;
  if (flags !== undefined) {
    check(Number.isSafeInteger(flags) && (flags & 0x40000000) === 0, 'INPUT_DATALESS', `Input has the dataless flag or unavailable metadata: ${path}`);
  }
  return readFile(path, encoding);
}

async function atomicJson(path, value) {
  await mkdir(dirname(path), {recursive: true});
  const temporary = `${path}.next-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, json(value), {mode: 0o600});
  await rename(temporary, path);
}

async function immutable(path, value, encoding = undefined) {
  await mkdir(dirname(path), {recursive: true});
  const bytes = encoding ? value : Buffer.isBuffer(value) ? value : json(value);
  await writeFile(path, bytes, {flag: 'wx', mode: 0o600, ...(encoding ? {encoding} : {})});
}

function safeInside(root, child) {
  const full = resolve(root, child), rel = relative(resolve(root), full);
  check(rel && rel !== '..' && !rel.startsWith(`..${sep}`), 'PATH_ESCAPE', 'Path escapes its declared root', {root, child});
  return full;
}

function reviewedBinding(row) {
  const analysis = row?.analysis, review = analysis?.validation?.semanticReview;
  return analysis?.reviewStatus === 'checked'
    && analysis?.validation?.literalEvidence === 'passed'
    && review?.approved === true
    && text(review.recordId)
    && review.sourceId === row.sourceId
    && review.textVersion === row.textVersion
    && review.analysisVersion === analysis.version
    && analysis.textVersion === row.textVersion;
}

function lineIndex(sourceText) {
  const lines = sourceText.split('\n'), starts = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  return {lines, starts};
}

function bindEvidence({sourceText, sourceId, textVersion, analysisVersion, unit, evidence, ordinal}) {
  check(object(evidence) && text(evidence.quote), 'EVIDENCE_SHAPE', 'Evidence requires a nonempty verbatim quote', {sourceId, unitId: unit.id, ordinal});
  const index = lineIndex(sourceText), lineStart = evidence.lineStart, lineEnd = evidence.lineEnd;
  check(Number.isSafeInteger(lineStart) && Number.isSafeInteger(lineEnd) && lineStart >= 1 && lineEnd >= lineStart && lineEnd <= index.lines.length,
    'EVIDENCE_LINES', 'Evidence line window is invalid', {sourceId, unitId: unit.id, ordinal, lineStart, lineEnd});
  const windowStart = index.starts[lineStart - 1];
  const windowEnd = index.starts[lineEnd - 1] + index.lines[lineEnd - 1].length;
  const window = sourceText.slice(windowStart, windowEnd), local = window.indexOf(evidence.quote);
  check(local >= 0, 'EVIDENCE_LITERAL', 'Evidence quote is absent from its declared line window', {sourceId, unitId: unit.id, ordinal});
  const quoteSha256 = sha256(evidence.quote);
  const evidenceId = `EV-${sha256([sourceId, textVersion, analysisVersion, unit.id, ordinal, quoteSha256].join('\0')).slice(0, 24)}`;
  return {
    evidenceId,
    origin: 'catalog.analysis.units[].evidence',
    sourceId,
    unitId: unit.id,
    catalogEvidenceOrdinal: ordinal,
    quote: evidence.quote,
    locator: {lineStart, lineEnd, charStart: windowStart + local, charEnd: windowStart + local + evidence.quote.length},
    binding: {textVersion, quoteSha256, lineWindowSha256: sha256(window), literalStatus: 'verified'},
  };
}

function packetPayload(row, sourceText, sourceTextSha256) {
  check(reviewedBinding(row), 'SOURCE_REVIEW_BINDING', 'Source lacks a current checked/approved catalog analysis binding', {sourceId: row?.sourceId});
  const analysis = row.analysis, review = analysis.validation.semanticReview;
  check(Array.isArray(analysis.units) && analysis.units.length >= 3, 'SOURCE_UNITS', 'At least three checked units are required', {sourceId: row.sourceId});
  const ids = new Set();
  for (const unit of analysis.units) {
    check(text(unit?.id) && !ids.has(unit.id), 'UNIT_ID', 'Unit IDs must be nonempty and unique', {sourceId: row.sourceId, unitId: unit?.id});
    ids.add(unit.id);
    check(object(unit.locator) && Array.isArray(unit.evidence) && unit.evidence.length > 0, 'UNIT_EVIDENCE', 'Every checked unit must retain evidence', {sourceId: row.sourceId, unitId: unit.id});
  }
  const evidenceRegistry = [], units = [];
  for (const [unitIndex, unit] of analysis.units.entries()) {
    const evidenceIds = [];
    for (const [evidenceIndex, evidence] of unit.evidence.entries()) {
      const bound = bindEvidence({sourceText, sourceId: row.sourceId, textVersion: row.textVersion,
        analysisVersion: analysis.version, unit, evidence, ordinal: evidenceIndex + 1});
      check(!evidenceRegistry.some(item => item.evidenceId === bound.evidenceId), 'EVIDENCE_ID_COLLISION', 'Evidence ID collision', {sourceId: row.sourceId});
      evidenceRegistry.push(bound); evidenceIds.push(bound.evidenceId);
    }
    units.push({
      unitId: unit.id,
      sequenceOrdinal: unitIndex + 1,
      title: unit.title,
      locator: unit.locator,
      existingCheckedAnalysis: {
        event: unit.event,
        psychology: unit.psychology,
        emotion: unit.emotion,
        expression: unit.expression,
        readerEffectHypothesis: unit.readerEffectHypothesis,
      },
      evidenceIds,
      relatedUnitIds: Array.isArray(unit.relatedUnitIds) ? unit.relatedUnitIds : [],
    });
  }
  const payload = {
    schemaVersion: DEEP_PACKET_VERSION,
    sourceBinding: {
      sourceId: row.sourceId,
      title: row.title,
      sourceSha256: row.sourceSha256,
      sourceTextSha256,
      textVersion: row.textVersion,
      declaredCompleteness: row.completeness ?? 'unknown',
      analysisVersion: analysis.version,
      analysisContentVersion: analysis.contentVersion ?? null,
      analysisTextVersion: analysis.textVersion,
      reviewRecordId: review.recordId,
      reviewOutcome: review.outcome ?? 'approved',
      reviewMethod: review.method ?? null,
      reviewBindingStatus: 'valid_checked_source_analysis',
    },
    visibilityBoundary: {
      suppliedToModel: 'all checked analysis units and every catalog evidence quote attached to those units',
      notSupplied: 'the contiguous full source text outside the evidence quotations; hidden drafts; author testimony; reader studies; platform or ROI data',
      completeness: row.completeness ?? 'unknown',
      interpretationRule: 'Psychology, emotional causality, reader effects and craft functions remain evidence-bound AI hypotheses. They are not facts about inner states, author intent or actual readers.',
    },
    inheritedCoverage: analysis.coverage ?? null,
    inheritedLimitations: Array.isArray(analysis.limitations) ? analysis.limitations : [],
    units,
    evidenceRegistry,
  };
  return {...payload, hostBindingSha256: sha256(json(payload))};
}

function outputContract(packet) {
  return {
    emotionalProgression: {
      synthesis: 'new cross-unit synthesis, not a copied unit summary',
      stages: [{stageId: 'EP1', unitIds: ['checked-unit-id'], evidenceIds: ['EV-host-id'], observedState: 'observable emotional state/signals', interpretation: 'bounded hypothesis', uncertainty: 'what the evidence cannot establish'}],
      transitions: [{fromStageId: 'EP1', toStageId: 'EP2', evidenceIds: ['EV-host-id-from', 'EV-host-id-to'], observedChange: 'what changes across units', possibleDriver: 'hypothesis, not fact', alternatives: ['plausible alternative'], uncertainty: 'boundary'}],
    },
    psychologicalChangeDrivers: {
      synthesis: 'new cross-unit synthesis',
      drivers: [{driverId: 'PD1', beforeUnitIds: ['unit-id'], afterUnitIds: ['different-unit-id'], evidenceIds: ['EV-from', 'EV-to'], observedTrigger: 'textual event/action', changeHypothesis: 'bounded inference', alternatives: ['alternative'], counterEvidenceOrGap: 'missing or conflicting support', uncertainty: 'boundary'}],
    },
    observableCraftDecisionHypotheses: {
      synthesis: 'new cross-unit synthesis',
      hypotheses: [{hypothesisId: 'CH1', unitIds: ['unit-a', 'unit-b'], evidenceIds: ['EV-a', 'EV-b'], observablePattern: 'ordering/repetition/contrast/disclosure visible in supplied evidence', possibleFunction: 'AI hypothesis only', alternatives: ['alternative explanation'], limitation: 'not author intent; no ROI or reader-result claim'}],
    },
    limitations: ['Only supplied checked units and verbatim evidence were visible.', 'All causal, psychological and craft-function statements are AI hypotheses.'],
    exactFormatRules: {
      modelOwnedTopLevelKeys: ['emotionalProgression', 'psychologicalChangeDrivers', 'observableCraftDecisionHypotheses', 'limitations'],
      hostOwnedMetadata: {schemaVersion: DEEP_MODEL_OUTPUT_VERSION, sourceId: packet.sourceBinding.sourceId, hostBindingSha256: packet.hostBindingSha256},
      metadataRule: 'Omit host-owned metadata. If any host-owned metadata key is emitted, its value must exactly match the supplied host binding or the response is rejected.',
      minimumCounts: {emotionalStages: 3, emotionalTransitions: 2, psychologicalDrivers: 2, observableCraftHypotheses: 2},
      placeholderValuesForbidden: ['not-used', 'n/a', 'none', 'unknown'],
      evidenceSpanRule: 'Every transition, psychological driver and craft hypothesis must cite evidence from at least two distinct units; before and after psychological sides must each have cited evidence.',
      exactFieldNamesRequired: true,
    },
  };
}

export function buildDeepAnalysisRequest(packet) {
  check(packet?.schemaVersion === DEEP_PACKET_VERSION, 'PACKET_VERSION', 'Unsupported evidence packet');
  const system = [
    '你是证据约束的叙事分析器。只依据宿主给出的全部 checked 单元和逐字 evidence registry 生成新的跨单元综合分析。',
    '必须完成三类新分析：跨单元情绪推进、心理变化驱动、可观察创作选择假说。不要把既有 event/psychology/emotion/expression/readerEffectHypothesis 改名、拼接或搬运成答案。',
    '每个实质判断都引用宿主 evidenceId；不得生成新 ID，不得改引文。跨单元判断必须跨至少两个不同单元，情绪推进至少三个阶段。',
    '心理与因果是 AI 假说；人物内心不可见时保留替代解释和缺口。创作选择只能描述可观察的排序、重复、对照、揭示或省略，并把功能写成假说；不得声称作者真实意图。',
    '不得臆造 ROI、转化、流量、平台效果、真人读者反应、外部母本内容或隐藏情节。不得输出 approved/checked/quality-pass。',
    '只输出 compact model response：顶层只能有 emotionalProgression、psychologicalChangeDrivers、observableCraftDecisionHypotheses、limitations 四个分析键。schemaVersion、sourceId、hostBindingSha256 由宿主从冻结 packet 注入，不要求模型复写；若仍输出其中任一项，值必须与宿主绑定完全一致，否则拒绝。provider 的 type=json_object 标记可省略。',
    '数量下限：emotionalProgression 至少 3 个 stages 和 2 个 transitions；psychologicalChangeDrivers 至少 2 个 drivers；observableCraftDecisionHypotheses 至少 2 个 hypotheses。每个 transition、driver、hypothesis 必须引用至少两个不同单元的证据；driver 的 before 与 after 两侧必须各有证据。',
    '字段名必须与 outputContract 完全一致，不得增加错位字段，不得用 not-used、n/a、none、unknown 等占位值。',
    '只返回一个 JSON 对象，不加 Markdown。',
  ].join('\n');
  const user = JSON.stringify({task: 'remaining99_evidence_bound_deep_analysis', packet, outputContract: outputContract(packet)});
  return {stage: 'remaining99-evidence-bound-deep-analysis', system, user, maxTokens: 9000,
    requestBinding: {sourceId: packet.sourceBinding.sourceId, hostBindingSha256: packet.hostBindingSha256,
      systemSha256: sha256(system), userSha256: sha256(user)}};
}

export async function prepareRemaining99DeepAnalysis({libraryRoot, auditPath, outputRoot, smokeCount = 3, now = () => new Date().toISOString()} = {}) {
  check(text(libraryRoot) && text(auditPath) && text(outputRoot), 'PREPARE_CONFIG', 'libraryRoot, auditPath and outputRoot are required');
  check(Number.isSafeInteger(smokeCount) && smokeCount >= 1, 'PREPARE_CONFIG', 'smokeCount must be a positive integer');
  const library = resolve(libraryRoot), root = resolve(outputRoot);
  const auditBytes = await readReady(resolve(auditPath)), catalogBytes = await readReady(join(library, 'catalog.json'));
  const audit = JSON.parse(auditBytes), catalog = JSON.parse(catalogBytes);
  check(Array.isArray(audit.sources) && audit.sources.length === 99, 'PREPARE_SCOPE', 'Semantic audit must list exactly 99 sources');
  check(Array.isArray(catalog.sources), 'PREPARE_CATALOG', 'Catalog sources are missing');
  const catalogRows = new Map(catalog.sources.map(row => [row.sourceId, row]));
  check(catalogRows.size === catalog.sources.length, 'PREPARE_CATALOG', 'Catalog source IDs are not unique');
  await mkdir(join(root, 'packets'), {recursive: true});
  const queueSources = [];
  for (const audited of audit.sources) {
    const row = catalogRows.get(audited.sourceId);
    check(row && row.sourceSha256 === audited.sourceSha256 && row.textVersion === audited.textVersion,
      'PREPARE_BINDING', 'Audit and catalog source binding differ', {sourceId: audited.sourceId});
    const sourceTextPath = join(library, 'objects', `${row.sourceSha256}.lf-v2.txt`);
    const sourceTextBytes = await readReady(sourceTextPath), sourceText = sourceTextBytes.toString('utf8');
    const expectedTextSha = row.indexIntegrity?.sourceTextSha256 ?? row.sourceSha256;
    check(sha256(sourceTextBytes) === expectedTextSha, 'PREPARE_TEXT_HASH', 'Normalized source text hash differs from catalog', {sourceId: row.sourceId});
    const packet = packetPayload(row, sourceText, expectedTextSha), packetPath = join(root, 'packets', `${row.sourceId}.json`);
    await atomicJson(packetPath, packet);
    const packetBytes = await readReady(packetPath);
    queueSources.push({sourceId: row.sourceId, title: row.title, packetPath: relative(root, packetPath), packetSha256: sha256(packetBytes),
      hostBindingSha256: packet.hostBindingSha256, unitCount: packet.units.length, evidenceCount: packet.evidenceRegistry.length,
      sourceBinding: packet.sourceBinding});
  }
  const common = {
    schemaVersion: DEEP_QUEUE_VERSION,
    generatedAt: now(),
    generatedWithoutModelOrNetwork: true,
    providerSessionOpened: false,
    approvalPolicy: 'outputs_are_candidate_unreviewed_even_after_host_validation',
    publicationPolicy: 'never_mutate_or_install_into_the_formal_library',
    retryPolicy: 'completed sources skip; failed sources remain failed unless retryFailed=true; every attempt is retained',
    auditBinding: {path: resolve(auditPath), sha256: sha256(auditBytes)},
    catalogBinding: {path: join(library, 'catalog.json'), sha256: sha256(catalogBytes), sourceCount: catalog.sources.length},
  };
  const full = {...common, queueName: 'remaining99-full', expectedSourceCount: 99, expectedInitialProviderPosts: 99, sources: queueSources};
  const smoke = {...common, queueName: `remaining99-smoke-${smokeCount}`, expectedSourceCount: smokeCount,
    expectedInitialProviderPosts: smokeCount, parentQueue: 'queue-99.json', sources: queueSources.slice(0, smokeCount)};
  await atomicJson(join(root, 'queue-99.json'), full);
  await atomicJson(join(root, `queue-smoke-${smokeCount}.json`), smoke);
  return {outputRoot: root, sourceCount: queueSources.length, smokeSourceIds: smoke.sources.map(item => item.sourceId),
    unitCount: queueSources.reduce((sum, item) => sum + item.unitCount, 0), evidenceCount: queueSources.reduce((sum, item) => sum + item.evidenceCount, 0)};
}

export async function verifyRemaining99DeepAnalysisPreparation({outputRoot, expectedSourceCount = 99, smokeCount = 3} = {}) {
  check(text(outputRoot) && Number.isSafeInteger(expectedSourceCount) && expectedSourceCount > 0, 'VERIFY_CONFIG', 'outputRoot and expectedSourceCount are required');
  const root = resolve(outputRoot);
  const fullBytes = await readReady(join(root, 'queue-99.json')), smokeBytes = await readReady(join(root, `queue-smoke-${smokeCount}.json`));
  const full = JSON.parse(fullBytes), smoke = JSON.parse(smokeBytes);
  check(full.schemaVersion === DEEP_QUEUE_VERSION && full.expectedSourceCount === expectedSourceCount && full.sources.length === expectedSourceCount,
    'VERIFY_QUEUE', 'Full queue source count or schema differs');
  check(smoke.schemaVersion === DEEP_QUEUE_VERSION && smoke.expectedSourceCount === smokeCount && smoke.sources.length === smokeCount,
    'VERIFY_QUEUE', 'Smoke queue source count or schema differs');
  check(JSON.stringify(smoke.sources.map(item => item.sourceId)) === JSON.stringify(full.sources.slice(0, smokeCount).map(item => item.sourceId)),
    'VERIFY_SMOKE', 'Smoke queue is not the declared prefix of the full queue');
  check(full.generatedWithoutModelOrNetwork === true && full.providerSessionOpened === false && smoke.generatedWithoutModelOrNetwork === true,
    'VERIFY_OFFLINE', 'Prepared queues do not carry the offline/no-session declaration');
  const seenSources = new Set(), seenEvidence = new Set();
  let unitCount = 0, evidenceCount = 0;
  for (const item of full.sources) {
    check(!seenSources.has(item.sourceId), 'VERIFY_SOURCE_ID', 'Duplicate source in full queue', {sourceId: item.sourceId});
    seenSources.add(item.sourceId);
    const packetPath = safeInside(root, item.packetPath), packetBytes = await readReady(packetPath);
    check(sha256(packetBytes) === item.packetSha256, 'VERIFY_PACKET_HASH', 'Packet hash differs from queue', {sourceId: item.sourceId});
    const packet = JSON.parse(packetBytes), {hostBindingSha256, ...payload} = packet;
    check(packet.schemaVersion === DEEP_PACKET_VERSION && packet.sourceBinding.sourceId === item.sourceId
      && hostBindingSha256 === item.hostBindingSha256 && sha256(json(payload)) === hostBindingSha256,
    'VERIFY_PACKET_BINDING', 'Packet host binding differs', {sourceId: item.sourceId});
    check(packet.units.length === item.unitCount && packet.evidenceRegistry.length === item.evidenceCount,
      'VERIFY_PACKET_COUNTS', 'Packet counts differ from queue', {sourceId: item.sourceId});
    const packetEvidence = new Map(packet.evidenceRegistry.map(evidence => [evidence.evidenceId, evidence]));
    check(packetEvidence.size === packet.evidenceRegistry.length, 'VERIFY_EVIDENCE_ID', 'Packet evidence IDs are not unique', {sourceId: item.sourceId});
    for (const unit of packet.units) {
      check(unit.evidenceIds.length > 0 && unit.evidenceIds.every(id => packetEvidence.get(id)?.unitId === unit.unitId),
        'VERIFY_UNIT_EVIDENCE', 'Unit evidence IDs do not resolve to the same unit', {sourceId: item.sourceId, unitId: unit.unitId});
    }
    for (const evidence of packet.evidenceRegistry) {
      check(!seenEvidence.has(evidence.evidenceId) && evidence.binding.literalStatus === 'verified'
        && /^[a-f0-9]{64}$/u.test(evidence.binding.quoteSha256) && sha256(evidence.quote) === evidence.binding.quoteSha256,
      'VERIFY_EVIDENCE_BINDING', 'Evidence ID or quote hash is invalid', {sourceId: item.sourceId, evidenceId: evidence.evidenceId});
      seenEvidence.add(evidence.evidenceId);
    }
    unitCount += packet.units.length; evidenceCount += packet.evidenceRegistry.length;
  }
  return {status: 'pass', sourceCount: seenSources.size, smokeCount, unitCount, evidenceCount, uniqueEvidenceIdCount: seenEvidence.size,
    modelCalls: 0, providerSessionOpened: false, approvalGranted: false};
}

function parseModelOutput(value) {
  if (object(value) && typeof value.choices?.[0]?.message?.content === 'string') return parseModelOutput(value.choices[0].message.content);
  if (object(value) && object(value.output)) return value.output;
  if (object(value)) return value;
  let raw = typeof value === 'string' ? value
    : value?.text ?? value?.content ?? value?.output_text ?? value?.choices?.[0]?.message?.content;
  if (object(raw)) return raw;
  check(typeof raw === 'string', 'MODEL_OUTPUT', 'Model adapter returned no JSON object or text');
  raw = raw.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch { throw fail('MODEL_JSON', 'Model response is not valid JSON'); }
  return parseModelOutput(parsed);
}

function allStrings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const item of value) allStrings(item, found);
  else if (object(value)) for (const item of Object.values(value)) allStrings(item, found);
  return found;
}

function ids(value, key) {
  check(Array.isArray(value?.[key]) && value[key].length > 0 && value[key].every(text), 'CANDIDATE_IDS', `${key} must be a nonempty string array`);
  return value[key];
}

function exactKeys(value, required, code, label, optional = []) {
  check(object(value), code, `${label} must be an object`);
  const requiredSet = new Set(required), allowed = new Set([...required, ...optional]);
  const missing = required.filter(key => !(key in value));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  check(missing.length === 0 && unknown.length === 0, code, `${label} fields differ from the exact contract`, {missing, unknown});
  return requiredSet;
}

function normalizeModelOwnedOutput(value, packet) {
  check(object(value), 'CANDIDATE_VERSION', 'Unsupported model output schema');
  const normalizations = [];
  const normalized = structuredClone(value);
  if ('type' in normalized) {
    check(normalized.type === 'json_object', 'CANDIDATE_VERSION', 'Unsupported model response type marker', {type: normalized.type});
    delete normalized.type;
    normalizations.push('removed-provider-type:json_object');
  }
  const expected = {
    schemaVersion: DEEP_MODEL_OUTPUT_VERSION,
    sourceId: packet.sourceBinding.sourceId,
    hostBindingSha256: packet.hostBindingSha256,
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key in normalized) {
      check(normalized[key] === expectedValue, key === 'schemaVersion' ? 'CANDIDATE_VERSION' : 'CANDIDATE_BINDING',
        `Model-provided ${key} differs from the frozen host binding`, {provided: normalized[key], expected: expectedValue});
      normalizations.push(`verified-model-metadata:${key}`);
    } else normalizations.push(`injected-host-metadata:${key}`);
    normalized[key] = expectedValue;
  }
  exactKeys(normalized,
    ['schemaVersion', 'sourceId', 'hostBindingSha256', 'emotionalProgression', 'psychologicalChangeDrivers', 'observableCraftDecisionHypotheses', 'limitations'],
    'CANDIDATE_TOP_LEVEL_FIELDS', 'Model response');
  // One observed wire spelling is an unambiguous key alias, not new content.
  // Retain the response and report the conversion; never choose between two
  // conflicting fields or relax the exact contract for any other key.
  const hypotheses = normalized.observableCraftDecisionHypotheses?.hypotheses;
  if (Array.isArray(hypotheses)) for (const [index, hypothesis] of hypotheses.entries()) {
    if (object(hypothesis) && Object.hasOwn(hypothesis, 'observedPattern')) {
      check(!Object.hasOwn(hypothesis, 'observablePattern'), 'CANDIDATE_CRAFT_ALIAS_AMBIGUOUS',
        'Craft hypothesis provides both pattern spellings');
      hypothesis.observablePattern = hypothesis.observedPattern;
      delete hypothesis.observedPattern;
      normalizations.push(`craft-pattern-key-alias:${index}:observedPattern->observablePattern`);
    }
  }
  return {normalized, normalizations};
}

export function validateDeepAnalysisModelOutput(value, packet) {
  const {normalized, normalizations} = normalizeModelOwnedOutput(value, packet);
  value = normalized;
  const unitById = new Map(packet.units.map(unit => [unit.unitId, unit]));
  const evidenceById = new Map(packet.evidenceRegistry.map(evidence => [evidence.evidenceId, evidence]));
  const usedEvidence = new Set(), usedUnits = new Set();
  const bind = (record, {minimumUnits = 1} = {}) => {
    const evidenceIds = ids(record, 'evidenceIds'), localUnits = new Set();
    for (const evidenceId of evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      check(evidence, 'CANDIDATE_EVIDENCE_ID', 'Candidate cites an unknown evidence ID', {evidenceId});
      check(evidence.binding.literalStatus === 'verified', 'CANDIDATE_EVIDENCE_BINDING', 'Candidate cites unverified evidence', {evidenceId});
      usedEvidence.add(evidenceId); usedUnits.add(evidence.unitId); localUnits.add(evidence.unitId);
    }
    check(localUnits.size >= minimumUnits, 'CANDIDATE_CROSS_UNIT', `Claim must cite evidence from at least ${minimumUnits} distinct units`);
    return {evidenceIds, localUnits};
  };
  const emotional = value.emotionalProgression;
  exactKeys(emotional, ['synthesis', 'stages', 'transitions'], 'CANDIDATE_EMOTION_FIELDS', 'emotionalProgression');
  check(object(emotional) && substantive(emotional.synthesis) && Array.isArray(emotional.stages) && emotional.stages.length >= 3
    && Array.isArray(emotional.transitions) && emotional.transitions.length >= 2, 'CANDIDATE_EMOTION', 'Emotional progression requires synthesis, at least three stages and two transitions');
  const stageIds = new Set();
  for (const stage of emotional.stages) {
    exactKeys(stage, ['stageId', 'unitIds', 'evidenceIds', 'observedState', 'interpretation', 'uncertainty'], 'CANDIDATE_STAGE_FIELDS', 'Emotional stage');
    check(text(stage?.stageId) && !stageIds.has(stage.stageId), 'CANDIDATE_STAGE', 'Emotion stage IDs must be unique');
    stageIds.add(stage.stageId);
    const unitIds = ids(stage, 'unitIds');
    check(unitIds.every(id => unitById.has(id)), 'CANDIDATE_UNIT_ID', 'Emotion stage cites an unknown unit ID');
    const binding = bind(stage);
    check([...binding.localUnits].every(id => unitIds.includes(id)), 'CANDIDATE_UNIT_EVIDENCE', 'Emotion stage unitIds do not cover cited evidence units');
    check(substantive(stage.observedState) && substantive(stage.interpretation) && substantive(stage.uncertainty), 'CANDIDATE_STAGE', 'Emotion stage lacks substantive bounded analysis');
  }
  check(new Set(emotional.stages.flatMap(stage => stage.unitIds)).size >= 3, 'CANDIDATE_EMOTION_SPAN', 'Emotion progression must span at least three distinct units');
  for (const transition of emotional.transitions) {
    exactKeys(transition, ['fromStageId', 'toStageId', 'evidenceIds', 'observedChange', 'possibleDriver', 'alternatives', 'uncertainty'], 'CANDIDATE_TRANSITION_FIELDS', 'Emotional transition');
    check(stageIds.has(transition?.fromStageId) && stageIds.has(transition?.toStageId) && transition.fromStageId !== transition.toStageId,
      'CANDIDATE_TRANSITION', 'Emotion transition must connect two declared distinct stages');
    bind(transition, {minimumUnits: 2});
    check(substantive(transition.observedChange) && substantive(transition.possibleDriver) && Array.isArray(transition.alternatives)
      && transition.alternatives.some(substantive) && substantive(transition.uncertainty), 'CANDIDATE_TRANSITION', 'Emotion transition lacks change, driver, alternatives or uncertainty');
  }
  const psychology = value.psychologicalChangeDrivers;
  exactKeys(psychology, ['synthesis', 'drivers'], 'CANDIDATE_PSYCHOLOGY_FIELDS', 'psychologicalChangeDrivers');
  check(object(psychology) && substantive(psychology.synthesis) && Array.isArray(psychology.drivers) && psychology.drivers.length >= 2,
    'CANDIDATE_PSYCHOLOGY', 'Psychological change requires synthesis and at least two drivers');
  for (const driver of psychology.drivers) {
    exactKeys(driver, ['driverId', 'beforeUnitIds', 'afterUnitIds', 'evidenceIds', 'observedTrigger', 'changeHypothesis', 'alternatives', 'counterEvidenceOrGap', 'uncertainty'], 'CANDIDATE_PSYCHOLOGY_FIELDS', 'Psychological driver');
    const before = ids(driver, 'beforeUnitIds'), after = ids(driver, 'afterUnitIds');
    check([...before, ...after].every(id => unitById.has(id)) && before.some(id => !after.includes(id)), 'CANDIDATE_PSYCHOLOGY_UNITS', 'Psychological driver must connect known distinct before/after units');
    const binding = bind(driver, {minimumUnits: 2});
    check([...binding.localUnits].some(id => before.includes(id)) && [...binding.localUnits].some(id => after.includes(id)),
      'CANDIDATE_PSYCHOLOGY_EVIDENCE', 'Psychological evidence must cover before and after units');
    check(substantive(driver.observedTrigger) && substantive(driver.changeHypothesis) && Array.isArray(driver.alternatives) && driver.alternatives.some(substantive)
      && substantive(driver.counterEvidenceOrGap) && substantive(driver.uncertainty), 'CANDIDATE_PSYCHOLOGY', 'Psychological driver lacks trigger, hypothesis, alternatives, gap or uncertainty');
  }
  const craft = value.observableCraftDecisionHypotheses;
  exactKeys(craft, ['synthesis', 'hypotheses'], 'CANDIDATE_CRAFT_FIELDS', 'observableCraftDecisionHypotheses');
  check(object(craft) && substantive(craft.synthesis) && Array.isArray(craft.hypotheses) && craft.hypotheses.length >= 2,
    'CANDIDATE_CRAFT', 'Craft analysis requires synthesis and at least two hypotheses');
  for (const hypothesis of craft.hypotheses) {
    exactKeys(hypothesis, ['hypothesisId', 'unitIds', 'evidenceIds', 'observablePattern', 'possibleFunction', 'alternatives', 'limitation'], 'CANDIDATE_CRAFT_FIELDS', 'Craft hypothesis');
    const unitIds = ids(hypothesis, 'unitIds');
    check(new Set(unitIds).size >= 2 && unitIds.every(id => unitById.has(id)), 'CANDIDATE_CRAFT_UNITS', 'Craft hypothesis must span two known units');
    const binding = bind(hypothesis, {minimumUnits: 2});
    check([...binding.localUnits].every(id => unitIds.includes(id)), 'CANDIDATE_CRAFT_EVIDENCE', 'Craft unitIds do not cover cited evidence units');
    check(substantive(hypothesis.observablePattern) && substantive(hypothesis.possibleFunction) && Array.isArray(hypothesis.alternatives)
      && hypothesis.alternatives.some(substantive) && substantive(hypothesis.limitation), 'CANDIDATE_CRAFT', 'Craft hypothesis lacks pattern, possible function, alternatives or limitation');
  }
  check(Array.isArray(value.limitations) && value.limitations.length >= 2 && value.limitations.every(substantive), 'CANDIDATE_LIMITATIONS', 'Candidate needs explicit visibility and hypothesis limitations');
  const strings = allStrings({emotional, psychology, craft});
  check(strings.every(substantive), 'CANDIDATE_PLACEHOLDER', 'Candidate contains an empty or placeholder semantic string');
  const inherited = new Set(packet.units.flatMap(unit => Object.values(unit.existingCheckedAnalysis)).filter(text).map(item => item.replace(/\s+/gu, ' ').trim()));
  check(!strings.some(item => item.trim().length >= 8 && inherited.has(item.replace(/\s+/gu, ' ').trim())),
    'CANDIDATE_COPIED_FIELD', 'Candidate copied an existing unit analysis field instead of producing new cross-unit analysis');
  const assertions = strings.join('\n');
  check(!/(?:作者(?:真实)?意图|作者想要|作者就是|作者显然)(?:是|在于|通过|为了|要)|(?:ROI|转化率|点击率|留存率|平台数据)(?:得到|提高|提升|增长|证明|显示)/iu.test(assertions),
    'CANDIDATE_UNSUPPORTED_ASSERTION', 'Candidate asserts author intent, ROI, platform or audience outcomes');
  return {modelOutput: structuredClone(value), validation: {
    status: 'evidence_binding_passed',
    approvalStatus: 'candidate_unreviewed',
    grantsApproved: false,
    grantsChecked: false,
    citedEvidenceCount: usedEvidence.size,
    citedUnitCount: usedUnits.size,
    packetEvidenceCount: evidenceById.size,
    hostBindingSha256: packet.hostBindingSha256,
    formatNormalization: normalizations,
  }};
}

async function resolveInvoker({model, fetch: fetchImpl, modelName, endpoint = 'https://api.deepseek.com/chat/completions', headers = {}, createProviderSession, providerSessionOptions}) {
  let session = null;
  if (typeof createProviderSession === 'function') {
    check(object(providerSessionOptions), 'PROVIDER_SESSION_CONFIG', 'providerSessionOptions are required with createProviderSession');
    session = await createProviderSession(providerSessionOptions);
    fetchImpl = session.fetch;
    modelName ??= providerSessionOptions.config?.model;
    headers = {...headers, authorization: `Bearer ${providerSessionOptions.config?.apiKey}`};
  }
  if (typeof model === 'function') return {invoke: request => model(request), session};
  for (const method of ['complete', 'generate', 'call']) {
    if (typeof model?.[method] === 'function') return {invoke: request => model[method](request), session};
  }
  check(typeof fetchImpl === 'function' && text(modelName), 'MODEL_ADAPTER', 'Inject a model function/object, or fetch plus modelName, or createProviderSession parameters');
  return {session, invoke: async request => {
    const response = await fetchImpl(endpoint, {method: 'POST', headers: {...headers, 'content-type': 'application/json'}, body: JSON.stringify({
      model: modelName,
      messages: [{role: 'system', content: request.system}, {role: 'user', content: request.user}],
      stream: false,
      response_format: {type: 'json_object'},
      max_tokens: request.maxTokens,
    })});
    const raw = await response.text();
    check(response.ok, 'MODEL_HTTP', `Model request failed with HTTP ${response.status}`, {raw});
    let body;
    try { body = JSON.parse(raw); } catch { throw fail('MODEL_HTTP_JSON', 'Model HTTP response is not JSON', {raw}); }
    return body.choices?.[0]?.message?.content ?? body.output_text ?? body;
  }};
}

export async function runRemaining99DeepAnalysis({queuePath, runRoot, model, fetch, modelName, endpoint,
  headers, createProviderSession, providerSessionOptions, retryFailed = false, sourceIds, maxSources, now = () => new Date().toISOString()} = {}) {
  check(text(queuePath) && text(runRoot), 'RUN_CONFIG', 'queuePath and runRoot are required');
  const queueBytes = await readReady(resolve(queuePath)), queue = JSON.parse(queueBytes), queueRoot = dirname(resolve(queuePath)), root = resolve(runRoot);
  check(queue.schemaVersion === DEEP_QUEUE_VERSION && Array.isArray(queue.sources), 'QUEUE_VERSION', 'Unsupported deep-analysis queue');
  const selected = sourceIds === undefined ? null : new Set(sourceIds);
  if (selected) check([...selected].every(id => queue.sources.some(item => item.sourceId === id)), 'RUN_SOURCE', 'Requested source is absent from the queue');
  check(maxSources === undefined || (Number.isSafeInteger(maxSources) && maxSources >= 1), 'RUN_CONFIG', 'maxSources must be a positive integer');
  await mkdir(root, {recursive: true});
  const frozenPath = join(root, 'queue-binding.json'), frozen = {queuePath: resolve(queuePath), queueSha256: sha256(queueBytes),
    schemaVersion: queue.schemaVersion, queueName: queue.queueName, expectedSourceCount: queue.expectedSourceCount};
  if (await exists(frozenPath)) check(JSON.stringify(JSON.parse(await readReady(frozenPath))) === JSON.stringify(frozen), 'RUN_QUEUE_CHANGED', 'Run root is frozen to a different queue');
  else await atomicJson(frozenPath, frozen);
  const candidates = queue.sources.filter(item => !selected || selected.has(item.sourceId)).slice(0, maxSources ?? queue.sources.length);
  const outcomes = [], work = [];
  for (const item of candidates) {
    const sourceRoot = join(root, 'sources', item.sourceId), statusPath = join(sourceRoot, 'status.json');
    const prior = await exists(statusPath) ? JSON.parse(await readReady(statusPath)) : null;
    if (prior?.status === 'completed') { outcomes.push({sourceId: item.sourceId, status: 'skipped_completed'}); continue; }
    if (prior?.status === 'failed' && !retryFailed) { outcomes.push({sourceId: item.sourceId, status: 'skipped_failed'}); continue; }
    const packetPath = safeInside(queueRoot, item.packetPath), packetBytes = await readReady(packetPath);
    check(sha256(packetBytes) === item.packetSha256, 'RUN_PACKET_HASH', 'Packet hash differs from queue', {sourceId: item.sourceId});
    const packet = JSON.parse(packetBytes);
    check(packet.sourceBinding.sourceId === item.sourceId && packet.hostBindingSha256 === item.hostBindingSha256,
      'RUN_PACKET_BINDING', 'Packet source binding differs from queue', {sourceId: item.sourceId});
    work.push({item, sourceRoot, statusPath, packet, request: buildDeepAnalysisRequest(packet)});
  }
  if (work.length === 0) return {schemaVersion: DEEP_RUN_VERSION, queueName: queue.queueName,
    candidatePolicy: 'candidate_unreviewed', providerSessionOpened: false, outcomes};
  let adapter;
  try {
    adapter = await resolveInvoker({model, fetch, modelName, endpoint, headers, createProviderSession, providerSessionOptions});
    for (const {item, sourceRoot, statusPath, packet, request} of work) {
      const attemptId = `${Date.now()}-${randomUUID()}`, attemptRoot = join(sourceRoot, 'attempts', attemptId);
      await mkdir(attemptRoot, {recursive: true});
      await immutable(join(attemptRoot, 'request.json'), request);
      await atomicJson(statusPath, {schemaVersion: DEEP_RUN_VERSION, sourceId: item.sourceId, status: 'running', attemptId,
        startedAt: now(), candidateReviewStatus: 'candidate_unreviewed', providerAccounting: 'main_controller_only'});
      let raw = null, phase = 'model';
      try {
        raw = await adapter.invoke(request);
        const rawText = typeof raw === 'string' ? raw : json(raw);
        await immutable(join(attemptRoot, 'response.raw.txt'), rawText, 'utf8');
        phase = 'validation';
        const parsed = parseModelOutput(raw), inspected = validateDeepAnalysisModelOutput(parsed, packet);
        const candidate = {
          schemaVersion: DEEP_CANDIDATE_VERSION,
          candidateStatus: 'candidate_unreviewed',
          approved: false,
          checked: false,
          sourceBinding: packet.sourceBinding,
          packetBinding: {packetPath: item.packetPath, packetSha256: item.packetSha256, hostBindingSha256: packet.hostBindingSha256},
          generatedAt: now(),
          modelOutput: inspected.modelOutput,
          hostValidation: inspected.validation,
          limitations: {
            visibleText: packet.visibilityBoundary,
            interpretation: 'AI-generated hypotheses pending independent semantic review; host evidence validation is not approval.',
            publication: 'Candidate is not installed in or resolved from the formal library.',
          },
        };
        const candidatePath = join(attemptRoot, 'candidate.json'), validationPath = join(attemptRoot, 'validation.json');
        await immutable(candidatePath, candidate); await immutable(validationPath, inspected.validation);
        await atomicJson(statusPath, {schemaVersion: DEEP_RUN_VERSION, sourceId: item.sourceId, status: 'completed', attemptId,
          completedAt: now(), candidatePath: relative(root, candidatePath), validationPath: relative(root, validationPath),
          candidateSha256: sha256(json(candidate)), validationSha256: sha256(json(inspected.validation)),
          candidateReviewStatus: 'candidate_unreviewed', approved: false, checked: false});
        outcomes.push({sourceId: item.sourceId, status: 'completed_candidate_unreviewed'});
      } catch (error) {
        const errorRecord = {phase, code: error.code ?? 'DEEP_ANALYSIS_FAILED', message: error.message, details: error.details ?? null, failedAt: now()};
        await immutable(join(attemptRoot, 'error.json'), errorRecord);
        await atomicJson(statusPath, {schemaVersion: DEEP_RUN_VERSION, sourceId: item.sourceId, status: 'failed', attemptId,
          failedAt: errorRecord.failedAt, phase, code: errorRecord.code, message: errorRecord.message,
          responseRetained: raw !== null, retryRequiresExplicitFlag: true, candidateReviewStatus: 'none'});
        outcomes.push({sourceId: item.sourceId, status: 'failed', phase, code: errorRecord.code});
      }
    }
  } finally {
    if (adapter?.session && typeof adapter.session.close === 'function') await adapter.session.close();
  }
  return {schemaVersion: DEEP_RUN_VERSION, queueName: queue.queueName, candidatePolicy: 'candidate_unreviewed',
    providerSessionOpened: Boolean(adapter?.session), outcomes};
}

export async function revalidateRetainedDeepAnalysisAttempt({queuePath, runRoot, sourceId, attemptId,
  outputRoot, deriveCandidate = false, semanticAudit, now = () => new Date().toISOString()} = {}) {
  check(text(queuePath) && text(runRoot) && text(sourceId) && text(attemptId), 'REVALIDATE_CONFIG',
    'queuePath, runRoot, sourceId and attemptId are required');
  check(deriveCandidate === false || (object(semanticAudit) && semanticAudit.status === 'pass' && text(semanticAudit.auditor)),
    'REVALIDATE_SEMANTIC_REVIEW', 'Deriving a candidate requires an explicit passing semantic audit and named auditor');
  const resolvedQueuePath = resolve(queuePath), queueBytes = await readReady(resolvedQueuePath), queue = JSON.parse(queueBytes);
  check(queue.schemaVersion === DEEP_QUEUE_VERSION && Array.isArray(queue.sources), 'QUEUE_VERSION', 'Unsupported deep-analysis queue');
  const item = queue.sources.find(row => row.sourceId === sourceId);
  check(item, 'REVALIDATE_SOURCE', 'Source is absent from the frozen queue', {sourceId});
  const queueRoot = dirname(resolvedQueuePath), root = resolve(runRoot);
  const packetPath = safeInside(queueRoot, item.packetPath), packetBytes = await readReady(packetPath);
  check(sha256(packetBytes) === item.packetSha256, 'REVALIDATE_PACKET_HASH', 'Packet hash differs from queue', {sourceId});
  const packet = JSON.parse(packetBytes);
  check(packet.sourceBinding.sourceId === sourceId && packet.hostBindingSha256 === item.hostBindingSha256,
    'REVALIDATE_PACKET_BINDING', 'Packet source binding differs from queue', {sourceId});
  const attemptRoot = safeInside(root, join('sources', sourceId, 'attempts', attemptId));
  const rawPath = join(attemptRoot, 'response.raw.txt'), errorPath = join(attemptRoot, 'error.json');
  const statusPath = safeInside(root, join('sources', sourceId, 'status.json'));
  const rawBytes = await readReady(rawPath), errorBytes = await readReady(errorPath), statusBytes = await readReady(statusPath);
  const originalStatus = JSON.parse(statusBytes), originalError = JSON.parse(errorBytes);
  check(originalStatus.status === 'failed' && originalStatus.attemptId === attemptId, 'REVALIDATE_ORIGINAL_STATUS',
    'Revalidation only accepts the retained attempt named by the failed source checkpoint', {sourceId, attemptId});
  const revalidationId = `${Date.now()}-${randomUUID()}`;
  const destination = resolve(outputRoot ?? join(root, 'revalidations'), sourceId, attemptId, revalidationId);
  let inspected = null, validationError = null;
  try {
    inspected = validateDeepAnalysisModelOutput(parseModelOutput(rawBytes.toString('utf8')), packet);
  } catch (error) {
    validationError = {code: error.code ?? 'REVALIDATION_FAILED', message: error.message, details: error.details ?? null};
  }
  const receipt = {
    schemaVersion: 'remaining99-deep-analysis-revalidation-receipt-v1',
    sourceId,
    attemptId,
    revalidationId,
    generatedAt: now(),
    execution: {modelCalls: 0, providerSessionOpened: false, providerLockRequested: false},
    immutableInputs: {
      queuePath: resolvedQueuePath,
      queueSha256: sha256(queueBytes),
      packetPath,
      packetSha256: sha256(packetBytes),
      hostBindingSha256: packet.hostBindingSha256,
      responseRawPath: rawPath,
      responseRawSha256: sha256(rawBytes),
      originalErrorPath: errorPath,
      originalErrorSha256: sha256(errorBytes),
      originalStatusPath: statusPath,
      originalStatusSha256: sha256(statusBytes),
      originalFailure: {phase: originalStatus.phase, code: originalStatus.code, message: originalStatus.message},
    },
    revalidation: inspected ? inspected.validation : {status: 'failed', error: validationError},
    semanticAudit: semanticAudit ?? {status: 'not_supplied'},
    derivedCandidate: false,
    approvalStatus: 'not_approved',
    originalAttemptMutated: false,
  };
  let candidatePath = null;
  if (deriveCandidate && inspected) {
    const candidate = {
      schemaVersion: DEEP_CANDIDATE_VERSION,
      candidateStatus: 'candidate_unreviewed',
      approved: false,
      checked: false,
      derivation: {kind: 'host_revalidation_of_retained_response', sourceAttemptId: attemptId, responseRawSha256: sha256(rawBytes), modelCalls: 0},
      sourceBinding: packet.sourceBinding,
      packetBinding: {packetPath: item.packetPath, packetSha256: item.packetSha256, hostBindingSha256: packet.hostBindingSha256},
      generatedAt: now(),
      modelOutput: inspected.modelOutput,
      hostValidation: inspected.validation,
      semanticAudit,
      limitations: {
        visibleText: packet.visibilityBoundary,
        interpretation: 'AI-generated hypotheses remain candidate_unreviewed after explicit semantic audit; revalidation is not approval.',
        publication: 'Derived candidate is not installed in or resolved from the formal library.',
      },
    };
    candidatePath = join(destination, 'derived-candidate.json');
    await immutable(candidatePath, candidate);
    receipt.derivedCandidate = true;
    receipt.derivedCandidatePath = candidatePath;
    receipt.derivedCandidateSha256 = sha256(json(candidate));
  }
  const receiptPath = join(destination, 'receipt.json');
  await immutable(receiptPath, receipt);
  return {status: inspected ? 'revalidated' : 'revalidation_failed', sourceId, attemptId, receiptPath,
    receiptSha256: sha256(json(receipt)), derivedCandidatePath: candidatePath, validationError};
}

function candidateSearchText(candidate) {
  return allStrings({title: candidate.sourceBinding?.title, output: candidate.modelOutput}).join('\n').toLocaleLowerCase('zh-CN');
}

export async function queryDeepAnalysisCandidates({runRoot, queuePath, query = '', sourceIds, dimensions, limit = 20} = {}) {
  check(text(runRoot) && text(queuePath), 'QUERY_CONFIG', 'runRoot and queuePath are required');
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= 200, 'QUERY_CONFIG', 'limit must be between 1 and 200');
  const resolvedQueuePath = resolve(queuePath), queue = JSON.parse(await readReady(resolvedQueuePath)), queueRoot = dirname(resolvedQueuePath);
  const root = resolve(runRoot), wanted = sourceIds ? new Set(sourceIds) : null;
  const requestedDimensions = dimensions ?? ['emotionalProgression', 'psychologicalChangeDrivers', 'observableCraftDecisionHypotheses'];
  check(Array.isArray(requestedDimensions) && requestedDimensions.every(name => ['emotionalProgression', 'psychologicalChangeDrivers', 'observableCraftDecisionHypotheses'].includes(name)),
    'QUERY_DIMENSIONS', 'Unknown candidate dimension');
  const terms = query.toLocaleLowerCase('zh-CN').split(/\s+/u).filter(Boolean), results = [];
  for (const item of queue.sources) {
    if (wanted && !wanted.has(item.sourceId)) continue;
    const statusPath = join(root, 'sources', item.sourceId, 'status.json');
    if (!await exists(statusPath)) continue;
    const status = JSON.parse(await readReady(statusPath));
    if (status.status !== 'completed' || status.candidateReviewStatus !== 'candidate_unreviewed' || status.approved !== false) continue;
    const candidatePath = safeInside(root, status.candidatePath), candidateBytes = await readReady(candidatePath);
    check(text(status.candidateSha256) && sha256(candidateBytes) === status.candidateSha256,
      'QUERY_CANDIDATE_HASH', 'Candidate hash differs from completed checkpoint', {sourceId: item.sourceId});
    const candidate = JSON.parse(candidateBytes), packetBytes = await readReady(safeInside(queueRoot, item.packetPath));
    check(sha256(packetBytes) === item.packetSha256, 'QUERY_PACKET_HASH', 'Packet hash differs from queue', {sourceId: item.sourceId});
    const packet = JSON.parse(packetBytes), revalidated = validateDeepAnalysisModelOutput(candidate.modelOutput, packet);
    if (candidate.candidateStatus !== 'candidate_unreviewed' || candidate.approved !== false || candidate.checked !== false) continue;
    check(candidate.sourceBinding.sourceId === packet.sourceBinding.sourceId
      && candidate.packetBinding.hostBindingSha256 === packet.hostBindingSha256
      && revalidated.validation.status === 'evidence_binding_passed', 'QUERY_CANDIDATE_BINDING', 'Candidate binding is invalid', {sourceId: item.sourceId});
    const haystack = candidateSearchText(candidate), score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
    if (terms.length && score === 0) continue;
    results.push({sourceId: item.sourceId, title: item.title, score, reviewStatus: 'candidate_unreviewed', approved: false, checked: false,
      evidenceBindingStatus: candidate.hostValidation.status,
      dimensions: Object.fromEntries(requestedDimensions.map(name => [name, candidate.modelOutput[name]])),
      candidatePath: relative(root, candidatePath)});
  }
  results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, 'zh-CN'));
  return {schemaVersion: 'remaining99-deep-analysis-candidate-query-v1', query, resultCount: Math.min(results.length, limit),
    reviewBoundary: 'Results are host-validated candidate hypotheses. They are not approved, checked, or installed library analysis.', results: results.slice(0, limit)};
}
