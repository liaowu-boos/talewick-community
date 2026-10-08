/** Explicit mock response for transport/workflow tests, never a semantic verdict. */
export function syntheticAdjudication(input, decision = 'confirm') {
  return JSON.stringify({ inputHash: input.inputHash, manuscriptSha256: input.manuscriptSha256,
    sourceReviewSha256: input.sourceReviewSha256, checkedChapterIds: input.chapters.map(c => c.id),
    decisions: input.issues.map(item => ({ issueId: item.issueId, issueSha256: item.issueSha256, decision,
      scope: 'text_internal', reason: '合成测试的指定裁定，仅验证状态与绑定。',
      supportingEvidence: [{ chapterId: item.issue.chapterId, quote: item.issue.quote,
        role: 'narration', actor: '合成叙述者', relevance: '合成测试中可定位的引文。' }], counterEvidence: [],
      alternativeExplanation: { assessment: 'ruled_out', reason: '测试替身指定状态；不代表语义验证。' },
      characterKnowledge: { assessment: 'not_applicable', reason: '测试替身。' },
    })) });
}
