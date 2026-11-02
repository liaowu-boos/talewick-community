import {createHash} from 'node:crypto';
import {buildDeepReferenceComparison} from './deep-reference-comparison.mjs';
import {DEEP_REFERENCE_LIMITS,DEEP_REFERENCE_QUERY_VERSION,
  DEEP_REFERENCE_CONCEPT_ALIAS_POLICIES,describeDeepReferenceConceptQuery} from './deep-reference-layer.mjs';

export const COMPONENT_FALLBACK_VERSION = 'analysis99-component-query-fallback-1';
export const COMPONENT_FALLBACK_POLICY_VERSION = 'whole-quality-component-fallback-policy-1';
export const COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION = 'whole-quality-component-fallback-policy-2';
const object = value => value !== null && typeof value === 'object'
  && [Object.prototype,null].includes(Object.getPrototypeOf(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : object(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key,canonical(value[key])])) : value;
function jsonValue(value,depth=0,seen=new Set()) {
  if (depth>40) throw Object.assign(new Error('JSON nesting limit'),{code:'JSON_SHAPE'});
  if (value===null || typeof value==='string' || typeof value==='boolean' || typeof value==='number'&&Number.isFinite(value)) return;
  if ((!object(value)&&!Array.isArray(value)) || seen.has(value)) throw Object.assign(new Error('Expected finite acyclic JSON data'),{code:'JSON_SHAPE'});
  if(Array.isArray(value)&&(Object.keys(value).length!==value.length||!Array.from({length:value.length},(_,i)=>Object.hasOwn(value,i)).every(Boolean)))
    throw Object.assign(new Error('Sparse/extended arrays are not JSON data'),{code:'JSON_SHAPE'});
  seen.add(value);
  for(const [key,item] of Object.entries(value)) {
    if(['__proto__','constructor','prototype'].includes(key)) throw Object.assign(new Error('Unsafe JSON key'),{code:'JSON_SHAPE'});
    jsonValue(item,depth+1,seen);
  }
  seen.delete(value);
}
export const fingerprint = value => {jsonValue(value);return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');};
const clone = value => structuredClone(value);
const equal = (a,b) => fingerprint(a) === fingerprint(b);
const requireThat = (value, code, message) => {
  if (!value) throw Object.assign(new Error(message), {code});
};
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const SHA=/^[a-f0-9]{64}$/u;
const keys=(value,allowed,code)=>requireThat(object(value)&&Object.keys(value).every(key=>allowed.includes(key)),code,'Unknown or invalid fields');
const range=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const strings=(value,max=20,length=4000)=>Array.isArray(value)&&value.length<=max&&value.every(s=>text(s)&&s.length<=length);
const unique=value=>new Set(value).size===value.length;
const normalized = request => ({problem:clone(request.problem),dimensions:clone(request.dimensions),sourceIds:request.sourceIds ?? null,
  limit:request.limit,maxFunctionsPerResult:request.maxFunctionsPerResult,maxEvidenceRefsPerResult:request.maxEvidenceRefsPerResult});
const noFallback = new Set(['not_queried','unavailable','not_supplied','not_assessed','not_adopted','applicable_exists']);
const facets = new Set(['target_mechanism','cost_mechanism','recognition_mechanism','action_mechanism']);
const boundary = 'only_component只表示子机制词面候选；演员、方向、承认对象、代价承担者、前提和完整目标适用性仍待核对。查询/供应不等于采用；无命中不能证明全库不存在。';

function validateRequest(request) {
  keys(request,['problem','dimensions','sourceIds','limit','maxFunctionsPerResult','maxEvidenceRefsPerResult'],'PARENT_REQUEST');
  jsonValue(request);
  const p=request.problem;
  keys(p,['problemId','statement','searchTerms','requiredTermGroups','context','conceptAliasPolicy'],'PARENT_PROBLEM');
  validateConceptPolicy(p);
  requireThat(text(p.problemId)&&p.problemId.length<=160&&text(p.statement)&&p.statement.length<=2000
    && strings(p.searchTerms,20,80)&&p.searchTerms.length>=2&&unique(p.searchTerms)
    && Array.isArray(p.requiredTermGroups)&&p.requiredTermGroups.length<=6
    && p.requiredTermGroups.every(g=>strings(g,12,80)&&g.length>0&&unique(g)&&g.every(t=>p.searchTerms.includes(t))),
  'PARENT_PROBLEM','Full goal problem must be explicit and bounded');
  if(p.context!==undefined) {
    requireThat(object(p.context)&&JSON.stringify(p.context).length<=16000,'PARENT_CONTEXT','Goal context must be bounded JSON');
  }
  requireThat(Array.isArray(request.dimensions)&&request.dimensions.length>0&&unique(request.dimensions)
    && request.dimensions.every(d=>['emotionalProgression','psychologicalChangeDrivers','observableCraftDecisionHypotheses'].includes(d))
    && range(request.limit,1,DEEP_REFERENCE_LIMITS.maxResults)
    && range(request.maxFunctionsPerResult,1,DEEP_REFERENCE_LIMITS.maxFunctionsPerResult)
    && range(request.maxEvidenceRefsPerResult,1,DEEP_REFERENCE_LIMITS.maxEvidenceRefsPerResult),
  'REQUEST_LIMIT','Explicit DATA bounds and dimensions required');
  requireThat(request.sourceIds===undefined||request.sourceIds===null
    ||strings(request.sourceIds,99,160)&&request.sourceIds.length>0&&unique(request.sourceIds),'REQUEST_SCOPE','Invalid source scope');
}

function validateConceptPolicy(value) {
  if (!Object.hasOwn(value,'conceptAliasPolicy')) return;
  requireThat(typeof value.conceptAliasPolicy==='string'
    &&Object.hasOwn(DEEP_REFERENCE_CONCEPT_ALIAS_POLICIES,value.conceptAliasPolicy),
  'COMPONENT_CONCEPT_POLICY','Unknown explicit concept alias policy');
}

function validateComponents(components,allowConceptAliases=false) {
  requireThat(Array.isArray(components)&&components.length>=1&&components.length<=3,'COMPONENT_LIMIT','必须显式声明1–3个子机制');
  const ids=new Set();
  for(const c of components) {
    keys(c,['id','facet','statement','searchTerms','requiredTermGroups',...(allowConceptAliases?['conceptAliasPolicy']:[])],'COMPONENT_FIELDS');
    validateConceptPolicy(c);
    requireThat(text(c.id)&&/^[a-z0-9][a-z0-9-]{0,63}$/u.test(c.id)&&!ids.has(c.id),'COMPONENT_ID','子机制id必须唯一');ids.add(c.id);
    requireThat(facets.has(c.facet)&&text(c.statement)&&c.statement.length<=1900,'COMPONENT_SCOPE','需要明确子机制类型及陈述');
    requireThat(strings(c.searchTerms,12,80)&&c.searchTerms.length>=2&&unique(c.searchTerms),'COMPONENT_TERMS','子机制需要2–12个明确正向词');
    requireThat(Array.isArray(c.requiredTermGroups)&&c.requiredTermGroups.length>=1&&c.requiredTermGroups.length<=4
      &&c.requiredTermGroups.every(g=>strings(g,12,80)&&g.length>0&&unique(g)&&g.every(t=>c.searchTerms.includes(t))),
    'COMPONENT_GROUPS','子机制必要词组须来自其正向词');
  }
}

export function validateComponentFallbackPolicy(policy) {
  if(policy===undefined) return null;
  keys(policy,['schemaVersion','enabled','components'],'COMPONENT_POLICY');
  requireThat([COMPONENT_FALLBACK_POLICY_VERSION,COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION].includes(policy.schemaVersion)
    &&typeof policy.enabled==='boolean','COMPONENT_POLICY','Policy version and boolean enabled are required');
  validateComponents(policy.components,policy.schemaVersion===COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION);
  return clone(policy);
}

export function buildComponentQueries({originalRequest, components, policyVersion=COMPONENT_FALLBACK_POLICY_VERSION}) {
  requireThat([COMPONENT_FALLBACK_POLICY_VERSION,COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION].includes(policyVersion),'COMPONENT_POLICY','Unknown component policy version');
  validateRequest(originalRequest);validateComponents(components,policyVersion===COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION);
  return components.map(component => {
    const terms = component.searchTerms, groups = component.requiredTermGroups;
    // A component opts in itself; the full goal's lexical policy is not inherited.
    const {conceptAliasPolicy:parentConceptPolicy,...parentProblem}=clone(originalRequest.problem);
    const request = {...clone(originalRequest), problem:{...parentProblem,
      problemId:`component-${fingerprint({parent:originalRequest.problem.problemId,component}).slice(0,16)}-${component.id}`,
      statement:`仅查询目标子机制：${component.statement}`,
      searchTerms:clone(terms), requiredTermGroups:clone(groups),
      ...(component.conceptAliasPolicy===undefined?{}:{conceptAliasPolicy:component.conceptAliasPolicy})}};
    const originalGroups = originalRequest.problem.requiredTermGroups ?? [];
    return {component:clone(component), matchScope:'only_component', request,
      parentProblemId:originalRequest.problem.problemId,
      parentGroupsNotRequiredForThisComponent:clone(originalGroups.filter(group => !groups.some(g => equal(g,group)))),
      preservedContext:clone(originalRequest.problem.context ?? null),
      boundary:'不再作为本子查询门槛，不代表完整目标的该阶段已获证据支持。'};
  });
}

function validateResponse(response, request) {
  jsonValue(response);
  keys(response,['schemaVersion','queryId','installId','request','matchingPolicy','status','resultCount','limits','boundary','retrievalIsUse','requiresExplicitAdoption','results'],'RESPONSE_FIELDS');
  requireThat(JSON.stringify(response).length<=2000000,'RESPONSE_SIZE','Query response exceeds bounded data contract');
  requireThat(response?.schemaVersion === DEEP_REFERENCE_QUERY_VERSION && text(response.queryId)
    && text(response.installId) && Array.isArray(response.results) && response.resultCount === response.results.length
    && response.resultCount <= request.limit && response.status === (response.resultCount ? 'covered' : 'uncovered')
    && equal(response.request,normalized(request)), 'RESPONSE_BINDING', '返回合同、原请求或计数不一致');
  requireThat(response.retrievalIsUse === false && response.requiresExplicitAdoption === true,
    'RESPONSE_STATE', '不得把查询提升为采用');
  const expectedQueryId='deepref-query-'+createHash('sha256').update(`${JSON.stringify({installId:response.installId,request:response.request},null,2)}\n`).digest('hex');
  requireThat(response.queryId===expectedQueryId,'RESPONSE_QUERY_ID','Query id does not bind the installed source/request');
  const conceptPlan=describeDeepReferenceConceptQuery(request.problem);
  requireThat(object(response.matchingPolicy)&&response.matchingPolicy.version===(conceptPlan?.version??'analysis99-positive-function-fields-1')
    &&strings(response.matchingPolicy.effectiveSearchTerms,20,80)
    &&response.matchingPolicy.effectiveSearchTerms.every(term=>request.problem.searchTerms.includes(term)),
  'RESPONSE_MATCH_POLICY','Positive match terms must belong to this request');
  if(conceptPlan) {
    requireThat(Object.entries(conceptPlan).filter(([key])=>key!=='minimumMatchedTerms')
      .every(([key,value])=>response.matchingPolicy[key]!==undefined&&equal(response.matchingPolicy[key],value)),
    'RESPONSE_CONCEPT_POLICY','Returned alias vocabulary, scoring units or threshold policy differs from the request');
  } else requireThat(response.matchingPolicy.conceptAliasPolicy===undefined,'RESPONSE_MATCH_POLICY','Literal query cannot consume an aliased response');
  // Reuse the existing strict complete-function/evidence contract without
  // assigning any suitability verdict or injecting explanatory evidence notes.
  buildDeepReferenceComparison({response,evidenceNotes:[]});
  const identities = new Set();
  for (const result of response.results) {
    keys(result,['referenceId','source','analysis','semanticReview','match','borrowableWritingFunctions','exactReferences','limits','retrievalIsUse','requiresExplicitAdoption'],'RESULT_FIELDS');
    requireThat(text(result.referenceId) && !identities.has(result.referenceId), 'DUPLICATE_RESULT', '来源重复');
    identities.add(result.referenceId);
    requireThat(result.analysis?.candidateStatus === 'candidate_unreviewed' && result.analysis.approved === false
      && result.analysis.checked === false && result.analysis.active === false
      && result.semanticReview?.approvalGranted === false && result.semanticReview.activeProductionChanged === false
      && text(result.semanticReview.verdict) && !/(?:reject|unsupported|fail|invalid)/u.test(result.semanticReview.verdict.toLowerCase())
      && result.retrievalIsUse === false && result.requiresExplicitAdoption === true,
    'CANDIDATE_STATE', '来源必须保留未批准状态');
    requireThat(['analysisId','originalReviewRecordId'].every(key=>text(result.analysis[key]))
      &&(result.analysis.analysisContentVersion===null||text(result.analysis.analysisContentVersion))
      &&text(result.semanticReview.reportPath),'ANALYSIS_BINDING','Original analysis/review identities are required');
    requireThat(request.sourceIds==null||request.sourceIds.includes(result.source.sourceId),
      'RESULT_SCOPE','Returned source is outside the original query scope');
    requireThat(result.match?.semanticSimilarityClaimed===false,'MATCH_STATE','Lexical matches cannot claim semantic suitability');
    if(conceptPlan) validateConceptScores(result,conceptPlan);
    requireThat(Array.isArray(result.borrowableWritingFunctions) && result.borrowableWritingFunctions.length > 0
      && Array.isArray(result.exactReferences), 'FUNCTION_SHAPE', '需要完整功能和证据');
    requireThat(result.borrowableWritingFunctions.length<=request.maxFunctionsPerResult
      &&result.exactReferences.length<=request.maxEvidenceRefsPerResult
      &&result.exactReferences.reduce((n,ref)=>n+ref.quote.length,0)<=DEEP_REFERENCE_LIMITS.maxEvidenceCharsPerResult
      &&result.borrowableWritingFunctions.every(fn=>request.dimensions.includes(fn.dimension)),
    'RESULT_LIMIT','Returned function/evidence bounds exceed the original request');
    requireThat(object(result.limits)&&object(result.limits.visibility)&&strings(result.limits.statements,16,4000)
      &&strings(result.semanticReview.caveats,128,12000)&&Array.isArray(result.semanticReview.blockingDefects)
      &&result.semanticReview.blockingDefects.length===0,'RESULT_LIMITS','Evidence limits/caveats must be retained');
    const refs = new Map(result.exactReferences.map(ref => [ref.evidenceId,ref]));
    requireThat(refs.size === result.exactReferences.length, 'DUPLICATE_REFERENCE', '重复证据ID');
    for (const fn of result.borrowableWritingFunctions) {
      keys(fn,['functionId','dimension','status','observablePattern','borrowableFunction','alternatives','limitation','evidenceIds','unitIds','matchedProblemTerms'],'FUNCTION_FIELDS');
      requireThat(text(fn.functionId) && Array.isArray(fn.evidenceIds) && fn.evidenceIds.length > 0
        && fn.evidenceIds.every(id => refs.has(id)), 'INCOMPLETE_FUNCTION', '缺少功能所需的完整引用');
      for (const id of fn.evidenceIds) {
        const ref = refs.get(id);
        requireThat(typeof ref.quote === 'string' && ref.sourceId === result.source.sourceId
          && ref.sourceTextSha256 === result.source.sourceTextSha256
          && createHash('sha256').update(ref.quote).digest('hex') === ref.quoteSha256,
        'REFERENCE_BINDING', '引用内容或来源绑定错误');
      }
    }
  }
}

function validateConceptScores(result,plan) {
  const concept=plan.activeConcept;
  const positiveText=functions=>functions.map(fn=>`${fn.observablePattern??''}\n${fn.borrowableFunction??''}`).join('\n').toLocaleLowerCase('zh-CN');
  const termsFor=functions=>{const text=positiveText(functions);return plan.effectiveSearchTerms.filter(term=>
    concept&&term===concept.representativeTerm?concept.aliases.some(alias=>text.includes(alias.toLocaleLowerCase('zh-CN'))):text.includes(term.toLocaleLowerCase('zh-CN')));};
  const functions=result.borrowableWritingFunctions;
  requireThat(Array.isArray(functions)&&functions.length>0,'FUNCTION_SHAPE','Complete functions required');
  const terms=termsFor(functions),groups=plan.effectiveRequiredTermGroups.map(g=>g.filter(t=>terms.includes(t)));
  const functionMatches=concept?functions.map(fn=>({functionId:fn.functionId,
    matchedAliases:concept.aliases.filter(a=>positiveText([fn]).includes(a.toLocaleLowerCase('zh-CN')))})).filter(x=>x.matchedAliases.length):[];
  const conceptMatches=functionMatches.length?[{conceptId:concept.conceptId,representativeTerm:concept.representativeTerm,countedOnce:true,functionMatches}]:[];
  requireThat(equal(result.match.matchedTerms,terms)&&result.match.matchedTermCount===terms.length
    &&result.match.lexicalScore===terms.length&&result.match.requiredMatchedTermCount===plan.minimumMatchedTerms
    &&terms.length>=plan.minimumMatchedTerms&&groups.every(g=>g.length>0)
    &&equal(result.match.requiredTermGroupsSatisfied,groups)&&equal(result.match.conceptMatches,conceptMatches)
    &&functions.every(fn=>termsFor([fn]).length>=DEEP_REFERENCE_LIMITS.minimumFunctionMatchedTerms
      &&equal(fn.matchedProblemTerms,termsFor([fn]))),
  'RESPONSE_CONCEPT_SCORE','Alias scores must bind only complete positive function fields and count each concept once');
}

function triggerFor(response, assessment) {
  if (!assessment) return {allowed:false,reason:'not_assessed'};
  keys(assessment,['queryId','responseSha256','outcome','supplied','decisions','provenance'],'ASSESSMENT_FIELDS');
  requireThat(typeof assessment.outcome==='string','ASSESSMENT_OUTCOME','Outcome required');
  if (noFallback.has(assessment.outcome)) return {allowed:false,reason:assessment.outcome};
  requireThat(assessment.queryId === response.queryId && assessment.responseSha256 === fingerprint(response),
    'STALE_ASSESSMENT', '适用判断绑定了不同查询或响应');
  if (assessment.outcome === 'no_hits') {
    requireThat(response.status === 'uncovered' && response.results.length === 0
      && (!assessment.supplied||Array.isArray(assessment.supplied)&&assessment.supplied.length===0)
      && (!assessment.decisions||Array.isArray(assessment.decisions)&&assessment.decisions.length===0),
      'FALSE_NO_HITS', '只有真实DATA空结果可标no_hits');
    return {allowed:true,reason:'confirmed_query_no_hits',assessmentScope:'returned_results_only'};
  }
  requireThat(assessment.outcome === 'all_supplied_inapplicable', 'ASSESSMENT_OUTCOME', '未知后备触发条件');
  const supplied = assessment.supplied, decisions = assessment.decisions;
  requireThat(Array.isArray(supplied) && supplied.length > 0 && supplied.length<=6 && Array.isArray(decisions)
    &&supplied.every(object)&&decisions.every(object)
    && new Set(supplied.map(s=>s.materialId)).size === supplied.length
    && new Set(decisions.map(d=>d.materialId)).size === decisions.length
    && decisions.length === supplied.length, 'ASSESSMENT_COVERAGE', '须完整覆盖非空实际供给');
  for (const item of supplied) {
    keys(item,['materialId','functionIds','side','sourceIds','contentSha256','supplyId'],'SUPPLY_FIELDS');
    requireThat(text(item.materialId)&&strings(item.functionIds,6,160)&&unique(item.functionIds)
      &&[undefined,'deep','legacy'].includes(item.side)
      &&(item.contentSha256===undefined||SHA.test(item.contentSha256))
      &&(item.sourceIds===undefined||strings(item.sourceIds,6,160)&&unique(item.sourceIds))
      &&(item.supplyId===undefined||text(item.supplyId)), 'SUPPLY_FIELDS','Actual supply projection is invalid');
    const result = response.results.find(r => r.referenceId === item.materialId);
    const decision = decisions.find(d => d.materialId === item.materialId);
    keys(decision,['materialId','fit','reason','supplyId','issueId','evidenceIds','transferBoundary'],'DECISION_FIELDS');
    const validSource=item.side==='legacy'
      ? !result&&item.functionIds.length===0&&SHA.test(item.contentSha256)
      : result&&item.functionIds.length>0&&item.functionIds.every(id=>result.borrowableWritingFunctions.some(fn=>fn.functionId===id))
        &&(item.sourceIds===undefined||equal(item.sourceIds,[result.source.sourceId]));
    requireThat(validSource
      && decision?.fit === 'inapplicable' && text(decision.reason),
    'ASSESSMENT_COVERAGE', '未供给/未知/已适用不能冒充全部不适用');
    requireThat(decision.reason.length<=12000&&(decision.supplyId===undefined||decision.supplyId===item.supplyId)
      &&(decision.evidenceIds===undefined||strings(decision.evidenceIds,128,160)),
    'DECISION_BINDING','Decision must bind the actual supply');
  }
  return {allowed:true,reason:'all_actual_supplies_judged_inapplicable',assessmentScope:'supplied_functions_only',
    unsuppliedFunctionsNotAssessed:response.results.flatMap(result => result.borrowableWritingFunctions
      .filter(fn=>!supplied.some(s=>s.materialId===result.referenceId && s.functionIds.includes(fn.functionId)))
      .map(fn=>({materialId:result.referenceId,functionId:fn.functionId})))};
}

function poolFrom(runs) {
  const pool = new Map();
  for (const run of runs) for (const result of run.response.results) {
    for (const fn of result.borrowableWritingFunctions) {
      const {matchedProblemTerms, ...completeFunction} = clone(fn);
      const candidateId = `component-function-${fingerprint({source:result.source,analysis:result.analysis,
        review:result.semanticReview.reportSha256,function:completeFunction}).slice(0,32)}`;
      const provenance = {componentId:run.component.id,queryId:run.response.queryId,
        responseSha256:run.responseSha256,functionMatchedTerms:clone(matchedProblemTerms ?? [])};
      if (pool.has(candidateId)) { pool.get(candidateId).retrievedBy.push(provenance); continue; }
      pool.set(candidateId,{candidateId,referenceId:result.referenceId,source:clone(result.source),analysis:clone(result.analysis),
        semanticReview:clone(result.semanticReview),function:completeFunction,
        exactReferences:clone(result.exactReferences.filter(ref=>fn.evidenceIds.includes(ref.evidenceId))),limits:clone(result.limits),
        retrievedBy:[provenance],matchScope:'only_component',semanticFit:'unknown',wholeGoalCoverage:'unknown',sameActorChain:'unknown',
        supplied:false,adopted:false,requiresExplicitAdoption:true,
        reviewQuestions:['谁行动、谁承认什么、谁承担代价？','认错与承担是否同一演员？',
          '方向是否相反或仅是受害损失/他人受罚？','前提冲突、未知项与完整目标缺失环节是什么？'],boundary});
    }
  }
  return [...pool.values()];
}

function contextFor(options) {
  keys(options,['enabled','originalRequest','originalResponse','assessment','components','query','signal','policy','checkpoint','onCheckpoint'],'FALLBACK_OPTIONS');
  const policy=validateComponentFallbackPolicy(options.policy);
  if(options.enabled!==undefined) requireThat(typeof options.enabled==='boolean','COMPONENT_POLICY','enabled must be boolean');
  if(policy) {
    requireThat(options.enabled===undefined||options.enabled===policy.enabled,'POLICY_CONFLICT','Conflicting enabled values');
    requireThat(options.components===undefined||equal(options.components,policy.components),'POLICY_CONFLICT','Conflicting components');
  }
  const enabled=policy?.enabled??options.enabled??false,components=clone(policy?.components??options.components??[]);
  const original={request:clone(options.originalRequest??null),response:clone(options.originalResponse??null),assessment:clone(options.assessment??null)};
  jsonValue(original);jsonValue(components);
  const conceptPolicy=policy?.schemaVersion===COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION;
  if(enabled) {validateComponents(components,conceptPolicy);validateRequest(original.request);}
  const fields={enabled,originalRequestSha256:fingerprint(original.request),originalResponseSha256:fingerprint(original.response),
    assessmentSha256:fingerprint(original.assessment),componentsSha256:fingerprint(components),installId:original.response?.installId??null,
    ...(conceptPolicy?{componentPolicyVersion:COMPONENT_FALLBACK_CONCEPT_POLICY_VERSION}:{})};
  const base={schemaVersion:COMPONENT_FALLBACK_VERSION,original,originalSha256:fingerprint(original),
    binding:{...fields,sha256:fingerprint({schemaVersion:COMPONENT_FALLBACK_VERSION,...fields})},
    providerCalls:0,boundary,requiresNewApplicabilityReview:true,productionSupplyChanged:false};
  if(!enabled) return {base,skip:'disabled'};
  if(!original.response) return {base,skip:'no_valid_original_query_response'};
  validateResponse(original.response,original.request);
  const trigger=triggerFor(original.response,original.assessment);
  if(!trigger.allowed) return {base,trigger,skip:trigger.reason};
  return {base,trigger,requests:buildComponentQueries({originalRequest:original.request,components,
    policyVersion:policy?.schemaVersion??COMPONENT_FALLBACK_POLICY_VERSION})};
}

function seal(value) {return {...value,checkpointSha256:fingerprint(value)};}
function checkpointFor(ctx,runs=[],error=null,partial=false) {
  const common={...clone(ctx.base),queryCalls:runs.length+(error?1:0),runs:clone(runs),candidatePool:[]};
  if(ctx.skip) return seal({...common,status:'not_attempted',reason:ctx.skip,...(ctx.trigger?{trigger:clone(ctx.trigger)}:{})});
  const active={...common,trigger:clone(ctx.trigger),requests:clone(ctx.requests)};
  if(error) return seal({...active,status:'query_error',failedComponentId:ctx.requests[runs.length].component.id,error:clone(error),
    reason:'Incomplete fallback; retain earlier responses for audit but expose no usable candidate pool.'});
  if(partial) return seal({...active,status:'in_progress'});
  const candidatePool=poolFrom(runs);
  return seal({...active,status:candidatePool.length?'component_candidates':'no_component_hits',candidatePool,
    absenceScope:candidatePool.length?null:'only_this_bounded_set_of_component_queries; whole_corpus_semantics_unknown'});
}

function validateCheckpoint(ctx,checkpoint) {
  requireThat(object(checkpoint),'CHECKPOINT_SHAPE','Checkpoint must be JSON');jsonValue(checkpoint);
  const {checkpointSha256,...payload}=checkpoint;
  requireThat(SHA.test(checkpointSha256)&&fingerprint(payload)===checkpointSha256,'CHECKPOINT_HASH','Checkpoint bytes/data changed');
  requireThat(checkpoint.schemaVersion===COMPONENT_FALLBACK_VERSION&&equal(checkpoint.binding,ctx.base.binding),
    'CHECKPOINT_STALE','Checkpoint belongs to different original input, policy or installation');
  requireThat(Array.isArray(checkpoint.runs)&&checkpoint.runs.length<=(ctx.requests?.length??0),'CHECKPOINT_PREFIX','Invalid query prefix');
  const runs=[];
  for(let i=0;i<checkpoint.runs.length;i++) {
    const saved=checkpoint.runs[i],planned=ctx.requests[i];
    validateResponse(saved.response,planned.request);
    requireThat(saved.response.installId===ctx.base.original.response.installId,'CORPUS_CHANGED','Saved query installation changed');
    const expected={...planned,response:clone(saved.response),responseSha256:fingerprint(saved.response)};
    requireThat(equal(saved,expected),'CHECKPOINT_PREFIX','Checkpoint query order, component or response binding changed');runs.push(expected);
  }
  let expected;
  if(ctx.skip) expected=checkpointFor(ctx);
  else if(checkpoint.status==='in_progress') {
    requireThat(runs.length<ctx.requests.length,'CHECKPOINT_PREFIX','Completed prefix cannot masquerade as interrupted');
    expected=checkpointFor(ctx,runs,null,true);
  } else if(checkpoint.status==='query_error') {
    keys(checkpoint.error,['code','message'],'CHECKPOINT_ERROR');
    requireThat(runs.length<ctx.requests.length&&text(checkpoint.error.code)&&checkpoint.error.code.length<=160
      &&typeof checkpoint.error.message==='string'&&checkpoint.error.message.length<=2000,'CHECKPOINT_ERROR','Invalid saved failure');
    expected=checkpointFor(ctx,runs,checkpoint.error);
  } else {
    requireThat(runs.length===ctx.requests.length,'CHECKPOINT_INCOMPLETE','Cannot expose a partial pool as completed');
    expected=checkpointFor(ctx,runs);
  }
  requireThat(equal(checkpoint,expected),'CHECKPOINT_DERIVATION','Saved candidate pool/status or original evidence changed');
  return clone(expected);
}

export function validateComponentFallbackCheckpoint({checkpoint,...options}={}) {
  return validateCheckpoint(contextFor(options),checkpoint);
}

export async function runComponentFallback(options={}) {
  const ctx=contextFor(options),{query,signal,onCheckpoint}=options;
  requireThat(onCheckpoint===undefined||typeof onCheckpoint==='function','CHECKPOINT_CALLBACK','onCheckpoint must be a function');
  if(signal!==undefined) requireThat(typeof signal?.throwIfAborted==='function','ABORT_SIGNAL','Expected an AbortSignal');
  let current;
  if(options.checkpoint!==undefined) {
    current=validateCheckpoint(ctx,options.checkpoint);
    if(current.status!=='in_progress') return current;
  } else {
    current=checkpointFor(ctx,[],null,!ctx.skip);
    await onCheckpoint?.(clone(current));
    if(ctx.skip) return current;
  }
  requireThat(typeof query==='function','QUERY_CALLBACK','需要真实DATA只读查询回调');
  const runs=clone(current.runs);
  for(let i=runs.length;i<ctx.requests.length;i++) {
    signal?.throwIfAborted();const planned=ctx.requests[i];let response;
    try {
      response=await query(clone(planned.request),{signal});signal?.throwIfAborted();
      validateResponse(response,planned.request);
      requireThat(response.installId===ctx.base.original.response.installId,'CORPUS_CHANGED','子查询不能静默切换安装');
    } catch(error) {
      if(signal?.aborted||error?.name==='AbortError'||error?.code==='ABORT_ERR') throw error;
      current=checkpointFor(ctx,runs,{code:typeof error?.code==='string'&&error.code.trim()?error.code.trim().slice(0,160).trim():'QUERY_ERROR',
        message:String(error?.message??error).slice(0,2000)});
      await onCheckpoint?.(clone(current));return current;
    }
    runs.push({...planned,response:clone(response),responseSha256:fingerprint(response)});
    current=checkpointFor(ctx,runs,null,runs.length<ctx.requests.length);
    await onCheckpoint?.(clone(current));
  }
  return current;
}
