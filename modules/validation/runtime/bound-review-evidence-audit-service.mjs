import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readdir, readFile, writeFile, rename, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify, isDeepStrictEqual as equal } from 'node:util';
import path from 'node:path';

export const BOUND_PRODUCT_AUDIT_VERSION = 'bound-review-evidence-audit-product-1';
export const BOUND_PRODUCT_AUDIT_POLICY = 'fact-premise-decomposition-and-two-axes-3';
export const BOUND_PRODUCT_MEMO_LIMIT = 128;
const BOUND_VERSION = 'review-evidence-audit-claim-bound-3';
const exec = promisify(execFile);
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = text => createHash('sha256').update(text).digest('hex');
const digest = value => sha(bytes(value));
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object'
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const canonicalDigest = v => sha(JSON.stringify(canonical(v)));
const stamp = () => new Date().toISOString();
const idOK = value => typeof value === 'string' && /^[\w-]{1,160}$/.test(value);
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const errorOf = error => ({ code: error?.code ?? 'BOUND_PRODUCT_STOPPED', message: String(error?.message ?? error), JSONPointer: error?.JSONPointer ?? null });
const fail = (code, message = code, status = 409) => Object.assign(new Error(message), { code, status });
const ensure = (condition, code, status) => { if (!condition) throw fail(code, code, status); };
const invariants = Object.freeze({ automaticAdoption: false, literaryPass: 'NOT_COMPUTED', semanticAccuracyProven: false, originalReviewUnchanged: true });
const flags = decoded => ({ eventGroundingPassed: decoded.eventGates.every(g => !g.needsReview),
  premiseCoveragePassed: decoded.premiseCoverageGates.every(g => !g.needsReview) });

/** Metadata-only: do not open iCloud placeholders or follow file symlinks. */
export async function boundAuditFileState(file) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return { available: false, reason: 'not_file' };
    if (process.platform === 'darwin') {
      const { stdout } = await exec('/usr/bin/stat', ['-f', '%f', file]);
      if (Number(stdout.trim()) & 0x40000000) return { available: false, reason: 'dataless' };
    }
    return { available: true };
  } catch (error) { if (error.code === 'ENOENT') return { available: false, reason: 'missing' }; throw error; }
}

/** Only server-owned dependencies are injected. This module never creates a provider or HTTP server. */
export class BoundReviewEvidenceAuditService {
  constructor({ rootDir, reviews, adapter, boundAdapter, model, fileState = boundAuditFileState, maxTargetsPerBatch = 2, runtimeDir = null }) {
    ensure(typeof rootDir === 'string' && path.isAbsolute(rootDir), 'BOUND_PRODUCT_ROOT');
    ensure(Number.isInteger(maxTargetsPerBatch) && maxTargetsPerBatch >= 1 && maxTargetsPerBatch <= 2, 'BOUND_PRODUCT_BATCH_LIMIT');
    ensure(runtimeDir === null || (typeof runtimeDir === 'string' && path.isAbsolute(runtimeDir)), 'BOUND_PRODUCT_RUNTIME_PATH');
    Object.assign(this, { rootDir: path.resolve(rootDir), reviews, adapter, boundAdapter, model, fileState, maxTargetsPerBatch, runtimeDir });
    this.jobs = new Map(); this.controllers = new Map(); this.mutations = Promise.resolve(); this.execution = Promise.resolve();
    this.closed = false; this.initialized = false;
    this.strictMemo = new Map();
  }
  available() {
    return typeof this.reviews?.evidenceAuditSource === 'function' && typeof this.adapter?.prepareReviewEvidenceAudit === 'function'
      && this.boundAdapter?.BOUND_AUDIT_VERSION === BOUND_VERSION
      && ['prepareBoundReviewEvidenceAudit', 'decodeBoundAuditBatch', 'assembleBoundReviewEvidenceAudit'].every(k => typeof this.boundAdapter?.[k] === 'function')
      && typeof this.model?.complete === 'function';
  }
  versions() { return { service: BOUND_PRODUCT_AUDIT_VERSION, bound: BOUND_VERSION, canonicalPolicy: BOUND_PRODUCT_AUDIT_POLICY,
    eventGrounding: true, premiseCoverage: true, maxTargetsPerBatch: this.maxTargetsPerBatch }; }
  idFor(sourceId) { ensure(idOK(sourceId), 'BOUND_PRODUCT_SOURCE_ID', 400); return digest({ version: BOUND_PRODUCT_AUDIT_VERSION, sourceReviewTaskId: sourceId }); }
  run(id) { ensure(shaOK(id), 'BOUND_PRODUCT_ID', 400); return path.join(this.rootDir, 'runs', id); }
  recordPath(id) { this.run(id); return path.join(this.rootDir, 'records', `${id}.json`); }
  async directory(folder, create = false) {
    if (folder === path.dirname(folder)) return;
    await this.directory(path.dirname(folder), create);
    try { const s = await lstat(folder); ensure(s.isDirectory() && !s.isSymbolicLink(), 'BOUND_PRODUCT_DIRECTORY'); }
    catch (e) { if (e.code !== 'ENOENT' || !create) throw e; await mkdir(folder, { mode: 0o700 }); }
  }
  async text(file) {
    await this.directory(path.dirname(file));
    ensure((await this.fileState(file)).available, 'BOUND_PRODUCT_FILE_UNAVAILABLE');
    return readFile(file, 'utf8');
  }
  async json(file) { return JSON.parse(await this.text(file)); }
  async exists(file) { try { await lstat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
  async put(file, value, raw = false) {
    await this.directory(path.dirname(file));
    await writeFile(file, raw ? value : bytes(value), { flag: 'wx', mode: 0o600 });
  }
  async save(record) {
    const file = this.recordPath(record.id);
    ensure((await this.fileState(file)).available, 'BOUND_PRODUCT_FILE_UNAVAILABLE');
    const temp = `${file}.${randomUUID()}.tmp`;
    await this.put(temp, record); await rename(temp, file);
  }
  async init() {
    // Resolve a trusted host's /var or /tmp alias once; reject symlinks inside the owned root.
    await mkdir(path.dirname(this.rootDir), { recursive: true, mode: 0o700 });
    this.rootDir = path.join(await realpath(path.dirname(this.rootDir)), path.basename(this.rootDir));
    await this.directory(this.rootDir, true);
    const manifest = path.join(this.rootDir, 'namespace.json'), expected = { schemaVersion: BOUND_PRODUCT_AUDIT_VERSION, ...this.versions() };
    if (!await this.exists(manifest)) {
      ensure((await readdir(this.rootDir)).length === 0, 'BOUND_PRODUCT_ROOT_NOT_EMPTY');
      await this.put(manifest, expected);
    } else ensure(equal(await this.json(manifest), expected), 'BOUND_PRODUCT_NAMESPACE');
    for (const name of ['records', 'runs']) await this.directory(path.join(this.rootDir, name), true);
    this.initialized = true; return this;
  }
  async prepareSource(sourceId, canonicalOnly = false) {
    this.idFor(sourceId);
    ensure(this.initialized && typeof this.reviews?.evidenceAuditSource === 'function'
      && typeof this.adapter?.prepareReviewEvidenceAudit === 'function' && this.boundAdapter?.BOUND_AUDIT_VERSION === BOUND_VERSION, 'BOUND_PRODUCT_UNAVAILABLE', 503);
    const source = await this.reviews.evidenceAuditSource(sourceId);
    ensure(source?.sourceReviewTaskId === sourceId && idOK(source.projectId) && shaOK(source.sourceRequestHash)
      && typeof source.sourceRunDir === 'string' && path.isAbsolute(source.sourceRunDir), 'BOUND_PRODUCT_SOURCE_BINDING');
    const prepared = await this.adapter.prepareReviewEvidenceAudit({ ...source, auditPolicyVersion: BOUND_PRODUCT_AUDIT_POLICY });
    ensure(prepared.auditPolicyVersion === BOUND_PRODUCT_AUDIT_POLICY && prepared.binding?.sourceReviewTaskId === sourceId
      && prepared.binding.sourceRequestHash === source.sourceRequestHash && prepared.sourceSnapshot && shaOK(prepared.requestHash), 'BOUND_PRODUCT_CANONICAL_BINDING');
    const identity = { sourceReviewTaskId: sourceId, projectId: source.projectId, sourceRequestHash: source.sourceRequestHash };
    if (canonicalOnly) return { source: identity, prepared };
    const boundPrepared = this.boundAdapter.prepareBoundReviewEvidenceAudit({ prepared, maxTargetsPerBatch: this.maxTargetsPerBatch,
      enableEventGrounding: true, enablePremiseCoverage: true });
    ensure(boundPrepared.registration.scope === 'complete_audit' && boundPrepared.registration.scopeTargetIds === null
      && boundPrepared.eventPrepared && boundPrepared.coveragePrepared && boundPrepared.batches.length > 0, 'BOUND_PRODUCT_FULL_SCOPE');
    return { source: identity, boundPrepared };
  }
  async assertSource(input) {
    const current = await this.prepareSource(input.source.sourceReviewTaskId, true);
    ensure(equal(current.source, input.source) && equal(current.prepared, input.boundPrepared.compact.canonicalPrepared), 'BOUND_PRODUCT_SOURCE_CHANGED');
  }
  async memoIdentity(p) {
    if (!this.runtimeDir) return null; // Safe compatibility fallback, with no memoization.
    const hashes = {};
    for (const name of ['review-evidence-audit-bound-v3.mjs', 'review-evidence-audit-compact.mjs',
      'review-evidence-audit-event-grounding-v2.mjs', 'review-evidence-audit-premise-coverage.mjs'])
      hashes[name] = sha(await this.text(path.join(this.runtimeDir, name)));
    const v = p.registration.versions;
    ensure(hashes['review-evidence-audit-bound-v3.mjs'] === v.sourceSHA256
      && hashes['review-evidence-audit-event-grounding-v2.mjs'] === v.eventGrounding.toolVersion
      && hashes['review-evidence-audit-premise-coverage.mjs'] === v.premiseCoverage.toolVersion
      && canonicalDigest({ sourceSha256: hashes['review-evidence-audit-compact.mjs'],
        canonicalValidator: p.compact.canonicalPrepared.versions }) === v.predecessor.toolVersion, 'BOUND_PRODUCT_CODE_CHANGED');
    // Canonical dependency hashes were just re-read by assertSource/prepareSource. No TTL or disk-derived cache.
    return digest({ prepared: digest(p), code: hashes });
  }
  memo(key, calculate) {
    if (key && this.strictMemo.has(key)) {
      const value = this.strictMemo.get(key);
      if (value.error) throw Object.assign(new Error(value.error.message), value.error);
      return structuredClone(value.result);
    }
    try {
      const result = calculate();
      if (key) this.remember(key, { result: structuredClone(result) });
      return result;
    } catch (error) {
      if (key) this.remember(key, { error: errorOf(error) });
      throw error;
    }
  }
  remember(key, value) {
    if (!this.strictMemo.has(key) && this.strictMemo.size >= BOUND_PRODUCT_MEMO_LIMIT)
      this.strictMemo.delete(this.strictMemo.keys().next().value);
    this.strictMemo.set(key, value);
  }
  decode(boundPrepared, batchId, rawResponse, identity) {
    return this.memo(identity && digest({ identity, batchId, raw: sha(rawResponse) }),
      () => this.boundAdapter.decodeBoundAuditBatch({ boundPrepared, batchId, rawResponse }));
  }
  assemble(boundPrepared, responses, identity) {
    return this.memo(identity && digest({ identity, responses: responses.map(r => [r.batchId, sha(r.rawResponse)]) }),
      () => this.boundAdapter.assembleBoundReviewEvidenceAudit({ boundPrepared, responses }));
  }
  modelRequest(batch) {
    return { stage: 'independent-review:semantic-evidence-audit', modelPolicy: 'semantic-evidence-audit-json-1',
      system: batch.instruction, user: JSON.stringify({ packet: batch.packet, responseSchema: batch.responseSchema }),
      responseSchema: structuredClone(batch.responseSchema), maxTokens: 24000, allowRecovery: false };
  }
  async preflight(sourceId) {
    const { source, boundPrepared: p } = await this.prepareSource(sourceId);
    await this.memoIdentity(p);
    return { ready: true, source, versions: this.versions(), registrationHash: p.registrationHash,
      targetCount: p.compact.canonicalPrepared.packet.targets.length, batchCount: p.batches.length,
      replayMemo: this.runtimeDir ? 'exact_bytes_and_verified_code_hashes' : 'disabled_runtimeDir_not_supplied',
      batches: p.batches.map(b => ({ batchId: b.batchId, batchHash: b.batchHash, targetIds: b.packet.targets.map(t => t.targetId),
        inputCharacters: this.modelRequest(b).system.length + this.modelRequest(b).user.length })), ...invariants };
  }
  start(sourceId, input) {
    const job = this.mutations.then(() => this.submit(sourceId, input));
    this.mutations = job.catch(() => {}); return job;
  }
  async submit(sourceId, input) {
    ensure(input && !Array.isArray(input) && Object.keys(input).length === 1 && idOK(input.requestId), 'BOUND_PRODUCT_INPUT_FIELDS', 400);
    ensure(!this.closed && this.available(), 'BOUND_PRODUCT_UNAVAILABLE', 503);
    const id = this.idFor(sourceId);
    if (await this.exists(this.recordPath(id))) return this.read(id); // New requestId is not permission to retry.
    const frozen = await this.prepareSource(sourceId), dir = this.run(id);
    // Exclusive directory survives a crash before registration: never silently replace or redispatch it.
    await mkdir(dir, { mode: 0o700 });
    const saved = { schemaVersion: BOUND_PRODUCT_AUDIT_VERSION, id, requestId: input.requestId, createdAt: stamp(), ...frozen };
    await this.put(path.join(dir, 'input.json'), saved);
    const record = { schemaVersion: BOUND_PRODUCT_AUDIT_VERSION, id, ...saved.source, requestId: input.requestId,
      createdAt: saved.createdAt, updatedAt: saved.createdAt, inputSHA256: digest(saved), status: 'queued', error: null };
    await this.put(this.recordPath(id), record);
    const controller = new AbortController(); this.controllers.set(id, controller);
    const job = this.execution.then(() => this.process(record, saved, controller));
    this.execution = job.catch(() => {}); this.jobs.set(id, job);
    void job.finally(() => { this.jobs.delete(id); this.controllers.delete(id); }).catch(() => {});
    return { ...record, report: null, completeEvidenceReview: false, ...invariants };
  }
  async frozen(record) {
    ensure(record.schemaVersion === BOUND_PRODUCT_AUDIT_VERSION && record.id === this.idFor(record.sourceReviewTaskId), 'BOUND_PRODUCT_RECORD_BINDING');
    const text = await this.text(path.join(this.run(record.id), 'input.json'));
    ensure(sha(text) === record.inputSHA256, 'BOUND_PRODUCT_INPUT_HASH');
    const input = JSON.parse(text);
    ensure(input.id === record.id && input.requestId === record.requestId && input.createdAt === record.createdAt
      && input.schemaVersion === BOUND_PRODUCT_AUDIT_VERSION && input.source.sourceReviewTaskId === record.sourceReviewTaskId
      && input.source.projectId === record.projectId && input.source.sourceRequestHash === record.sourceRequestHash, 'BOUND_PRODUCT_RECORD_BINDING');
    await this.assertSource(input); return input;
  }
  async fileHashes(folder, except = []) {
    const out = {};
    for (const name of (await readdir(folder)).sort()) {
      if (except.includes(name)) continue;
      out[name] = sha(await this.text(path.join(folder, name)));
    }
    return out;
  }
  async batch(record, input, batch, signal, usedContexts, usedInvocations) {
    await this.assertSource(input);
    const memoIdentity = await this.memoIdentity(input.boundPrepared);
    ensure(!signal.aborted && !await this.exists(path.join(this.run(record.id), 'cancel.json')), 'BOUND_PRODUCT_CANCELLED');
    const dir = path.join(this.run(record.id), batch.batchId); await mkdir(dir, { mode: 0o700 });
    const request = this.modelRequest(batch);
    await this.put(path.join(dir, 'dispatch.json'), { batchId: batch.batchId, batchHash: batch.batchHash,
      inputSHA256: record.inputSHA256, requestSHA256: digest(request), request, at: stamp() });
    let receipt, raw, decoded, failure = null, transportOK = false, callbackIndex = 0;
    let callbackTail = Promise.resolve(); const callbacks = [];
    const event = (kind, value) => {
      const n = ++callbackIndex;
      const work = callbackTail.then(() => this.put(path.join(dir, `event-${String(n).padStart(4, '0')}.json`), { kind, value }));
      void work.catch(() => {}); // Observed again below even if an adapter neglects to await the callback.
      callbackTail = work; callbacks.push(work); return work;
    };
    try {
      raw = await this.model.complete({ ...request, signal,
        onAttempt: attempt => event('attempt', structuredClone(attempt)),
        onReceipt: value => { receipt = structuredClone(value); return event('receipt', receipt); } });
      await Promise.all(callbacks);
      ensure(typeof raw === 'string' && raw.trim().length > 0, 'BOUND_PRODUCT_RESPONSE_MISSING');
      await this.put(path.join(dir, 'raw-response.txt'), raw, true);
      ensure(receipt && ['provider', 'contextId', 'invocationId'].every(k => typeof receipt[k] === 'string' && receipt[k].length > 0), 'BOUND_PRODUCT_RECEIPT_MISSING');
      await this.put(path.join(dir, 'receipt.json'), receipt);
      ensure(!usedContexts.has(receipt.contextId) && !usedInvocations.has(receipt.invocationId), 'BOUND_PRODUCT_CONTEXT_REUSED');
      usedContexts.add(receipt.contextId); usedInvocations.add(receipt.invocationId);
      await this.assertSource(input);
      ensure(!signal.aborted && !await this.exists(path.join(this.run(record.id), 'cancel.json')), 'BOUND_PRODUCT_CANCELLED');
      transportOK = true;
      decoded = this.decode(input.boundPrepared, batch.batchId, raw, memoIdentity);
      await this.put(path.join(dir, 'decoded.json'), { representation: 'derived_from_provider_raw', decoded });
    } catch (error) {
      await Promise.allSettled(callbacks);
      // A provider may attach a partial body/receipt on failure. Preserve, never decode it as a completed response.
      if (typeof error.rawResponse === 'string' && !await this.exists(path.join(dir, 'raw-response.txt')))
        await this.put(path.join(dir, 'raw-response.txt'), error.rawResponse, true);
      if (!await this.exists(path.join(dir, 'receipt.json')) && (receipt ?? error.receipt)) await this.put(path.join(dir, 'receipt.json'), receipt ?? error.receipt);
      failure = errorOf(error); await this.put(path.join(dir, 'failure.json'), failure);
    }
    const seal = { schemaVersion: `${BOUND_PRODUCT_AUDIT_VERSION}-batch`, batchId: batch.batchId, batchHash: batch.batchHash,
      inputSHA256: record.inputSHA256, transportOK, decoded: Boolean(decoded), error: failure,
      ...(decoded ? flags(decoded) : { eventGroundingPassed: false, premiseCoveragePassed: false }),
      files: await this.fileHashes(dir), at: stamp() };
    await this.put(path.join(dir, 'seal.json'), seal);
    return { seal, raw, decoded };
  }
  async process(record, input, controller) {
    const dir = this.run(record.id), responses = [], batchSeals = {}, contexts = new Set(input.boundPrepared.compact.canonicalPrepared.binding.sourceContextIds),
      invocations = new Set(input.boundPrepared.compact.canonicalPrepared.binding.sourceInvocationIds);
    let error = null, assembled = null;
    try {
      await this.put(path.join(dir, 'execution-started.json'), { inputSHA256: record.inputSHA256, at: stamp() });
      record.status = 'running'; record.updatedAt = stamp(); await this.save(record);
      for (const batch of input.boundPrepared.batches) {
        ensure(!controller.signal.aborted, 'BOUND_PRODUCT_CANCELLED');
        const outcome = await this.batch(record, input, batch, controller.signal, contexts, invocations);
        batchSeals[batch.batchId] = digest(outcome.seal);
        if (outcome.decoded) responses.push({ batchId: batch.batchId, rawResponse: outcome.raw });
        if (outcome.seal.error) error ??= outcome.seal.error;
        if (!outcome.seal.transportOK) break;
      }
      await this.assertSource(input);
      if (responses.length === input.boundPrepared.batches.length) {
        assembled = this.assemble(input.boundPrepared, responses, await this.memoIdentity(input.boundPrepared));
        await this.put(path.join(dir, 'assembled.json'), { representation: 'derived_from_provider_raw_batches', assembled });
        if (!assembled.completeEvidenceReview) error ??= errorOf(fail('BOUND_PRODUCT_GATES_NEED_REVIEW'));
      }
    } catch (e) { error ??= errorOf(e); }
    const status = controller.signal.aborted || await this.exists(path.join(dir, 'cancel.json')) ? 'cancelled'
      : !error && assembled?.completeEvidenceReview === true ? 'complete' : 'needs_attention';
    const result = { schemaVersion: `${BOUND_PRODUCT_AUDIT_VERSION}-result`, inputSHA256: record.inputSHA256,
      status, error, batchSeals, assembledSHA256: assembled ? digest({ representation: 'derived_from_provider_raw_batches', assembled }) : null,
      completeEvidenceReview: status === 'complete', ...invariants };
    // Terminal evidence is immutable. The mutable record is only an index, never proof of success.
    await this.put(path.join(dir, 'result.json'), result);
    record.status = status; record.error = error; record.updatedAt = stamp(); await this.save(record);
  }
  async replay(record, input) {
    const dir = this.run(record.id), terminal = await this.exists(path.join(dir, 'result.json')) ? await this.json(path.join(dir, 'result.json')) : null;
    const memoIdentity = await this.memoIdentity(input.boundPrepared);
    const responses = [], batches = [], seals = {}, contexts = new Set(input.boundPrepared.compact.canonicalPrepared.binding.sourceContextIds),
      invocations = new Set(input.boundPrepared.compact.canonicalPrepared.binding.sourceInvocationIds);
    for (const batch of input.boundPrepared.batches) {
      const folder = path.join(dir, batch.batchId), sealFile = path.join(folder, 'seal.json');
      if (!await this.exists(sealFile)) { batches.push({ batchId: batch.batchId, status: await this.exists(folder) ? 'unsealed' : 'not_dispatched' }); continue; }
      const sealText = await this.text(sealFile), seal = JSON.parse(sealText); seals[batch.batchId] = sha(sealText);
      ensure(seal.inputSHA256 === record.inputSHA256 && seal.batchId === batch.batchId && seal.batchHash === batch.batchHash
        && equal(await this.fileHashes(folder, ['seal.json']), seal.files), 'BOUND_PRODUCT_BATCH_SEAL');
      const dispatch = await this.json(path.join(folder, 'dispatch.json')), expected = this.modelRequest(batch);
      ensure(dispatch.batchId === batch.batchId && dispatch.batchHash === batch.batchHash && dispatch.inputSHA256 === record.inputSHA256
        && equal(dispatch.request, expected) && dispatch.requestSHA256 === digest(expected), 'BOUND_PRODUCT_DISPATCH_BINDING');
      let decoded = null, decodeError = null;
      if (seal.transportOK) {
        const receipt = await this.json(path.join(folder, 'receipt.json'));
        ensure(['provider', 'contextId', 'invocationId'].every(k => typeof receipt[k] === 'string' && receipt[k].length > 0)
          && !contexts.has(receipt.contextId) && !invocations.has(receipt.invocationId), 'BOUND_PRODUCT_CONTEXT_REUSED');
        contexts.add(receipt.contextId); invocations.add(receipt.invocationId);
        const raw = await this.text(path.join(folder, 'raw-response.txt'));
        try { decoded = this.decode(input.boundPrepared, batch.batchId, raw, memoIdentity); }
        catch (e) { decodeError = errorOf(e); }
        if (decoded) {
          ensure(seal.decoded && equal(await this.json(path.join(folder, 'decoded.json')), { representation: 'derived_from_provider_raw', decoded })
            && equal(flags(decoded), { eventGroundingPassed: seal.eventGroundingPassed, premiseCoveragePassed: seal.premiseCoveragePassed }), 'BOUND_PRODUCT_DERIVED_BINDING');
          responses.push({ batchId: batch.batchId, rawResponse: raw });
        } else ensure(!seal.decoded && equal(decodeError, seal.error), 'BOUND_PRODUCT_FAILURE_REPLAY');
      }
      if (seal.error) ensure(equal(await this.json(path.join(folder, 'failure.json')), seal.error), 'BOUND_PRODUCT_FAILURE_BINDING');
      batches.push({ batchId: batch.batchId, status: decoded ? (Object.values(flags(decoded)).every(Boolean) ? 'validated' : 'needs_attention') : 'needs_attention',
        error: seal.error, decoded, rawResponseSHA256: seal.files['raw-response.txt'] ?? null });
    }
    let assembled = null;
    if (responses.length === input.boundPrepared.batches.length) assembled = this.assemble(input.boundPrepared, responses, memoIdentity);
    if (terminal) {
      ensure(terminal.inputSHA256 === record.inputSHA256 && equal(terminal.batchSeals, seals)
        && ['complete', 'needs_attention', 'cancelled'].includes(terminal.status), 'BOUND_PRODUCT_TERMINAL_BINDING');
      if (terminal.assembledSHA256) {
        const text = await this.text(path.join(dir, 'assembled.json'));
        ensure(sha(text) === terminal.assembledSHA256 && equal(JSON.parse(text), { representation: 'derived_from_provider_raw_batches', assembled }), 'BOUND_PRODUCT_ASSEMBLED_BINDING');
      }
      ensure(terminal.status !== 'complete' || (assembled?.completeEvidenceReview === true && terminal.assembledSHA256 && !terminal.error), 'BOUND_PRODUCT_FALSE_COMPLETE');
    }
    const view = { status: terminal?.status ?? (this.jobs.has(record.id) ? record.status : 'interrupted'), error: terminal?.error ??
      (!terminal && !this.jobs.has(record.id) ? errorOf(fail('BOUND_PRODUCT_INTERRUPTED_NO_RETRY')) : null), batches,
      completeEvidenceReview: terminal?.status === 'complete' && assembled?.completeEvidenceReview === true,
      report: terminal?.assembledSHA256 ? { representation: 'derived_from_provider_raw_batches', assembled } : null };
    const proof = terminal?.assembledSHA256 && ['complete', 'needs_attention'].includes(terminal.status)
      ? this.proof(input, responses, assembled) : null;
    return { view, proof };
  }
  proof(input, responses, assembled) {
    const boundPrepared = structuredClone(input.boundPrepared), exactResponses = structuredClone(responses), savedAssembly = structuredClone(assembled);
    return { boundPrepared: structuredClone(boundPrepared), responses: structuredClone(exactResponses), savedAssembly: structuredClone(savedAssembly),
      assembleBound: ({ boundPrepared: providedPrepared, responses: providedResponses }) => {
        ensure(equal(providedPrepared, boundPrepared) && equal(providedResponses, exactResponses), 'BOUND_PRODUCT_PROOF_CHANGED');
        return structuredClone(savedAssembly);
      } };
  }
  /** One GET operation: source and sealed bytes are checked once, proof never goes to HTTP. */
  async readWithProof(id) {
    const record = await this.json(this.recordPath(id));
    ensure(record.id === id, 'BOUND_PRODUCT_RECORD_BINDING');
    const view = { id, sourceReviewTaskId: record.sourceReviewTaskId, projectId: record.projectId,
      requestId: record.requestId, status: record.status, createdAt: record.createdAt, report: null, batches: [], sourceVerified: false, completeEvidenceReview: false, ...invariants };
    try {
      const input = await this.frozen(record), replay = await this.replay(record, input);
      await this.assertSource(input); // Fail closed if source changes while replay is in progress.
      Object.assign(view, replay.view, { sourceVerified: true }); return { view, proof: replay.proof };
    } catch (error) { view.status = 'needs_attention'; view.error = errorOf(error); return { view, proof: null }; }
  }
  async read(id) { return (await this.readWithProof(id)).view; }
  /** SERVER ONLY. Never serialize this proof into an HTTP response or accept one from a browser. */
  async readProof(id) {
    const { proof } = await this.readWithProof(id); ensure(proof, 'BOUND_PRODUCT_PROOF_INCOMPLETE'); return proof;
  }
  async listWithProof(sourceId) {
    const id = this.idFor(sourceId), entries = await this.exists(this.recordPath(id)) ? [await this.readWithProof(id)] : [];
    let eligible = false, error = null;
    // Existing record eligibility was checked by readWithProof; no second prepare/replay for a single list GET.
    if (entries.length) eligible = entries[0].view.sourceVerified;
    else try { await this.prepareSource(sourceId, true); eligible = true; } catch (e) { error = errorOf(e); }
    const view = { namespace: BOUND_PRODUCT_AUDIT_VERSION, available: this.available() && !this.closed, eligible,
      canStart: eligible && !this.closed && this.available() && entries.length === 0, versions: this.versions(), error, tasks: entries.map(e => e.view) };
    return { view, entries };
  }
  async list(sourceId) { return (await this.listWithProof(sourceId)).view; }
  async cancel(id) {
    const record = await this.json(this.recordPath(id)), dir = this.run(id);
    if (!await this.exists(path.join(dir, 'result.json'))) {
      if (!await this.exists(path.join(dir, 'cancel.json'))) await this.put(path.join(dir, 'cancel.json'), { id, at: stamp(), reason: 'explicit_cancellation' });
      this.controllers.get(id)?.abort(fail('BOUND_PRODUCT_CANCELLED'));
    }
    return this.read(record.id);
  }
  async drain() { await this.mutations; await Promise.allSettled([...this.jobs.values()]); }
  async close() {
    this.closed = true; await this.mutations;
    await Promise.all([...this.controllers.keys()].map(id => this.cancel(id)));
    await this.drain();
  }
}
