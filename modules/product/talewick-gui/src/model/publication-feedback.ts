export type Hypothesis={id:string;claim:string;observationIds:string[];quotes:string[];alternatives:string[];limitations:string[];testPlan:{change:string;keepFixed:string;targetMetric:string;successCriterion:string}};
export type Review={id:string;status:'completed'|'failed';observedRevision:number;createdAt:string;report?:{summary:string;observations:{kind:string;statement:string;quote:string|null;observationIds:string[]}[];hypotheses:Hypothesis[];limitations:string[]};error?:{message:string}|string};
export type Publication={id:string;revision:number;workId:string;title:string;text:string;textSha256:string;textVersionLabel:string;platform:string;account:string;genre:string;traffic:string;publishedAt:string|null;workIdentityConfirmed:boolean;accountIdentityConfirmed:boolean;observations:Observation[];reviews:Review[];decisions:{id:string;reviewId:string;hypothesisId:string;action:string;status:string;reason:string;scope?:string;createdAt:string;limitations:string[];planDecisionId?:string;criterionCheck?:unknown;plan?:unknown;result?:unknown;evidenceBindings?:unknown}[]};
export type Observation={id?:string;observedAt:string;windowHours:number|null;windowKind:string;moderation:{status:string;reason:string;category:string};metrics:Record<string,number|null>;metricDefinition:string;metricsComparable:boolean;notes:string};
export type Assessment={facts:unknown[];gaps:unknown[];limitations:unknown[];rates:{readRate:number|null;completionRate:number|null};currentObservationId?:string|null;observationConflict?:boolean;literaryQuality:string};
export async function publicationAPI<T>(route='',body?:unknown):Promise<T>{const response=await fetch(`/api/publication-feedback${route}`,{method:body===undefined?'GET':'POST',headers:body===undefined?undefined:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error??'请求失败，请重试。');return value;}
export const metricNames:Record<string,string>={impressions:'曝光',reads:'阅读',completions:'读完',likes:'点赞',comments:'评论',favorites:'收藏',follows:'关注'};
export const statusNames:Record<string,string>={unknown:'未知',pending:'待审核',approved:'已过审',rejected:'已拒绝',changes_requested:'要求修改',testing:'验证中',supported:'支持',contradicted:'反例',inconclusive:'尚无定论',provisionally_adopted:'暂时采用',withdrawn:'已撤回'};
export function nullableNumber(value:string){if(!value.trim())return null;const n=Number(value);if(!Number.isFinite(n)||n<0)throw Error('指标请填写非负数，未知请留空。');return n;}
export function iso(value:string){if(!value.trim())return null;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})?$/.test(value.trim()))throw Error('请按 YYYY-MM-DDTHH:mm 填写本地时间，或提供带时区的 ISO 日期。');const date=new Date(value.trim());if(Number.isNaN(date.getTime()))throw Error('日期无效，请填写有效日期。');return date.toISOString();}
export function renderFact(value:unknown):string {
 if(typeof value==='string')return value.replace(/\b(impressions|reads|completions|likes|comments|favorites|follows)\b/g,key=>metricNames[key]);
 if(value&&typeof value==='object'){
  const v=value as Record<string,unknown>;
  if(v.kind==='moderation'){
   const status=typeof v.status==='string'?(statusNames[v.status]??v.status):'未知';
   const categories:Record<string,string>={unknown:'未知',format:'格式',content_restriction:'内容限制',genre_fit:'类型适配',editorial_quality:'编辑质量',other:'其他'};
   const category=typeof v.category==='string'?(categories[v.category]??v.category):'未知';
   return `平台审核：${status}；理由：${typeof v.reason==='string'&&v.reason.trim()?v.reason:'未提供'}；理由类别：${category}。`;
  }
  if(v.kind==='metrics'){
   const metrics=v.metrics&&typeof v.metrics==='object'?v.metrics as Record<string,unknown>:{};
   const counts=Object.entries(metricNames).map(([key,label])=>`${label}：${typeof metrics[key]==='number'?metrics[key]:'未提供'}`).join('；');
   const date=typeof v.observedAt==='string'?new Date(v.observedAt):null;
   const at=date&&!Number.isNaN(date.getTime())?date.toLocaleString('zh-CN'):'未提供';
   return `观察时间：${at}；窗口：${typeof v.windowHours==='number'?`${v.windowHours} 小时`:'未提供'}。${counts}。`;
  }
  return String(v.message??v.statement??v.description??JSON.stringify(v));
 }
 return String(value);
}
