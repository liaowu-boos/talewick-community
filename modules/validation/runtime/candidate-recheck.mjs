import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { manuscriptFingerprint } from './checks.mjs';
import {
  CROSS_CHAPTER_IMPLEMENTATION_VERSION,
  prepareCrossChapterExtraction,
  reviewCrossChapter,
} from './cross-chapter-review.mjs';

export const CANDIDATE_RECHECK_VERSION = `candidate-recheck-${CROSS_CHAPTER_IMPLEMENTATION_VERSION}-1`;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const ensure = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function copy(value) {
  let cloned;
  try { cloned = structuredClone(value); } catch { ensure(false, 'NON_JSON_INPUT'); }
  ensure(JSON.stringify(cloned) !== undefined && isDeepStrictEqual(cloned, JSON.parse(JSON.stringify(cloned))), 'NON_JSON_INPUT');
  return cloned;
}
function frozen(value) {
  if (object(value) || Array.isArray(value)) {
    for (const child of Object.values(value)) frozen(child);
    Object.freeze(value);
  }
  return value;
}
function artifactAdapter(artifacts) {
  ensure(object(artifacts), 'ARTIFACTS_REQUIRED');
  if (Object.hasOwn(artifacts, 'store') || Object.hasOwn(artifacts, 'checkpoint')) {
    ensure(Object.keys(artifacts).length === 2 && object(artifacts.store) && typeof artifacts.checkpoint === 'function', 'ARTIFACTS_REQUIRED');
    return artifacts;
  }
  return { store: artifacts, checkpoint: async () => {} };
}
async function save(adapter, key, value) {
  const record = copy(value);
  if (Object.hasOwn(adapter.store, key)) {
    ensure(isDeepStrictEqual(copy(adapter.store[key]), record), 'CHECKPOINT_MISMATCH');
    return;
  }
  await adapter.checkpoint(key, copy(record));
  adapter.store[key] = record;
}

function guardedModel(model, adapter) {
  return {
    async complete(request) {
      const key = `candidate-recheck:dispatch:${request.stage}`;
      const requestSHA = digest({ stage: request.stage, system: request.system, user: request.user,
        modelPolicy: request.modelPolicy, maxTokens: request.maxTokens, allowRecovery: request.allowRecovery });
      const started = { requestSHA, stage: request.stage };
      const completed = adapter.store[`${key}:completed`];
      if (completed !== undefined) {
        ensure(isDeepStrictEqual(copy(adapter.store[`${key}:started`]), started) && completed.requestSHA === requestSHA, 'DISPATCH_BINDING');
        if (completed.receipt !== null) await request.onReceipt(copy(completed.receipt));
        return completed.rawResponse;
      }
      if (Object.hasOwn(adapter.store, `${key}:started`)) {
        ensure(isDeepStrictEqual(copy(adapter.store[`${key}:started`]), started), 'DISPATCH_BINDING');
        ensure(!Object.hasOwn(adapter.store, `${key}:failed`), 'PROVIDER_DISPATCH_FAILED');
        ensure(false, 'PROVIDER_OUTCOME_UNKNOWN');
      }
      await save(adapter, `${key}:started`, started);
      let receipt = null;
      let rawResponse;
      try {
        rawResponse = await model.complete({ ...request, onReceipt(value) {
          ensure(receipt === null, 'MULTIPLE_PROVIDER_RECEIPTS');
          receipt = copy(value);
        } });
      } catch (error) {
        await save(adapter, `${key}:failed`, { requestSHA, code: typeof error?.code === 'string' ? error.code : 'MODEL_CALL_FAILED' });
        throw error;
      }
      await save(adapter, `${key}:completed`, { requestSHA, rawResponse, receipt });
      if (receipt !== null) await request.onReceipt(copy(receipt));
      return rawResponse;
    },
  };
}

/** Product creates this server-side from its stored source task and complete candidate. */
export function prepareCandidateRecheck({ sourceTaskId, candidateChapters, priorFailureIds = [] } = {}) {
  ensure(typeof sourceTaskId === 'string' && ID.test(sourceTaskId), 'SOURCE_TASK_ID');
  ensure(Array.isArray(priorFailureIds) && priorFailureIds.length <= 20 &&
    priorFailureIds.every(id => typeof id === 'string' && ID.test(id)) && new Set(priorFailureIds).size === priorFailureIds.length, 'PRIOR_FAILURE_IDS');
  const chapters = copy(candidateChapters);
  const cross = prepareCrossChapterExtraction(chapters);
  const binding = {
    sourceTaskId,
    candidateSHA: manuscriptFingerprint(chapters),
    checkerVersion: CANDIDATE_RECHECK_VERSION,
    crossChapterManuscriptSHA: cross.manuscript.manuscriptSha256,
  };
  const core = { schemaVersion: CANDIDATE_RECHECK_VERSION, binding, candidateChapters: chapters, priorFailureIds: copy(priorFailureIds) };
  return frozen({ ...core, requestSHA: digest(core) });
}

function validatePrepared(prepared) {
  const saved = copy(prepared);
  ensure(object(saved) && object(saved.binding), 'PREPARED_INVALID');
  const rebuilt = prepareCandidateRecheck({
    sourceTaskId: saved.binding.sourceTaskId,
    candidateChapters: saved.candidateChapters,
    priorFailureIds: saved.priorFailureIds,
  });
  ensure(isDeepStrictEqual(saved, rebuilt), 'PREPARED_TAMPER');
  return rebuilt;
}

export function candidateRecheckStatusFor(review) {
  ensure(object(review) && Array.isArray(review.findings) && Array.isArray(review.comparisonGroups), 'REVIEW_RESULT_INVALID');
  if (review.findings.some(item => item.status === 'confirmed_conflict')) return 'failed';
  if (review.findings.some(item => item.status === 'ambiguous')) return 'needs_attention';
  return 'reviewed_no_reported_conflict';
}

function sealedResult(input, review) {
  ensure(review.manuscriptSha256 === input.binding.crossChapterManuscriptSHA, 'REVIEW_MANUSCRIPT_BINDING');
  ensure(isDeepStrictEqual(review.checkedChapterIds, input.candidateChapters.map(chapter => chapter.id)), 'REVIEW_COVERAGE');
  const core = {
    schemaVersion: CANDIDATE_RECHECK_VERSION,
    binding: input.binding,
    requestSHA: input.requestSHA,
    priorFailureIds: input.priorFailureIds,
    status: candidateRecheckStatusFor(review),
    crossChapterResult: copy(review),
    automaticAdoption: false,
    literaryPass: 'NOT_COMPUTED',
    readerPreference: 'NOT_RECHECKED',
  };
  return frozen({ ...core, resultSHA: digest(core) });
}

/** Two-stage full manuscript scan. The host owns async scheduling and persisted checkpoint storage. */
export async function runCandidateRecheck({ prepared, model, artifacts, signal, onProgress } = {}) {
  const input = validatePrepared(prepared);
  ensure(model && typeof model.complete === 'function', 'MODEL_REQUIRED');
  const adapter = artifactAdapter(artifacts);
  await save(adapter, 'candidate-recheck:request', input);
  const review = await reviewCrossChapter({
    manuscript: input.candidateChapters, model: guardedModel(model, adapter), artifacts: adapter,
    options: { signal, progress: onProgress },
  });
  const result = sealedResult(input, review);
  await save(adapter, 'candidate-recheck:result', result);
  return result;
}

/** Replays sealed stage checkpoints on an isolated copy; verification never writes to caller artifacts. */
export async function validateCandidateRecheckResult({ result, prepared, artifacts } = {}) {
  const input = validatePrepared(prepared);
  const supplied = artifactAdapter(artifacts);
  const adapter = { store: copy(supplied.store), checkpoint: async () => { ensure(false, 'RECHECK_CHECKPOINT_INCOMPLETE'); } };
  ensure(isDeepStrictEqual(copy(adapter.store['candidate-recheck:request']), input), 'REQUEST_CHECKPOINT');
  const review = await reviewCrossChapter({
    manuscript: input.candidateChapters,
    model: { async complete() { ensure(false, 'RECHECK_CHECKPOINT_INCOMPLETE'); } },
    artifacts: adapter,
  });
  const expected = sealedResult(input, review);
  ensure(isDeepStrictEqual(copy(result), expected) && isDeepStrictEqual(copy(adapter.store['candidate-recheck:result']), expected), 'RESULT_TAMPER');
  return expected;
}

/** Read-only gate for an explicit user choice, never an automated clearance. */
export async function checkCandidateRecheckAdoption({ result, prepared, artifacts, sourceTaskId, candidateChapters, checkerVersion } = {}) {
  let valid;
  try { valid = await validateCandidateRecheckResult({ result, prepared, artifacts }); }
  catch { return { eligible: false, reason: 'invalid_result' }; }
  if (sourceTaskId !== valid.binding.sourceTaskId) return { eligible: false, reason: 'wrong_task' };
  if (checkerVersion !== valid.binding.checkerVersion) return { eligible: false, reason: 'checker_version_mismatch' };
  if (!Array.isArray(candidateChapters) || manuscriptFingerprint(candidateChapters) !== valid.binding.candidateSHA)
    return { eligible: false, reason: 'stale_candidate' };
  return candidateRecheckSelectionForStatus(valid.status);
}

export function candidateRecheckSelectionForStatus(status) {
  if (status === 'failed') return { eligible: false, reason: 'fact_conflict' };
  if (status === 'needs_attention') return { eligible: false, reason: 'fact_doubt' };
  ensure(status === 'reviewed_no_reported_conflict', 'RECHECK_STATUS');
  return { eligible: true, reason: 'explicit_selection_available' };
}
