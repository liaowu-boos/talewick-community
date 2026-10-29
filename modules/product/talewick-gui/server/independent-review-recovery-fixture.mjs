// Synthetic local-only input for the product/validation boundary regression.
// No provider, model transport, live task or literary-quality assertion.
import { randomUUID } from 'node:crypto';
import * as adapter from '../../../validation/runtime/independent-review-task.mjs';
import { IndependentReviewService } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

export async function createIndependentRecoveryFixture(rootDir, { family = false } = {}) {
  const first = '同一条记录。\n\n同一条记录。\n唯一尾句。\n末句。\n\n再一句。';
  const baseline = [{ id: 'c1', title: '记录', body: first }, { id: 'c2', title: '选择', body: '她仍等母亲替她决定去留。广播响了两遍。' }];
  const candidate = family ? [baseline[0], { ...baseline[1], body: '她独自登上去南城的车。广播响了两遍。' }] : baseline;
  const goals = family ? [{ id: 'g1', statement: '以行动承担选择', claimType: 'editorial_hypothesis',
    sourceEvidence: [{ chapterId: 'c2', quote: '仍等母亲替她决定去留', start: 1 }],
    counterCase: [{ chapterId: 'c1', quote: '唯一尾句。', start: first.indexOf('唯一尾句。') }],
    expectedEffect: '呈现自己的行动', failureCriterion: '仍然等待他人替她决定', requiredOutcomes: [{ id: 'o1', dimension: 'action', description: '承担选择代价' }] }] : [];
  const prepared = { caseId: `synthetic-${family ? 'family' : 'workplace'}`, mode: 'compare', baselineChapters: baseline,
    candidate: { mode: family ? 'revised' : 'no_change', chapters: candidate }, goals };
  const calls = [], repairCalls = [];
  const citation = (manuscript, quote = '唯一尾句。', start = null) => ({ blindId: manuscript.blindId, chapterId: 'c1', quote, start });
  const analyze = async input => {
    const index = calls.length; calls.push(input.stage); const packet = input.packet.protocolPacket;
    let response;
    if (input.stage === 'independent_reading') response = {
      schemaVersion: 'whole-quality-independent-reading-1', packetSha256: packet.packetSha256, readerId: packet.readerId,
      entries: [{ blindId: 'M', readScope: 'whole', overallImpression: '完整阅读的独立意见，保留不确定性。', claims: [{ id: `c-${index}`, claimType: 'editorial_hypothesis',
        statement: '人物情绪积累仍有不足。', evidence: [citation(packet.manuscripts[0], !family && index === 3 ? '同一条记录。' : '唯一尾句。')] }] }],
    };
    else if (input.stage === 'blind_pair') response = {
      schemaVersion: packet.schemaVersion, packetSha256: packet.packetSha256, readerId: packet.readerId,
      independentRecordSha256: input.packet.independentRecordSha256, preference: index === 4 ? 'mixed' : 'no_clear_preference',
      comparisons: [{ id: `p-${index}`, claimType: 'editorial_hypothesis', statement: '两稿仍各有不足，不能宣称整体改善。',
        severeHarm: { status: 'none', blindIds: [], evidence: [] }, evidence: packet.manuscripts.map(item => citation(item)) }],
    };
    else response = {
      schemaVersion: 'whole-quality-goal-audit-1', packetSha256: packet.packetSha256, blindPairRecordSha256s: input.packet.blindPairRecordSha256s,
      goalAssessments: family ? [{ goalId: 'g1', status: 'implemented', rationale: '这份判断应因未改动证据而失败。', failureCriterionMet: false,
        outcomes: [{ outcomeId: 'o1', status: 'implemented', explanation: '不能把未改动文字算作落实。',
          baselineEvidence: [citation(packet.baseline, '唯一尾句。'), citation(packet.baseline, '末句。再一句。')],
          candidateEvidence: [citation(packet.candidate, '唯一尾句。'), citation(packet.candidate, '末句。再一句。')] }] }] : [],
    };
    return { outputText: JSON.stringify(response), receipt: { provider: 'synthetic', invocationId: randomUUID(), contextId: randomUUID(), inputHash: input.inputHash } };
  };
  const analyzePositionRepair = async input => {
    repairCalls.push(input);
    return { outputText: JSON.stringify({ repairs: input.packet.invalidCitations.map(item => ({ JSONPointer: item.JSONPointer, quote: item.quote, start: item.exactStartOffsets.at(-1) })) }),
      receipt: { provider: 'synthetic', invocationId: randomUUID(), contextId: randomUUID(), inputHash: input.inputHash } };
  };
  const service = await new IndependentReviewService({ rootDir, adapter, analyze, analyzePositionRepair, prepareRequest: () => ({ request: prepared }) }).init();
  const task = await service.start({ projectId: family ? 'synthetic-family' : 'synthetic-workplace', requestId: 'original-review', caseId: prepared.caseId,
    mode: 'compare', sourceTaskId: 'synthetic-completed-whole', title: '冻结原稿', chapters: baseline, manuscriptRevision: productManuscriptRevision('冻结原稿', baseline) });
  return { service, task, calls, repairCalls, adapter };
}
