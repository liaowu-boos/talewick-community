/** A protocol fixture only: labels are supplied by tests, not inferred from prose. */
export function syntheticAdjudicationResponse(input, decision = 'confirm') {
  return JSON.stringify({
    inputHash: input.inputHash, manuscriptSha256: input.manuscriptSha256,
    sourceReviewSha256: input.sourceReviewSha256,
    checkedChapterIds: input.chapters.map(chapter => chapter.id),
    decisions: input.issues.map((item, index) => {
      const label = typeof decision === 'function' ? decision(item, index) : decision;
      const chapter = input.chapters.find(chapter => chapter.id === item.issue.chapterId);
      return {
        issueId: item.issueId, issueSha256: item.issueSha256, decision: label,
        reason: '合成状态测试指定的裁定，不代表语义判断正确。', scope: 'text_internal',
        supportingEvidence: [{ chapterId: chapter.id, quote: item.issue.quote,
          start: chapter.body.indexOf(item.issue.quote), role: 'narration', actor: '测试叙述者',
          relevance: '只验证引文绑定和状态迁移。' }], counterEvidence: [],
        alternativeExplanation: { assessment: label === 'confirm' ? 'ruled_out' : 'unresolved', reason: '测试指定状态。' },
        characterKnowledge: { assessment: 'not_applicable', reason: '合成协议测试。' },
      };
    }),
  });
}
