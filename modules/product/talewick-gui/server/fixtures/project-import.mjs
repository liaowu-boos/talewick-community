// Synthetic manuscript/response fixtures, adapted from creation's validated whole-quality tests.
// They run only in tests/local smoke; no provider or live story is used.
import { runWholeManuscriptQualityRevision } from '../../../../creation/runtime/whole-manuscript-quality.mjs';
import { productManuscriptRevision } from '../full15-service.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const chapters = [
  { id: 'ch-1', title: '旧账', body: '林岚把尺寸簿推回柜台。\n她说先把旧账分清，再谈谁留下。' },
  { id: 'ch-2', title: '分工', body: '\n\n前序😀\r\n\r\n第二天电话又响。\n\n🙂林遥说自己只是回来帮忙，手却停在欠款页上。' },
  { id: 'ch-3', title: '清单', body: '林岚把未完的清单递过去。\n林遥接过，没有说原谅。' },
];
const request = () => ({ kind: 'revise', revisionMode: 'whole-manuscript-v2', projectTitle: '尺寸簿', instruction: '独立阅读，修复主要场景问题并保留克制结尾。', baseRevision: 'base-1', chapters: structuredClone(chapters) });
const binding = (user, key) => user.responseBindings[key];
const ev = (chapterId, quote, purpose) => ({ chapterId, quote, purpose });

function scenes() { return [
  { id: 's-1', chapterId: 'ch-1', sequence: 1, entryEvidence: ev('ch-1','林岚把尺寸簿推回柜台。','场景进入'), exitEvidence: ev('ch-1','她说先把旧账分清，再谈谁留下。','场景退出'), beforeState: '姐妹仍在争执旧账', trigger: '尺寸簿被推回', action: '林岚要求先分清旧账', afterState: '去留被推迟', cost: '分工仍未改变', narrativeFunction: '建立未解决关系', preservedStrengths: [] },
  { id: 's-2', chapterId: 'ch-2', sequence: 1, entryEvidence: ev('ch-2','第二天电话又响。','场景进入'), exitEvidence: ev('ch-2','林遥说自己只是回来帮忙，手却停在欠款页上。','场景退出'), beforeState: '林遥仍称临时帮忙', trigger: '电话再次响起', action: '她只停在欠款页上', afterState: '承担没有变成行动', cost: '姐姐继续接电话', narrativeFunction: '重复未落实', preservedStrengths: [] },
  { id: 's-3', chapterId: 'ch-3', sequence: 1, entryEvidence: ev('ch-3','林岚把未完的清单递过去。','场景进入'), exitEvidence: ev('ch-3','林遥接过，没有说原谅。','场景退出'), beforeState: '清单未交接', trigger: '林岚递出清单', action: '林遥接过', afterState: '形成有限合作', cost: '没有和解', narrativeFunction: '克制收束', preservedStrengths: [ev('ch-3','林遥接过，没有说原谅。','保留有限合作')] },
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

export async function createProjectImportFixture({ projectId = 'saved-import-source', preserve = false } = {}) {
  const sourceRequest = { ...request(), projectId, requestId: 'fixture-whole-request', idea: '离线合成测试',
    context: {character:'',world:'',plot:'',theme:''}, materials: [], style: null, quote: '' };
  sourceRequest.baseRevision = productManuscriptRevision(sourceRequest.projectTitle, sourceRequest.chapters);
  const saved = journal(), syntheticModel = modelFor({preserve});
  const result = await runWholeManuscriptQualityRevision({request:sourceRequest,model:syntheticModel,checkpoint:saved.checkpoint});
  const task = {id:'77777777-7777-4777-8777-777777777777',projectId,requestId:sourceRequest.requestId,
    kind:'revise',revisionMode:'whole-manuscript-v2',status:'completed',stage:'completed',
    createdAt:'2026-10-23T02:00:00Z',updatedAt:'2026-10-23T02:00:00Z',baseRevision:sourceRequest.baseRevision,
    engine:'fixed',engineVersion:'fixed-workflow-1',result};
  const failed = {id:'88888888-8888-4888-8888-888888888888',projectId,requestId:'fixture-failed-create',
    kind:'create',status:'failed',stage:'review',createdAt:'2026-10-23T01:00:00Z',updatedAt:'2026-10-23T01:00:00Z',
    baseRevision:'initial-create',engine:'fixed',engineVersion:'fixed-workflow-1',error:'合成审阅失败，保留原任务。'};
  return {request:sourceRequest,task,failed,artifacts:saved.artifacts,syntheticCompletions:syntheticModel.calls.length};
}
export function installProjectImportFixture(tasks, fixture, {includeFailedCreate=true}={}) {
  tasks.tasks.set(fixture.task.id, structuredClone(fixture.task));
  tasks.requests.set(fixture.task.id, structuredClone(fixture.request));
  tasks.artifacts.set(fixture.task.id, structuredClone(fixture.artifacts));
  if (includeFailedCreate) tasks.tasks.set(fixture.failed.id, structuredClone(fixture.failed));
}

export async function saveProjectImportFixture(runsDir, fixture, {includeFailedCreate=true}={}) {
  const failedRequest = {...fixture.request,requestId:fixture.failed.requestId,kind:'create',chapters:[],baseRevision:fixture.failed.baseRevision};
  delete failedRequest.revisionMode;
  const records = [[fixture.task, fixture.request, fixture.artifacts], ...(includeFailedCreate ? [[fixture.failed, failedRequest, {}]] : [])];
  for (const [task, request, artifacts] of records) {
    const folder = path.join(runsDir, task.id); await mkdir(folder, {recursive:true});
    for (const [file, value] of [['task.json',task],['request.json',request],['artifacts.json',artifacts]])
      await writeFile(path.join(folder,file), JSON.stringify(value), {flag:'wx'});
  }
}
