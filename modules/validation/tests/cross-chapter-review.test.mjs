import protection from './fixtures/cross-chapter-deictic-role-protection.mjs';
import expected from './fixtures/cross-chapter-expected.mjs';
import frozen from './fixtures/cross-chapter-frozen-case.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CROSS_CHAPTER_STAGES,
  CROSS_CHAPTER_IMPLEMENTATION_VERSION,
  CROSS_CHAPTER_PROTOCOL_SYSTEM_VERSION,
  CROSS_CHAPTER_ATTENTION_ANCHOR_VERSION,
  WHOLE_QUALITY_MODEL_POLICY,
  buildCrossChapterAttentionAnchors,
  inspectCrossChapterAdjudicationResponse,
  inspectCrossChapterExtractionResponse,
  prepareCrossChapterAdjudication,
  prepareCrossChapterExtraction,
  reviewCrossChapter,
} from '../runtime/cross-chapter-review.mjs';

const chapters = new Map(frozen.manuscript.chapters.map(chapter => [chapter.id, chapter]));

function evidence(chapterId, quote) {
  const start = chapters.get(chapterId).body.indexOf(quote);
  assert.notEqual(start, -1, `${quote} must exist in ${chapterId}`);
  return { chapterId, quote };
}

const entities = [
  { id: 'person-lin-lan', canonicalName: '林岚', aliases: ['林岚', '她'], kind: 'person' },
  { id: 'person-lin-blue', canonicalName: '林蓝', aliases: ['林蓝'], kind: 'person' },
  { id: 'person-officer', canonicalName: '警员', aliases: ['警员'], kind: 'person' },
  { id: 'object-key', canonicalName: '铜钥匙', aliases: ['铜钥匙'], kind: 'object' },
  { id: 'object-boxes', canonicalName: '同一批木箱', aliases: ['木箱', '同一批入库'], kind: 'object' },
  { id: 'object-clock', canonicalName: '报时钟', aliases: ['报时钟'], kind: 'object' },
  { id: 'object-letter', canonicalName: '密封信', aliases: ['密封信'], kind: 'object' },
  { id: 'object-folder', canonicalName: '蓝色文件夹', aliases: ['蓝色文件夹'], kind: 'object' },
];

const events = [
  { id: 'event-entry-mon', canonicalKind: '进入档案室', occurrenceKey: '周一首次进入', sequence: 1, participantEntityIds: ['person-lin-lan'], objectEntityIds: [], chapterIds: ['chapter-1', 'chapter-2', 'chapter-3', 'chapter-4'] },
  { id: 'event-inventory-batch', canonicalKind: '同批入库清点', occurrenceKey: '周一同一批入库', sequence: 1, participantEntityIds: [], objectEntityIds: ['object-boxes'], chapterIds: ['chapter-1', 'chapter-3'] },
  { id: 'event-key-state', canonicalKind: '钥匙持有状态', occurrenceKey: '周一钥匙移动', sequence: 1, participantEntityIds: ['person-lin-lan', 'person-officer'], objectEntityIds: ['object-key'], chapterIds: ['chapter-1', 'chapter-2', 'chapter-4'] },
  { id: 'event-bell-mon', canonicalKind: '报时钟鸣响', occurrenceKey: '周一鸣响', sequence: 1, participantEntityIds: [], objectEntityIds: ['object-clock'], chapterIds: ['chapter-1'] },
  { id: 'event-bell-tue', canonicalKind: '报时钟鸣响', occurrenceKey: '周二鸣响', sequence: 2, participantEntityIds: [], objectEntityIds: ['object-clock'], chapterIds: ['chapter-3'] },
  { id: 'event-bell-wed', canonicalKind: '报时钟鸣响', occurrenceKey: '周三同一轮校验', sequence: 3, participantEntityIds: [], objectEntityIds: ['object-clock'], chapterIds: ['chapter-4'] },
  { id: 'event-letter-disclosure', canonicalKind: '密封信内容披露', occurrenceKey: '延迟披露', sequence: 1, participantEntityIds: [], objectEntityIds: ['object-letter'], chapterIds: ['chapter-1', 'chapter-4'] },
  { id: 'event-folder-state', canonicalKind: '文件夹位置状态', occurrenceKey: '北侧书架文件夹', sequence: 1, participantEntityIds: [], objectEntityIds: ['object-folder'], chapterIds: ['chapter-1', 'chapter-4'] },
  { id: 'event-visitor-log', canonicalKind: '南楼访客登记', occurrenceKey: '林蓝周一值班', sequence: 1, participantEntityIds: ['person-lin-blue'], objectEntityIds: [], chapterIds: ['chapter-2', 'chapter-4'] },
];

const claimSpecs = [
  ['boxes-3', 'chapter-1', 'count', ['object-boxes'], 'event-inventory-batch', '同一批木箱', '入库数量', '3', '周一入库', '同批第1轮', 'narrated_fact', '同一批入库三只木箱'],
  ['boxes-2', 'chapter-3', 'count', ['object-boxes'], 'event-inventory-batch', '同一批木箱', '清点数量', '2', '同批清点结束', '同批第1轮', 'narrated_fact', '同一批入库清点结束，账本明确仍是两只木箱；期间没有搬出、损毁或重新分批'],
  ['entry-seen', 'chapter-1', 'actor', ['person-lin-lan'], 'event-entry-mon', '林岚', '进入档案室', '已进入', '周一八点', '首次', 'narrated_fact', '监控拍到林岚第一次进入档案室'],
  ['entry-denied', 'chapter-2', 'actor', ['person-lin-lan'], 'event-entry-mon', '林岚', '进入档案室', '未进入', '周一当晚', '首次', 'dialogue_claim', '“我今晚没有进过档案室。”'],
  ['arrival-memory', 'chapter-3', 'time', ['person-lin-lan'], 'event-entry-mon', '林岚', '首次到达时间', '20:30', '周一', '首次', 'memory', '林岚回忆自己八点半才第一次到达档案室'],
  ['arrival-video', 'chapter-4', 'time', ['person-lin-lan'], 'event-entry-mon', '林岚', '首次到达时间', '20:00', '周一', '首次', 'narrated_fact', '监控时间码再次确认林岚周一八点整已经进门'],
  ['key-table', 'chapter-1', 'object_state', ['person-lin-lan', 'object-key'], 'event-key-state', '铜钥匙', '位置', '桌上', '周一八点后', '状态1', 'narrated_fact', '她把铜钥匙放在桌上'],
  ['key-pocket', 'chapter-2', 'object_state', ['person-lin-lan', 'object-key'], 'event-key-state', '铜钥匙', '位置', '外套口袋', '周一九点', '状态2', 'narrated_fact', '林岚拿起桌上的铜钥匙，塞进外套口袋'],
  ['bell-mon-two', 'chapter-1', 'count', ['object-clock'], 'event-bell-mon', '报时钟', '鸣响次数', '2', '周一', '轮次1', 'narrated_fact', '周一的报时钟响了两次'],
  ['bell-tue-one', 'chapter-3', 'count', ['object-clock'], 'event-bell-tue', '报时钟', '鸣响次数', '1', '周二', '轮次2', 'narrated_fact', '第二天周二，报时钟只响了一次'],
  ['letter-withheld', 'chapter-1', 'object_state', ['object-letter'], 'event-letter-disclosure', '密封信内容', '披露状态', '未披露', '第一章', '披露前', 'narrated_fact', '叙述暂时没有说明密封信里写了什么'],
  ['letter-revealed', 'chapter-4', 'object_state', ['object-letter'], 'event-letter-disclosure', '密封信内容', '披露状态', '仓库地址', '第四章', '披露时', 'narrated_fact', '直到此刻，叙述才揭示密封信写的是仓库地址，先前的留白是为了延迟披露'],
  ['linlan-entry-count', 'chapter-1', 'count', ['person-lin-lan'], 'event-entry-mon', '林岚', '进入档案室次数', '1', '周一八点', '进入事件', 'narrated_fact', '林岚第一次进入档案室'],
  ['linblue-visitors', 'chapter-4', 'count', ['person-lin-blue'], 'event-visitor-log', '林蓝', '登记访客人数', '4', '周一值班', '访客登记事件', 'narrated_fact', '林蓝的访客簿仍记着四人，与林岚进入档案室的次数无关'],
  ['folder-present', 'chapter-1', 'object_state', ['object-folder'], 'event-folder-state', '蓝色文件夹', '位置状态', '在北侧书架', '第一章', '状态1', 'narrated_fact', '蓝色文件夹仍在北侧书架上'],
  ['folder-missing', 'chapter-4', 'object_state', ['object-folder'], 'event-folder-state', '蓝色文件夹', '位置状态', '不在北侧书架', '第四章', '状态2', 'narrated_fact', '北侧书架上的蓝色文件夹已经不见了，正文没有交代谁移动了它'],
  ['bell-wed-three', 'chapter-4', 'count', ['object-clock'], 'event-bell-wed', '报时钟', '同轮鸣响次数', '3', '周三校验', '同一轮', 'narrated_fact', '日志左栏写着报时钟响了三声'],
  ['bell-wed-two', 'chapter-4', 'count', ['object-clock'], 'event-bell-wed', '报时钟', '同轮鸣响次数', '2', '周三校验', '同一轮', 'narrated_fact', '右栏却写同一轮只响了两声'],
  ['officer-received-key', 'chapter-4', 'actor', ['person-officer', 'object-key'], 'event-key-state', '警员', '接收铜钥匙', '已接收', '第四章交接', '交接', 'narrated_fact', '她从外套口袋取出铜钥匙交给警员'],
];

const claims = claimSpecs.map(([id, chapterId, dimension, entityIds, eventId, subject, predicate, value, timeScope, eventRound, epistemic, quote]) => ({
  id, chapterId, dimension, entityIds, eventId, subject, predicate, value, timeScope, eventRound, epistemic, evidence: [evidence(chapterId, quote)],
}));

const groupSpecs = [
  ['boxes-same-batch', 'count', ['boxes-3', 'boxes-2'], ['object-boxes'], ['event-inventory-batch']],
  ['entry-deliberate-lie', 'actor', ['entry-seen', 'entry-denied'], ['person-lin-lan'], ['event-entry-mon']],
  ['arrival-misremembered', 'time', ['arrival-memory', 'arrival-video'], ['person-lin-lan'], ['event-entry-mon']],
  ['key-normal-transition', 'object_state', ['key-table', 'key-pocket'], ['person-lin-lan', 'object-key'], ['event-key-state']],
  ['clock-different-rounds', 'count', ['bell-mon-two', 'bell-tue-one'], ['object-clock'], ['event-bell-mon', 'event-bell-tue']],
  ['letter-delayed-disclosure', 'object_state', ['letter-withheld', 'letter-revealed'], ['object-letter'], ['event-letter-disclosure']],
  ['linlan-different-people', 'count', ['linlan-entry-count', 'linblue-visitors'], ['person-lin-lan', 'person-lin-blue'], ['event-entry-mon', 'event-visitor-log']],
  ['folder-unexplained', 'object_state', ['folder-present', 'folder-missing'], ['object-folder'], ['event-folder-state']],
  ['same-chapter-clock-conflict', 'count', ['bell-wed-three', 'bell-wed-two'], ['object-clock'], ['event-bell-wed']],
];

const comparisonGroups = groupSpecs.map(([id, dimension, claimIds, entityIds, eventIds]) => ({ id, dimension, claimIds, entityIds, eventIds, rationale: `核对 ${id} 的跨章事实与反证。` }));

function extractionResponse(input) {
  return {
    schemaVersion: 'cross-chapter-extraction-1', inputHash: input.inputHash, manuscriptSha256: input.manuscript.manuscriptSha256,
    checkedChapterIds: frozen.manuscript.chapters.map(chapter => chapter.id),
    chapterCoverage: frozen.manuscript.chapters.map(chapter => ({ chapterId: chapter.id, claimIds: claims.filter(claim => claim.chapterId === chapter.id).map(claim => claim.id), extractionNote: `已完整检查${chapter.title}的时间、主体、次数和物件状态。` })),
    entities, events, claims, comparisonGroups,
    unpairedClaims: [{ claimId: 'officer-received-key', reason: 'no_comparable_claim', rationale: '只有一处警员接收钥匙的事实，不制造伪比较。' }],
  };
}

const reasonToCheck = { lying: 'lying', misremembering: 'misremembering', normal_change: 'normalChange', different_rounds: 'differentRounds', intentional_omission: 'intentionalOmission', different_entity: 'differentEntity' };

function findingFor(spec) {
  const group = comparisonGroups.find(item => item.id === spec.groupId);
  const findingEvidence = group.claimIds.flatMap((claimId, index) => claims.find(item => item.id === claimId).evidence.map(item => ({ claimId, chapterId: item.chapterId, quote: item.quote, start: item.start, role: index === 0 ? 'support' : 'counter' })));
  const selected = reasonToCheck[spec.resolutionReason];
  const counterchecks = Object.fromEntries(['lying', 'misremembering', 'normalChange', 'differentRounds', 'intentionalOmission', 'differentEntity'].map(name => {
    let checkEvidence = name === selected ? findingEvidence : [];
    if (spec.groupId === 'entry-deliberate-lie' && name === 'lying') {
      const context = evidence('chapter-2', '她明知监控存在，仍故意说');
      checkEvidence = [{ claimId: null, chapterId: context.chapterId, quote: context.quote, start: context.start, role: 'counter' }];
    }
    if (spec.groupId === 'arrival-misremembered' && name === 'misremembering') {
      const context = evidence('chapter-3', '她承认这段记忆很模糊');
      checkEvidence = [{ claimId: null, chapterId: context.chapterId, quote: context.quote, start: context.start, role: 'counter' }];
    }
    if (spec.groupId === 'key-normal-transition' && name === 'normalChange') {
      const external = claims.find(claim => claim.id === 'officer-received-key').evidence[0];
      checkEvidence = [...checkEvidence, { claimId: 'officer-received-key', chapterId: external.chapterId, quote: external.quote, start: external.start, role: 'counter' }];
    }
    if (spec.groupId === 'folder-unexplained' && name === 'normalChange') {
      const context = evidence('chapter-3', '走廊记录显示九点前后无人靠近北侧书架');
      checkEvidence = [{ claimId: null, chapterId: context.chapterId, quote: context.quote, start: context.start, role: 'counter' }];
    }
    return [name, {
      assessment: name === selected ? 'supported' : spec.status === 'confirmed_conflict' ? 'refuted' : 'unknown',
      rationale: name === selected ? `${name} 反证由逐字证据支持。` : `${name} 未获足够证据支持。`,
      evidence: checkEvidence,
    }];
  }));
  const sameEventDecision = spec.resolutionReason === 'different_rounds' || spec.resolutionReason === 'different_entity' ? 'different' : spec.status === 'ambiguous' ? 'uncertain' : 'same';
  return { groupId: spec.groupId, status: spec.status, summary: `固定样本核对：${spec.groupId}`, sameEventDecision, resolutionReason: spec.resolutionReason, evidence: findingEvidence, counterchecks };
}

function adjudicationResponse(input) {
  return {
    schemaVersion: 'cross-chapter-adjudication-1', inputHash: input.inputHash, extractionResultSha256: input.extractionResultSha256,
    checkedChapterIds: frozen.manuscript.chapters.map(chapter => chapter.id),
    checkedGroupIds: comparisonGroups.map(group => group.id),
    findings: expected.expectedFindings.map(findingFor),
  };
}

function modelFor({ invalidFirstExtraction = false, invalidEvidenceStart = false } = {}) {
  const calls = [];
  let extractionFailed = false;
  return {
    calls,
    async complete(request) {
      calls.push(request);
      assert.equal(request.allowRecovery, false);
      assert.equal(request.modelPolicy, WHOLE_QUALITY_MODEL_POLICY);
      assert.equal(request.maxTokens, request.stage.startsWith(CROSS_CHAPTER_STAGES.extract) ? 14000 : 16000);
      request.onReceipt({ provider: 'fixture-provider', model: 'fixture-model', stage: request.stage });
      const wire = JSON.parse(request.user);
      if (request.stage === CROSS_CHAPTER_STAGES.extract && invalidFirstExtraction && !extractionFailed) {
        extractionFailed = true;
        return '{';
      }
      if (request.stage === CROSS_CHAPTER_STAGES.extract && invalidEvidenceStart && !extractionFailed) {
        extractionFailed = true;
        const invalid = structuredClone(extractionResponse(wire));
        invalid.claims[0].evidence[0].start = 999999;
        return JSON.stringify(invalid);
      }
      if (request.stage === `${CROSS_CHAPTER_STAGES.extract}:format-repair`) return JSON.stringify(extractionResponse(wire.originalInput));
      if (request.stage === CROSS_CHAPTER_STAGES.extract) return JSON.stringify(extractionResponse(wire));
      if (request.stage === CROSS_CHAPTER_STAGES.adjudicate) return JSON.stringify(adjudicationResponse(wire));
      throw new Error(`Unexpected stage ${request.stage}`);
    },
  };
}

test('prepares a full-manuscript extract packet with the product policy and no diagnosis fields', () => {
  const context = prepareCrossChapterExtraction(frozen.manuscript);
  assert.equal(context.prepared.stage, 'whole-quality:cross-chapter:extract');
  assert.equal(context.prepared.modelInput.implementationVersion, CROSS_CHAPTER_IMPLEMENTATION_VERSION);
  assert.equal(context.prepared.modelInput.protocolSystemVersion, CROSS_CHAPTER_PROTOCOL_SYSTEM_VERSION);
  assert.equal(context.prepared.modelInput.modelPolicy, WHOLE_QUALITY_MODEL_POLICY);
  assert.equal(context.prepared.modelInput.reviewPolicy.mode, 'critical_fact_ledger');
  assert.equal(context.prepared.modelInput.reviewPolicy.maxClaims, 80);
  assert.equal(context.prepared.modelInput.attentionAnchors.schemaVersion, CROSS_CHAPTER_ATTENTION_ANCHOR_VERSION);
  assert.equal(context.prepared.modelInput.attentionAnchors.semantics, 'reading_attention_only_not_evidence_or_conflict');
  assert.equal(context.prepared.modelInput.responseContract.schemaVersion, 'cross-chapter-extraction-compact-1');
  assert.ok(context.prepared.system.includes('章节后半不能因为前面卡片过多而省略'));
  assert.deepEqual(context.prepared.modelInput.manuscript.chapters.map(chapter => chapter.id), expected.chapterIds);
  const serialized = JSON.stringify(context.prepared.modelInput);
  for (const forbidden of ['diagnosis', 'knownIssues', 'authorPlan', 'mustFix', 'gpt-5.6-sol']) assert.equal(serialized.includes(forbidden), false);
});

test('r06 attention anchors are neutral, UTF-16 exact, per-chapter bounded, and cover later chapters', () => {
  const anchorManuscript = {
    id: 'neutral-attention-anchor-fixture',
    chapters: [
      { id: 'early', body: '😀序言\r\n昨天，值班员请求同伴开门；同伴拒绝。铃响三声。' },
      { id: 'middle', body: '第二天，他回想当时没人允许移动木箱，也没有按启动钮。记录写了两次。' },
      { id: 'late', body: Array.from({ length: 14 }, (_, index) => `第${index + 1}段：那天有人要求复核，另一人不肯签字，设备响了${index + 1}次。`).join('\r\n') },
    ],
  };
  const anchors = buildCrossChapterAttentionAnchors(anchorManuscript);
  assert.equal(anchors.schemaVersion, CROSS_CHAPTER_ATTENTION_ANCHOR_VERSION);
  assert.equal(anchors.semantics, 'reading_attention_only_not_evidence_or_conflict');
  assert.deepEqual(anchors.chapters.map(chapter => chapter.chapterId), ['early', 'middle', 'late']);
  assert.ok(anchors.chapters.every(chapter => chapter.anchorCount > 0 && chapter.anchorCount <= 8));
  assert.ok(anchors.chapters.at(-1).anchorCount > 0, 'a busy first chapter must not consume later chapter coverage');
  assert.ok(anchors.chapters.flatMap(chapter => chapter.anchors).some(anchor => anchor.kind === 'quantity_statement'));

  const bodies = new Map(anchorManuscript.chapters.map(chapter => [chapter.id, chapter.body]));
  for (const chapter of anchors.chapters) {
    const counts = new Map();
    for (const anchor of chapter.anchors) {
      const body = bodies.get(chapter.chapterId);
      assert.equal(anchor.quote, body.slice(anchor.start, anchor.end));
      assert.equal(anchor.trigger, body.slice(anchor.triggerStart, anchor.triggerEnd));
      assert.ok(anchor.start <= anchor.triggerStart && anchor.triggerEnd <= anchor.end);
      assert.ok(anchor.quote.length <= 360);
      assert.equal(anchor.chapterId, chapter.chapterId);
      assert.equal(Object.hasOwn(anchor, 'status'), false);
      assert.equal(Object.hasOwn(anchor, 'conflict'), false);
      counts.set(anchor.kind, (counts.get(anchor.kind) ?? 0) + 1);
    }
    assert.ok([...counts.values()].every(count => count <= 2));
  }
  const earlyRelative = anchors.chapters[0].anchors.find(anchor => anchor.trigger === '昨天');
  assert.equal(earlyRelative.triggerStart, anchorManuscript.chapters[0].body.indexOf('昨天'));
  assert.equal(earlyRelative.triggerStart, 6, 'emoji is two UTF-16 code units and CRLF is two code units');

  const prepared = prepareCrossChapterExtraction(anchorManuscript);
  assert.deepEqual(prepared.prepared.modelInput.attentionAnchors, anchors);
  assert.match(prepared.prepared.system, /只是中立阅读路标，不是claim、证据、矛盾/);
  assert.match(prepared.prepared.system, /从全文寻找/);
  assert.match(prepared.prepared.system, /找不到可比较另一侧时.*unpaired/);
  assert.equal(prepared.prepared.system.includes('安禾'), false);
  assert.equal(prepared.prepared.system.includes('雾号'), false);

  const emptyLedger = {
    schemaVersion: 'cross-chapter-extraction-compact-1',
    chapterCoverage: anchorManuscript.chapters.map(chapter => ({ chapterId: chapter.id, extractionNote: '已检查anchor附近及全文对应场景，未形成可支持的比较。' })),
    comparisons: [],
    unpaired: [],
  };
  const normalized = inspectCrossChapterExtractionResponse(JSON.stringify(emptyLedger), prepared);
  assert.equal(normalized.claims.length, 0, 'host attention anchors must not become claims or conflicts');
  assert.equal(normalized.comparisonGroups.length, 0);

  const maxChapterManuscript = {
    chapters: Array.from({ length: 100 }, (_, index) => ({
      id: `budget-${index + 1}`,
      body: Array.from({ length: 12 }, (__, cue) => `昨天记录第${cue + 1}轮：有人请求复核，另一人拒绝，设备响了${cue + 1}次，但没有按按钮。`).join('\n'),
    })),
  };
  const budgetContext = prepareCrossChapterExtraction(maxChapterManuscript);
  const budgetAnchors = budgetContext.prepared.modelInput.attentionAnchors;
  assert.equal(budgetAnchors.chapters.length, 100);
  assert.ok(budgetAnchors.chapters.every(chapter => chapter.anchorCount > 0 && chapter.anchorCount <= 8));
  assert.ok(budgetAnchors.totalAnchors <= 800);
  assert.ok(budgetAnchors.chapters.at(-1).anchorCount > 0);
  assert.ok(budgetContext.prepared.user.length <= 900000);
});

test('r08 restores only a unique whitespace-only continuous quote and records normalization audit', () => {
  const manuscript = {
    chapters: [{ id: 'q1', body: '😀甲问：“可以现在开门吗？”\r\n乙答：“不行，刚才没有允许开门。”\r\n旁白保持沉默。' }],
  };
  const context = prepareCrossChapterExtraction(manuscript);
  const wire = {
    schemaVersion: 'cross-chapter-extraction-compact-1',
    chapterCoverage: [{ chapterId: 'q1', extractionNote: '检查连续问答和否定动作。' }],
    comparisons: [],
    unpaired: [{
      dimension: 'actor', subject: '开门请求', aspect: '是否允许开门', reason: 'no_comparable_claim', rationale: '全文没有支持另一侧，不制造比较。',
      claim: { chapterId: 'q1', quote: '甲问：“可以现在开门吗？” 乙答：“不行，刚才没有允许开门。”', value: '拒绝开门', timeScope: '当前问答', eventRound: '同一轮', epistemic: 'dialogue_claim' },
    }],
  };
  const raw = JSON.stringify(wire);
  const normalized = inspectCrossChapterExtractionResponse(raw, context);
  assert.equal(JSON.stringify(wire), raw, 'host normalization must not mutate the model response object');
  const evidenceItem = normalized.claims[0].evidence[0];
  const restoredQuote = '甲问：“可以现在开门吗？”\r\n乙答：“不行，刚才没有允许开门。”';
  assert.equal(evidenceItem.quote, restoredQuote);
  assert.equal(evidenceItem.start, manuscript.chapters[0].body.indexOf(restoredQuote));
  assert.equal(evidenceItem.end, evidenceItem.start + restoredQuote.length);
  assert.equal(evidenceItem.normalizationAudit.kind, 'whitespace_only_unique_contiguous');
  assert.equal(evidenceItem.normalizationAudit.suppliedQuote, wire.unpaired[0].claim.quote);
  assert.equal(evidenceItem.normalizationAudit.start, evidenceItem.start);
  assert.equal(evidenceItem.normalizationAudit.end, evidenceItem.end);

  const punctuationChange = structuredClone(wire);
  punctuationChange.unpaired[0].claim.quote = '甲问：“可以现在开门吗！” 乙答：“不行，刚才没有允许开门。”';
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(punctuationChange), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_QUOTE'));

  const explicitWrongStart = structuredClone(normalized);
  explicitWrongStart.claims[0].evidence[0] = { chapterId: 'q1', quote: wire.unpaired[0].claim.quote, start: 0 };
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(explicitWrongStart), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_START'));

  const ambiguousManuscript = { chapters: [{ id: 'q1', body: `${restoredQuote}\n---\n${restoredQuote}` }] };
  const ambiguousContext = prepareCrossChapterExtraction(ambiguousManuscript);
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(wire), ambiguousContext), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_QUOTE_WHITESPACE_AMBIGUOUS'));
});

test('r08 removes only model-added boundary quote marks from long unique exact spans and audits the restoration', () => {
  const manuscript = {
    chapters: [{
      id: 'q1',
      body: '林工说：“阿泽明早跟老陈他们出海，近海，一天来回。傍晚前回来。”\n她又补充：“日期我再核。原定明天跟老陈那条船汇合的事，取消，船不等你。”\n附页写着足够长的完整连续证据文本。',
    }],
  };
  const context = prepareCrossChapterExtraction(manuscript);
  assert.equal(context.prepared.modelInput.implementationVersion, 'cross-chapter-review-r08');
  assert.equal(context.prepared.modelInput.protocolSystemVersion, 'cross-chapter-protocol-system-r08');
  assert.match(context.prepared.system, /不要为了让片段看似完整而自行补写首尾引号/);

  const wire = {
    schemaVersion: 'cross-chapter-extraction-compact-1',
    chapterCoverage: [{ chapterId: 'q1', extractionNote: '检查三个连续原文片段。' }],
    comparisons: [],
    unpaired: [
      {
        dimension: 'time', subject: '出海安排', aspect: '返程范围', reason: 'no_comparable_claim', rationale: '只有一处安排陈述。',
        claim: { chapterId: 'q1', quote: '“阿泽明早跟老陈他们出海，近海，一天来回。”', value: '近海一天来回', timeScope: '明早', eventRound: '出海安排', epistemic: 'dialogue_claim' },
      },
      {
        dimension: 'actor', subject: '汇合安排', aspect: '是否取消', reason: 'no_comparable_claim', rationale: '只有一处取消陈述。',
        claim: { chapterId: 'q1', quote: '“原定明天跟老陈那条船汇合的事，取消，船不等你。”', value: '取消汇合', timeScope: '当前通知', eventRound: '汇合安排', epistemic: 'dialogue_claim' },
      },
      {
        dimension: 'object_state', subject: '附页', aspect: '文本状态', reason: 'no_comparable_claim', rationale: '只有一处附页文本。',
        claim: { chapterId: 'q1', quote: '"足够长的完整连续证据文本"', value: '存在文本', timeScope: '附页当前', eventRound: '附页记录', epistemic: 'narrated_fact' },
      },
    ],
  };
  const raw = JSON.stringify(wire);
  const normalized = inspectCrossChapterExtractionResponse(raw, context);
  assert.equal(JSON.stringify(wire), raw, 'host normalization must not mutate the parsed model response');
  const evidenceItems = normalized.claims.map(claim => claim.evidence[0]);
  assert.deepEqual(evidenceItems.map(item => item.quote), [
    '“阿泽明早跟老陈他们出海，近海，一天来回。',
    '原定明天跟老陈那条船汇合的事，取消，船不等你。”',
    '足够长的完整连续证据文本',
  ]);
  assert.deepEqual(evidenceItems.map(item => item.normalizationAudit.removedBoundaryCharacters), [
    [{ side: 'end', character: '”' }],
    [{ side: 'start', character: '“' }],
    [{ side: 'start', character: '"' }, { side: 'end', character: '"' }],
  ]);
  for (const [index, item] of evidenceItems.entries()) {
    assert.equal(item.normalizationAudit.kind, 'boundary_quote_only_unique_contiguous');
    assert.equal(item.normalizationAudit.suppliedQuote, wire.unpaired[index].claim.quote);
    assert.equal(item.normalizationAudit.restoredQuote, item.quote);
    assert.equal(item.normalizationAudit.reason, 'removed_model_added_boundary_quote_marks_from_unique_exact_source_span');
    assert.equal(item.quote, manuscript.chapters[0].body.slice(item.start, item.end));
  }

  for (const invalidQuote of [
    '“阿泽明早跟老陈他们出海；近海，一天来回。”',
    '“阿泽明早没跟老陈他们出海，近海，一天来回。”',
    '“阿泽明早跟老陈他们出海，近海，两天来回。”',
    '“阿明明早跟老陈他们出海，近海，一天来回。”',
  ]) {
    const invalid = structuredClone(wire);
    invalid.unpaired = [structuredClone(wire.unpaired[0])];
    invalid.unpaired[0].claim.quote = invalidQuote;
    assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(invalid), context), error =>
      error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_QUOTE'));
  }

  const explicitWrongStart = structuredClone(normalized);
  explicitWrongStart.claims[0].evidence[0] = { chapterId: 'q1', quote: wire.unpaired[0].claim.quote, start: 0 };
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(explicitWrongStart), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_START'));

  const short = structuredClone(wire);
  short.unpaired = [{
    dimension: 'time', subject: '短句', aspect: '内容', reason: 'no_comparable_claim', rationale: '短句不允许边界恢复。',
    claim: { chapterId: 'q1', quote: '“日期我再核。”', value: '再核日期', timeScope: '当前', eventRound: '短句', epistemic: 'dialogue_claim' },
  }];
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(short), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_QUOTE'));

  const duplicateText = '阿泽明早跟老陈他们出海，近海，一天来回。';
  const ambiguousManuscript = { chapters: [{ id: 'q1', body: `甲说：“${duplicateText}继续。”\n乙说：“${duplicateText}另行通知。”` }] };
  const ambiguousContext = prepareCrossChapterExtraction(ambiguousManuscript);
  const ambiguous = structuredClone(wire);
  ambiguous.chapterCoverage = [{ chapterId: 'q1', extractionNote: '检查重复安排。' }];
  ambiguous.unpaired = [structuredClone(wire.unpaired[0])];
  ambiguous.unpaired[0].claim.occurrence = 1;
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(ambiguous), ambiguousContext), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_QUOTE_BOUNDARY_AMBIGUOUS'));
});

test('runs two full passes and returns fixed positive, counterexample, entity, event, and ambiguous outcomes', async () => {
  const model = modelFor();
  const artifacts = {};
  const result = await reviewCrossChapter({ manuscript: frozen.manuscript, model, artifacts });
  assert.equal(model.calls.length, 2);
  assert.deepEqual(model.calls.map(call => call.stage), [CROSS_CHAPTER_STAGES.extract, CROSS_CHAPTER_STAGES.adjudicate]);
  assert.ok(model.calls.every(call => JSON.parse(call.user).manuscript.chapters.length === frozen.manuscript.chapters.length));
  assert.deepEqual(result.checkedChapterIds, expected.chapterIds);
  assert.deepEqual(result.findings.map(({ groupId, status, resolutionReason }) => ({ groupId, status, resolutionReason })), expected.expectedFindings);
  assert.equal(result.qualityPreset, false);
  assert.equal(result.implementationVersion, 'cross-chapter-review-r08');
  assert.equal(result.independentReviewProtocolMutation, false);
  assert.ok(result.findings.every(finding => finding.status !== 'no_change' && new Set(finding.evidence.map(item => `${item.chapterId}:${item.start}`)).size >= 2));
  assert.equal(result.findings.find(item => item.groupId === 'folder-unexplained').status, 'ambiguous');
  const folderCounterEvidence = result.findings.find(item => item.groupId === 'folder-unexplained').counterchecks.normalChange.evidence;
  assert.equal(folderCounterEvidence.length, 1);
  assert.equal(folderCounterEvidence[0].chapterId, 'chapter-3');
  assert.equal(folderCounterEvidence[0].claimId, null);
  assert.equal(folderCounterEvidence[0].sourceScope, 'manuscript_context');
  assert.equal(folderCounterEvidence[0].manuscriptSha256, result.manuscriptSha256);
  const keyCounterEvidence = result.findings.find(item => item.groupId === 'key-normal-transition').counterchecks.normalChange.evidence;
  assert.ok(keyCounterEvidence.some(item => item.claimId === 'officer-received-key' && item.sourceScope === 'external_claim'));
  assert.ok(result.findings.find(item => item.groupId === 'folder-unexplained').evidence.every(item => item.sourceScope === 'group_claim'));
  assert.equal(result.findings.find(item => item.groupId === 'same-chapter-clock-conflict').status, 'confirmed_conflict');
  assert.deepEqual(result.chapterCoverage.flatMap(item => item.claimIds).includes('officer-received-key'), true);
  assert.ok(Object.keys(artifacts).some(key => key.endsWith(':primary-response')));
  assert.ok(result.stageReceipts.every(receipt => /^[a-f0-9]{64}$/.test(receipt.primaryResponseSha256)));
});

test('resumes from raw-bound checkpoints without another model call and rejects tampering', async () => {
  const model = modelFor();
  const artifacts = {};
  const first = await reviewCrossChapter({ manuscript: frozen.manuscript, model, artifacts });
  const noCallModel = { async complete() { throw new Error('resume must not call model'); } };
  const resumed = await reviewCrossChapter({ manuscript: frozen.manuscript, model: noCallModel, artifacts });
  assert.deepEqual(resumed, first);
  const tampered = structuredClone(artifacts);
  tampered['whole-quality:cross-chapter:extract:primary-response'].rawResponse += ' ';
  await assert.rejects(() => reviewCrossChapter({ manuscript: frozen.manuscript, model: noCallModel, artifacts: tampered }), error => error.code === 'RESPONSE_CHECKPOINT');

  const forgedProtocol = structuredClone(artifacts);
  forgedProtocol['whole-quality:cross-chapter:extract:input'].input.protocolSystemVersion = 'untrusted-protocol';
  await assert.rejects(() => reviewCrossChapter({ manuscript: frozen.manuscript, model: noCallModel, artifacts: forgedProtocol }), error => error.code === 'CHECKPOINT_MISMATCH');

  const forgedLegacy = structuredClone(artifacts);
  for (const stage of ['extract', 'adjudicate']) {
    const input = forgedLegacy[`whole-quality:cross-chapter:${stage}:input`].input;
    input.implementationVersion = 'cross-chapter-review-r03';
    delete input.protocolSystemVersion;
  }
  await assert.rejects(() => reviewCrossChapter({ manuscript: frozen.manuscript, model: noCallModel, artifacts: forgedLegacy }), error => error.code === 'CHECKPOINT_MISMATCH');
});

test('allows one format repair for a stage and keeps recovery disabled for every transport call', async () => {
  const model = modelFor({ invalidFirstExtraction: true });
  const result = await reviewCrossChapter({ manuscript: frozen.manuscript, model, artifacts: {} });
  assert.deepEqual(model.calls.map(call => call.stage), [CROSS_CHAPTER_STAGES.extract, `${CROSS_CHAPTER_STAGES.extract}:format-repair`, CROSS_CHAPTER_STAGES.adjudicate]);
  assert.ok(model.calls.every(call => call.allowRecovery === false));
  assert.ok(result.stageReceipts[0].formatRepairResponseSha256);
});

test('passes precise evidence diagnostics into the only format repair', async () => {
  const model = modelFor({ invalidEvidenceStart: true });
  const artifacts = {};
  await reviewCrossChapter({ manuscript: frozen.manuscript, model, artifacts });
  const location = artifacts['whole-quality:cross-chapter:extract:repair-input'].repairInput.errorLocation;
  assert.equal(location.fieldPath, '$.claims.0.evidence.0');
  assert.equal(location.chapterId, 'chapter-1');
  assert.equal(location.quote, '同一批入库三只木箱');
  assert.equal(location.start, 999999);
  assert.equal(artifacts['whole-quality:cross-chapter:extract:repair-input'].repairInput.violations[0].code, 'EVIDENCE_START');
});

test('empty aliases are valid and one repair receives every illegal epistemic enum at once', async () => {
  let primarySent = false;
  const artifacts = {};
  const model = {
    async complete(request) {
      request.onReceipt({ provider: 'fixture-provider', model: 'fixture-model', stage: request.stage });
      const wire = JSON.parse(request.user);
      if (request.stage === CROSS_CHAPTER_STAGES.extract) {
        primarySent = true;
        const invalid = structuredClone(extractionResponse(wire));
        invalid.entities[0].aliases = [];
        invalid.claims[0].epistemic = 'character_report';
        invalid.claims[1].epistemic = 'character_statement';
        return JSON.stringify(invalid);
      }
      if (request.stage === `${CROSS_CHAPTER_STAGES.extract}:format-repair`) {
        const repaired = JSON.parse(wire.invalidResponse);
        repaired.claims[0].epistemic = 'dialogue_claim';
        repaired.claims[1].epistemic = 'memory';
        return JSON.stringify(repaired);
      }
      if (request.stage === CROSS_CHAPTER_STAGES.adjudicate) return JSON.stringify(adjudicationResponse(wire));
      throw new Error(`Unexpected stage ${request.stage}`);
    },
  };
  const result = await reviewCrossChapter({ manuscript: frozen.manuscript, model, artifacts });
  assert.equal(primarySent, true);
  assert.deepEqual(result.entities[0].aliases, []);
  const violations = artifacts['whole-quality:cross-chapter:extract:repair-input'].repairInput.violations;
  assert.deepEqual(violations.map(item => item.fieldPath), ['$.claims.0.epistemic', '$.claims.1.epistemic']);
  assert.ok(violations.every(item => item.code === 'ENUM' && item.allowed.includes('dialogue_claim')));
});

test('host locates a unique null start, requires occurrence for repeated quotes, and rejects wrong explicit starts', () => {
  const manuscript = [
    { id: 'same', title: '同章', body: '灯亮。灯亮。' },
    { id: 'other', title: '异章', body: '后来灯灭。' },
  ];
  const context = prepareCrossChapterExtraction(manuscript);
  const base = {
    schemaVersion: 'cross-chapter-extraction-1', inputHash: context.prepared.inputHash, manuscriptSha256: context.manuscript.manuscriptSha256,
    checkedChapterIds: ['same', 'other'],
    chapterCoverage: [{ chapterId: 'same', claimIds: ['on'], extractionNote: '检查重复引文。' }, { chapterId: 'other', claimIds: ['off'], extractionNote: '检查唯一引文。' }],
    entities: [{ id: 'lamp', canonicalName: '灯', aliases: ['灯'], kind: 'object' }],
    events: [{ id: 'lamp-event', canonicalKind: '灯状态', occurrenceKey: '同一观察', sequence: 1, participantEntityIds: [], objectEntityIds: ['lamp'], chapterIds: ['same', 'other'] }],
    claims: [
      { id: 'on', chapterId: 'same', dimension: 'object_state', entityIds: ['lamp'], eventId: 'lamp-event', subject: '灯', predicate: '状态', value: '亮', timeScope: '先前', eventRound: '同轮', epistemic: 'narrated_fact', evidence: [{ chapterId: 'same', quote: '灯亮', start: null, occurrence: 2 }] },
      { id: 'off', chapterId: 'other', dimension: 'object_state', entityIds: ['lamp'], eventId: 'lamp-event', subject: '灯', predicate: '状态', value: '灭', timeScope: '后来', eventRound: '同轮', epistemic: 'narrated_fact', evidence: [{ chapterId: 'other', quote: '灯灭', start: null }] },
    ],
    comparisonGroups: [{ id: 'lamp-group', dimension: 'object_state', claimIds: ['on', 'off'], entityIds: ['lamp'], eventIds: ['lamp-event'], rationale: '核对两个位置。' }],
    unpairedClaims: [],
  };
  const checked = inspectCrossChapterExtractionResponse(JSON.stringify(base), context);
  assert.equal(checked.claims[0].evidence[0].start, 3);
  assert.equal(checked.claims[1].evidence[0].start, 2);
  const noOccurrence = structuredClone(base);
  delete noOccurrence.claims[0].evidence[0].occurrence;
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(noOccurrence), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' &&
    error.violations.some(item => item.code === 'EVIDENCE_OCCURRENCE_REQUIRED' && item.fieldPath === '$.claims.0.evidence.0'));
  const wrongStart = structuredClone(base);
  wrongStart.claims[1].evidence[0].start = 0;
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(wrongStart), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' &&
    error.violations.some(item => item.code === 'EVIDENCE_START' && item.fieldPath === '$.claims.1.evidence.0'));
});

test('rejects a parseable format repair that changes frozen claims or findings', async () => {
  let primary;
  const model = {
    async complete(request) {
      request.onReceipt({ provider: 'fixture-provider', model: 'fixture-model', stage: request.stage });
      const wire = JSON.parse(request.user);
      if (request.stage === CROSS_CHAPTER_STAGES.extract) {
        primary = extractionResponse(wire);
        delete primary.chapterCoverage;
        return JSON.stringify(primary);
      }
      if (request.stage === `${CROSS_CHAPTER_STAGES.extract}:format-repair`) {
        const repaired = extractionResponse(wire.originalInput);
        repaired.claims.find(claim => claim.id === 'boxes-3').value = '2';
        return JSON.stringify(repaired);
      }
      throw new Error(`Unexpected stage ${request.stage}`);
    },
  };
  await assert.rejects(() => reviewCrossChapter({ manuscript: frozen.manuscript, model, artifacts: {} }), error => error.code === 'FORMAT_REPAIR_SEMANTIC_DRIFT');
});

const compactManuscript = {
  id: 'compact-boundary-case',
  chapters: [
    { id: 'c1', title: '开始', body: '灯亮。铃响三声。钥匙交给警员。灯亮。灯亮。' },
    { id: 'c2', title: '后来', body: '后来灯灭。日志写同一轮铃响两声。' },
    { id: 'c3', title: '反证', body: '维修记录说明有人先切断电源。走廊记录显示无人靠近。第二轮铃响一声。第二轮记录仍是一声。' },
  ],
};

function compactExtractionResponse() {
  return {
    schemaVersion: 'cross-chapter-extraction-compact-1',
    chapterCoverage: compactManuscript.chapters.map(chapter => ({ chapterId: chapter.id, extractionNote: `已检查${chapter.title}的关键约束事实。` })),
    comparisons: [{
      dimension: 'object_state',
      subject: '设备灯',
      aspect: '同一轮状态',
      rationale: '核对同一设备在同轮记录中的状态。',
      claims: [
        { chapterId: 'c1', quote: '灯亮', occurrence: 1, value: '亮', timeScope: '开始', eventRound: '同一轮', epistemic: 'narrated_fact' },
        { chapterId: 'c2', quote: '后来灯灭', value: '灭', timeScope: '后来', eventRound: '同一轮', epistemic: 'narrated_fact' },
      ],
    }],
    unpaired: [{
      dimension: 'actor',
      subject: '维修员',
      aspect: '断电操作',
      claim: { chapterId: 'c3', quote: '维修记录说明有人先切断电源', value: '先切断电源', timeScope: '状态变化前', eventRound: '同一轮', epistemic: 'narrated_fact' },
      reason: 'no_comparable_claim',
      rationale: '只有一处明确记录，保留作第二遍组外反证。',
    }],
  };
}

function compactCounterchecks() {
  return Object.fromEntries(['lying', 'misremembering', 'normalChange', 'differentRounds', 'intentionalOmission', 'differentEntity'].map(name => [name, {
    assessment: name === 'normalChange' ? 'supported' : 'unknown',
    rationale: name === 'normalChange' ? '组外维修记录支持正常状态变化。' : `${name} 没有足够证据。`,
    evidence: name === 'normalChange'
      ? [{ claimId: 'claim-3', role: 'counter' }]
      : name === 'intentionalOmission'
        ? [{ claimId: null, chapterId: 'c3', quote: '走廊记录显示无人靠近', role: 'counter' }]
        : [],
  }]));
}

function compactAdjudicationResponse() {
  return {
    schemaVersion: 'cross-chapter-adjudication-compact-1',
    checkedChapterIds: ['c1', 'c2', 'c3'],
    findings: [{
      groupId: 'group-1',
      status: 'resolved',
      summary: '维修记录解释了灯由亮到灭的变化。',
      sameEventDecision: 'same',
      resolutionReason: 'normal_change',
      evidence: [{ claimId: 'claim-1', role: 'support' }, { claimId: 'claim-2', role: 'counter' }],
      counterchecks: compactCounterchecks(),
    }],
  };
}

test('compact extract and adjudicate are expanded into the strict normalized host-bound contract', async () => {
  const calls = [];
  const artifacts = {};
  const model = {
    async complete(request) {
      calls.push(request);
      request.onReceipt({ provider: 'fixture-provider', model: 'fixture-model', stage: request.stage });
      if (request.stage === CROSS_CHAPTER_STAGES.extract) return JSON.stringify(compactExtractionResponse());
      if (request.stage === CROSS_CHAPTER_STAGES.adjudicate) return JSON.stringify(compactAdjudicationResponse());
      throw new Error(`Unexpected stage ${request.stage}`);
    },
  };
  const result = await reviewCrossChapter({ manuscript: compactManuscript, model, artifacts });
  assert.deepEqual(calls.map(call => call.stage), [CROSS_CHAPTER_STAGES.extract, CROSS_CHAPTER_STAGES.adjudicate]);
  assert.deepEqual(result.checkedChapterIds, ['c1', 'c2', 'c3']);
  assert.deepEqual(result.claims.map(claim => claim.id), ['claim-1', 'claim-2', 'claim-3']);
  assert.deepEqual(result.comparisonGroups.map(group => group.id), ['group-1']);
  assert.equal(result.claims[0].evidence[0].start, 0);
  assert.equal(result.claims[0].evidence[0].occurrence, 1);
  assert.equal(result.claims[0].evidence[0].manuscriptSha256, undefined);
  assert.equal(result.inputHash, undefined);
  assert.equal(result.findings[0].inputHash, undefined);
  assert.equal(result.findings[0].evidence[0].sourceScope, 'group_claim');
  assert.equal(result.findings[0].counterchecks.normalChange.evidence[0].sourceScope, 'external_claim');
  assert.equal(result.findings[0].counterchecks.intentionalOmission.evidence[0].sourceScope, 'manuscript_context');
  assert.equal(result.findings[0].counterchecks.intentionalOmission.evidence[0].manuscriptSha256, result.manuscriptSha256);
  const extractInput = artifacts['whole-quality:cross-chapter:extract:input'];
  const extractRaw = artifacts['whole-quality:cross-chapter:extract:primary-response'];
  assert.equal(extractRaw.inputHash, extractInput.inputHash);
  assert.equal(extractRaw.requestSha256, extractInput.requestSha256);
  assert.match(extractRaw.responseSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.parse(extractRaw.rawResponse).schemaVersion, 'cross-chapter-extraction-compact-1');
});

test('compact extraction keeps closed roots, full coverage, enums, exact quotes, occurrence, and two positions strict', () => {
  const context = prepareCrossChapterExtraction(compactManuscript);
  const valid = compactExtractionResponse();
  const normalized = inspectCrossChapterExtractionResponse(JSON.stringify(valid), context);
  assert.equal(normalized.inputHash, context.prepared.inputHash);
  assert.equal(normalized.manuscriptSha256, context.manuscript.manuscriptSha256);
  assert.deepEqual(normalized.checkedChapterIds, ['c1', 'c2', 'c3']);

  const extraRoot = structuredClone(valid);
  extraRoot.inputHash = 'model-must-not-supply-host-binding';
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(extraRoot), context), error => error.code === 'COMPACT_EXTRACTION_FIELDS');

  const invalidEnum = structuredClone(valid);
  invalidEnum.comparisons[0].dimension = 'other';
  invalidEnum.comparisons[0].claims[0].epistemic = 'character_report';
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(invalidEnum), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'ENUM'));

  const forgedQuote = structuredClone(valid);
  forgedQuote.comparisons[0].claims[1].quote = '正文中不存在的灯状态';
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(forgedQuote), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_QUOTE'));

  const repeatedWithoutOccurrence = structuredClone(valid);
  delete repeatedWithoutOccurrence.comparisons[0].claims[0].occurrence;
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(repeatedWithoutOccurrence), context), error =>
    error.code === 'EXTRACTION_CONTRACT_VIOLATIONS' && error.violations.some(item => item.code === 'EVIDENCE_OCCURRENCE_REQUIRED'));

  const secondOccurrence = structuredClone(valid);
  secondOccurrence.comparisons[0].claims[0].occurrence = 2;
  const located = inspectCrossChapterExtractionResponse(JSON.stringify(secondOccurrence), context);
  assert.equal(located.claims[0].evidence[0].start, compactManuscript.chapters[0].body.indexOf('灯亮', 1));

  const missingChapter = structuredClone(valid);
  missingChapter.chapterCoverage.pop();
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(missingChapter), context), error => error.code === 'EXTRACTION_CHAPTER_COVERAGE');

  const samePosition = structuredClone(valid);
  samePosition.comparisons[0].claims[1] = structuredClone(samePosition.comparisons[0].claims[0]);
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(samePosition), context), error => error.code === 'GROUP_COMPARABILITY');
});

test('compact singleton comparisons normalize to unpaired without inventing evidence while empty groups remain invalid', () => {
  const context = prepareCrossChapterExtraction(compactManuscript);
  const singleton = compactExtractionResponse();
  singleton.comparisons = [{
    dimension: 'count',
    subject: '孤立计数事实',
    aspect: '记录数量',
    rationale: '模型误建了只有一侧的比较组。',
    claims: [{ chapterId: 'c2', quote: '后来灯灭', value: '灭', timeScope: '后来', eventRound: '同一轮', epistemic: 'narrated_fact' }],
  }];
  singleton.unpaired = [];
  const originalRaw = JSON.stringify(singleton);
  const normalized = inspectCrossChapterExtractionResponse(originalRaw, context);

  assert.equal(JSON.stringify(singleton), originalRaw);
  assert.equal(normalized.comparisonGroups.length, 0);
  assert.equal(normalized.claims.length, 1);
  assert.deepEqual(normalized.claims[0].evidence.map(item => item.quote), ['后来灯灭']);
  assert.deepEqual(normalized.unpairedClaims.map(item => ({ claimId: item.claimId, reason: item.reason })), [{ claimId: 'claim-1', reason: 'no_comparable_claim' }]);
  assert.match(normalized.unpairedClaims[0].rationale, /^HOST_NORMALIZED_SINGLETON_COMPARISON: /);
  assert.match(normalized.unpairedClaims[0].rationale, /模型误建了只有一侧的比较组/);

  const empty = compactExtractionResponse();
  empty.comparisons[0].claims = [];
  assert.throws(() => inspectCrossChapterExtractionResponse(JSON.stringify(empty), context), error => error.code === 'COMPACT_GROUP_CLAIMS');
});

test('compact adjudication keeps roots, enums, group coverage, repeated context, and external evidence strict', () => {
  const extractionContext = prepareCrossChapterExtraction(compactManuscript);
  const extraction = inspectCrossChapterExtractionResponse(JSON.stringify(compactExtractionResponse()), extractionContext);
  const context = prepareCrossChapterAdjudication(extractionContext, extraction);
  const valid = compactAdjudicationResponse();
  const normalized = inspectCrossChapterAdjudicationResponse(JSON.stringify(valid), context);
  assert.equal(normalized.inputHash, context.prepared.inputHash);
  assert.equal(normalized.extractionResultSha256, context.extractionResultSha256);
  assert.deepEqual(normalized.checkedGroupIds, ['group-1']);

  const extraRoot = structuredClone(valid);
  extraRoot.extractionResultSha256 = 'model-must-not-supply-host-binding';
  assert.throws(() => inspectCrossChapterAdjudicationResponse(JSON.stringify(extraRoot), context), error => error.code === 'COMPACT_ADJUDICATION_FIELDS');

  const invalidStatus = structuredClone(valid);
  invalidStatus.findings[0].status = 'no_change';
  assert.throws(() => inspectCrossChapterAdjudicationResponse(JSON.stringify(invalidStatus), context), error => error.code === 'FINDING_VALUE');

  const missingGroupSide = structuredClone(valid);
  missingGroupSide.findings[0].evidence = [{ claimId: 'claim-1', role: 'support' }, { claimId: 'claim-1', role: 'counter' }];
  assert.throws(() => inspectCrossChapterAdjudicationResponse(JSON.stringify(missingGroupSide), context), error => error.code === 'FINDING_CLAIM_COVERAGE');

  const forgedContext = structuredClone(valid);
  forgedContext.findings[0].counterchecks.intentionalOmission.evidence[0].quote = '正文中没有这条反证';
  assert.throws(() => inspectCrossChapterAdjudicationResponse(JSON.stringify(forgedContext), context), error => error.code === 'EVIDENCE_QUOTE');

  const repeatedContext = structuredClone(valid);
  repeatedContext.findings[0].counterchecks.intentionalOmission.evidence[0] = { claimId: null, chapterId: 'c1', quote: '灯亮', role: 'counter' };
  assert.throws(() => inspectCrossChapterAdjudicationResponse(JSON.stringify(repeatedContext), context), error => error.code === 'EVIDENCE_OCCURRENCE_REQUIRED');
});

test('compact format repair cannot change a claim judgment while fixing structure', async () => {
  const primary = compactExtractionResponse();
  primary.unexpected = true;
  const model = {
    async complete(request) {
      request.onReceipt({ provider: 'fixture-provider', model: 'fixture-model', stage: request.stage });
      if (request.stage === CROSS_CHAPTER_STAGES.extract) return JSON.stringify(primary);
      if (request.stage === `${CROSS_CHAPTER_STAGES.extract}:format-repair`) {
        const repaired = compactExtractionResponse();
        repaired.comparisons[0].claims[0].value = '暗';
        return JSON.stringify(repaired);
      }
      throw new Error(`Unexpected stage ${request.stage}`);
    },
  };
  await assert.rejects(() => reviewCrossChapter({ manuscript: compactManuscript, model, artifacts: {} }), error => error.code === 'FORMAT_REPAIR_SEMANTIC_DRIFT');
});

test('compact contract requires atomic minimal groups while host permits evidence reuse without semantic string inference', () => {
  const context = prepareCrossChapterExtraction(compactManuscript);
  assert.ok(context.prepared.modelInput.responseContract.rules.some(rule => rule.includes('每条claim只能表达')));
  assert.ok(context.prepared.modelInput.responseContract.rules.some(rule => rule.includes('最小双向对照')));
  const base = compactExtractionResponse();
  const mixed = structuredClone(base);
  mixed.comparisons = [{
    dimension: 'count', subject: '报时铃', aspect: '鸣响次数', rationale: '把多轮记录放在一个大组。',
    claims: [
      { chapterId: 'c1', quote: '铃响三声', value: '3', timeScope: '第一轮', eventRound: '第一轮', epistemic: 'narrated_fact' },
      { chapterId: 'c2', quote: '同一轮铃响两声', value: '2', timeScope: '第一轮', eventRound: '第一轮', epistemic: 'narrated_fact' },
      { chapterId: 'c3', quote: '第二轮铃响一声', value: '1', timeScope: '第二轮', eventRound: '第二轮', epistemic: 'narrated_fact' },
      { chapterId: 'c3', quote: '第二轮记录仍是一声', value: '1', timeScope: '第二轮', eventRound: '第二轮', epistemic: 'narrated_fact' },
    ],
  }];
  mixed.unpaired = [];
  assert.equal(inspectCrossChapterExtractionResponse(JSON.stringify(mixed), context).comparisonGroups.length, 1);

  const split = structuredClone(mixed);
  split.comparisons = [
    { ...mixed.comparisons[0], rationale: '第一轮最小双向对照。', claims: mixed.comparisons[0].claims.slice(0, 2) },
    { ...mixed.comparisons[0], rationale: '第二轮最小双向对照。', claims: mixed.comparisons[0].claims.slice(2) },
    {
      dimension: 'object_state', subject: '第一轮报时', aspect: '是否完整', rationale: '同一证据约束另一个独立问题。',
      claims: [
        { chapterId: 'c1', quote: '铃响三声', value: '完整', timeScope: '第一轮', eventRound: '第一轮', epistemic: 'narrated_fact' },
        { chapterId: 'c2', quote: '同一轮铃响两声', value: '不完整', timeScope: '第一轮', eventRound: '第一轮', epistemic: 'narrated_fact' },
      ],
    },
  ];
  const normalized = inspectCrossChapterExtractionResponse(JSON.stringify(split), context);
  assert.equal(normalized.comparisonGroups.length, 3);
  const reused = normalized.claims.filter(claim => claim.evidence[0].quote === '铃响三声');
  assert.deepEqual(reused.map(claim => claim.id), ['claim-1', 'claim-5']);
  assert.equal(reused[0].evidence[0].start, reused[1].evidence[0].start);
});

test('generic deictic and role fixture protects prompt coverage and exact response location without asserting semantic success', () => {
  assert.equal(protection.boundary.includes('not a semantic-quality judgment'), true);
  assert.equal(protection.expectedProtocol.hostMustNotInferStatus, true);

  const extractionContext = prepareCrossChapterExtraction(protection.manuscript);
  const contractRules = extractionContext.prepared.modelInput.responseContract.rules.join('\n');
  assert.match(contractRules, /回顾性对白/);
  assert.match(contractRules, /施事、受事、否定词/);
  assert.match(contractRules, /相对日期/);
  assert.match(contractRules, /近指优先绑定当前对话和紧邻叙述/);
  assert.match(contractRules, /同一对话或紧邻即时叙述出现互斥事实/);
  assert.match(extractionContext.prepared.system, /完整链/);
  assert.match(extractionContext.prepared.system, /不得只因措辞像旧记录就强行回指/);

  const normalized = inspectCrossChapterExtractionResponse(JSON.stringify(protection.compactExtractionResponse), extractionContext);
  assert.equal(normalized.comparisonGroups.length, protection.expectedProtocol.comparisonCount);
  assert.equal(normalized.claims.length, protection.expectedProtocol.claimCount);
  assert.deepEqual(normalized.checkedChapterIds, protection.expectedProtocol.checkedChapterIds);
  const chaptersById = new Map(protection.manuscript.chapters.map(chapter => [chapter.id, chapter]));
  for (const claim of normalized.claims) {
    const evidenceItem = claim.evidence[0];
    assert.equal(evidenceItem.start, chaptersById.get(claim.chapterId).body.indexOf(evidenceItem.quote));
    assert.equal(evidenceItem.occurrence, 1);
  }
  const reused = normalized.claims.filter(claim => claim.evidence[0].quote === protection.expectedProtocol.reusedQuote);
  assert.equal(reused.length, 2);
  assert.equal(reused[0].evidence[0].start, reused[1].evidence[0].start);

  const adjudicationContext = prepareCrossChapterAdjudication(extractionContext, normalized);
  const adjudicationRules = adjudicationContext.prepared.modelInput.responseContract.rules.join('\n');
  assert.match(adjudicationRules, /timeScope和eventRound只是待复核标签，不是独立证据/);
  assert.match(adjudicationRules, /施事、受事、否定与动作/);
  assert.match(adjudicationContext.prepared.system, /不得因为标签写着不同轮次就直接判differentRounds/);
  assert.match(adjudicationContext.prepared.system, /当前对话的近指/);
});

test('compact adjudication keeps unexplained object movement ambiguous unless a separate delayed-disclosure clue is cited', () => {
  const noClueManuscript = {
    chapters: [
      { id: 'o1', body: '清点时木盒仍在北架。' },
      { id: 'o2', body: '第二次清点时木盒已经不见。' },
      { id: 'o3', body: '值班记录没有说明谁移动了木盒。' },
    ],
  };
  const extractionWire = {
    schemaVersion: 'cross-chapter-extraction-compact-1',
    chapterCoverage: ['o1', 'o2', 'o3'].map(chapterId => ({ chapterId, extractionNote: '检查木盒位置与移动说明。' })),
    comparisons: [{
      dimension: 'object_state', subject: '木盒', aspect: '位置状态', rationale: '核对同一木盒前后位置。',
      claims: [
        { chapterId: 'o1', quote: '木盒仍在北架', value: '在北架', timeScope: '第一次清点', eventRound: '状态链', epistemic: 'narrated_fact' },
        { chapterId: 'o2', quote: '木盒已经不见', value: '不在北架', timeScope: '第二次清点', eventRound: '状态链', epistemic: 'narrated_fact' },
      ],
    }],
    unpaired: [],
  };
  const extractionContext = prepareCrossChapterExtraction(noClueManuscript);
  assert.ok(extractionContext.prepared.system.includes('互斥答案'));
  const extraction = inspectCrossChapterExtractionResponse(JSON.stringify(extractionWire), extractionContext);
  const context = prepareCrossChapterAdjudication(extractionContext, extraction);
  assert.ok(context.prepared.modelInput.responseContract.rules.some(rule => rule.includes('物件从出现到不见')));
  assert.ok(context.prepared.system.includes('不能把“没写”本身当作intentionalOmission'));
  const ambiguous = {
    schemaVersion: 'cross-chapter-adjudication-compact-1', checkedChapterIds: ['o1', 'o2', 'o3'], findings: [{
      groupId: 'group-1', status: 'ambiguous', summary: '正文未说明移动者与过程。', sameEventDecision: 'uncertain', resolutionReason: 'insufficient_context',
      evidence: [{ claimId: 'claim-1', role: 'support' }, { claimId: 'claim-2', role: 'counter' }],
      counterchecks: Object.fromEntries(['lying', 'misremembering', 'normalChange', 'differentRounds', 'intentionalOmission', 'differentEntity'].map(name => [name, { assessment: 'unknown', rationale: '没有明确反证。', evidence: [] }])),
    }],
  };
  assert.equal(inspectCrossChapterAdjudicationResponse(JSON.stringify(ambiguous), context).findings[0].status, 'ambiguous');

  const unsupportedResolved = structuredClone(ambiguous);
  unsupportedResolved.findings[0].status = 'resolved';
  unsupportedResolved.findings[0].sameEventDecision = 'same';
  unsupportedResolved.findings[0].resolutionReason = 'intentional_omission';
  unsupportedResolved.findings[0].counterchecks.intentionalOmission = {
    assessment: 'supported', rationale: '只凭中间动作没写就声称有意留白。', evidence: [{ claimId: 'claim-1', role: 'support' }],
  };

  const clueManuscript = structuredClone(noClueManuscript);
  clueManuscript.chapters[2].body = '附注明确写着：搬运记录将在下一章披露。';
  const clueWire = structuredClone(extractionWire);
  clueWire.unpaired = [{
    dimension: 'actor', subject: '叙述记录', aspect: '披露安排', reason: 'no_comparable_claim', rationale: '独立的延迟披露线索。',
    claim: { chapterId: 'o3', quote: '搬运记录将在下一章披露', value: '明确延迟披露', timeScope: '第二次清点后', eventRound: '披露安排', epistemic: 'narrated_fact' },
  }];
  const clueExtractionContext = prepareCrossChapterExtraction(clueManuscript);
  const clueExtraction = inspectCrossChapterExtractionResponse(JSON.stringify(clueWire), clueExtractionContext);
  const clueContext = prepareCrossChapterAdjudication(clueExtractionContext, clueExtraction);
  const supportedResolved = structuredClone(unsupportedResolved);
  supportedResolved.findings[0].counterchecks.intentionalOmission.evidence = [{ claimId: 'claim-3', role: 'counter' }];
  const resolved = inspectCrossChapterAdjudicationResponse(JSON.stringify(supportedResolved), clueContext);
  assert.equal(resolved.findings[0].status, 'resolved');
  assert.equal(resolved.findings[0].counterchecks.intentionalOmission.evidence[0].sourceScope, 'external_claim');
});

test('r08 conservatively keeps lying and misremembering explanations ambiguous without semantic guessing', () => {
  const manuscript = {
    chapters: [
      { id: 'w1', body: '值班记录写明：巡检在当天完成。门卫记录写着门已经锁好。维修前灯是熄灭的。' },
      { id: 'w2', body: '回顾者说巡检在第二天完成。他随后声称门当时没有锁。维修后灯已经亮起。' },
      { id: 'w3', body: '核对日历后，回顾者明确说：“我把日期记错了。”另一份笔录写着：“他承认先前是在撒谎。”窗外正在下雨。' },
    ],
  };
  const extractionWire = {
    schemaVersion: 'cross-chapter-extraction-compact-1',
    chapterCoverage: ['w1', 'w2', 'w3'].map(chapterId => ({ chapterId, extractionNote: '检查时间与门锁陈述。' })),
    comparisons: [
      {
        dimension: 'time', subject: '巡检', aspect: '完成日期', rationale: '核对同一巡检的完成日期。',
        claims: [
          { chapterId: 'w1', quote: '巡检在当天完成', value: '当天', timeScope: '记录当日', eventRound: '同一巡检', epistemic: 'narrated_fact' },
          { chapterId: 'w2', quote: '巡检在第二天完成', value: '第二天', timeScope: '事后回顾', eventRound: '同一巡检', epistemic: 'memory' },
        ],
      },
      {
        dimension: 'object_state', subject: '门', aspect: '是否锁好', rationale: '核对同一时点的门锁状态。',
        claims: [
          { chapterId: 'w1', quote: '门卫记录写着门已经锁好', value: '已锁', timeScope: '值班时', eventRound: '同一时点', epistemic: 'narrated_fact' },
          { chapterId: 'w2', quote: '他随后声称门当时没有锁', value: '未锁', timeScope: '事后陈述', eventRound: '同一时点', epistemic: 'dialogue_claim' },
        ],
      },
      {
        dimension: 'object_state', subject: '灯', aspect: '维修前后状态', rationale: '核对维修导致的正常状态变化。',
        claims: [
          { chapterId: 'w1', quote: '维修前灯是熄灭的', value: '熄灭', timeScope: '维修前', eventRound: '同一维修过程', epistemic: 'narrated_fact' },
          { chapterId: 'w2', quote: '维修后灯已经亮起', value: '亮起', timeScope: '维修后', eventRound: '同一维修过程', epistemic: 'narrated_fact' },
        ],
      },
    ],
    unpaired: [],
  };
  const extractionContext = prepareCrossChapterExtraction(manuscript);
  const extraction = inspectCrossChapterExtractionResponse(JSON.stringify(extractionWire), extractionContext);
  const context = prepareCrossChapterAdjudication(extractionContext, extraction);
  assert.match(context.prepared.system, /不能单独作为decisive explanation授权resolved/);
  assert.ok(context.prepared.modelInput.responseContract.rules.some(rule => rule.includes('必须保持ambiguous')));

  const counterchecks = (selected, evidenceItems) => Object.fromEntries(
    ['lying', 'misremembering', 'normalChange', 'differentRounds', 'intentionalOmission', 'differentEntity'].map(name => [name, {
      assessment: name === selected ? 'supported' : 'unknown',
      rationale: name === selected ? '另有独立原文明确支持。' : '没有足够独立证据。',
      evidence: name === selected ? evidenceItems : [],
    }]),
  );
  const resolvedByEpistemicClaims = {
    schemaVersion: 'cross-chapter-adjudication-compact-1',
    checkedChapterIds: ['w1', 'w2', 'w3'],
    findings: [
      {
        groupId: 'group-1', status: 'resolved', summary: '独立承认支持误记解释。', sameEventDecision: 'same', resolutionReason: 'misremembering',
        evidence: [{ claimId: 'claim-1', role: 'support' }, { claimId: 'claim-2', role: 'counter' }],
        counterchecks: counterchecks('misremembering', [{ claimId: null, chapterId: 'w3', quote: '回顾者明确说：“我把日期记错了。”', role: 'counter' }]),
      },
      {
        groupId: 'group-2', status: 'resolved', summary: '独立承认支持撒谎解释。', sameEventDecision: 'same', resolutionReason: 'lying',
        evidence: [{ claimId: 'claim-3', role: 'support' }, { claimId: 'claim-4', role: 'counter' }],
        counterchecks: counterchecks('lying', [{ claimId: null, chapterId: 'w3', quote: '他承认先前是在撒谎', role: 'counter' }]),
      },
      {
        groupId: 'group-3', status: 'resolved', summary: '维修解释了灯的真实状态变化。', sameEventDecision: 'same', resolutionReason: 'normal_change',
        evidence: [{ claimId: 'claim-5', role: 'support' }, { claimId: 'claim-6', role: 'counter' }],
        counterchecks: counterchecks('normalChange', [{ claimId: 'claim-5', role: 'support' }, { claimId: 'claim-6', role: 'counter' }]),
      },
    ],
  };
  const explicit = inspectCrossChapterAdjudicationResponse(JSON.stringify(resolvedByEpistemicClaims), context);
  assert.deepEqual(explicit.findings.map(item => [item.status, item.resolutionReason]), [
    ['ambiguous', 'insufficient_context'],
    ['ambiguous', 'insufficient_context'],
    ['resolved', 'normal_change'],
  ]);
  assert.equal(explicit.findings[0].counterchecks.misremembering.assessment, 'supported');
  assert.equal(explicit.findings[1].counterchecks.lying.assessment, 'supported');
  assert.deepEqual(explicit.findings[0].hostBoundary, {
    code: 'epistemic_explanation_requires_review',
    modelReportedStatus: 'resolved',
    modelReportedResolutionReason: 'misremembering',
    appliedStatus: 'ambiguous',
    appliedResolutionReason: 'insufficient_context',
  });
  assert.deepEqual(explicit.findings[1].hostBoundary, {
    code: 'epistemic_explanation_requires_review',
    modelReportedStatus: 'resolved',
    modelReportedResolutionReason: 'lying',
    appliedStatus: 'ambiguous',
    appliedResolutionReason: 'insufficient_context',
  });
  assert.equal(Object.hasOwn(explicit.findings[2], 'hostBoundary'), false);

  const weakEvidence = structuredClone(resolvedByEpistemicClaims);
  weakEvidence.findings[0].counterchecks.misremembering.evidence = [{ claimId: null, chapterId: 'w2', quote: '回顾者说', role: 'counter' }];
  weakEvidence.findings[1].counterchecks.lying.evidence = [{ claimId: null, chapterId: 'w3', quote: '窗外正在下雨', role: 'counter' }];
  const weakNormalized = inspectCrossChapterAdjudicationResponse(JSON.stringify(weakEvidence), context);
  assert.deepEqual(weakNormalized.findings.slice(0, 2).map(item => [item.status, item.resolutionReason]), [
    ['ambiguous', 'insufficient_context'],
    ['ambiguous', 'insufficient_context'],
  ]);
  assert.equal(weakNormalized.findings[0].counterchecks.misremembering.evidence[0].sourceScope, 'manuscript_context');
  assert.equal(weakNormalized.findings[1].counterchecks.lying.evidence[0].sourceScope, 'manuscript_context');
  assert.equal(weakNormalized.findings[0].hostBoundary.code, 'epistemic_explanation_requires_review');
  assert.equal(weakNormalized.findings[1].hostBoundary.code, 'epistemic_explanation_requires_review');
});

