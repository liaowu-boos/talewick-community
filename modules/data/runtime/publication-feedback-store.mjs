import {createHash, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink, rmdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {isDeepStrictEqual} from 'node:util';

const SCHEMA = 'publication-feedback-v1';
const CATALOG = 'publication-feedback-catalog-v1';
const statuses = {plan_test:'testing',record_result:null,adopt:'provisionally_adopted',reject:'rejected',withdraw:'withdrawn'};
const resultStatuses = {supports:'supported',contradicts:'contradicted',inconclusive:'inconclusive'};
const counts = ['impressions','reads','completions','likes','comments','favorites','follows'];
const publicationKeys = ['workId','workIdentityConfirmed','accountIdentityConfirmed','title','text','textVersionLabel','platform','account','genre','traffic','publishedAt','publicUrl','presentationNote','notes'];
const observationKeys = ['observedAt','windowHours','windowKind','moderation','metrics','metricDefinition','metricsComparable','notes'];
const reviewKeys = ['status','textSha256','observedRevision','inputHash','report','error','rawResponse'];
const decisionKeys = ['reviewId','hypothesisId','planDecisionId','action','reason','plan','result','scope','status','limitations','evidenceBindings'];
const own = (o,k) => Object.hasOwn(o,k);
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o) && [Object.prototype,null].includes(Object.getPrototypeOf(o));
const sha = s => createHash('sha256').update(s).digest('hex');
const error = (code,status,message) => Object.assign(new Error(message),{code,status});
const check = (ok,message='输入字段不合法。') => {if(!ok)throw error('INVALID_INPUT',400,message);};
function keys(o,allowed){check(object(o));check(Object.keys(o).every(k=>allowed.includes(k)),'输入包含未允许的字段。');}
function str(v,max=4000,required=false){
 if(v===undefined&&!required)return '';
 check(typeof v==='string');v=v.trim();check(v.length<=max&&(!required||v.length>0),'文字必填项为空或超过长度限制。');return v;
}
function choice(v,values,fallback){if(v===undefined)v=fallback;check(values.includes(v),'枚举值不合法。');return v;}
function iso(v,nullable=false){
 if(nullable&&(v===undefined||v===null))return null;
 check(typeof v==='string');v=v.trim();
 check(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(v)&&Number.isFinite(Date.parse(v)),'日期须为有效 ISO 时间。');
 const [y,m,d]=v.slice(0,10).split('-').map(Number);
 check(m>=1&&m<=12&&d>=1&&d<=new Date(Date.UTC(y,m,0)).getUTCDate(),'日期不存在。');return v;
}
function hex(v){check(typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),'哈希格式不合法。');return v;}
function list(v,max=200){check(Array.isArray(v)&&v.length<=max,'数组超过限制或格式不合法。');return v;}
function strings(v,max=200){return list(v,max).map(x=>str(x));}
function boolean(v){if(v===undefined)return false;check(typeof v==='boolean','身份确认须为布尔值。');return v;}
function explanations(v){const values=list(v).map(x=>str(x,4000,true));check(values.length>0,'模型须保留非空的替代解释与限制。');return values;}
// Reports and validation evidence have their own module contracts. Preserve their
// JSON structure while bounding storage and rejecting executable/prototype metadata.
function jsonValue(value,depth=0){
 check(depth<=10,'JSON 嵌套过深。');
 if(value===null||typeof value==='boolean')return value;
 if(typeof value==='number'){check(Number.isFinite(value));return value;}
 if(typeof value==='string'){check(value.length<=120000,'JSON 文字过长。');return value;}
 if(Array.isArray(value))return list(value,500).map(v=>jsonValue(v,depth+1));
 check(object(value));check(Object.keys(value).length<=100);
 const result={};for(const [k,v] of Object.entries(value)){
  check(k.length<=200&&!['__proto__','prototype','constructor'].includes(k),'JSON 字段不合法。');result[k]=jsonValue(v,depth+1);
 }return result;
}
function boundedJSON(value){const v=jsonValue(value);check(JSON.stringify(v).length<=500000,'JSON 内容超过存储限制。');return v;}
function copy(value){try{return structuredClone(value);}catch{throw error('INVALID_INPUT',400,'输入须为可保存的JSON数据。');}}
function reportPayload(value,publication){
 keys(value,['schemaVersion','inputHash','summary','observations','hypotheses','limitations']);
 const v=boundedJSON(value);check(v.schemaVersion==='publication-feedback-review-v1');hex(v.inputHash);v.summary=str(v.summary,4000,true);
 const observationIds=new Set(publication.observations.map(o=>o.id));
 const refs=ids=>list(ids).map(id=>{id=str(id,200,true);check(observationIds.has(id),'报告引用了不属于本稿的观察。');return id;});
 const quote=q=>{check(typeof q==='string'&&q.length>0&&q.length<=120000&&publication.text.includes(q),'报告引文不属于固定正文。');return q;};
 v.observations=list(v.observations).map(o=>{keys(o,['kind','statement','observationIds','quote']);return {
  kind:choice(o.kind,['platform','distribution','reading','text']),statement:str(o.statement,4000,true),observationIds:refs(o.observationIds),quote:o.quote===null?null:quote(o.quote)};});
 const seen=new Set();v.hypotheses=list(v.hypotheses).map(h=>{
  keys(h,['id','claim','observationIds','quotes','alternatives','limitations','testPlan']);const id=str(h.id,200,true);check(!seen.has(id),'假说标识重复。');seen.add(id);
  keys(h.testPlan,['change','keepFixed','targetMetric','successCriterion']);return {id,claim:str(h.claim,4000,true),observationIds:refs(h.observationIds),quotes:list(h.quotes).map(quote),
   alternatives:explanations(h.alternatives),limitations:explanations(h.limitations),testPlan:Object.fromEntries(['change','keepFixed','targetMetric','successCriterion'].map(k=>[k,str(h.testPlan[k],4000,true)]))};
 });v.limitations=explanations(v.limitations);return v;
}
function createPayload(p){
 keys(p,publicationKeys);
 check(typeof p.text==='string'&&p.text.trim().length>0&&p.text.length<=120000,'正文为空或超过120000字符。');
 const publicUrl=p.publicUrl===undefined||p.publicUrl===null?null:str(p.publicUrl,4000,true);
 if(publicUrl!==null){let u;try{u=new URL(publicUrl);}catch{check(false,'公开链接格式不合法。');}
  check(['http:','https:'].includes(u.protocol)&&!u.username&&!u.password,'公开链接仅支持不含凭据的 HTTP(S) 地址。');}
 return {workId:str(p.workId,200,true),workIdentityConfirmed:boolean(p.workIdentityConfirmed),accountIdentityConfirmed:boolean(p.accountIdentityConfirmed),title:str(p.title,200,true),text:p.text,textVersionLabel:str(p.textVersionLabel,200),
  platform:str(p.platform,200,true),account:str(p.account,200,true),genre:str(p.genre,200),
  traffic:choice(p.traffic,['organic','paid','unknown'],'unknown'),publishedAt:iso(p.publishedAt,true),publicUrl,
  presentationNote:str(p.presentationNote),notes:str(p.notes)};
}
function observation(p,publication){
 keys(p,observationKeys);const observedAt=iso(p.observedAt);
 check(!publication.publishedAt||Date.parse(observedAt)>=Date.parse(publication.publishedAt),'观察时间不能早于发布时间。');
 const windowHours=p.windowHours===undefined||p.windowHours===null?null:p.windowHours;
 check(windowHours===null||(typeof windowHours==='number'&&Number.isFinite(windowHours)&&windowHours>0),'观察窗口须为正数或null。');
 const m=p.moderation??{};keys(m,['status','reason','category']);const metrics=p.metrics??{};keys(metrics,counts);
 const normalized={};for(const k of counts){const v=metrics[k]===undefined?null:metrics[k];check(v===null||(Number.isSafeInteger(v)&&v>=0),'指标须为非负安全整数或null。');normalized[k]=v;}
 const metricDefinition=str(p.metricDefinition),metricsComparable=p.metricsComparable===undefined?false:p.metricsComparable;
 check(typeof metricsComparable==='boolean');check(!metricsComparable||metricDefinition,'确认可比前须填写指标口径。');
 return {observedAt,windowHours,windowKind:choice(p.windowKind,['since_publication','unknown'],'unknown'),moderation:{status:choice(m.status,['unknown','pending','approved','rejected','changes_requested'],'unknown'),
  reason:str(m.reason),category:choice(m.category,['unknown','format','content_restriction','genre_fit','editorial_quality','other'],'unknown')},
 metrics:normalized,metricDefinition,metricsComparable,notes:str(p.notes)};
}
function review(p,publication,currentRevision){
 keys(p,reviewKeys);check(publication.observations.length>0,'没有发布观察，不能保存复盘。');
 const status=choice(p.status,['completed','failed']);
 check(hex(p.textSha256)===publication.textSha256,'复盘正文版本不匹配。');
 check(Number.isSafeInteger(p.observedRevision)&&p.observedRevision===currentRevision,'复盘观察版本已过期。');
 const v={status,textSha256:p.textSha256,observedRevision:p.observedRevision,inputHash:hex(p.inputHash)};
 if(status==='completed'){
  check(!own(p,'error'),'完成记录不能携带失败字段。');check(object(p.report),'复盘报告不能为空。');
  v.report=reportPayload(p.report,publication);check(v.report.inputHash===v.inputHash,'报告版本或输入绑定不匹配。');
 }else{
  check(!own(p,'report'),'失败记录不能携带已完成报告。');keys(p.error,['code','message']);
  const code=str(p.error.code,100,true);check(/^[A-Z][A-Z0-9_]*$/.test(code),'错误代码不合法。');
  // Provider errors may contain config or credentials: never echo arbitrary messages.
  str(p.error.message);v.error={code,message:'复盘未完成，请检查配置或稍后显式重试。'};
 }
 if(own(p,'rawResponse')){check(typeof p.rawResponse==='string'&&p.rawResponse.length<=1000000,'原始响应超过限制。');v.rawResponse=p.rawResponse;}
 return v;
}
function decision(p,publication){
 keys(p,decisionKeys);const action=choice(p.action,Object.keys(statuses));
 const reviewId=str(p.reviewId,200,true),hypothesisId=str(p.hypothesisId,200,true);
 const r=publication.reviews.find(r=>r.id===reviewId&&r.status==='completed');
 check(r&&Array.isArray(r.report?.hypotheses)&&r.report.hypotheses.some(h=>h.id===hypothesisId),'找不到已完成复盘中的假说。');
 // This internal API takes VALIDATION's evaluated envelope, not browser input.
 // status alone never promotes a hypothesis; derive it from the evaluated action.
 check(own(p,'status')&&own(p,'limitations')&&own(p,'evidenceBindings'),'决策须先由验证模块评估。');
 const v={reviewId,hypothesisId,action,reason:str(p.reason,4000,true)};
 if(own(p,'planDecisionId'))v.planDecisionId=str(p.planDecisionId,200,true);
 if(['record_result','adopt'].includes(action)){
  check(v.planDecisionId,'后续结果或暂时采用必须绑定具体计划。');
  check(publication.decisions.some(d=>d.id===v.planDecisionId&&d.action==='plan_test'&&d.reviewId===reviewId&&d.hypothesisId===hypothesisId),'计划不属于所选复盘假说。');
 }
 if(own(p,'plan')){keys(p.plan,['change','keepFixed','targetMetric','successCriterion','baselinePublicationIds','criterion']);v.plan={
  change:str(p.plan.change,4000,true),keepFixed:str(p.plan.keepFixed,4000,true),targetMetric:str(p.plan.targetMetric,4000,true),
  successCriterion:str(p.plan.successCriterion,4000,true),baselinePublicationIds:list(p.plan.baselinePublicationIds).map(x=>str(x,200,true))};
  if(own(p.plan,'criterion')){keys(p.plan.criterion,['kind','value']);v.plan.criterion={kind:choice(p.plan.criterion.kind,['increase','decrease','at_least','at_most','approved'])};
   if(own(p.plan.criterion,'value')){check(typeof p.plan.criterion.value==='number'&&Number.isFinite(p.plan.criterion.value),'判据数值须为有限数字。');v.plan.criterion.value=p.plan.criterion.value;}
  }
 }
 if(own(p,'result')){keys(p.result,['publicationIds','conclusion','note']);v.result={publicationIds:list(p.result.publicationIds).map(x=>str(x,200,true)),
  conclusion:choice(p.result.conclusion,Object.keys(resultStatuses)),note:str(p.result.note)};}
 if(own(p,'scope'))v.scope=str(p.scope);
 check(action!=='plan_test'||v.plan,'验证计划不能为空。');check(action!=='record_result'||v.result,'后续结果不能为空。');
 check(action!=='adopt'||v.scope,'暂时采用必须说明适用范围。');
 const status=action==='record_result'?resultStatuses[v.result.conclusion]:statuses[action];check(p.status===status,'决策状态与操作不一致。');
 v.status=status;v.limitations=strings(p.limitations);
 check(object(p.evidenceBindings)||Array.isArray(p.evidenceBindings),'证据绑定须为JSON对象或数组。');
 v.evidenceBindings=boundedJSON(p.evidenceBindings);
 check(action!=='adopt'||Object.keys(v.evidenceBindings).length>0,'暂时采用缺少冻结证据绑定。');
 return v;
}
function publicPublication(p){const v=structuredClone(p);for(const r of v.reviews)delete r.rawResponse;return v;}
function validateCatalog(db){
 keys(db,['schemaVersion','publications']);check(db.schemaVersion===CATALOG);list(db.publications,10000);
 const ids=new Set();const identity=v=>{check(typeof v.id==='string'&&/^[0-9a-f-]{36}$/.test(v.id)&&!ids.has(v.id));ids.add(v.id);iso(v.createdAt);};
 for(const p of db.publications){
  keys(p,['schemaVersion','id','revision','createdAt','updatedAt',...publicationKeys,'textSha256','chars','observations','reviews','decisions']);
  check(p.schemaVersion===SCHEMA);identity(p);iso(p.updatedAt);
  const payload=Object.fromEntries(publicationKeys.map(k=>[k,p[k]]));check(isDeepStrictEqual(payload,createPayload(payload)));
  check(p.textSha256===sha(p.text)&&p.chars===p.text.length);
  list(p.observations,10000);list(p.reviews,10000);list(p.decisions,10000);
  check(p.revision===1+p.observations.length+p.reviews.length+p.decisions.length,'历史数量与版本不一致。');
  for(const o of p.observations){identity(o);keys(o,['id','createdAt',...observationKeys]);const payload=Object.fromEntries(observationKeys.map(k=>[k,o[k]]));check(isDeepStrictEqual(payload,observation(payload,p)));}
  for(const r of p.reviews){identity(r);keys(r,['id','createdAt',...reviewKeys]);check(r.observedRevision>=2&&r.observedRevision<p.revision);const {id,createdAt,...payload}=r;check(isDeepStrictEqual(payload,review(payload,p,r.observedRevision)));}
  for(const d of p.decisions){identity(d);keys(d,['id','createdAt',...decisionKeys]);const {id,createdAt,...payload}=d;check(isDeepStrictEqual(payload,decision(payload,p)));}
 }return db;
}

/** Dedicated catalog only. Decision business gates remain owned by VALIDATION. */
export async function createPublicationFeedbackStore({rootDir}={}){
 check(typeof rootDir==='string'&&rootDir.trim(),'必须指定独立存储目录。');
 const root=resolve(rootDir),owner=join(root,'owner.json'),catalog=join(root,'catalog.json'),nonce=randomUUID();
 const storageError=()=>error('STORAGE_FAILED',503,'发布复盘存储失败，原记录已保留。');
 await mkdir(root,{recursive:true}).catch(()=>{throw storageError();});
 const claim=()=>writeFile(owner,JSON.stringify({pid:process.pid,nonce}),{flag:'wx'});
 try{await claim();}catch(e){
  if(e.code!=='EEXIST')throw storageError();
  const recovery=join(root,'owner-recovery');
  try{await mkdir(recovery);}catch{throw error('STORE_BUSY',409,'发布复盘目录已被占用。');}
  try{
   const old=JSON.parse(await readFile(owner,'utf8'));check(Number.isSafeInteger(old.pid)&&old.pid>0);
   let dead=false;try{process.kill(old.pid,0);}catch(e){dead=e.code==='ESRCH';}
   if(!dead)throw error('STORE_BUSY',409,'发布复盘目录已被占用。');
   await unlink(owner);await claim();
  }catch(e){throw e.code==='STORE_BUSY'?e:error('STORE_BUSY',409,'无法安全确认旧存储锁，未接管目录。');}
  finally{await rmdir(recovery).catch(()=>{});}
 }
 async function atomic(value){
  const temp=join(root,`catalog.${randomUUID()}.tmp`);
  try{await writeFile(temp,JSON.stringify(value),{flag:'wx'});await rename(temp,catalog);}
  finally{await unlink(temp).catch(()=>{});}
 }
 const release=async()=>{const held=JSON.parse(await readFile(owner,'utf8'));if(held.nonce!==nonce)throw error('STORE_BUSY',409,'存储锁归属发生变化。');await unlink(owner);};
 let db;
 try{
  let raw;try{raw=await readFile(catalog,'utf8');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(raw===undefined){db={schemaVersion:CATALOG,publications:[]};await atomic(db);}
  else{try{db=validateCatalog(JSON.parse(raw));}catch{throw error('STORE_CORRUPT',503,'发布复盘历史校验失败，未覆盖原文件。');}}
 }catch(e){await release().catch(()=>{});throw e.code==='STORE_CORRUPT'?e:storageError();}
 let tail=Promise.resolve(),closed=false,closing;
 const open=()=>{if(closed)throw error('STORE_CLOSED',503,'发布复盘存储已关闭。');};
 const find=(state,id)=>{check(typeof id==='string'&&id.length<=200,'记录标识不合法。');const p=state.publications.find(p=>p.id===id);if(!p)throw error('NOT_FOUND',404,'发布记录不存在。');return p;};
 function mutate(fn){
  open();const task=tail.then(async()=>{
   const next=structuredClone(db),result=fn(next);
   try{await atomic(next);}catch{throw storageError();}
   db=next;return publicPublication(result);
  });tail=task.catch(()=>{});return task;
 }
 const read=fn=>{open();return tail.then(()=>fn(db));};
 function append(id,payload,options,field,normalize){
  const saved=copy(payload),opts=copy(options); // Caller mutation cannot race queued validation.
  return mutate(state=>{
   keys(opts,['expectedRevision']);check(Number.isSafeInteger(opts.expectedRevision)&&opts.expectedRevision>=1,'必须提供当前版本号。');
   const p=find(state,id);if(opts.expectedRevision!==p.revision)throw error('REVISION_CONFLICT',409,'记录已更新，请重新读取后再保存。');
   check(p[field].length<10000,'历史记录数量达到本期上限。');
   const value=normalize(saved,p,p.revision),at=new Date().toISOString();
   p[field].push({id:randomUUID(),createdAt:at,...value});p.revision++;p.updatedAt=at;return p;
  });
 }
 return {
  async listPublications(){return read(state=>state.publications.map(p=>{
   const {text,observations,reviews,decisions,...summary}=p;
   return {...structuredClone(summary),observationCount:observations.length,reviewCount:reviews.length,decisionCount:decisions.length};
  }));},
  async getPublication(id){return read(state=>publicPublication(find(state,id)));},
  async createPublication(payload){const saved=copy(payload);return mutate(state=>{
   check(state.publications.length<10000,'发布记录数量达到本期上限。');const value=createPayload(saved),at=new Date().toISOString();
   const p={schemaVersion:SCHEMA,id:randomUUID(),revision:1,createdAt:at,updatedAt:at,...value,
    textSha256:sha(value.text),chars:value.text.length,observations:[],reviews:[],decisions:[]};state.publications.push(p);return p;
  });},
  async addObservation(id,payload,options){return append(id,payload,options,'observations',observation);},
  async addReview(id,payload,options){return append(id,payload,options,'reviews',review);},
  async addDecision(id,payload,options){return append(id,payload,options,'decisions',decision);},
  close(){if(closing)return closing;closed=true;closing=tail.then(()=>release()).catch(e=>{throw e.status?e:storageError();});return closing;},
 };
}
