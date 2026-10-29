import { createHash } from 'node:crypto';
import { readFile, readdir, lstat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export const ZERO_DISPATCH_VERSION = 'independent-review-audited-zero-dispatch-1';
export const AUDITED_REPAIR_DIRECTORY = 'position-repair-after-audited-nondispatch';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const ensure = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const hashPattern = /^[a-f0-9]{64}$/;
const json = bytes => JSON.parse(bytes.toString('utf8'));
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const timestamp = x => { const t = Date.parse(x); ensure(Number.isFinite(t), 'ZERO_DISPATCH_TIME'); return t; };

async function file(path) {
  ensure(isAbsolute(path) && resolve(path) === path, 'ZERO_DISPATCH_PATH');
  const stat = await lstat(path);
  ensure(stat.isFile() && !stat.isSymbolicLink(), 'ZERO_DISPATCH_FILE');
  return readFile(path);
}

function validateEvidence(witnessRaw, audit, snapshots, wireEntries, task, descriptor, originalAttemptId) {
  ensure(object(audit) && typeof audit.reviewTaskId === 'string' && hashPattern.test(audit.witnessSHA256), 'ZERO_DISPATCH_TRUSTED_AUDIT_REQUIRED');
  ensure(sha(witnessRaw) === audit.witnessSHA256, 'ZERO_DISPATCH_WITNESS_HASH');
  const w = json(witnessRaw);
  ensure(w.schemaVersion === 'analysis99-provider-not-sent-witness-1', 'ZERO_DISPATCH_WITNESS_VERSION');
  ensure(w.reviewTaskId === audit.reviewTaskId && w.stageId === descriptor.id && w.originalAttemptId === originalAttemptId
    && typeof w.localRepairAttemptId === 'string', 'ZERO_DISPATCH_WITNESS_IDENTITY');
  ensure(Number.isSafeInteger(w.openingCount) && w.openingCount >= 0 && w.closingCount === w.openingCount && w.attemptedPosts === 0
    && w.providerInFlight === false && w.wireFiles === 0 && w.doesNotResetCounter === true && w.doesNotAuthorizeUnknownOutcomeRetry === true, 'ZERO_DISPATCH_WITNESS_COUNTS');
  ensure(isAbsolute(w.wireDirectory) && resolve(w.wireDirectory) === w.wireDirectory && basename(w.wireDirectory) === 'wire' && basename(dirname(w.wireDirectory)) === 'provider', 'ZERO_DISPATCH_WIRE_PATH');
  ensure(Array.isArray(wireEntries) && wireEntries.length === 0, 'ZERO_DISPATCH_WIRE_NOT_EMPTY');
  const provider = dirname(w.wireDirectory), segment = dirname(provider);
  const paths = [join(segment, 'accounting.json'), join(provider, 'accounting.json'), join(provider, 'balance.json'), join(provider, 'session.json'), join(provider, 'opening-state.json'), join(provider, 'provider-ledger.ndjson'), join(segment, 'task-final.json')];
  ensure(Array.isArray(w.files) && w.files.length === paths.length && snapshots.length === paths.length
    && new Set(w.files.map(f => f.path)).size === paths.length && paths.every(p => w.files.some(f => f.path === p)), 'ZERO_DISPATCH_EVIDENCE_COVERAGE');
  const buffers = paths.map(p => {
    const f = w.files.find(f => f.path === p), b = snapshots.find(s => s.path === p);
    ensure(b && typeof b.base64 === 'string', 'ZERO_DISPATCH_EVIDENCE_MISSING');
    const bytes = Buffer.from(b.base64, 'base64');
    ensure(bytes.length === f.bytes && hashPattern.test(f.sha256) && sha(bytes) === f.sha256, 'ZERO_DISPATCH_EVIDENCE_HASH'); return bytes;
  });
  const [a, b, balance, session, opening, , terminal] = buffers.map((bytes, i) => i === 5 ? null : json(bytes));
  ensure(buffers[0].equals(buffers[1]) && equal(a, b), 'ZERO_DISPATCH_ACCOUNTING_DISAGREEMENT');
  ensure(a.openingCount === w.openingCount && a.closingCount === w.closingCount && a.attemptedPosts === 0 && a.blocked === true
    && a.durabilityFailure === false && a.providerInFlight === false && Array.isArray(a.receipts) && a.receipts.length === 0, 'ZERO_DISPATCH_ACCOUNTING_NOT_EMPTY');
  ensure(balance.httpStatus === 200 && balance.available === false && balance.generationPostsThisCheck === 0
    && balance.observedCumulativeGenerationPosts === w.openingCount && equal(balance, w.balance), 'ZERO_DISPATCH_BALANCE');
  ensure(session.caseId === a.caseId && session.openingCount === w.openingCount && equal(session.modelPolicy, a.modelPolicy), 'ZERO_DISPATCH_SESSION');
  ensure(opening.currentAuthorization?.sameExperimentUsed === w.openingCount && opening.currentAuthorization?.providerInFlight === false, 'ZERO_DISPATCH_OPENING_STATE');
  ensure(buffers[5].length === 0, 'ZERO_DISPATCH_LEDGER_NOT_EMPTY');
  ensure(terminal.id === audit.reviewTaskId && terminal.caseId === task.caseId && terminal.mode === task.mode && terminal.status === 'needs_attention'
    && terminal.report === null && terminal.error?.code === 'POSITION_REPAIR_EXHAUSTED' && terminal.error?.stage === descriptor.id
    && terminal.progress?.completedStages === task.stagePlan.findIndex(item => item.id === descriptor.id), 'ZERO_DISPATCH_TASK_BINDING');
  const recoveries = terminal.recoveries?.filter(item => item.stageId === descriptor.id && item.mode === 'position_repair') ?? [];
  ensure(recoveries.length === 1 && recoveries[0].status === 'needs_attention' && recoveries[0].resultError?.code === 'POSITION_REPAIR_EXHAUSTED'
    && ['QUOTE_NOT_FOUND', 'QUOTE_POSITION_NOT_UNIQUE'].includes(recoveries[0].originalError?.code), 'ZERO_DISPATCH_TASK_RECOVERY');
  ensure(timestamp(session.startedAt) <= timestamp(balance.checkedAt) && timestamp(balance.checkedAt) <= timestamp(a.completedAt)
    && timestamp(a.completedAt) <= timestamp(w.at), 'ZERO_DISPATCH_TIME');
  return { witness: w, sessionStarted: timestamp(session.startedAt), balanceChecked: timestamp(balance.checkedAt), completed: timestamp(a.completedAt) };
}

async function blockedAttempt({ task, descriptor, origin, input, originalAttemptId, evidence, eventPrefix }) {
  const dir = join(origin.dir, 'position-repair');
  ensure(equal((await readdir(dir)).sort(), ['dispatch.json', 'instruction.txt', 'packet.json']), 'ZERO_DISPATCH_REPAIR_HAS_RESPONSE_OR_EXTRA_FILES');
  const [dispatchRaw, packetRaw, instructionRaw] = await Promise.all(['dispatch.json', 'packet.json', 'instruction.txt'].map(n => file(join(dir, n))));
  const dispatch = json(dispatchRaw), packet = json(packetRaw);
  ensure(dispatch.attemptId === evidence.witness.localRepairAttemptId && dispatch.inputHash === input.inputHash
    && equal(packet, input.packet) && instructionRaw.toString('utf8') === `${input.instruction}\n`, 'ZERO_DISPATCH_REPAIR_INPUT');
  const allEventsRaw = await readFile(join(dirname(task.runDir), 'events.ndjson'), 'utf8');
  const prefix = eventPrefix ?? allEventsRaw;
  ensure(allEventsRaw.startsWith(prefix) && prefix.endsWith('\n'), 'ZERO_DISPATCH_EVENT_PREFIX');
  const events = prefix.trimEnd().split('\n').map(line => JSON.parse(line));
  const laterEvents = allEventsRaw.slice(prefix.length).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  ensure(!laterEvents.some(e => e.attemptId === dispatch.attemptId), 'ZERO_DISPATCH_LATE_BLOCKED_ATTEMPT_EVENT');
  const related = events.filter(e => e.originalAttemptId === originalAttemptId && e.type.startsWith('position_repair_'));
  ensure(related.length === 2 && related[0].type === 'position_repair_started' && related[1].type === 'position_repair_failed'
    && related.every(e => e.stageId === descriptor.id && e.attemptId === dispatch.attemptId)
    && related[0].inputHash === input.inputHash, 'ZERO_DISPATCH_REPAIR_EVENTS');
  const latest = events.at(-1);
  ensure(latest.type === 'stage_needs_attention' && latest.stageId === descriptor.id && latest.attemptId === originalAttemptId
    && latest.code === 'POSITION_REPAIR_EXHAUSTED', 'ZERO_DISPATCH_FAILURE_EVENT');
  ensure(!events.some(e => e.attemptId === dispatch.attemptId && ['provider_returned', 'position_repair_returned'].includes(e.type)), 'ZERO_DISPATCH_RETURN_EXISTS');
  ensure(evidence.sessionStarted <= timestamp(related[0].at) && timestamp(related[0].at) <= evidence.balanceChecked
    && evidence.balanceChecked <= timestamp(related[1].at) && timestamp(related[1].at) <= evidence.completed, 'ZERO_DISPATCH_TIME');
  return { originalAttemptId, blockedRepairAttemptId: dispatch.attemptId, originalRawSha256: sha(origin.raw),
    originalInputHash: input.packet.originalInputHash, repairInputHash: input.inputHash,
    blockedFiles: { dispatch: sha(dispatchRaw), packet: sha(packetRaw), instruction: sha(instructionRaw) },
    eventPrefix: prefix, eventPrefixSha256: sha(prefix) };
}

/** Trusted coordinator audit only; never writes or invokes a model. */
export async function inspectZeroDispatchAuthorization({ task, descriptor, origin, input, originalAttemptId, audit }) {
  ensure(object(audit), 'ZERO_DISPATCH_TRUSTED_AUDIT_REQUIRED');
  const witnessRaw = await file(audit.witnessPath);
  ensure(sha(witnessRaw) === audit.witnessSHA256, 'ZERO_DISPATCH_WITNESS_HASH');
  const witness = json(witnessRaw);
  ensure(Array.isArray(witness.files) && witness.files.length === 7, 'ZERO_DISPATCH_EVIDENCE_COVERAGE');
  const snapshots = await Promise.all(witness.files.map(async f => ({ path: f.path, base64: (await file(f.path)).toString('base64') })));
  const wireStat = await lstat(witness.wireDirectory); ensure(wireStat.isDirectory() && !wireStat.isSymbolicLink(), 'ZERO_DISPATCH_WIRE_PATH');
  const wireEntries = await readdir(witness.wireDirectory);
  const evidence = validateEvidence(witnessRaw, audit, snapshots, wireEntries, task, descriptor, originalAttemptId);
  const binding = await blockedAttempt({ task, descriptor, origin, input, originalAttemptId, evidence });
  return { schemaVersion: ZERO_DISPATCH_VERSION, audit: structuredClone(audit), witnessBase64: witnessRaw.toString('base64'), snapshots,
    wireEntries, caseId: task.caseId, requestHash: task.requestHash, stageId: descriptor.id, ...binding };
}

export async function saveZeroDispatchAuthorization(dir, authorization) {
  await writeFile(join(dir, 'authorization.json'), `${JSON.stringify(authorization, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

/** Replays archived byte snapshots, never trusts a caller-supplied completed check. */
export async function replayZeroDispatchAuthorization({ dir, task, descriptor, origin, input, originalAttemptId }) {
  const bytes = await file(join(dir, 'authorization.json')), saved = json(bytes);
  ensure(saved.schemaVersion === ZERO_DISPATCH_VERSION && saved.caseId === task.caseId && saved.requestHash === task.requestHash && saved.stageId === descriptor.id, 'ZERO_DISPATCH_AUTHORIZATION_BINDING');
  const evidence = validateEvidence(Buffer.from(saved.witnessBase64, 'base64'), saved.audit, saved.snapshots, saved.wireEntries, task, descriptor, originalAttemptId);
  const binding = await blockedAttempt({ task, descriptor, origin, input, originalAttemptId, evidence, eventPrefix: saved.eventPrefix });
  for (const key of Object.keys(binding)) ensure(equal(saved[key], binding[key]), 'ZERO_DISPATCH_AUTHORIZATION_BINDING');
  return { schemaVersion: ZERO_DISPATCH_VERSION, authorizationSha256: sha(bytes), witnessSHA256: saved.audit.witnessSHA256,
    blockedRepairAttemptId: saved.blockedRepairAttemptId };
}

export function zeroDispatchSummary(authorization) {
  return { eligible: true, schemaVersion: ZERO_DISPATCH_VERSION, requestHash: authorization.requestHash, stageId: authorization.stageId,
    reviewTaskId: authorization.audit.reviewTaskId, witnessSHA256: authorization.audit.witnessSHA256,
    originalAttemptId: authorization.originalAttemptId, blockedRepairAttemptId: authorization.blockedRepairAttemptId,
    repairInputHash: authorization.repairInputHash, originalRawSha256: authorization.originalRawSha256,
    providerCalls: 0, automaticAdoption: false };
}
