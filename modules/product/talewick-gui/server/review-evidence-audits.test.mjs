import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile, readdir, cp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { IndependentReviewService } from './independent-review-service.mjs';
import { ReviewEvidenceAuditService, createReviewEvidenceAuditRouter, PRODUCT_EVIDENCE_AUDIT_FORMAT_NORMALIZATION_VERSION as formatVersion, PRODUCT_EVIDENCE_AUDIT_POLICY_VERSION as policyVersion } from './review-evidence-audits.mjs';
import { createIndependentReviewEvidenceAuditAnalyze } from './independent-review-analyze.mjs';
import { productManuscriptRevision } from './full15-service.mjs';
import * as review from '../../../validation/runtime/independent-review-task.mjs';
import * as focus from '../../../validation/runtime/focused-whole-quality-evaluation.mjs';
import * as audit from '../../../validation/runtime/review-evidence-audit.mjs';

const out = fileURLToPath(new URL('../../../../../product/', import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
const legacyPolicy = 'original-citation-and-whole-text-1';
const v2Policy = 'fact-subclaims-and-two-axes-2';
const premiseDimensions = ['identity_relationship', 'speaker_actor', 'intent_completion', 'transfer_direction', 'event_round'];
const chapters = [
  { id: 'ch-1', title: '未签的单据', body: '下午三点，她在门口下车。\r\n\r\n她说：“钱已经付清。”\n\n我没有看到转账记录。\n\n😀纸边被雨打湿。' },
  { id: 'ch-2', title: '留下', body: '天亮后，她拒绝签字，把工牌放在桌上。\n\n经理把延期三个月写进第二栏。\n\n她推开门走进雨里。' },
];
const goal = { id: 'g1', statement: '相对原稿增加选择代价。', claimType: 'editorial_hypothesis',
  sourceEvidence: [{ chapterId: 'ch-2', quote: '天亮后，她拒绝签字，把工牌放在桌上。', start: 0 }],
  counterCase: [{ chapterId: 'ch-1', quote: '下午三点，她在门口下车。', start: 0 }], expectedEffect: '新增后果。', failureCriterion: '全文没有变化。',
  requiredOutcomes: [{ id: 'o1', dimension: 'action', description: '新增可见后果。' }] };
const until = async fn => { for (let n = 0; n < 2000; n++) { if (await fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error('local integration timeout'); };
async function hashes(folder, prefix = '') {
  const map = {};
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name), name = prefix + entry.name;
    if (entry.isDirectory()) Object.assign(map, await hashes(file, name + '/'));
    else map[name] = sha(await readFile(file));
  }
  return map;
}
function response(packet) {
  return { schemaVersion: 'review-evidence-audit-3-response', requestHash: packet.requestHash,
    assessments: packet.targets.map(t => ({ targetId: t.targetId, targetSHA: t.targetSHA,
      premiseChecks: t.claimSources.map((source, index) => ({ JSONPointer: source.JSONPointer,
        dimensions: Object.fromEntries(premiseDimensions.map(dimension => [dimension, {
          disposition: dimension === 'speaker_actor' ? (index ? 'unresolved' : 'identified') : 'not_applicable',
          factIds: dimension === 'speaker_actor' && !index ? ['F1'] : [], reason: '离线结构样例，不认证事实。',
        }])) })),
      factCoverage: t.claimSources.map((source, index) => ({ JSONPointer: source.JSONPointer,
        disposition: index ? 'unresolved' : 'fact_checks', factIds: index ? [] : ['F1'], reason: '离线协议样例，不代表真实语义判断。' })),
      factChecks: t.claimSources.slice(0, 1).map(source => ({ factId: 'F1', claim: { JSONPointer: source.JSONPointer, quote: source.text, start: 0 },
        dimensions: ['speaker_actor'], status: 'uncertain', basis: 'undetermined', reason: '只验证原意见逐字定位。',
        supportedScope: null, limits: '合成响应未进行实际语义核对。', evidence: [], counterEvidence: [] })),
      factDependencies: { originalCitationSupport: [], wholeTextCheck: t.claimSources.length ? ['F1'] : [] },
      originalCitationSupport: { status: 'uncertain', reason: '离线响应仅测试协议。', supportedScope: null, limits: '不代替真实语义审阅。',
        citationChecks: t.originalCitations.map(c => ({ citationId: c.citationId, status: 'uncertain', basis: 'editorial_interpretation', reason: '保留不确定性。' })) },
      wholeTextCheck: { status: 'uncertain', reason: '只验证逐字定位和完整保存。', supportedScope: null, limits: '这些不是实际模型判断。',
        evidence: [{ anchorId: packet.manuscripts.find(m => m.blindId === t.allowedBlindIds[0]).chapters[0].paragraphs.find(p => p.citable).anchorId,
          basis: 'narrated_action', explanation: '仅定位原文，不声称它支持原意见。' }], counterEvidence: [], mechanicalFactsUsed: [] } })) };
}

test('real local HTTP → server-selected v3 + normalization → strict replay/restart/migration; originals unchanged', { timeout: 120000 }, async t => {
  await mkdir(path.join(out, 'test-runs'), { recursive: true });
  const root = await mkdtemp(path.join(out, 'test-runs/audit-http-'));
  let reviewCalls = 0, auditCalls = 0;
  const reviews = await new IndependentReviewService({ rootDir: path.join(root, 'independent-reviews'), adapter: review, readingFocus: focus,
    prepareRequest: async input => ({ request: { caseId: input.caseId, mode: 'compare', baselineChapters: input.chapters,
      candidate: { mode: 'no_change', chapters: input.chapters }, goals: [goal] } }),
    analyze: async args => { reviewCalls++; return { outputText: JSON.stringify(args.packet.responseContract.example),
      receipt: { provider: 'offline', invocationId: `blind-${reviewCalls}`, contextId: `blind-${reviewCalls}`, inputHash: args.inputHash } }; },
  }).init();
  t.after(() => reviews.close());
  const created = await reviews.start({ projectId: 'audit-source-local', requestId: 'audit-source-r1', caseId: 'audit-source-local-case',
    mode: 'compare', sourceTaskId: 'whole-source-local', title: '单据', chapters, manuscriptRevision: productManuscriptRevision('单据', chapters),
    readingFocusVersion: focus.READING_FOCUS_VERSION, modelCitationMode: 'paragraph_refs_v1' });
  await until(() => !reviews.busy && reviews.get(created.id).status !== 'queued');
  assert.equal(reviews.get(created.id).status, 'complete', JSON.stringify(reviews.get(created.id).error)); assert.equal(reviewCalls, 7);
  const sourceBefore = await hashes(reviews.rootDir), auditRoot = path.join(root, 'review-evidence-audits');
  let modelRaw;
  const model = { complete: async options => {
    auditCalls++; assert.equal(options.allowRecovery, false); assert.equal(options.stage, 'independent-review:semantic-evidence-audit');
    await options.onAttempt({ stage: options.stage, attempt: 1, requestedModel: 'synthetic-pro' });
    await options.onReceipt({ provider: 'offline', invocationId: `audit-${auditCalls}`, contextId: `audit-${auditCalls}` });
    const packet = JSON.parse(options.user).packet;
    assert.equal(packet.formatNormalizationVersion, formatVersion);
    assert.equal(packet.auditPolicyVersion, policyVersion);
    const value = response(packet);
    for (const row of value.assessments) for (const check of row.originalCitationSupport.citationChecks) {
      check.explanation = check.reason; delete check.reason;
    }
    return modelRaw = JSON.stringify(value);
  } };
  let service = await new ReviewEvidenceAuditService({ rootDir: auditRoot, reviews, adapter: audit,
    analyze: createIndependentReviewEvidenceAuditAnalyze({ model }) }).init();
  t.after(() => service.close());
  const send = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const router = createReviewEvidenceAuditRouter({ service, json: send, canRun: () => true, bodyJSON: async req => { let value = ''; for await (const chunk of req) value += chunk; return JSON.parse(value); } });
  const server = http.createServer(async (req, res) => { try { if (!await router(req, res, new URL(req.url, 'http://127.0.0.1'))) send(res, 404, {}); }
    catch (error) { send(res, error.status || 500, { error: error.message, code: error.code }); } });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/independent-reviews/${created.id}/evidence-audits`;
  const post = async body => { const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, body: await res.json() }; };
  let listed = await (await fetch(url)).json(); assert.equal(listed.eligible, true); assert.equal(listed.tasks.length, 0);
  assert.equal(listed.versions.policyVersion, policyVersion, 'GET advertises the policy used for a new online audit');
  for (const injected of [{ requestId: 'bad', sourceRunDir: root }, { requestId: 'bad', report: { passed: true } }, { requestId: 'bad', analyze: '{}' }, { requestId: 'bad', formatNormalizationVersion: formatVersion }, { requestId: 'bad', auditPolicyVersion: policyVersion }])
    assert.equal((await post(injected)).status, 400);
  assert.equal(auditCalls, 0);
  const accepted = await post({ requestId: 'audit-http-r1' }); assert.equal(accepted.status, 202); const id = accepted.body.task.id;
  await until(() => !service.jobs.size);
  listed = await (await fetch(url)).json(); const done = listed.tasks[0];
  assert.equal(done.status, 'complete', JSON.stringify(done.error)); assert.equal(auditCalls, 1);
  assert.equal(done.formatNormalizationVersion, formatVersion);
  assert.equal(done.auditPolicyVersion, policyVersion);
  assert.equal(done.report.representationStatus, 'recovered_from_format');
  assert.equal(done.report.formatNormalization.version, formatVersion); assert.ok(done.report.formatNormalization.mappedFields > 0);
  assert.equal(done.report.coverage.complete, true); assert.equal(done.targets.length, done.report.coverage.completed);
  for (const row of done.report.assessments) {
    const target = done.targets.find(t => t.targetId === row.targetId);
    assert.deepEqual(row.premiseChecks.map(c => c.JSONPointer), target.claimSources.map(s => s.JSONPointer));
    for (const check of row.premiseChecks) assert.deepEqual(Object.keys(check.dimensions), premiseDimensions);
  }
  for (const row of done.report.assessments) for (const fact of row.factChecks) {
    const target = done.targets.find(t => t.targetId === row.targetId), source = target.claimSources.find(s => s.JSONPointer === fact.claim.JSONPointer);
    assert.equal(source.text.slice(fact.claim.start, fact.claim.end), fact.claim.quote);
  }
  assert.equal(done.automaticAdoption, false); assert.equal(done.report.voteResult, null); assert.equal(done.literaryPass, 'NOT_COMPUTED');
  for (const item of done.report.assessments) for (const e of item.wholeTextCheck.evidence)
    assert.equal(chapters.find(c => c.id === e.chapterId).body.slice(e.start, e.end), e.quote);
  assert.equal((await post({ requestId: 'audit-http-r1' })).body.task.id, id);
  assert.equal((await post({ requestId: 'another-click-id' })).body.task.id, id); assert.equal(auditCalls, 1);
  assert.deepEqual(await hashes(reviews.rootDir), sourceBefore);
  const auditBefore = await hashes(auditRoot), saved = service.records.get(id);
  assert.equal(saved.formatNormalizationVersion, formatVersion);
  assert.equal(saved.auditPolicyVersion, policyVersion);
  assert.equal(saved.modelPolicy, 'semantic-evidence-audit-json-1');
  const frozenInput = JSON.parse(await readFile(path.join(auditRoot, 'prepared', `${id}.json`), 'utf8'));
  assert.equal(frozenInput.auditPolicyVersion, policyVersion); assert.equal(frozenInput.versions.policyVersion, policyVersion);
  assert.equal(frozenInput.formatNormalizationVersion, formatVersion);
  assert.equal(await readFile(path.join(auditRoot, saved.adapterRunDir, 'raw-response.txt'), 'utf8'), modelRaw);
  assert.equal(JSON.parse(await readFile(path.join(auditRoot, saved.adapterRunDir, 'input.json'), 'utf8')).formatNormalizationVersion, formatVersion);
  assert.equal(saved.modelAttempts.length, 1); assert.match(saved.adapterRunDir, /^runs\/review-evidence-audit-/);
  assert.equal(JSON.stringify(listed).includes(root), false, 'public view contains no local paths');
  await service.close();
  const movedRoot = path.join(root, 'migrated-review-evidence-audits'); await cp(auditRoot, movedRoot, { recursive: true });
  service = await new ReviewEvidenceAuditService({ rootDir: movedRoot, reviews, adapter: audit, analyze: () => { throw Error('redispatch forbidden'); } }).init();
  const migrated = await service.list(created.id); assert.deepEqual(migrated.tasks[0].report, done.report);
  assert.equal((await service.start(created.id, { requestId: 'after-migration' })).id, id);
  assert.deepEqual(await hashes(movedRoot), auditBefore); assert.deepEqual(await hashes(reviews.rootDir), sourceBefore);
  const proofPath = path.join(movedRoot, saved.adapterRunDir, 'format-normalization-proof.json');
  const proofRaw = await readFile(proofPath), changedProof = JSON.parse(proofRaw); changedProof.mappings[0].valueSha256 = '0'.repeat(64);
  await writeFile(proofPath, JSON.stringify(changedProof, null, 2) + '\n');
  const invalidProof = (await service.list(created.id)).tasks[0];
  assert.equal(invalidProof.status, 'needs_attention'); assert.equal(invalidProof.report, null);
  assert.equal((await service.start(created.id, { requestId: 'tamper-must-not-reroll' })).id, id);
  await writeFile(proofPath, proofRaw); assert.equal(auditCalls, 1);
  // Prepared or original-source changes fail closed without any new dispatch.
  const preparedPath = path.join(movedRoot, 'prepared', `${id}.json`), originalPrepared = await readFile(preparedPath);
  await writeFile(preparedPath, '{}'); assert.equal((await service.list(created.id)).tasks[0].status, 'needs_attention');
  assert.equal((await service.list(created.id)).tasks[0].report, null); await writeFile(preparedPath, originalPrepared);
  const originalSource = reviews.evidenceAuditSource.bind(reviews); reviews.evidenceAuditSource = async () => { throw Error('synthetic changed source binding'); };
  assert.equal((await service.list(created.id)).tasks[0].report, null); reviews.evidenceAuditSource = originalSource;
  assert.equal(auditCalls, 1); assert.equal(reviewCalls, 7);
  await writeFile(process.env.PRODUCT_AUDIT_PROOF_PATH || path.join(out, 'audit-http-proof.json'), JSON.stringify({ status: 'passed', fixtureRoot: root,
    sourceReviewTaskId: created.id, auditId: id, sealedSourceStages: 7, syntheticReviewCalls: reviewCalls, syntheticAuditCalls: auditCalls,
    providerCalls: 0, auditPolicyVersion: policyVersion, formatNormalizationVersion: formatVersion, normalizationProofTamperRejected: true,
    targetCount: done.report.coverage.completed, sourceBefore, sourceAfter: await hashes(reviews.rootDir),
    auditBefore, migratedAuditAfter: await hashes(movedRoot), report: done.report }, null, 2) + '\n');
});

test('failed/unknown audit is never dispatched on restart or new requestId; cloud placeholder is not read or overwritten', async () => {
  await mkdir(path.join(out, 'test-runs'), { recursive: true }); const root = await mkdtemp(path.join(out, 'test-runs/audit-stop-'));
  let calls = 0; const requestHash = 'e'.repeat(64), inputHash = 'd'.repeat(64);
  const prepared = { requestHash, inputHash, packet: { targets: [] }, sourceSnapshot: { fixture: 'fixed' }, binding: { fixture: 'fixed' } };
  const reviews = { evidenceAuditSource: async () => ({ sourceReviewTaskId: 'source', sourceRequestHash: 'f'.repeat(64), projectId: 'project' }) };
  const adapter = { getReviewEvidenceAuditVersions: () => ({}), getReviewEvidenceAuditPolicyVersions: () => [legacyPolicy, policyVersion], getReviewEvidenceAuditFormatNormalizationVersions: () => [formatVersion],
    prepareReviewEvidenceAudit: async options => ({ ...prepared, versions: { policyVersion: options.auditPolicyVersion ?? legacyPolicy },
      ...(options.auditPolicyVersion === policyVersion ? { auditPolicyVersion: policyVersion } : {}),
      ...(options.formatNormalizationVersion ? { formatNormalizationVersion: options.formatNormalizationVersion } : {}) }),
    runReviewEvidenceAudit: async ({ analyze }) => { await analyze({}); }, readReviewEvidenceAudit: async () => { throw Error('never'); } };
  let service = await new ReviewEvidenceAuditService({ rootDir: root, reviews, adapter, analyze: async () => { calls++; throw Error('provider outcome unknown'); } }).init();
  await service.start('source', { requestId: 'one' }); await service.close(); assert.equal(calls, 1);
  service = await new ReviewEvidenceAuditService({ rootDir: root, reviews, adapter, analyze: async () => { calls++; } }).init();
  assert.equal((await service.start('source', { requestId: 'two' })).status, 'needs_attention'); await service.close(); assert.equal(calls, 1);
  const recordPath = path.join(root, 'records', `${requestHash}.json`), before = await readFile(recordPath);
  const blocked = new ReviewEvidenceAuditService({ rootDir: root, reviews, adapter, analyze: () => {}, fileState: async () => ({ available: false, reason: 'dataless' }) });
  await assert.rejects(blocked.init(), { code: 'AUDIT_LOCAL_FILE_WAIT' }); assert.deepEqual(await readFile(recordPath), before);
  const stopped = JSON.parse(before); stopped.status = 'running'; await writeFile(recordPath, JSON.stringify(stopped, null, 2) + '\n');
  service = await new ReviewEvidenceAuditService({ rootDir: root, reviews, adapter, analyze: async () => { calls++; } }).init();
  assert.equal((await service.list('source')).tasks[0].status, 'interrupted'); await service.close(); assert.equal(calls, 1);
});

test('new audit requires supported explicit server policy/format; saved options cannot be changed', async () => {
  await mkdir(path.join(out, 'test-runs'), { recursive: true }); const root = await mkdtemp(path.join(out, 'test-runs/audit-policy-'));
  const source = { sourceReviewTaskId: 'source', sourceRequestHash: 'a'.repeat(64), projectId: 'project' };
  const prepared = { requestHash: 'b'.repeat(64), inputHash: 'c'.repeat(64), versions: { policyVersion }, auditPolicyVersion: policyVersion,
    sourceSnapshot: { fixed: true }, binding: { fixed: true }, packet: { targets: [] } };
  let calls = 0;
  const adapter = { getReviewEvidenceAuditVersions: () => ({}), prepareReviewEvidenceAudit: async () => prepared,
    readReviewEvidenceAudit: async () => { throw Error('not dispatched'); }, runReviewEvidenceAudit: async () => { calls++; } };
  const service = await new ReviewEvidenceAuditService({ rootDir: root, reviews: { evidenceAuditSource: async () => source }, adapter, analyze: async () => { calls++; } }).init();
  await assert.rejects(service.start('source', { requestId: 'new' }), { code: 'AUDIT_POLICY_UNAVAILABLE' });
  adapter.getReviewEvidenceAuditPolicyVersions = () => [legacyPolicy, policyVersion];
  await assert.rejects(service.start('source', { requestId: 'new' }), { code: 'AUDIT_FORMAT_UNAVAILABLE' });
  adapter.getReviewEvidenceAuditFormatNormalizationVersions = () => [formatVersion];
  await assert.rejects(service.start('source', { requestId: 'new' }), { code: 'AUDIT_FORMAT_BINDING' });
  assert.equal(calls, 0); assert.equal(service.records.size, 0);
  const frozen = { ...prepared, formatNormalizationVersion: formatVersion }, raw = JSON.stringify(frozen, null, 2) + '\n';
  await writeFile(path.join(root, 'prepared', `${prepared.requestHash}.json`), raw);
  const record = { id: prepared.requestHash, inputHash: prepared.inputHash, preparedSHA256: sha(raw), auditPolicyVersion: policyVersion };
  await assert.rejects(service.prepared(record), { code: 'AUDIT_PREPARED_BINDING' });
  assert.deepEqual(await service.prepared({ ...record, formatNormalizationVersion: formatVersion }), frozen);
  await assert.rejects(service.prepared({ ...record, formatNormalizationVersion: formatVersion, auditPolicyVersion: legacyPolicy }), { code: 'AUDIT_PREPARED_BINDING' });
  await service.close(); assert.equal(calls, 0);
});

test('fixture: only a new source gets server v3; existing v1 and v2 retain saved policies without redispatch', async () => {
  await mkdir(path.join(out, 'test-runs'), { recursive: true }); const root = await mkdtemp(path.join(out, 'test-runs/audit-v2-options-'));
  const preparedInputs = new Map(); let calls = 0;
  const reviews = { evidenceAuditSource: async id => ({ sourceReviewTaskId: id, sourceRequestHash: sha(id), projectId: 'project' }) };
  const make = options => {
    const policy = options.auditPolicyVersion ?? legacyPolicy, requestHash = sha(JSON.stringify([options.sourceReviewTaskId, policy, options.formatNormalizationVersion]));
    const prepared = { requestHash, inputHash: sha(requestHash), versions: { policyVersion: policy }, sourceSnapshot: { id: options.sourceReviewTaskId },
      binding: { sourceReviewTaskId: options.sourceReviewTaskId, sourceRequestHash: options.sourceRequestHash, targetsPolicy: policy }, packet: { targets: [] },
      ...(policy !== legacyPolicy ? { auditPolicyVersion: policy } : {}),
      ...(options.formatNormalizationVersion ? { formatNormalizationVersion: options.formatNormalizationVersion } : {}) };
    preparedInputs.set(requestHash, prepared); return prepared;
  };
  const replay = prepared => ({ requestHash: prepared.requestHash, inputHash: prepared.inputHash, sourceReviewTaskId: prepared.binding.sourceReviewTaskId,
    status: prepared.binding.sourceReviewTaskId === 'old-source' ? 'needs_attention' : 'complete',
    error: prepared.binding.sourceReviewTaskId === 'old-source' ? { code: 'ORIGINAL_FAILURE', message: 'Original failure retained.' } : null,
    report: { requestHash: prepared.requestHash, sourceReviewTaskId: prepared.binding.sourceReviewTaskId, sourceRequestHash: prepared.binding.sourceRequestHash,
      automaticAdoption: false, literaryPass: 'NOT_COMPUTED', originalReviewUnchanged: true } });
  const adapter = { getReviewEvidenceAuditPolicyVersions: () => [legacyPolicy, v2Policy, policyVersion], getReviewEvidenceAuditFormatNormalizationVersions: () => [formatVersion],
    getReviewEvidenceAuditVersions: options => ({ policyVersion: options?.auditPolicyVersion ?? legacyPolicy }), prepareReviewEvidenceAudit: async options => make(options),
    readReviewEvidenceAudit: async ({ requestHash }) => replay(preparedInputs.get(requestHash)),
    runReviewEvidenceAudit: async ({ prepared, runRoot, analyze, onProgress }) => {
      const runDir = path.join(runRoot, `review-evidence-audit-${prepared.requestHash}`); await mkdir(runDir);
      await writeFile(path.join(runDir, 'input.json'), JSON.stringify(prepared, null, 2) + '\n');
      await onProgress({ requestHash: prepared.requestHash, runDir }); await analyze({}); return { ...replay(prepared), runDir };
    } };
  let service = await new ReviewEvidenceAuditService({ rootDir: root, reviews, adapter, analyze: async () => { calls++; } }).init();
  // A saved v1 failure with a policy-specific binding would not match a v3 prepare.
  const prior = make(await reviews.evidenceAuditSource('old-source')), raw = JSON.stringify(prior, null, 2) + '\n';
  const oldRow = { schemaVersion: 'review-evidence-audit-product-1', id: prior.requestHash, projectId: 'project', sourceReviewTaskId: 'old-source',
    sourceRequestHash: prior.binding.sourceRequestHash, requestId: 'old-request', inputHash: prior.inputHash, preparedSHA256: sha(raw),
    status: 'needs_attention', createdAt: '2026-01-01', updatedAt: '2026-01-01', adapterRunDir: `runs/review-evidence-audit-${prior.requestHash}`, error: replay(prior).error };
  await mkdir(path.join(root, oldRow.adapterRunDir)); await writeFile(path.join(root, oldRow.adapterRunDir, 'input.json'), raw);
  await writeFile(path.join(root, 'prepared', `${prior.requestHash}.json`), raw); await service.save(oldRow, true); service.records.set(oldRow.id, oldRow);
  const oldBytes = await readFile(path.join(root, 'records', `${oldRow.id}.json`));
  const oldListing = await service.list('old-source');
  assert.equal(oldListing.versions.policyVersion, policyVersion); assert.equal(oldListing.tasks[0].error.code, 'ORIGINAL_FAILURE');
  assert.equal(oldListing.tasks[0].auditPolicyVersion, undefined); assert.equal(prior.versions.policyVersion, legacyPolicy);
  assert.equal((await service.start('old-source', { requestId: 'new-id-no-upgrade' })).id, oldRow.id); assert.equal(calls, 0);
  const priorV2 = make({ ...await reviews.evidenceAuditSource('old-v2-source'), auditPolicyVersion: v2Policy, formatNormalizationVersion: formatVersion });
  const v2Raw = JSON.stringify(priorV2, null, 2) + '\n';
  const v2Row = { ...oldRow, id: priorV2.requestHash, sourceReviewTaskId: 'old-v2-source', sourceRequestHash: priorV2.binding.sourceRequestHash,
    requestId: 'old-v2-request', inputHash: priorV2.inputHash, preparedSHA256: sha(v2Raw), status: 'complete', error: null,
    auditPolicyVersion: v2Policy, formatNormalizationVersion: formatVersion, adapterRunDir: `runs/review-evidence-audit-${priorV2.requestHash}` };
  await mkdir(path.join(root, v2Row.adapterRunDir)); await writeFile(path.join(root, v2Row.adapterRunDir, 'input.json'), v2Raw);
  await writeFile(path.join(root, 'prepared', `${v2Row.id}.json`), v2Raw); await service.save(v2Row, true); service.records.set(v2Row.id, v2Row);
  const v2Bytes = await readFile(path.join(root, 'records', `${v2Row.id}.json`));
  assert.equal((await service.list('old-v2-source')).tasks[0].auditPolicyVersion, v2Policy);
  assert.equal((await service.start('old-v2-source', { requestId: 'no-v2-upgrade' })).id, v2Row.id); assert.equal(calls, 0);
  const fresh = await service.start('new-source', { requestId: 'new-source-request' }); await service.close(); assert.equal(calls, 1);
  const saved = service.records.get(fresh.id); assert.equal(saved.auditPolicyVersion, policyVersion); assert.equal(saved.formatNormalizationVersion, formatVersion);
  service = await new ReviewEvidenceAuditService({ rootDir: root, reviews, adapter, analyze: async () => { calls++; } }).init();
  assert.equal((await service.list('new-source')).tasks[0].status, 'complete');
  assert.equal((await service.start('new-source', { requestId: 'different-id-after-restart' })).id, saved.id);
  assert.equal((await service.start('old-source', { requestId: 'another-old-id' })).id, oldRow.id);
  assert.equal((await service.list('old-v2-source')).tasks[0].status, 'complete');
  assert.equal((await service.start('old-v2-source', { requestId: 'no-v2-upgrade-after-restart' })).id, v2Row.id);
  assert.deepEqual(await readFile(path.join(root, 'records', `${v2Row.id}.json`)), v2Bytes);
  assert.deepEqual(await readFile(path.join(root, 'records', `${oldRow.id}.json`)), oldBytes);
  await service.close(); assert.equal(calls, 1); assert.equal(service.records.size, 3);
});

test('versions advertises only the explicit server v3 policy and fails closed on unsupported or mismatched metadata', () => {
  const calls = [], versions = Object.freeze({ policyVersion, toolVersion: 'fixture-tool' });
  const adapter = { getReviewEvidenceAuditPolicyVersions: () => [legacyPolicy, policyVersion],
    getReviewEvidenceAuditVersions: options => { calls.push(options); return versions; } };
  const service = new ReviewEvidenceAuditService({ rootDir: '/unused/no-service-started', adapter });
  assert.equal(service.versions(), versions); assert.deepEqual(calls, [{ auditPolicyVersion: policyVersion }]);
  adapter.getReviewEvidenceAuditVersions = () => ({ policyVersion: legacyPolicy }); assert.equal(service.versions(), null);
  adapter.getReviewEvidenceAuditPolicyVersions = () => [legacyPolicy];
  adapter.getReviewEvidenceAuditVersions = () => { assert.fail('Must not advertise a legacy policy for new online tasks'); };
  assert.equal(service.versions(), null);
});
