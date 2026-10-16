// Synthetic public protocol fixtures; not excerpts from a manuscript corpus.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { runWholeManuscriptQualityRevision, assertWholeQualityResult, createWholeQualityRequestSpec,
  createWholeQualityDraftGuidance, inspectStoredWholeQualityReadingFailure } from './whole-manuscript-quality.mjs';

const chapters = [
  { id: 'ch-1', title: '旧账', body: '周青把零件簿推回柜台。\n她说先把旧账分清，再谈谁留下。' },
  { id: 'ch-2', title: '分工', body: '第二天电话又响。\n林遥说自己只是回来帮忙，手却停在欠款页上。' },
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
  const base=modelFor(),contracts=new Map();let readingContract,repairChecked=false,planEligible;
  const model={complete:async args=>{const envelope=JSON.parse(args.user),repair=args.stage.endsWith(':format-repair'),input=repair?envelope.originalInput:envelope,stage=args.stage.replace(':format-repair','');
    assert.equal(input.responseContract.additionalProperties,false);assert.equal(input.responseContract.binding.type,'host_binding');assert(input.responseContract.properties);
    if(repair){assert.deepEqual(input.responseContract,readingContract);assert.match(args.system,/responseContract.*完整且权威/);repairChecked=true;}
    else {contracts.set(stage,input.responseContract);if(stage==='whole-quality:reading')readingContract=input.responseContract;if(stage==='whole-quality:plan')planEligible=input.eligibleIssueIds;}
    if(args.stage==='whole-quality:reading')return '{}';return base.complete(args);}};
  await runWholeManuscriptQualityRevision({request:request(),model,retrieveKnowledge:uncovered});
  assert.equal(repairChecked,true);assert.deepEqual([...contracts.keys()],['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:revision','whole-quality:reread']);

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
  assert.deepEqual(model.calls.map(c=>c.stage),['whole-quality:reading','whole-quality:plan','whole-quality:feasibility','whole-quality:feasibility:format-repair']);});

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
