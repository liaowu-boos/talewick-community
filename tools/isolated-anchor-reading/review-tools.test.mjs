import test from 'node:test';
import assert from 'node:assert/strict';
import {buildReadingPlan,validateResponse,inspectExecution,valueSHA256,sha256} from './review-tools.mjs';
import {manuscripts,chapterIds,makeResponse} from './synthetic-fixture.mjs';
const build=()=>buildReadingPlan({manuscripts,chapterIds});
const inspect=(request,response=makeResponse(request.packet),extra={})=>validateResponse({packet:request.packet,expectedPacketSHA256:request.packetSHA256,raw:JSON.stringify(response),...extra});
test('three planned contexts isolate both complete single texts and comparison',()=>{
 const original=JSON.stringify(manuscripts),p=build();assert.deepEqual(p.requests.map(r=>r.requestId),['S1','S2','C1']);
 for(const [i,r]of p.requests.entries()){
  assert.equal(r.messages.length,2);assert.deepEqual(JSON.parse(r.messages[1].content),r.packet);
  if(i<2){assert.equal(r.packet.manuscripts.length,1);assert.equal(r.packet.manuscripts[0].version,'X');assert.deepEqual(r.packet.manuscripts[0].chapters,manuscripts[i?'B':'A']);assert.equal(r.packet.differences.length,0);assert.equal(r.packet.identity,null);}
  else{assert.deepEqual(r.packet.manuscripts.map(m=>m.version),['A','B']);assert(r.packet.differences.length>0);assert(r.packet.instructions.includes('差异辅助比较'));}
  assert(!/修改目标|其他读者的回答/.test(r.messages[1].content));
 }
 assert.equal(JSON.stringify(manuscripts),original);assert.deepEqual(build(),p);
});
test('all valid synthetic responses resolve exact original anchors, preserving CRLF and punctuation',()=>{
 for(const request of build().requests){const raw=JSON.stringify(makeResponse(request.packet)),r=inspect(request);assert(r.valid,JSON.stringify(r.errors));assert.equal(r.rawSHA256,sha256(raw));assert.equal(r.factJudgment,'requires_human_review');assert.equal(r.fullManuscriptAccepted,false);
  for(const e of r.resolvedEvidence){const c=request.packet.manuscripts.find(m=>m.version===e.version).chapters.find(c=>c.id===e.chapterId);assert.equal(c[e.field].slice(e.start,e.end),e.quote);}
 }
 assert(build().requests[0].packet.manuscripts[0].chapters[0].body.includes('\r\n\r\n'));
});
test('single reading rejects a preference field and another single context anchor',()=>{
 const p=build(),r=makeResponse(p.requests[0].packet);r.overall.preference='A';assert(!inspect(p.requests[0],r).schemaValid);
 delete r.overall.preference;r.evidence[0].anchorId=p.requests[1].packet.anchors[0].anchorId;
 assert(inspect(p.requests[0],r).errors.some(e=>e.code==='ANCHOR_UNKNOWN'));
});
test('false identical declaration is a deterministic contradiction even with fully covered changes',()=>{
 const request=build().requests[2],response=makeResponse(request.packet);response.textIdentity='identical';
 const r=inspect(request,response);assert(r.differenceCoverage.every(d=>d.covered));assert(r.errors.some(e=>e.code==='TEXT_IDENTITY_CONTRADICTION'));assert.equal(r.validatedPreference,null);assert.equal(r.identityCheck.actual,'different');
});
test('only shared paragraph citations expose every missing changed side',()=>{
 const request=build().requests[2],response=makeResponse(request.packet);
 const common=response.evidence.filter(e=>e.chapterId==='ending'&&e.anchorId.endsWith('P001')).map(e=>e.id);
 response.changeReadings.forEach(c=>c.evidenceIds=common);
 const r=inspect(request,response);assert(r.anchorsValid);assert(!r.valid);assert(r.differenceCoverage.every(d=>!d.covered));assert(r.errors.some(e=>e.code==='DIFFERENCE_SIDE_NOT_FULLY_CITED'));
});
test('declared version and chapter cannot reassign a frozen anchor',()=>{
 const request=build().requests[2];
 for(const value of ['B','__proto__']){const response=makeResponse(request.packet);response.evidence.find(e=>e.version==='A').version=value;assert(inspect(request,response).errors.some(e=>e.code==='ANCHOR_SOURCE_MISMATCH'));}
 const response=makeResponse(request.packet);response.evidence[0].chapterId='ending';assert(!inspect(request,response).anchorsValid);
});
test('frozen hash and rebuilt packet reject body, catalog, contract and difference tampering',()=>{
 const original=build().requests[2];
 for(const mutate of [p=>p.manuscripts[0].chapters[0].body+='x',p=>p.anchors[0].text='fabricated',p=>p.responseContract.properties.kind.enum=['anything'],p=>p.differences[0].A.regionAnchorIds=[]]){
  const packet=structuredClone(original.packet);mutate(packet);
  assert(!validateResponse({packet,expectedPacketSHA256:original.packetSHA256,raw:'{}'}).bindingValid);
  if(packet.manuscripts[0].chapters[0].body===original.packet.manuscripts[0].chapters[0].body)assert(!validateResponse({packet,expectedPacketSHA256:valueSHA256(packet),raw:'{}'}).bindingValid);
 }
 assert(!validateResponse({packet:original.packet,raw:'{}'}).bindingValid);
 assert.deepEqual(build().requests[2],original);
});
test('mutating one exported packet cannot mutate another or future contracts',()=>{
 const p=build(),expected=build();p.requests[0].packet.manuscripts[0].chapters[0].body='mutated';p.requests[0].packet.responseContract.properties.kind.enum[0]='mutated';
 assert.deepEqual(p.requests[2],expected.requests[2]);assert.deepEqual(build(),expected);
});
test('insertions and deletions require changed anchors plus the empty side context',()=>{
 const m=structuredClone(manuscripts);m.A[0].body='甲。\n\n乙。';m.B[0].body='甲。\n\n新增。\n\n乙。';
 const r=buildReadingPlan({manuscripts:m,chapterIds}).requests[2],v=inspect(r);assert(v.valid);const d=r.packet.differences.find(d=>d.chapterId==='opening');
 assert.equal(d.A.regionAnchorIds.length,0);assert(d.A.contextAnchorIds.length>0);assert.equal(d.B.regionAnchorIds.length,1);
 const response=makeResponse(r.packet);response.changeReadings.find(c=>c.differenceId===d.differenceId).evidenceIds=response.evidence.filter(e=>e.version==='B'&&d.B.regionAnchorIds.includes(e.anchorId)).map(e=>e.id);
 assert(!inspect(r,response).valid);
});
test('all changed paragraphs in one region must be selected',()=>{
 const m=structuredClone(manuscripts);m.A[0].body='甲。\n\n旧一。\n\n旧二。\n\n乙。';m.B[0].body='甲。\n\n新一。\n\n新二。\n\n乙。';
 const request=buildReadingPlan({manuscripts:m,chapterIds}).requests[2],response=makeResponse(request.packet),d=request.packet.differences.find(d=>d.chapterId==='opening');
 const skipped=response.evidence.find(e=>e.anchorId===d.A.regionAnchorIds[1]).id;
 response.changeReadings.find(c=>c.differenceId===d.differenceId).evidenceIds=response.changeReadings.find(c=>c.differenceId===d.differenceId).evidenceIds.filter(id=>id!==skipped);
 const r=inspect(request,response);assert(!r.valid);assert(r.differenceCoverage.find(x=>x.differenceId===d.differenceId).sides[0].missingRegionAnchorIds.length);
});
test('title and separator-only differences remain explicit; titles cannot replace chapter-body evidence',()=>{
 const m=structuredClone(manuscripts);m.B=structuredClone(m.A);m.B[0].title='新标题';m.B[1].body=m.B[1].body.replace('\n\n','\r\n\r\n');
 const request=buildReadingPlan({manuscripts:m,chapterIds}).requests[2];assert.deepEqual(request.packet.differences.map(d=>d.kind),['title','separator_or_whitespace']);assert(inspect(request).valid);
 const response=makeResponse(request.packet);response.chapterReadings[0].evidenceIds=[response.evidence.find(e=>e.anchorId==='C1-A-opening-T').id];assert(!inspect(request,response).valid);
});
test('identical manuscripts allow no changes and no clear improvement without invented differences',()=>{
 const m={A:structuredClone(manuscripts.A),B:structuredClone(manuscripts.A)},r=buildReadingPlan({manuscripts:m,chapterIds}).requests[2];
 assert.equal(r.packet.differences.length,0);assert(inspect(r).valid);
 const response=makeResponse(r.packet);response.textIdentity='different';assert(!inspect(r,response).valid);
});
test('arbitrary prose is not silently treated as verified fact or automatically classified by keywords',()=>{
 const request=build().requests[2],response=makeResponse(request.packet);response.overall.assessment='两稿完全相同，也没有人离开。';response.textIdentity='different';
 const r=inspect(request,response);assert(r.valid);assert.equal(r.factJudgment,'requires_human_review');assert.equal(r.literaryJudgment,'requires_human_review');
});
test('missing or extra difference IDs, duplicate evidence and invalid raw JSON are rejected',()=>{
 const request=build().requests[2];let response=makeResponse(request.packet);response.changeReadings.pop();assert(!inspect(request,response).valid);
 response=makeResponse(request.packet);response.changeReadings.push({...response.changeReadings[0],differenceId:'D999'});assert(!inspect(request,response).valid);
 response=makeResponse(request.packet);response.evidence[1].id=response.evidence[0].id;assert(!inspect(request,response).valid);
 for(const raw of ['{','null','[]','"text"'])assert(!validateResponse({packet:request.packet,expectedPacketSHA256:request.packetSHA256,raw}).valid);
 assert(!inspect(request,makeResponse(request.packet),{expectedRawSHA256:'0'.repeat(64)}).bindingValid);
});
test('three-context execution inspection rejects shared IDs, conversation carryover and plan edits',()=>{
 const plan=build(),executions=plan.requests.map((r,i)=>({requestId:r.requestId,messages:r.messages,raw:JSON.stringify(makeResponse(r.packet)),receipt:{contextId:'c'+i,invocationId:'i'+i}}));
 assert(inspectExecution({plan,executions}).valid);
 executions[2].receipt.contextId='c0';assert(!inspectExecution({plan,executions}).valid);executions[2].receipt.contextId='c2';
 executions[2].messages=[...executions[2].messages,{role:'assistant',content:'other reader opinion'}];assert(!inspectExecution({plan,executions}).valid);
 const changed=structuredClone(plan);changed.privateBindings.S1='B';assert(!inspectExecution({plan:changed,executions}).valid);
 assert(!inspectExecution({plan,executions:[null,{},{}]}).valid);
});
test('exact difference ranges reconstruct all 196 short repeated/reordered paragraph pairs',()=>{
 const sequences=[];for(let n=1;n<=3;n++)for(let mask=0;mask<2**n;mask++)sequences.push(Array.from({length:n},(_,i)=>(mask>>i)&1?'乙段。':'甲段。'));
 let cases=0;
 for(const [i,a]of sequences.entries())for(const [j,b]of sequences.entries()){
  const m=structuredClone(manuscripts);m.A[0].body=a.join(i%2?'\n\n':'\r\n\r\n');m.B[0].body=b.join(j%2?'\n\n\n':'\n\n');
  const packet=buildReadingPlan({manuscripts:m,chapterIds}).requests[2].packet;
  const changes=packet.differences.filter(d=>d.chapterId==='opening'&&d.rawDifference);
  let rebuilt=m.A[0].body;for(const d of changes.toSorted((x,y)=>y.rawDifference.A.start-x.rawDifference.A.start)){const r=d.rawDifference;assert.equal(m.A[0].body.slice(r.A.start,r.A.end),r.A.text);rebuilt=rebuilt.slice(0,r.A.start)+r.B.text+rebuilt.slice(r.A.end);}
  assert.equal(rebuilt,m.B[0].body);cases++;
 }
 assert.equal(cases,196);
});

function rangedTexts(chapterIds){
 const A=chapterIds.map((id,i)=>({id,title:`合成章节${i}`,body:`共同段落${i}。\n\n原有动作${i}。`}));
 const B=A.map((c,i)=>({...c,body:i===0?c.body.replace('原有','不同'):c.body}));
 return {A,B};
}
for(const range of [['only'],['part-A','part-Z'],['10','2','appendix','epilogue'],['unit_1','unit_2','unit_3','unit_4','unit_5','unit_6']]){
 test(`explicit ordered range ${range.join(',')} binds each chapter and dynamic coverage`,()=>{
  const m=rangedTexts(range),before=structuredClone(m),plan=buildReadingPlan({manuscripts:m,chapterIds:range});
  assert.equal(plan.protocolVersion,'isolated-anchor-reading-2');assert.deepEqual(plan.chapterIds,range);
  for(const [i,request]of plan.requests.entries()){
   assert.deepEqual(request.packet.chapterIds,range);assert.deepEqual(JSON.parse(request.messages[1].content).chapterIds,range);
   assert.equal(request.packet.responseContract.properties.chapterReadings.minItems,range.length*(i===2?2:1));
   const response=makeResponse(request.packet),result=inspect(request,response);
   assert(result.valid,JSON.stringify(result.errors));assert.deepEqual(result.chapterIds,range);
   assert.deepEqual([...new Set(result.resolvedEvidence.map(e=>e.chapterId))],range);
   response.chapterReadings.pop();assert(!inspect(request,response).valid);
  }
  assert.deepEqual(m,before);
 });
}
test('chapterIds is mandatory, nonempty, unique and restricted to documented literal identifiers',()=>{
 for(const range of [undefined,null,[],['same','same'],['bad space'],['/path'],['.'],['章一'],[1],['a'.repeat(81)]]){
  assert.throws(()=>buildReadingPlan({manuscripts,chapterIds:range}));
 }
});
test('both manuscripts must exactly match the explicit range with no sorting, filling or omitted chapters',()=>{
 const range=['z-last','a-first','middle'];
 for(const mutate of [m=>m.A.pop(),m=>m.B.pop(),m=>m.B.reverse(),m=>m.B[1].id=m.B[0].id,
  m=>m.A[0].id='different',m=>m.B.push({...m.B[0],id:'extra'})]){
  const m=rangedTexts(range);mutate(m);assert.throws(()=>buildReadingPlan({manuscripts:m,chapterIds:range}));
 }
});
test('wrong-chapter evidence is rejected even when both anchors are individually valid in a new range',()=>{
 const range=['scene-one','scene-two','scene-three','scene-four'];
 const request=buildReadingPlan({manuscripts:rangedTexts(range),chapterIds:range}).requests[0];
 const response=makeResponse(request.packet);
 response.chapterReadings[0].evidenceIds=[response.evidence.find(e=>e.chapterId===range[1]&&e.anchorId.endsWith('P001')).id];
 const result=inspect(request,response);assert(result.anchorsValid);assert(!result.evidenceContractValid);
 assert(result.errors.some(e=>e.code==='WRONG_SOURCE'));assert.equal(result.validatedPreference,null);
});
test('range changes are part of packet, messages and plan digests and cannot silently rewrite a saved request',()=>{
 const range=['one','two'],plan=buildReadingPlan({manuscripts:rangedTexts(range),chapterIds:range}),request=plan.requests[2];
 const changed=structuredClone(request.packet);changed.chapterIds.reverse();
 assert(!validateResponse({packet:changed,expectedPacketSHA256:request.packetSHA256,raw:'{}'}).bindingValid);
 assert(!validateResponse({packet:changed,expectedPacketSHA256:valueSHA256(changed),raw:'{}'}).bindingValid);
 const other=buildReadingPlan({manuscripts:rangedTexts(['uno','dos']),chapterIds:['uno','dos']});
 assert.notEqual(plan.planSHA256,other.planSHA256);assert.notEqual(request.messagesSHA256,other.requests[2].messagesSHA256);
 const executions=plan.requests.map((r,i)=>({requestId:r.requestId,messages:r.messages,raw:JSON.stringify(makeResponse(r.packet)),receipt:{contextId:`c${i}`,invocationId:`i${i}`}}));
 executions[0].messages=other.requests[0].messages;
 assert(inspectExecution({plan,executions}).errors.includes('ACTUAL_MESSAGES_MISMATCH_S1'));
});
test('public v2 rejects legacy protocol packets and execution plans without implicit migration',()=>{
 const plan=build(),packet=structuredClone(plan.requests[0].packet);
 packet.protocolVersion='isolated-anchor-reading-1';delete packet.chapterIds;
 const result=validateResponse({packet,expectedPacketSHA256:valueSHA256(packet),raw:'{}'});
 assert(!result.bindingValid);assert(result.errors.some(e=>e.code==='PROTOCOL_VERSION'));
 const oldPlan=structuredClone(plan);oldPlan.protocolVersion='isolated-anchor-reading-1';
 assert(!inspectExecution({plan:oldPlan,executions:[]}).valid);
 assert.equal(result.schemaVersion,'isolated-anchor-reading-inspection-2');
});
