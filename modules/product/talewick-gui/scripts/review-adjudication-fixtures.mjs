/** Synthetic UI fixtures normalized by the real validator. No model or HTTP calls. */
import { createAdjudicationInput, normalizeAdjudication, ADJUDICATION_VERSION } from '../../../validation/runtime/review-adjudication.mjs';
import { manuscriptFingerprint } from '../../../validation/runtime/checks.mjs';
import { projectReviewAdjudication } from '../server/service-public.mjs';

export function adjudicationFixture({ noIssues = false, historical = false } = {}) {
  const promise = historical ? '乙答应明早送还。' : '乙答应明早归还。';
  const chapters = [
    { id: 'ch-1', title: '第一章', body: '甲把旧钟交给乙。' + promise },
    { id: 'ch-2', title: '第二章', body: '第二天，乙托丙把旧钟送回。甲收到旧钟。' },
  ];
  const review = { summary: '离线测试原审稿，非模型交付。', manuscriptSha256: manuscriptFingerprint(chapters),
    issues: noIssues ? [] : [0, 1, 2].map(index => ({ chapterId: 'ch-1', severity: 'must_fix', quote: promise, explanation: `待裁定测试意见 ${index + 1}`, suggestion: '仅为界面数据，不授权修改。' })), limitations: ['合成测试记录。'] };
  const input = createAdjudicationInput({ chapters, review });
  const evidence = { chapterId: 'ch-1', quote: promise, role: 'dialogue', actor: '乙', relevance: '测试支持证据。' };
  const counter = { chapterId: 'ch-2', quote: '第二天，乙托丙把旧钟送回。', role: 'narration', actor: '叙述者', relevance: '测试后文反证。' };
  const response = { inputHash: input.inputHash, manuscriptSha256: input.manuscriptSha256, sourceReviewSha256: input.sourceReviewSha256, checkedChapterIds: chapters.map(c => c.id),
    decisions: input.modelInput.issues.map((issue, index) => ({ issueId: issue.issueId, issueSha256: issue.issueSha256,
      decision: ['confirm', 'reject', 'uncertain'][index], reason: ['测试确认理由。', '后文存在归还记录。', '仅凭本文不能核实专业事实。'][index],
      scope: index === 2 ? 'external_verification_required' : 'text_internal', supportingEvidence: [evidence], counterEvidence: index === 1 ? [counter] : [],
      alternativeExplanation: { assessment: index === 0 ? 'ruled_out' : 'unresolved', reason: '合成替代解释检查。' }, characterKnowledge: { assessment: 'not_applicable', reason: '合成人物知情范围检查。' } })) };
  const adjudication = noIssues ? { schemaVersion: ADJUDICATION_VERSION, status: 'not_required', origin: 'program_no_must_fix', inputHash: input.inputHash,
    manuscriptSha256: input.manuscriptSha256, sourceReviewSha256: input.sourceReviewSha256, sourceReview: structuredClone(review), rawResponse: null, responseSha256: null,
    checkedChapterIds: [], decisions: [], revisionEligibleIssueIds: [], retainedDisputeIssueIds: [], modelReviewPassed: false, semanticValidity: 'not_evaluated', literaryQuality: 'NOT_ASSESSED', systemGo: false }
    : normalizeAdjudication(JSON.stringify(response), input);
  const result = { title: '合成裁定与版本测试', chapters, review, reviewAdjudication: adjudication, checks: {}, knowledge: {}, warnings: [] };
  return { ...result, reviewAdjudicationBinding: projectReviewAdjudication(result) };
}
