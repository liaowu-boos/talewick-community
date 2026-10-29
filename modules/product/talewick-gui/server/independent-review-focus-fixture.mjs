// Synthetic product/validation boundary fixture. No model transport or live data.
import { randomUUID } from 'node:crypto';
import * as adapter from '../../../validation/runtime/independent-review-task.mjs';
import * as readingFocus from '../../../validation/runtime/focused-whole-quality-evaluation.mjs';
import { IndependentReviewService } from './independent-review-service.mjs';
import { productManuscriptRevision } from './full15-service.mjs';

export async function createIndependentFocusFixture(rootDir) {
  const chapters = [{ id: 'c1', title: '车票', body: '窗外下着雨。她关上门，把旧车票压在桌角。' },
    { id: 'c2', title: '选择', body: '她仍等母亲替她决定去留。广播响了两遍。' }];
  const candidate = [chapters[0], { ...chapters[1], body: '她独自登上去南城的车。广播响了两遍。' }];
  const goals = [{ id: 'g1', statement: '以行动承担选择', claimType: 'editorial_hypothesis',
    sourceEvidence: [{ chapterId: 'c2', quote: '仍等母亲替她决定去留', start: 1 }],
    counterCase: [{ chapterId: 'c1', quote: '她关上门', start: 6 }], expectedEffect: '呈现自己的行动',
    failureCriterion: '仍然等待他人替她决定', requiredOutcomes: [{ id: 'o1', dimension: 'action', description: '承担选择代价' }] }];
  const calls = [], preparations = [];
  const input = extra => ({ projectId: 'synthetic-focus', requestId: 'synthetic-focus-once', caseId: 'synthetic-focus-case',
    title: '车票', chapters, manuscriptRevision: productManuscriptRevision('车票', chapters), mode: 'compare',
    sourceTaskId: 'synthetic-no-change', readingFocusVersion: readingFocus.READING_FOCUS_VERSION, ...extra });
  const prepareRequest = value => {
    preparations.push(structuredClone(value));
    const request = { caseId: value.caseId, mode: value.mode, baselineChapters: chapters };
    if (value.mode === 'compare') Object.assign(request, value.sourceTaskId === 'synthetic-goal-failure'
      ? { candidate: { mode: 'revised', chapters: candidate }, goals }
      : { candidate: { mode: 'no_change', chapters }, goals: [] });
    return { request, provenance: { sourceTaskId: value.sourceTaskId } };
  };
  const citation = (manuscript, counter = false) => {
    const chapter = manuscript.chapters[0], paragraph = chapter.body.trim().split(/\r?\n/)[0];
    return { blindId: manuscript.blindId, chapterId: chapter.id, quote: counter ? paragraph.slice(-6) : paragraph, start: null };
  };
  const analyze = async args => {
    calls.push(args); const packet = args.packet.protocolPacket, focused = Boolean(packet.readingFocusVersion);
    let response;
    if (args.stage === 'independent_reading') {
      const evidence = [citation(packet.manuscripts[0])];
      response = { schemaVersion: focused ? 'whole-quality-independent-reading-2' : 'whole-quality-independent-reading-1',
        packetSha256: packet.packetSha256, readerId: packet.readerId, entries: [{ blindId: 'M', readScope: 'whole',
          overallImpression: '完整阅读后仍有保留，不能据此断言改善。',
          claims: focused ? [] : [{ id: 'legacy', claimType: 'editorial_hypothesis', statement: '人物的行动仍有解读空间。', evidence }],
          ...(focused ? { focusAssessments: packet.readingFocusDefinitions.map(focus => ({ focusId: focus.id,
            claimType: 'editorial_hypothesis', statement: `${focus.title}仍有不同读法。`, evidence,
            counterEvidence: [citation(packet.manuscripts[0], true)], uncertainty: '这些引文不能排除另一种阅读感受。' })) } : {}) }] };
    } else if (args.stage === 'blind_pair') {
      const evidence = packet.manuscripts.map(item => citation(item));
      const focuses = focused ? packet.readingFocusDefinitions : [{ id: 'legacy', title: '整体阅读' }];
      response = { schemaVersion: packet.schemaVersion, packetSha256: packet.packetSha256, readerId: packet.readerId,
        independentRecordSha256: args.packet.independentRecordSha256,
        preference: packet.readerId === 'reader-1' ? 'mixed' : 'no_clear_preference',
        comparisons: focuses.map(focus => ({ id: `comparison-${focus.id}`, claimType: 'editorial_hypothesis',
          statement: `${focus.title}未显示明确优劣。`, evidence, severeHarm: { status: 'none', blindIds: [], evidence: [] },
          ...(focused ? { focusId: focus.id, counterEvidence: [], uncertainty: '没有可靠反例，仍保留无明确偏好的可能。' } : {}) })) };
    } else {
      response = { schemaVersion: 'whole-quality-goal-audit-1', packetSha256: packet.packetSha256,
        blindPairRecordSha256s: args.packet.blindPairRecordSha256s,
        goalAssessments: packet.goals.map(goal => ({ goalId: goal.id, status: 'implemented',
          rationale: '故意用未改变的引文声称落实，必须保持语义失败。', failureCriterionMet: false,
          outcomes: goal.requiredOutcomes.map(outcome => ({ outcomeId: outcome.id, status: 'implemented',
            explanation: '本测试不得把未改动内容视为落实。', baselineEvidence: [citation(packet.baseline)], candidateEvidence: [citation(packet.candidate)] })) })) };
    }
    return { outputText: JSON.stringify(response), receipt: { provider: 'synthetic', invocationId: randomUUID(), contextId: randomUUID(), inputHash: args.inputHash } };
  };
  const options = { rootDir, adapter, readingFocus, analyze, prepareRequest };
  const service = await new IndependentReviewService(options).init();
  return { service, input, calls, preparations, options, chapters };
}
