import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {knowledgeForAuthor} from './knowledge.mjs';
import {MATERIAL_NARRATIVE_OBSERVATION_VERSION} from '../../../data/runtime/narrative-observations.mjs';
import {createPlanningFollowupDecisionInput,createPlanningFollowupResponseReceipt,validatePlanningFollowupResponseReceipt,createPlanningFollowupDecisionCommit} from './planning-followup-decisions.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(canonical):Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const projectionHash=value=>sha(JSON.stringify(canonical(value)));
const observationValue='只在观察值中的句子绝不能当原文引文。';

function materialWithObservation(){
 const content='【原文参考；不作为已发布分析】\n她把借来的旧钟交还给老人。',sourceSha256=sha('source');
 const reference={sourceId:'s',sourceSha256,textVersion:'t1',analysisVersion:'a1',unitIds:[],lineStart:2,lineEnd:2};
 const material={id:'new-observed',title:'测试来源',kind:'retrieved',use:'raw_reference',content,sha256:sha(content),references:[reference],selectionReason:'测试',limitations:['只供测试']};
 const item={id:'legacy:s:story:ending_mechanism',field:'ending_mechanism',value:observationValue,
  analysisStatus:{kind:'archived_ai_narrative_observation',archiveAccepted:true,currentAnalysisBindingValid:false,grantsCurrentCheckedAnalysisStatus:false},
  confidence:{originalFieldConfidence:'high',boundaryOrigin:'analyst_simulated'},
  source:{sourceId:'s',title:'测试来源',sourceSha256,normalizedTextSha256:sha('她把借来的旧钟交还给老人。'),textVersion:'t1'},
  archive:{storyId:'story',cardSha256:sha('card'),auditSha256:sha('audit')},
  authority:{classification:'observable_narrative_choice',authorIntentClaimed:false,grantsNewCheckedAnalysisStatus:false,automaticCreativeSupply:false,retrievalIntegrated:false},
  evidence:[{quote:'她把借来的旧钟交还给老人。',lineStart:2,lineEnd:2}],
  materialBinding:{materialId:material.id,references:[reference],allEvidenceInsideSelectedWindows:true},limitations:['历史 AI 观察，不是当前 checked analysis。']};
 const charged={...item,chargedChars:JSON.stringify(item).length};
 const projection={contractVersion:MATERIAL_NARRATIVE_OBSERVATION_VERSION,queryHash:sha('query'),usedChars:charged.chargedChars,items:[charged],limits:['必须显式采用材料。']};
 projection.projectionSha256=projectionHash({contractVersion:projection.contractVersion,queryHash:projection.queryHash,items:projection.items,limits:projection.limits});
 return {...material,narrativeObservations:projection};
}

const plan={title:'钟',premise:'归还旧钟',ending:'归还完成',constraints:[],chapters:[{id:'ch-1',title:'归还',goal:'归还旧钟',continuity:'收束',scenes:['归还']}],materialDecisions:[]};

test('strict author projection exposes observations only with their adopted material',()=>{
 const material=materialWithObservation(),packet={materials:[material],style:null,limits:[]};
 assert.deepEqual(knowledgeForAuthor(packet,{materialDecisions:[],requireAdoptDecision:true}).materials,[]);
 const view=knowledgeForAuthor(packet,{materialDecisions:[{materialId:material.id,decision:'adopt'}],requireAdoptDecision:true});
 assert.deepEqual(view.materials[0].narrativeObservations,material.narrativeObservations);
 assert.equal(view.materials[0].use,'raw_reference');
 const tampered=structuredClone(packet);tampered.materials[0].narrativeObservations.items[0].value='换新分析';
 assert.throws(()=>knowledgeForAuthor(tampered,{materialDecisions:[{materialId:material.id,decision:'adopt'}],requireAdoptDecision:true}),/narrative observations/);
});

test('decision input binds observation bytes but source quotes still match content only',()=>{
 const material=materialWithObservation(),knowledge=knowledgeForAuthor({materials:[material],style:null,limits:[]});
 const input=createPlanningFollowupDecisionInput({plan,knowledge,activeSnapshotHash:'a'.repeat(64),addedMaterialIds:[material.id]});
 assert.equal(input.newMaterials[0].narrativeObservations.items[0].value,observationValue);
 const bad={materialDecisions:[{materialId:material.id,decision:'adopt',reason:'误把观察当原文',limitations:['测试'],mechanism:'归还动作',sourceQuotes:[observationValue],target:{chapterNumber:1,sceneNumber:1}}]};
 const receipt=createPlanningFollowupResponseReceipt(input,JSON.stringify(bad));
 assert.throws(()=>createPlanningFollowupDecisionCommit({input,responseReceipt:receipt,output:bad,normalizePlan:value=>value}),/来源短引/);
 const changed=structuredClone(input);changed.knowledge.materials[0].narrativeObservations.items[0].value='恢复时换新分析';
 assert.throws(()=>validatePlanningFollowupResponseReceipt(receipt,changed),/响应保存点/);
});
