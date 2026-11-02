import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const bundle = await build({ stdin: { contents: `export {ReviewEvidenceAuditDetails} from './src/features/ReviewEvidenceAuditPanel.tsx';
export {createElement} from 'react';export {renderToStaticMarkup} from 'react-dom/server';`, resolveDir: fileURLToPath(new URL('../', import.meta.url)), loader: 'tsx' },
  bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(fileURLToPath(import.meta.url))});` } });
const ui = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const render = task => ui.renderToStaticMarkup(ui.createElement(ui.ReviewEvidenceAuditDetails, { task }));
const task = () => ({ status: 'complete', targets: [{ targetId: 'T1', kind: 'claim', readerId: 'reader-2',
  original: { statement: '人物说已付款，所以实际已经付清。' }, originalCitations: [{ blindId: 'A', chapterId: 'ch-1', quote: '她说：“已经付清。”' }] }],
  report: { automaticAdoption: false, literaryPass: 'NOT_COMPUTED', originalReviewUnchanged: true, coverage: { complete: true, completed: 1 },
    assessments: [{ targetId: 'T1', originalCitationSupport: { status: 'unsupported', reason: '原引文只包含人物说法。', limits: '无法证实付款。',
      citationChecks: [{ citationId: 'C1', status: 'unsupported', basis: 'character_statement', reason: '不是转账记录。' }] },
    wholeTextCheck: { status: 'uncertain', reason: '全文仍无付款凭证。', supportedScope: null, limits: '保留实际付款状态的不确定性。',
      evidence: [{ blindId: 'A', chapterId: 'ch-2', quote: '我没有看到转账记录。', basis: 'narrator_inference', explanation: '没有看到，不等于必然未付。' }], counterEvidence: [], mechanicalFactsUsed: [] } }] } });

test('two support axes, original opinion and exact recovered evidence are distinct and collapsed without a new vote', () => {
  const value = task(), before = JSON.stringify(value), html = render(value);
  for (const label of ['原意见', '原引文', '补读全文', '依据不足或存在反证', '尚不能确定', '人物说法', '我没有看到转账记录', '不是盲评票数']) assert.ok(html.includes(label), label);
  assert.ok(!html.includes('<details open')); assert.equal(JSON.stringify(value), before);
  for (const changed of [{ ...value, status: 'needs_attention' }, { ...value, report: { ...value.report, automaticAdoption: true } }, { ...value, report: undefined }])
    assert.equal(render(changed), '', 'failed/unbound result must not appear as a completed audit');
});

test('identical manuscript mechanical evidence is described without inventing an improvement or citation', () => {
  const value = task(), whole = value.report.assessments[0].wholeTextCheck;
  whole.evidence = []; whole.mechanicalFactsUsed = ['identical_manuscripts']; whole.status = 'supported'; whole.reason = '两稿全文相同，无文本增量。';
  const html = render(value); assert.match(html, /两稿正文经逐字核对相同/); assert.match(html, /这不表示文学质量更好/);
  assert.doesNotMatch(html, /我没有看到转账记录/);
});

test('format-only recovery is explained inside collapsed details and never presented for a failed or legacy result', () => {
  const legacy = task(); assert.doesNotMatch(render(legacy), /已按固定规则恢复字段表示/);
  const value = { ...legacy, report: { ...legacy.report, representationStatus: 'recovered_from_format' } }, before = JSON.stringify(value);
  const html = render(value);
  assert.match(html, /已按固定规则恢复字段表示/); assert.match(html, /评语判断未改，这不表示质量提高/);
  assert.ok(!html.includes('<details open')); assert.equal(JSON.stringify(value), before);
  assert.equal(render({ ...value, status: 'needs_attention' }), '');
});

test('v2 facts, coverage and dependencies are collapsed model judgments; legacy and failed views do not gain fact checks', () => {
  const legacy = task(), value = { ...legacy, auditPolicyVersion: 'fact-subclaims-and-two-axes-2', targets: [{ ...legacy.targets[0],
    claimSources: [{ JSONPointer: '/statement', text: legacy.targets[0].original.statement }, { JSONPointer: '/uncertainty', text: '实际付款仍不清楚。' }] }],
    report: { ...legacy.report, assessments: [{ ...legacy.report.assessments[0],
      factCoverage: [{ JSONPointer: '/statement', disposition: 'fact_checks', factIds: ['F1'], reason: '分开人物说法与是否付款。' },
        { JSONPointer: '/uncertainty', disposition: 'unresolved', factIds: [], reason: '收付方向仍无法核实。' }],
      factChecks: [{ factId: 'F1', claim: { quote: '实际已经付清', start: 9, end: 15 }, status: 'contradicted', dimensions: ['intent_completion', 'transfer_direction'],
        basis: 'character_statement', reason: '承诺不是完成付款。', supportedScope: null, limits: '不判断人物是否诚实。', evidence: [],
        counterEvidence: [{ blindId: 'A', chapterId: 'ch-2', quote: '转账页面上写着失败。', basis: 'narrated_action', explanation: '本次转账并未成功。' }] }],
      factDependencies: { originalCitationSupport: ['F1'], wholeTextCheck: ['F1'] } }] } };
  const before = JSON.stringify(value), html = render(value);
  for (const label of ['事实子判断 · 1 项', '仍有未能核实的部分', '收付方向', '实际已经付清', '存在反证', '转账页面上写着失败', '原引文栏依赖：子判断1', '补读全文栏依赖：子判断1', '不认证事实']) assert.ok(html.includes(label), label);
  assert.ok(!html.includes('<details open')); assert.equal(JSON.stringify(value), before);
  assert.doesNotMatch(render(legacy), /事实子判断/);
  assert.doesNotMatch(render({ ...value, auditPolicyVersion: undefined }), /事实子判断/);
  assert.equal(render({ ...value, status: 'needs_attention' }), '');
});

test('v3 five-dimensional premises stay collapsed and not_applicable never means a fact is correct', () => {
  const value = task(); value.auditPolicyVersion = 'fact-premise-decomposition-and-two-axes-3';
  value.targets[0].claimSources = [{ JSONPointer: '/statement', text: value.targets[0].original.statement }];
  const assessment = value.report.assessments[0];
  assessment.factChecks = [{ factId: 'F1', claim: { quote: '实际已经付清' }, status: 'uncertain', dimensions: ['intent_completion'] }];
  assessment.premiseChecks = [{ JSONPointer: '/statement', dimensions: {
    identity_relationship: { disposition: 'not_applicable', factIds: [], reason: '未识别身份前提。' },
    speaker_actor: { disposition: 'unresolved', factIds: [], reason: '行动者仍待确定。' },
    intent_completion: { disposition: 'identified', factIds: ['F1'], reason: '涉及实际完成状态。' },
    transfer_direction: { disposition: 'not_applicable', factIds: [], reason: '未识别方向前提。' },
    event_round: { disposition: 'not_applicable', factIds: [], reason: '未识别轮次前提。' },
  } }];
  const before = JSON.stringify(value), html = render(value);
  for (const label of ['五维前提检查', '身份与关系', '说话人与行动者', '意图与实际完成', '收付方向', '事件与轮次',
    '已识别此前提', '复核者认为不涉及', '尚未确定是否涉及', '不表示事实正确', '关联：子判断1', '尚不能确定', '原意见']) assert.ok(html.includes(label), label);
  assert.ok(!html.includes('<details open')); assert.equal(JSON.stringify(value), before);
  for (const auditPolicyVersion of [undefined, 'fact-subclaims-and-two-axes-2'])
    assert.doesNotMatch(render({ ...value, auditPolicyVersion }), /五维前提检查/);
  assert.equal(render({ ...value, status: 'needs_attention' }), '');
});
