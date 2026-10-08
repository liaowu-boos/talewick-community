import {createHash} from 'node:crypto';

const COUNTS = ['impressions', 'reads', 'completions', 'likes', 'comments', 'favorites', 'follows'];
const LIMIT = '观察数据不能确立因果、文学质量、统计显著性或全平台通用标准。';
const own = (o, k) => Object.hasOwn(o, k);
const copy = x => structuredClone(x);
const hash = x => createHash('sha256').update(x).digest('hex');
function fail(message, code = 'PUBLICATION_FEEDBACK_INVALID') {
  throw Object.assign(new Error(message), {code, status: 400});
}
function object(x, name) {
  if (!x || typeof x !== 'object' || Array.isArray(x) || ![Object.prototype, null].includes(Object.getPrototypeOf(x))) fail(`${name}必须是JSON对象。`);
  return x;
}
function fields(x, keys, name) {
  object(x, name);
  if (Object.keys(x).some(k => !keys.includes(k))) fail(`${name}含不允许的字段。`);
}
function string(x, name, max = 4000, required = false) {
  if (x === undefined || x === null) { if (required) fail(`${name}不能为空。`); return ''; }
  if (typeof x !== 'string' || x.length > max) fail(`${name}必须是长度不超过${max}的字符串。`);
  const value = x.trim();
  if (required && !value) fail(`${name}不能为空。`);
  return value;
}
function list(x, name, max = 100) {
  if (!Array.isArray(x) || x.length > max) fail(`${name}必须是最多${max}项的数组。`);
  return x;
}
function date(x, name) {
  if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(x) || !Number.isFinite(Date.parse(x))) fail(`${name}必须是有效ISO日期。`);
  const [y, m, d] = x.slice(0, 10).split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || +x.slice(11, 13) > 23 || +x.slice(14, 16) > 59 || +x.slice(17, 19) > 59) fail(`${name}不是有效日期。`);
  return Date.parse(x);
}
function canonical(x) {
  if (Array.isArray(x)) return x.map(canonical);
  if (x && typeof x === 'object') return Object.fromEntries(Object.keys(x).sort().map(k => [k, canonical(x[k])]));
  return x;
}
function current(p) {
  object(p, '发布记录'); const observations = list(p.observations ?? [], '观察历史', 100000);
  if (!observations.length) return {snapshot: null, conflict: false};
  const times = observations.map(o => date(o.observedAt, '观察时间'));
  const max = Math.max(...times), candidates = observations.filter((o, i) => times[i] === max);
  const payload = o => JSON.stringify(canonical(Object.fromEntries(Object.entries(o).filter(([k]) => !['id', 'createdAt'].includes(k)))));
  const conflict = new Set(candidates.map(payload)).size > 1;
  return {snapshot: conflict ? null : candidates[0], conflict};
}
function latest(p) { return current(p).snapshot; }
function windowValid(p, o) {
  if (!o || o.windowKind !== 'since_publication' || !p.publishedAt || windowValue(o) === null) return false;
  const duration = date(o.observedAt, '观察时间') - date(p.publishedAt, '发布时间');
  return duration >= 0 && Math.abs(duration - o.windowHours * 3600000) <= 60000;
}

function metrics(o) {
  const m = o?.metrics ?? {};
  object(m, '指标');
  return Object.fromEntries(COUNTS.map(k => {
    const v = m[k] ?? null;
    if (v !== null && (!Number.isSafeInteger(v) || v < 0)) fail(`${k}必须是非负安全整数或null。`);
    return [k, v];
  }));
}
function windowValue(o) {
  const v = o?.windowHours ?? null;
  if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v <= 0)) fail('观察窗必须是正数或null。');
  return v;
}

export function assessPublication(publication) {
  const selected = current(publication), snapshot = selected.snapshot, currentObservationId = snapshot?.id ?? null, observationConflict = selected.conflict, rates = {readRate: null, completionRate: null};
  const facts = [], gaps = [], limitations = [LIMIT, '平台审核结果与读者阅读效果分别记录；曝光量少不等于写作质量差。'];
  if (!snapshot) return {facts, gaps: [observationConflict ? '最新观察同时间存在冲突，不能确定当前快照。' : '尚无发布观察，不能复盘或推算阅读效果。'], limitations, rates, currentObservationId, observationConflict, literaryQuality: 'not_established'};
  const m = metrics(snapshot), windowHours = windowValue(snapshot);
  const status = snapshot.moderation?.status ?? 'unknown';
  facts.push({kind: 'moderation', observationId: snapshot.id ?? null, status, reason: snapshot.moderation?.reason ?? '', category: snapshot.moderation?.category ?? 'unknown'});
  facts.push({kind: 'metrics', observationId: snapshot.id ?? null, observedAt: snapshot.observedAt ?? null, windowHours, metrics: m});
  for (const k of COUNTS) if (m[k] === null) gaps.push(`${k}缺失，不能视为0。`);
  if (status === 'rejected' && !string(snapshot.moderation?.reason, '审核原因')) gaps.push('平台退稿但未给理由，原因未知，不推断为文学质量问题。');
  if (status === 'unknown' || status === 'pending') gaps.push('尚无确定的审核结果。');
  if (windowHours === null) gaps.push('观察时间窗未知。');
  const validWindow = windowValid(publication, snapshot);
  if (!validWindow) limitations.push('统计窗口不是有效自发布起累计窗口，不能用于有效比较或晋级。');
  const defined = validWindow && snapshot.metricsComparable === true && !!string(snapshot.metricDefinition, '指标口径');
  if (!defined) limitations.push('指标口径未确认，不推算阅读率或完读率。');
  for (const [key, numerator, denominator] of [['readRate', 'reads', 'impressions'], ['completionRate', 'completions', 'reads']]) {
    if (m[numerator] === null || m[denominator] === null) continue;
    if (m[numerator] > m[denominator]) { limitations.push(`${numerator}大于${denominator}，保留原值，不推算${key}。`); continue; }
    if (m[denominator] === 0) { limitations.push(`${denominator}为0，${key}没有有效分母。`); continue; }
    if (defined) rates[key] = m[numerator] / m[denominator];
  }
  return {facts, gaps, limitations, rates, currentObservationId, observationConflict, literaryQuality: 'not_established'};
}

export function comparePublications(publications) {
  list(publications, '比较记录', 100);
  const reasons = [], items = publications.map(p => {
    const o = latest(p), assessment = assessPublication(p);
    return {publicationId: p.id ?? null, workId: p.workId ?? null, revision: p.revision ?? null, textSha256: p.textSha256 ?? null,
      platform: string(p.platform, '平台', 200), account: string(p.account, '账号', 200), traffic: p.traffic ?? 'unknown', genre: string(p.genre, '题材', 200),
      workIdentityConfirmed: p.workIdentityConfirmed === true, accountIdentityConfirmed: p.accountIdentityConfirmed === true, publishedAt: p.publishedAt ?? null, observationConflict: assessment.observationConflict, chars: p.chars ?? (typeof p.text === 'string' ? p.text.length : null), snapshot: copy(o), rates: assessment.rates,
      limitations: [...assessment.limitations, ...assessment.gaps]};
  });
  if (items.some(x => !x.workIdentityConfirmed || !x.accountIdentityConfirmed)) reasons.push('作品或账号唯一身份尚未确认；确认仍只是用户声明。');
  if (items.some(x => x.observationConflict)) reasons.push('最新观察同时间冲突，不能选用快照。');
  if (items.some(x => !windowValid(x, x.snapshot))) reasons.push('仅支持时间差一致的自发布起累计窗口。');
  if (items.some(x => x.snapshot && date(x.snapshot.observedAt, '观察时间') > Date.now())) reasons.push('未来观察不能参与有效比较。');
  if (items.length < 2) reasons.push('至少需要两条发布记录才可比较。');
  if (new Set(items.map(x => x.publicationId)).size !== items.length) reasons.push('重复发布记录不能作为独立比较项。');
  for (const key of ['platform', 'account', 'genre']) {
    if (items.some(x => !x[key])) reasons.push(`${key}未知，比较受限。`);
    if (new Set(items.map(x => x[key])).size > 1) reasons.push(`${key}不同，不能直接比较绝对量。`);
  }
  if (items.some(x => !['organic', 'paid'].includes(x.traffic))) reasons.push('流量方式未知，比较受限。');
  if (new Set(items.map(x => x.traffic)).size > 1) reasons.push('流量方式不同，比较受限。');
  if (items.some(x => !x.snapshot)) reasons.push('有记录缺少观察快照。');
  if (items.some(x => windowValue(x.snapshot) === null)) reasons.push('观察时间窗未知，比较受限。');
  if (new Set(items.map(x => windowValue(x.snapshot))).size > 1) reasons.push('观察时间窗不同，比较受限。');
  const defs = items.map(x => string(x.snapshot?.metricDefinition, '指标口径'));
  if (defs.some(x => !x) || items.some(x => x.snapshot?.metricsComparable !== true)) reasons.push('指标口径未明确确认，比较受限。');
  if (new Set(defs).size > 1) reasons.push('指标定义不同，比较受限。');
  const lengthsDiffer = new Set(items.map(x => x.chars)).size > 1;
  for (const item of items) {
    if (lengthsDiffer) item.limitations.push('篇幅不同，阅读负担可能不同，需作为混杂因素保留。');
    if (new Set(items.map(x => x.workId)).size < items.length) item.limitations.push('同一作品的不同发布或快照不算多个独立作品。');
    item.limitations.push('发布时间、呈现方式、账号历史和同期分发变化仍可能影响结果。');
  }
  return {comparable: reasons.length === 0, reasons, items, causality: 'not_established'};
}

function identity(p) {
  object(p, '发布记录');
  for (const key of ['id', 'workId', 'platform', 'account']) string(p[key], key, 200, true);
  if (!Number.isSafeInteger(p.revision) || p.revision < 1) fail('发布版本无效。');
  if (typeof p.text !== 'string' || !p.text.trim() || p.text.length > 120000 || p.textSha256 !== hash(p.text)) fail('稿件正文或SHA绑定无效。');
}
function binding(p, now) {
  identity(p); const o = latest(p);
  if (!o) fail('证据记录缺少观察快照。');
  string(o.id, '观察ID', 200, true);
  const at = date(o.observedAt, '观察时间');
  if (at > now) fail('不能使用未来观察。');
  if (p.publishedAt !== null && p.publishedAt !== undefined && at < date(p.publishedAt, '发布时间')) fail('观察不能早于发布时间。');
  metrics(o); windowValue(o);
  return {publicationId: p.id, workId: p.workId, revision: p.revision, textSha256: p.textSha256, textVersionLabel: p.textVersionLabel ?? '',
    platform: p.platform, account: p.account, traffic: p.traffic ?? 'unknown', genre: p.genre ?? '', chars: p.chars ?? p.text.length,
    workIdentityConfirmed: p.workIdentityConfirmed === true, accountIdentityConfirmed: p.accountIdentityConfirmed === true, publishedAt: p.publishedAt ?? null, observationId: o.id, snapshot: copy(o), snapshotSha256: hash(JSON.stringify(o))};
}
function asPublication(b) {
  if (!b || b.snapshotSha256 !== hash(JSON.stringify(b.snapshot)) || b.observationId !== b.snapshot?.id) fail('冻结证据绑定失效。');
  return {...b, id: b.publicationId, observations: [b.snapshot]};
}
function ids(value, name) {
  const result = list(value, name, 100).map(v => string(v, name, 200, true));
  if (!result.length || new Set(result).size !== result.length) fail(`${name}不能为空或重复。`);
  return result;
}

const TARGET_ALIASES = {
  impressions: ['impressions', '曝光', '曝光量', '展现量'], reads: ['reads', '阅读', '阅读量', '阅读数'],
  completions: ['completions', '完读数', '完读量'], likes: ['likes', '点赞', '点赞数', '点赞量'],
  comments: ['comments', '评论数', '评论量'], favorites: ['favorites', '收藏', '收藏数', '收藏量'],
  follows: ['follows', '关注数', '新增关注', '新增关注数'], readRate: ['readrate', '阅读率'],
  completionRate: ['completionrate', '完读率', '完成率'], moderation: ['moderation', 'moderation.status', '审核', '审核状态', '过审状态', '过审', '审核结果']
};
function targetEvidence(target, bindings) {
  const name = string(target, '目标指标').toLowerCase();
  const key = Object.keys(TARGET_ALIASES).find(k => TARGET_ALIASES[k].includes(name));
  if (!key) fail('目标指标无法解析；可保存计划或记录inconclusive，不能记录支持、反例或暂时采用。');
  return {targetMetric: key, values: bindings.map(b => {
    const p = asPublication(b); let value;
    if (COUNTS.includes(key)) value = metrics(b.snapshot)[key];
    else if (key === 'moderation') {
      value = b.snapshot.moderation?.status;
      if (!['approved', 'rejected', 'changes_requested'].includes(value)) value = null;
    } else value = assessPublication(p).rates[key];
    if (value === null || value === undefined) fail(`基线和后续都须有目标指标${key}的实际证据；比率需要已确认口径与可计算分母。`);
    return {publicationId: b.publicationId, observationId: b.observationId, snapshotSha256: b.snapshotSha256, value};
  })};
}

// Each frozen version participates, including a baseline and current origin sharing an ID.
function evidenceComparison(bindings) {return comparePublications(bindings.map((b,i)=>({...asPublication(b),id:`evidence-${i}`})));}
function normalizedClaim(claim) {return string(claim,'假说内容',4000,true).replace(/\s+/g,' ');}
function validateCriterion(c) {
 fields(c,['kind','value'],'结构化判据');
 if (!['increase','decrease','at_least','at_most','approved'].includes(c.kind)) fail('判据类型无效。');
 if (['at_least','at_most'].includes(c.kind)) {if (typeof c.value!=='number'||!Number.isFinite(c.value)||c.value<0) fail('阈值须为非负有限数值。');}
 else if (own(c,'value')) fail('此判据不接受阈值。');
 return copy(c);
}
function criterionCheck(plan, baseline, followups, origin) {
 const reasons=[];let evidence, criterion;
 try {
  if (!plan?.criterion) fail('计划没有结构化criterion，只能记录inconclusive。');
  criterion=validateCriterion(plan.criterion); evidence=targetEvidence(plan.targetMetric,[...baseline,...followups]);
  if ((evidence.targetMetric==='moderation') !== (criterion.kind==='approved')) fail('审核状态仅支持approved判据；数值目标不能用approved。');
  if (['readRate','completionRate'].includes(evidence.targetMetric) && own(criterion,'value') && criterion.value>1) fail('比率阈值使用0–1。');
 } catch(e) {return {evaluable:false,passed:false,reasons:[e.message],targetEvidence:null,criterion:plan?.criterion??null};}
 const cmp=evidenceComparison([origin,...baseline,...followups]);
 reasons.push(...cmp.reasons);
 const base=evidence.values.slice(0,baseline.length).map(x=>x.value);
 const checks=evidence.values.slice(baseline.length).map(x=>({...x,passed:criterion.kind==='approved'?x.value==='approved':criterion.kind==='increase'?base.every(v=>x.value>v):criterion.kind==='decrease'?base.every(v=>x.value<v):criterion.kind==='at_least'?x.value>=criterion.value:x.value<=criterion.value}));
 if (!checks.length || checks.some(x=>!x.passed)) reasons.push('后续实际指标未逐部达到冻结判据。');
 return {evaluable:true,passed:reasons.length===0,criterion,targetEvidence:evidence,checks,reasons};
}

export function evaluateDecision({publication, reviewId, hypothesisId, input, publications, now = new Date().toISOString()}) {
  identity(publication); const time = date(now, '决策时间');
  if (!latest(publication)) fail('没有发布观察，不能评估复盘决策。');
  reviewId = string(reviewId, '复盘ID', 200, true); hypothesisId = string(hypothesisId, '假说ID', 200, true);
  fields(input, ['reviewId', 'hypothesisId', 'action', 'reason', 'plan', 'result', 'scope', 'planDecisionId'], '决策');
  if (input.reviewId !== reviewId || input.hypothesisId !== hypothesisId) fail('决策与目标复盘或假说不一致。');
  const review = list(publication.reviews ?? [], '复盘历史', 100000).find(r => r.id === reviewId);
  if (!review || review.status !== 'completed' || review.textSha256 !== publication.textSha256 || !Number.isSafeInteger(review.observedRevision) || review.observedRevision < 1 || review.observedRevision > publication.revision || !/^[a-f0-9]{64}$/.test(review.inputHash ?? '') || review.report?.inputHash !== review.inputHash) fail('需要绑定本稿的已完成复盘。');
  if (!list(review.report.hypotheses, '假说', 100).some(h => h.id === hypothesisId)) fail('假说不存在。');
  const action = input.action;
  if (!['plan_test', 'record_result', 'adopt', 'reject', 'withdraw'].includes(action)) fail('不支持的决策动作。');
  const reason = string(input.reason, '决策理由', 4000, true), scope = string(input.scope, '适用范围', 4000);
  if (!['record_result','adopt'].includes(action) && own(input,'planDecisionId')) fail('此动作不接受计划ID。');
  if (action !== 'plan_test' && own(input, 'plan') || action !== 'record_result' && own(input, 'result')) fail('决策携带了与动作不符的计划或结果。');
  const all = new Map();
  for (const p of list(publications ?? [], '证据记录', 100)) { identity(p); if (all.has(p.id)) fail('证据记录ID重复。'); all.set(p.id, p); }
  if (all.has(publication.id) && JSON.stringify(all.get(publication.id)) !== JSON.stringify(publication)) fail('起源稿版本不一致。');
  all.set(publication.id, publication);
  const histories = list(publication.decisions ?? [], '决策历史', 100000).filter(d => d.reviewId === reviewId && d.hypothesisId === hypothesisId);
  for (const d of histories) { string(d.id, '历史决策ID', 200, true); if (date(d.createdAt, '历史决策时间') > time) fail('决策时间早于已有历史。'); }
  const plan = histories.filter(d => d.action === 'plan_test').at(-1);
  const evidenceBindings = {schemaVersion: 'publication-feedback-evidence-v1', review: {publicationId: publication.id, textSha256: publication.textSha256, reviewId, hypothesisId, inputHash: review.inputHash, observedRevision: review.observedRevision}, planDecisionId: plan?.id ?? null, baseline: [], publications: []};
  const out = {reviewId, hypothesisId, action, reason, ...(scope ? {scope} : {}), limitations: [LIMIT, '至少两部后续作品只是阻止单例晋级的流程底线，不是统计置信或文学及格门槛。'], evidenceBindings};
  const resolve = id => { const p = all.get(id); if (!p) fail(`找不到证据发布记录：${id}`); return binding(p, time); };
  if (action === 'plan_test') {
    fields(input.plan, ['change', 'keepFixed', 'targetMetric', 'successCriterion', 'baselinePublicationIds', 'criterion'], '验证计划');
    out.plan = Object.fromEntries(['change', 'keepFixed', 'targetMetric', 'successCriterion'].map(k => [k, string(input.plan[k], k, 4000, true)]));
    if (input.plan.criterion !== undefined) out.plan.criterion = validateCriterion(input.plan.criterion);
    out.plan.baselinePublicationIds = ids(input.plan.baselinePublicationIds, '基线发布ID');
    evidenceBindings.baseline = out.plan.baselinePublicationIds.map(resolve);
    out.status = 'testing'; return out;
  }
  if (action === 'reject') { out.status = 'rejected'; return out; }
  if (action === 'withdraw') {
    if (!histories.some(d => d.status === 'provisionally_adopted')) fail('尚未暂时采用，不能撤回；可拒绝该假说。');
    out.status = 'withdrawn'; return out;
  }
  if (!plan) fail('请先保存验证计划。');
  if (string(input.planDecisionId, '计划ID', 200, true) !== plan.id) fail('必须明确绑定当前有效计划ID，旧计划结果不能挪用。');
  out.planDecisionId = plan.id;
  if (histories.slice(histories.indexOf(plan) + 1).some(d => ['reject', 'withdraw'].includes(d.action))) fail('假说已拒绝或撤回，请先保存新计划。');
  const baseline = plan.evidenceBindings?.baseline;
  if (!Array.isArray(baseline) || !baseline.length) fail('计划缺少冻结基线。');
  baseline.forEach(asPublication); evidenceBindings.baseline = copy(baseline);
  const baseHashes = new Set([publication.textSha256, ...baseline.map(b => b.textSha256)]);
  const baseWorks = new Set([publication.workId, ...baseline.map(b => b.workId)]), planTime = date(plan.createdAt, '计划时间');
  function checkFollowup(b) {
    asPublication(b);
    if (baseHashes.has(b.textSha256)) fail('后续正文不能与起源或基线稿相同。');
    if (baseWorks.has(b.workId)) fail('起源稿或基线稿的重复发布/快照不能充当后续独立作品。');
    if (!b.publishedAt || date(b.publishedAt,'后续发布时间') <= planTime) fail('有效支持的稿件必须在计划后发布。');
    if (date(b.snapshot.observedAt, '后续观察时间') <= planTime) fail('后续观察必须晚于计划。');
  }
  if (action === 'record_result') {
    fields(input.result, ['publicationIds', 'conclusion', 'note'], '验证结果');
    const publicationIds = ids(input.result.publicationIds, '后续发布ID');
    if (!['supports', 'contradicts', 'inconclusive'].includes(input.result.conclusion)) fail('验证结果结论无效。');
    out.result = {publicationIds, conclusion: input.result.conclusion, note: string(input.result.note, '结果说明')};
    evidenceBindings.publications = publicationIds.map(resolve);
    if (out.result.conclusion === 'supports') evidenceBindings.publications.forEach(checkFollowup);
    if (out.result.conclusion !== 'inconclusive' && evidenceBindings.publications.some(b => Object.values(metrics(b.snapshot)).every(v => v === null) && !['approved', 'rejected', 'changes_requested'].includes(b.snapshot.moderation?.status))) fail('缺少实际指标或确定审核观察，只能记录无法判断。');
    const origin = binding(publication, time);
    evidenceBindings.origin = origin;
    const check = criterionCheck(plan.plan, baseline, evidenceBindings.publications, origin);
    evidenceBindings.criterionCheck = check;
    if (out.result.conclusion === 'supports' && !check.passed) fail('不能记录有效支持：' + check.reasons.join('；'));
    if (out.result.conclusion === 'contradicts' && !check.evaluable) fail('目标或判据未就绪，只能记录inconclusive。');
    const comparison = comparePublications([...baseline, ...evidenceBindings.publications].map(asPublication));
    out.limitations.push(...comparison.reasons, ...check.reasons);
    out.status = {supports: 'supported', contradicts: 'contradicted', inconclusive: 'inconclusive'}[out.result.conclusion];
    out.limitations.push('支持/反例是用户记录的观察结论，程序未验证指标改善或原因假说成立。');
    return out;
  }
  if (!scope) fail('暂时采用必须说明适用范围。');
  if (/全平台|所有平台|任意平台|跨平台|全账号|所有账号|任意账号|跨账号|所有题材|任意题材|全题材|永久|普遍适用|通用规则|all\s+platforms|universal/i.test(scope)) fail('适用范围不能扩大到全平台、全账号、全题材或永久标准。');
  // No field in v1 resolves a counterexample: never erase it by merely appending a new plan.
  const claim = normalizedClaim(review.report.hypotheses.find(h => h.id === hypothesisId).claim);
  const related = (publication.decisions ?? []).filter(d => {const r=(publication.reviews ?? []).find(r=>r.id===d.reviewId);const h=r?.report?.hypotheses?.find(h=>h.id===d.hypothesisId);return h && normalizedClaim(h.claim)===claim;});
  if (related.some(d => d.action === 'record_result' && (d.status === 'contradicted' || d.result?.conclusion === 'contradicts'))) fail('已有反例尚未解决，不能直接暂时采用；需提出范围更明确的新假说并继续验证。', 'PUBLICATION_FEEDBACK_COUNTEREXAMPLE_UNRESOLVED');
  const supported = histories.filter(d => d.action === 'record_result' && d.status === 'supported' && d.result?.conclusion === 'supports' && d.evidenceBindings?.planDecisionId === plan.id);
  const frozen = new Map();
  for (const d of supported) {
    if (JSON.stringify(d.evidenceBindings.baseline) !== JSON.stringify(baseline)) fail('支持记录与计划基线不一致。');
    for (const b of d.evidenceBindings.publications ?? []) { checkFollowup(b); const prior = frozen.get(b.publicationId); if (prior && prior.snapshotSha256 !== b.snapshotSha256) fail('同一发布含多份支持快照，请先以新计划明确依据。'); frozen.set(b.publicationId, copy(b)); }
  }
  if (new Set([...frozen.values()].map(b => b.workId)).size < 2 || new Set([...frozen.values()].map(b=>b.textSha256)).size < 2) fail('暂时采用至少需要两部不同workId的后续支持作品。');
  const origin = binding(publication, time); evidenceBindings.origin = origin;
  const check = criterionCheck(plan.plan, baseline, [...frozen.values()], origin); evidenceBindings.criterionCheck = check;
  if (!check.passed) fail('不能暂时采用：' + check.reasons.join('；'));
  const comparison = evidenceComparison([origin, ...baseline, ...frozen.values()]);
  if (!comparison.comparable) fail('暂时采用证据不可比：' + comparison.reasons.join('；'));
  evidenceBindings.targetEvidence = check.targetEvidence;
  const first = baseline[0];
  evidenceBindings.applicability = {platform: first.platform, account: first.account, genre: first.genre, traffic: first.traffic, windowKind: first.snapshot.windowKind, windowHours: first.snapshot.windowHours, metricDefinition: first.snapshot.metricDefinition.trim(), targetMetric: evidenceBindings.targetEvidence.targetMetric, provisional: true, scopeTextIsAdditionalRestrictionOnly: true};
  out.limitations.push('结构化applicability是适用范围上限；自由scope仅为附加说明，不能覆盖或扩大冻结的平台、账号、题材、流量、口径和观察窗。');
  evidenceBindings.publications = [...frozen.values()]; evidenceBindings.supportDecisionIds = supported.map(d => d.id);
  out.status = 'provisionally_adopted'; out.limitations.push('只在所填范围暂时采用；保留反例与撤回入口，不构成永久标准。');
  for (const item of comparison.items) out.limitations.push(...item.limitations);
  out.limitations = [...new Set(out.limitations)]; return out;
}
