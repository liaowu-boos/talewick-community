import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {mkdir,readFile,writeFile,rename,unlink,link,readdir,rmdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {LIBRARY_LIMITS} from './library.mjs';
import {inspectAnalysisCandidate} from './analysis-candidate.mjs';
import {analysisReviewPrompt,inspectAnalysisReview} from './analysis-review.mjs';
import {analysisBudget,inspectAnalysisBudgetRequest,ANALYSIS_BUDGET_VERSION,LEGACY_ANALYSIS_BUDGET_VERSION,REVIEW_MAX_TOKENS} from './analysis-budget.mjs';

export const EXTERNAL_ANALYSIS_VERSION='codex-external-analysis-2';
export const LEGACY_EXTERNAL_ANALYSIS_VERSION='codex-external-analysis-1';
const hash=value=>createHash('sha256').update(value).digest('hex');
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const exact=(x,keys)=>object(x)&&Object.keys(x).sort().join('|')===[...keys].sort().join('|');
const short=x=>typeof x==='string'&&x.trim().length>0&&x.length<=200;
const error=(code,message)=>Object.assign(new Error(message),{code});
const check=(yes,code,message)=>{if(!yes)throw error(code,message);};
const serialized=value=>JSON.stringify(value);
const requestValue=request=>({stage:request.stage,system:request.system,user:request.user,maxTokens:request.maxTokens});
const sameRequest=(a,b)=>isDeepStrictEqual({...a,user:JSON.parse(a.user)},{...b,user:JSON.parse(b.user)});
const transport=(maxTokens,budget)=>({execution:'external_replay',providerRequests:0,referenceProviderMaxTokens:maxTokens,codexMaxTokensEnforced:false,
 ...(budget?.version===ANALYSIS_BUDGET_VERSION?{analysisBudgetPolicyVersion:budget.version}:{})});
const budgetEnvelope=budget=>budget.version===LEGACY_ANALYSIS_BUDGET_VERSION?LEGACY_EXTERNAL_ANALYSIS_VERSION:EXTERNAL_ANALYSIS_VERSION;
function analysisContract(request){
 try{return inspectAnalysisBudgetRequest(request);}catch{throw error('EXTERNAL_INPUT','analysis stage budget contract');}
}
// Malformed requests must still reach the immutable attempt journal before rejection.
function inferredEnvelope(input){
 try{return budgetEnvelope(analysisContract(parseRequest(input)));}catch{return EXTERNAL_ANALYSIS_VERSION;}
}

function fixedSource(bytes,completeness='unknown'){
 check(Buffer.isBuffer(bytes)||bytes instanceof Uint8Array,'EXTERNAL_SOURCE','source bytes required');
 check(bytes.byteLength>0&&bytes.byteLength<=LIBRARY_LIMITS.maxBytes&&['full','first_four','unknown'].includes(completeness),'EXTERNAL_SOURCE','source budget or declaration');
 const sourceSha256=hash(bytes),encoding=bytes[0]===255&&bytes[1]===254?'utf-16le':bytes[0]===254&&bytes[1]===255?'utf-16be':'utf-8';
 let text;try{text=new TextDecoder(encoding,{fatal:true}).decode(bytes).replace(/\r\n|\r/g,'\n');}catch{throw error('EXTERNAL_SOURCE','invalid source encoding');}
 check(text.trim()&&!text.includes('\0')&&text.length<=LIBRARY_LIMITS.maxTextChars,'EXTERNAL_SOURCE','invalid or oversized source');
 return {source:{sourceSha256,sourceTextSha256:hash(text),textVersion:`text-v2-lf-${sourceSha256}`,completeness},text};
}
function sourceUser(user,fixed){
 check(object(user)&&user.textVersion===fixed.source.textVersion&&user.declaredCompleteness===fixed.source.completeness,'EXTERNAL_SOURCE_BINDING','request source version or declaration mismatch');
 check(isDeepStrictEqual(user.lines,fixed.text.split('\n').map((text,i)=>({line:i+1,text}))),'EXTERNAL_SOURCE_BINDING','request must contain all fixed source lines');
}
function parseRequest(input){
 check(typeof input==='string'&&Buffer.byteLength(input)<=1_000_000,'EXTERNAL_INPUT','bounded exact request JSON required');
 let r;try{r=JSON.parse(input);}catch{throw error('EXTERNAL_INPUT','invalid request JSON');}
 check(exact(r,['stage','system','user','maxTokens'])&&typeof r.system==='string'&&r.system.trim()&&typeof r.user==='string','EXTERNAL_INPUT','complete stage/system/user/maxTokens request required');
 return r;
}
function inspectCandidate(raw,fixed){
 let value;try{value=JSON.parse(raw);}catch{return {analysis:null,diagnostics:[{code:'INVALID_JSON',path:'$',message:'Original external analysis is invalid JSON.'}]};}
 check(object(value)&&!['version','reviewStatus','validation','approved','semanticReview','checked'].some(k=>Object.hasOwn(value,k)),'EXTERNAL_SELF_APPROVAL','model output cannot carry publication or approval metadata');
 return inspectAnalysisCandidate(value,fixed.text,fixed.source.textVersion);
}
function reviewAnalysis(raw,fixed){
 const inspected=inspectCandidate(raw,fixed);check(inspected.analysis,'EXTERNAL_CANDIDATE','valid literal candidate required for review input');
 const a=inspected.analysis;
 a.validation.responseVersion=`response-${hash(raw)}`;
 // Match the existing first-import lifecycle without changing the candidate's canonical version.
 if(fixed.source.completeness!=='full'&&a.coverage.scope==='full'){
  a.coverage.scope=fixed.source.completeness;a.coverage.notes.push('用户未声明全文，不认定已覆盖整部作品。');
 }
 return a;
}

// Only service-generated FAILED attempts may differ during explicit recovery. The
// external review input must still be the exact initial candidate with null review.
function initialFromRuntime(a,expected){
 const copy=structuredClone(a),v=copy?.validation;
 if(v?.semanticReview!==null){
  const history=v?.semanticReviewHistory;
  check(Array.isArray(history)&&history.length>0&&isDeepStrictEqual(history.at(-1),v.semanticReview),'EXTERNAL_REVIEW_BINDING','only complete failed service history may resume');
  const ids=new Set();
  for(const r of history){
   const required=['recordId','sourceId','textVersion','analysisVersion','approved','notes','reviewedAt','method','outcome'];
   const keys=Object.keys(r??{});
   check(required.every(k=>keys.includes(k))&&keys.every(k=>required.includes(k)||['responseVersion','diagnostics'].includes(k))&&short(r.recordId)&&!ids.has(r.recordId)&&short(r.sourceId)&&r.sourceId===history[0].sourceId&&r.textVersion===expected.textVersion&&r.analysisVersion===expected.version&&r.approved===false&&r.outcome==='failed'&&r.method==='model-library-review'&&short(r.reviewedAt)&&Array.isArray(r.notes)&&r.notes.every(x=>typeof x==='string'),'EXTERNAL_REVIEW_BINDING','history is not a failed runtime review for this candidate');
   if(Object.hasOwn(r,'responseVersion')||Object.hasOwn(r,'diagnostics'))check(/^review-response-[a-f0-9]{64}$/.test(r.responseVersion)&&Array.isArray(r.diagnostics),'EXTERNAL_REVIEW_BINDING','failed response diagnostics mismatch');
   ids.add(r.recordId);
  }
  v.semanticReview=null;delete v.semanticReviewHistory;
 }
 check(isDeepStrictEqual(copy,expected),'EXTERNAL_REVIEW_BINDING','runtime initial candidate has changed or extra metadata');
 return copy;
}

/** The coordinator supplies the frozen analysis system (or a captured runtime request on retry). */
export function prepareExternalAnalysisInput({bytes,completeness='unknown',system,request,analysisBudgetVersion}={}){
 const fixed=fixedSource(bytes,completeness);
 const policy=analysisBudget(analysisBudgetVersion);
 // Caller supplies the frozen system, including v2's guidance, or an exact captured request.
 const input=typeof request==='string'?request:serialized(request?requestValue(request):{stage:'library-analysis',system,user:serialized({declaredCompleteness:completeness,textVersion:fixed.source.textVersion,lines:fixed.text.split('\n').map((text,i)=>({line:i+1,text})),...policy.userFields}),maxTokens:policy.maxTokens});
 const parsed=parseRequest(input),budget=analysisContract(parsed);
 check(analysisBudgetVersion===undefined||budget.version===policy.version,'EXTERNAL_INPUT','explicit analysis budget policy mismatch');
 sourceUser(JSON.parse(parsed.user),fixed);
 return {source:fixed.source,request:parsed,input,inputSha256:hash(input),transport:transport(parsed.maxTokens,budget)};
}
/** Independent review sees only the canonical candidate, never a previous approval or model identity. */
export function prepareExternalReviewInput({bytes,completeness='unknown',analysisOutput,request:existing}={}){
 const fixed=fixedSource(bytes,completeness),analysis=reviewAnalysis(analysisOutput,fixed);
 const request={stage:'library-review',...analysisReviewPrompt({text:fixed.text,analysis,textVersion:fixed.source.textVersion,declaredCompleteness:completeness}),maxTokens:REVIEW_MAX_TOKENS};
 const input=typeof existing==='string'?existing:serialized(existing??request),parsed=parseRequest(input);
 check(sameRequest(parsed,request),'EXTERNAL_REVIEW_BINDING','review request must contain the exact initial production candidate');
 return {source:fixed.source,analysisVersion:analysis.version,request:parsed,input,inputSha256:hash(input),transport:transport(request.maxTokens)};
}

async function immutable(path,value){
 const text=serialized(value),temp=`${path}.${randomUUID()}.tmp`;
 try{await writeFile(temp,text,{flag:'wx'});try{await link(temp,path);}catch(e){if(e.code!=='EEXIST')throw e;check(await readFile(path,'utf8')===text,'EXTERNAL_JOURNAL_CONFLICT','immutable journal conflict');}}
 finally{await unlink(temp).catch(()=>{});}
}
async function replace(path,value){const temp=`${path}.${randomUUID()}.tmp`;try{await writeFile(temp,serialized(value),{flag:'wx'});await rename(temp,path);}finally{await unlink(temp).catch(()=>{});}}

/** verifyAgentReceipt is a REQUIRED trusted coordinator-ledger reader, not a model-supplied verifier.
 * This module makes no provider request and never writes catalog/index/indexIntegrity.
 */
export async function createExternalAnalysisBridge({journalDir,verifyAgentReceipt,producerPolicy}={}){
 check(typeof journalDir==='string'&&journalDir&&typeof verifyAgentReceipt==='function','EXTERNAL_CONFIG','journal and trusted receipt verifier required');
 for(const role of ['analysis','review'])check(short(producerPolicy?.[role]?.model)&&producerPolicy[role].reasoningEffort==='high','EXTERNAL_CONFIG','explicit model/high policy for both agents required');
 const policy=structuredClone(producerPolicy),root=resolve(journalDir),owner=join(root,'owner.json'),nonce=randomUUID();
 await mkdir(root,{recursive:true});
 try{await writeFile(owner,serialized({pid:process.pid,nonce}),{flag:'wx'});}catch(e){
  if(e.code!=='EEXIST')throw e;
  // Serialize stale-owner recovery too: two restarters must not unlink each other's new owner.
  const recovery=join(root,'owner-recovery');
  try{await mkdir(recovery);}catch(err){if(err.code==='EEXIST')throw error('EXTERNAL_JOURNAL_BUSY','journal owner recovery already in progress');throw err;}
  try{
   let stale=false;
   try{const previous=JSON.parse(await readFile(owner,'utf8'));check(Number.isInteger(previous.pid)&&previous.pid>0,'EXTERNAL_JOURNAL_BUSY','invalid journal owner');process.kill(previous.pid,0);}catch(err){stale=err.code==='ESRCH';}
   check(stale,'EXTERNAL_JOURNAL_BUSY','external journal already owned or owner unverifiable');await unlink(owner);await writeFile(owner,serialized({pid:process.pid,nonce}),{flag:'wx'});
  }finally{await rmdir(recovery);}
 }
 try{for(const name of ['artifacts','active','attempts','deliveries','bindings'])await mkdir(join(root,name),{recursive:true});}catch(e){await unlink(owner);throw e;}
 let closed=false,serial=Promise.resolve(),closing;const pending=new Set();
 const open=()=>check(!closed,'EXTERNAL_CLOSED','external bridge closed');
 const transaction=fn=>{const result=serial.then(()=>{open();return fn();});serial=result.catch(()=>{});return result;};
 const json=async path=>JSON.parse(await readFile(path,'utf8'));
 const key=s=>hash(serialized([s.sourceSha256,s.textVersion,s.completeness]));
 const active=async s=>{try{return await json(join(root,'active',key(s)+'.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}};
 const artifact=async id=>{check(/^[a-f0-9]{64}$/.test(id),'EXTERNAL_ARTIFACT','invalid artifact id');const value=await json(join(root,'artifacts',id+'.json'));check(hash(serialized(value))===id,'EXTERNAL_ARTIFACT','artifact bytes changed');return value;};
 async function authenticate(stage,role){
  check(exact(stage,['input','output','receiptId'])&&short(stage.receiptId)&&typeof stage.output==='string'&&Buffer.byteLength(stage.output)<=1_000_000,'EXTERNAL_ARTIFACT','exact bounded stage artifact required');
  const request=parseRequest(stage.input),budget=role==='analysis'?analysisContract(request):null;
  const r=await verifyAgentReceipt(stage.receiptId);
  check(object(r)&&r.receiptId===stage.receiptId&&r.producer==='codex'&&r.status==='completed'&&short(r.agentId)&&r.model===policy[role].model&&r.reasoningEffort==='high'&&r.inputSha256===hash(stage.input)&&r.outputSha256===hash(stage.output),'EXTERNAL_RECEIPT','trusted agent receipt binding mismatch');
  return {producer:'codex',model:r.model,reasoningEffort:r.reasoningEffort,agentId:r.agentId,receiptId:r.receiptId,inputSha256:r.inputSha256,outputSha256:r.outputSha256,...transport(request.maxTokens,budget)};
 }
 async function validate(value){
  const fixed={source:value.source,text:value.text};
  check(hash(fixed.text)===fixed.source.sourceTextSha256&&fixed.source.textVersion===`text-v2-lf-${fixed.source.sourceSha256}`,'EXTERNAL_SOURCE_BINDING','fixed source changed');
  const analysisProducer=await authenticate(value.analysis,'analysis'),ar=parseRequest(value.analysis.input);
  check(value.schemaVersion===budgetEnvelope(analysisContract(ar)),'EXTERNAL_INPUT','artifact version differs from signed analysis budget policy');sourceUser(JSON.parse(ar.user),fixed);
  const inspected=inspectCandidate(value.analysis.output,fixed);let reviewProducer=null,reviewInspection=null;
  if(value.review){
   reviewProducer=await authenticate(value.review,'review');
   check(reviewProducer.agentId!==analysisProducer.agentId,'EXTERNAL_REVIEW_INDEPENDENCE','analysis and review must use different real agents');
   const a=reviewAnalysis(value.analysis.output,fixed),rr=parseRequest(value.review.input);
   const expected={stage:'library-review',...analysisReviewPrompt({text:fixed.text,analysis:a,textVersion:fixed.source.textVersion,declaredCompleteness:fixed.source.completeness}),maxTokens:REVIEW_MAX_TOKENS};
   check(sameRequest(rr,expected),'EXTERNAL_REVIEW_BINDING','review input must bind this complete canonical analysis version and source');
   let rv;try{rv=JSON.parse(value.review.output);}catch{rv=null;}
   reviewInspection=inspectAnalysisReview(rv,a,{requireRubric:true});
  }
  return {analysisVersion:inspected.analysis?.version??null,analysisDiagnostics:inspected.diagnostics,analysisProducer,reviewProducer,reviewInspection};
 }
 const api={
  async registerArtifact({bytes,completeness='unknown',analysis,review=null,expectedArtifactId,schemaVersion=inferredEnvelope(analysis?.input)}={}){
   open();const fixed=fixedSource(bytes,completeness),value={schemaVersion,...fixed,analysis:structuredClone(analysis),review:structuredClone(review)};
   return transaction(async()=>{
    const attemptId=randomUUID();
    // Raw stage strings survive receipt, protocol, CAS and literal failures.
    await immutable(join(root,'attempts',attemptId+'.json'),{kind:'external_artifact_registration',...value});
    try{
     const checked=await validate(value),artifactId=hash(serialized(value)),prior=await active(fixed.source);
     check(!prior||prior.artifactId===artifactId||expectedArtifactId===prior.artifactId,'EXTERNAL_ARTIFACT_CONFLICT','changing a source artifact requires its explicit prior artifact id');
     if(!prior)check(expectedArtifactId===undefined,'EXTERNAL_ARTIFACT_CONFLICT','unexpected prior artifact id');
     await immutable(join(root,'artifacts',artifactId+'.json'),value);
     if(prior?.artifactId!==artifactId)await replace(join(root,'active',key(fixed.source)+'.json'),{artifactId});
     await immutable(join(root,'attempts',attemptId+'.outcome.json'),{status:'registered',artifactId,...checked,providerRequests:0});
     return {artifactId,source:fixed.source,analysisVersion:checked.analysisVersion,analysisDiagnostics:checked.analysisDiagnostics,reviewDiagnostics:checked.reviewInspection?.diagnostics??null,reviewApproved:checked.reviewInspection?.review?.approved??null,duplicate:prior?.artifactId===artifactId};
    }catch(e){await immutable(join(root,'attempts',attemptId+'.outcome.json'),{status:'failed',code:e.code??'EXTERNAL_INVALID',message:e.message,providerRequests:0});throw e;}
   });
  },
  model:{async complete(request){
   open();const work=transaction(()=>deliver(request));pending.add(work);try{return await work;}finally{pending.delete(work);}
  }},
  /** Register first, then call this with an existing service configured with bridge.model. No implicit retry. */
  async importSource(library,{artifactId,bytes,fileName,completeness='unknown',sourceNote=''}={}){
   open();bytes=Buffer.from(bytes);const fixed=fixedSource(bytes,completeness),value=await artifact(artifactId);check(isDeepStrictEqual(fixed,{source:value.source,text:value.text}),'EXTERNAL_SOURCE_BINDING','import source differs from artifact');
   await validate(value);check((await active(fixed.source))?.artifactId===artifactId,'EXTERNAL_ARTIFACT_CONFLICT','only the explicitly active artifact may import');
   let cursor;do{const page=await library.list({cursor,limit:100});const existing=page.items.find(s=>!s.duplicateOf&&s.sourceSha256===fixed.source.sourceSha256);if(existing)return {source:await library.get(existing.sourceId,{includeAnalysis:true}),existing:true,artifactId};cursor=page.nextCursor;}while(cursor);
   const source=await library.importSource({requestId:'codex-external-'+fixed.source.sourceSha256,fileName,bytes,completeness,sourceNote});
   return {source,existing:false,artifactId};
  },
  /** Read the actual service result; caller/model supplied result objects are not accepted. */
  async bindLibraryResult(library,sourceId,{artifactId}={}){
   open();check(typeof library?.get==='function'&&short(sourceId),'EXTERNAL_RESULT_BINDING','library service and sourceId required');
   const detail=await library.get(sourceId,{includeAnalysis:true});
   const value=await artifact(artifactId),checked=await validate(value),a=detail.analysis,r=a?.validation?.semanticReview;
   check(detail.sourceSha256===value.source.sourceSha256&&detail.textVersion===value.source.textVersion&&a?.version===checked.analysisVersion,'EXTERNAL_RESULT_BINDING','service source/canonical version mismatch');
   const restored=structuredClone(a);restored.reviewStatus='candidate';restored.validation.semanticReview=null;delete restored.validation.semanticReviewHistory;
   check(isDeepStrictEqual(restored,reviewAnalysis(value.analysis.output,value)),'EXTERNAL_RESULT_BINDING','service candidate content mismatch');
   check(r?.recordId&&r.method==='model-library-review'&&r.sourceId===(detail.duplicateOf??detail.sourceId)&&r.textVersion===value.source.textVersion&&r.analysisVersion===a.version&&r.responseVersion==='review-response-'+hash(value.review?.output??''),'EXTERNAL_RESULT_BINDING','service review does not bind this raw external review');
   const inspected=checked.reviewInspection?.review;
   check(inspected&&r.approved===inspected.approved&&isDeepStrictEqual(r.checks,inspected.checks)&&isDeepStrictEqual(r.notes,inspected.notes)&&r.rubricVersion===inspected.rubricVersion&&r.outcome===(inspected.approved?'approved':'rejected')&&a.reviewStatus===(inspected.approved?'checked':'needs_review'),'EXTERNAL_RESULT_BINDING','service approval differs from authenticated six-check review');
   const journal=await api.readJournal();
   for(const role of ['analysis','review'])check(journal.deliveries.some(d=>d.status==='released_to_runtime'&&d.role===role&&d.producer?.receiptId===checked[role+'Producer'].receiptId&&d.analysisVersion===a.version),'EXTERNAL_RESULT_BINDING','matching external replay delivery missing');
   const binding={schemaVersion:value.schemaVersion,artifactId,sourceId:r.sourceId,sourceSha256:detail.sourceSha256,textVersion:detail.textVersion,analysisVersion:a.version,reviewRecordId:r.recordId,reviewResponseVersion:r.responseVersion,method:r.method,approved:r.approved,producerProvenance:{source:'codex',execution:'external_replay',providerRequests:0,analysis:checked.analysisProducer,review:checked.reviewProducer}};
   await immutable(join(root,'bindings',hash(serialized([r.sourceId,r.recordId]))+'.json'),binding);
   return {binding,semanticReview:{...structuredClone(r),producerProvenance:binding.producerProvenance}};
  },
  async readJournal(){open();const result={};for(const name of ['attempts','deliveries','bindings'])result[name]=await Promise.all((await readdir(join(root,name))).filter(x=>x.endsWith('.json')).sort().map(f=>json(join(root,name,f))));return result;},
  close(){if(closing)return closing;closed=true;closing=(async()=>{await serial;await Promise.allSettled([...pending]);const current=await json(owner);check(current.nonce===nonce,'EXTERNAL_JOURNAL_BUSY','journal ownership changed');await unlink(owner);})();return closing;},
 };
 async function deliver(request){
   open();request.signal?.throwIfAborted();const trigger=requestValue(request),deliveryId=randomUUID();
   let selected,checked,role;
   try{
    check(['library-analysis','library-review'].includes(request.stage),'EXTERNAL_STAGE','external replay only supports analysis and review');
    role=request.stage==='library-analysis'?'analysis':'review';const user=JSON.parse(request.user);
    const match=/^text-v2-lf-([a-f0-9]{64})$/.exec(user.textVersion);check(match,'EXTERNAL_SOURCE_BINDING','fixed source version required');
    const pointer=await active({sourceSha256:match[1],textVersion:user.textVersion,completeness:user.declaredCompleteness});
    check(pointer,'EXTERNAL_ARTIFACT_MISSING','no registered artifact; runtime request retained for offline preparation');
    selected=await artifact(pointer.artifactId);checked=await validate(selected);sourceUser(user,selected);
    check(selected[role],'EXTERNAL_ARTIFACT_MISSING','independent review artifact not registered');
    let normalized=trigger;
    if(role==='review'){
     const initial=initialFromRuntime(user.analysis,reviewAnalysis(selected.analysis.output,selected));
     normalized={...trigger,user:serialized({...user,analysis:initial})};
    }
    check(sameRequest(normalized,parseRequest(selected[role].input)),'EXTERNAL_REQUEST_BINDING','runtime request differs from the authenticated external input');
    check((await active(selected.source))?.artifactId===pointer.artifactId,'EXTERNAL_ARTIFACT_CONFLICT','active artifact changed during replay');
    open();request.signal?.throwIfAborted();
    await immutable(join(root,'deliveries',deliveryId+'.json'),{kind:'external_replay',status:'released_to_runtime',providerRequests:0,artifactId:pointer.artifactId,role,runtimeRequest:trigger,runtimeRequestSha256:hash(serialized(trigger)),producer:role==='analysis'?checked.analysisProducer:checked.reviewProducer,analysisVersion:checked.analysisVersion});
    open();request.signal?.throwIfAborted();return selected[role].output;
   }catch(e){await immutable(join(root,'deliveries',deliveryId+'.failure.json'),{kind:'external_replay',status:'failed',providerRequests:0,runtimeRequest:trigger,code:e.code??'EXTERNAL_REPLAY_FAILED',message:e.message});throw e;}
 }
 return api;
}
