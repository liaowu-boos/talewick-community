// Synthetic API integration data. Reuses CREATION's offline stage fixture; no library/provider access.
import { createHash } from 'node:crypto';
import { fixture } from '../../../../creation/runtime/goal-opportunity-fixtures.mjs';
import { runWholeManuscriptQualityRevision } from '../../../../creation/runtime/whole-manuscript-quality.mjs';
import { createWorkflowRouter } from '../workflow-engine.mjs';
import { productManuscriptRevision } from '../full15-service.mjs';
import { validateRequest } from '../tasks.mjs';

export function materialContextFixture({ enabled = true, requestId = 'material-context-new' } = {}) {
  const f = fixture({ enabled: false }), prompts = [];
  const hash = v => createHash('sha256').update(v).digest('hex');
  const content = '机制：用一个有界行动承担有限代价。\n\n引文：她收回手。\n她把自己的名字写进未完成栏。😀\n  ';
  const material = { id: 'selected-fixture', title: '合成资料', kind: 'retrieved', use: 'reviewed_analysis', content, sha256: hash(content),
    references: [{ sourceId: 'synthetic-source', sourceSha256: hash('synthetic-source'), textVersion: 'fixture-text-1',
      analysisVersion: 'fixture-analysis-1', unitIds: ['unit-1'], reviewRecordId: 'fixture-review-1', lineStart: 1, lineEnd: 2 }],
    selectionReason: '仅离线传输测试。', limitations: ['合成资料不证明文学效果。'] };
  const declined = { ...structuredClone(material), id: 'declined-fixture', content: '不应进入新上下文的被拒材料。', sha256: hash('不应进入新上下文的被拒材料。') };
  const request = validateRequest({ ...f.request, projectId: 'synthetic-material-context', requestId, idea: '离线接线测试',
    context: { character: '', world: '', plot: '', theme: '' }, materials: [], style: null, quote: '',
    baseRevision: productManuscriptRevision(f.request.projectTitle, f.request.chapters),
    ...(enabled ? { adoptedMaterialContextPolicy: { schemaVersion: 'whole-quality-adopted-material-context-policy-1', mode: 'selected_complete_materials' } } : {}) });
  const control = { pauseAtFeasibility: false };
  const model = { async complete(args) {
    prompts.push({ stage: args.stage, system: args.system, user: args.user, modelPolicy: args.modelPolicy, allowRecovery: args.allowRecovery });
    if (control.pauseAtFeasibility && args.stage === 'whole-quality:feasibility') throw Object.assign(Error('Synthetic interruption before feasibility; saved earlier stages stay sealed.'), { code: 'TEST_LOCAL_PAUSE' });
    const input = JSON.parse(args.user);
    if (args.stage === 'whole-quality:applicability') return JSON.stringify({ ...input.responseBindings,
      assessments: input.retrieval.supplies.map((s, i) => ({ supplyId: s.supplyId, materialId: s.materialId, issueId: s.issueId,
        fit: i === 0 ? 'direct_fit' : 'inapplicable', reason: '合成适用性，仅验证边界。', evidenceIds: i === 0 ? s.evidenceIds : [], transferBoundary: '只借行动组织，不复制人物和情节。' })), noSuitableReasons: [] });
    if (args.stage === 'whole-quality:material-evidence') return JSON.stringify({ ...input.responseBindings,
      recordsByIssue: input.activeLedgers.map(l => ({ issueId: l.issueId, records: l.usedMaterialIds.map(materialId => ({ materialId,
        status: 'not_located', findings: [], reason: '本地测试不主张实际采用或文学改善。' })) })) });
    const raw = await f.model.complete(args);
    if (args.stage !== 'whole-quality:plan') return raw;
    const plan = JSON.parse(raw);
    plan.materialDecisions = input.retrieval.supplies.map((s, i) => ({ supplyId: s.supplyId, materialId: s.materialId,
      issueId: s.issueId, goalId: s.goalId, decision: i === 0 ? 'used' : 'not_used', planItemIds: i === 0 ? ['plan-1'] : [],
      evidenceIds: i === 0 ? s.evidenceIds : [], reason: '合成完整材料选择。', ...(i === 0 ? { appliedAs: '仅借有限行动组织。' } : {}),
      applicabilityBoundary: '不复制来源情节。', limitations: ['不证明实际采用。'] }));
    plan.items[0].adoptedSupplyIds = [input.retrieval.supplies[0].supplyId]; return JSON.stringify(plan);
  } };
  const router = createWorkflowRouter({ config: {}, queryDeepReferences: f.options.queryDeepReferences,
    retrieveKnowledge: async query => ({ contractVersion: 'v04-contract-1', packetId: 'synthetic-packet-' + hash(JSON.stringify(query)).slice(0, 12),
      query, status: 'matched', materials: structuredClone([material, declined]), candidates: [], limits: ['离线合成，不读资料库。'], usedChars: content.length + declined.content.length }),
    wholeQualityRunner: runWholeManuscriptQualityRevision });
  return { request, model, workflow: router, prompts, material, declined, control };
}
