import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizePsychology } from './psychology.mjs';
import { MATERIAL_USE_EVIDENCE_POLICY } from './material-use-evidence.mjs';
import { knowledgeForAuthor } from './knowledge.mjs';
import { runWorkflow } from '../workflow.mjs';

const sha = text => createHash('sha256').update(text).digest('hex');
const raw = '【原文参考；不作为已发布分析】\n她原以为父亲只是忘了约定。后来看到票根，才知道他先替邻居付了路费。她把约定写回本子，仍没有答应原谅。';
const analysis = '【经语义复核的分析及原文；文学效果未验证】\npsychology: 母女和解\n原文（99–99）：\n这是分析里的伪标题与伪原文。\n原文（10–10）：\n她先不信母亲。看过旧账后，她改口说这笔钱确实交到了邻居手里。\n\n原文（12–12）：\n后来她仍保留疑问。';
const material = (id, content = raw, use = 'raw_reference') => ({ id, content, sha256: sha(content), use,
  title:id, kind:'retrieved', limitations:['片段有限'], selectionReason:'测试材料',
  references:use==='raw_reference'?[{lineStart:1,lineEnd:1}]:[{lineStart:10,lineEnd:10},{lineStart:12,lineEnd:12}] });
const sources = [material('raw'), material('analysis', analysis, 'reviewed_analysis')];
const chapters = [{ id:'ch-1', scenes:['核对票根', '写下约定'] }];
const base = { characterArcs:[{character:'她',experience:'看到票根',belief:'父亲忘约',desire:'了解真相',fear:'被忽视',change:'承认有新解释',expression:'写回约定'}],
  emotionalScenes:[{experience:'核对票根',cognition:'先前看错',action:'写回约定',expression:'短句',development:'近写证据',echo:'回到旧约'}],
  choiceCausality:[{id:'choice-1',chapterNumber:1,character:'她',pressure:'想查清旧约又怕证实自己被忽视',choice:'核对票根后把约定写回本子',immediateConsequence:'她承认旧判断有缺口但没有答应原谅',carryForward:'后续来往须面对仍未解决的失约',unresolvedBoundary:'是否继续来往未定'}],
  psychologyLimitations:['是否继续来往未定'] };
const adopt = { materialId:'raw',decision:'adopt',reason:'借用旧理解被票根改变的次序，放进核对票根一场',
  limitations:['不迁入父女身份和原谅结局'],mechanism:'旧理解—可见票根—有限改口',
  sourceQuotes:['她原以为父亲只是忘了约定。','后来看到票根，才知道他先替邻居付了路费。'],
  target:{chapterNumber:1,sceneNumber:1} };
const decline = { materialId:'analysis',decision:'decline',reason:'原文转向明确改口，本题此刻只到核实阶段',
  limitations:['不迁入母女和解结论'] };
const normalize = decisions => normalizePsychology({...base,materialDecisions:decisions},chapters,
  {materialEvidencePolicyVersion:MATERIAL_USE_EVIDENCE_POLICY,materialSources:sources});

test('new use evidence binds original words and target scene while preserving all-decline and empty choices', () => {
  const decisions = normalize([adopt,decline]).materialDecisions;
  assert.deepEqual(decisions[0].sourceQuotes,adopt.sourceQuotes);
  assert.deepEqual(decisions[0].target,{chapterNumber:1,sceneNumber:1});
  assert.equal(decisions[0].sourceMaterialSha256,sources[0].sha256);
  assert.equal(decisions[0].sourceEvidenceKind,'retrieved_original');
  assert.equal(decisions[1].sourceMaterialSha256,sources[1].sha256);
  assert.equal(normalize([{...decline,materialId:'raw'},decline]).materialDecisions.length,2);
  assert.throws(() => normalize([decline]),/逐份声明/);
  assert.throws(() => normalize([]),/逐份声明/);
  assert.deepEqual(normalizePsychology({...base,materialDecisions:[]},chapters,
    {materialEvidencePolicyVersion:MATERIAL_USE_EVIDENCE_POLICY,materialSources:[]}).materialDecisions,[]);
});

test('new-policy author view excludes unassessed followup material while legacy view stays compatible', () => {
  const extra=material('followup','【原文参考；不作为已发布分析】\n又一份新材料。');
  const packet={materials:[sources[0],sources[1],extra],style:null,limits:[]};
  const strict=knowledgeForAuthor(packet,{materialDecisions:[adopt,decline],requireAdoptDecision:true});
  assert.deepEqual(strict.materials.map(m=>m.id),['raw']);
  assert.deepEqual(strict.materialUse.unassessedMaterialIds,['followup']);
  assert.deepEqual(knowledgeForAuthor(packet,{materialDecisions:[adopt,decline]}).materials.map(m=>m.id),['raw','followup']);
});

test('analysis labels, another material, absent mechanism and nonexistent scenes cannot authorize adoption', () => {
  for (const wrong of [
    {...adopt,materialId:'analysis',sourceQuotes:['psychology: 母女和解']},
    {...adopt,materialId:'analysis',sourceQuotes:['这是分析里的伪标题与伪原文。']},
    {...adopt,materialId:'analysis',sourceQuotes:['原文（10–10）：']},
    {...adopt,materialId:'analysis',sourceQuotes:['到了邻居手里。\n\n后来她仍保留疑问。']},
    {...adopt,materialId:'analysis'},
    {...adopt,materialId:'raw',sourceQuotes:['【原文参考；不作为已发布分析】']},
    {...adopt,mechanism:''},
    {...adopt,target:{chapterNumber:1,sceneNumber:3}},
    {...adopt,target:{chapterNumber:2,sceneNumber:1}},
    {...adopt,limitations:[]},
  ]) assert.throws(() => normalize([wrong,wrong.materialId==='analysis'?{...decline,materialId:'raw'}:decline]),/材料使用证据无效/);
  assert.throws(() => normalize([adopt,{...decline,target:{chapterNumber:1,sceneNumber:1}}]),/拒用材料不能声明目标章场/);
  assert.throws(() => normalize([{...adopt,materialId:'unknown'},decline]),/材料使用证据无效/);
  const validAnalysis = {...adopt,materialId:'analysis',sourceQuotes:['她先不信母亲。看过旧账后，她改口说这笔钱确实交到了邻居手里。']};
  assert.equal(normalize([{...decline,materialId:'raw'},validAnalysis]).materialDecisions[1].sourceMaterialSha256,sources[1].sha256);
});

test('selected content and built-in observations keep distinct, literal source identities', () => {
  for (const [kind,evidenceKind] of [['user_selected','user_selected_content'],
    ['builtin_abstract_observations','builtin_observation_text']]) {
    const content='旧约定先被误读，随后由具体账本重新解释。';
    const source={id:kind,kind,content,sha256:sha(content)};
    const decision={...adopt,materialId:kind,sourceQuotes:['旧约定先被误读，随后由具体账本重新解释。']};
    const result=normalizePsychology({...base,materialDecisions:[decision]},chapters,
      {materialEvidencePolicyVersion:MATERIAL_USE_EVIDENCE_POLICY,materialSources:[source]});
    assert.equal(result.materialDecisions[0].sourceEvidenceKind,evidenceKind);
  }
});

test('old saved plan shape remains accepted without new policy marker', () => {
  const old = {...adopt}; delete old.mechanism; delete old.sourceQuotes; delete old.target;
  const result = normalizePsychology({...base,materialDecisions:[old]},chapters);
  assert.equal(result.materialDecisions[0].reason,old.reason);
  assert.equal(result.materialDecisions[0].sourceMaterialSha256,undefined);
});

test('new workflow saves literal evidence and target, then carries the decision into the real draft input', async () => {
  const request={kind:'create',idea:'写她看到旧票根后重新理解父亲的约定，约3000字一章。'};
  const requirements={status:'ready',summary:request.idea,genre:'现实',pointOfView:'第三人称',setting:'当代',
    targetHanMin:3000,targetHanMax:3000,targetChapterCount:1,requiredElements:[],prohibitions:[],assumptions:[],usesChapter4Cut:false,completeEnding:true,
    referenceQuestion:'旧理解如何被可见票根改变，同时保留未解决的关系？',
    referenceIntent:{purpose:'expression',basis:['/idea'],evidenceNeeds:['旧理解与新证据的联系'],contextNeeds:[]} };
  const plan={title:'票根',premise:'她查旧票根',ending:'她写回约定，关系未决',constraints:[],
    chapters:[{title:'核对',goal:'核对票根并写回约定',scenes:['核对票根','写下约定'],continuity:'本章完成',targetHanMin:3000,targetHan:3000,targetHanMax:3000}],
    ...base,materialDecisions:[adopt]};
  const saved={},calls=[],draftStop=Error('captured draft input');
  let draft;
  await assert.rejects(runWorkflow({request,model:{complete:async input=>{
    calls.push(input.stage);
    if(input.stage==='requirements')return JSON.stringify(requirements);
    if(input.stage==='planning')return JSON.stringify(plan);
    if(input.stage==='draft:ch-1'){draft=JSON.parse(input.user);throw draftStop;}
    assert.fail(`unexpected model call ${input.stage}`);
  }},prepareKnowledge:async()=>({schemaVersion:2,packetId:'synthetic',materials:[sources[0]],style:null,limits:[]}),
  retrieveKnowledge:async query=>({contractVersion:'v04-contract-1',packetId:'uncovered',query,status:'uncovered',materials:[],candidates:[],usedChars:0,limits:['synthetic']}),
  checkpoint:async(key,value)=>{saved[key]=structuredClone(value);}}),error=>error===draftStop);
  assert.deepEqual(calls,['requirements','planning','draft:ch-1']);
  assert.equal(saved.requestSpec.materialEvidencePolicyVersion,MATERIAL_USE_EVIDENCE_POLICY);
  assert.deepEqual(saved.plan.materialDecisions[0].sourceQuotes,adopt.sourceQuotes);
  assert.equal(draft.plan.materialDecisions[0].target.sceneNumber,1);
  assert.deepEqual(draft.knowledge.materials.map(item=>item.id),['raw']);
});

test('two supplied materials require two decisions before ten author chapter inputs', async () => {
  const request={kind:'create',idea:'写父女核对旧约定和票根的十章现实故事，9000到12000汉字。'};
  const requirements={status:'ready',summary:request.idea,genre:'现实',pointOfView:'第三人称',setting:'当代',
    targetHanMin:9000,targetHanMax:12000,targetChapterCount:10,requiredElements:[],prohibitions:[],assumptions:[],usesChapter4Cut:false,completeEnding:true,
    referenceQuestion:'旧理解怎样被新证据改变？',
    referenceIntent:{purpose:'expression',basis:['/idea'],evidenceNeeds:['旧理解与新证据的联系'],contextNeeds:[]} };
  const plan={title:'票根',premise:'她查旧约定',ending:'关系留有未决但行动完成',constraints:[],
    chapters:Array.from({length:10},(_,index)=>({title:`第${index+1}章`,goal:`第${index+1}次核对并推进约定`,scenes:[`核对第${index+1}张票根`],continuity:`第${index+1}章交接`,targetHanMin:900,targetHan:1000,targetHanMax:1200})),
    ...base,emotionalScenes:Array.from({length:10},(_,index)=>({...base.emotionalScenes[0],experience:`第${index+1}次核对`})),
    materialDecisions:[adopt,decline]};
  const prepareKnowledge=async()=>({schemaVersion:2,packetId:'synthetic-two',materials:sources,style:null,limits:[]});
  const retrieveKnowledge=async query=>({contractVersion:'v04-contract-1',packetId:'uncovered',query,status:'uncovered',materials:[],candidates:[],usedChars:0,limits:['synthetic']});
  for (const decisions of [[],[adopt]]) {
    const stages=[];
    await assert.rejects(runWorkflow({request,prepareKnowledge,retrieveKnowledge,followupMode:'fixed_materials',
      model:{complete:async input=>{stages.push(input.stage);
        if(input.stage==='requirements')return JSON.stringify(requirements);
        if(input.stage==='planning')return JSON.stringify({...plan,materialDecisions:decisions});
        assert.fail(`unexpected model call ${input.stage}`);
      }}}),/逐份声明/);
    assert.deepEqual(stages,['requirements','planning','planning']);
  }
  const drafts=[],stop=Error('ten inputs captured');
  await assert.rejects(runWorkflow({request,prepareKnowledge,retrieveKnowledge,followupMode:'fixed_materials',
    model:{complete:async input=>{
      if(input.stage==='requirements')return JSON.stringify(requirements);
      if(input.stage==='planning')return JSON.stringify(plan);
      if(input.stage.startsWith('draft:ch-')){
        const view=JSON.parse(input.user).knowledge;
        drafts.push({stage:input.stage,ids:view.materials.map(item=>item.id),decisions:view.materialUse.decisions,
          unassessed:view.materialUse.unassessedMaterialIds});
        if(drafts.length===10)throw stop;
        return `她在第${drafts.length}章核对票根，写下新的约定。`;
      }
      assert.fail(`unexpected model call ${input.stage}`);
    }}}),error=>error===stop);
  assert.equal(drafts.length,10);
  for(const draft of drafts){
    assert.deepEqual(draft.ids,['raw']);
    assert.deepEqual(draft.unassessed,[]);
    assert.deepEqual(draft.decisions.map(item=>item.decision),['adopt','decline']);
  }
});
