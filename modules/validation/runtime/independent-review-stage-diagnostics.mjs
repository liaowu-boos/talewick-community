import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { wholeQualitySha256 } from './focused-whole-quality-evaluation.mjs';
import { getIndependentReviewRequestHash } from './independent-review-task.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeId = id => typeof id === 'string' && /^[\w-]+$/.test(id);
const sealSchemas = new Set(['independent-review-stage-seal-1', 'independent-review-reread-stage-seal-1',
  'independent-review-recovered-stage-seal-1', 'independent-review-paragraph-stage-seal-1']);
const states = ['sealed', 'returned_invalid', 'unknown', 'not_dispatched'];
const lifecycle = new Set(['dispatch_started', 'provider_returned', 'dispatch_not_sent', 'stage_needs_attention', 'unknown_dispatch', 'cancelled', 'stage_sealed']);
const ensure = (condition, code) => { if (!condition) throw Object.assign(new Error(code), { code }); };

// Caller selects a trusted native task root. Reject redirects inside that root, including dangling symlinks.
async function optional(path, directory = false) {
  try {
    const stat = await lstat(path);
    ensure((directory ? stat.isDirectory() : stat.isFile()) && await realpath(path) === path, 'DIAGNOSTIC_ARTIFACT_PATH');
    return directory ? await readdir(path) : await readFile(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
const decode = bytes => bytes === null ? null : JSON.parse(bytes.toString('utf8'));
const one = (events, type) => events.filter(e => e.type === type);

async function inspectAttempt(task, stage, attemptId, events, seal, stageDir) {
  const dir = join(stageDir, 'attempts', attemptId);
  await optional(dir, true);
  const raw = await optional(join(dir, 'raw-response.txt'));
  const rawResponse = raw === null ? null : { sha256: sha(raw), byteLength: raw.length };
  const failure = events.findLast(e => e.type === 'stage_needs_attention' || e.type === 'cancelled');
  const decision = (state, reason) => ({ attemptId, state, reason, inputHash: starts[0]?.inputHash ?? null,
    providerReturnEvents: returns.length, rawResponse,
    failureCode: /^[A-Z][A-Z_0-9]{0,99}$/.test(failure?.code ?? '') ? failure.code : null });
  const unknown = reason => decision('unknown', reason);
  const starts = one(events, 'dispatch_started'), returns = one(events, 'provider_returned'), seals = one(events, 'stage_sealed');
  const start = starts[0], returned = returns[0], sealEvent = seals[0];
  if (starts.length !== 1 || returns.length > 1 || seals.length > 1 || !/^[0-9a-f]{64}$/.test(start?.inputHash ?? '')) return unknown('missing_or_conflicting_events');
  const dispatch = decode(await optional(join(dir, 'dispatch.json')));
  if (!dispatch || dispatch.attemptId !== attemptId || dispatch.stageId !== stage.id || dispatch.stage !== stage.stage || dispatch.inputHash !== start.inputHash || start.stage !== stage.stage) return unknown('dispatch_binding_mismatch');
  if (events[0] !== start) return unknown('events_out_of_order');
  if (events.some(e => e.stage !== stage.stage)) return unknown('stage_binding_mismatch');
  const notSent = events.some(e => e.type === 'dispatch_not_sent' || (e.type === 'stage_needs_attention' && e.definitelyNotDispatched === true));
  if (notSent) {
    if (returned || rawResponse || sealEvent || seal?.attemptId === attemptId || events.some(e => e.providerOutcomeUnknown || e.type === 'unknown_dispatch' || e.code === 'PROVIDER_OUTCOME_UNKNOWN')) return unknown('conflicting_non_dispatch');
    return decision('not_dispatched', 'explicit_non_dispatch');
  }
  if (!returned || !rawResponse) return unknown('return_event_or_raw_missing');
  if (returned.inputHash !== start.inputHash || returned.stage !== stage.stage || events.some(e => e.type === 'unknown_dispatch' || e.code === 'PROVIDER_OUTCOME_UNKNOWN' || e.providerOutcomeUnknown === true)) return unknown('conflicting_return_evidence');
  const parsed = await optional(join(dir, 'parsed-response.json'));
  if (parsed !== null) {
    try {
      if (!isDeepStrictEqual(JSON.parse(raw), JSON.parse(parsed))) return unknown('raw_parsed_mismatch');
    } catch (error) {
      if (error instanceof SyntaxError) return unknown('raw_parsed_mismatch');
      throw error;
    }
  }
  const receipt = decode(await optional(join(dir, 'receipt.json')));
  if (failure?.code !== 'PROVIDER_RECEIPT_INVALID' && (!receipt || receipt.inputHash !== start.inputHash || receipt.contextId !== returned.contextId || receipt.invocationId !== returned.invocationId || receipt.provider !== returned.provider)) return unknown('receipt_binding_mismatch');
  if (sealEvent || seal?.attemptId === attemptId) {
    if (!seal || !sealEvent || parsed === null || seal.attemptId !== attemptId || seal.stageId !== stage.id || seal.stage !== stage.stage || events.at(-1) !== sealEvent || !seal.record || !returned.contextId || !returned.invocationId) return unknown('seal_or_event_mismatch');
    if (!sealSchemas.has(seal.schemaVersion) || (task.modelCitationMode === 'paragraph_refs_v1') !== (seal.schemaVersion === 'independent-review-paragraph-stage-seal-1')) return unknown('unexpected_seal_schema');
    if (task.evidencePolicy !== undefined) {
      const proof = decode(await optional(join(dir, 'delivery-proof.json')));
      if (!proof || sha(JSON.stringify(proof)) !== seal.deliveryProofSHA256 || sealEvent.deliveryProofSHA256 !== seal.deliveryProofSHA256) return unknown('delivery_proof_mismatch');
    }
    const hash = wholeQualitySha256(seal.record);
    const validation = decode(await optional(join(dir, 'validation.json')));
    const resolved = decode(await optional(join(dir, 'resolved-record.json')));
    if (!resolved || wholeQualitySha256(resolved) !== hash || validation?.ok !== true || validation.recordSha256 !== hash) return unknown('seal_record_mismatch');
    if (seal.inputHash !== start.inputHash || sealEvent.inputHash !== start.inputHash || sealEvent.stage !== stage.stage || seal.recordSha256 !== hash || sealEvent.recordSha256 !== hash || seal.contextId !== returned.contextId || sealEvent.contextId !== returned.contextId || seal.invocationId !== returned.invocationId) return unknown('seal_binding_mismatch');
    const boundRaw = seal.paragraphReferences?.files?.['raw-response.txt'];
    if (task.modelCitationMode === 'paragraph_refs_v1' && (boundRaw !== rawResponse.sha256 || wholeQualitySha256(seal.paragraphReferences) !== sealEvent.paragraphReferencesSha256)) return unknown('sealed_raw_digest_mismatch');
    return decision('sealed', 'existing_seal_observed');
  }
  if (!failure?.code || events.at(-1) !== failure || events.indexOf(failure) <= events.indexOf(returned)) return unknown('return_without_terminal_rejection');
  // Cancellation after a return says nothing about the validity of its contents.
  if (failure.type !== 'stage_needs_attention') return unknown('returned_but_not_validated');
  return decision('returned_invalid', 'returned_with_saved_raw_and_rejection');
}

async function inspectStage(task, run, stage, timeline) {
  const dir = join(run, 'stages', stage.id);
  const stageFiles = await optional(dir, true) ?? [];
  const local = timeline.filter(e => e.stageId === stage.id);
  const beforeDispatchCancel = e => e.type === 'cancelled' && e.code === 'CANCELLED' && !e.attemptId;
  const stageEvents = local.filter(e => lifecycle.has(e.type) && !beforeDispatchCancel(e));
  const dirs = await optional(join(dir, 'attempts'), true) ?? [];
  const seal = decode(await optional(join(dir, 'sealed.json')));
  const attemptIds = new Set([...stageEvents.map(e => e.attemptId), ...dirs, ...(seal ? [seal.attemptId] : [])]);
  const attempts = [];
  if ([...attemptIds].some(id => !safeId(id))) return { stageId: stage.id, state: 'unknown', reason: 'unbound_attempt', attempts };
  for (const id of attemptIds) attempts.push(await inspectAttempt(task, stage, id, stageEvents.filter(e => e.attemptId === id), seal, dir));
  if (!attempts.length) {
    if (local.some(e => !beforeDispatchCancel(e)) || stageFiles.some(name => name !== 'attempts')) return {stageId: stage.id, state:'unknown', reason:'incomplete_attempt_history', attempts};
    return { stageId: stage.id, state: 'not_dispatched', reason: 'no_attempt_in_snapshot', attempts };
  }
  let state;
  if (attempts.some(a => a.state === 'unknown')) state = 'unknown';
  else if (attempts.some(a => a.state === 'sealed')) state = stageEvents.at(-1)?.type === 'stage_sealed' ? 'sealed' : 'unknown';
  else state = attempts.some(a => a.state === 'returned_invalid') ? 'returned_invalid' : 'not_dispatched';
  return { stageId: stage.id, state, reason: attempts.length === 1 ? attempts[0].reason : 'attempt_history', attempts };
}

/** Inspect a quiescent server-selected native task. Never invokes resume/reconcile or reads model opinions into the result. */
export async function readIndependentReviewStageDiagnostics({ runDir, requestHash }) {
  ensure(isAbsolute(runDir) && basename(runDir) === 'run', 'DIAGNOSTIC_RUN_PATH');
  const run = await realpath(runDir), parent = dirname(run);
  const metadataPath = join(parent, 'task.json'), eventPath = join(parent, 'events.ndjson'), requestPath = join(parent, 'request.json');
  async function unlocked() { ensure((await optional(join(parent, 'active.lock'))) === null, 'DIAGNOSTIC_TASK_ACTIVE'); }
  await unlocked();
  const [metadata, journal, requestBytes] = await Promise.all([metadataPath, eventPath, requestPath].map(p => optional(p)));
  ensure(metadata && journal && requestBytes && journal.at(-1) === 10, 'DIAGNOSTIC_INCOMPLETE_SNAPSHOT');
  const task = decode(metadata), request = decode(requestBytes), events = journal.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
  ensure(task.schemaVersion === 'independent-review-task-1' && task.runDir === run && task.runRoot === dirname(parent) && task.requestHash === requestHash && task.caseId === request.caseId && task.mode === request.mode, 'DIAGNOSTIC_TASK_BINDING');
  ensure(getIndependentReviewRequestHash({request, modelCitationMode:task.modelCitationMode, evidencePolicy:task.evidencePolicy}) === requestHash, 'DIAGNOSTIC_REQUEST_HASH');
  const created = one(events, 'created'), ids = new Set(task.stagePlan.map(s => s.id));
  ensure(created.length === 1 && events[0] === created[0] && created[0].requestHash === requestHash && created[0].mode === task.mode && created[0].totalStages === task.stagePlan.length && ids.size === task.stagePlan.length && [...ids].every(safeId), 'DIAGNOSTIC_JOURNAL_BINDING');
  ensure(events.every(e => (!e.stageId || ids.has(e.stageId)) && (!lifecycle.has(e.type) || ids.has(e.stageId))), 'DIAGNOSTIC_FOREIGN_STAGE');
  const stageDirs = await optional(join(run, 'stages'), true) ?? [];
  ensure(stageDirs.every(id => ids.has(id)), 'DIAGNOSTIC_FOREIGN_STAGE');
  const owners = new Map();
  for (const e of events.filter(e => e.stageId && safeId(e.attemptId) && lifecycle.has(e.type))) {
    ensure(!owners.has(e.attemptId) || owners.get(e.attemptId) === e.stageId, 'DIAGNOSTIC_ATTEMPT_REUSED'); owners.set(e.attemptId, e.stageId);
  }
  const stages = [];
  for (const stage of task.stagePlan) {
    try { stages.push(await inspectStage(task, run, stage, events)); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      stages.push({stageId: stage.id, state:'unknown', reason:'malformed_stage_artifact', attempts:[]});
    }
  }
  await unlocked();
  const [endMetadata,endJournal,endRequest] = await Promise.all([metadataPath,eventPath,requestPath].map(p => optional(p)));
  ensure(endMetadata && endJournal && endRequest && metadata.equals(endMetadata) && journal.equals(endJournal) && requestBytes.equals(endRequest), 'DIAGNOSTIC_SNAPSHOT_CHANGED');
  return { schemaVersion:'independent-review-stage-diagnostics-1', requestHash, taskMetadataSHA256:sha(metadata), eventsSHA256:sha(journal), stages,
    counts:Object.fromEntries(states.map(state => [state,stages.filter(s => s.state === state).length])) };
}
