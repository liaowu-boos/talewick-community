import assert from 'node:assert/strict';
import {buildReadingPlan, validateResponse, inspectExecution, sha256, PROTOCOL_VERSION} from '../../isolated-anchor-reading/review-tools.mjs';

const ids = ['S1', 'S2', 'C1'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const pendingSemantic = () => ({status: 'pending', label: '人工语义复核未完成',
  summary: '锚点定位、同文检查与差异覆盖均不证明语义支持。'});

// get/ref must come from a trusted, frozen evidence store. Hashes of JSON values
// use the protocol's canonical serializer; raw response hashes use exact bytes.
export function adaptIsolatedReading({plan, expectedPlanSHA256, manifest, get, ref}) {
  assert.equal(plan.protocolVersion, PROTOCOL_VERSION, 'Unsupported reading protocol; no implicit migration');
  const comparison = plan.requests?.find(request => request.requestId === 'C1');
  assert(comparison, 'Comparison packet required');
  const manuscripts = Object.fromEntries(comparison.packet.manuscripts.map(m => [m.version, m.chapters]));
  const rebuilt = buildReadingPlan({manuscripts, chapterIds: plan.chapterIds});
  assert.deepEqual(plan, rebuilt, 'Plan, packet, or messages differ from the protocol');
  assert.equal(plan.planSHA256, expectedPlanSHA256, 'Trusted plan hash mismatch');
  assert.equal(manifest.planSHA256, expectedPlanSHA256, 'Manifest plan binding mismatch');
  assert(Array.isArray(manifest.requests));
  assert.deepEqual(manifest.requests.map(item => item.requestId), ids, 'Three ordered request slots required');

  const read = id => {
    const result = get(id);
    assert(Buffer.isBuffer(result.bytes), 'Evidence bytes required');
    assert.equal(sha256(result.bytes), result.entry.sha256, 'Evidence bytes differ from their saved hash');
    return result;
  };
  const json = id => JSON.parse(read(id).bytes);
  const raws = new Map();
  const requests = plan.requests.map((request, i) => {
    const item = manifest.requests[i], single = request.packet.mode === 'single';
    const row = {
      requestId: request.requestId, mode: request.packet.mode,
      label: single ? `${request.requestId} · 独立匿名单稿阅读` : 'C1 · 差异辅助比较',
      method: single ? '仅提供一份匿名 X 稿；没有另一稿，也不产生稿间偏好。'
        : '两稿全文加中立差异定位；不是 AB/BA 冷读，也不是三张偏好票。',
      returnState: 'unknown', rawText: null, originalResponse: null,
      opinion: null, references: [],
      protocolValidation: {status: 'pending', label: '协议与冻结锚点校验未导入'},
      semanticReview: pendingSemantic(),
      preference: {applicable: !single, raw: null, validated: null,
        label: single ? '单稿阅读不适用稿间偏好' : '比较偏好待核验'},
      fullManuscriptAccepted: false,
    };
    if (!item.rawId) return row;
    const raw = read(item.rawId);
    raws.set(request.requestId, raw);
    row.returnState = 'returned';
    row.rawText = raw.bytes.toString('utf8');
    row.references.push(ref(item.rawId));
    let response;
    try { response = JSON.parse(row.rawText); } catch { /* Original bytes remain available. */ }
    row.originalResponse = response ?? null;
    row.opinion = Object.fromEntries(['freeReading', 'overall', 'dimensions', 'chapterReadings',
      'factualChecks', 'counterReading', 'scopeLimit', ...(!single ? ['textIdentity', 'changeReadings'] : [])]
      .filter(key => response !== null && typeof response === 'object' && Object.hasOwn(response, key))
      .map(key => [key, structuredClone(response[key])]));
    // Preserve forbidden single-reader fields only in originalResponse/rawText.
    // They are evidence of rejection, never a single-reader comparative vote.
    if (single && row.opinion.overall && typeof row.opinion.overall === 'object') {
      row.opinion.overall = Object.fromEntries(Object.entries(row.opinion.overall).filter(([key]) => key !== 'preference'));
    }
    if (!single) row.preference.raw = response?.overall?.preference ?? null;

    if (item.inspectionId) {
      row.references.push(ref(item.inspectionId));
      try {
        const saved = json(item.inspectionId);
        const verified = validateResponse({packet: request.packet, expectedPacketSHA256: request.packetSHA256,
          raw: raw.bytes, expectedRawSHA256: raw.entry.sha256});
        assert.deepEqual(saved, verified, 'Saved inspection does not match frozen packet and raw bytes');
        row.protocolValidation = {status: saved.valid ? 'passed' : 'failed',
          label: saved.valid ? '协议与冻结锚点校验通过，语义另行复核' : '协议校验未通过，原始回包保留',
          inspection: saved, anchorMeaning: '引文由冻结目录取回，不是模型自行逐字抄引的证明。'};
      } catch {
        row.protocolValidation = {status: 'binding_error', label: '校验记录与冻结输入不匹配',
          errors: ['INSPECTION_BINDING_MISMATCH'], effectivePreference: null};
      }
    }
    if (item.semanticReviewId) {
      row.references.push(ref(item.semanticReviewId));
      try {
        const report = json(item.semanticReviewId);
        assert.equal(report.schemaVersion, 'isolated-reading-semantic-review-2');
        assert.equal(report.planSHA256, expectedPlanSHA256);
        assert.equal(report.packetSHA256, request.packetSHA256);
        assert.equal(report.requestId, request.requestId);
        assert.equal(report.rawSHA256, raw.entry.sha256);
        assert.equal(report.fullManuscriptAccepted, false);
        assert(['pending', 'failed', 'reviewed'].includes(report.status));
        assert(text(report.scope) && text(report.summary));
        row.semanticReview = {...report, label: {pending: '人工语义复核未完成', failed: '人工语义复核未通过',
          reviewed: '声明范围内的人工复核已完成'}[report.status]};
      } catch {
        row.semanticReview = {status: 'binding_error', label: '人工复核记录绑定失败',
          summary: '不能将未绑定记录用于本路结论。'};
      }
    }
    return row;
  });

  let execution = {status: 'pending', label: '三路执行存档未完整核验', references: []};
  if (manifest.executionId) {
    execution.references.push(ref(manifest.executionId));
    try {
      const executions = manifest.requests.map(item => {
        assert(raws.has(item.requestId) && item.messagesId && item.receiptId, 'Execution archive incomplete');
        execution.references.push(ref(item.messagesId), ref(item.receiptId));
        return {requestId: item.requestId, raw: raws.get(item.requestId).bytes,
          messages: json(item.messagesId), receipt: json(item.receiptId)};
      });
      const actual = inspectExecution({plan, executions});
      assert.deepEqual(json(manifest.executionId), actual, 'Saved execution differs from archived inputs');
      execution = {...execution, status: actual.valid ? 'passed' : 'failed',
        label: actual.valid ? '三路执行存档绑定通过' : '三路执行存档核验未通过', inspection: actual};
    } catch {
      execution = {...execution, status: 'binding_error', label: '执行记录绑定失败或存档不完整',
        errors: ['EXECUTION_ARCHIVE_BINDING_MISMATCH']};
    }
  }
  const c1 = requests[2];
  if (c1.protocolValidation.status === 'passed' && execution.status === 'passed') {
    c1.preference.validated = c1.protocolValidation.inspection.validatedPreference;
    c1.preference.label = '仅 C1 的机械核验偏好；语义与编辑决定另列';
  }

  let editorialDecision = {status: 'pending', label: '编辑采纳未决定',
    summary: '不从机器通过、单稿读感或偏好票数推导采纳。', references: [], adoptionExecuted: false};
  if (manifest.editorialDecisionId) {
    editorialDecision.references.push(ref(manifest.editorialDecisionId));
    try {
      const report = json(manifest.editorialDecisionId);
      assert.equal(report.schemaVersion, 'isolated-reading-editorial-decision-2');
      assert.equal(report.planSHA256, expectedPlanSHA256);
      assert.equal(report.fullManuscriptAccepted, false);
      assert(['pending', 'retain_baseline', 'use_as_working_draft'].includes(report.status));
      assert(text(report.scope) && text(report.summary));
      const snapshot = Object.fromEntries(ids.map(id => [id, raws.get(id)?.entry.sha256 ?? null]));
      assert.deepEqual(report.rawSHA256ByRequest, snapshot, 'Editorial decision uses another response snapshot');
      editorialDecision = {...editorialDecision, status: report.status, scope: report.scope, summary: report.summary,
        label: {pending: '编辑采纳未决定', retain_baseline: '编辑决定保留基线',
          use_as_working_draft: '编辑选择继续作为工作底稿，非全稿验收'}[report.status]};
    } catch {
      editorialDecision = {...editorialDecision, status: 'binding_error', label: '编辑决定绑定失败',
        summary: '不能将未绑定编辑记录用于当前快照。'};
    }
  }
  return {schemaVersion: 'isolated-reading-view-2', protocolVersion: plan.protocolVersion,
    planSHA256: expectedPlanSHA256, chapterIds: [...plan.chapterIds], requests, execution, editorialDecision,
    textIdentity: structuredClone(comparison.packet.identity),
    textIdentityScope: '冻结的所提供章节标题及正文；逐章 titleEqual 与 bodyEqual 分列。',
    differences: structuredClone(comparison.packet.differences),
    fullManuscriptAccepted: false, adoptionExecuted: false,
    limitation: '三路结果分列，不投票；所有通过状态均不扩大为全文质量或事实验收。'};
}
