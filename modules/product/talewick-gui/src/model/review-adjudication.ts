import type { Chapter, RuntimeResult } from './types';

export const reviewRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const reviewText = (value: unknown): string => typeof value === 'string' ? value : '';
export const reviewIssueId = (value: unknown): string => reviewRecord(value) ? reviewText(value.issueId ?? value.id) : '';
export const decisionNames: Record<string, string> = { confirm: '确认', reject: '不采纳', uncertain: '待核实' };
const chapterSnapshot = (chapters: Chapter[]) => JSON.stringify(chapters.map(({ id, title, body }) => ({ id, title, body })));

/** Display states only, never revision authorization or literary pass/fail. */
export function adjudicationView(result: RuntimeResult, currentChapters?: Chapter[]) {
  const raw = result.reviewAdjudication;
  const value = reviewRecord(raw) ? raw : undefined;
  const decisions = Array.isArray(value?.decisions) ? value.decisions : [];
  const sourceReview = reviewRecord(value?.sourceReview) ? value.sourceReview : undefined;
  const issues = sourceReview && Array.isArray(sourceReview.issues) ? sourceReview.issues : result.review.issues ?? [];
  const sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const seenIds = new Set<string>(), seenIndices = new Set<number>();
  const items = decisions.map(rawDecision => {
    const decision = reviewRecord(rawDecision) ? rawDecision : {};
    const issueId = reviewText(decision.issueId), outcome = reviewText(decision.decision);
    const issueIndex = typeof decision.issueIndex === 'number' ? decision.issueIndex : -1;
    const issue = issues[issueIndex];
    const entriesValid = (entries: unknown) => Array.isArray(entries) && entries.every(e => reviewRecord(e) && reviewText(e.chapterId).trim() && reviewText(e.quote).trim() && Number.isInteger(e.start) && Number.isInteger(e.end));
    const valid = Boolean(sha(issueId) && !seenIds.has(issueId) && Number.isInteger(issueIndex) && !seenIndices.has(issueIndex) && reviewRecord(issue) && issue.severity === 'must_fix' && Object.hasOwn(decisionNames, outcome) && reviewText(decision.reason).trim() && entriesValid(decision.supportingEvidence) && entriesValid(decision.counterEvidence));
    seenIds.add(issueId); seenIndices.add(issueIndex);
    return { issueId, issueIndex, outcome, valid, reason: reviewText(decision.reason), issue,
      evidence: Array.isArray(decision.supportingEvidence) ? decision.supportingEvidence : [],
      counterEvidence: Array.isArray(decision.counterEvidence) ? decision.counterEvidence : [],
      alternativeExplanation: decision.alternativeExplanation, characterKnowledge: decision.characterKnowledge,
      scope: reviewText(decision.scope), revisionEligible: decision.revisionEligible, raw: rawDecision };
  });
  const validShape = Boolean(value && sha(value.manuscriptSha256) && sha(value.sourceReviewSha256) && sourceReview && Array.isArray(value.decisions) && items.every(item => item.valid));
  let status: NonNullable<RuntimeResult['reviewAdjudicationBinding']>['status'] = raw === undefined ? 'missing' : !value ? 'invalid' : value.schemaVersion !== 'review-adjudication-2' ? 'unsupported' : validShape ? 'unverified' : 'invalid';
  if (validShape && value?.schemaVersion === 'review-adjudication-2' && result.reviewAdjudicationBinding) {
    status = result.reviewAdjudicationBinding.status === 'missing' ? 'unverified' : result.reviewAdjudicationBinding.status;
    if (result.reviewAdjudicationBinding.manuscriptSha256 !== value.manuscriptSha256) status = 'stale';
  }
  const resolvedIndices = new Set(items.filter(item => item.valid).map(item => item.issueIndex));
  return { status, value, items, issues,
    notRequired: status === 'bound' && value?.status === 'not_required' && value.origin === 'program_no_must_fix',
    pendingCount: issues.filter((issue, index) => reviewRecord(issue) && issue.severity === 'must_fix' && !resolvedIndices.has(index)).length,
    counts: Object.fromEntries(Object.keys(decisionNames).map(key => [key, items.filter(item => item.valid && item.outcome === key).length])),
    currentVersion: currentChapters === undefined ? 'unavailable' : chapterSnapshot(result.chapters) === chapterSnapshot(currentChapters) ? 'same' : 'changed',
  };
}

export function quoteMatchesResult(entry: unknown, result: RuntimeResult): boolean {
  if (!reviewRecord(entry) || !reviewText(entry.quote).trim() || typeof entry.start !== 'number' || !Number.isInteger(entry.start) || entry.start < 0 || entry.end !== entry.start + reviewText(entry.quote).length) return false;
  return result.chapters.some(chapter => chapter.id === entry.chapterId && chapter.body.slice(entry.start as number, entry.end as number) === entry.quote);
}

function canonical(value: unknown): unknown {
  return Array.isArray(value) ? value.map(canonical) : reviewRecord(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}

/** Detect stale/corrupted browser copies after the server's full validation.
 * A digest is an integrity check, not a provider signature or a literary verdict. */
export async function verifyAdjudicationDisplay(result: RuntimeResult): Promise<NonNullable<RuntimeResult['reviewAdjudicationBinding']>['status']> {
  const view = adjudicationView(result);
  if (view.status !== 'bound') return view.status;
  const binding = result.reviewAdjudicationBinding!;
  if (!globalThis.crypto?.subtle || !binding.adjudicationSha256) return 'unverified';
  const digest = async (text: string) => Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))).map(byte => byte.toString(16).padStart(2, '0')).join('');
  const [manuscriptSha256, reviewSha256, adjudicationSha256] = await Promise.all([
    digest(chapterSnapshot(result.chapters)),
    digest(JSON.stringify(canonical(result.reviewOriginal ?? result.review))),
    digest(JSON.stringify(canonical(result.reviewAdjudication))),
  ]);
  if (manuscriptSha256 !== binding.manuscriptSha256 || reviewSha256 !== view.value?.sourceReviewSha256) return 'stale';
  return adjudicationSha256 === binding.adjudicationSha256 ? 'bound' : 'invalid';
}
