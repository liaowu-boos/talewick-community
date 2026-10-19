const recordValue = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const records = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(recordValue).filter((item): item is Record<string, unknown> => Boolean(item)) : [];

export interface CrossChapterSummary {
  sourceConfirmed: number;
  sourceAmbiguous: number;
  sourceResolved: number;
  repairedOriginalIssues: number;
  unrepairedOriginalIssues: number;
  candidateConfirmed: number;
  candidateRecheckPresent: boolean;
  label: string;
}

export function crossChapterSummary(value: unknown): CrossChapterSummary | null {
  const quality = recordValue(value);
  const bundle = recordValue(quality?.crossChapterReview);
  const review = recordValue(bundle?.review);
  if (bundle?.schemaVersion !== 'whole-quality-cross-chapter-bundle-1' || review?.schemaVersion !== 'cross-chapter-review-result-1') return null;
  const sourceFindings = records(review.findings);
  const resolution = recordValue(quality?.crossChapterResolution);
  const outcomes = records(resolution?.items);
  const recheckBundle = recordValue(quality?.crossChapterRecheck);
  const recheckReview = recordValue(recheckBundle?.review);
  const candidateRecheckPresent = recheckBundle?.schemaVersion === 'whole-quality-cross-chapter-bundle-1'
    && recheckReview?.schemaVersion === 'cross-chapter-review-result-1';
  const candidateFindings = candidateRecheckPresent ? records(recheckReview.findings) : [];
  const sourceConfirmed = sourceFindings.filter(item => item.status === 'confirmed_conflict').length;
  const repairedOriginalIssues = outcomes.filter(item => item.repairStatus === 'resolved_in_candidate').length;
  const candidateConfirmed = candidateFindings.filter(item => item.status === 'confirmed_conflict').length;
  const candidatePart = candidateRecheckPresent ? `候选仍有冲突 ${candidateConfirmed}` : recordValue(quality?.crossChapterRecheckIncomplete)?.status === 'incomplete' ? '候选核查未完成' : '候选复查未记录';
  return {
    sourceConfirmed,
    sourceAmbiguous: sourceFindings.filter(item => item.status === 'ambiguous').length,
    sourceResolved: sourceFindings.filter(item => item.status === 'resolved').length,
    repairedOriginalIssues,
    unrepairedOriginalIssues: outcomes.filter(item => item.repairStatus === 'unresolved').length,
    candidateConfirmed,
    candidateRecheckPresent,
    label: `跨章事实核查（原稿确认 ${sourceConfirmed} · 原定问题已修 ${repairedOriginalIssues} · ${candidatePart}）`,
  };
}

export const countercheckName = (value: string): string => ({
  differentEntity: '不同人物或实体',
  differentRounds: '不同轮次或时段',
  intentionalOmission: '有意省略',
  lying: '角色说谎',
  misremembering: '记忆偏差',
  normalChange: '正常变化',
} as Record<string, string>)[value] || value;

export function crossChapterBoundaryNote(value: unknown): string {
  const boundary = recordValue(recordValue(value)?.hostBoundary);
  if (boundary?.code !== 'epistemic_explanation_requires_review') return '';
  const reason = boundary.modelReportedResolutionReason === 'lying' ? '角色说谎' : '记忆偏差';
  return `模型提出用“${reason}”解释差异；这尚不足以结案，系统保留为待核对。原始判断和引文均已保存。`;
}

export const countercheckAssessment = (value: unknown): string => ({
  supported: '有证据支持',
  unsupported: '证据不支持',
  refuted: '已有反证',
  unknown: '信息不足',
} as Record<string, string>)[typeof value === 'string' ? value : ''] || '未记录判断';
