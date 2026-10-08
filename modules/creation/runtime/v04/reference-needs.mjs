import { validateRecall } from './knowledge.mjs';
export const FOLLOWUP_POLICY = 'bounded-followup-1';
const plain = v => v && typeof v === 'object' && !Array.isArray(v) && [Object.prototype,null].includes(Object.getPrototypeOf(v));
const keys = (v, expected) => plain(v) && JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...expected].sort());
const text = (v,max) => typeof v==='string' && v.length>0 && v.length<=max && v===v.trim();
export const NEED_PROMPT = `可选增加 referenceNeeds 数组（0–1项），只在当前出现新的具体参考需要或上下文不足时提供。每项只含 question（已trim非空≤240字符）、reason（已trim非空≤400字符）、basis（new_reference_need或insufficient_context）、recall（只含focus:scene/ending/echo与queries:0–3条已trim非空不重复且每条≤120字符）、target。question写本场关系或处境、具体触发和需要解决的表达难点，不重复“同一人物情绪如何发展”等通用题；reason说明当前缺哪段心理理解或行动后果、迁移限制及为什么已有材料不能回答。只写当前问题需要的环节，未知明确记缺口，不编造触发、不套忍耐到爆发或和解公式。recall只换述同一问题，不靠人名、职业和道具换皮。规划target只含chapterNumber（本计划章号）；初审target只含chapterId和quote（本篇逐字引文≤300字符，须对应本报告must_fix问题）。不编造库中人物、书名、台词或已知答案；补查不意味着采用，更不授权额外改稿。本次计划明确decline的材料不能因换窗口或补查自动恢复推荐；新计划明确改为adopt才重新评估。没有合适参考正常继续。不能在纯正文中输出此字段。`;
/** Invalid adjuncts are refused without making a valid core plan/review fail or retry. */
export function referenceNeedsField(value) {
 if(value===undefined)return {};
 try {
  if(!Array.isArray(value)||value.length>1)throw Error();
  for(const n of value){
   if(!keys(n,['question','reason','basis','recall','target'])||!text(n.question,240)||!text(n.reason,400)||!['new_reference_need','insufficient_context'].includes(n.basis))throw Error();
   validateRecall(n.recall);
   const target=n.target;
   if(!(keys(target,['chapterNumber'])&&Number.isInteger(target.chapterNumber)&&target.chapterNumber>0&&target.chapterNumber<=12)
    && !(keys(target,['chapterId','quote'])&&text(target.chapterId,160)&&text(target.quote,300)))throw Error();
  }
  return {referenceNeeds:structuredClone(value)};
 }catch{return {referenceNeeds:null};}
}
export function selectNeed(value,slot,{plan,chapters,issues}={}) {
 const field=referenceNeedsField(value);
 if(field.referenceNeeds===null)return {status:'rejected',reason:'invalid_reference_need'};
 if(!field.referenceNeeds?.length)return {status:'not_requested',reason:'no_reference_need'};
 const need=field.referenceNeeds[0];
 if(slot==='planning'){
  if(!keys(need.target,['chapterNumber'])||!plan?.chapters?.[need.target.chapterNumber-1])return {status:'rejected',reason:'invalid_target'};
 }else{
  const {chapterId,quote}=need.target;
  if(!keys(need.target,['chapterId','quote'])||!chapters?.find(c=>c.id===chapterId)?.body.includes(quote)
   ||!issues?.some(i=>i.chapterId===chapterId&&i.quote===quote&&i.severity==='must_fix'&&i.evidenceVerified))return {status:'rejected',reason:'not_anchored_must_fix'};
 }
 return {status:'eligible',need};
}
