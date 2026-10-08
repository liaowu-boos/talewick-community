import type { RuntimeResult } from './types';
export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const text = (v: unknown): string => typeof v === 'string' ? v : '';
export const records = (v: unknown): Record<string, unknown>[] => Array.isArray(v) ? v.filter(record) : [];
export const texts = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
const count = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const reasons: Record<string, string> = { invalid_reference_need: '参考问题格式不符合要求', no_reference_need: '本次没有提出补查问题', invalid_target: '未找到有效的目标章节', not_anchored_must_fix: '未绑定已核实且需要修订的问题' };
export function reasonLabel(value: unknown): string { const s = text(value); return s.includes('consumerBindings') ? '材料已准备；实际调用情况见写作输入记录，采用与效果未核验。' : reasons[s] || s; }
export function slotLabel(value: unknown): string { return value === 'planning' ? '规划后补查' : value === 'review' ? '初审后补查' : '补查记录'; }
export function slotOutcome(slot: Record<string, unknown>): string {
  if (slot.status === 'prepared' || slot.status === 'supplied') { const n = count(slot.acceptedCount); return n === null ? '接受数量未记录，无法确认补入' : n > 0 ? `已准备 ${n} 份补充材料` : '查到材料，本次未补入'; }
  const labels: Record<string, string> = { matched: '查到材料，是否补入未记录', no_additions: '查到材料，本次未补入', uncovered: '未找到覆盖问题的材料', unavailable: '补查未取得可用结果', rejected: '补查请求未通过校验', skipped_budget: '材料预算已满，未补查', deferred_no_consumer: '没有后续写作需要，未补查', duplicate_need: '相同问题已尝试，未重复补查', not_connected: '检索未连接，未补查', interrupted_no_requery: '补查结果未完整保存，沿用旧材料', not_requested: '本次未提出补查' };
  return labels[text(slot.status)] || '记录状态无法识别，不能确认补入';
}
const statuses = ['prepared', 'no_additions', 'uncovered', 'unavailable', 'rejected', 'skipped_budget', 'deferred_no_consumer', 'duplicate_need', 'not_connected', 'interrupted_no_requery', 'not_requested'];
const objectArray = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.every(record);
const ids = (v: unknown): v is string[] => Array.isArray(v) && v.every(x => typeof x === 'string' && x.length > 0) && new Set(v).size === v.length;
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i]);
/** Validate the public projection, without redoing backend cryptographic verification. */
export function validLedger(ledger: unknown, activeKnowledge: unknown): ledger is Record<string, unknown> {
  if (!record(ledger) || ledger.policyVersion !== 'bounded-followup-1' || ledger.suppliedNotAdopted !== true
    || !objectArray(ledger.slots) || ledger.slots.length !== 2 || new Set(ledger.slots.map(s => s.slot)).size !== 2
    || !objectArray(ledger.snapshots) || !ledger.snapshots.length || !objectArray(ledger.consumerBindings)
    || count(ledger.retainedChars) === null || Number(ledger.retainedChars) > 30000 || count(ledger.activeChars) === null
    || Number(ledger.activeChars) > Number(ledger.retainedChars)) return false;
  const seen = new Set<string>();
  for (const snapshot of ledger.snapshots) {
    if (!text(snapshot.hash) || seen.has(text(snapshot.hash)) || !objectArray(snapshot.materials)
      || !ids(snapshot.activeMaterialIds) || !ids(snapshot.materials.map(m => m.id))
      || !sameIds(snapshot.activeMaterialIds, snapshot.materials.map(m => text(m.id)))
      || snapshot.materials.some(m => typeof m.title !== 'string' || (m.references !== undefined && !objectArray(m.references)))
      || count(snapshot.retainedChars) === null || Number(snapshot.retainedChars) > 30000
      || (seen.size === 0 ? snapshot.parentHash !== null : !seen.has(text(snapshot.parentHash)))) return false;
    seen.add(text(snapshot.hash));
  }
  if (ledger.initialSnapshotHash !== ledger.snapshots[0].hash || !seen.has(text(ledger.activeSnapshotHash))) return false;
  const active = ledger.snapshots.find(s => s.hash === ledger.activeSnapshotHash)!;
  if (!record(activeKnowledge) || !objectArray(activeKnowledge.materials) || !ids(activeKnowledge.materials.map(m => m.id))
    || !sameIds(active.activeMaterialIds as string[], activeKnowledge.materials.map(m => text(m.id)))) return false;
  for (const slot of ledger.slots) {
    if (!['planning', 'review'].includes(text(slot.slot)) || !statuses.includes(text(slot.status))
      || count(slot.acceptedCount) === null || count(slot.droppedCount) === null
      || (slot.snapshotHash !== undefined && !seen.has(text(slot.snapshotHash)))) return false;
    const delta = slot.delta;
    if (delta !== null && delta !== undefined && (!record(delta) || !objectArray(delta.accepted) || !objectArray(delta.dropped) || !objectArray(delta.superseded)
      || delta.accepted.length !== slot.acceptedCount || delta.dropped.length !== slot.droppedCount || !ids(delta.accepted.map(m => m.id)))) return false;
    if (slot.status === 'prepared') {
      if (Number(slot.acceptedCount) < 1 || !record(delta) || !seen.has(text(slot.snapshotHash))) return false;
      const snapshot = ledger.snapshots.find(s => s.hash === slot.snapshotHash)!;
      if (!(delta.accepted as Record<string, unknown>[]).every(m => (snapshot.activeMaterialIds as string[]).includes(text(m.id)))) return false;
    } else if (slot.acceptedCount !== 0) return false;
    if ((slot.droppedCount !== 0) && !record(delta)) return false;
  }
  return ledger.consumerBindings.every(binding => text(binding.id) && text(binding.stage) && text(binding.inputHash)
    && ['prepared_or_unknown', 'response_returned'].includes(text(binding.outcome)) && typeof binding.neutralReview === 'boolean'
    && (binding.snapshotHash === null || seen.has(text(binding.snapshotHash)))
    && (!binding.neutralReview || binding.snapshotHash === null));
}
export function materialView(result: RuntimeResult) {
  const ledger = result.followupRetrieval;
  const valid = validLedger(ledger, result.activeKnowledge);
  const slots = valid ? records(ledger.slots) : [];
  const materials = records((valid ? result.activeKnowledge! : result.knowledge).materials);
  const added = slots.reduce((n, s) => n + (s.status === 'prepared' ? Number(s.acceptedCount) : 0), 0);
  const invalid = !!result.followupRetrievalInvalid || (!!ledger && !valid);
  return { ledger: valid ? ledger : undefined, slots, materials, added, invalid,
    summary: invalid ? '补查记录不完整，无法确认本次补查结果。' : valid ? added > 0 ? `补查共准备 ${added} 份材料。` : '本次没有补入新材料。' : '此结果没有补查记录。',
    retainedChars: valid ? count(ledger.retainedChars) : null,
    activeChars: valid ? count(ledger.activeChars) : null,
  };
}

export function consumerLabel(stage: unknown): string {
  const s = text(stage);
  if (s.startsWith('agent:reviseChapter:')) return `必要修订 · ${s.slice('agent:reviseChapter:'.length)}`;
  if (s === 'agent:replan') return '故事方案调整';
  if (s === 'agent:reviewManuscript') return '修订后全文复审';
  const match = /^(draft|revision):(.+)$/.exec(s);
  if (match) return `${match[1] === 'draft' ? '正文写作' : '必要修订'} · ${match[2]}`;
  return ({ planning: '故事规划', review: '初次审稿', revisionReview: '修订后复审', requestedRevision: '用户要求的修订' } as Record<string, string>)[s] || '业务调用';
}
export function snapshotLabel(hash: unknown, snapshots: Record<string, unknown>[]): string {
  if (!text(hash)) return '未绑定材料版本';
  const i = snapshots.findIndex(s => s.hash === hash);
  return i < 0 ? '材料版本未找到' : i === 0 ? '初始材料' : `补查材料第 ${i} 版`;
}

/** Public counts only. The exact receipt is internal and must never be rendered here. */
export function relevanceReviewText(value: unknown, invalid = false): string {
  if (!invalid && value === undefined) return '未记录适用性筛选，无法确认是否经过筛选。';
  const keys = ['receiptId', 'inputHash', 'status', 'sentCount', 'notReviewedCount', 'usableCount', 'irrelevantCount', 'insufficientContextCount'];
  const counters = ['sentCount', 'notReviewedCount', 'usableCount', 'irrelevantCount', 'insufficientContextCount'];
  if (invalid || !record(value) || Object.keys(value).length !== keys.length || keys.some(k => !Object.hasOwn(value, k))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(text(value.receiptId))
    || !/^[0-9a-f]{64}$/.test(text(value.inputHash)) || counters.some(k => count(value[k]) === null || Number(value[k]) > 20)
    || Number(value.sentCount) + Number(value.notReviewedCount) > 20) return '筛选记录不完整或不兼容，无法确认筛选结果。';
  const n = Number(value.sentCount), unreviewed = Number(value.notReviewedCount);
  const usable = Number(value.usableCount), irrelevant = Number(value.irrelevantCount), insufficient = Number(value.insufficientContextCount);
  if (value.status === 'completed' && n > 0 && usable + irrelevant + insufficient === n) {
    return `已筛选 ${n} 项候选：${usable} 项可作参考，${irrelevant} 项不相关，${insufficient} 项上下文不足；另有 ${unreviewed} 项未送审。筛选不代表写作采用或效果已验证。`;
  }
  if (value.status === 'failed' && usable + irrelevant + insufficient === 0) return `本次准备筛选 ${n} 项，另有 ${unreviewed} 项未纳入；候选筛选未完成，未按词法结果回退供给。`;
  if (value.status === 'not_reviewed' && n === 0 && usable + irrelevant + insufficient === 0) return `本次未送审候选，${unreviewed} 项未审；不能据此认定来源没有可用材料。`;
  return '筛选记录不完整或不兼容，无法确认筛选结果。';
}

/** Retrieval outcome is distinct from candidate screening and material adoption. */
export function initialRetrievalText(value: unknown): string {
  if (!record(value) || value.status === undefined) return '初始检索状态未记录。';
  switch (value.status) {
    case 'uncovered': return '初始检索完成，未找到覆盖本次问题的材料。';
    case 'unavailable': return '初始检索未取得可用结果，无法判断是否有合适材料。';
    case 'matched': return '初始检索已取得参考材料；是否采用及效果需结合后续记录判断。';
    case 'skipped_budget': return '材料预算已满，未进行初始检索。';
    case 'not_connected': return '初始检索未连接。';
    default: return '初始检索状态无法识别，不能确认结果。';
  }
}
