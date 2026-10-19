import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  DEEP_MODEL_OUTPUT_VERSION,
  DEEP_PACKET_VERSION,
  DEEP_QUEUE_VERSION,
  buildDeepAnalysisRequest,
  queryDeepAnalysisCandidates,
  revalidateRetainedDeepAnalysisAttempt,
  runRemaining99DeepAnalysis,
  validateDeepAnalysisModelOutput,
} from '../runtime/remaining99-deep-analysis-batch.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sourceId = 'source-deep-1';

function packet() {
  const units = [1, 2, 3].map(index => ({
    unitId: `U${index}`,
    sequenceOrdinal: index,
    title: `单元${index}`,
    locator: {lineStart: index, lineEnd: index},
    existingCheckedAnalysis: {
      event: `既有事件${index}，只描述局部动作。`,
      psychology: `既有心理${index}，仍然属于局部推断。`,
      emotion: `既有情绪${index}，没有形成跨单元推进。`,
      expression: `既有表达${index}。`,
      readerEffectHypothesis: `既有读者作用假说${index}。`,
    },
    evidenceIds: [`EV-${index}a`, `EV-${index}b`],
    relatedUnitIds: [],
  }));
  const evidenceRegistry = units.flatMap(unit => unit.evidenceIds.map((evidenceId, ordinal) => ({
    evidenceId,
    origin: 'catalog.analysis.units[].evidence',
    sourceId,
    unitId: unit.unitId,
    catalogEvidenceOrdinal: ordinal + 1,
    quote: `${unit.unitId}逐字证据${ordinal + 1}`,
    locator: {lineStart: unit.sequenceOrdinal, lineEnd: unit.sequenceOrdinal, charStart: 0, charEnd: 5},
    binding: {textVersion: 'text-v1', quoteSha256: hash(`${unit.unitId}逐字证据${ordinal + 1}`), lineWindowSha256: 'a'.repeat(64), literalStatus: 'verified'},
  })));
  return {
    schemaVersion: DEEP_PACKET_VERSION,
    sourceBinding: {sourceId, title: '测试故事', sourceSha256: 'b'.repeat(64), sourceTextSha256: 'c'.repeat(64), textVersion: 'text-v1',
      declaredCompleteness: 'unknown', analysisVersion: 'analysis-v1', analysisContentVersion: null, analysisTextVersion: 'text-v1',
      reviewRecordId: 'review-1', reviewOutcome: 'approved', reviewMethod: 'model-library-review', reviewBindingStatus: 'valid_checked_source_analysis'},
    visibilityBoundary: {suppliedToModel: 'all checked units and evidence', notSupplied: 'full text', completeness: 'unknown', interpretationRule: 'hypothesis'},
    inheritedCoverage: null,
    inheritedLimitations: [],
    units,
    evidenceRegistry,
    hostBindingSha256: 'd'.repeat(64),
  };
}

function output(bound = packet()) {
  return {
    schemaVersion: DEEP_MODEL_OUTPUT_VERSION,
    sourceId: bound.sourceBinding.sourceId,
    hostBindingSha256: bound.hostBindingSha256,
    emotionalProgression: {
      synthesis: '三处行动信号从克制转为对抗，再转为带保留的缓和；这只是跨单元解释。',
      stages: [
        {stageId: 'EP1', unitIds: ['U1'], evidenceIds: ['EV-1a'], observedState: '动作收束，情绪外显较少。', interpretation: '可能处于克制阶段。', uncertainty: '未见直接内心陈述。'},
        {stageId: 'EP2', unitIds: ['U2'], evidenceIds: ['EV-2a'], observedState: '对抗动作增加。', interpretation: '可能转入防御或愤怒。', uncertainty: '动机仍有其他解释。'},
        {stageId: 'EP3', unitIds: ['U3'], evidenceIds: ['EV-3a'], observedState: '行动节奏放缓。', interpretation: '可能出现有限缓和。', uncertainty: '不能证明情绪已经解决。'},
      ],
      transitions: [
        {fromStageId: 'EP1', toStageId: 'EP2', evidenceIds: ['EV-1a', 'EV-2a'], observedChange: '从收束动作转为直接对抗。', possibleDriver: '第二单元的可见冲突可能触发变化。', alternatives: ['也可能只是场景压力增加。'], uncertainty: '因果关系是AI假说。'},
        {fromStageId: 'EP2', toStageId: 'EP3', evidenceIds: ['EV-2b', 'EV-3a'], observedChange: '动作强度下降并留下保留。', possibleDriver: '第三单元的新信息可能改变应对。', alternatives: ['也可能只是叙述节奏切换。'], uncertainty: '无法证明稳定心理变化。'},
      ],
    },
    psychologicalChangeDrivers: {
      synthesis: '可观察事件与行动方式共同支持两个可能的心理变化驱动。',
      drivers: [
        {driverId: 'PD1', beforeUnitIds: ['U1'], afterUnitIds: ['U2'], evidenceIds: ['EV-1b', 'EV-2a'], observedTrigger: '冲突从言语转为行动。', changeHypothesis: '人物可能从回避转向防御。', alternatives: ['也可能是策略性应对。'], counterEvidenceOrGap: '没有直接内心陈述。', uncertainty: '只据动作推断。'},
        {driverId: 'PD2', beforeUnitIds: ['U2'], afterUnitIds: ['U3'], evidenceIds: ['EV-2b', 'EV-3b'], observedTrigger: '后续信息改变互动条件。', changeHypothesis: '人物可能降低即时对抗。', alternatives: ['也可能只是暂时停顿。'], counterEvidenceOrGap: '后续是否持续未知。', uncertainty: '不等于完成心理修复。'},
      ],
    },
    observableCraftDecisionHypotheses: {
      synthesis: '跨单元可见的对照和递进可形成两项创作选择假说。',
      hypotheses: [
        {hypothesisId: 'CH1', unitIds: ['U1', 'U2'], evidenceIds: ['EV-1a', 'EV-2a'], observablePattern: '先收束动作，后集中呈现对抗动作。', possibleFunction: '可能用顺序对照突出升级。', alternatives: ['也可能由事件自然时序造成。'], limitation: '只是可观察功能假说，不代表作者真实意图。'},
        {hypothesisId: 'CH2', unitIds: ['U2', 'U3'], evidenceIds: ['EV-2b', 'EV-3a'], observablePattern: '强动作后接较慢动作。', possibleFunction: '可能形成节奏落差并保留余波。', alternatives: ['也可能只是场景转换。'], limitation: '不推断ROI、真人读者结果或作者真实意图。'},
      ],
    },
    limitations: ['模型只看到了宿主提供的全部checked单元和逐字证据。', '心理、因果和功能均为待独立复核的AI假说。'],
  };
}

test('validator accepts new cross-unit synthesis while retaining candidate boundaries', () => {
  const result = validateDeepAnalysisModelOutput(output(), packet());
  assert.equal(result.validation.status, 'evidence_binding_passed');
  assert.equal(result.validation.approvalStatus, 'candidate_unreviewed');
  assert.equal(result.validation.grantsApproved, false);
  assert.equal(result.validation.citedUnitCount, 3);
});

test('compact model response receives frozen host metadata while wrong emitted metadata is rejected', () => {
  const compact = output();
  delete compact.schemaVersion; delete compact.sourceId; delete compact.hostBindingSha256;
  const result = validateDeepAnalysisModelOutput(compact, packet());
  assert.equal(result.modelOutput.schemaVersion, DEEP_MODEL_OUTPUT_VERSION);
  assert.equal(result.modelOutput.sourceId, sourceId);
  assert.deepEqual(result.validation.formatNormalization, [
    'injected-host-metadata:schemaVersion',
    'injected-host-metadata:sourceId',
    'injected-host-metadata:hostBindingSha256',
  ]);
  const wrong = structuredClone(compact); wrong.sourceId = 'wrong-source';
  assert.throws(() => validateDeepAnalysisModelOutput(wrong, packet()), error => error.code === 'CANDIDATE_BINDING');
});

test('prompt declares compact exact fields and explicit minimum counts', () => {
  const request = buildDeepAnalysisRequest(packet()), body = JSON.parse(request.user);
  assert.deepEqual(body.outputContract.exactFormatRules.modelOwnedTopLevelKeys,
    ['emotionalProgression', 'psychologicalChangeDrivers', 'observableCraftDecisionHypotheses', 'limitations']);
  assert.deepEqual(body.outputContract.exactFormatRules.minimumCounts,
    {emotionalStages: 3, emotionalTransitions: 2, psychologicalDrivers: 2, observableCraftHypotheses: 2});
  assert.match(request.system, /至少 3 个 stages 和 2 个 transitions/u);
});

test('one craft key alias preserves semantic content and original raw while conflicting fields fail', () => {
  const canonical = output(), raw = structuredClone(canonical);
  const hypothesis = raw.observableCraftDecisionHypotheses.hypotheses[1];
  hypothesis.observedPattern = hypothesis.observablePattern;
  delete hypothesis.observablePattern;
  const before = structuredClone(raw);
  const result = validateDeepAnalysisModelOutput(raw, packet());
  assert.deepEqual(raw, before);
  assert.deepEqual(result.modelOutput, canonical);
  assert.ok(result.validation.formatNormalization.includes('craft-pattern-key-alias:1:observedPattern->observablePattern'));
  hypothesis.observablePattern = '另一种解释不能被自动选择或删除。';
  assert.throws(() => validateDeepAnalysisModelOutput(raw, packet()), error => error.code === 'CANDIDATE_CRAFT_ALIAS_AMBIGUOUS');
});

test('validator rejects invented evidence IDs, copied unit fields and author-intent assertions', () => {
  const invented = output(); invented.emotionalProgression.stages[0].evidenceIds = ['EV-invented'];
  assert.throws(() => validateDeepAnalysisModelOutput(invented, packet()), error => error.code === 'CANDIDATE_EVIDENCE_ID');
  const copied = output(); copied.emotionalProgression.synthesis = packet().units[0].existingCheckedAnalysis.emotion;
  assert.throws(() => validateDeepAnalysisModelOutput(copied, packet()), error => error.code === 'CANDIDATE_COPIED_FIELD');
  const intent = output(); intent.observableCraftDecisionHypotheses.hypotheses[0].possibleFunction = '作者真实意图是提高转化率。';
  assert.throws(() => validateDeepAnalysisModelOutput(intent, packet()), error => error.code === 'CANDIDATE_UNSUPPORTED_ASSERTION');
  const placeholder = output(); placeholder.observableCraftDecisionHypotheses.hypotheses[0].observablePattern = 'not-used';
  assert.throws(() => validateDeepAnalysisModelOutput(placeholder, packet()), error => error.code === 'CANDIDATE_CRAFT');
  const wrongField = output(); wrongField.observableCraftDecisionHypotheses.hypotheses[0].observedPattern = '错位字段';
  assert.throws(() => validateDeepAnalysisModelOutput(wrongField, packet()), error => error.code === 'CANDIDATE_CRAFT_ALIAS_AMBIGUOUS');
});

test('runner retains failed attempts, requires explicit retry, checkpoints candidates and exposes only unreviewed query results', async () => {
  const root = await mkdtemp(join(tmpdir(), 'remaining99-deep-test-')), queueRoot = join(root, 'queue'), runRoot = join(root, 'run');
  await mkdir(queueRoot, {recursive: true});
  const bound = packet(), longEvidenceQuote = '长引文证据'.repeat(450);
  bound.evidenceRegistry[0].quote = longEvidenceQuote;
  bound.evidenceRegistry[0].binding.quoteSha256 = hash(longEvidenceQuote);
  const packetText = `${JSON.stringify(bound, null, 2)}\n`, packetPath = join(queueRoot, `${sourceId}.json`);
  await writeFile(packetPath, packetText);
  const queue = {schemaVersion: DEEP_QUEUE_VERSION, queueName: 'test', expectedSourceCount: 1, sources: [{sourceId, title: '测试故事',
    packetPath: `${sourceId}.json`, packetSha256: hash(packetText), hostBindingSha256: bound.hostBindingSha256, unitCount: 3, evidenceCount: 6, sourceBinding: bound.sourceBinding}]};
  const queuePath = join(queueRoot, 'queue.json'); await writeFile(queuePath, `${JSON.stringify(queue, null, 2)}\n`);
  const failed = await runRemaining99DeepAnalysis({queuePath, runRoot, model: async () => { throw new Error('synthetic failure'); }});
  assert.equal(failed.outcomes[0].status, 'failed');
  const skipped = await runRemaining99DeepAnalysis({queuePath, runRoot, model: async () => output(bound)});
  assert.equal(skipped.outcomes[0].status, 'skipped_failed');
  const completed = await runRemaining99DeepAnalysis({queuePath, runRoot, model: async () => output(bound), retryFailed: true});
  assert.equal(completed.outcomes[0].status, 'completed_candidate_unreviewed');
  const sourceRoot = join(runRoot, 'sources', sourceId), attempts = await readdir(join(sourceRoot, 'attempts'));
  assert.equal(attempts.length, 2);
  const statusPath = join(sourceRoot, 'status.json'); await stat(statusPath);
  const status = JSON.parse(await readFile(statusPath));
  assert.equal(status.approved, false);
  const queried = await queryDeepAnalysisCandidates({queuePath, runRoot, query: '对抗'});
  assert.equal(queried.resultCount, 1);
  assert.equal(queried.results[0].reviewStatus, 'candidate_unreviewed');
  assert.equal(queried.results[0].approved, false);
  assert.equal(JSON.stringify(queried).includes(longEvidenceQuote), false);
  assert.equal(JSON.stringify(queried).includes('EV-1a'), true);

  let opened = 0, closed = 0, authorization = null;
  const sessionRunRoot = join(root, 'session-run');
  const sessionResult = await runRemaining99DeepAnalysis({
    queuePath,
    runRoot: sessionRunRoot,
    createProviderSession: async options => {
      opened++;
      assert.equal(options.caseId, 'controller-owned-case');
      return {
        fetch: async (_endpoint, init) => {
          authorization = init.headers.authorization;
          const body = JSON.parse(init.body), suppliedPacket = JSON.parse(body.messages[1].content).packet;
          return new Response(JSON.stringify({choices: [{message: {content: JSON.stringify(output(suppliedPacket))}}]}), {status: 200});
        },
        close: async () => { closed++; },
      };
    },
    providerSessionOptions: {caseId: 'controller-owned-case', config: {model: 'controller-model', apiKey: 'private-test-key'}},
  });
  assert.equal(sessionResult.outcomes[0].status, 'completed_candidate_unreviewed');
  assert.equal(opened, 1); assert.equal(closed, 1); assert.equal(authorization, 'Bearer private-test-key');
  const sessionAttempts = await readdir(join(sessionRunRoot, 'sources', sourceId, 'attempts'));
  const requestPath = join(sessionRunRoot, 'sources', sourceId, 'attempts', sessionAttempts[0], 'request.json'); await stat(requestPath);
  assert.equal((await readFile(requestPath, 'utf8')).includes('private-test-key'), false);
  let unnecessarySession = 0;
  const allSkipped = await runRemaining99DeepAnalysis({queuePath, runRoot: sessionRunRoot,
    createProviderSession: async () => { unnecessarySession++; throw new Error('must not open'); }, providerSessionOptions: {}});
  assert.equal(allSkipped.outcomes[0].status, 'skipped_completed');
  assert.equal(allSkipped.providerSessionOpened, false);
  assert.equal(unnecessarySession, 0);

  const retainedRoot = join(root, 'retained-run'), retainedAttemptId = 'retained-failed-attempt';
  const retainedAttemptRoot = join(retainedRoot, 'sources', sourceId, 'attempts', retainedAttemptId);
  await mkdir(retainedAttemptRoot, {recursive: true});
  const compact = output(bound); delete compact.schemaVersion; delete compact.sourceId; delete compact.hostBindingSha256;
  const outer = {choices: [{message: {content: JSON.stringify(compact)}}]};
  await writeFile(join(retainedAttemptRoot, 'response.raw.txt'), `${JSON.stringify(outer, null, 2)}\n`);
  await writeFile(join(retainedAttemptRoot, 'error.json'), `${JSON.stringify({phase: 'validation', code: 'CANDIDATE_VERSION', message: 'old parser failure'})}\n`);
  await writeFile(join(retainedRoot, 'sources', sourceId, 'status.json'), `${JSON.stringify({status: 'failed', attemptId: retainedAttemptId,
    phase: 'validation', code: 'CANDIDATE_VERSION', message: 'old parser failure'})}\n`);
  const revalidated = await revalidateRetainedDeepAnalysisAttempt({queuePath, runRoot: retainedRoot, sourceId,
    attemptId: retainedAttemptId, deriveCandidate: true, semanticAudit: {status: 'pass', auditor: 'test-semantic-auditor'}});
  assert.equal(revalidated.status, 'revalidated');
  assert.ok(revalidated.derivedCandidatePath);
  await stat(revalidated.receiptPath);
  const receipt = JSON.parse(await readFile(revalidated.receiptPath, 'utf8'));
  assert.equal(receipt.execution.modelCalls, 0);
  assert.equal(receipt.originalAttemptMutated, false);
  assert.equal(receipt.approvalStatus, 'not_approved');
  await stat(join(retainedRoot, 'sources', sourceId, 'status.json'));
  const retainedStatus = JSON.parse(await readFile(join(retainedRoot, 'sources', sourceId, 'status.json'), 'utf8'));
  assert.equal(retainedStatus.status, 'failed');
});
