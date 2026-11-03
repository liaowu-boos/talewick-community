import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const REVIEW_POLICY_VERSION = 'independent-review-evidence-policy-1';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const GENERAL_EVIDENCE_RULES = [
  '输出契约中的示例只演示字段形状，不是默认答案，也不是已证实事实；示例中的任何段落编号都不是必选值。每条证据都要从当前完整正文实际选择支持该判断的可引用 anchorId。不要把格式示例误读为只能使用某一个编号，也不要照抄示例判断。',
  '先读完整正文再选证据。paragraphs中的每个anchorId仅对应当前packet中该段文字；编号不表示重要性或证据强弱。不同请求的同名编号不得跨请求沿用。引用成功、位置精确或JSON合规只证明文本定位，不能证明观点得到支持。',
  '比较时身份仍隐藏，差异必须由你阅读两篇全文自行判断。只有逐章逐段核对标题和正文后，才可断言全文逐字相同或全部没有变化；无明显偏好、情节相近、局部相同都不等于全文无差异。只收到一篇稿时不得判断两稿关系。',
  '核查事实须区分叙述者直接陈述、人物说的话、转述、猜测、条件假设及尚未发生的计划。对话能证明某人说过某句话，不自动证明话中事件真实发生。明确记录谁说、对谁说、指令由谁发出、谁执行；上下文不能确定时标注不确定。',
  '人物性别、亲属或职务身份须有明确文本支持，不凭姓名、岗位或行为推定；代词及省略主语的归属须核对相邻上下文。一个段落出现同一人物不代表它支持关于此人物的任何断言。',
  '分别陈述可核查事实和文学解释，保留反证与不确定性；不能把程序完成、引用可定位、改动存在、读者偏好混为文学质量通过。',
].join('\n');

function changedSpan(before, after) {
  if (before === after) return null;
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  if (start > 0 && /[\uD800-\uDBFF]/.test(before[start - 1])) start--;
  let beforeEnd = before.length, afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) { beforeEnd--; afterEnd--; }
  if (beforeEnd < before.length && /[\uDC00-\uDFFF]/.test(before[beforeEnd])) { beforeEnd++; afterEnd++; }
  return { start, beforeEnd, afterEnd, beforeText: before.slice(start, beforeEnd), afterText: after.slice(start, afterEnd),
    spanType: 'single-enclosing-replacement-not-minimal-edit-script', offsetUnit: 'UTF-16 code units' };
}
export function computeDifferenceAudit(before, after) {
  assert(Array.isArray(before) && Array.isArray(after) && before.length === after.length);
  const chapters = before.map((old, i) => {
    const next = after[i]; assert.equal(old.id, next.id);
    const titleSame = old.title === next.title, bodySame = old.body === next.body;
    return { chapterId: old.id, titleSame, bodySame, titleBefore: old.title, titleAfter: next.title,
      beforeBodySHA256: hash(old.body), afterBodySHA256: hash(next.body),
      beforeUTF16Length: old.body.length, afterUTF16Length: next.body.length,
      ...(bodySame ? {} : { replacement: changedSpan(old.body, next.body) }) };
  });
  const core = { schemaVersion: 'literal-fulltext-difference-audit-1', beforeSHA256: hash(before), afterSHA256: hash(after),
    allTextIdentical: chapters.every(c => c.titleSame && c.bodySame), changedChapterIds: chapters.filter(c => !c.titleSame || !c.bodySame).map(c => c.chapterId),
    coverage: 'all-chapters-in-order-all-title-and-body-code-units-no-trimming', chapters,
    establishes: 'literal-text-equality-or-difference-only', semanticImprovementEstablished: false, literaryPass: 'NOT_COMPUTED' };
  return { ...core, auditSHA256: hash(core) };
}

/** Keeps the immutable protocol binding distinct from the actually delivered augmented input. */
export function augmentReviewPrompt(args, differenceAudit) {
  const source = JSON.parse(args.user), packet = structuredClone(source.packet);
  const goal = packet.stage === 'goal_audit';
  assert.equal(goal, args.stage === 'independent-review:goal-audit');
  assert(!Object.hasOwn(packet, 'computedDifferenceAudit'));
  const supplement = goal ? { schemaVersion: 'post-blind-literal-difference-supplement-1', computedDifferenceAudit: structuredClone(differenceAudit) } : undefined;
  const clarifying = args.system.replace('本版本所有证据仅输出 {"anchorId":"R0001"}。', '本版本每条证据对象只含 anchorId 字段，其值必须从当前正文的实际可引用编号中选择。');
  const baseInstruction = goal ? clarifying.replace('当前 packet 是唯一输入', '当前 packet 与本次 user 顶层 supplement 是仅有输入').replace('你只可使用本次 user 消息中的冻结 packet。', '你只可使用本次 user 消息中的冻结 packet 与本阶段独立封存的 supplement。') : clarifying;
  const system = `${baseInstruction}\n\n本轮通用证据规则（${REVIEW_POLICY_VERSION}）：\n${GENERAL_EVIDENCE_RULES}`
    + (goal ? '\n本阶段已在六次盲读封存后揭示身份。user顶层supplement.computedDifferenceAudit是程序逐字核对的事实，不是作者意见：请逐章复核相同/不同声明与所列文字差异。差异存在不证明改善，内容相同部分不算新增；它不能替代你对具体目标的判断。若它与原先判断冲突，明确说明冲突，不删除或改写已封存的盲读结果。' : '');
  const user = JSON.stringify({ ...source, ...(goal ? { supplement } : {}) });
  assert.deepEqual(JSON.parse(user).packet, source.packet);
  return { prompt: { ...args, system, user }, binding: {
    wrapperVersion: REVIEW_POLICY_VERSION, protocolInputHash: source.inputHash,
    deliveredSystemSHA256: hash(system), deliveredUserSHA256: hash(user),
    deliveredInputSHA256: hash({ stage: args.stage, system, user }),
    protocolHashCoversAugmentation: false, differenceAuditDisclosed: goal,
    ...(goal ? { differenceAuditSHA256: differenceAudit.auditSHA256, supplementSHA256: hash(supplement) } : {}),
  } };
}

/** Conservative lexical flags for human review, not semantic acceptance or edits to model judgments. */
export function inspectLiteralIdentityAssertions(raw, differenceAudit) {
  const findings = []; let parsed;
  try { parsed = JSON.parse(raw); } catch { return { status: 'unparseable', flags: [], modelJudgmentChanged: false }; }
  function visit(value, at = '') {
    if (typeof value === 'string') {
      if (/(?:\/quote|\/anchorId|SHA256|Sha256|Hash|\/caseId|\/chapterId|\/blindId)$/.test(at)) return;
      const pattern = /(?:两稿|两篇(?:稿件|文本|稿)?|两个(?:版本|文本)|两份(?:全文|稿件|文本)|原稿[与和]候选稿|基线[与和]候选(?:稿)?)\s*(?:全文|正文|内容|文字)?\s*(?:完全相同|完全一致|逐字相同|逐字一致|没有任何差异|不存在任何差异|没有(?:任何)?改动)/g;
      for (const match of value.matchAll(pattern)) {
        const prefix = value.slice(Math.max(0, match.index - 12), match.index);
        const qualified = /(?:并非|并不|不是|不能(?:说|认定|断言)|不应|是否|若|如果|假如|无法(?:确认|认定)|尚未证实)/.test(prefix);
        findings.push({ JSONPointer: at, matched: match[0], surroundingText: value,
          status: qualified ? 'qualified-mention-manual-review' : differenceAudit.allTextIdentical ? 'consistent-literal-identity-assertion' : 'conflicts-with-computed-difference',
          automatedScope: 'narrow-lexical-detection-not-complete-language-understanding' });
      }
    } else if (Array.isArray(value)) value.forEach((v, i) => visit(v, `${at}/${i}`));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, `${at}/${k.replaceAll('~', '~0').replaceAll('/', '~1')}`);
  }
  visit(parsed);
  return { status: findings.some(f => f.status === 'conflicts-with-computed-difference') ? 'needs_manual_review' : 'no_conflict_detected_by_narrow_rule',
    flags: findings, computedDifferenceAuditSHA256: differenceAudit.auditSHA256, modelJudgmentChanged: false,
    semanticPass: 'NOT_COMPUTED', qualityPass: 'NOT_COMPUTED' };
}
