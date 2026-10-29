import {createHash, randomUUID} from 'node:crypto';
import {link, mkdir, readFile, stat, unlink, writeFile} from 'node:fs/promises';
import {dirname, join, relative, resolve, sep} from 'node:path';
import {
  queryDeepAnalysisCandidates,
  readReady,
  validateDeepAnalysisModelOutput,
} from './remaining99-deep-analysis-batch.mjs';

export const DEEP_REFERENCE_LAYER_VERSION = 'analysis99-deep-reference-layer-2';
export const DEEP_REFERENCE_INSTALL_VERSION = 'analysis99-deep-reference-install-2';
export const DEEP_REFERENCE_QUERY_VERSION = 'analysis99-problem-query-2';
export const DEEP_REFERENCE_LIMITS = Object.freeze({
  maxResults: 8,
  maxSearchTerms: 20,
  maxFunctionsPerResult: 6,
  maxEvidenceRefsPerResult: 24,
  maxEvidenceCharsPerResult: 12000,
  maxLimitStringsPerResult: 16,
  maxStringChars: 4000,
  minimumMatchedTerms: 2,
  minimumFunctionMatchedTerms: 2,
});

const CANDIDATE_VERSION = 'remaining99-deep-analysis-candidate-v1';
const QUEUE_VERSION = 'remaining99-deep-analysis-queue-v1';
const CANDIDATE_INDEX_VERSION = 'remaining99-candidate-coverage-2';
const REVIEW_INDEX_VERSION = 'remaining99-semantic-review-index-1';
const SHA = /^[a-f0-9]{64}$/u;
const resolvedInstallations = new WeakSet();
// Policy vocabulary is not positive evidence of a writing function. Keep the
// original request for provenance, and disclose every ignored term in the reply.
const POLICY_TERMS = new Set(['来源','自身','可见','逐字','检索','查询','命中','适用性','材料']);
const MATCHING_POLICY = 'analysis99-positive-function-fields-1';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = value => `${JSON.stringify(value, null, 2)}\n`;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fail = (code, message, details) => Object.assign(new Error(message), {code, details});
const check = (condition, code, message, details) => { if (!condition) throw fail(code, message, details); };

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

function safeInside(root, child, {allowRoot = false} = {}) {
  check(nonempty(root) && nonempty(child), 'DEEP_REF_PATH', 'A root and child path are required');
  const base = resolve(root), full = resolve(base, child), rel = relative(base, full);
  check((allowRoot && rel === '') || (rel && rel !== '..' && !rel.startsWith(`..${sep}`)),
    'DEEP_REF_PATH_ESCAPE', 'Path escapes its declared root', {root: base, child});
  return full;
}

async function readJson(path, code = 'DEEP_REF_JSON') {
  const bytes = await readReady(path);
  try { return {bytes, value: JSON.parse(bytes)}; }
  catch (error) { throw fail(code, `Invalid JSON: ${path}`, {path, cause: error.message}); }
}

function uniqueMap(items, key, code, label) {
  check(Array.isArray(items), code, `${label} must be an array`);
  const mapped = new Map();
  for (const item of items) {
    const id = item?.[key];
    check(nonempty(id) && !mapped.has(id), code, `${label} has a missing or duplicate ${key}`, {id});
    mapped.set(id, item);
  }
  return mapped;
}

function exactBinding(left, right, keys, code, sourceId) {
  for (const key of keys) check(left?.[key] === right?.[key], code, `Binding differs at ${key}`, {sourceId, left: left?.[key], right: right?.[key]});
}

function reviewRejected(review) {
  const verdict = String(review?.verdict ?? '').toLowerCase();
  return !nonempty(verdict)
    || /(?:reject|unsupported|fail|invalid)/u.test(verdict)
    || !Array.isArray(review?.blockingDefects)
    || review.blockingDefects.length > 0;
}

function reportRecords(report) {
  return ['candidates','sources','items'].flatMap(key => Array.isArray(report?.[key]) ? report[key] : []);
}

function reportState(record) {
  return record?.candidateStateObserved ?? record?.candidateState ?? record?.reviewState ?? null;
}

function boundReportRecord(report, binding, candidate) {
  const records = reportRecords(report);
  const bindingMode = binding.bindingMode ?? binding.reviewBindingMode;
  if (bindingMode === 'candidate_bytes') return records.find(item => item.sourceId === binding.sourceId
    && item.candidateSha256 === binding.candidateSha256 && item.packetSha256 === binding.packetSha256);
  if (bindingMode === 'retained_raw_with_mechanical_alias_receipt') {
    const rawSha256 = candidate?.derivation?.responseRawSha256;
    const record = records.find(item => item.sourceId === binding.sourceId
      && item.packetSha256 === binding.packetSha256 && item.rawResponseSha256 === rawSha256);
    const audit = candidate?.semanticAudit;
    if (!record || !SHA.test(rawSha256) || audit?.rawResponseSha256 !== rawSha256
      || audit?.packetSha256 !== binding.packetSha256 || audit?.sourceId !== binding.sourceId
      || record.mechanicalFailureAudit?.aliasCount !== 1
      || !candidate.hostValidation?.formatNormalization?.some(value => value.includes('craft-pattern-key-alias'))) return undefined;
    return record;
  }
  return undefined;
}

function verifyEvidenceRegistry(packet, sourceText, sourceId) {
  check(Array.isArray(packet.evidenceRegistry) && packet.evidenceRegistry.length > 0,
    'DEEP_REF_PACKET_EVIDENCE', 'Packet has no evidence registry', {sourceId});
  const ids = new Set();
  for (const evidence of packet.evidenceRegistry) {
    check(nonempty(evidence?.evidenceId) && !ids.has(evidence.evidenceId),
      'DEEP_REF_PACKET_EVIDENCE', 'Packet evidence IDs must be unique', {sourceId, evidenceId: evidence?.evidenceId});
    ids.add(evidence.evidenceId);
    const locator = evidence.locator, binding = evidence.binding;
    check(evidence.sourceId === sourceId && nonempty(evidence.unitId) && nonempty(evidence.quote)
      && object(locator) && Number.isSafeInteger(locator.charStart) && Number.isSafeInteger(locator.charEnd)
      && locator.charStart >= 0 && locator.charEnd >= locator.charStart && locator.charEnd <= sourceText.length
      && object(binding) && binding.literalStatus === 'verified' && SHA.test(binding.quoteSha256),
    'DEEP_REF_PACKET_EVIDENCE', 'Packet evidence binding is invalid', {sourceId, evidenceId: evidence.evidenceId});
    check(hash(evidence.quote) === binding.quoteSha256
      && sourceText.slice(locator.charStart, locator.charEnd) === evidence.quote,
    'DEEP_REF_SOURCE_EVIDENCE_MISMATCH', 'Evidence quote no longer matches the bound source text', {sourceId, evidenceId: evidence.evidenceId});
  }
}

async function publishExclusive(path, bytes) {
  const temporary = `${path}.next-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, bytes, {flag: 'wx', mode: 0o600});
  try { await link(temporary, path); }
  finally { await unlink(temporary).catch(() => {}); }
}

function installationProjection(verification, createdAt, provenance = verification.provenance) {
  const entries = verification.entries.map(entry => ({
    sourceId: entry.sourceId,
    title: entry.title,
    candidatePath: entry.candidatePath,
    candidateSha256: entry.candidateSha256,
    packetPath: entry.packetPath,
    packetSha256: entry.packetSha256,
    statusPath: entry.statusPath,
    statusSha256: entry.statusSha256,
    reportPath: entry.reportPath,
    reportSha256: entry.reportSha256,
    reviewBindingMode: entry.reviewBindingMode,
    verdict: entry.verdict,
    source: entry.source,
    analysis: entry.analysis,
  }));
  const identity = {
    layerVersion: DEEP_REFERENCE_LAYER_VERSION,
    layerRoot: verification.layerRoot,
    catalogPath: verification.catalogPath,
    frozenCatalogPath: verification.frozenCatalogPath,
    bindings: verification.bindings,
    entries,
  };
  return {
    schemaVersion: DEEP_REFERENCE_INSTALL_VERSION,
    contractVersion: 'analysis99-deep-reference-contract-2',
    installId: `analysis99-${hash(json(identity))}`,
    createdAt,
    layerRoot: verification.layerRoot,
    catalogPath: verification.catalogPath,
    frozenCatalogPath: verification.frozenCatalogPath,
    sourceCount: entries.length,
    bindings: verification.bindings,
    provenance,
    entries,
    exclusions: verification.exclusions,
    stateBoundary: {
      candidateStatus: 'candidate_unreviewed',
      approved: false,
      checked: false,
      active: false,
      mutatesFormal136: false,
      retrievalIsUse: false,
    },
  };
}

export async function verifyDeepReferenceLayer({layerRoot, catalogPath, expectedSourceCount = 99} = {}) {
  check(nonempty(layerRoot), 'DEEP_REF_CONFIG', 'layerRoot is required');
  check(Number.isSafeInteger(expectedSourceCount) && expectedSourceCount > 0,
    'DEEP_REF_CONFIG', 'expectedSourceCount must be a positive integer');
  const root = resolve(layerRoot);
  const paths = {
    queue: join(root, 'queue-99.json'),
    candidateIndex: join(root, 'candidate-index.json'),
    reviewIndex: join(root, 'semantic-review-index.json'),
  };
  const [queueFile, candidateIndexFile, reviewIndexFile] = await Promise.all([
    readJson(paths.queue), readJson(paths.candidateIndex), readJson(paths.reviewIndex),
  ]);
  const queue = queueFile.value, candidateIndex = candidateIndexFile.value, reviewIndex = reviewIndexFile.value;
  check(queue.schemaVersion === QUEUE_VERSION && queue.expectedSourceCount === expectedSourceCount,
    'DEEP_REF_QUEUE', 'Queue version or expected source count differs', {schemaVersion: queue.schemaVersion, expectedSourceCount: queue.expectedSourceCount});
  check(candidateIndex.schemaVersion === CANDIDATE_INDEX_VERSION
    && candidateIndex.expectedSourceCount === expectedSourceCount
    && candidateIndex.generatedAndHostValidated === expectedSourceCount
    && candidateIndex.formalApproval === false,
  'DEEP_REF_CANDIDATE_INDEX', 'Candidate index boundary or source count differs');
  check(reviewIndex.schemaVersion === REVIEW_INDEX_VERSION
    && reviewIndex.generatedCandidates === expectedSourceCount
    && reviewIndex.reviewedSupported === expectedSourceCount,
  'DEEP_REF_REVIEW_INDEX', 'Semantic review index boundary or source count differs');
  check(Array.isArray(candidateIndex.missing) && candidateIndex.missing.length === 0
    && Array.isArray(candidateIndex.invalid) && candidateIndex.invalid.length === 0
    && Array.isArray(reviewIndex.missing) && reviewIndex.missing.length === 0
    && Array.isArray(reviewIndex.errors) && reviewIndex.errors.length === 0,
  'DEEP_REF_INCOMPLETE', 'Layer indexes retain missing or invalid current records');

  const auditPath = resolve(queue.auditBinding?.path ?? '');
  const frozenCatalogPath = resolve(queue.catalogBinding?.path ?? '');
  const actualCatalogPath = resolve(catalogPath ?? frozenCatalogPath);
  const [auditFile, frozenCatalogFile] = await Promise.all([readJson(auditPath), readJson(frozenCatalogPath)]);
  const catalogFile = actualCatalogPath === frozenCatalogPath ? frozenCatalogFile : await readJson(actualCatalogPath);
  check(SHA.test(queue.auditBinding?.sha256) && hash(auditFile.bytes) === queue.auditBinding.sha256,
    'DEEP_REF_AUDIT_HASH', 'Coverage audit hash differs from the queue binding');
  check(SHA.test(queue.catalogBinding?.sha256) && hash(frozenCatalogFile.bytes) === queue.catalogBinding.sha256,
    'DEEP_REF_FROZEN_CATALOG_HASH', 'Frozen catalog snapshot hash differs from the queue binding');
  check(Array.isArray(frozenCatalogFile.value.sources)
    && frozenCatalogFile.value.sources.length === queue.catalogBinding.sourceCount,
  'DEEP_REF_FROZEN_CATALOG', 'Frozen catalog snapshot source count differs from the queue binding');
  check(Array.isArray(catalogFile.value.sources), 'DEEP_REF_CATALOG', 'Live catalog sources must be an array');

  const queueById = uniqueMap(queue.sources, 'sourceId', 'DEEP_REF_QUEUE', 'queue sources');
  const candidateById = uniqueMap(candidateIndex.entries, 'sourceId', 'DEEP_REF_CANDIDATE_INDEX', 'candidate entries');
  const reviewById = uniqueMap(reviewIndex.reviews, 'sourceId', 'DEEP_REF_REVIEW_INDEX', 'current reviews');
  const wantedSourceIds = new Set(queueById.keys()), catalogById = new Map();
  for (const row of catalogFile.value.sources) {
    if (!wantedSourceIds.has(row?.sourceId)) continue;
    check(!catalogById.has(row.sourceId), 'DEEP_REF_CATALOG', 'Live catalog duplicates a bound source ID', {sourceId: row.sourceId});
    catalogById.set(row.sourceId, row);
  }
  check(queueById.size === expectedSourceCount && candidateById.size === expectedSourceCount && reviewById.size === expectedSourceCount,
    'DEEP_REF_COUNT', 'Layer does not contain the expected number of unique current records');

  const reportBindings = new Map((reviewIndex.reports ?? []).map(item => [item.path, item.sha256]));
  check(reportBindings.size === (reviewIndex.reports ?? []).length,
    'DEEP_REF_REVIEW_INDEX', 'Review report paths are duplicated');
  const superseded = new Set((reviewIndex.supersededReviews ?? [])
    .map(item => JSON.stringify([item.sourceId, item.reportPath, item.reportSha256, item.candidateSha256])));
  const reportCache = new Map(), sourceCache = new Map(), entries = [];
  const sourceObjectRoot = join(dirname(actualCatalogPath), 'objects');

  for (const [sourceId, queueEntry] of queueById) {
    const indexed = candidateById.get(sourceId), reviewed = reviewById.get(sourceId), catalogRow = catalogById.get(sourceId);
    check(indexed && reviewed && catalogRow, 'DEEP_REF_SOURCE_BINDING', 'Source is absent from a current layer index', {sourceId});
    check(indexed.owner !== candidateIndex.rejectedBatchExcluded,
      'DEEP_REF_REJECTED_CANDIDATE', 'Rejected candidate batch is present in the current index', {sourceId, owner: indexed.owner});
    check(!superseded.has(JSON.stringify([sourceId, reviewed.reportPath, reviewed.reportSha256, reviewed.candidateSha256])),
      'DEEP_REF_SUPERSEDED_REVIEW', 'A superseded review is present as the current review', {sourceId});
    check(!reviewRejected(reviewed) && reviewed.approvalGranted === false && reviewed.activeProductionChanged === false,
      'DEEP_REF_REJECTED_REVIEW', 'Current semantic review is rejected, blocked, or activating', {sourceId, verdict: reviewed.verdict});
    check(reportBindings.get(reviewed.reportPath) === reviewed.reportSha256,
      'DEEP_REF_REVIEW_HASH', 'Current review is absent from the frozen report index', {sourceId});

    const candidatePath = safeInside(root, indexed.candidatePath), packetPath = safeInside(root, indexed.packetPath);
    const statusPath = safeInside(root, join('sources', sourceId, 'status.json'));
    const reportPath = safeInside(root, reviewed.reportPath);
    const [candidateFile, packetFile, statusFile] = await Promise.all([
      readJson(candidatePath), readJson(packetPath), readJson(statusPath),
    ]);
    let reportFile = reportCache.get(reportPath);
    if (!reportFile) { reportFile = await readJson(reportPath); reportCache.set(reportPath, reportFile); }
    check(SHA.test(indexed.candidateSha256) && hash(candidateFile.bytes) === indexed.candidateSha256,
      'DEEP_REF_CANDIDATE_HASH', 'Candidate hash differs from the candidate index', {sourceId});
    check(SHA.test(indexed.packetSha256) && hash(packetFile.bytes) === indexed.packetSha256
      && indexed.packetSha256 === queueEntry.packetSha256,
    'DEEP_REF_PACKET_HASH', 'Packet hash differs from the candidate index or queue', {sourceId});
    check(SHA.test(reviewed.reportSha256) && hash(reportFile.bytes) === reviewed.reportSha256,
      'DEEP_REF_REVIEW_HASH', 'Semantic review report hash differs from the review index', {sourceId});

    const candidate = candidateFile.value, packet = packetFile.value, status = statusFile.value;
    check(candidate.schemaVersion === CANDIDATE_VERSION && candidate.candidateStatus === 'candidate_unreviewed'
      && candidate.approved === false && candidate.checked === false && candidate.active !== true,
    'DEEP_REF_CANDIDATE_STATE', 'Candidate state was promoted or changed', {sourceId});
    check(status.status === 'completed' && status.sourceId === sourceId
      && status.candidateReviewStatus === 'candidate_unreviewed' && status.approved === false && status.checked === false
      && status.candidatePath === indexed.candidatePath && status.candidateSha256 === indexed.candidateSha256,
    'DEEP_REF_STATUS_BINDING', 'Source status is stale or mismatched', {sourceId});
    check(indexed.validation?.status === 'evidence_binding_passed'
      && indexed.validation?.approvalStatus === 'candidate_unreviewed'
      && indexed.validation?.grantsApproved === false && indexed.validation?.grantsChecked === false,
    'DEEP_REF_CANDIDATE_STATE', 'Candidate index grants an unsupported state', {sourceId});
    check(reviewed.candidateSha256 === indexed.candidateSha256 && reviewed.packetSha256 === indexed.packetSha256,
      'DEEP_REF_REVIEW_BINDING', 'Semantic review is bound to different candidate or packet bytes', {sourceId});

    exactBinding(candidate.sourceBinding, packet.sourceBinding,
      ['sourceId','title','sourceSha256','sourceTextSha256','textVersion','analysisVersion','analysisContentVersion','analysisTextVersion','reviewRecordId'],
      'DEEP_REF_SOURCE_BINDING', sourceId);
    exactBinding(queueEntry.sourceBinding, packet.sourceBinding,
      ['sourceId','title','sourceSha256','sourceTextSha256','textVersion','analysisVersion','analysisContentVersion','analysisTextVersion','reviewRecordId'],
      'DEEP_REF_QUEUE_BINDING', sourceId);
    exactBinding(catalogRow, packet.sourceBinding, ['sourceId','title','sourceSha256','textVersion'],
      'DEEP_REF_CATALOG_BINDING', sourceId);
    check(catalogRow.analysis?.version === packet.sourceBinding.analysisVersion
      && catalogRow.analysis?.textVersion === packet.sourceBinding.analysisTextVersion
      && catalogRow.analysis?.validation?.semanticReview?.recordId === packet.sourceBinding.reviewRecordId,
    'DEEP_REF_CATALOG_BINDING', 'Packet analysis binding is stale against the catalog', {sourceId});
    check(candidate.packetBinding?.packetSha256 === indexed.packetSha256
      && candidate.packetBinding?.hostBindingSha256 === packet.hostBindingSha256
      && queueEntry.hostBindingSha256 === packet.hostBindingSha256,
    'DEEP_REF_PACKET_BINDING', 'Candidate or queue host binding differs from the packet', {sourceId});
    const hostValidation = validateDeepAnalysisModelOutput(candidate.modelOutput, packet).validation;
    check(hostValidation.status === 'evidence_binding_passed',
      'DEEP_REF_CANDIDATE_BINDING', 'Candidate no longer passes evidence binding validation', {sourceId});

    const reportCandidate = boundReportRecord(reportFile.value, {
      sourceId,
      candidateSha256: indexed.candidateSha256,
      packetSha256: indexed.packetSha256,
      bindingMode: reviewed.bindingMode,
    }, candidate);
    const reportBinding = reportCandidate?.binding, observedState = reportState(reportCandidate);
    check(reportCandidate && (reportCandidate.verdict ?? reportCandidate.status) === reviewed.verdict
      && (!reportBinding || (reportBinding.packetHashMatches === true
        && reportBinding.sourceBindingMatches === true && reportBinding.hostBindingMatches === true))
      && (!observedState || (observedState.approved !== true && observedState.checked !== true && observedState.active !== true))
      && same(reportCandidate.caveats ?? [], reviewed.caveats ?? [])
      && same(reportCandidate.blockingDefects ?? [], reviewed.blockingDefects ?? []),
    'DEEP_REF_REVIEW_BINDING', 'Review report does not contain the indexed current candidate binding', {sourceId});

    const sourcePath = safeInside(sourceObjectRoot, `${packet.sourceBinding.sourceSha256}.lf-v2.txt`);
    let sourceFile = sourceCache.get(sourcePath);
    if (!sourceFile) { sourceFile = await readReady(sourcePath); sourceCache.set(sourcePath, sourceFile); }
    const expectedSourceTextSha = packet.sourceBinding.sourceTextSha256;
    check(SHA.test(expectedSourceTextSha) && hash(sourceFile) === expectedSourceTextSha
      && catalogRow.indexIntegrity?.sourceTextSha256 === expectedSourceTextSha,
    'DEEP_REF_SOURCE_HASH', 'Normalized source bytes differ from the packet or catalog binding', {sourceId});
    const sourceText = sourceFile.toString('utf8');
    verifyEvidenceRegistry(packet, sourceText, sourceId);

    entries.push({
      sourceId,
      title: indexed.title,
      candidatePath: relative(root, candidatePath),
      candidateSha256: indexed.candidateSha256,
      packetPath: relative(root, packetPath),
      packetSha256: indexed.packetSha256,
      statusPath: relative(root, statusPath),
      statusSha256: hash(statusFile.bytes),
      reportPath: relative(root, reportPath),
      reportSha256: reviewed.reportSha256,
      reviewBindingMode: reviewed.bindingMode,
      verdict: reviewed.verdict,
      source: {
        sourceId,
        sourceSha256: packet.sourceBinding.sourceSha256,
        sourceTextSha256: expectedSourceTextSha,
        textVersion: packet.sourceBinding.textVersion,
      },
      analysis: {
        analysisId: packet.sourceBinding.analysisVersion,
        analysisContentVersion: packet.sourceBinding.analysisContentVersion,
        originalReviewRecordId: packet.sourceBinding.reviewRecordId,
      },
    });
  }

  entries.sort((a, b) => a.sourceId.localeCompare(b.sourceId));
  const liveBoundSourcesSha256 = hash(json(entries.map(entry => ({
    sourceId: entry.sourceId,
    title: entry.title,
    source: entry.source,
    analysis: entry.analysis,
  }))));
  return {
    schemaVersion: DEEP_REFERENCE_LAYER_VERSION,
    layerRoot: root,
    catalogPath: actualCatalogPath,
    frozenCatalogPath,
    sourceCount: entries.length,
    bindings: {
      queueSha256: hash(queueFile.bytes),
      candidateIndexSha256: hash(candidateIndexFile.bytes),
      semanticReviewIndexSha256: hash(reviewIndexFile.bytes),
      auditSha256: hash(auditFile.bytes),
      frozenCatalogSnapshotSha256: hash(frozenCatalogFile.bytes),
      liveBoundSourcesSha256,
    },
    provenance: {
      frozenCatalogPath,
      liveCatalogPath: actualCatalogPath,
      liveCatalogObservedSha256AtVerification: hash(catalogFile.bytes),
      liveCatalogAcceptanceScope: 'only_the_99_bound_rows_and_their_normalized_source_bytes',
    },
    exclusions: {
      rejectedBatch: candidateIndex.rejectedBatchExcluded,
      supersededReviewCount: (reviewIndex.supersededReviews ?? []).length,
      rejectedCurrentCount: 0,
    },
    stateBoundary: {candidateStatus: 'candidate_unreviewed', approved: false, checked: false, active: false},
    entries,
  };
}

export async function installDeepReferenceLayer({layerRoot, installRoot, catalogPath, expectedSourceCount = 99, now = () => new Date().toISOString()} = {}) {
  check(nonempty(installRoot), 'DEEP_REF_CONFIG', 'installRoot is required');
  const root = resolve(installRoot), manifestPath = join(root, 'manifest.json'), receiptPath = join(root, 'manifest.sha256');
  const verification = await verifyDeepReferenceLayer({layerRoot, catalogPath, expectedSourceCount});
  let existingManifest = null;
  if (await exists(manifestPath)) existingManifest = (await readJson(manifestPath)).value;
  const manifest = installationProjection(verification, existingManifest?.createdAt ?? now());
  const manifestBytes = Buffer.from(json(manifest)), receiptBytes = Buffer.from(`${hash(manifestBytes)}\n`);
  await mkdir(root, {recursive: true});
  if (existingManifest) {
    const existing = await readReady(manifestPath);
    check(hash(existing) === hash(manifestBytes), 'DEEP_REF_INSTALL_EXISTS', 'A different installation already exists at installRoot', {installRoot: root});
  } else await publishExclusive(manifestPath, manifestBytes);
  if (await exists(receiptPath)) {
    const existingReceipt = await readReady(receiptPath, 'utf8');
    check(existingReceipt.trim() === hash(manifestBytes), 'DEEP_REF_INSTALL_RECEIPT', 'Existing manifest receipt differs');
  } else await publishExclusive(receiptPath, receiptBytes);
  return {schemaVersion: DEEP_REFERENCE_INSTALL_VERSION, installId: manifest.installId, installRoot: root,
    manifestPath, manifestSha256: hash(manifestBytes), sourceCount: manifest.sourceCount};
}

export async function resolveDeepReferenceLayer({installRoot, catalogPath} = {}) {
  check(nonempty(installRoot), 'DEEP_REF_CONFIG', 'installRoot is required');
  const root = resolve(installRoot), manifestPath = join(root, 'manifest.json'), receiptPath = join(root, 'manifest.sha256');
  const [manifestFile, receipt] = await Promise.all([readJson(manifestPath), readReady(receiptPath, 'utf8')]);
  check(receipt.trim() === hash(manifestFile.bytes), 'DEEP_REF_INSTALL_RECEIPT', 'Manifest receipt does not match manifest bytes');
  const manifest = manifestFile.value;
  check(manifest.schemaVersion === DEEP_REFERENCE_INSTALL_VERSION && nonempty(manifest.installId)
    && Number.isSafeInteger(manifest.sourceCount) && manifest.sourceCount > 0,
  'DEEP_REF_INSTALL_MANIFEST', 'Installation manifest is invalid');
  const verification = await verifyDeepReferenceLayer({
    layerRoot: manifest.layerRoot,
    catalogPath: catalogPath ?? manifest.catalogPath,
    expectedSourceCount: manifest.sourceCount,
  });
  const expectedProjection = installationProjection(verification, manifest.createdAt, {
    ...verification.provenance,
    liveCatalogObservedSha256AtVerification: manifest.provenance?.liveCatalogObservedSha256AtVerification,
  });
  check(same(manifest, expectedProjection), 'DEEP_REF_STALE_INSTALL', 'Installation manifest is stale against the frozen layer');
  const installation = {
    schemaVersion: DEEP_REFERENCE_INSTALL_VERSION,
    installId: manifest.installId,
    installRoot: root,
    layerRoot: manifest.layerRoot,
    catalogPath: manifest.catalogPath,
    frozenCatalogPath: manifest.frozenCatalogPath,
    sourceCount: manifest.sourceCount,
    entries: manifest.entries,
    bindings: manifest.bindings,
    provenance: manifest.provenance,
    stateBoundary: manifest.stateBoundary,
  };
  Object.freeze(installation.entries);
  Object.freeze(installation);
  resolvedInstallations.add(installation);
  return installation;
}

function validateProblem(problem) {
  check(object(problem) && nonempty(problem.problemId) && problem.problemId.length <= 160
    && nonempty(problem.statement) && problem.statement.length <= 2000
    && Array.isArray(problem.searchTerms) && problem.searchTerms.length >= 2
    && problem.searchTerms.length <= DEEP_REFERENCE_LIMITS.maxSearchTerms,
  'DEEP_REF_QUERY_PROBLEM', 'Problem requires problemId, statement and 2-20 searchTerms');
  const terms = [...new Set(problem.searchTerms.map(term => String(term).trim()).filter(Boolean))];
  check(terms.length >= 2 && terms.every(term => term.length <= 80),
    'DEEP_REF_QUERY_PROBLEM', 'Search terms must be distinct nonempty strings of at most 80 characters');
  const requiredTermGroups = problem.requiredTermGroups ?? [];
  check(Array.isArray(requiredTermGroups) && requiredTermGroups.length <= 6
    && requiredTermGroups.every(group => Array.isArray(group) && group.length > 0 && group.length <= 12
      && group.every(term => terms.includes(term))),
  'DEEP_REF_QUERY_PROBLEM', 'requiredTermGroups must contain only declared searchTerms');
  return {...problem, searchTerms: terms, requiredTermGroups: requiredTermGroups.map(group => [...new Set(group)])};
}

function functionCandidates(modelOutput, dimensions) {
  const output = [];
  if (dimensions.includes('emotionalProgression')) {
    for (const item of modelOutput.emotionalProgression?.transitions ?? []) output.push({
      functionId: `emotion:${item.fromStageId}:${item.toStageId}`,
      dimension: 'emotionalProgression',
      status: 'evidence_bound_hypothesis',
      observablePattern: item.observedChange,
      borrowableFunction: item.possibleDriver,
      alternatives: item.alternatives,
      limitation: item.uncertainty,
      evidenceIds: item.evidenceIds,
      unitIds: [],
    });
  }
  if (dimensions.includes('psychologicalChangeDrivers')) {
    for (const item of modelOutput.psychologicalChangeDrivers?.drivers ?? []) output.push({
      functionId: `psychology:${item.driverId}`,
      dimension: 'psychologicalChangeDrivers',
      status: 'evidence_bound_hypothesis',
      observablePattern: item.observedTrigger,
      borrowableFunction: item.changeHypothesis,
      alternatives: item.alternatives,
      limitation: `${item.counterEvidenceOrGap}\n${item.uncertainty}`,
      evidenceIds: item.evidenceIds,
      unitIds: [...new Set([...(item.beforeUnitIds ?? []), ...(item.afterUnitIds ?? [])])],
    });
  }
  if (dimensions.includes('observableCraftDecisionHypotheses')) {
    for (const item of modelOutput.observableCraftDecisionHypotheses?.hypotheses ?? []) output.push({
      functionId: `craft:${item.hypothesisId}`,
      dimension: 'observableCraftDecisionHypotheses',
      status: 'evidence_bound_hypothesis',
      observablePattern: item.observablePattern,
      borrowableFunction: item.possibleFunction,
      alternatives: item.alternatives,
      limitation: item.limitation,
      evidenceIds: item.evidenceIds,
      unitIds: item.unitIds,
    });
  }
  return output;
}

function positiveFunctionText(items) {
  return items.map(item => `${item.observablePattern ?? ''}\n${item.borrowableFunction ?? ''}`)
    .join('\n').toLocaleLowerCase('zh-CN');
}

function matchedPositiveTerms(items, problem) {
  const text = positiveFunctionText(items);
  return problem.searchTerms.filter(term => text.includes(term.toLocaleLowerCase('zh-CN')));
}

function boundedFunctions(modelOutput, packet, dimensions, functionLimit, evidenceLimit, problem) {
  const evidenceById = new Map(packet.evidenceRegistry.map(item => [item.evidenceId, item]));
  const selected = [], selectedIds = new Set();
  let evidenceChars = 0;
  const ranked = functionCandidates(modelOutput, dimensions).map(item => {
    const matchedProblemTerms = matchedPositiveTerms([item], problem);
    return {...item, matchedProblemTerms};
  }).filter(item => item.matchedProblemTerms.length >= DEEP_REFERENCE_LIMITS.minimumFunctionMatchedTerms)
    .sort((left, right) => right.matchedProblemTerms.length - left.matchedProblemTerms.length
      || left.functionId.localeCompare(right.functionId));
  for (const item of ranked) {
    if (selected.length >= functionLimit) break;
    check(Array.isArray(item.evidenceIds) && item.evidenceIds.every(id => evidenceById.has(id)),
      'DEEP_REF_QUERY_EVIDENCE', 'Projected function cites evidence absent from its packet', {functionId: item.functionId});
    const newIds = item.evidenceIds.filter(id => !selectedIds.has(id));
    const newChars = newIds.reduce((sum, id) => sum + evidenceById.get(id).quote.length, 0);
    if (selectedIds.size + newIds.length > evidenceLimit
      || evidenceChars + newChars > DEEP_REFERENCE_LIMITS.maxEvidenceCharsPerResult) continue;
    selected.push(item);
    newIds.forEach(id => selectedIds.add(id));
    evidenceChars += newChars;
  }
  const references = [...selectedIds].map(evidenceId => {
    const evidence = evidenceById.get(evidenceId);
    return {
      evidenceId,
      unitId: evidence.unitId,
      locator: evidence.locator,
      quoteSha256: evidence.binding.quoteSha256,
      textVersion: evidence.binding.textVersion,
      quote: evidence.quote,
    };
  });
  return {functions: selected, references};
}

function boundedStrings(values, limit = DEEP_REFERENCE_LIMITS.maxLimitStringsPerResult) {
  const out = [];
  for (const value of values.flat(Infinity)) {
    if (!nonempty(value) || out.includes(value)) continue;
    check(value.length <= DEEP_REFERENCE_LIMITS.maxStringChars,
      'DEEP_REF_QUERY_STRING', 'A projected limitation exceeds the per-string bound');
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}

export async function queryDeepReferences({installation, problem, dimensions, sourceIds, limit = 5,
  maxFunctionsPerResult = DEEP_REFERENCE_LIMITS.maxFunctionsPerResult,
  maxEvidenceRefsPerResult = DEEP_REFERENCE_LIMITS.maxEvidenceRefsPerResult} = {}) {
  check(object(installation) && resolvedInstallations.has(installation),
    'DEEP_REF_QUERY_INSTALLATION', 'installation must come from resolveDeepReferenceLayer');
  const checkedProblem = validateProblem(problem);
  const ignoredSearchTerms = checkedProblem.searchTerms.filter(term => POLICY_TERMS.has(term));
  const positiveProblem = {...checkedProblem,
    searchTerms: checkedProblem.searchTerms.filter(term => !POLICY_TERMS.has(term)),
    requiredTermGroups: checkedProblem.requiredTermGroups.map(group => group.filter(term => !POLICY_TERMS.has(term)))};
  const positiveTermsSufficient = positiveProblem.searchTerms.length >= DEEP_REFERENCE_LIMITS.minimumFunctionMatchedTerms
    && positiveProblem.requiredTermGroups.every(group => group.length > 0);
  const requestedDimensions = dimensions ?? ['emotionalProgression','psychologicalChangeDrivers','observableCraftDecisionHypotheses'];
  check(Array.isArray(requestedDimensions) && requestedDimensions.length > 0
    && requestedDimensions.every(value => ['emotionalProgression','psychologicalChangeDrivers','observableCraftDecisionHypotheses'].includes(value)),
  'DEEP_REF_QUERY_DIMENSIONS', 'Unknown or empty query dimensions');
  check(Number.isSafeInteger(limit) && limit >= 1 && limit <= DEEP_REFERENCE_LIMITS.maxResults
    && Number.isSafeInteger(maxFunctionsPerResult) && maxFunctionsPerResult >= 1 && maxFunctionsPerResult <= DEEP_REFERENCE_LIMITS.maxFunctionsPerResult
    && Number.isSafeInteger(maxEvidenceRefsPerResult) && maxEvidenceRefsPerResult >= 1 && maxEvidenceRefsPerResult <= DEEP_REFERENCE_LIMITS.maxEvidenceRefsPerResult,
  'DEEP_REF_QUERY_LIMITS', 'Query limits exceed the frozen bounds');
  const installedById = new Map(installation.entries.map(item => [item.sourceId, item]));
  if (sourceIds !== undefined) {
    check(Array.isArray(sourceIds) && sourceIds.length > 0 && sourceIds.every(id => installedById.has(id)),
      'DEEP_REF_QUERY_SOURCES', 'sourceIds contains an unknown or invalid installed source');
  }
  const queryText = positiveProblem.searchTerms.join(' ');
  const candidateQuery = positiveTermsSufficient ? await queryDeepAnalysisCandidates({
    runRoot: installation.layerRoot,
    queuePath: join(installation.layerRoot, 'queue-99.json'),
    query: queryText,
    sourceIds,
    dimensions: requestedDimensions,
    limit: 200,
  }) : {results: []};
  const minimumMatchedTerms = Math.max(DEEP_REFERENCE_LIMITS.minimumMatchedTerms,
    Math.ceil(positiveProblem.searchTerms.length / 4));
  const groupsSatisfied = terms => positiveProblem.requiredTermGroups.every(group => group.some(term => terms.includes(term)));
  // The reused query's broad text index is only a candidate pool. Neither its
  // caveat-inflated score nor its order can determine the returned ranking.
  const matched = candidateQuery.results.map(item => ({...item,
    positiveTerms: matchedPositiveTerms(functionCandidates(item.dimensions, requestedDimensions), positiveProblem)}))
    .filter(item => installedById.has(item.sourceId) && item.positiveTerms.length >= minimumMatchedTerms
      && groupsSatisfied(item.positiveTerms));
  const projected = [];
  for (const hit of matched) {
    const entry = installedById.get(hit.sourceId);
    const [candidateFile, packetFile, reportFile, statusFile] = await Promise.all([
      readJson(safeInside(installation.layerRoot, entry.candidatePath)),
      readJson(safeInside(installation.layerRoot, entry.packetPath)),
      readJson(safeInside(installation.layerRoot, entry.reportPath)),
      readJson(safeInside(installation.layerRoot, entry.statusPath)),
    ]);
    check(hash(candidateFile.bytes) === entry.candidateSha256 && hash(packetFile.bytes) === entry.packetSha256
      && hash(reportFile.bytes) === entry.reportSha256 && hash(statusFile.bytes) === entry.statusSha256,
    'DEEP_REF_QUERY_TAMPER', 'A selected layer record changed after resolution', {sourceId: entry.sourceId});
    const candidate = candidateFile.value, packet = packetFile.value;
    const reportCandidate = boundReportRecord(reportFile.value, entry, candidate);
    check(reportCandidate, 'DEEP_REF_QUERY_REVIEW', 'Selected result has no current bound review', {sourceId: entry.sourceId});
    const bounded = boundedFunctions(candidate.modelOutput, packet, requestedDimensions,
      maxFunctionsPerResult, maxEvidenceRefsPerResult, positiveProblem);
    if (bounded.functions.length === 0) continue;
    const matchedTerms = matchedPositiveTerms(bounded.functions, positiveProblem);
    if (matchedTerms.length < minimumMatchedTerms || !groupsSatisfied(matchedTerms)) continue;
    const referenceId = `deepref:${entry.sourceId}:${entry.candidateSha256.slice(0,16)}:${entry.reportSha256.slice(0,16)}`;
    projected.push({
      referenceId,
      source: {...entry.source, title: entry.title},
      analysis: {...entry.analysis, candidateSha256: entry.candidateSha256, packetSha256: entry.packetSha256,
        candidateStatus: 'candidate_unreviewed', approved: false, checked: false, active: false},
      semanticReview: {reportPath: entry.reportPath, reportSha256: entry.reportSha256, verdict: entry.verdict,
        caveats: reportCandidate.caveats ?? [], blockingDefects: [], approvalGranted: false, activeProductionChanged: false},
      match: {matchedTerms, matchedTermCount: matchedTerms.length, requiredMatchedTermCount: minimumMatchedTerms,
        requiredTermGroupsSatisfied: positiveProblem.requiredTermGroups.map(group => group.filter(term => matchedTerms.includes(term))),
        lexicalScore: matchedTerms.length, semanticSimilarityClaimed: false},
      borrowableWritingFunctions: bounded.functions,
      exactReferences: bounded.references.map(reference => ({...reference, sourceId: entry.sourceId,
        sourceSha256: entry.source.sourceSha256, sourceTextSha256: entry.source.sourceTextSha256})),
      limits: {
        visibility: packet.visibilityBoundary,
        statements: boundedStrings([
          candidate.modelOutput.limitations ?? [],
          reportCandidate.caveats ?? [],
          packet.inheritedLimitations ?? [],
        ]),
      },
      retrievalIsUse: false,
      requiresExplicitAdoption: true,
    });
  }
  // Rank only complete projected functions, then apply the result limit. Words
  // in omitted functions cannot increase a returned result's score or rank.
  const results = projected.sort((left, right) => right.match.lexicalScore - left.match.lexicalScore
    || left.source.title.localeCompare(right.source.title, 'zh-CN')
    || left.source.sourceId.localeCompare(right.source.sourceId)).slice(0, limit);
  const request = {problem: checkedProblem, dimensions: requestedDimensions, sourceIds: sourceIds ?? null, limit,
    maxFunctionsPerResult, maxEvidenceRefsPerResult};
  return {
    schemaVersion: DEEP_REFERENCE_QUERY_VERSION,
    queryId: `deepref-query-${hash(json({installId: installation.installId, request}))}`,
    installId: installation.installId,
    request,
    matchingPolicy: {version: MATCHING_POLICY, positiveFields: ['observablePattern','borrowableFunction'],
      excludedFields: ['alternatives','limitation','uncertainty','counterEvidenceOrGap','identifiers','context','reviewCaveats'],
      ignoredSearchTerms, effectiveSearchTerms: positiveProblem.searchTerms,
      effectiveRequiredTermGroups: positiveProblem.requiredTermGroups,
      candidatePoolCount: candidateQuery.results.length, positiveCandidateCount: matched.length,
      noResultReason: results.length ? null : !positiveTermsSufficient
        ? 'insufficient_positive_terms_or_required_group' : 'no_eligible_positive_function_bundle',
      boundary: 'Positive lexical support only; not semantic suitability. Limits and alternative explanations remain attached, not scored.'},
    status: results.length > 0 ? 'covered' : 'uncovered',
    resultCount: results.length,
    limits: {...DEEP_REFERENCE_LIMITS, requestedResultLimit: limit, requiredMatchedTermCount: minimumMatchedTerms},
    boundary: 'Lexical retrieval returns independently reviewed, evidence-bound hypotheses. Retrieval is not adoption or proof of literary effect.',
    retrievalIsUse: false,
    requiresExplicitAdoption: true,
    results,
  };
}
