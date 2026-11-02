import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EVENT_GROUNDING_POLICY = 'event-state-and-time-grounding-1';
const VERSION = 'review-evidence-audit-event-grounding-1';
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const sha = v => createHash('sha256').update(v).digest('hex');
const hash = v => sha(JSON.stringify(canonical(v)));
const same = (a, b) => hash(a) === hash(b);
const text = v => typeof v === 'string' && v.trim().length > 0;
const ensure = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const NATURES = ['verifiable_fact', 'mixed_fact_interpretation', 'literary_interpretation', 'uncertain'];
const KINDS = ['none', 'event_order', 'chronology_conflict', 'schedule_difference', 'uncertain'];
const STATES = ['planned', 'executed', 'recalled', 'uncertain'];
const RELATIONS = ['before', 'after', 'same_time', 'unknown'];
const BASES = ['explicit_clock', 'explicit_relation', 'recollection', 'narrative_sequence_only', 'absence_only', 'uncertain'];

export const EVENT_GROUNDING_INSTRUCTION = `【显式event-state-and-time-grounding-1：原canonical v3之外的事实/解释与时序依据】
这是一道额外gate，不是新偏好票。先把原claim中的可核实前提与感受/文学解释分开。factChecks里“阅读动力放缓、心理可信、余味更强、解释过度”等不能仅因你觉得合理就成为确定事实；这些解释应留在原两轴。混合句应从原claim的宿主span目录选择真正可核实的部分，保留条件、否定和范围。不能拆开时保留uncertain与limits，不把整句supported，也不能删改原意见。
eventGrounding.facts恰好覆盖本target的全部factId。claimNature说明核查片段是verifiable_fact、mixed_fact_interpretation、literary_interpretation还是uncertain；只有已分离的verifiable_fact可作确定事实。temporalKind是none、event_order、chronology_conflict、schedule_difference或uncertain。不得把明确的先后、再次、提前、尚未、计划/执行冲突伪装成none来免查；非时序事实不强造两个事件。
每项时序判断明确left/right两个不同事件，指向本稿原paragraph anchor，分别标planned（计划、提议、承诺）、executed（被叙述实际执行）、recalled（回忆/转述的过去事件）或uncertain。回忆所在的章序不是事件发生位置；角色声称做过也不自动等于叙述事实。事件自身和关系依据须出现在该fact的evidence/counterEvidence，contextAnchorIds覆盖宿主给的前后相邻可引段落，并补充必要的日期/回忆/改约上下文。不能只核原引文。
assertedRelation指本fact原断言中的left相对right先后，不是按章节排序后的臆测。relationBasis区分explicit_clock、explicit_relation、recollection、narrative_sequence_only、absence_only和uncertain。仅凭章序/提到的先后不能作确定事件顺序；“没写取出/归还/改约/再次发生”只能说明本次读到的缺口，不能证明没发生。未知允许，不能为填表发明事实。
计划下午送出、实际更早取回，首先是计划与执行衔接待查，不能直接判两个已执行动作时间倒置。possible改约、回忆、不同轮次或未写桥接应记录alternativeExplanation及limits；不要替作者补桥，也不要把可能性当已发生。chronology_conflict的确定结论要求两个已执行事件及可核对关系；planned/recalled/uncertain状态不能被暗中升格。
clockId只能从宿主字面时钟目录选取，不能新写时间数值。目录不判发生事实：相同“下午三点”可在计划或回忆中。explicit_clock还须提供sameDayContextAnchorIds作为同日依据；同日继承仍是你可能出错的语义判断。宿主只比较保守分钟区间；无上午/下午的八点保留08/20两种可能，“第二天”不自动变成绝对第2日，无法确定则uncertain。对明确关系用relationEvidenceAnchorIds，不能用裸章号代替。
通用虚构例子：修表匠上午九点已经收款，下午才看见遗失通知，不能写成“看见通知后才收款”。向导说次日下午出发，后来早晨到站，先查是否改约/回忆/另一趟；不能将计划当已执行。先出现归航回忆、后叙写出港不等于航次倒置。“我觉得结尾安静”留作文学解释，不造已证实事实。
所有新增字段和版本须随请求记录。宿主只检查绑定与一致性，不替你证明语义；不改原status、偏好、引文或稿件，不强迫肯定/否定。每个理由/限制用一句短话，保留所有原覆盖项。`;

export function getAuditEventGroundingVersions() {
  const file = fileURLToPath(import.meta.url), stat = lstatSync(file);
  ensure(stat.isFile() && !stat.isSymbolicLink(), 'EVENT_GROUNDING_SOURCE');
  if (process.platform === 'darwin') ensure(!(Number(execFileSync('/usr/bin/stat', ['-f', '%f', file], { encoding: 'utf8' }).trim()) & 0x40000000), 'EVENT_GROUNDING_DATALESS');
  return freeze({ policyVersion: EVENT_GROUNDING_POLICY, toolVersion: sha(readFileSync(file)) });
}

function numeral(s) {
  if (/^\d+$/.test(s)) return Number(s);
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (s === '十') return 10;
  if (s.includes('十')) { const [a, b] = s.split('十'); return (a ? digits[a] : 1) * 10 + (b ? digits[b] : 0); }
  return s.length === 1 ? digits[s] : NaN;
}
// Literal clock parsing only. No chapter-order, calendar-day, event-state or story inference.
function clockRanges(literal) {
  if (literal === '中午') return { ranges: [[660, 839]], reading: 'broad_noon_period' };
  const m = literal.match(/^(凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)?\s*([0-9零〇一二两三四五六七八九十]+)(点|[:：])(?:(半|一刻|三刻|[0-9零〇一二两三四五六七八九十]+)(?:分)?)?(多|左右)?$/u);
  if (!m) return null;
  const h = numeral(m[2]), minutes = m[4] === '半' ? 30 : m[4] === '一刻' ? 15 : m[4] === '三刻' ? 45 : m[4] ? numeral(m[4]) : 0;
  if (!Number.isInteger(h) || h < 0 || h > 23 || !Number.isInteger(minutes) || minutes < 0 || minutes > 59) return null;
  let hours, reading;
  if (m[1]) {
    if (h > 12) return null;
    const pm = ['中午', '下午', '傍晚', '晚上', '夜里'].includes(m[1]);
    if (m[1] === '中午' && ![11, 12, 1, 2].includes(h)) return null;
    hours = [pm ? (h === 12 || h === 11 && m[1] === '中午' ? h : h + 12) : h]; reading = 'explicit_period';
  } else if (m[3] !== '点' || h === 0 || h > 12) { hours = [h]; reading = 'numeric_24h'; }
  else { hours = h === 12 ? [0, 12] : [h, h + 12]; reading = 'ambiguous_meridiem'; }
  return { ranges: hours.map(hour => {
    const at = hour * 60 + minutes;
    return m[5] === '多' ? [at, Math.min(1439, at + 59)] : m[5] === '左右' ? [Math.max(0, at - 30), Math.min(1439, at + 30)] : [at, at];
  }), reading };
}

export function prepareAuditEventGrounding({ manuscripts } = {}) {
  ensure(Array.isArray(manuscripts) && manuscripts.length > 0, 'EVENT_GROUNDING_MANUSCRIPTS');
  const anchors = [], clocks = [], blindIds = new Set(), anchorIds = new Set();
  for (const m of manuscripts) {
    ensure(object(m) && text(m.blindId) && !blindIds.has(m.blindId) && /^[a-f0-9]{64}$/.test(m.manuscriptSha256) && Array.isArray(m.chapters), 'EVENT_GROUNDING_MANUSCRIPT'); blindIds.add(m.blindId);
    const chapterIds = new Set();
    for (const ch of m.chapters) {
      ensure(object(ch) && text(ch.id) && !chapterIds.has(ch.id) && Array.isArray(ch.paragraphs), 'EVENT_GROUNDING_CHAPTER'); chapterIds.add(ch.id);
      let start = 0; const chapter = [];
      for (const p of ch.paragraphs) {
        ensure(object(p) && text(p.anchorId) && !anchorIds.has(p.anchorId) && typeof p.text === 'string' && typeof p.citable === 'boolean', 'EVENT_GROUNDING_ANCHOR'); anchorIds.add(p.anchorId);
        const a = { anchorId: p.anchorId, blindId: m.blindId, chapterId: ch.id, start, end: start + p.text.length,
          text: p.text, textSHA256: sha(p.text), citable: p.citable, manuscriptSha256: m.manuscriptSha256, requiredContextAnchorIds: [] };
        start = a.end; anchors.push(a); chapter.push(a);
      }
      const citable = chapter.filter(a => a.citable);
      for (const [i, a] of citable.entries()) a.requiredContextAnchorIds = [citable[i - 1]?.anchorId, citable[i + 1]?.anchorId].filter(Boolean);
    }
  }
  const pattern = /(?:(?:凌晨|早上|早晨|上午|中午|下午|傍晚|晚上|夜里)\s*)?[0-9零〇一二两三四五六七八九十]{1,3}(?:点(?:(?:半|一刻|三刻)|(?:[0-9零〇一二两三四五六七八九十]{1,3}分?))?|[:：][0-9]{2})(?:多|左右)?|中午/gu;
  for (const a of anchors.filter(a => a.citable)) for (const match of a.text.matchAll(pattern)) {
    const parsed = clockRanges(match[0]); if (!parsed) continue;
    clocks.push({ clockId: `TC${String(clocks.length + 1).padStart(5, '0')}`, anchorId: a.anchorId,
      start: match.index, end: match.index + match[0].length, literal: match[0], ...parsed });
  }
  const versions = getAuditEventGroundingVersions(), manuscriptHash = hash(manuscripts);
  const bindingHash = hash({ schemaVersion: VERSION, versions, manuscriptHash, anchors, clocks });
  const packet = { schemaVersion: `${VERSION}-packet`, versions, bindingHash, manuscriptHash,
    clockMarkers: clocks, contextRequirement: 'event_anchor_plus_previous_and_next_citable_paragraph_in_same_chapter',
    temporalTruthNotInferredByHost: true };
  return freeze({ schemaVersion: `${VERSION}-prepared`, versions, manuscripts: structuredClone(manuscripts), manuscriptHash, bindingHash, anchors, clocks, packet });
}
function validatedPrepared(prepared) {
  const expected = prepareAuditEventGrounding({ manuscripts: prepared?.manuscripts });
  ensure(same(prepared, expected), 'EVENT_GROUNDING_PREPARED_BINDING'); return expected;
}

const obj = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const str = { type: 'string', minLength: 1 }, nullable = { type: ['string', 'null'] };
const ids = () => ({ type: 'array', items: str }); // Uniqueness is checked by host, not an unsupported CLI schema keyword.
export function auditEventGroundingAssessmentContractFields({ prepared, target } = {}) {
  const p = validatedPrepared(prepared);
  ensure(text(target?.targetId) && /^[a-f0-9]{64}$/.test(target.targetSHA) && Array.isArray(target.allowedBlindIds)
    && target.allowedBlindIds.every(id => p.manuscripts.some(m => m.blindId === id)), 'EVENT_GROUNDING_TARGET');
  const event = () => obj({ anchorId: str, state: { type: 'string', enum: STATES }, contextAnchorIds: ids(), clockId: nullable });
  const temporal = obj({ assertedRelation: { type: 'string', enum: RELATIONS }, left: event(), right: event(),
    relationBasis: { type: 'string', enum: BASES }, relationEvidenceAnchorIds: ids(), sameDayContextAnchorIds: ids(),
    alternativeExplanation: nullable, limits: nullable });
  return { eventGrounding: obj({ bindingHash: { type: 'string', const: p.bindingHash }, facts: { type: 'array', items: obj({
    factId: str, claimNature: { type: 'string', enum: NATURES }, temporalKind: { type: 'string', enum: KINDS },
    temporal: { anyOf: [{ type: 'null' }, temporal] },
  }) } }) };
}

function clockRelation(left, right) {
  if (left.ranges.every(a => right.ranges.every(b => a[1] < b[0]))) return 'before';
  if (left.ranges.every(a => right.ranges.every(b => a[0] > b[1]))) return 'after';
  if (left.ranges.length === 1 && right.ranges.length === 1 && left.ranges[0][0] === left.ranges[0][1]
    && right.ranges[0][0] === right.ranges[0][1] && left.ranges[0][0] === right.ranges[0][0]) return 'same_time';
  return 'unknown';
}

/** Additional read-only gate. It never coerces a fact/axis status or creates a completed canonical result. */
export function checkAuditEventGroundingAssessment({ prepared, target, assessment, eventGrounding, assessmentIndex = 0 } = {}) {
  const p = validatedPrepared(prepared), issues = [], mappings = [], root = `/assessments/${assessmentIndex}/eventGrounding`;
  const issue = (code, pointer, detail, severity = 'error') => issues.push({ code, JSONPointer: pointer, detail, severity });
  const exact = (v, keys, pointer) => {
    if (!object(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) { issue('EVENT_GROUNDING_FIELDS', pointer, { expected: keys }); return false; } return true;
  };
  const anchors = new Map(p.anchors.map(a => [a.anchorId, a])), clocks = new Map(p.clocks.map(c => [c.clockId, c]));
  const allow = new Set(target?.allowedBlindIds ?? []);
  const list = (value, pointer, allowedBlindId) => {
    if (!Array.isArray(value)) { issue('EVENT_GROUNDING_REFS', pointer, 'Expected anchor array'); return []; }
    const seen = new Set(), valid = [];
    for (const [i, id] of value.entries()) {
      const a = anchors.get(id);
      if (!a?.citable || seen.has(id) || !allow.has(a.blindId) || allowedBlindId && a.blindId !== allowedBlindId) issue('EVENT_GROUNDING_ANCHOR_BINDING', `${pointer}/${i}`, { anchorId: id });
      else valid.push(a);
      seen.add(id);
    } return valid;
  };
  if (!target || assessment?.targetId !== target.targetId || assessment?.targetSHA !== target.targetSHA || !Array.isArray(assessment?.factChecks)) issue('EVENT_GROUNDING_TARGET_BINDING', root, 'Canonical target/fact list mismatch');
  if (exact(eventGrounding, ['bindingHash', 'facts'], root)) {
    if (eventGrounding.bindingHash !== p.bindingHash) issue('EVENT_GROUNDING_BINDING', `${root}/bindingHash`, 'Wrong manuscript/policy binding');
    const facts = new Map((assessment?.factChecks ?? []).map(f => [f.factId, f]));
    if (!Array.isArray(eventGrounding.facts) || eventGrounding.facts.length !== facts.size) issue('EVENT_GROUNDING_FACT_COVERAGE', `${root}/facts`, { expected: facts.size });
    const seen = new Set();
    for (const [i, row] of (Array.isArray(eventGrounding.facts) ? eventGrounding.facts : []).entries()) {
      const q = `${root}/facts/${i}`;
      if (!exact(row, ['factId', 'claimNature', 'temporalKind', 'temporal'], q)) continue;
      const f = facts.get(row.factId);
      if (!f || seen.has(row.factId)) { issue('EVENT_GROUNDING_FACT_BINDING', q, { factId: row.factId }); continue; } seen.add(row.factId);
      if (!NATURES.includes(row.claimNature) || !KINDS.includes(row.temporalKind)) { issue('EVENT_GROUNDING_ENUM', q, 'Unknown kind'); continue; }
      const conclusive = ['supported', 'contradicted'].includes(f.status);
      if (!['supported', 'contradicted', 'uncertain'].includes(f.status)) issue('EVENT_GROUNDING_FACT_STATUS', q, 'Canonical validator must reject this fact status too');
      if (row.claimNature !== 'verifiable_fact') issue('EVENT_GROUNDING_FACT_INTERPRETATION', q,
        'Separate factual premise from interpretation; host will not rewrite the selected span or status.', conclusive ? 'error' : 'limitation');
      const fm = { factId: f.factId, claimNature: row.claimNature, temporalKind: row.temporalKind, events: [], conditionalClockRelation: null };
      mappings.push(fm);
      if (row.temporalKind === 'none') { if (row.temporal !== null) issue('EVENT_GROUNDING_NON_TEMPORAL_FIELDS', q, 'Non-temporal fact must have temporal:null'); continue; }
      if (row.temporalKind === 'uncertain' && row.temporal === null) {
        issue('EVENT_GROUNDING_UNRESOLVED', q, 'Temporal premise unresolved', conclusive ? 'error' : 'limitation'); continue;
      }
      const t = row.temporal;
      if (!exact(t, ['assertedRelation', 'left', 'right', 'relationBasis', 'relationEvidenceAnchorIds', 'sameDayContextAnchorIds', 'alternativeExplanation', 'limits'], `${q}/temporal`)) continue;
      if (!RELATIONS.includes(t.assertedRelation) || !BASES.includes(t.relationBasis)
        || ![t.alternativeExplanation, t.limits].every(v => v === null || text(v))) issue('EVENT_GROUNDING_TEMPORAL_FIELDS', `${q}/temporal`, 'Unknown relation/basis or empty limit');
      const cited = new Set([...(f.evidence ?? []), ...(f.counterEvidence ?? [])].map(r => r.anchorId));
      const events = [];
      for (const side of ['left', 'right']) {
        const e = t[side], ep = `${q}/temporal/${side}`;
        if (!exact(e, ['anchorId', 'state', 'contextAnchorIds', 'clockId'], ep)) continue;
        const a = list([e.anchorId], `${ep}/anchorId`)[0];
        if (!STATES.includes(e.state)) issue('EVENT_GROUNDING_EVENT_STATE', `${ep}/state`, 'State must be planned/executed/recalled/uncertain');
        if (!a) continue;
        if (!cited.has(a.anchorId)) issue('EVENT_GROUNDING_EVENT_NOT_CITED', ep, { anchorId: a.anchorId });
        const contexts = list(e.contextAnchorIds, `${ep}/contextAnchorIds`, a.blindId);
        const missing = a.requiredContextAnchorIds.filter(id => !contexts.some(c => c.anchorId === id));
        if (missing.length) issue('EVENT_GROUNDING_CONTEXT_MISSING', ep, { requiredAnchorIds: missing });
        const clock = e.clockId === null ? null : clocks.get(e.clockId);
        if (e.clockId !== null && (!clock || ![a.anchorId, ...contexts.map(c => c.anchorId)].includes(clock.anchorId))) issue('EVENT_GROUNDING_CLOCK_BINDING', `${ep}/clockId`, { clockId: e.clockId });
        events.push({ ...e, anchor: a, clock });
        fm.events.push({ side, anchorId: a.anchorId, state: e.state, blindId: a.blindId, chapterId: a.chapterId,
          sourceTextSHA256: a.textSHA256, context: contexts.map(c => ({ anchorId: c.anchorId, textSHA256: c.textSHA256 })), clock });
      }
      if (events.length !== 2) continue;
      const [left, right] = events;
      if (left.anchorId === right.anchorId) issue('EVENT_GROUNDING_SHARED_EVENT_ANCHOR', `${q}/temporal`,
        'Two events may share one paragraph; their distinct action identities remain a semantic claim, not a paragraph-count proof.', 'limitation');
      if (left.anchor.blindId !== right.anchor.blindId) issue('EVENT_GROUNDING_CROSS_MANUSCRIPT_ORDER', `${q}/temporal`, 'Cross-version positions do not define an event timeline');
      const relations = list(t.relationEvidenceAnchorIds, `${q}/temporal/relationEvidenceAnchorIds`, left.anchor.blindId);
      const days = list(t.sameDayContextAnchorIds, `${q}/temporal/sameDayContextAnchorIds`, left.anchor.blindId);
      for (const a of [...relations, ...days]) if (!cited.has(a.anchorId)) issue('EVENT_GROUNDING_RELATION_NOT_CITED', `${q}/temporal`, { anchorId: a.anchorId });
      if (row.temporalKind === 'uncertain' || [left.state, right.state].includes('uncertain') || t.assertedRelation === 'unknown') issue('EVENT_GROUNDING_UNRESOLVED', `${q}/temporal`, 'Unresolved event/order cannot be conclusive', conclusive ? 'error' : 'limitation');
      if (['narrative_sequence_only', 'absence_only', 'uncertain', 'recollection'].includes(t.relationBasis)) issue('EVENT_GROUNDING_INSUFFICIENT_TIME_BASIS', `${q}/temporal/relationBasis`, 'Narrative order, omission, or unanchored recollection does not establish chronology', conclusive ? 'error' : 'limitation');
      if (['event_order', 'chronology_conflict'].includes(row.temporalKind) && [left.state, right.state].some(s => s === 'planned')) issue('EVENT_GROUNDING_PLAN_NOT_EXECUTION', `${q}/temporal`, 'Planned times are not completed event chronology', conclusive ? 'error' : 'limitation');
      if (row.temporalKind === 'chronology_conflict' && [left.state, right.state].some(s => s !== 'executed')) issue('EVENT_GROUNDING_CONFLICT_EVENT_STATE', `${q}/temporal`, 'A definite execution conflict requires two executed events', conclusive ? 'error' : 'limitation');
      if (row.temporalKind === 'chronology_conflict' && !text(t.alternativeExplanation)) issue('EVENT_GROUNDING_ALTERNATIVES_MISSING', `${q}/temporal/alternativeExplanation`, 'State what rescheduling/recollection/other-round possibility remains');
      if (row.temporalKind === 'schedule_difference' && ![left.state, right.state].includes('planned')) issue('EVENT_GROUNDING_SCHEDULE_STATE', `${q}/temporal`, 'Schedule comparison needs a planned event');
      if (row.temporalKind === 'schedule_difference' && (!text(t.alternativeExplanation) || !text(t.limits))) issue('EVENT_GROUNDING_SCHEDULE_LIMITS', `${q}/temporal`, 'Schedule difference must not become an unexplained execution impossibility');
      if (t.relationBasis === 'explicit_relation' && relations.length === 0) issue('EVENT_GROUNDING_RELATION_MISSING', `${q}/temporal`, 'An explicit relation needs cited textual evidence');
      if (t.relationBasis === 'explicit_clock') {
        if (!left.clock || !right.clock || !days.length) issue('EVENT_GROUNDING_CLOCK_CONTEXT', `${q}/temporal`, 'Two bound clocks and cited same-day context required');
        else {
          const actual = clockRelation(left.clock, right.clock); fm.conditionalClockRelation = actual;
          if (actual === 'unknown') issue('EVENT_GROUNDING_CLOCK_UNDERDETERMINED', `${q}/temporal`, 'Clock ranges overlap or meridiem is ambiguous', conclusive ? 'error' : 'limitation');
          else if ((f.status === 'supported' && t.assertedRelation !== actual)
            || (f.status === 'contradicted' && t.assertedRelation === actual)) issue('EVENT_GROUNDING_CLOCK_STATUS_CONFLICT', `${q}/temporal`, { asserted: t.assertedRelation, conditionalActual: actual, unchangedFactStatus: f.status });
        }
      }
    }
    for (const id of facts.keys()) if (!seen.has(id)) issue('EVENT_GROUNDING_FACT_COVERAGE', `${root}/facts`, { missingFactId: id });
  }
  const needsReview = issues.some(i => i.severity === 'error');
  return freeze({ schemaVersion: `${VERSION}-gate`, policyVersion: EVENT_GROUNDING_POLICY,
    status: needsReview ? 'needs_review' : 'structurally_consistent', needsReview, issues,
    proof: { versions: p.versions, bindingHash: p.bindingHash, targetId: target?.targetId ?? null, targetSHA: target?.targetSHA ?? null,
      assessmentSHA256: hash(assessment ?? null), eventGroundingSHA256: hash(eventGrounding ?? null), mappings,
      originalAssessmentUnchanged: true, sameDayAndEventStateRemainSemanticClaims: true },
    automaticAdoption: false, semanticAccuracy: 'NOT_VERIFIED' });
}
