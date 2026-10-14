import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  createPlanningFollowupDecisionInput,
  createPlanningFollowupDecisionStart,
  validatePlanningFollowupDecisionStart,
  createPlanningFollowupResponseReceipt,
  validatePlanningFollowupResponseReceipt,
  createPlanningFollowupDecisionCommit,
  validatePlanningFollowupDecisionCommit,
} from './planning-followup-decisions.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const snapshotHash='a'.repeat(64);
const content='【原文参考；不作为已发布分析】\n他把借来的旧钟交还给老人。';
const material={id:'new-2',title:'测试来源',kind:'retrieved',use:'raw_reference',content,sha256:sha(content),
 references:[{sourceId:'s',sourceSha256:sha('source'),textVersion:'t1',analysisVersion:'a1',unitIds:[],lineStart:2,lineEnd:2}],
 selectionReason:'测试',limitations:['只供合同测试']};
const plan={title:'钟',premise:'归还旧钟',ending:'完成归还',constraints:[],lengthPolicyVersion:'chapter-budget-v1',
 chapters:[{id:'ch-1',title:'第一章',goal:'决定归还',continuity:'旧钟尚在',targetHan:500,targetHanMin:400,targetHanMax:600,scenes:[{goal:'作出决定'}]}],
 creationPolicyVersion:'v04-creation-1',characterArcs:[{character:'甲'}],emotionalScenes:[{chapterId:'ch-1'}],psychologyLimitations:[],
 materialDecisions:[{materialId:'old-1',decision:'decline',reason:'无关',limitations:['不使用'],status:'author_declared_not_text_verified',sourceMaterialSha256:'b'.repeat(64)}]};
const knowledge={materials:[material]};
const makeInput=()=>createPlanningFollowupDecisionInput({plan,knowledge,activeSnapshotHash:snapshotHash,addedMaterialIds:['new-2']});
const adopt={materialDecisions:[{materialId:'new-2',decision:'adopt',reason:'可服务既定场景',limitations:['不迁移人物身份'],
 mechanism:'用归还动作兑现承诺',sourceQuotes:['他把借来的旧钟交还给老人。'],target:{chapterNumber:1,sceneNumber:1}}]};

test('bounded commit appends a normalized decision while every existing plan field stays fixed',()=>{
 const input=makeInput(),receipt=createPlanningFollowupResponseReceipt(input,JSON.stringify(adopt));
 const args={input,responseReceipt:receipt,output:adopt,normalizePlan:value=>structuredClone(value)};
 const commit=createPlanningFollowupDecisionCommit(args);validatePlanningFollowupDecisionCommit(commit,args);
 assert.deepEqual(commit.addedMaterialIds,['new-2']);assert.deepEqual(commit.plan.materialDecisions[0],plan.materialDecisions[0]);
 assert.equal(commit.materialDecisions[0].sourceMaterialSha256,material.sha256);assert.equal(commit.materialDecisions[0].sourceEvidenceKind,'retrieved_original');
});

test('decline uses the same exact-id patch and cannot carry adopt fields',()=>{
 const input=makeInput(),output={materialDecisions:[{materialId:'new-2',decision:'decline',reason:'没有安全对应',limitations:['不迁移物件']} ]};
 const receipt=createPlanningFollowupResponseReceipt(input,JSON.stringify(output));
 assert.equal(createPlanningFollowupDecisionCommit({input,responseReceipt:receipt,output,normalizePlan:value=>structuredClone(value)}).materialDecisions[0].decision,'decline');
 assert.throws(()=>createPlanningFollowupDecisionCommit({input,responseReceipt:receipt,output:{materialDecisions:[{...output.materialDecisions[0],mechanism:'越界'}]},normalizePlan:value=>value}),/字段越界/);
});

test('old ids, fabricated quotes, replanning, and receipt tampering fail closed',()=>{
 const input=makeInput(),receipt=createPlanningFollowupResponseReceipt(input,JSON.stringify(adopt));
 const start=createPlanningFollowupDecisionStart(input);validatePlanningFollowupDecisionStart(start,input);
 assert.throws(()=>createPlanningFollowupDecisionCommit({input,responseReceipt:receipt,output:{materialDecisions:[{...adopt.materialDecisions[0],materialId:'old-1'}]},normalizePlan:value=>value}),/决定id/);
 assert.throws(()=>createPlanningFollowupDecisionCommit({input,responseReceipt:receipt,output:{materialDecisions:[{...adopt.materialDecisions[0],sourceQuotes:['这段文字并不存在于来源正文。']}]},normalizePlan:value=>value}),/来源短引/);
 assert.throws(()=>createPlanningFollowupDecisionCommit({input,responseReceipt:receipt,output:adopt,normalizePlan:value=>({...value,ending:'暗中改写'})}),/改变了方案/);
 assert.throws(()=>validatePlanningFollowupResponseReceipt({...receipt,inputHash:'0'.repeat(64)},input),/响应保存点/);
 assert.throws(()=>validatePlanningFollowupDecisionStart({...start,inputHash:'0'.repeat(64)},input),/开始保存点/);
});
