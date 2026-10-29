// Synthetic public protocol fixtures; not excerpts from a manuscript corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { buildIndependentReviewRequest } from './independent-review-handoff.mjs';
import { validateWritingGoals, WRITING_GOAL_DATA_OPTIONS } from './writing-goals.mjs';
import { runWholeManuscriptQualityRevision, assertWholeQualityResult, createWholeQualityRequestSpec,
  createWholeQualityDraftGuidance, inspectStoredWholeQualityReadingFailure,
  runCrossChapterAwareWholeManuscriptQualityRevision } from './whole-manuscript-quality.mjs';

const chapters = [
  { id: 'ch-1', title: '旧账', body: '周青把零件簿推回柜台。\n她说先把旧账分清，再谈谁留下。' },
  { id: 'ch-2', title: '分工', body: '\n\n前序😀\r\n\r\n第二天电话又响。\n\n🙂林遥说自己只是回来帮忙，手却停在欠款页上。' },
  { id: 'ch-3', title: '清单', body: '周青把未完的清单递过去。\n林遥接过，没有说原谅。' },
];
const request = () => ({ kind: 'revise', revisionMode: 'whole-manuscript-v2', projectTitle: '零件簿', instruction: '独立阅读，修复主要场景问题并保留克制结尾。', baseRevision: 'base-1', chapters: structuredClone(chapters) });
const binding = (user, key) => user.responseBindings[key];
const ev = (chapterId, quote, purpose) => ({ chapterId, quote, purpose });

function scenes() { return [
  { id: 's-1', chapterId: 'ch-1', sequence: 1, entryEvidence: ev('ch-1','周青把零件簿推回柜台。','场景进入'), exitEvidence: ev('ch-1','她说先把旧账分清，再谈谁留下。','场景退出'), beforeState: '姐妹仍在争执旧账', trigger: '零件簿被推回', action: '周青要求先分清旧账', afterState: '去留被推迟', cost: '分工仍未改变', narrativeFunction: '建立未解决关系', preservedStrengths: [] },
  { id: 's-2', chapterId: 'ch-2', sequence: 1, entryEvidence: ev('ch-2','第二天电话又响。','场景进入'), exitEvidence: ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','场景退出'), beforeState: '林遥仍称临时帮忙', trigger: '电话再次响起', action: '她只停在欠款页上', afterState: '承担没有变成行动', cost: '姐姐继续接电话', narrativeFunction: '重复未落实', preservedStrengths: [] },
  { id: 's-3', chapterId: 'ch-3', sequence: 1, entryEvidence: ev('ch-3','周青把未完的清单递过去。','场景进入'), exitEvidence: ev('ch-3','林遥接过，没有说原谅。','场景退出'), beforeState: '清单未交接', trigger: '周青递出清单', action: '林遥接过', afterState: '形成有限合作', cost: '没有和解', narrativeFunction: '克制收束', preservedStrengths: [ev('ch-3','林遥接过，没有说原谅。','保留有限合作')] },
]; }
function issue() { return { id: 'i-1', claimType: 'reader_effect_hypothesis', area: 'emotion_progression', priority: 'major', disposition: 'investigate',
  observation: '承担意愿在前两场没有转成可见分工。', readerEffectHypothesis: '读者可能觉得关系变化主要靠结尾声明。', suspectedCause: '电话场景仍沿用原分工。', sceneIds: ['s-1','s-2'],
  evidence: [ev('ch-1','她说先把旧账分清，再谈谁留下。','去留被推迟'),ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','承担没有行动')],
  counterEvidence: [ev('ch-3','林遥接过，没有说原谅。','结尾已有有限合作')], preservation: [ev('ch-3','林遥接过，没有说原谅。','保留克制')],
  expectedEffect: '用两场实际分工变化让承担逐步可见。', failureCriteria: '只换名词或增加说明，未改变谁接电话和处理欠款。', limitations: ['属于读者效果假说。'] }; }
function readingResponse(user,{preserve=false,secondary=false}={}) { const issues=preserve?[]:[secondary?{...issue(),priority:'secondary',disposition:'needs_evidence'}:issue()];return JSON.stringify({ schemaVersion: binding(user,'schemaVersion'), inputHash: binding(user,'inputHash'), sourceManuscriptSha256: binding(user,'sourceManuscriptSha256'), checkedChapterIds: binding(user,'checkedChapterIds'),
  coverage: {status:'complete',omissions:[]}, synopsis: '姐妹处理旧账并形成不等于原谅的有限合作。', sceneChanges: scenes(), issues, strengths: [ev('ch-3','林遥接过，没有说原谅。','克制结尾')], unresolved: [] }); }
function planResponse(user,{preserve=false,oneScene=false}={}) { if(preserve)return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),sourceManuscriptSha256:binding(user,'sourceManuscriptSha256'),readingSha256:binding(user,'readingSha256'),retrievalSha256:binding(user,'retrievalSha256'),decision:'preserve_original',summary:'没有安全主要修项。',items:[],materialDecisions:[],unresolved:[]});
  const supplies=user.retrieval.supplies,adoptedSupplyIds=supplies.map(s=>s.supplyId),materialDecisions=supplies.map(s=>({supplyId:s.supplyId,materialId:s.materialId,issueId:s.issueId,decision:'used',planItemIds:['p-1'],evidenceIds:[s.evidenceIds[0]],reason:'证据提供判断后动作的有限组织方法。',appliedAs:'仅约束动作承接压力，不移植人物或情节。',applicabilityBoundary:'只适用于该修改组的动作落点。',limitations:['采用声明不证明文学效果。']}));
  return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),sourceManuscriptSha256:binding(user,'sourceManuscriptSha256'),readingSha256:binding(user,'readingSha256'),retrievalSha256:binding(user,'retrievalSha256'),decision:'revise',summary:'在争执和电话两场改变实际分工。',items:[{
    id:'p-1',issueIds:['i-1'],decision:'revise',scope:'linked_scenes',affectedChapterIds:oneScene?['ch-2']:['ch-1','ch-2'],sceneIds:oneScene?['s-2']:['s-1','s-2'],
    targets:oneScene?[{id:'t-2',sceneId:'s-2',...ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','让必要场景落实分工')}]:[{id:'t-1',sceneId:'s-1',...ev('ch-1','她说先把旧账分清，再谈谁留下。','让第一场出现初步承担')},{id:'t-2',sceneId:'s-2',...ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','让第二场落实分工')}],
    actionRequirements:oneScene?[{id:'r-2',description:'电话场景由林遥处理电话和欠款',targetIds:['t-2'],expectedVisibleChange:'明确改变分工',failureCriterion:'只换欠款页名词'}]:[{id:'r-1',description:'第一场由林遥接下一项工作',targetIds:['t-1'],expectedVisibleChange:'出现具体接单行动',failureCriterion:'仍只讨论去留'},{id:'r-2',description:'第二场由林遥处理电话和欠款',targetIds:['t-2'],expectedVisibleChange:'明确改变分工',failureCriterion:'只换欠款页名词'}],
    action:'让承担在必要场景落实。',rationale:'结尾已有合作，需要前文动作承接。',expectedEffect:'关系变化由行动积累。',failureCriteria:'动作未发生或损伤不和解结尾。',risks:['可能写得过满。'],preserve:[ev('ch-3','林遥接过，没有说原谅。','保护克制结尾')],adoptedSupplyIds,independentAdoption:'本组包含该问题所有互相依赖的目标；不依赖其他修改组即可成立。'}],materialDecisions,unresolved:[]}); }
function feasibilityResponse(user,{blocked=false,lie=false}={}) { const assessment=blocked?'unsupported':'supported',planItem=user.plan.items[0];return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),sourceManuscriptSha256:binding(user,'sourceManuscriptSha256'),planSha256:binding(user,'planSha256'),checks:[{planItemId:'p-1',assessment:blocked&&!lie?'infeasible':'feasible',reason:blocked?'目标范围不足。':'所有必要 target 都覆盖完整动作句。',requirementChecks:planItem.actionRequirements.map(r=>({requirementId:r.id,assessment,targetIds:r.targetIds,reason:blocked?'只覆盖名词。':'可重写完整行动句。'})),sourceEvidence:[ev('ch-1','她说先把旧账分清，再谈谁留下。','第一场范围')],blockingReasons:blocked?['不能凭名词替换实现动作。']:[],limitations:['可行不证明文学效果。']} ]}); }
function candidateResponse(user,{partial=false}={}) { const replacementsById={
  't-1':{targetId:'t-1',chapterId:'ch-1',sourceQuote:'她说先把旧账分清，再谈谁留下。',replacement:'她说先把旧账分清，周末那张单子由林遥去送。',appliedPlanItemIds:['p-1'],notes:['第一场出现初步承担。']},
  't-2':{targetId:'t-2',chapterId:'ch-2',sourceQuote:'林遥说自己只是回来帮忙，手却停在欠款页上。',replacement:'林遥接起电话，把欠款页拉到面前，说余下三家由自己来打。',appliedPlanItemIds:['p-1'],notes:['第二场落实分工。']},
  },replacements=user.plan.items[0].targets.map(t=>replacementsById[t.id]);return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),sourceManuscriptSha256:binding(user,'sourceManuscriptSha256'),planSha256:binding(user,'planSha256'),feasibilitySha256:binding(user,'feasibilitySha256'),replacements:partial?replacements.slice(0,1):replacements,skippedPlanItems:[]}); }
function rereadResponse(user,{status='applied'}={}) { const applied=status==='applied';return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),sourceManuscriptSha256:binding(user,'sourceManuscriptSha256'),candidateManuscriptSha256:binding(user,'candidateManuscriptSha256'),checkedChapterIds:binding(user,'checkedChapterIds'),coverage:{status:'complete',omissions:[]},summary:applied?'必要场景动作落实并保留结尾克制。':'原稿保留。',changeChecks:user.plan.items.filter(i=>i.decision==='revise').map(i=>({planItemId:i.id,executionStatus:status,goalAssessment:applied?'implemented':'not_attempted',coherenceAssessment:applied?'consistent':'not_checked',reason:applied?'实际分工变化可见。':'方案未执行。',requirementChecks:i.actionRequirements.map(r=>({requirementId:r.id,assessment:applied?'supported':'not_attempted',reason:applied?'动作已在候选出现。':'未执行。',evidence:applied?[r.id==='r-2'?ev('ch-2','林遥接起电话，把欠款页拉到面前，说余下三家由自己来打。','第二场动作'):ev('ch-1','她说先把旧账分清，周末那张单子由林遥去送。','第一场动作')]:[]})),risks:[],recommendation:applied?'eligible_for_user_choice':'not_recommended'})),introducedIssues:[],unresolvedItems:[],preservedStrengths:[ev('ch-3','林遥接过，没有说原谅。','结尾保留')]}); }
function applicabilityResponse(user,{fit='direct_fit'}={}){return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),sourceManuscriptSha256:binding(user,'sourceManuscriptSha256'),retrievalSha256:binding(user,'retrievalSha256'),
  assessments:user.retrieval.supplies.map(s=>({supplyId:s.supplyId,issueId:s.issueId,materialId:s.materialId,fit,reason:fit==='direct_fit'?'来源逐字展示压力后由人物接起电话并承担下一项工作。':'来源只提供宽泛行动组织，不能直接适配当前姐妹旧账问题。',evidenceIds:fit==='direct_fit'?[s.evidenceIds[0]]:[],transferBoundary:'只迁移行动承接机制，不迁移来源人物、职业或情节。'})),
  noSuitableReasons:fit==='direct_fit'?[]:user.issues.map(issue=>({issueId:issue.id,reason:'没有直接适用材料，可依据原稿证据提出原创方案。'}))});}
function finalTextResponse(user){const quote='林遥接起电话，把欠款页拉到面前，说余下三家由自己来打。',chapter=user.candidateChapters.find(item=>item.id==='ch-2');return JSON.stringify({schemaVersion:binding(user,'schemaVersion'),inputHash:binding(user,'inputHash'),candidateManuscriptSha256:binding(user,'candidateManuscriptSha256'),materialUseSha256:binding(user,'materialUseSha256'),
  recordsByIssue:user.activeLedgers.map(ledger=>({issueId:ledger.issueId,records:ledger.usedMaterialIds.map(materialId=>{const decision=ledger.decisions.find(item=>item.materialId===materialId);return{materialId,status:'located',findings:[{chapterId:'ch-2',start:chapter.body.indexOf(quote),quote,changeGroupId:decision.changeGroupIds[0],sourceEvidenceIds:[decision.evidenceIds[0]],textRole:'visible_application',explanation:'候选正文逐字出现该修改组声明的行动承接。'}]};})}))});}

function journal(){const artifacts={};return{artifacts,checkpoint:async(k,v)=>{artifacts[k]=structuredClone(v);}};}
function modelFor({preserve=false,secondary=false,blocked=false,lie=false,partial=false,oneScene=false,applicabilityFit='direct_fit'}={}){const calls=[];return{calls,complete:async args=>{calls.push(args);const u=JSON.parse(args.user),input=args.stage.endsWith(':format-repair')?u.originalInput:u;
  if(args.stage.startsWith('whole-quality:reading'))return readingResponse(input,{preserve,secondary});
  if(args.stage.startsWith('whole-quality:applicability'))return applicabilityResponse(input,{fit:applicabilityFit});
  if(args.stage.startsWith('whole-quality:plan'))return planResponse(input,{preserve,oneScene});
  if(args.stage.startsWith('whole-quality:feasibility'))return feasibilityResponse(input,{blocked,lie});
  if(args.stage.startsWith('whole-quality:revision'))return candidateResponse(input,{partial});
  if(args.stage.startsWith('whole-quality:reread'))return rereadResponse(input,{status:preserve||secondary?'blocked':blocked?'blocked':'applied'});
  if(args.stage.startsWith('whole-quality:material-evidence'))return finalTextResponse(input);
  throw Error(`unexpected ${args.stage}`);}};}
const uncovered=async query=>({contractVersion:'v04-contract-1',packetId:'packet-test',query,status:'uncovered',materials:[],candidates:[],limits:['没有适用材料。'],usedChars:0});
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const stableFingerprint=value=>hash(JSON.stringify(canonical(value)));
const matched=async query=>{const content='【原文参考；不作为已发布分析】\n压力之后，人物接起电话，把下一项工作记到自己名下。',material={id:'raw-1',title:'动作承接窗口',kind:'retrieved',use:'raw_reference',content,sha256:hash(content),references:[{sourceId:'source-a',sourceSha256:'a'.repeat(64),textVersion:'text-v1',analysisVersion:'analysis-v1',unitIds:[],lineStart:8,lineEnd:9}],selectionReason:'离线固定桩，仅验证合同。',limitations:['适用性仍须由方案判断。']};return{contractVersion:'v04-contract-1',packetId:'packet-matched',query,status:'matched',materials:[material],candidates:[{id:'candidate-a',sourceId:'source-a',reason:'固定桩候选'}],limits:['命中不等于采用。'],usedChars:content.length};};

test('all five model stages expose self-contained types, enums, constraints, legal empty shapes, and repair keeps the full contract',async()=>{
  const base=modelFor(),contracts=new Map(),systems=new Map();let readingContract,repairChecked=false,planEligible;
  const model={complete:async args=>{const envelope=JSON.parse(args.user),repair=args.stage.endsWith(':format-repair'),input=repair?envelope.originalInput:envelope,stage=args.stage.replace(':format-repair','');
    assert.equal(input.responseContract.additionalProperties,false);assert.equal(input.responseContract.binding.type,'host_binding');assert(input.responseContract.properties);
    if(repair){assert.deepEqual(input.responseContract,readingContract);assert.match(args.system,/responseContract.*完整且权威/);repairChecked=true;}
    else {contracts.set(stage,input.responseContract);systems.set(stage,args.system);if(stage==='whole-quality:reading')readingContract=input.responseContract;if(stage==='whole-quality:plan')planEligible=input.eligibleIssueIds;}
    if(args.stage==='whole-quality:reading')return '{}';return base.complete(args);}};
  await runWholeManuscriptQualityRevision({request:request(),model,retrieveKnowledge:uncovered});
  assert.equal(repairChecked,true);assert.deepEqual([...contracts.keys()],['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:revision','whole-quality:reread']);
  for(const stage of ['whole-quality:reading','whole-quality:plan','whole-quality:revision','whole-quality:reread']){
    assert.match(systems.get(stage),/相同犹豫再次出现却没有新信息/);assert.match(systems.get(stage),/心理转折缺少此前经验/);
    assert.match(systems.get(stage),/技术或流程说明挤压现场行动/);assert.match(systems.get(stage),/不得为覆盖检查项强制诊断/);
    assert.match(systems.get(stage),/物件回环、歧义、克制、停顿和留白/);
  }

  readingContract=contracts.get('whole-quality:reading');
  assert.deepEqual(readingContract.issueSchema.properties.claimType.enum,['textual_conflict','reader_effect_hypothesis','editorial_preference']);
  assert.deepEqual(readingContract.issueSchema.properties.area.enum,['emotion_progression','meaningful_repetition','knowledge_continuity','causality','ending_cost','structure','other']);
  assert.deepEqual(readingContract.issueSchema.properties.priority.enum,['major','secondary','preserve']);assert.deepEqual(readingContract.issueSchema.properties.disposition.enum,['investigate','preserve','needs_evidence']);
  assert.equal(readingContract.issueSchema.properties.preservation.type,'array');assert.equal(readingContract.issueSchema.properties.limitations.type,'array');assert.equal(readingContract.issueSchema.properties.limitations.minItems,1);
  assert.match(readingContract.issueSchema.boundary,/only to an issue you choose to label major\+investigate/);assert.deepEqual(readingContract.legalEmptyResult.shape.issues,[]);
  assert(!Object.hasOwn(readingContract.evidence.properties,'start'));assert.match(readingContract.evidence.constraints.join(' '),/host derives/);

  const plan=contracts.get('whole-quality:plan');assert.deepEqual(plan.properties.decision.enum,['revise','preserve_original']);assert.deepEqual(plan.itemSchema.properties.decision.enum,['revise','preserve']);
  assert.equal(plan.itemSchema.properties.scope.const,'linked_scenes');assert.equal(plan.itemSchema.properties.sceneIds.minItems,0);assert(plan.itemSchema.conditionalConstraints[0].then.includes('sceneIds has at least 1 item'));
  assert.deepEqual(plan.materialDecisionSchema.properties.decision.enum,['used','not_used']);assert.deepEqual(plan.legalEmptyResult.shape.items,[]);assert.match(plan.itemSchema.constraints.join(' '),/mutually dependent targets/);assert.deepEqual(planEligible,['i-1']);assert.match(plan.inputBoundary.eligibleIssueIds.meaning,/plan model is not called/);

  const feasibility=contracts.get('whole-quality:feasibility');assert.deepEqual(feasibility.checkSchema.properties.assessment.enum,['feasible','infeasible','uncertain']);
  assert.deepEqual(feasibility.requirementCheckSchema.properties.assessment.enum,['supported','unsupported','uncertain']);assert.match(feasibility.checkSchema.conditionalConstraints[0].then.join(' '),/blockingReasons=\[\]/);

  const revision=contracts.get('whole-quality:revision');assert.equal(revision.replacementSchema.properties.replacement.type,'string');assert.equal(revision.replacementSchema.properties.replacement.minLength,0);
  assert.match(revision.globalConstraints[0],/exactly one/);assert.deepEqual(revision.legalEmptyResult.shape.replacements,[]);

  const reread=contracts.get('whole-quality:reread');assert.deepEqual(reread.changeCheckSchema.properties.executionStatus.enum,['applied','blocked','skipped']);
  assert.deepEqual(reread.changeCheckSchema.properties.goalAssessment.enum,['implemented','partly_implemented','not_implemented','uncertain','not_attempted']);
  assert.deepEqual(reread.changeCheckSchema.properties.coherenceAssessment.enum,['consistent','inconsistent','uncertain','not_checked']);
  assert.deepEqual(reread.requirementCheckSchema.properties.assessment.enum,['supported','not_supported','uncertain','not_attempted']);assert.deepEqual(reread.introducedIssueSchema.properties.severity.enum,['serious','moderate','minor']);
  assert.deepEqual(reread.legalEmptyResult.shape.introducedIssues,[]);assert.match(reread.globalConstraints.join(' '),/separate fields/);
});

test('feasibility distinguishes an outside-answer edit from authorized replacements that establish then reuse new state',async()=>{
  const calls=[];let eligibility;
  const model={complete:async args=>{calls.push(args.stage);const envelope=JSON.parse(args.user),input=args.stage.endsWith(':format-repair')?envelope.originalInput:envelope;
    if(args.stage==='whole-quality:reading'){const response=JSON.parse(readingResponse(input));response.issues.push({...issue(),id:'i-2',area:'meaningful_repetition',
      observation:'损坏实物离开台面后没有形成后续动作回响。',suspectedCause:'物件状态没有跨场延续。',sceneIds:['s-2','s-3'],
      evidence:[ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','前场可建立物件状态'),ev('ch-3','周青把未完的清单递过去。','后场可兑现触碰动作')],
      counterEvidence:[ev('ch-1','周青把零件簿推回柜台。','原稿已有可用实物')],preservation:[ev('ch-1','她说先把旧账分清，再谈谁留下。','保留争执')],
      expectedEffect:'让一个实物状态在两个授权落点间延续。',failureCriteria:'若需要改动 target 外文本或解释关系则失败。'});return JSON.stringify(response);}
    if(args.stage==='whole-quality:plan'){assert.match(args.system,/若要求改写 target 之后的另一句回答或事件，必须把那句本身另列为 target/);return JSON.stringify({
      schemaVersion:binding(input,'schemaVersion'),inputHash:binding(input,'inputHash'),sourceManuscriptSha256:binding(input,'sourceManuscriptSha256'),readingSha256:binding(input,'readingSha256'),retrievalSha256:binding(input,'retrievalSha256'),
      decision:'revise',summary:'分别检查越界回答与跨场物件动作。',items:[
        {id:'p-1',issueIds:['i-1'],decision:'revise',scope:'linked_scenes',affectedChapterIds:['ch-1'],sceneIds:['s-1'],
          targets:[{id:'t-1',sceneId:'s-1',...ev('ch-1','周青把零件簿推回柜台。','只授权问句前的动作句')}],
          actionRequirements:[{id:'r-1',description:'改写 target 之后“她说先把旧账分清”的回答句。',targetIds:['t-1'],expectedVisibleChange:'后一句回答改变',failureCriterion:'回答句不变则失败'}],
          action:'改后一句回答。',rationale:'测试越界。',expectedEffect:'回答改变。',failureCriteria:'不得复制出第二个回答。',risks:['可能越界。'],
          preserve:[ev('ch-2','第二天电话又响。','保留电话')],adoptedSupplyIds:[],independentAdoption:'独立检查越界。'},
        {id:'p-2',issueIds:['i-2'],decision:'revise',scope:'linked_scenes',affectedChapterIds:['ch-2','ch-3'],sceneIds:['s-2','s-3'],
          targets:[{id:'t-2a',sceneId:'s-2',...ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','整体替换落点可保留原句并新增收起纸页的动作')},
            {id:'t-2b',sceneId:'s-3',...ev('ch-3','周青把未完的清单递过去。','后续整体替换落点可触碰先前收起的纸页')}],
          actionRequirements:[{id:'r-2a',description:'保留原句并补写林遥折起一页收入口袋。',targetIds:['t-2a'],expectedVisibleChange:'前场建立被收起的纸页',failureCriterion:'只改名词而没有动作'},
            {id:'r-2b',description:'在后场加入她隔着口袋碰到那页纸的短动作。',targetIds:['t-2b'],expectedVisibleChange:'后场兑现触觉回响',failureCriterion:'解释或说出纸页意义'}],
          action:'前场建立物件，后场触碰。',rationale:'同组按顺序建立并兑现。',expectedEffect:'动作形成连续性。',failureCriteria:'不得要求物件预先存在。',risks:['新增动作可能过重。'],
          preserve:[ev('ch-3','林遥接过，没有说原谅。','保留克制结尾')],adoptedSupplyIds:[],independentAdoption:'本组两个 target 原子联动，不依赖另一组。'}],
      materialDecisions:[],unresolved:[]});}
    if(args.stage==='whole-quality:feasibility'){assert.match(args.system,/可被整体替换的 source span/);assert.match(args.system,/不得仅因旧引文没有.*拟新增内容就判 unsupported/);
      assert.match(args.system,/较早 target 的替换可以先建立物件或状态，较后 target 的替换再使用/);assert.match(args.system,/唯一 target 只覆盖问句/);
      assert.match(input.responseContract.requirementCheckSchema.constraints.join(' '),/noun-only coverage/);return JSON.stringify({schemaVersion:binding(input,'schemaVersion'),inputHash:binding(input,'inputHash'),
        sourceManuscriptSha256:binding(input,'sourceManuscriptSha256'),planSha256:binding(input,'planSha256'),checks:[
          {planItemId:'p-1',assessment:'infeasible',reason:'唯一 target 不覆盖被要求改写的后一句回答。',requirementChecks:[{requirementId:'r-1',assessment:'unsupported',reason:'替换前一句不能删除或改写未授权的后一句。',targetIds:['t-1']}],
            sourceEvidence:[ev('ch-1','周青把零件簿推回柜台。','授权 span'),ev('ch-1','她说先把旧账分清，再谈谁留下。','未授权回答')],blockingReasons:['要求改动 target 外回答。'],limitations:['只判断授权范围。']},
          {planItemId:'p-2',assessment:'feasible',reason:'两个完整句 span 可用较长 replacement 先建立物件再兑现触碰。',requirementChecks:[
            {requirementId:'r-2a',assessment:'supported',reason:'第一 target 可保留原句并追加收起动作。',targetIds:['t-2a']},
            {requirementId:'r-2b',assessment:'supported',reason:'同组后续 target 可使用第一 target 新建立的物件。',targetIds:['t-2b']}],
            sourceEvidence:[ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','前场替换 span'),ev('ch-3','周青把未完的清单递过去。','后场替换 span')],blockingReasons:[],limitations:['可行不证明文学效果。']}]});}
    if(args.stage==='whole-quality:revision'){eligibility=input.eligiblePlanItemIds;throw Error('expected-revision-dispatch');}
    throw Error(`unexpected ${args.stage}`);}};
  await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model}),/expected-revision-dispatch/);
  assert.deepEqual(eligibility,['p-2']);assert.deepEqual(calls,['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:revision']);
});

test('verbatim evidence failure gives format repair the exact field, chapter and quote without loosening whitespace rules',async()=>{
  const actualRequest=request();
  actualRequest.chapters[2].body+='\n\n耳机里只剩回潮。\n\n安禾没动。她等。\n\n一分多钟后，走廊里有了脚步声。';
  const j=journal();let repairEnvelope,repairSystem;const calls=[];
  const model={complete:async args=>{
    calls.push(args.stage);
    const envelope=JSON.parse(args.user),input=args.stage.endsWith(':format-repair')?envelope.originalInput:envelope;
    const response=JSON.parse(readingResponse(input));
    const exactEvidence=ev('ch-3','安禾没动。她等。','等待没有被说明替代');
    for(let sequence=2;sequence<=5;sequence++)response.sceneChanges.push({id:`s-${sequence+2}`,chapterId:'ch-3',sequence,
      entryEvidence:exactEvidence,exitEvidence:exactEvidence,beforeState:'等待仍在继续',trigger:'耳机只剩回潮',action:'安禾没有动作',afterState:'等待延长',cost:'没有即时回答',
      narrativeFunction:'保留停顿',preservedStrengths:[exactEvidence]});
    response.sceneChanges[6].preservedStrengths[0]=ev('ch-3','她没动。她等。','等待没有被说明替代');
    if(args.stage==='whole-quality:reading:format-repair'){repairEnvelope=envelope;repairSystem=args.system;}
    return JSON.stringify(response);
  }};
  await assert.rejects(runWholeManuscriptQualityRevision({request:actualRequest,model,checkpoint:j.checkpoint}),error=>{
    assert.equal(error.code,'WHOLE_QUALITY_FORMAT_FAILED');
    assert.equal(error.causeCode,'WHOLE_QUALITY_READING');
    assert.deepEqual(error.causeLocation,j.artifacts['whole-quality:reading:repair-input'].repairInput.errorLocation);
    return true;
  });
  assert.deepEqual(calls,['whole-quality:reading','whole-quality:reading:format-repair']);
  assert.equal(repairEnvelope.repairInput.errorLocation.fieldPath,'sceneChanges[6].preservedStrengths[0]');
  assert.equal(repairEnvelope.repairInput.errorLocation.chapterId,'ch-3');
  assert.equal(repairEnvelope.repairInput.errorLocation.quote,'她没动。她等。');
  assert.match(repairEnvelope.repairInput.errorLocation.quoteSha256,/^[0-9a-f]{64}$/);
  assert.match(repairEnvelope.repairInput.errorLocation.chapterBodySha256,/^[0-9a-f]{64}$/);
  assert.match(repairEnvelope.originalInput.chapters[2].body,/耳机里只剩回潮。\n\n安禾没动。她等。\n\n一分多钟后/);
  assert.equal(repairEnvelope.originalInput.chapters[2].body.includes('她没动。她等。'),false);
  assert.match(repairSystem,/短而连续的逐字引文/);
  assert.match(repairSystem,/保留原文全部字符、空格和换行/);
  assert.match(repairSystem,/不得省略词语、拼接片段、改写或做空白归一化/);
  assert.equal(Object.keys(j.artifacts).filter(key=>key==='whole-quality:reading:repair-response').length,1);
});

test('a single format repair can use the location to restore the omitted source word without deleting evidence',async()=>{
  const actualRequest=request();
  actualRequest.chapters[2].body+='\n\n耳机里只剩回潮。\n\n安禾没动。她等。\n\n一分多钟后，走廊里有了脚步声。';
  const base=modelFor(),readingCalls=[],j=journal();
  const responseFor=(input,corrected)=>{const response=JSON.parse(readingResponse(input)),exactEvidence=ev('ch-3','安禾没动。她等。','等待没有被说明替代');
    for(let sequence=2;sequence<=5;sequence++)response.sceneChanges.push({id:`s-${sequence+2}`,chapterId:'ch-3',sequence,entryEvidence:exactEvidence,exitEvidence:exactEvidence,
      beforeState:'等待仍在继续',trigger:'耳机只剩回潮',action:'安禾没有动作',afterState:'等待延长',cost:'没有即时回答',narrativeFunction:'保留停顿',preservedStrengths:[exactEvidence]});
    if(!corrected)response.sceneChanges[6].preservedStrengths[0]=ev('ch-3','她没动。她等。','等待没有被说明替代');return JSON.stringify(response);};
  const model={complete:async args=>{if(args.stage.startsWith('whole-quality:reading')){readingCalls.push(args.stage);const envelope=JSON.parse(args.user),repair=args.stage.endsWith(':format-repair');
      return responseFor(repair?envelope.originalInput:envelope,repair);}return base.complete(args);}};
  const result=await runWholeManuscriptQualityRevision({request:actualRequest,model,checkpoint:j.checkpoint});
  const evidence=result.wholeRevision.quality.independentReading.sceneChanges[6].preservedStrengths[0];
  assert.deepEqual(readingCalls,['whole-quality:reading','whole-quality:reading:format-repair']);
  assert.equal(result.wholeRevision.quality.independentReading.sceneChanges.length,7);
  assert.equal(evidence.quote,'安禾没动。她等。');
  assert.equal(evidence.start,actualRequest.chapters[2].body.indexOf('安禾没动。她等。'));

  const legacy=structuredClone(j.artifacts),legacyRepairInput=structuredClone(legacy['whole-quality:reading:repair-input'].repairInput);
  legacyRepairInput.schemaVersion='whole-quality-format-repair-1';delete legacyRepairInput.literalEvidenceFeedback;
  delete legacyRepairInput.errorLocation;
  const legacyRepairInputHash=stableFingerprint(legacyRepairInput);
  legacy['whole-quality:reading:repair-input']={repairInputHash:legacyRepairInputHash,repairInput:legacyRepairInput};
  legacy['whole-quality:reading:repair-response'].inputHash=legacyRepairInputHash;
  delete legacy['whole-quality:reading:result'];delete legacy['whole-quality:reading:receipt'];
  const validInspection=inspectStoredWholeQualityReadingFailure(legacy);
  assert.equal(validInspection.exhausted,false);assert.equal(validInspection.reason,'repair_valid');
  let resumedCalls=0,retrievalCalls=0;
  const resumed=await runWholeManuscriptQualityRevision({request:actualRequest,artifacts:legacy,checkpoint:async()=>{},
    model:{complete(){resumedCalls++;throw Error('forbidden');}},retrieveKnowledge(){retrievalCalls++;throw Error('forbidden');}});
  assert.equal(resumedCalls,0);assert.equal(retrievalCalls,0);assert.deepEqual(resumed,result);

  const exhausted=structuredClone(legacy),invalidRaw=exhausted['whole-quality:reading:primary-response'].rawResponse;
  exhausted['whole-quality:reading:repair-response'].rawResponse=invalidRaw;
  exhausted['whole-quality:reading:repair-response'].responseSha256=hash(invalidRaw);
  const exhaustedInspection=inspectStoredWholeQualityReadingFailure(exhausted);
  assert.equal(exhaustedInspection.exhausted,true);assert.equal(exhaustedInspection.reason,'both_responses_invalid');
  assert.equal(exhaustedInspection.primaryError.location.fieldPath,'sceneChanges[6].preservedStrengths[0]');
  assert.equal(exhaustedInspection.repairError.location.quote,'她没动。她等。');

  const tampered=structuredClone(exhausted);tampered['whole-quality:reading:repair-response'].responseSha256='0'.repeat(64);
  const tamperedInspection=inspectStoredWholeQualityReadingFailure(tampered);
  assert.equal(tamperedInspection.exhausted,false);assert.equal(tamperedInspection.reason,'invalid_or_incomplete_checkpoint');

  const wrongLocation=structuredClone(j.artifacts),wrongRepairRecord=wrongLocation['whole-quality:reading:repair-input'];
  wrongRepairRecord.repairInput.errorLocation.quote='安禾没动。她等。';
  wrongRepairRecord.repairInputHash=stableFingerprint(wrongRepairRecord.repairInput);
  wrongLocation['whole-quality:reading:repair-response'].inputHash=wrongRepairRecord.repairInputHash;
  const wrongLocationInspection=inspectStoredWholeQualityReadingFailure(wrongLocation);
  assert.equal(wrongLocationInspection.exhausted,false);assert.equal(wrongLocationInspection.reason,'invalid_or_incomplete_checkpoint');
});

test('v2 reads scenes, retrieves by problem, checks feasibility, applies atomic linked scenes and rereads goal separately from coherence',async()=>{
  const j=journal(),model=modelFor(),result=await runWholeManuscriptQualityRevision({request:request(),model,retrieveKnowledge:uncovered,checkpoint:j.checkpoint});
  assert.deepEqual(model.calls.map(c=>c.stage),['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:revision','whole-quality:reread']);
  assert.equal(result.wholeRevision.quality.retrieval.callbackCalls,1);assert.equal(result.wholeRevision.quality.retrieval.byIssue[0].status,'uncovered');
  assert.deepEqual(result.wholeRevision.diff.changedChapterIds,['ch-1','ch-2']);assert.equal(result.wholeRevision.reread.changeChecks[0].goalAssessment,'implemented');
  assert.equal(result.wholeRevision.reread.changeChecks[0].coherenceAssessment,'consistent');assert.equal(result.wholeRevision.adoption.atomicGroups[0].recommendation,'eligible_for_user_choice');assert.match(result.wholeRevision.adoption.atomicGroups[0].independentAdoption,/不依赖其他修改组/);
  assert.deepEqual(assertWholeQualityResult(result,j.artifacts.requestSpec),result);
});

test('a change group may use one necessary scene and one visible requirement without padding',async()=>{const result=await runWholeManuscriptQualityRevision({request:request(),model:modelFor({oneScene:true})});
  assert.deepEqual(result.wholeRevision.plan.items[0].sceneIds,['s-2']);assert.equal(result.wholeRevision.plan.items[0].actionRequirements.length,1);
  assert.deepEqual(result.wholeRevision.diff.changedChapterIds,['ch-2']);});

test('DATA evidence bundle and used ledger stay source-bound through the final artifact',async()=>{const j=journal(),result=await runWholeManuscriptQualityRevision({request:request(),model:modelFor({oneScene:true}),retrieveKnowledge:matched,checkpoint:j.checkpoint});
  const supply=result.wholeRevision.quality.retrieval.supplies[0],ledger=result.wholeRevision.quality.materialUse.ledgers[0];
  assert.equal(supply.reviewBoundary,'unreviewed_raw_reference');assert.equal(ledger.usedMaterialIds[0],'raw-1');
  assert.equal(ledger.decisions[0].evidenceIds[0],supply.evidenceIds[0]);assert.deepEqual(ledger.decisions[0].sourceBindings,[{sourceId:'source-a',sourceSha256:'a'.repeat(64),textVersion:'text-v1'}]);
  assert.deepEqual(result.wholeRevision.quality.applicability.directSupplyIds,[supply.supplyId]);
  assert.equal(result.wholeRevision.quality.finalTextMaterialEvidence.byIssue[0].records[0].status,'located');
  assert.equal(result.wholeRevision.quality.finalTextMaterialEvidence.literaryEffect,'NOT_COMPUTED');
  assert.equal(result.wholeRevision.quality.c06References.completeLibraryComparison,false);
  assert.deepEqual(result.wholeRevision.stageReceipts.map(item=>item.stage),['whole-quality:reading','whole-quality:applicability','whole-quality:plan','whole-quality:feasibility','whole-quality:revision','whole-quality:reread','whole-quality:material-evidence']);
  let modelCalls=0,retrievalCalls=0;const resumed=await runWholeManuscriptQualityRevision({request:request(),artifacts:j.artifacts,checkpoint:async()=>{},
    model:{complete(){modelCalls++;throw Error('forbidden');}},retrieveKnowledge(){retrievalCalls++;throw Error('forbidden');}});
  assert.equal(modelCalls,0);assert.equal(retrievalCalls,0);assert.deepEqual(resumed,result);
  const forged=structuredClone(j.artifacts);forged['whole-quality:applicability:result'].directSupplyIds=[];
  await assert.rejects(runWholeManuscriptQualityRevision({request:request(),artifacts:forged,checkpoint:async()=>{},model:{complete(){throw Error('forbidden');}}}),{code:'WHOLE_QUALITY_APPLICABILITY'});
});

test('mechanism-only material cannot be marked used, while no supplied material leaves original planning available',async()=>{
  await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model:modelFor({oneScene:true,applicabilityFit:'mechanism_only'}),retrieveKnowledge:matched}),{code:'WHOLE_QUALITY_FORMAT_FAILED'});
  const model=modelFor({oneScene:true}),result=await runWholeManuscriptQualityRevision({request:request(),model,retrieveKnowledge:uncovered});
  assert.equal(result.wholeRevision.quality.applicability.noSuitableMaterial,undefined);
  assert.deepEqual(result.wholeRevision.quality.applicability.noSuitableIssueIds,['i-1']);
  assert.equal(result.wholeRevision.quality.applicability.modelStageDispatched,false);
  assert.equal(result.revisionApplied,true);
  assert.equal(model.calls.some(call=>call.stage.startsWith('whole-quality:applicability')),false);
});

test('narrative observation recall is wired before the single normal retrieval call and remains source-bound evidence only',async()=>{
  let observationCalls=0,retrievalCalls=0;
  const result=await runWholeManuscriptQualityRevision({request:request(),model:modelFor(),
    queryNarrativeObservations:async query=>{observationCalls++;assert.equal(query.query,issue().observation);return{contractVersion:'narrative-observation-query-1',queryHash:'f'.repeat(64),status:'uncovered',request:{query:query.query},results:[]};},
    retrieveKnowledge:async query=>{retrievalCalls++;assert.equal(query.query,issue().observation);assert.equal(Object.hasOwn(query.recall,'observationSeeds'),false);return uncovered(query);}});
  assert.equal(observationCalls,1);assert.equal(retrievalCalls,1);
  const retrieval=result.wholeRevision.quality.retrieval.byIssue[0].result;
  assert.equal(retrieval.observationRecall.availableSeedCount,0);
  assert.match(retrieval.observationRecall.boundary,/不自动供应/);
});

test('infeasible action plan is blocked before revision and original stays byte-identical',async()=>{const model=modelFor({blocked:true}),result=await runWholeManuscriptQualityRevision({request:request(),model});
  assert.deepEqual(model.calls.map(c=>c.stage),['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:reread']);assert.equal(result.revisionApplied,false);assert.deepEqual(result.chapters,chapters);
  assert.equal(result.wholeRevision.reread.changeChecks[0].executionStatus,'blocked');assert.equal(result.wholeRevision.adoption.atomicGroups[0].recommendation,'not_recommended');assert.deepEqual(result.wholeRevision.quality.materialUse.notConnectedIssueIds,['i-1']);});

test('host rejects a feasibility response that calls unsupported noun-only targets feasible',async()=>{const model=modelFor({blocked:true,lie:true});await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model}),{code:'WHOLE_QUALITY_FORMAT_FAILED'});
  assert.deepEqual(model.calls.map(c=>c.stage),['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:feasibility:format-repair']);
  const repairInput=JSON.parse(model.calls.at(-1).user).repairInput;assert.equal(repairInput.schemaVersion,'whole-quality-format-repair-1');assert.equal(repairInput.literalEvidenceFeedback,undefined);});

test('no major safe issue preserves original, skips retrieval feasibility and revision, and records honest not-connected state',async()=>{const model=modelFor({preserve:true}),result=await runWholeManuscriptQualityRevision({request:request(),model});
  assert.deepEqual(model.calls.map(c=>c.stage),['whole-quality:reading','whole-quality:reread']);assert.equal(result.revisionApplied,false);assert.deepEqual(result.chapters,chapters);
  assert.equal(result.wholeRevision.quality.retrieval.callbackCalls,0);assert.equal(result.wholeRevision.quality.retrieval.byIssue.length,0);assert.equal(result.wholeRevision.quality.feasibility.schemaVersion,'whole-quality-feasibility-not-required-1');
  assert.equal(result.wholeRevision.plan.origin,'host_no_eligible_issues');assert.equal(result.wholeRevision.planProvenance.producer,'host');assert.equal(result.wholeRevision.planProvenance.modelStageDispatched,false);
  assert.equal(result.wholeRevision.modelCalls.primaryCalls,2);assert.deepEqual(result.wholeRevision.stageReceipts.map(r=>r.stage),['whole-quality:reading','whole-quality:reread']);});

test('secondary-only reading is retained by a bound host plan without dispatching or repairing plan model output',async()=>{const j=journal(),model=modelFor({secondary:true}),result=await runWholeManuscriptQualityRevision({request:request(),model,checkpoint:j.checkpoint});
  assert.deepEqual(model.calls.map(c=>c.stage),['whole-quality:reading','whole-quality:reread']);assert.deepEqual(result.wholeRevision.planProvenance.eligibleIssueIds,[]);
  assert.equal(result.wholeRevision.plan.items.length,1);assert.equal(result.wholeRevision.plan.items[0].decision,'preserve');assert.deepEqual(result.wholeRevision.plan.items[0].issueIds,['i-1']);
  assert(j.artifacts['whole-quality:plan:host-input']);assert(j.artifacts['whole-quality:plan:host-result']);assert.equal(j.artifacts['whole-quality:plan:primary-response'],undefined);
  let calls=0;const resumed=await runWholeManuscriptQualityRevision({request:request(),artifacts:j.artifacts,checkpoint:j.checkpoint,model:{complete(){calls++;throw Error('forbidden');}}});
  assert.equal(calls,0);assert.deepEqual(resumed,result);
  const forgedResult=structuredClone(result);forgedResult.wholeRevision.planProvenance.planInputSha256=hash('forged');assert.throws(()=>assertWholeQualityResult(forgedResult,j.artifacts.requestSpec),{code:'WHOLE_QUALITY_PLAN_PROVENANCE'});
  const forgedArtifacts=structuredClone(j.artifacts);forgedArtifacts['whole-quality:plan:host-result'].summary='forged';await assert.rejects(runWholeManuscriptQualityRevision({request:request(),artifacts:forgedArtifacts,checkpoint:j.checkpoint,model:{complete(){throw Error('forbidden');}}}),{code:'WHOLE_QUALITY_CHECKPOINT_MISMATCH'});});

test('result gate remains compatible with the immediately previous model-plan result shape',async()=>{const j=journal(),current=await runWholeManuscriptQualityRevision({request:request(),model:modelFor({preserve:true}),checkpoint:j.checkpoint}),legacy=structuredClone(current);
  const legacyPlanInput=structuredClone(j.artifacts['whole-quality:plan:host-input'].input),contract=legacyPlanInput.responseContract;
  legacyPlanInput.schemaVersion='whole-quality-plan-input-1';delete legacyPlanInput.applicability;delete legacyPlanInput.eligibleIssueIds;contract.schemaVersion='whole-quality-plan-response-contract-2';delete contract.inputBoundary;delete contract.optional;delete contract.properties.origin;
  contract.itemSchema.properties.issueIds.items.enumFrom='input.reading.issues[].id';contract.globalConstraints=contract.globalConstraints.slice(0,-1);
  const planInputHash=stableFingerprint(legacyPlanInput);delete legacy.wholeRevision.plan.origin;legacy.wholeRevision.plan.inputHash=planInputHash;delete legacy.wholeRevision.planProvenance;
  legacy.wholeRevision.quality.feasibility.planSha256=stableFingerprint(legacy.wholeRevision.plan);
  const rereadInput=structuredClone(j.artifacts['whole-quality:reread:input'].input);rereadInput.plan=legacy.wholeRevision.plan;rereadInput.feasibility=legacy.wholeRevision.quality.feasibility;
  const rereadInputHash=stableFingerprint(rereadInput);legacy.wholeRevision.reread.inputHash=rereadInputHash;
  const readingReceipt=legacy.wholeRevision.stageReceipts[0],rereadReceipt={...legacy.wholeRevision.stageReceipts.at(-1),inputHash:rereadInputHash};
  legacy.wholeRevision.stageReceipts=[readingReceipt,{stage:'whole-quality:plan',inputHash:planInputHash,primaryResponseSha256:hash('legacy-plan-response')},rereadReceipt];
  delete legacy.wholeRevision.quality.applicability;delete legacy.wholeRevision.quality.finalTextMaterialEvidence;delete legacy.wholeRevision.quality.c06References;
  legacy.wholeRevision.modelCalls.primaryCalls=3;legacy.wholeRevision.modelCalls.maxPrimaryCalls=5;legacy.wholeRevision.modelCalls.maxFormatRepairCalls=5;
  assert.deepEqual(assertWholeQualityResult(legacy,j.artifacts.requestSpec),legacy);});

test('completed checkpoints resume without model or retrieval calls',async()=>{const j=journal(),first=modelFor(),expected=await runWholeManuscriptQualityRevision({request:request(),model:first,retrieveKnowledge:uncovered,checkpoint:j.checkpoint});let calls=0,retrieval=0;
  const resumed=await runWholeManuscriptQualityRevision({request:request(),artifacts:j.artifacts,checkpoint:j.checkpoint,model:{complete(){calls++;throw Error('forbidden');}},retrieveKnowledge(){retrieval++;throw Error('forbidden');}});
  assert.equal(calls,0);assert.equal(retrieval,0);assert.deepEqual(resumed,expected);});

test('cross-scene group cannot partially apply',async()=>{await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model:modelFor({partial:true})}),{code:'WHOLE_QUALITY_FORMAT_FAILED'});});

test('pure result gate rejects candidate and adoption forgery',async()=>{const j=journal(),result=await runWholeManuscriptQualityRevision({request:request(),model:modelFor(),checkpoint:j.checkpoint});
  for(const mutate of [v=>{v.chapters[0].body+='越权';},v=>{v.wholeRevision.adoption.atomicGroups[0].recommendation='eligible_for_user_choice';v.wholeRevision.reread.changeChecks[0].goalAssessment='not_implemented';}]){const forged=structuredClone(result);mutate(forged);assert.throws(()=>assertWholeQualityResult(forged,j.artifacts.requestSpec));}});

test('new draft guidance exposes the same scene-change and failure-criterion method without claiming prose exists',()=>{const guidance=createWholeQualityDraftGuidance({premise:'姐妹处理旧账。',ending:'形成有限合作。',sceneChanges:[{id:'s1',beforeState:'未分工',trigger:'电话响',action:'妹妹接电话',afterState:'开始分工',cost:'仍未和解',failureCriterion:'只说愿意而未行动'}],priorities:[{id:'p1',problem:'承担不可见',expectedEffect:'用行动推进',failureCriterion:'只有说明'}],materialDecisions:[],unresolved:[]});
  assert.equal(guidance.schemaVersion,'whole-quality-draft-guidance-1');assert.match(guidance.guidanceSha256,/^[0-9a-f]{64}$/);assert.match(guidance.boundary,/不证明/);});

test('request spec binds v2 source, objective and base revision',()=>{const spec=createWholeQualityRequestSpec(request());assert.equal(spec.revisionMode,'whole-manuscript-v2');assert.equal(spec.sourceBaseRevision,'base-1');assert.match(spec.inputFingerprint,/^[0-9a-f]{64}$/);});

test('whole-quality checkpoint binds deep-reference enabled versus disabled policy',async()=>{
  const legacy=createWholeQualityRequestSpec(request()),enhanced=createWholeQualityRequestSpec(request(),{deepReferenceEnabled:true});
  assert.equal(legacy.deepReferencePolicyVersion,undefined);assert.equal(enhanced.deepReferencePolicyVersion,'creation-deep-reference-integration-1');
  assert.notEqual(legacy.inputFingerprint,enhanced.inputFingerprint);let modelCalls=0,deepCalls=0;
  const model={complete(){modelCalls+=1;throw Error('forbidden');}},deep=async()=>{deepCalls+=1;throw Error('forbidden');};
  await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model,queryDeepReferences:deep,artifacts:{requestSpec:legacy}}),{code:'WHOLE_QUALITY_CHECKPOINT_MISMATCH'});
  await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model,artifacts:{requestSpec:enhanced}}),{code:'WHOLE_QUALITY_CHECKPOINT_MISMATCH'});
  assert.equal(modelCalls,0);assert.equal(deepCalls,0);
});

test('enhanced final result keeps the rebuilt deep-reference bundle through the full gate and zero-call resume',async()=>{
  const j=journal(),result=await runWholeManuscriptQualityRevision({request:request(),model:modelFor(),retrieveKnowledge:uncovered,
    queryDeepReferences:async()=>{throw Error('offline unavailable fixture');},checkpoint:j.checkpoint});
  assert.equal(result.wholeRevision.quality.deepReference.callbackStatus,'unavailable');
  const before=structuredClone(result);
  assert.deepEqual(assertWholeQualityResult(result,j.artifacts.requestSpec),before);
  assert.deepEqual(result,before);
  let calls=0,writes=0;
  const forbidden=async()=>{calls++;throw Error('unexpected external call');};
  const resumed=await runWholeManuscriptQualityRevision({request:request(),artifacts:j.artifacts,model:{complete:forbidden},
    queryDeepReferences:forbidden,retrieveKnowledge:forbidden,checkpoint:async()=>{writes++;throw Error('unexpected checkpoint write');}});
  assert.deepEqual(resumed,result);assert.equal(calls,0);assert.equal(writes,0);
  const forged=structuredClone(result);forged.wholeRevision.quality.deepReference.callbackStatus='matched';
  assert.throws(()=>assertWholeQualityResult(forged,j.artifacts.requestSpec),{code:'WHOLE_QUALITY_RESULT'});
});

function crossReviewResult(chapterList,{confirmed=true}={}){const first=chapterList[0],second=chapterList[1],left='她说先把旧账分清，再谈谁留下。',right=confirmed?'林遥说自己只是回来帮忙，手却停在欠款页上。':'林遥接起电话，说明自己前一天已核过欠款，再把余下三家记到名下。';return{
  schemaVersion:'cross-chapter-review-result-1',modelPolicy:'whole-manuscript-quality-json-1',manuscriptSha256:'a'.repeat(64),checkedChapterIds:chapterList.map(item=>item.id),chapterCoverage:[],entities:[],events:[],claims:[],comparisonGroups:[],
  findings:confirmed?[{groupId:'fact-1',status:'confirmed_conflict',summary:'同一欠款事实被写成先已知、后初次接触。',sameEventDecision:'same',resolutionReason:'direct_conflict',
    evidence:[{claimId:'c-1',chapterId:first.id,quote:left,start:first.body.indexOf(left),role:'support'},{claimId:'c-2',chapterId:second.id,quote:right,start:second.body.indexOf(right),role:'support'}],counterchecks:{}}]:[],
  counts:{confirmed_conflict:confirmed?1:0,ambiguous:0,resolved:0},stageReceipts:[
    {stage:'whole-quality:cross-chapter:extract',primaryResponseSha256:'1'.repeat(64)},
    {stage:'whole-quality:cross-chapter:adjudicate',primaryResponseSha256:'2'.repeat(64)}],independentReviewProtocolMutation:false,qualityPreset:false,automaticRepairEligible:false};}

function crossAwareFixture({unresolved=false,candidateUnrelated=false,candidateRelatedRenumbered=false}={}){const calls=[],reviewCalls=[];const model={calls,complete:async args=>{calls.push(args);const envelope=JSON.parse(args.user),u=args.stage.endsWith(':format-repair')?envelope.originalInput:envelope;
  if(args.stage.startsWith('whole-quality:reading'))return readingResponse(u,{preserve:true});
  if(args.stage.startsWith('whole-quality:plan')){const conflict=u.confirmedConflicts[0];if(unresolved)return JSON.stringify({schemaVersion:binding(u,'schemaVersion'),inputHash:binding(u,'inputHash'),sourceManuscriptSha256:binding(u,'sourceManuscriptSha256'),readingSha256:binding(u,'readingSha256'),retrievalSha256:binding(u,'retrievalSha256'),decision:'preserve_original',summary:'冻结冲突无法在授权范围内安全修订。',items:[],materialDecisions:[],unresolved:[{issueId:conflict.id,reason:'相邻说话人边界不够明确，保留为未决。'}]});
    const scope=conflict.scopeOptions.find(item=>item.chapterId==='ch-2'&&item.quote.includes('林遥说自己只是回来帮忙'));
    return JSON.stringify({schemaVersion:binding(u,'schemaVersion'),inputHash:binding(u,'inputHash'),sourceManuscriptSha256:binding(u,'sourceManuscriptSha256'),readingSha256:binding(u,'readingSha256'),retrievalSha256:binding(u,'retrievalSha256'),decision:'revise',summary:'在冻结连续段落内统一欠款认知。',items:[{id:'cross-plan-1',issueIds:[conflict.id],decision:'revise',scope:'linked_scenes',affectedChapterIds:['ch-2'],sceneIds:['s-2'],targets:[{id:'cross-target-1',sceneId:'s-2',chapterId:scope.chapterId,quote:scope.quote,purpose:'在最小连续段落内修复认知冲突'}],actionRequirements:[{id:'cross-req-1',description:'明确林遥此前已核过欠款并承担后续电话',targetIds:['cross-target-1'],expectedVisibleChange:'认知与行动在同一句可见',failureCriterion:'仍写成第一次接触欠款'}],action:'统一欠款认知并让承担落地。',rationale:'事实核对已确认互斥。',expectedEffect:'跨章事实一致。',failureCriteria:'删除问题但没有保留人物行动。',risks:['可能改变克制语气。'],preserve:[ev('ch-3','林遥接过，没有说原谅。','保留结尾优点')],adoptedSupplyIds:[],independentAdoption:'该事实修复不依赖其他修改组。'}],materialDecisions:[],unresolved:[]});}
  if(args.stage.startsWith('whole-quality:feasibility')){const item=u.plan.items[0];return JSON.stringify({schemaVersion:binding(u,'schemaVersion'),inputHash:binding(u,'inputHash'),sourceManuscriptSha256:binding(u,'sourceManuscriptSha256'),planSha256:binding(u,'planSha256'),checks:[{planItemId:item.id,assessment:'feasible',reason:'冻结段落覆盖完整认知与动作。',requirementChecks:item.actionRequirements.map(req=>({requirementId:req.id,assessment:'supported',reason:'可在该连续段落完成。',targetIds:req.targetIds})),sourceEvidence:[ev('ch-2',item.targets[0].quote,'冻结范围')],blockingReasons:[],limitations:['仍须复读说话人和视角。']}]});}
  if(args.stage.startsWith('whole-quality:revision')){const target=u.plan.items[0].targets[0];return JSON.stringify({schemaVersion:binding(u,'schemaVersion'),inputHash:binding(u,'inputHash'),sourceManuscriptSha256:binding(u,'sourceManuscriptSha256'),planSha256:binding(u,'planSha256'),feasibilitySha256:binding(u,'feasibilitySha256'),replacements:[{targetId:target.id,chapterId:target.chapterId,sourceQuote:target.quote,replacement:'林遥接起电话，说明自己前一天已核过欠款，再把余下三家记到名下。',appliedPlanItemIds:['cross-plan-1'],notes:['保持林遥为说话人与视角承担者。']}],skippedPlanItems:[]});}
  if(args.stage.startsWith('whole-quality:reread')){const applied=!unresolved,quote='林遥接起电话，说明自己前一天已核过欠款，再把余下三家记到名下。';return JSON.stringify({schemaVersion:binding(u,'schemaVersion'),inputHash:binding(u,'inputHash'),sourceManuscriptSha256:binding(u,'sourceManuscriptSha256'),candidateManuscriptSha256:binding(u,'candidateManuscriptSha256'),checkedChapterIds:binding(u,'checkedChapterIds'),coverage:{status:'complete',omissions:[]},summary:applied?'冲突消除且说话人、视角和克制结尾保持。':'冲突未执行修订。',changeChecks:u.plan.items.filter(item=>item.decision==='revise').map(item=>({planItemId:item.id,executionStatus:'applied',goalAssessment:'implemented',coherenceAssessment:'consistent',reason:'认知与行动已经统一。',requirementChecks:item.actionRequirements.map(req=>({requirementId:req.id,assessment:'supported',reason:'候选逐字可见。',evidence:[ev('ch-2',quote,'冲突修复证据')]})),risks:[],recommendation:'eligible_for_user_choice'})),introducedIssues:[],unresolvedItems:[],preservedStrengths:[ev('ch-3','林遥接过，没有说原谅。','结尾仍保留')],crossChapterChecks:u.confirmedConflicts.map(conflict=>({conflictId:conflict.id,assessment:applied?'resolved':'not_attempted',reason:applied?'原互斥认知已统一。':'未执行修订。',evidence:applied?[ev('ch-2',quote,'候选事实一致')]:[]}))});}
  throw Error(`unexpected ${args.stage}`);}};
  const reviewCrossChapter=async ({manuscript,modelPolicy})=>{reviewCalls.push(structuredClone(manuscript));assert.equal(modelPolicy,'whole-manuscript-quality-json-1');const fixed=manuscript.chapters[1].body.includes('前一天已核过欠款');
    if(fixed&&candidateUnrelated){const review=crossReviewResult(manuscript.chapters,{confirmed:false}),left='周青把零件簿推回柜台。',right='林遥接过，没有说原谅。';review.findings=[{groupId:'fact-1',status:'confirmed_conflict',summary:'候选稿另有与原欠款冲突无关的清单风险。',sameEventDecision:'same',resolutionReason:'direct_conflict',
      evidence:[{claimId:'other-a',chapterId:'ch-1',quote:left,start:manuscript.chapters[0].body.indexOf(left),role:'support'},{claimId:'other-b',chapterId:'ch-3',quote:right,start:manuscript.chapters[2].body.indexOf(right),role:'support'}],counterchecks:{}}];review.counts.confirmed_conflict=1;return review;}
    if(fixed&&candidateRelatedRenumbered){const review=crossReviewResult(manuscript.chapters,{confirmed:false}),left='她说先把旧账分清，再谈谁留下。',right='林遥接起电话，说明自己前一天已核过欠款，再把余下三家记到名下。';review.findings=[{groupId:'renumbered-9',status:'confirmed_conflict',summary:'复查仍认为旧账认知与后续承担互相冲突。',sameEventDecision:'same',resolutionReason:'direct_conflict',
      evidence:[{claimId:'renumbered-a',chapterId:'ch-1',quote:left,start:manuscript.chapters[0].body.indexOf(left),role:'support'},{claimId:'renumbered-b',chapterId:'ch-2',quote:right,start:manuscript.chapters[1].body.indexOf(right),role:'support'}],counterchecks:{}}];review.counts.confirmed_conflict=1;return review;}
    return crossReviewResult(manuscript.chapters,{confirmed:!fixed});};
  return{model,reviewCrossChapter,reviewCalls};}

function installFrozenCrossProtocolFailure(target,prefix,manuscript,{code='FORMAT_REPAIR_SEMANTIC_DRIFT',primaryRaw='{"invalid":"primary"}',repairRaw='{"invalid":"repair"}'}={}){
  const stage='whole-quality:cross-chapter:extract',input={schemaVersion:'cross-chapter-extraction-input-1',implementationVersion:'cross-chapter-review-r04',
    modelPolicy:'whole-manuscript-quality-json-1',manuscript:{chapters:structuredClone(manuscript)}};
  const inputHash=stableFingerprint(input),requestSha256=hash(`request:${inputHash}`),primaryResponseSha256=hash(primaryRaw);
  const repairInput={schemaVersion:'cross-chapter-format-repair-1',stage,originalInputHash:inputHash,invalidResponseSha256:primaryResponseSha256,
    errorCode:'EXTRACTION_CONTRACT_VIOLATIONS',error:'frozen invalid response'};
  const repairInputHash=stableFingerprint(repairInput),repairRequestSha256=hash(`repair:${repairInputHash}`),repairResponseSha256=hash(repairRaw);
  Object.assign(target,{
    [`${prefix}${stage}:input`]:{inputHash,requestSha256,input},
    [`${prefix}${stage}:primary-response`]:{stage,inputHash,requestSha256,rawResponse:primaryRaw,responseSha256:primaryResponseSha256},
    [`${prefix}${stage}:repair-input`]:{repairInputHash,repairInput,requestSha256:repairRequestSha256},
    [`${prefix}${stage}:repair-response`]:{stage:`${stage}:format-repair`,inputHash:repairInputHash,requestSha256:repairRequestSha256,
      rawResponse:repairRaw,responseSha256:repairResponseSha256},
  });
  return{code,inputHash,primaryResponseSha256,repairInputHash,repairResponseSha256};
}
function failedCrossError(code){const error=Object.assign(new Error(code),{code});if(code==='FORMAT_REPAIR_FAILED')error.causeCode='EXTRACTION_CONTRACT_VIOLATIONS';return error;}
function prepareCandidateCrossFailure(j,result,code='FORMAT_REPAIR_SEMANTIC_DRIFT'){
  const prefix='whole-quality:cross-chapter:candidate:';
  for(const key of Object.keys(j.artifacts))if(key===`${prefix}bundle`||key.startsWith(`${prefix}artifact:`)||key.startsWith(`${prefix}retry-`)
    ||key.startsWith(`${prefix}protocol-failure:`))delete j.artifacts[key];
  const frozen=installFrozenCrossProtocolFailure(j.artifacts,`${prefix}artifact:`,result.chapters,{code});return{prefix,frozen};
}
function retryingCrossReviewer({sourceChapters,sourceReview,originalFailureCode='FORMAT_REPAIR_SEMANTIC_DRIFT',retryFailureCode}={}){const calls=[];return{calls,reviewer:async({manuscript,model,modelPolicy,artifacts})=>{
  assert.equal(modelPolicy,'whole-manuscript-quality-json-1');const store=artifacts.store;
  if(sourceChapters&&JSON.stringify(manuscript.chapters)===JSON.stringify(sourceChapters))return structuredClone(sourceReview);
  if(store['whole-quality:cross-chapter:result'])return structuredClone(store['whole-quality:cross-chapter:result']);
  if(store['test:successful-review'])return structuredClone(store['test:successful-review']);
  if(store['whole-quality:cross-chapter:extract:repair-response'])throw failedCrossError(store['test:retry-failure-marker']?retryFailureCode:originalFailureCode);
  assert.deepEqual(Object.keys(store),[],'retry-1 must start with an empty independent artifact namespace');
  const first=await model.complete({stage:'test:cross-retry:extract',system:'fresh extraction',user:JSON.stringify({manuscript}),modelPolicy,maxTokens:1});
  const second=await model.complete({stage:'test:cross-retry:adjudicate',system:'fresh adjudication',user:JSON.stringify({manuscript}),modelPolicy,maxTokens:1});
  calls.push(first,second);
  if(retryFailureCode){installFrozenCrossProtocolFailure(store,'',manuscript.chapters,{code:retryFailureCode,primaryRaw:first,repairRaw:second});store['test:retry-failure-marker']=true;
    for(const [key,value]of Object.entries(store))await artifacts.checkpoint(key,value);throw failedCrossError(retryFailureCode);}
  const review=crossReviewResult(manuscript.chapters,{confirmed:false});review.stageReceipts=[
    {stage:'whole-quality:cross-chapter:extract',primaryResponseSha256:hash(first)},
    {stage:'whole-quality:cross-chapter:adjudicate',primaryResponseSha256:hash(second)}];
  await artifacts.checkpoint('test:successful-review',review);return structuredClone(review);
}};}

test('new cross-chapter binding runs even after issues=[], freezes a bounded target, rereads, rechecks, and counts factual stages',async()=>{const j=journal(),fixture=crossAwareFixture();const result=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter,artifacts:j.artifacts,checkpoint:j.checkpoint});
  assert.equal(fixture.reviewCalls.length,2);assert.equal(result.wholeRevision.quality.independentReading.issues.length,0);assert.equal(result.wholeRevision.plan.items[0].issueIds[0],'cross-chapter:fact-1');
  const conflict=result.wholeRevision.quality.crossChapterReview.confirmedConflicts[0],body=chapters[1].body,targetLine='🙂林遥说自己只是回来帮忙，手却停在欠款页上。';
  assert.equal(conflict.scopeOptions.find(item=>item.quote===targetLine)?.start,body.indexOf(targetLine));
  const adjacent=conflict.scopeOptions.find(item=>item.quote.startsWith('第二天电话又响。')&&item.paragraphCount===2);
  assert.equal(adjacent.start,body.indexOf('第二天电话又响。'));assert.equal(adjacent.quote,`第二天电话又响。\n\n${targetLine}`);
  const planCall=fixture.model.calls.find(item=>item.stage==='whole-quality:plan'),frozen=JSON.parse(planCall.user).confirmedConflicts[0];
  assert.deepEqual({hardIssue:frozen.hardIssue,claimType:frozen.claimType,requiredDisposition:frozen.requiredDisposition},{hardIssue:true,claimType:'textual_conflict',requiredDisposition:'revise_or_unresolved'});
  assert.equal(result.wholeRevision.plan.items[0].targets[0].quote.includes('\n'),false);assert.equal(result.wholeRevision.quality.crossChapterResolution.items[0].repairStatus,'resolved_in_candidate');
  assert.equal(conflict.id,'cross-chapter:fact-1');assert.equal(result.wholeRevision.reread.crossChapterChecks[0].conflictId,conflict.id);
  assert.equal(result.wholeRevision.modelCalls.primaryCalls,9);assert.equal(result.wholeRevision.modelCalls.crossChapterPrimaryCalls,4);assert.equal(result.wholeRevision.modelCalls.maxPrimaryCalls,11);
  assert.deepEqual(assertWholeQualityResult(result,j.artifacts.requestSpec),result);
  let modelCalls=0;const resumed=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:{complete(){modelCalls++;throw Error('forbidden');}},modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter,artifacts:j.artifacts,checkpoint:j.checkpoint});
  assert.equal(modelCalls,0);assert.equal(fixture.reviewCalls.length,4);assert.deepEqual(resumed,result);
});

test('confirmed conflict may end no_change only as explicit unresolved and is never counted as repaired',async()=>{const fixture=crossAwareFixture({unresolved:true}),result=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter});
  assert.equal(result.wholeRevision.status,'no_change');assert.equal(result.revisionApplied,false);assert.equal(result.wholeRevision.quality.crossChapterResolution.items[0].repairStatus,'unresolved');
  assert.equal(result.wholeRevision.quality.crossChapterResolution.items[0].hardIssue,true);assert.equal(result.wholeRevision.reread.crossChapterChecks[0].assessment,'not_attempted');
  assert.match(result.wholeRevision.quality.crossChapterResolution.items[0].reason,/说话人边界/);assert(result.warnings.some(item=>item.includes('no_change')));assert.equal(fixture.reviewCalls.length,1);
  assert.equal(result.wholeRevision.modelCalls.primaryCalls,5);assert.equal(result.wholeRevision.modelCalls.crossChapterPrimaryCalls,2);assert.equal(result.wholeRevision.modelCalls.maxPrimaryCalls,9);
});

test('source cross with zero confirmed still runs the two-stage candidate recheck after free-reading changes',async()=>{const base=modelFor(),reviewCalls=[],model={complete:async args=>{const raw=await base.complete(args);
    if(args.stage==='whole-quality:reread'){const value=JSON.parse(raw);value.crossChapterChecks=[];return JSON.stringify(value);}return raw;}};
  const reviewCrossChapter=async ({manuscript,modelPolicy})=>{assert.equal(modelPolicy,'whole-manuscript-quality-json-1');reviewCalls.push(structuredClone(manuscript));return crossReviewResult(manuscript.chapters,{confirmed:false});};
  const result=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model,modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter});
  assert.equal(result.wholeRevision.quality.crossChapterReview.confirmedConflicts.length,0);assert.equal(result.wholeRevision.quality.independentReading.issues[0].priority,'major');
  assert(result.wholeRevision.diff.changedChapterIds.length>0);assert.equal(reviewCalls.length,2);assert.notDeepEqual(reviewCalls[0].chapters,reviewCalls[1].chapters);
  assert.equal(result.wholeRevision.quality.crossChapterRecheck.confirmedConflicts.length,0);assert.equal(result.wholeRevision.quality.crossChapterResolution.confirmedCount,0);
  assert.equal(result.wholeRevision.modelCalls.crossChapterPrimaryCalls,4);assert.equal(result.wholeRevision.modelCalls.primaryCalls,9);assert.equal(result.wholeRevision.modelCalls.maxPrimaryCalls,11);
  assert.deepEqual(assertWholeQualityResult(result,result.wholeRevision.requestSpec),result);
});

test('candidate recheck does not relate a reused local group id when claim and verbatim evidence differ',async()=>{const fixture=crossAwareFixture({candidateUnrelated:true}),result=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter});
  const resolution=result.wholeRevision.quality.crossChapterResolution;
  assert.equal(resolution.items[0].repairStatus,'resolved_in_candidate');assert.deepEqual(resolution.items[0].candidateRelatedFindingIds,[]);
  assert.deepEqual(resolution.candidateConfirmedRisks.map(item=>({findingId:item.findingId,sourceConflictIds:item.sourceConflictIds,sourceRelations:item.sourceRelations})),[{findingId:'fact-1',sourceConflictIds:[],sourceRelations:[]}]);
});

test('candidate recheck relates a renumbered group through shared verbatim fact evidence',async()=>{const fixture=crossAwareFixture({candidateRelatedRenumbered:true}),result=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter});
  const resolution=result.wholeRevision.quality.crossChapterResolution,item=resolution.items[0],risk=resolution.candidateConfirmedRisks[0];
  assert.equal(item.repairStatus,'unresolved');assert.deepEqual(item.candidateRelatedFindingIds,['renumbered-9']);assert.equal(item.candidateRelations[0].matchedBy,'shared_verbatim_evidence');
  assert.deepEqual(risk.sourceConflictIds,['cross-chapter:fact-1']);assert.equal(risk.sourceRelations[0].matchedBy,'shared_verbatim_evidence');assert(risk.sourceRelations[0].evidenceKeys.length>0);
});

test('candidate cross protocol drift gets one fresh namespace, preserves failed raw hashes, and resumes completed work without replaying whole stages',async()=>{
  const j=journal(),fixture=crossAwareFixture(),initial=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,
    modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter,artifacts:j.artifacts,checkpoint:j.checkpoint});
  const {prefix,frozen}=prepareCandidateCrossFailure(j,initial,'FORMAT_REPAIR_SEMANTIC_DRIFT'),sourceReview=j.artifacts['whole-quality:cross-chapter:source:bundle'].review;
  const retry=retryingCrossReviewer({sourceChapters:initial.wholeRevision.sourceChapters,sourceReview});let freshCalls=0;
  const retryModel={complete:async args=>{assert.match(args.stage,/^test:cross-retry:/);assert.doesNotMatch(args.user,new RegExp(frozen.primaryResponseSha256));freshCalls++;return JSON.stringify({fresh:true,stage:args.stage});}};
  const resumed=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:retryModel,modelPolicy:'whole-manuscript-quality-json-1',
    reviewCrossChapter:retry.reviewer,artifacts:j.artifacts,checkpoint:j.checkpoint});
  const bundle=resumed.wholeRevision.quality.crossChapterRecheck,failure=bundle.protocolFailures[0];
  assert.equal(freshCalls,2);assert.equal(retry.calls.length,2);assert.equal(failure.code,'FORMAT_REPAIR_SEMANTIC_DRIFT');
  assert.equal(failure.rawResponseSha256,frozen.primaryResponseSha256);assert.equal(failure.formatRepairResponseSha256,frozen.repairResponseSha256);
  assert.deepEqual(bundle.attempts.map(item=>[item.attempt,item.artifactNamespace,item.status]),[[0,'primary','protocol_failed'],[1,'retry-1','completed']]);
  assert.equal(resumed.wholeRevision.modelCalls.crossChapterPrimaryCalls,5);assert.equal(resumed.wholeRevision.modelCalls.crossChapterFormatRepairCalls,1);
  assert.equal(resumed.wholeRevision.modelCalls.primaryCalls,10);assert.equal(resumed.wholeRevision.modelCalls.formatRepairCalls,1);
  assert.equal(resumed.wholeRevision.modelCalls.maxPrimaryCalls,13);assert.equal(resumed.wholeRevision.modelCalls.maxFormatRepairCalls,13);
  assert.equal(Object.keys(j.artifacts).some(key=>key.startsWith(`${prefix}retry-2:`)),false);
  assert.deepEqual(assertWholeQualityResult(resumed,resumed.wholeRevision.requestSpec),resumed);
  let forbiddenCalls=0;const replay=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:{complete(){forbiddenCalls++;throw Error('forbidden');}},
    modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:retry.reviewer,artifacts:j.artifacts,checkpoint:j.checkpoint});
  assert.equal(forbiddenCalls,0);assert.equal(retry.calls.length,2);assert.deepEqual(replay,resumed);
});

test('a failed retry retains an independently reviewable candidate but never becomes retry-2, a successful check or adoptable result',async()=>{
  const j=journal(),fixture=crossAwareFixture(),initial=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,
    modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter,artifacts:j.artifacts,checkpoint:j.checkpoint});
  const {prefix}=prepareCandidateCrossFailure(j,initial,'FORMAT_REPAIR_FAILED'),sourceReview=j.artifacts['whole-quality:cross-chapter:source:bundle'].review;
  const retry=retryingCrossReviewer({sourceChapters:initial.wholeRevision.sourceChapters,sourceReview,originalFailureCode:'FORMAT_REPAIR_FAILED',retryFailureCode:'FORMAT_REPAIR_SEMANTIC_DRIFT'});
  let freshCalls=0;const retryModel={complete:async args=>{freshCalls++;return JSON.stringify({retryFailed:true,stage:args.stage});}};
  const partial=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:retryModel,modelPolicy:'whole-manuscript-quality-json-1',
    reviewCrossChapter:retry.reviewer,artifacts:j.artifacts,checkpoint:j.checkpoint});
  assert.deepEqual(partial.chapters,initial.chapters);assert.equal(partial.wholeRevision.status,'candidate_ready_cross_check_incomplete');
  assert.equal(partial.qualityCheckStatus,'incomplete');assert.equal(partial.wholeRevision.quality.crossChapterRecheck,undefined);
  assert.equal(partial.wholeRevision.quality.crossChapterRecheckIncomplete.protocolFailures.length,2);
  assert.ok(partial.wholeRevision.adoption.atomicGroups.every(group=>group.recommendation==='not_recommended'));
  assert.equal(partial.wholeRevision.quality.crossChapterResolution.resolvedInCandidateCount,0);
  assert.equal(partial.wholeRevision.modelCalls.crossChapterPrimaryCalls,4);
  assert.equal(partial.wholeRevision.modelCalls.crossChapterFormatRepairCalls,2);
  assert.equal(freshCalls,2);assert.equal(j.artifacts[`${prefix}protocol-failure:0`].code,'FORMAT_REPAIR_FAILED');
  assert.equal(j.artifacts[`${prefix}protocol-failure:1`].code,'FORMAT_REPAIR_SEMANTIC_DRIFT');assert.equal(j.artifacts[`${prefix}bundle`],undefined);
  assert.equal(Object.keys(j.artifacts).some(key=>key.startsWith(`${prefix}retry-2:`)),false);
  let forbiddenCalls=0;const replay=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:{complete(){forbiddenCalls++;throw Error('forbidden');}},
    modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:retry.reviewer,artifacts:j.artifacts,checkpoint:j.checkpoint});
  assert.deepEqual(replay,partial);
  const forged=structuredClone(partial);forged.wholeRevision.quality.crossChapterRecheckIncomplete.sourceManuscriptSha256='a'.repeat(64);
  assert.throws(()=>assertWholeQualityResult(forged,partial.wholeRevision.requestSpec),{code:'WHOLE_QUALITY_CROSS_RECHECK_INCOMPLETE'});
  assert.equal(forbiddenCalls,0);assert.equal(Object.keys(j.artifacts).some(key=>key.startsWith(`${prefix}retry-2:`)),false);
});

test('cross retry refuses a frozen failure whose input no longer binds the candidate manuscript',async()=>{
  const j=journal(),fixture=crossAwareFixture(),initial=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:fixture.model,
    modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:fixture.reviewCrossChapter,artifacts:j.artifacts,checkpoint:j.checkpoint});
  const {prefix}=prepareCandidateCrossFailure(j,initial),sourceReview=j.artifacts['whole-quality:cross-chapter:source:bundle'].review;
  j.artifacts[`${prefix}artifact:whole-quality:cross-chapter:extract:input`].input.manuscript.chapters[0].body+='tampered';
  const retry=retryingCrossReviewer({sourceChapters:initial.wholeRevision.sourceChapters,sourceReview});let calls=0;
  await assert.rejects(runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:{complete(){calls++;throw Error('forbidden');}},
    modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter:retry.reviewer,artifacts:j.artifacts,checkpoint:j.checkpoint}),{code:'WHOLE_QUALITY_CROSS_CHAPTER_RETRY'});
  assert.equal(calls,0);assert.equal(j.artifacts[`${prefix}retry-1:binding`],undefined);
});

test('cross-aware runner replays completed legacy no_change with zero calls and does not upgrade an unfinished legacy checkpoint',async()=>{const complete=journal(),legacyResult=await runWholeManuscriptQualityRevision({request:request(),model:modelFor({preserve:true}),checkpoint:complete.checkpoint});let modelCalls=0,reviewCalls=0;
  const replay=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:{complete(){modelCalls++;throw Error('forbidden');}},modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter(){reviewCalls++;throw Error('forbidden');},artifacts:complete.artifacts,checkpoint:complete.checkpoint});
  assert.deepEqual(replay,legacyResult);assert.equal(modelCalls,0);assert.equal(reviewCalls,0);assert.equal(replay.wholeRevision.requestSpec.crossChapterReview,undefined);
  const partial=journal(),stop=Error('stop-after-legacy-request');await assert.rejects(runWholeManuscriptQualityRevision({request:request(),model:modelFor(),checkpoint:async(k,v)=>{partial.artifacts[k]=structuredClone(v);if(k==='requestSpec')throw stop;}}),error=>error===stop);
  const resumedCalls=[],legacyModel=modelFor(),resumed=await runCrossChapterAwareWholeManuscriptQualityRevision({request:request(),model:{complete(args){resumedCalls.push(args);return legacyModel.complete(args);}},modelPolicy:'whole-manuscript-quality-json-1',reviewCrossChapter(){reviewCalls++;throw Error('forbidden');},artifacts:partial.artifacts,checkpoint:partial.checkpoint});
  const legacyPlanCall=resumedCalls.find(item=>item.stage==='whole-quality:plan'),legacyRereadCall=resumedCalls.find(item=>item.stage==='whole-quality:reread'),legacyPlanInput=JSON.parse(legacyPlanCall.user),legacyRereadInput=JSON.parse(legacyRereadCall.user);
  assert.equal(resumed.wholeRevision.requestSpec.crossChapterReview,undefined);assert.equal(reviewCalls,0);assert.equal(legacyPlanInput.confirmedConflicts,undefined);assert.equal(legacyPlanInput.responseContract.inputBoundary.confirmedConflicts,undefined);
  assert.equal(legacyRereadInput.confirmedConflicts,undefined);assert.equal(legacyRereadInput.responseContract.properties.crossChapterChecks,undefined);assert.doesNotMatch(legacyPlanCall.system,/confirmed_conflict/);assert.doesNotMatch(legacyRereadCall.system,/confirmedConflicts/);
});

test('versioned factual reading admits one-scene conflicting positions but keeps multi-scene standards for effect hypotheses',async()=>{
  const manuscript=[{id:'count',title:'清点',body:'仓门没有再开。\n清点员说：“现在只有两箱。”\n他接着写下：“这次共有三箱。”'}];
  const makeReading=(u,claimType,overlap=false)=>({
    ...u.responseBindings, inputHash:u.inputHash,coverage:{status:'complete',omissions:[]},synopsis:'同一次清点的口头数量与记录冲突。',
    sceneChanges:[{id:'count-scene',chapterId:'count',sequence:1,entryEvidence:ev('count','仓门没有再开。','场景开始'),exitEvidence:ev('count','他接着写下：“这次共有三箱。”','场景结束'),beforeState:'仓门封闭',trigger:'现场清点',action:'口头报告并记录',afterState:'两种数量不一致',cost:'无法确认实数',narrativeFunction:'清点',preservedStrengths:[]}],
    issues:[{...issue(),id:'count-issue',claimType,area:'knowledge_continuity',sceneIds:['count-scene'],observation:'同一清点没有出入而数量互斥。',evidence:[ev('count','清点员说：“现在只有两箱。”','口头两箱'),ev('count',overlap?'现在只有两箱。':'他接着写下：“这次共有三箱。”',overlap?'同一位置子串':'书面三箱')],counterEvidence:[ev('count','仓门没有再开。','没有出入，但仍需排除人物说谎')],preservation:[]}],strengths:[],unresolved:[]});
  for(const variant of [{type:'textual_conflict',ok:true},{type:'reader_effect_hypothesis',ok:false},{type:'textual_conflict',overlap:true,ok:false}]){
    const j=journal();let reviewed=false,modelCalls=0;
    const model={complete:async args=>{modelCalls++;const raw=JSON.parse(args.user),u=raw.originalInput??raw;
      assert.equal(u.responseBindings.schemaVersion,'whole-quality-reading-2');
      assert.equal(u.responseContract.schemaVersion,'whole-quality-reading-response-contract-3');
      return JSON.stringify(makeReading(u,variant.type,variant.overlap));}};
    await assert.rejects(runCrossChapterAwareWholeManuscriptQualityRevision({request:{...request(),chapters:manuscript},model,modelPolicy:'whole-manuscript-quality-json-1',artifacts:j.artifacts,checkpoint:j.checkpoint,
      reviewCrossChapter:async()=>{reviewed=true;throw Object.assign(Error('Reading validated; stop before independent cross model'),{code:'READING_ACCEPTED'});}}),e=>e.code===(variant.ok?'READING_ACCEPTED':'WHOLE_QUALITY_FORMAT_FAILED'));
    assert.equal(reviewed,variant.ok);assert.equal(modelCalls,variant.ok?1:2);
    assert.equal(Boolean(j.artifacts['whole-quality:reading:result']),variant.ok);
  }
});

// Synthetic DATA evidence is used only to exercise host adoption behavior.
const goalSha = value => createHash('sha256').update(value).digest('hex');
const sourceSha = goalSha('frozen source bytes');
const candidateSha = goalSha('candidate');
const packetSha = goalSha('packet');
const reportSha = goalSha('review');
const quote = '她看到票根后，没有立刻原谅，只把旧约定重新抄了一遍。';
const afterQuote = '抄完以后，她仍把空白留给对方自己说明。';
const referenceId = `deepref:source-1:${candidateSha.slice(0,16)}:${reportSha.slice(0,16)}`;

function goalDataResponse(request, results = [goalDataResult()]) {
  const normalizedRequest = { problem: { ...structuredClone(request.problem),
      searchTerms: [...new Set((request.problem.searchTerms ?? []).map(term => String(term).trim()).filter(Boolean))],
      requiredTermGroups: (request.problem.requiredTermGroups ?? []).map(group => [...new Set(group)]) },
    dimensions: structuredClone(request.dimensions), sourceIds: request.sourceIds ?? null, limit: request.limit,
    maxFunctionsPerResult: request.maxFunctionsPerResult, maxEvidenceRefsPerResult: request.maxEvidenceRefsPerResult };
  const installId = 'combined-99-v1-test';
  const queryId = `deepref-query-${goalSha(`${JSON.stringify({ installId, request: normalizedRequest }, null, 2)}\n`)}`;
  return { schemaVersion: 'analysis99-problem-query-2', queryId,
    installId, request: normalizedRequest, status: results.length ? 'covered' : 'uncovered', resultCount: results.length,
    limits: { maxResults: 8 }, boundary: 'retrieval is not use', retrievalIsUse: false,
    requiresExplicitAdoption: true, results };
}

function goalDataResult() {
  return { referenceId, source: { sourceId: 'source-1', sourceSha256: sourceSha, sourceTextSha256: goalSha('text'),
      textVersion: 'text-v1', title: '证据源' },
    analysis: { analysisId: 'analysis-1', analysisVersion: 'deep-v1', candidateSha256: candidateSha,
      packetSha256: packetSha, candidateStatus: 'candidate_unreviewed', approved: false, checked: false, active: false },
    semanticReview: { reportPath: 'reviews/source-1.json', reportSha256: reportSha, verdict: 'retain_with_caveats',
      caveats: ['只是一项证据约束假说'], blockingDefects: [], approvalGranted: false, activeProductionChanged: false },
    match: { matchedTerms: ['选择','代价'], matchedTermCount: 2, requiredMatchedTermCount: 2, lexicalScore: 2,
      semanticSimilarityClaimed: false },
    borrowableWritingFunctions: [{ functionId: 'psychology:before:after', dimension: 'psychologicalChangeDrivers',
      status: 'evidence_bound_hypothesis', observablePattern: '看见物证后先做有限行动',
      borrowableFunction: '用有限选择而不是彻底改口表现心理变化', alternatives: ['也可能只是暂缓冲突'],
      limitation: '不能证明原谅', evidenceIds: ['ev-1','ev-2'], unitIds: ['unit-1','unit-2'] }],
    exactReferences: [{ evidenceId: 'ev-1', unitId: 'unit-1', locator: { lineStart: 7, lineEnd: 7, charStart: 10, charEnd: 38 },
      quoteSha256: goalSha(quote), textVersion: 'text-v1', quote, sourceId: 'source-1', sourceSha256: sourceSha,
      sourceTextSha256: goalSha('text') }, { evidenceId: 'ev-2', unitId: 'unit-2', locator: { lineStart: 9, lineEnd: 9, charStart: 40, charEnd: 61 },
      quoteSha256: goalSha(afterQuote), textVersion: 'text-v1', quote: afterQuote, sourceId: 'source-1', sourceSha256: sourceSha,
      sourceTextSha256: goalSha('text') }],
    limits: { visibility: '只见当前证据窗', statements: ['不可迁入人物与情节'] }, retrievalIsUse: false,
    requiresExplicitAdoption: true };
}

function goalRequest() {
  return { ...request(), writingGoals: { schemaVersion: 'creation-writing-goals-1', goals: [{
    id: 'explicit-responsibility', dimension: 'choice', chapterIds: ['ch-2'],
    problem: { problemId: 'explicit-responsibility', statement: '以有限的具体分工选择表现承担，保留不和解的结尾。',
      searchTerms: ['选择','代价'], requiredTermGroups: [['选择'],['代价']], context: { boundaries: ['不得强迫原谅。'] } },
    preservationBoundaries: ['保留原有关系分歧和克制结尾；不复制来源人物、情节或原句。'],
  }] } };
}

function goalModel({ preserve = false, fit = 'direct_fit', events = [], mutatePlan, missingText = false } = {}) {
  return { complete: async args => {
    events.push(args.stage);
    // Any unexpected format retry must expose the primary error, not conceal it with a valid second fixture.
    if (args.stage.endsWith(':format-repair')) throw Error(JSON.parse(args.user).repairInput.error);
    const u = JSON.parse(args.user), goalIds = u.requestSpec.writingGoals.goals.map(goal => goal.id);
    if (args.stage === 'whole-quality:reading') return readingResponse(u, { preserve: true });
    if (args.stage === 'whole-quality:applicability') {
      assert.deepEqual(u.issues, []);
      const response = JSON.parse(applicabilityResponse(u, { fit }));
      if (fit !== 'direct_fit') response.noSuitableReasons = u.writingGoals.map(goal => ({ issueId: goal.querySubjectId,
        reason: '来源的情节依赖不能迁入当前冻结目标，保留拒用。' }));
      return JSON.stringify(response);
    }
    if (args.stage === 'whole-quality:plan') {
      assert.deepEqual(u.eligibleIssueIds, []); assert.deepEqual(u.reading.issues, []);
      assert.deepEqual(u.eligibleGoalIds, goalIds);
      const response = JSON.parse(planResponse(u, { preserve, oneScene: true }));
      response.goalDispositions = goalIds.map(goalId => ({ goalId, decision: preserve ? 'preserve' : 'attempt',
        planItemIds: preserve ? [] : ['p-1'], reason: preserve ? '原稿已足够；来源不适配，保留目标不强制修改。' : '只尝试可见选择，不要求关系和解。' }));
      if (preserve) response.materialDecisions = u.retrieval.supplies.map(s => ({ supplyId: s.supplyId,
        materialId: s.materialId, issueId: s.issueId, goalId: s.goalId, decision: 'not_used', planItemIds: [], evidenceIds: [],
        reason: '不适用或无安全改法，明确拒用。', applicabilityBoundary: '不复制情节和结局。', limitations: ['检索不是适用或采用证明。'] }));
      else {
        response.items[0].issueIds = []; response.items[0].goalIds = goalIds;
        response.materialDecisions.forEach(d => { d.goalId = u.retrieval.supplies.find(s => s.supplyId === d.supplyId).goalId; });
      }
      mutatePlan?.(response, u); return JSON.stringify(response);
    }
    if (args.stage === 'whole-quality:feasibility') return feasibilityResponse(u);
    if (args.stage === 'whole-quality:revision') return candidateResponse(u);
    if (args.stage === 'whole-quality:reread') {
      const response = JSON.parse(rereadResponse(u, { status: preserve ? 'blocked' : 'applied' }));
      if (u.confirmedConflicts !== undefined) response.crossChapterChecks = [];
      return JSON.stringify(response);
    }
    if (args.stage === 'whole-quality:material-evidence') {
      const response = JSON.parse(finalTextResponse(u));
      if (missingText) for (const entry of response.recordsByIssue) for (const row of entry.records) {
        row.status = 'not_located'; row.findings = []; row.reason = '无法证明该来源功能在最终正文中落实。';
      }
      return JSON.stringify(response);
    }
    throw Error(`unexpected goal stage ${args.stage}`);
  } };
}

test('explicit goal with zero diagnosed issues queries exact DATA problem before planning and binds real final spans', async () => {
  const req = goalRequest(), events = [], j = journal(); let captured, legacyCalls = 0;
  const result = await runWholeManuscriptQualityRevision({ request: req, model: goalModel({ events }), checkpoint: j.checkpoint,
    retrieveKnowledge: async query => { legacyCalls++; return matched(query); },
    queryDeepReferences: async query => { captured = structuredClone(query); events.push('goal-query'); return goalDataResponse(query); } });
  assert.deepEqual(captured.problem, req.writingGoals.goals[0].problem);
  assert.deepEqual(captured.dimensions, WRITING_GOAL_DATA_OPTIONS.dimensions);
  assert.equal(captured.maxFunctionsPerResult, 3); assert.equal(captured.maxEvidenceRefsPerResult, 10); assert.equal(legacyCalls, 1);
  assert(events.indexOf('goal-query') < events.indexOf('whole-quality:applicability'));
  assert(events.indexOf('whole-quality:applicability') < events.indexOf('whole-quality:plan'));
  const q = result.wholeRevision.quality;
  assert.deepEqual(q.independentReading.issues, []); assert.deepEqual(q.retrieval.byIssue, []);
  assert.equal(q.retrieval.byGoal.length, 1); assert.equal(q.retrieval.supplies.length, 2);
  assert(q.retrieval.supplies.every(s => s.origin === 'writing_goal' && s.goalId === req.writingGoals.goals[0].id));
  assert.equal(q.deepReference.candidates.length, 1);
  assert.deepEqual(result.wholeRevision.plan.items[0].issueIds, []);
  assert.deepEqual(result.wholeRevision.plan.items[0].goalIds, ['explicit-responsibility']);
  assert.equal(q.writingGoals.goals[0].disposition.decision, 'attempt');
  for (const material of q.writingGoals.goals[0].materials) {
    assert.equal(material.status, 'used_exact_text_located');
    assert(material.manuscriptEvidence.length > 0);
    for (const evidence of material.manuscriptEvidence) {
      const chapter = result.chapters.find(ch => ch.id === evidence.chapterId);
      assert.equal(chapter.body.slice(evidence.start, evidence.start + evidence.quote.length), evidence.quote);
    }
  }
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
  let forbiddenCalls = 0;
  const forbidden = () => { forbiddenCalls++; throw Error('resume must not call or write'); };
  const replay = await runWholeManuscriptQualityRevision({ request: req, model: { complete: forbidden }, retrieveKnowledge: forbidden,
    queryDeepReferences: forbidden, artifacts: j.artifacts, checkpoint: forbidden });
  assert.equal(JSON.stringify(replay), JSON.stringify(result)); assert.equal(forbiddenCalls, 0);
  const handoff = buildIndependentReviewRequest({ caseId: 'goal-bound-handoff', request: req, result });
  assert.equal(handoff.request.goals[0].claimType, 'editorial_hypothesis');
  assert.equal(handoff.provenance.writingGoalsSha256, stableFingerprint(req.writingGoals));
  assert(handoff.request.goals[0].sourceEvidence.length > 0);
  assert.equal(Object.hasOwn(handoff.request, 'writingGoals'), false);
});

test('explicit goals may decline every real supply and preserve with zero fabricated diagnoses or final-text claims', async () => {
  const events = [], result = await runWholeManuscriptQualityRevision({ request: goalRequest(), model: goalModel({ preserve: true, fit: 'inapplicable', events }),
    queryDeepReferences: async query => goalDataResponse(query) });
  assert.equal(result.wholeRevision.status, 'no_change'); assert.deepEqual(result.chapters, chapters);
  assert.deepEqual(result.wholeRevision.quality.independentReading.issues, []);
  assert(events.includes('whole-quality:plan')); assert(!events.includes('whole-quality:revision'));
  const goal = result.wholeRevision.quality.writingGoals.goals[0];
  assert.equal(goal.disposition.decision, 'preserve'); assert.equal(goal.materials[0].fit, 'inapplicable');
  assert.equal(goal.materials[0].status, 'unused'); assert.deepEqual(goal.materials[0].manuscriptEvidence, []);
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
});

test('uncovered and unavailable goal queries remain distinct and still allow a preserve plan', async () => {
  for (const unavailable of [false, true]) {
    const result = await runWholeManuscriptQualityRevision({ request: goalRequest(), model: goalModel({ preserve: true }),
      queryDeepReferences: async query => { if (unavailable) throw Error('offline'); return goalDataResponse(query, []); } });
    const q = result.wholeRevision.quality;
    assert.equal(q.retrieval.byGoal[0].status, unavailable ? 'unavailable' : 'uncovered');
    assert.equal(q.writingGoals.goals[0].queryStatus, unavailable ? 'unavailable' : 'uncovered');
    assert.deepEqual(q.writingGoals.goals[0].materials, []);
    assert.equal(result.wholeRevision.planProvenance.producer, 'model');
    assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
  }
});

test('a goal used declaration without final manuscript evidence remains not_proven', async () => {
  const result = await runWholeManuscriptQualityRevision({ request: goalRequest(), model: goalModel({ missingText: true }),
    queryDeepReferences: async query => goalDataResponse(query) });
  const material = result.wholeRevision.quality.writingGoals.goals[0].materials[0];
  assert.equal(material.decision, 'used'); assert.equal(material.status, 'not_proven');
  assert.deepEqual(material.manuscriptEvidence, []);
});

test('goals reject invalid requests and require the deep callback before any stage is invoked', async () => {
  let calls = 0; const forbidden = () => { calls++; throw Error('not allowed'); };
  await assert.rejects(runWholeManuscriptQualityRevision({ request: goalRequest(), model: { complete: forbidden } }), { code: 'WRITING_GOALS_CALLBACK_REQUIRED' });
  for (const mutate of [v => { v.goals = []; }, v => { v.goals[0].id = 'mismatch'; },
    v => { v.goals[0].problem.requiredTermGroups = [['not-frozen']]; }, v => { v.goals[0].chapterIds = ['unknown']; },
    v => { v.goals.push(structuredClone(v.goals[0])); }, v => { v.extra = true; }, v => { v.goals[0].preservationBoundaries = []; }]) {
    const req = goalRequest(); mutate(req.writingGoals);
    assert.throws(() => validateWritingGoals(req.writingGoals, req.chapters), { code: 'WRITING_GOALS_REQUEST' });
    await assert.rejects(runWholeManuscriptQualityRevision({ request: req, model: { complete: forbidden }, queryDeepReferences: forbidden }), { code: 'WRITING_GOALS_REQUEST' });
  }
  assert.equal(calls, 0);
});

test('goals cannot authorize mechanism-only supply, unknown goals, false diagnoses, outside-chapter targets, or incomplete dispositions', async () => {
  await assert.rejects(runWholeManuscriptQualityRevision({ request: goalRequest(), model: goalModel({ fit: 'mechanism_only' }),
    queryDeepReferences: async query => goalDataResponse(query) }), /只有功能适用层/);
  for (const mutatePlan of [p => { p.items[0].goalIds = ['unknown']; }, p => { p.items[0].issueIds = ['invented-diagnosis']; },
    p => { p.items[0].goalIds = []; }, p => { p.goalDispositions = []; },
    p => { p.materialDecisions[0].goalId = 'unknown'; }]) {
    await assert.rejects(runWholeManuscriptQualityRevision({ request: goalRequest(), model: goalModel({ mutatePlan }),
      queryDeepReferences: async query => goalDataResponse(query) }));
  }
  const req = goalRequest(); req.writingGoals.goals[0].chapterIds = ['ch-1'];
  await assert.rejects(runWholeManuscriptQualityRevision({ request: req, model: goalModel(),
    queryDeepReferences: async query => goalDataResponse(query) }), /写作目标.*范围/);
});

test('goal policy/source binding rejects changed or removed goals on resume and handoff, and report/span tampering', async () => {
  const req = goalRequest(), j = journal(), result = await runWholeManuscriptQualityRevision({ request: req,
    model: goalModel(), queryDeepReferences: async query => goalDataResponse(query), checkpoint: j.checkpoint });
  let calls = 0; const forbidden = () => { calls++; throw Error('no calls'); };
  for (const mutate of [r => { delete r.writingGoals; }, r => { r.writingGoals.goals[0].problem.statement += '改变目标'; },
    r => { r.writingGoals.goals[0].preservationBoundaries[0] += '新边界'; }, r => { r.writingGoals.goals[0].chapterIds = []; }]) {
    const altered = structuredClone(req); mutate(altered);
    await assert.rejects(runWholeManuscriptQualityRevision({ request: altered, model: { complete: forbidden },
      queryDeepReferences: forbidden, artifacts: j.artifacts, checkpoint: forbidden }), { code: 'WHOLE_QUALITY_CHECKPOINT_MISMATCH' });
    assert.throws(() => buildIndependentReviewRequest({ caseId: 'goal-tamper', request: altered, result }), { code: 'HANDOFF_REQUEST_BINDING' });
  }
  for (const mutate of [r => { r.wholeRevision.quality.writingGoals.goals[0].disposition.reason += 'post-hoc'; },
    r => { r.wholeRevision.quality.writingGoals.goals[0].materials[0].manuscriptEvidence[0].quote = '改写引文'; },
    r => { r.wholeRevision.quality.retrieval.byGoal[0].goalId = 'changed'; },
    r => { r.wholeRevision.quality.retrieval.byGoal[0].result.packet.deepReference.dataRequest.problem.statement += 'changed'; },
    r => { r.wholeRevision.quality.retrieval.byGoal[0].result.packet.deepReference.response.request.limit = 1; },
    r => { r.wholeRevision.quality.retrieval.byGoal[0].result.packet.deepReference.functionSelection.selections[0].selectedFunctionIds = ['forged']; },
    r => { r.wholeRevision.requestSpec.writingGoals.goals[0].dimension = 'emotion'; }]) {
    const altered = structuredClone(result); mutate(altered);
    assert.throws(() => assertWholeQualityResult(altered, result.wholeRevision.requestSpec));
  }
  assert.equal(calls, 0);
});

test('goal-driven revision through the production cross-aware entry keeps source and candidate factual review separate', async () => {
  const phases = [], result = await runCrossChapterAwareWholeManuscriptQualityRevision({ request: goalRequest(),
    model: goalModel(), modelPolicy: 'whole-manuscript-quality-json-1', queryDeepReferences: async query => goalDataResponse(query),
    reviewCrossChapter: async ({ manuscript }) => { phases.push(manuscript.chapters); return crossReviewResult(manuscript.chapters, { confirmed: false }); } });
  assert.equal(phases.length, 2); assert.deepEqual(phases[0], chapters); assert.deepEqual(phases[1], result.chapters);
  assert.equal(result.wholeRevision.quality.writingGoals.goals[0].deepMaterialOutcome, 'used_exact_text_located');
  assert.deepEqual(result.wholeRevision.quality.independentReading.issues, []);
  assert.deepEqual(assertWholeQualityResult(result, result.wholeRevision.requestSpec), result);
  const handoff = buildIndependentReviewRequest({ caseId: 'goal-production-entry', request: goalRequest(), result });
  assert.equal(handoff.provenance.requestBindingMode, 'runtime_normalized_cross_binding');
});
