import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {MockLanguageModelV4} from 'ai/test';
import {runWorkflow} from '../../../creation/runtime/workflow.mjs';
import {createFollowup,AUTHOR_MATERIAL_POLICY} from '../../../creation/runtime/v04/followup.mjs';
import {createWorkflowRouter} from './workflow-engine.mjs';
import {makeAgentModels,configFor} from '../scripts/agent-runtime-smoke.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const material=n=>({id:`m${n}`,title:`合成材料${n}`,kind:'retrieved',use:'raw_reference',
 content:`仅限工程测试的材料${n}。`,sha256:sha(`仅限工程测试的材料${n}。`),
 references:[{sourceId:'source',sourceSha256:sha('source'),textVersion:'t1',analysisVersion:'a1',unitIds:[],lineStart:n,lineEnd:n}],selectionReason:'本地合成',limitations:['不证明文学效果']});
const decisions=adopt=>[1,2].map(n=>({materialId:`m${n}`,decision:n===adopt?'adopt':'decline',reason:n===adopt?'用于修理场景中的动作承接':'不适合当前场景',limitations:['测试声明，不是正文效果']}));
const packet=query=>({contractVersion:'v04-contract-1',packetId:'p',query:structuredClone(query),status:'matched',materials:[material(1),material(2)],candidates:[],usedChars:material(1).content.length+material(2).content.length,limits:['合成测试']});

async function fixture({engine='fixed',artifacts={},failAt,repairReplan=false}={}){
 const mocks=makeAgentModels({reviewDecision:'revise'}),calls=[],toolInputs=[],queries=[];
 const request={kind:'create',idea:'合成测试：修钟。',context:{},materials:[]};
 let replanCount=0,step=0;
 const agentModel=new MockLanguageModelV4({provider:'explicit-author-policy-test',modelId:'synthetic',doGenerate:async options=>{
  if(!options.tools?.some(t=>t.name==='approve_plan'))return mocks.agentModel.doGenerate(options);
  toolInputs.push(structuredClone(options.prompt));
  const name=['read_materials','revise_plan','read_materials','approve_plan'][step++];
  assert.ok(name,'bounded synthetic plan tools');
  return {content:[{type:'tool-call',toolCallId:randomUUID(),toolName:name,input:JSON.stringify({reason:'工程回归',...(name==='revise_plan'?{feedback:'重新评估两个场景材料的适用性'}:{})})}],
   finishReason:{unified:'tool-calls',raw:'tool_calls'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]};
 }});
 const model={complete:async args=>{
  const input=JSON.parse(args.user);calls.push({stage:args.stage,input});
  if(args.stage===failAt)throw Error('synthetic interruption');
  const response=await mocks.model.complete(args);
  if(['planning','agent:replan'].includes(args.stage)){
   if(args.stage==='agent:replan'&&repairReplan&&replanCount++===0)return JSON.stringify({title:'字段不完整的测试方案'});
   const value=JSON.parse(response);value.materialDecisions=decisions(args.stage==='agent:replan'?1:2);return JSON.stringify(value);
  }
  return response;
 }};
 const retrieveKnowledge=async q=>{queries.push(q);return packet(q);};
 const router=createWorkflowRouter({config:configFor('/tmp/unused-author-material-test'),agentModel,retrieveKnowledge});
 const run=()=>router({request,engine,model,artifacts,checkpoint:async(k,v)=>{artifacts[k]=structuredClone(v);}});
 return {run,calls,artifacts,queries,toolInputs,request,model,retrieveKnowledge};
}

test('fixed workflow removes declined material from actual draft/revision inputs and keeps neutral review separate',async()=>{
 const f=await fixture();const result=await f.run();
 assert.equal(f.artifacts.requestSpec.authorMaterialPolicyVersion,AUTHOR_MATERIAL_POLICY);
 const authors=f.calls.filter(c=>c.stage.startsWith('draft:')||c.stage.startsWith('revision:'));
 assert.equal(authors.length,3);
 for(const call of authors){assert.deepEqual(call.input.knowledge.materials.map(m=>m.id),['m2']);assert.deepEqual(call.input.knowledge.materialUse.excludedMaterialIds,['m1']);}
 assert.deepEqual(result.knowledge.materials.map(m=>m.id),['m1','m2']);
 assert.deepEqual(result.activeKnowledge.materials.map(m=>m.id),['m1','m2']);
 for(const c of f.calls.filter(c=>['review','revisionReview'].includes(c.stage)))assert.equal(c.input.knowledge,undefined);
 const before=structuredClone(f.artifacts),count=f.calls.length;
 assert.deepEqual(await f.run(),result);assert.equal(f.calls.length,count);assert.deepEqual(f.artifacts,before);
});

test('SDK reads current plan projection before and after replan; one field repair retains the filtered original input',async()=>{
 const f=await fixture({engine:'ai-sdk',repairReplan:true});await f.run();
 const reads=Object.values(f.artifacts).filter(v=>v?.output?.knowledge);
 assert.equal(reads.length,2);
 assert.deepEqual(reads.map(r=>r.output.knowledge.materials.map(m=>m.id)),[['m2'],['m1']]);
 const replans=f.calls.filter(c=>c.stage==='agent:replan');assert.equal(replans.length,2);
 assert.deepEqual(replans[0].input.knowledge.materials.map(m=>m.id),['m2']);
 assert.deepEqual(replans[1].input.originalInput,replans[0].input);
 for(const c of f.calls.filter(c=>c.stage.startsWith('draft:')||c.stage.startsWith('agent:reviseChapter:')))assert.deepEqual(c.input.knowledge.materials.map(m=>m.id),['m1']);
});

test('interrupted new task resumes the same filtered snapshot without repeating retrieval or completed chapters',async()=>{
 const first=await fixture({failAt:'draft:ch-2'});await assert.rejects(first.run(),/synthetic interruption/);
 const firstChapter=structuredClone(first.artifacts['draft:ch-1']);
 const resumed=await fixture({artifacts:first.artifacts});await resumed.run();
 assert.equal(resumed.queries.length,0);assert.equal(resumed.calls.some(c=>c.stage==='draft:ch-1'),false);
 assert.deepEqual(resumed.artifacts['draft:ch-1'],firstChapter);
 assert.deepEqual(resumed.calls.find(c=>c.stage==='draft:ch-2').input.knowledge.materials.map(m=>m.id),['m2']);
});

test('synthetic legacy task without the new policy keeps the prior full author view on resume',async()=>{
 const first=await fixture({failAt:'planning'});await assert.rejects(first.run(),/synthetic interruption/);
 const legacy=structuredClone(first.artifacts);delete legacy.requestSpec.authorMaterialPolicyVersion;
 for(const k of Object.keys(legacy))if(k.startsWith('knowledge-use:')||k.startsWith('knowledge-returned:'))delete legacy[k];
 const f=await fixture({artifacts:legacy});await f.run();
 for(const c of f.calls.filter(c=>c.stage.startsWith('draft:')||c.stage.startsWith('revision:')))assert.deepEqual(c.input.knowledge.materials.map(m=>m.id),['m1','m2']);
 assert.equal(legacy.requestSpec.authorMaterialPolicyVersion,undefined);
});

test('unknown material policy fails before a provider call or an approved-looking fallback',()=>{
 assert.throws(()=>createFollowup({request:{},requestSpec:{authorMaterialPolicyVersion:'unknown'},knowledge:{materials:[],limits:[]},saved:{},persist:async()=>assert.fail()}),/未知作者材料政策/);
});
