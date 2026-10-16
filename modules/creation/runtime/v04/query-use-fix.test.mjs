import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compileReferenceStrategy, REFERENCE_STRATEGIES } from './reference-strategy.mjs';
import { knowledgeForAuthor, filterAuthorKnowledge, retrievalQuery } from './knowledge.mjs';
import { normalizePsychology } from './psychology.mjs';
import { runWorkflow } from '../workflow.mjs';

// Deliberately all choose emotion_development: differences must come from actual needs.
const problems = [
  { relationship: '互相扶持的朋友获得不等认可', trigger: '再次面对共同决定', desiredEffect: '真心与嫉妒依赖并存并影响合作', constraints: ['不预定维持友谊或谁占道德高地'] },
  { relationship: '生者与逝去的朋友及其他生者', trigger: '恢复日常时听见不同的共同记忆', desiredEffect: '哀伤和轻松并存而事情仍需处理', constraints: ['结束事情不等于治愈'] },
  { relationship: '多年职业投入与现实承诺相牵', trigger: '得到认可后怀疑是否继续', desiredEffect: '热爱与抗拒并存并作出有代价的选择', constraints: ['不预设去留哪种更勇敢'] },
  { relationship: '共同体受益者与承担代价者', trigger: '旁观者发现自己的便利牵涉公共安排', desiredEffect: '好意自保面子相互影响产生有限帮助', constraints: ['不分善恶两队'] },
];
const choiceFor = p => ({ status: 'selected', mechanism: 'emotion_development', basis: '/idea',
  quote: p.trigger, reason: '当前关系和触发需要具体的心理与表达联系', storyProblem: p });
const requestFor = p => ({ kind: 'create', idea: Object.values(p).flat().join('；') });
const req = { status: 'ready', summary: '合成测试', genre: '现实', pointOfView: '第三人称', setting: '当代',
  targetHanMin: 3000, targetHanMax: 3000, targetChapterCount: 3, requiredElements: [], prohibitions: [], assumptions: [], usesChapter4Cut: false, completeEnding: true };

test('four same-mechanism problems keep different relations, triggers, effects and limits on actual retrieval wire', async () => {
  const queries = [];
  for (const p of problems) {
    const request = requestFor(p), calls = [], saved = {}, stop = Error('offline stop before planning');
    await assert.rejects(runWorkflow({ request, model: { complete: async call => {
      calls.push(call); assert.equal(call.stage, 'requirements');
      return JSON.stringify({ ...req, referenceStrategy: choiceFor(p) });
    } }, retrieveKnowledge: async query => {
      queries.push(query);
      return { contractVersion: 'v04-contract-1', packetId: 'synthetic-empty', query, status: 'uncovered', materials: [], candidates: [], usedChars: 0, limits: ['合成空响应'] };
    }, checkpoint: async (key, value) => { saved[key] = value; if (key === 'knowledge') throw stop; } }), e => e === stop);
    assert.equal(calls.length, 1); assert.equal(calls[0].maxTokens, 2500);
    const query = queries.at(-1), context = JSON.parse(query.context);
    for (const s of Object.values(p).flat()) assert.ok(query.query.includes(s));
    assert.ok(query.query.length <= 240); assert.notEqual(query.query, REFERENCE_STRATEGIES.emotion_development.question);
    assert.deepEqual(context.targetUse.storyProblem, p);
    assert.match(context.referenceNeed.evidenceRule, /不能整组转成来源必须重演/);
    assert.deepEqual(query.budget, { maxCandidates: 20, maxUnits: 6, maxChars: 12000 });
    assert.equal(query.recall, undefined); assert.equal(saved.knowledge.materials.length, 0);
  }
  assert.equal(new Set(queries.map(q => q.query)).size, 4);
});

test('bounded story problem rejects malformed, overlong or invented basis without silently dropping constraints', () => {
  const p = problems[0], v = choiceFor(p), request = requestFor(p);
  for (const invalid of [null, { ...p, invented: 'force revenge' }, { ...p, trigger: ' ' }, { ...p, constraints: [null] },
    { ...p, constraints: ['same', 'same'] }, { ...p, relationship: '字'.repeat(80), trigger: '字'.repeat(80), desiredEffect: '字'.repeat(80) }]) {
    assert.throws(() => compileReferenceStrategy({ ...v, storyProblem: invalid }, request));
  }
  assert.throws(() => compileReferenceStrategy({ ...v, quote: 'request never said this' }, request));
  assert.throws(() => compileReferenceStrategy({ ...v, basis: '/context/priorDraft' }, request));
  const unknown = { ...p, trigger: '原需求未说明具体触发', constraints: [] };
  const out = compileReferenceStrategy({ ...v, storyProblem: unknown }, request);
  assert.match(out.referenceQuestion, /未说明/); assert.doesNotMatch(out.referenceQuestion, /必须爆发|必须和解/);
  assert.equal(out.selection.verification, 'literal_quote_only_mechanism_fit_requires_review');
});

test('facts and omitted reference fields keep their own routes and budgets', () => {
  const request = requestFor(problems[0]);
  const old = retrievalQuery(request, req, 79);
  assert.ok(old.query.includes(request.idea)); assert.equal(old.budget.maxChars, 79);
  const question = '此设备说明书的额定电压是多少？';
  const factual = retrievalQuery(request, { ...req, referenceQuestion: question,
    referenceIntent: { purpose: 'facts', evidenceNeeds: ['说明书额定电压'], contextNeeds: [], basis: ['/idea'] } }, 100);
  assert.equal(factual.query, question); assert.equal(JSON.parse(factual.context).referenceNeed.purpose, 'facts');
});

const hash = s => createHash('sha256').update(s).digest('hex');
const material = (id, start = 1, use = 'raw_reference') => ({ id, title: `synthetic ${id}`, content: `CONTENT_${id}`, kind: 'retrieved',
  sha256: hash(`CONTENT_${id}`), use, selectionReason: `RECOMMEND_${id}`, limitations: ['范围有限'],
  references: [{ sourceId: 'source', sourceSha256: hash('source'), textVersion: 't1', analysisVersion: 'a1',
    lineStart: start, lineEnd: start + 2, unitIds: use === 'reviewed_analysis' ? [id] : [], ...(use === 'reviewed_analysis' ? { reviewRecordId: 'r1' } : {}) }] });
const decline = id => ({ materialId: id, decision: 'decline', reason: '该材料依赖身份反转，本篇未发生', limitations: ['不借用其反转前提'] });
const adopt = id => ({ materialId: id, decision: 'adopt', reason: '借鉴好意与自保同时影响回应；第2章协商场，人物承認获益后改为承担轮值，家人失去空闲时间', limitations: ['不移植来源清算结局；尚未实际执行轮值'] });
const packet = () => ({ materials: [material('a'), material('b', 10, 'reviewed_analysis'), material('c', 20)],
  style: null, limits: ['synthetic only'], retrieval: { query: { recall: { focus: 'scene', queries: ['关系变化'] } } } });

test('declined bytes and recommendations disappear from author view, decisions remain unverified and packet immutable', () => {
  const knowledge = packet(), before = structuredClone(knowledge), decisions = [decline('a'), adopt('b')];
  const view = knowledgeForAuthor(knowledge, { materialDecisions: decisions });
  assert.deepEqual(view.materials.map(m => m.id), ['b', 'c']);
  assert.doesNotMatch(JSON.stringify(view), /CONTENT_a|RECOMMEND_a/);
  assert.equal(view.materialUse.decisions[1].status, 'author_declared_not_text_verified');
  assert.deepEqual(view.materials[0].references, knowledge.materials[1].references);
  assert.deepEqual(view.recall, knowledge.retrieval.query.recall);
  view.materials[0].references[0].lineEnd = 999; view.materialUse.decisions[0].limitations.push('no mutation');
  assert.deepEqual(knowledge, before); assert.equal(decisions[0].limitations.length, 1);
});

test('latest explicit adoption restores material; missing or empty decisions preserve legacy view; all decline may be empty', () => {
  const knowledge = packet(), full = knowledgeForAuthor(knowledge);
  for (const materialDecisions of [undefined, []]) assert.deepEqual(knowledgeForAuthor(knowledge, { materialDecisions }), full);
  assert.deepEqual(filterAuthorKnowledge(full, [decline('a')]).materials.map(m => m.id), ['b', 'c']);
  assert.deepEqual(filterAuthorKnowledge(full, [adopt('a')]).materials.map(m => m.id), ['a', 'b', 'c']);
  assert.equal(knowledgeForAuthor(knowledge, { materialDecisions: knowledge.materials.map(m => decline(m.id)) }).materials.length, 0);
  assert.equal(knowledgeForAuthor({ materials: [], style: null, limits: [] }, { materialDecisions: [] }).materials.length, 0);
});

test('followup aliases, expanded raw ranges and reviewed unit aliases cannot revive declined materials; disjoint units survive', () => {
  const original = packet().materials;
  const sameBytes = { ...material('alias', 40), content: original[0].content, sha256: original[0].sha256 };
  const expanded = material('expanded', 2);
  const reviewedAlias = material('reviewed-alias', 10, 'reviewed_analysis'); reviewedAlias.references[0].unitIds = ['b'];
  const nonoverlap = material('d', 40);
  const differentUnit = material('other-unit', 10, 'reviewed_analysis');
  const otherVersion = material('other-version', 1); otherVersion.references[0].textVersion = 't2';
  const active = knowledgeForAuthor({ materials: [sameBytes, expanded, reviewedAlias, nonoverlap, differentUnit, otherVersion], limits: [], style: null });
  const before = structuredClone(active);
  const view = filterAuthorKnowledge(active, [decline('a'), decline('b')], original);
  assert.deepEqual(view.materials.map(m => m.id), ['d', 'other-unit', 'other-version']);
  assert.deepEqual(view.materialUse.excludedMaterialIds, ['alias', 'expanded', 'reviewed-alias']);
  assert.deepEqual(active, before);
  // Use the full active snapshot to recompute a new plan's decision, never its filtered predecessor.
  assert.equal(filterAuthorKnowledge(active, [adopt('a'), adopt('b')], original).materials.length, 6);
});

test('mechanism, incompatible settings and target scene survive existing psychology normalization without new schema', () => {
  const v = { characterArcs: [{ character: '甲', experience: '受益', belief: '想置身事外', desire: '方便', fear: '损失', change: '承认自己受益', expression: '协商时自辩' }],
    emotionalScenes: [{ experience: '协商轮值', cognition: '自己也获益', action: '承担轮值', expression: '有限承诺', development: '展开家人失去空闲', echo: '待下一次轮值检验' }],
    choiceCausality: [{ id: 'choice-1', chapterNumber: 1, character: '甲', pressure: '想保留便利又怕失去空闲', choice: '接受本周轮值', immediateConsequence: '家人本周少一个晚上相处', carryForward: '下次协商必须说明是否继续', unresolvedBoundary: '家人是否接受仍未知' }],
    materialDecisions: [adopt('b'), decline('a')], psychologyLimitations: ['家人是否接受仍需展开'] };
  const out = normalizePsychology(v, [{ id: 'ch-2' }]);
  assert.equal(out.materialDecisions[0].reason, v.materialDecisions[0].reason);
  assert.deepEqual(out.materialDecisions[0].limitations, v.materialDecisions[0].limitations);
  assert.equal(out.materialDecisions[0].status, 'author_declared_not_text_verified');
  assert.equal(out.emotionalScenes[0].chapterId, 'ch-2');
});
