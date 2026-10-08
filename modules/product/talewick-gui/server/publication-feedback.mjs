const fail=(code,message,status=400)=>Object.assign(new Error(message),{code,status});
const object=(v,keys)=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw fail('INVALID_INPUT','请求字段不正确。');};
const revision=v=>{if(!Number.isSafeInteger(v)||v<1)throw fail('INVALID_INPUT','请提供当前记录版本。');};
const safeReview=r=>{const {rawResponse,...safe}=r;return safe;};
const safePublication=p=>({...p,reviews:p.reviews.map(safeReview)});
export async function createPublicationFeedbackService({rootDir,model,configured=()=>true,adapters}={}){
 const a=adapters??Object.assign({},await import('../../../data/runtime/publication-feedback-store.mjs'),await import('../../../validation/runtime/publication-feedback.mjs'),await import('../../../creation/runtime/publication-feedback.mjs'));
 const store=await a.createPublicationFeedbackStore({rootDir});const active=new Map();let closed=false;
 const open=()=>{if(closed)throw fail('SERVICE_CLOSED','服务已关闭，请刷新后重试。',503);};
 const get=async id=>{open();return store.getPublication(id);};
 const expect=(p,v)=>{revision(v);if(p.revision!==v)throw fail('VERSION_CONFLICT','记录已更新，请刷新后依据最新观察重试。',409);};
 const evidence=async(p,input)=>{const ids=input.action==='plan_test'?input.plan?.baselinePublicationIds:input.action==='record_result'?input.result?.publicationIds:[];if(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!id.trim()||id.trim().length>200)||new Set(ids.map(id=>id.trim())).size!==ids.length)throw fail('INVALID_INPUT','证据须为最多 100 条不同的发布记录标识。');return Promise.all(ids.map(id=>id.trim()).filter(id=>id!==p.id).map(id=>store.getPublication(id)));};
 return {
  list:async()=>{open();return store.listPublications();},
  create:async payload=>{open();return safePublication(await store.createPublication(payload));},
  get:async id=>{const p=await get(id);return {publication:safePublication(p),assessment:a.assessPublication(p)};},
  observe:async(id,body)=>{object(body,['expectedRevision','observation']);revision(body.expectedRevision);open();const p=await store.addObservation(id,body.observation,{expectedRevision:body.expectedRevision});return {publication:safePublication(p),assessment:a.assessPublication(p)};},
  compare:async body=>{object(body,['publicationIds']);if(!Array.isArray(body.publicationIds)||body.publicationIds.length<2||body.publicationIds.length>50||body.publicationIds.some(id=>typeof id!=='string'||!id)||new Set(body.publicationIds).size!==body.publicationIds.length)throw fail('INVALID_INPUT','请选择 2–50 条不同的发布记录。');return a.comparePublications(await Promise.all(body.publicationIds.map(get)));},
  decide:async(id,body)=>{object(body,['expectedRevision','decision']);const p=await get(id);expect(p,body.expectedRevision);const input=body.decision;object(input,['reviewId','hypothesisId','action','reason','plan','result','scope','planDecisionId']);const decision=a.evaluateDecision({publication:p,reviewId:input.reviewId,hypothesisId:input.hypothesisId,input,publications:await evidence(p,input),now:new Date().toISOString()});return safePublication(await store.addDecision(id,decision,{expectedRevision:body.expectedRevision}));},
  brief:async(id,reviewId,hypothesisId)=>{const p=await get(id);return a.feedbackExperimentBrief({publication:p,reviewId,hypothesisId});},
  review:async(id,body)=>{
   object(body,['expectedRevision']);const p=await get(id);expect(p,body.expectedRevision);
   if(!configured())throw fail('MODEL_UNAVAILABLE','模型尚未配置；仍可保存发布信息和观察。',503);
   if(!p.observations.length)throw fail('OBSERVATION_REQUIRED','先追加实际审核或指标观察，再进行复盘。');
   if(active.has(id))throw fail('REVIEW_BUSY','此记录正在复盘，请等待当前复盘结束。',409);
   const controller=new AbortController();let done;const settled=new Promise(r=>{done=r;});active.set(id,{controller,settled});
   try{
    const assessment=a.assessPublication(p),comparison=a.comparePublications([p]);
    const request=a.buildPublicationFeedbackRequest({publication:p,assessment,comparison});
    let result;
    try{result=await a.analyzePublicationFeedback({publication:p,assessment,comparison,model,signal:controller.signal});}
    catch{result={status:'failed',textSha256:p.textSha256,observedRevision:p.revision,inputHash:request.inputHash,error:{code:'REVIEW_FAILED',message:'本次复盘未完成；原稿和观察已保留，请检查模型配置后显式重试。'}};}
    // CAS deliberately discards a stale result instead of rewriting a newer observation.
    const saved=await store.addReview(id,result,{expectedRevision:p.revision});
    const review=saved.reviews.at(-1);return {publication:safePublication(saved),review:safeReview(review)};
   }finally{active.delete(id);done();}
  },
  async close(){if(closed)return;closed=true;for(const job of active.values())job.controller.abort();await Promise.allSettled([...active.values()].map(j=>j.settled));await store.close();},
 };
}
export function createPublicationFeedbackRouter({service,json,bodyJSON}){
 return async(req,res,url)=>{
  if(!url.pathname.startsWith('/api/publication-feedback'))return false;
  try{
   const route=url.pathname.slice('/api/publication-feedback'.length);
   if(route===''&&req.method==='GET')json(res,200,{publications:await service.list()});
   else if(route===''&&req.method==='POST')json(res,201,{publication:await service.create(await bodyJSON(req))});
   else if(route==='/compare'&&req.method==='POST')json(res,200,{comparison:await service.compare(await bodyJSON(req))});
   else{
    const match=route.match(/^\/([\w-]{1,160})(?:\/(observations|reviews|decisions|brief))?$/);if(!match)throw fail('NOT_FOUND','找不到这条发布记录。',404);
    const [,id,action]=match;
    if(!action&&req.method==='GET')json(res,200,await service.get(id));
    else if(action==='brief'&&req.method==='GET')json(res,200,{brief:await service.brief(id,url.searchParams.get('reviewId'),url.searchParams.get('hypothesisId'))});
    else if(req.method==='POST'&&action==='observations')json(res,200,await service.observe(id,await bodyJSON(req)));
    else if(req.method==='POST'&&action==='reviews')json(res,200,await service.review(id,await bodyJSON(req)));
    else if(req.method==='POST'&&action==='decisions')json(res,200,{publication:await service.decide(id,await bodyJSON(req))});
    else throw fail('METHOD_NOT_ALLOWED','此入口不支持当前操作。',405);
   }
  }catch(e){const status=Number.isInteger(e.status)&&e.status>=400&&e.status<600?e.status:500;json(res,status,{error:status===500?'发布复盘服务暂时不可用；已保存的记录不受影响。':e.message,code:status===500?'INTERNAL_ERROR':e.code});}
  return true;
 };
}
