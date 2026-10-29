import type { Chapter } from './types';

export type ReviewManuscriptRole = 'source' | 'candidate' | 'single' | 'unknown';
export interface ReviewEvidenceLocation {
  chapterId: string;
  start: number;
  quote: string;
  label: string;
  blindId?: string;
  readerId?: string;
  stage?: string;
  documentRole?: ReviewManuscriptRole;
  evidenceKind?: 'supporting' | 'counter';
}
export interface IndependentReviewSnapshot {
  id: string;
  blindId: string;
  role: ReviewManuscriptRole;
  label: string;
  title?: string;
  chapters: Chapter[];
}
export interface IndependentReviewFinding {
  id: string;
  statement: string;
  detail?: string;
  status?: string;
  uncertainty?: string;
  evidence: ReviewEvidenceLocation[];
}
export interface IndependentReviewSection {
  id: string;
  readerId?: string;
  readerLabel: string;
  stage: string;
  stageLabel: string;
  preference?: string;
  findings: IndependentReviewFinding[];
}
export interface IndependentReviewView {
  headline: string;
  boundary: string;
  readerLines: string[];
  attributionLines: string[];
  summaryFindings: string[];
  findings: string[];
  sections: IndependentReviewSection[];
  evidence: ReviewEvidenceLocation[];
  snapshots: IndependentReviewSnapshot[];
  limitations: string[];
}

type UnknownRecord = Record<string, unknown>;
const record = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
/** Manuscript text and citations are UTF-16-bound evidence; validate without normalizing bytes. */
const exactText = (value: unknown) => typeof value === 'string' && value.trim() ? value : '';
const texts = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];
const statusNames: Record<string, string> = {
  implemented: '已落实', partially_implemented: '部分落实', not_implemented: '未落实', not_applicable: '不适用',
  first: '倾向先读稿', second: '倾向后读稿', mixed: '两稿各有取舍', no_clear_preference: '无明确偏好',
  hard_fact: '模型事实判断', editorial_hypothesis: '编辑判断',
};
const stageNames: Record<string, string> = { independent_reading: '独立全文阅读', blind_pair: '盲态两稿比较', goal_audit: '冻结目标核查' };
const focusNames: Record<string, string> = {
  continuation_desire: '继续阅读意愿的变化', psychological_turns: '心理转折的可信度', emotional_payoff: '情绪累积与兑现',
  middle_late_pacing: '中后段节奏', scene_explanation: '场景与解释的关系', choice_cost: '人物选择及其代价',
};
export const isPartialBlindReport = (value: unknown): value is UnknownRecord => record(value)
  && value.schemaVersion === 'independent-review-partial-blind-report-1' && value.completeBlindReview === true
  && value.completedBlindStages === 6 && value.taskStatus === 'needs_attention' && value.goalAuditStatus === 'needs_attention'
  && value.automaticAdoption === false && value.literaryPass === 'NOT_COMPUTED';
const limitationNames: Record<string, string> = {
  'Blind preference does not prove goal implementation.': '盲评偏好不能证明预定目标已经落实。',
  'Goal implementation does not by itself grant adoption.': '目标落实本身不代表候选稿可以直接采用。',
  'Mixed or divergent findings require a narrowed recheck rather than aggregation.': '意见混合或存在分歧时，需要缩小范围复核，不能合并为统一结论。',
  'Six blind stages are valid; the goal audit remains failed and the task remains needs_attention.': '六个盲评阶段的记录已核验；目标核查仍未通过，任务仍需处理。',
  'Reader judgments, negative opinions and disagreement are preserved without aggregation.': '各读者的判断、负面意见和分歧均原样保留，不合并为统一结论。',
  'No goal compliance, factual clearance, literary pass or automatic adoption is inferred.': '这些记录不表示目标已落实、事实核查通过或文学质量通过，也不会自动采用候选稿。',
};

interface FrozenGoalLabels {
  statements: Map<string, string>;
  outcomes: Map<string, string>;
}

function normalizeRole(value: unknown): ReviewManuscriptRole {
  const name = text(value).toLowerCase().replaceAll('-', '_');
  if (['baseline', 'source', 'original', 'original_manuscript'].includes(name)) return 'source';
  if (['candidate', 'revised', 'candidate_manuscript'].includes(name)) return 'candidate';
  if (['single', 'manuscript', 'current'].includes(name)) return 'single';
  return 'unknown';
}

function readerLabel(readerId?: string) {
  if (!readerId) return '目标核查';
  const match = readerId.match(/(?:reader[-_ ]?)?(\d+)$/i);
  return match ? `读者 ${match[1]}` : readerId;
}

function roleLabel(role: ReviewManuscriptRole, blindId: string) {
  if (role === 'source') return `冻结原稿${blindId ? ` · 匿名稿 ${blindId}` : ''}`;
  if (role === 'candidate') return `冻结候选稿${blindId ? ` · 匿名稿 ${blindId}` : ''}`;
  if (role === 'single') return '本次冻结单稿';
  return blindId ? `匿名稿 ${blindId}` : '冻结稿件';
}

function preferenceRoleLabel(role: ReviewManuscriptRole) {
  if (role === 'source') return '冻结原稿';
  if (role === 'candidate') return '冻结候选稿';
  if (role === 'single') return '本次冻结单稿';
  return '';
}

function collectRoleBindings(value: unknown, found: Map<string, ReviewManuscriptRole>, depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(value)) { value.forEach(item => collectRoleBindings(item, found, depth + 1)); return; }
  if (!record(value)) return;
  const blindId = text(value.blindId), explicit = normalizeRole(value.role ?? value.manuscriptRole ?? value.identity ?? value.documentRole);
  if (blindId && explicit !== 'unknown') found.set(blindId, explicit);
  for (const key of ['blindRoles', 'blindIdRoles', 'roleByBlindId', 'roles']) {
    const roles = value[key];
    if (!record(roles)) continue;
    for (const [id, role] of Object.entries(roles)) {
      const normalized = normalizeRole(record(role) ? role.role ?? role.identity : role);
      if (id && normalized !== 'unknown') found.set(id, normalized);
    }
  }
  Object.values(value).forEach(item => collectRoleBindings(item, found, depth + 1));
}

function frozenGoalLabels(completionEvidence: unknown): FrozenGoalLabels {
  const result: FrozenGoalLabels = { statements: new Map(), outcomes: new Map() };
  if (!record(completionEvidence) || !Array.isArray(completionEvidence.frozenGoals)) return result;
  completionEvidence.frozenGoals.filter(record).forEach(goal => {
    const goalId = text(goal.id ?? goal.goalId), statement = text(goal.statement);
    if (goalId && statement) result.statements.set(goalId, statement);
    if (!Array.isArray(goal.requiredOutcomes)) return;
    goal.requiredOutcomes.filter(record).forEach(outcome => {
      const outcomeId = text(outcome.id ?? outcome.outcomeId), description = text(outcome.description);
      if (outcomeId && description) result.outcomes.set(`${goalId}|${outcomeId}`, description);
    });
  });
  return result;
}

function collectSnapshots(value: unknown, roles: Map<string, ReviewManuscriptRole>, found: IndependentReviewSnapshot[], hint = '', depth = 0) {
  if (depth > 12) return;
  if (Array.isArray(value)) { value.forEach(item => collectSnapshots(item, roles, found, hint, depth + 1)); return; }
  if (!record(value)) return;
  const chapters = Array.isArray(value.chapters) ? value.chapters.filter(record).map(item => ({ id: exactText(item.id), title: exactText(item.title), body: exactText(item.body) })).filter(item => item.id && item.body) : [];
  if (chapters.length) {
    const blindId = text(value.blindId ?? value.id);
    let role = normalizeRole(value.role ?? value.manuscriptRole ?? value.identity ?? value.documentRole ?? hint);
    if (role === 'unknown' && blindId) role = roles.get(blindId) ?? 'unknown';
    if (blindId && role !== 'unknown') roles.set(blindId, role);
    const id = `${role}:${blindId || text(value.manuscriptSha256) || found.length}`;
    if (!found.some(item => item.id === id)) found.push({ id, blindId, role, label: roleLabel(role, blindId), ...(exactText(value.title) ? { title: exactText(value.title) } : {}), chapters });
    return;
  }
  for (const [key, item] of Object.entries(value)) collectSnapshots(item, roles, found, key, depth + 1);
}

function citation(value: unknown, label: string, readerId: string | undefined, stage: string, roles: Map<string, ReviewManuscriptRole>): ReviewEvidenceLocation | null {
  if (!record(value)) return null;
  const chapterId = text(value.chapterId), quote = exactText(value.quote), blindId = text(value.blindId), start = value.start;
  if (!chapterId || !quote || !Number.isSafeInteger(start) || Number(start) < 0) return null;
  const documentRole = blindId ? roles.get(blindId) : undefined;
  return { chapterId, quote, start: Number(start), label, ...(blindId ? { blindId } : {}), ...(readerId ? { readerId } : {}), ...(stage ? { stage } : {}), ...(documentRole ? { documentRole } : {}) };
}

function collectEvidence(value: unknown, label: string, readerId: string | undefined, stage: string, roles: Map<string, ReviewManuscriptRole>, found: ReviewEvidenceLocation[] = [], depth = 0) {
  if (depth > 16) return found;
  if (Array.isArray(value)) { value.forEach(item => collectEvidence(item, label, readerId, stage, roles, found, depth + 1)); return found; }
  if (!record(value)) return found;
  const location = citation(value, label, readerId, stage, roles);
  if (location) {
    const key = `${location.readerId ?? ''}|${location.stage ?? ''}|${location.blindId ?? ''}|${location.chapterId}|${location.start}|${location.quote}|${location.label}`;
    if (!found.some(item => `${item.readerId ?? ''}|${item.stage ?? ''}|${item.blindId ?? ''}|${item.chapterId}|${item.start}|${item.quote}|${item.label}` === key)) found.push(location);
  }
  Object.values(value).forEach(item => collectEvidence(item, label, readerId, stage, roles, found, depth + 1));
  return found;
}

function stageOf(value: UnknownRecord, envelope: UnknownRecord) {
  const explicit = text(envelope.stage ?? value.stage);
  if (explicit) return explicit;
  const schema = text(value.schemaVersion);
  if (schema.includes('goal-audit') || Array.isArray(value.goalAssessments)) return 'goal_audit';
  if (schema.includes('blind-pair') || Array.isArray(value.comparisons)) return 'blind_pair';
  return 'independent_reading';
}

function recordEnvelopes(source: UnknownRecord) {
  const candidates: unknown[] = [];
  if (isPartialBlindReport(source)) {
    const merged = source.independentReadings;
    const completeMerged = Array.isArray(merged) && merged.length === 2 && merged.every(item => record(item) && record(item.record)
      && Array.isArray(item.record.entries) && item.record.entries.length === 2
      && item.record.entries.every(entry => record(entry) && ['A', 'B'].includes(text(entry.blindId)))
      && new Set(item.record.entries.map(entry => record(entry) ? entry.blindId : null)).size === 2);
    const readings = completeMerged ? merged : source.isolatedReadings;
    if (Array.isArray(readings)) candidates.push(...readings);
    if (Array.isArray(source.blindPairReviews)) candidates.push(...source.blindPairReviews);
  }
  if (record(source.completionEvidence)) {
    for (const key of ['independentReadings', 'blindPairReviews']) if (Array.isArray(source.completionEvidence[key])) candidates.push(...source.completionEvidence[key] as unknown[]);
    if (record(source.completionEvidence.goalAudit)) candidates.push(source.completionEvidence.goalAudit);
  }
  for (const key of ['records', 'fullRecords', 'reviewRecords', 'readerViews']) if (Array.isArray(source[key])) candidates.push(...source[key] as unknown[]);
  if (record(source.divergentReadings) && Array.isArray(source.divergentReadings.records)) candidates.push(...source.divergentReadings.records);
  for (const key of ['goalRecord', 'goalAudit', 'goalAuditRecord']) if (record(source[key])) candidates.push(source[key]);
  const seen = new Set<string>(), result: { envelope: UnknownRecord; value: UnknownRecord }[] = [];
  for (const candidate of candidates) {
    if (!record(candidate)) continue;
    const value = record(candidate.record) ? candidate.record : candidate;
    if (!(Array.isArray(value.entries) || Array.isArray(value.comparisons) || Array.isArray(value.goalAssessments))) continue;
    const identity = text(candidate.recordSha256) || JSON.stringify(value);
    if (seen.has(identity)) continue;
    seen.add(identity); result.push({ envelope: candidate, value });
  }
  return result;
}

function findingsForRecord(value: UnknownRecord, readerId: string | undefined, stage: string, roles: Map<string, ReviewManuscriptRole>, completionRoles: Map<string, ReviewManuscriptRole>, goalLabels: FrozenGoalLabels) {
  const result: IndependentReviewFinding[] = [], add = (id: string, statement: unknown, evidenceValue?: unknown, status?: unknown, detail?: unknown, uncertainty?: unknown, counterEvidence?: unknown) => {
    const line = text(statement); if (!line) return;
    const supporting = collectEvidence(evidenceValue, line, readerId, stage, roles), counter = collectEvidence(counterEvidence, line, readerId, stage, roles);
    result.push({ id, statement: line, ...(text(detail) ? { detail: text(detail) } : {}), ...(text(status) ? { status: statusNames[text(status)] ?? text(status) } : {}),
      ...(text(uncertainty) ? { uncertainty: text(uncertainty) } : {}),
      evidence: counterEvidence === undefined ? supporting : [...supporting.map(item => ({ ...item, evidenceKind: 'supporting' as const })), ...counter.map(item => ({ ...item, evidenceKind: 'counter' as const }))] });
  };
  if (Array.isArray(value.entries)) value.entries.filter(record).forEach((entry, entryIndex) => {
    const blindId = text(entry.blindId), detail = roleLabel(blindId ? completionRoles.get(blindId) ?? 'unknown' : 'unknown', blindId);
    add(`entry-${entryIndex}-impression`, entry.overallImpression, undefined, undefined, detail);
    if (Array.isArray(entry.claims)) entry.claims.filter(record).forEach((claim, claimIndex) => add(`entry-${entryIndex}-claim-${text(claim.id) || claimIndex}`, claim.statement, claim.evidence, claim.claimType, detail));
    if (Array.isArray(entry.focusAssessments)) entry.focusAssessments.filter(record).forEach((assessment, index) => {
      const focus = focusNames[text(assessment.focusId)] || text(assessment.focusId);
      add(`entry-${entryIndex}-focus-${text(assessment.focusId) || index}`, assessment.statement, assessment.evidence, assessment.claimType,
        `${detail} · ${focus}`, assessment.uncertainty, assessment.counterEvidence);
    });
  });
  if (Array.isArray(value.comparisons)) value.comparisons.filter(record).forEach((comparison, index) => {
    const harm = comparison.severeHarm;
    let status: unknown = comparison.claimType;
    if (harm === true) status = '严重问题 · 旧版归属未区分';
    else if (record(harm) && harm.status === 'unknown') status = '严重问题 · 归属待核对';
    else if (record(harm) && harm.status === 'attributed') {
      const labels = texts(harm.blindIds).map(id => roleLabel(completionRoles.get(id) ?? 'unknown', id));
      status = `严重问题 · ${labels.join('、')}`;
    }
    add(`comparison-${text(comparison.id) || index}`, comparison.statement, [comparison.evidence, record(harm) ? harm.evidence : []], status,
      focusNames[text(comparison.focusId)] || text(comparison.focusId), comparison.uncertainty, comparison.counterEvidence);
  });
  if (Array.isArray(value.goalAssessments)) value.goalAssessments.filter(record).forEach((goal, goalIndex) => {
    const goalId = text(goal.goalId), goalStatement = goalLabels.statements.get(goalId);
    add(`goal-${goalId || goalIndex}`, goal.rationale, goal, goal.status, goalStatement ? `目标：${goalStatement}` : goalId ? `目标 ${goalId}` : '目标核查');
    if (Array.isArray(goal.outcomes)) goal.outcomes.filter(record).forEach((outcome, outcomeIndex) => {
      const outcomeId = text(outcome.outcomeId), description = goalLabels.outcomes.get(`${goalId}|${outcomeId}`);
      add(`goal-${goalIndex}-outcome-${outcomeId || outcomeIndex}`, outcome.explanation, outcome, outcome.status, description ? `预定结果：${description}` : outcomeId ? `结果 ${outcomeId}` : '目标结果');
    });
  });
  if (!result.length) {
    const seen = new Set<string>();
    const walk = (item: unknown, depth = 0) => {
      if (depth > 16) return;
      if (Array.isArray(item)) { item.forEach(child => walk(child, depth + 1)); return; }
      if (!record(item)) return;
      for (const key of ['statement', 'overallImpression', 'summary', 'rationale', 'observation', 'explanation', 'reason']) {
        const line = text(item[key]);
        if (line && !seen.has(line)) { seen.add(line); add(`fallback-${result.length}`, line, item); }
      }
      Object.values(item).forEach(child => walk(child, depth + 1));
    };
    walk(value);
  }
  return result;
}

interface IndependentReviewDisplayContext { taskId: string; partialSnapshotProjection?: unknown }

function boundPartialSnapshots(source: UnknownRecord, context?: IndependentReviewDisplayContext) {
  const projection = context?.partialSnapshotProjection;
  if (!record(projection) || projection.schemaVersion !== 'independent-review-partial-snapshots-1'
    || projection.reviewTaskId !== context?.taskId || projection.caseId !== source.caseId
    || projection.requestHash !== source.requestHash || projection.partialReportSha256 !== source.reportSha256
    || !/^[a-f0-9]{64}$/.test(text(source.reportSha256)) || !record(source.privateBinding)
    || !record(source.privateBinding.bindings) || !Array.isArray(projection.snapshots) || projection.snapshots.length !== 2) return null;
  const binding = source.privateBinding, roles = binding.bindings as UnknownRecord;
  const valid = projection.snapshots.every(item => record(item) && ['A', 'B'].includes(text(item.blindId))
    && ['baseline', 'candidate'].includes(text(item.role)) && roles[text(item.blindId)] === item.role
    && item.manuscriptSha256 === binding[item.role === 'baseline' ? 'baselineManuscriptSha256' : 'candidateManuscriptSha256']
    && Array.isArray(item.chapters) && item.chapters.length > 0 && item.chapters.every(chapter => record(chapter)
      && typeof chapter.id === 'string' && typeof chapter.title === 'string' && typeof chapter.body === 'string'));
  return valid && new Set(projection.snapshots.map(item => record(item) ? item.blindId : null)).size === 2 ? projection : null;
}

/** A supplied alias must resolve exactly; never redirect a missing alias to another manuscript. */
export function independentReviewSnapshotForEvidence(snapshots: IndependentReviewSnapshot[], evidence: ReviewEvidenceLocation) {
  const matching = evidence.blindId ? snapshots.filter(item => item.blindId === evidence.blindId)
    : evidence.documentRole ? snapshots.filter(item => item.role === evidence.documentRole) : snapshots;
  if (matching.length !== 1) return undefined;
  const snapshot = matching[0], chapter = snapshot.chapters.find(item => item.id === evidence.chapterId);
  return chapter && Number.isSafeInteger(evidence.start) && evidence.start >= 0 && evidence.quote.length > 0
    && chapter.body.slice(evidence.start, evidence.start + evidence.quote.length) === evidence.quote ? snapshot : undefined;
}

export function independentReviewView(report: unknown, mode: 'single' | 'compare', context?: IndependentReviewDisplayContext): IndependentReviewView {
  const source = record(report) ? report : {}, roles = new Map<string, ReviewManuscriptRole>(), completionRoles = new Map<string, ReviewManuscriptRole>(), snapshots: IndependentReviewSnapshot[] = [];
  const partial = mode === 'compare' && isPartialBlindReport(source);
  collectRoleBindings(source, roles);
  if (partial) collectRoleBindings(source.readerBindings, completionRoles);
  if (record(source.completionEvidence)) collectRoleBindings(source.completionEvidence, completionRoles);
  const goalLabels = frozenGoalLabels(source.completionEvidence);
  collectSnapshots(partial ? boundPartialSnapshots(source, context) : source, roles, snapshots);
  if (mode === 'single' && snapshots.length === 1 && snapshots[0].role === 'unknown') snapshots[0] = { ...snapshots[0], role: 'single', label: '本次冻结单稿' };
  snapshots.forEach(snapshot => { if (snapshot.blindId && snapshot.role !== 'unknown') roles.set(snapshot.blindId, snapshot.role); });
  const sections = recordEnvelopes(source).map(({ envelope, value }, index) => {
    const readerId = text(value.readerId ?? envelope.readerId) || undefined, stage = stageOf(value, envelope), preference = text(value.preference);
    return { id: text(envelope.stageId) || `${stage}-${readerId ?? 'controller'}-${index}`, ...(readerId ? { readerId } : {}), readerLabel: readerLabel(readerId), stage,
      stageLabel: stageNames[stage] ?? stage, ...(preference ? { preference: statusNames[preference] ?? preference } : {}), findings: findingsForRecord(value, readerId, stage, roles, completionRoles, goalLabels) };
  });
  const evidence = sections.flatMap(section => section.findings.flatMap(finding => finding.evidence));
  const findings = sections.flatMap(section => section.findings.map(finding => finding.statement));
  const boundaryName: Record<string, string> = { preserve_original: '建议保留原稿并核对严重伤害', goals_not_achieved: '预定目标尚未落实', narrowed_recheck_required: '存在分歧或部分落实，需要缩小范围复核', eligible_for_editorial_consideration: '可进入编辑选择，仍需用户决定', no_change: '本轮没有质量增益主张' };
  const legacyAttribution = mode === 'compare' && source.schemaVersion === 'whole-quality-evaluation-result-1';
  const attribution = ['whole-quality-evaluation-result-2', 'whole-quality-evaluation-result-3'].includes(text(source.schemaVersion)) && record(source.severeHarmAttribution) ? source.severeHarmAttribution : null;
  const attributionLines = legacyAttribution ? ['旧版归属未区分：历史报告没有区分原稿问题与候选损伤，保留原始结论，请结合新评阅查看。'] : attribution ? [
    `原稿严重问题记录：${Array.isArray(attribution.baselineIssues) ? attribution.baselineIssues.length : 0} 条`,
    `候选严重损伤记录：${Array.isArray(attribution.candidateRisks) ? attribution.candidateRisks.length : 0} 条`,
    `问题归属待核对：${Array.isArray(attribution.unknown) ? attribution.unknown.length : 0} 条`,
    '以上按评阅记录计数，同一问题可能重复出现；两稿均有的问题分别列入两类。',
  ] : [];
  const boundary = partial ? '保留前六阶段的独立阅读与比较；目标核查仍失败，不代表目标落实、事实通过或文学质量通过。' : legacyAttribution && source.adoptionBoundary === 'preserve_original' ? '历史建议：保留原稿；严重问题的稿件归属未区分。' : boundaryName[text(source.adoptionBoundary)] || (mode === 'single' ? '单稿意见已经保存，不产生版本胜负。' : '比较结论只作为内部编辑证据。');
  const readerLines = Array.isArray(source.readerViews) ? source.readerViews.filter(record).map(item => {
    const nested = record(item.record) ? item.record : {}, id = text(item.readerId) || text(nested.readerId), preference = text(item.preference) || text(nested.preference);
    if (preference === 'first' || preference === 'second') {
      const orderValue = Array.isArray(item.order) ? item.order : nested.order, order = texts(orderValue);
      const selectedBlindId = text(item.selectedBlindId) || text(nested.selectedBlindId), expectedBlindId = order[preference === 'first' ? 0 : 1];
      const selectedRole = selectedBlindId && selectedBlindId === expectedBlindId ? completionRoles.get(selectedBlindId) ?? 'unknown' : 'unknown';
      const selectedLabel = preferenceRoleLabel(selectedRole);
      if (selectedLabel) return `${readerLabel(id || undefined)}：倾向${selectedLabel}（匿名稿${selectedBlindId}；${preference === 'first' ? '先读' : '后读'}）`;
    }
    const verdict = (statusNames[preference] ?? preference) || text(item.overallImpression) || text(nested.overallImpression);
    return verdict ? `${readerLabel(id || undefined)}：${verdict}` : '';
  }).filter(Boolean) : [];
  if (partial && Array.isArray(source.readerBindings)) source.readerBindings.filter(record).forEach(item => {
    const preference = text(item.originalPreference), order = Array.isArray(item.order) ? item.order.filter(record) : [];
    const selected = order[preference === 'first' ? 0 : preference === 'second' ? 1 : -1];
    const label = selected ? preferenceRoleLabel(normalizeRole(selected.role)) : '';
    readerLines.push(`${readerLabel(text(item.readerId) || undefined)}：${label ? `倾向${label}（匿名稿${text(selected.blindId)}；${preference === 'first' ? '先读' : '后读'}）` : statusNames[preference] || preference}（独立意见，不汇总投票）`);
  });
  const limitations = [...texts(source.limitations).map(item => limitationNames[item] ?? item), ...(source.literaryPass === 'NOT_COMPUTED' ? ['本任务不计算文学质量通过。'] : []), ...(source.automaticAdoption === false ? ['评阅结果不会自动采用或改写正文。'] : [])];
  return { headline: partial ? '全文盲评已完成；目标核查未通过' : mode === 'single' ? '两路独立全文初读' : '原稿与候选的隔离盲评', boundary, readerLines, attributionLines, summaryFindings: findings.slice(0, 4), findings, sections, evidence, snapshots, limitations: [...new Set(limitations)] };
}
