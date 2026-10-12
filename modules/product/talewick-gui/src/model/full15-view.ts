export type Full15PanelAction = 'start' | 'retry' | null;

type TaskLike = { status: string } | undefined;
type UnknownRecord = Record<string, unknown>;

export interface Full15CheckView {
  id: string;
  name: string;
  status: string;
  statusLabel: string;
  summary: string;
  quotes: string[];
}

export interface Full15IssueView {
  id: string;
  checkId: string;
  checkName: string;
  summary: string;
  suggestedVerification: string;
  quotes: string[];
  priority: boolean;
}

export interface Full15ReportView {
  checks: Full15CheckView[];
  issues: Full15IssueView[];
  limitations: string[];
  scopeText: string;
}

const checkNames: Record<string, string> = {
  C01: '交付规格',
  C02: '开篇三问',
  C03: '明确知情矛盾',
  C04: '明确物件状态矛盾',
  C05: '四五章承接',
  C06: '有限参考文本重合',
};

const statusNames: Record<string, string> = {
  checked: '已检查',
  insufficient_evidence: '证据不足',
  not_applicable: '不适用',
  not_evaluated: '未评估',
  incomplete: '未完整覆盖',
};

const record = (value: unknown): value is UnknownRecord => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
const texts = (value: unknown) => Array.isArray(value) ? value.map(text).filter(Boolean) : [];

export function full15PanelAction(task: TaskLike, stale: boolean): Full15PanelAction {
  if (task && ['queued', 'running'].includes(task.status)) return null;
  if (stale) return 'start';
  if (task && ['interrupted', 'needs_attention', 'incomplete', 'complete', 'cancelled'].includes(task.status)) return 'retry';
  return 'start';
}

export function acceptsFull15Response(activeProjectId: string, requestedProjectId: string, requestSequence: number, latestSequence: number) {
  return activeProjectId === requestedProjectId && requestSequence === latestSequence;
}

function quotesIn(value: unknown, found = new Set<string>(), depth = 0): string[] {
  if (depth > 8 || found.size >= 12) return [...found];
  if (Array.isArray(value)) for (const item of value) quotesIn(item, found, depth + 1);
  else if (record(value)) for (const [key, item] of Object.entries(value)) {
    if (/quote/i.test(key) && typeof item === 'string' && item.trim()) found.add(item.trim());
    else quotesIn(item, found, depth + 1);
  }
  return [...found];
}

function checkRows(value: unknown): UnknownRecord[] {
  if (Array.isArray(value)) return value.filter(record);
  if (!record(value)) return [];
  return Object.entries(value).map(([id, item]) => record(item) ? { id, ...item } : { id, status: item });
}

function checkSummary(id: string, status: string, item: UnknownRecord, data: UnknownRecord) {
  const supplied = text(data.summary) || text(item.summary) || text(data.reason) || text(item.reason);
  if (supplied) return supplied;
  if (id === 'C01') {
    const length = typeof data.body_han_count === 'number' ? `正文 ${data.body_han_count} 个汉字` : '';
    const chapters = typeof data.explicit_chapter_count === 'number' ? `${data.explicit_chapter_count} 章` : '';
    if (length || chapters) return [length, chapters].filter(Boolean).join('，') + '。';
  }
  if (status === 'not_applicable') return '本项不适用于这次检查。';
  if (status === 'not_evaluated') return '本次没有评估此项。';
  if (status === 'insufficient_evidence') return '现有正文证据不足，无法得出明确判断。';
  return '报告未提供可展示的摘要。';
}

export function full15ReportView(report: unknown): Full15ReportView {
  const source = record(report) ? report : {};
  const checks = checkRows(source.checks).map((item, index) => {
    const id = text(item.id) || text(item.check_id) || `项目${index + 1}`;
    const data = record(item.data) ? item.data : {};
    const status = text(item.status) || 'not_evaluated';
    return {
      id,
      name: text(item.name) || checkNames[id] || '其他检查',
      status,
      statusLabel: statusNames[status] || '状态未识别',
      summary: checkSummary(id, status, item, data),
      quotes: quotesIn(data),
    };
  }).sort((left, right) => left.id.localeCompare(right.id, 'zh-CN'));
  const priorities = new Set(texts(source.priorityIssueIds ?? source.priority_issue_ids));
  const issues = (Array.isArray(source.issues) ? source.issues : []).filter(record).map((item, index) => {
    const checkId = text(item.check_id) || text(item.checkId);
    return {
      id: text(item.id) || `问题${index + 1}`,
      checkId,
      checkName: checkNames[checkId] || '其他检查',
      summary: text(item.reasoning) || text(item.summary) || '报告未提供问题摘要。',
      suggestedVerification: text(item.suggested_verification) || text(item.suggestedVerification),
      quotes: quotesIn(item.citations),
      priority: priorities.has(text(item.id)),
    };
  }).sort((left, right) => Number(right.priority) - Number(left.priority));
  return {
    checks,
    issues,
    limitations: texts(source.limitations),
    scopeText: '检查范围以本次报告中各项目的状态为准；“不适用”“未评估”和“证据不足”都不表示通过。',
  };
}
