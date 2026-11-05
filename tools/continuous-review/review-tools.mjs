import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

export const PROTOCOL_VERSION = 'continuous-review-1';
const template = JSON.parse(readFileSync(new URL('./prompt-templates.json', import.meta.url),'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonempty = v => typeof v === 'string' && v.trim().length > 0;
const versions = ['A','B'];
const chapterIds = ['ch-1','ch-2','ch-3'];
const dimensions = ['consequence_credibility','character_pressure','pacing','ending_force','causal_continuity'];
const array = v => Array.isArray(v) ? v : [];
const exactKeys = (v,keys) => object(v) && isDeepStrictEqual(Object.keys(v).sort(),[...keys].sort());
function checkManuscripts(manuscripts) {
  if (!exactKeys(manuscripts,versions)) throw Error('MANUSCRIPTS_AB_REQUIRED');
  for (const v of versions) {
    if (!Array.isArray(manuscripts[v]) || manuscripts[v].length !== 3) throw Error('THREE_CHAPTERS_REQUIRED');
    manuscripts[v].forEach((c,i) => {
      if (!exactKeys(c,['id','title','body']) || c.id !== chapterIds[i] || !nonempty(c.title) || !nonempty(c.body)) throw Error('CHAPTER_ID_OR_TEXT_INVALID');
    });
  }
}
export function buildReadingPrompts({manuscripts}) {
  checkManuscripts(manuscripts);
  return [['A','B'],['B','A']].map((order,i) => {
    const system = template.system;
    const user = JSON.stringify({instructions:template.instructions,manuscripts:order.map(version=>({version,chapters:manuscripts[version]})),responseContract:template.responseContract});
    const messages = [{role:'system',content:system},{role:'user',content:user}];
    return {readerId:`reader-${i+1}`,order,system,user,messages,messagesSHA256:sha256(JSON.stringify(messages))};
  });
}
function paragraphs(body) {
  const result = []; let cursor = 0;
  const add = end => {
    const slice = body.slice(cursor,end), leading = slice.length - slice.trimStart().length;
    const text = slice.trim();
    if (text) result.push({paragraphIndex:result.length,start:cursor+leading,end:cursor+leading+text.length,text});
  };
  for (const match of body.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)) {add(match.index); cursor=match.index+match[0].length;}
  add(body.length); return result;
}
export function inspectChangeCoverage({manuscripts,citations=[]}) {
  checkManuscripts(manuscripts);
  const all = Object.fromEntries(versions.map(v=>[v,manuscripts[v].flatMap(c=>paragraphs(c.body).map(p=>({...p,chapterId:c.id})))]));
  const units = [], separatorOnly = [], titleChanges = [];
  for (const [i,id] of chapterIds.entries()) {
    const a=manuscripts.A[i],b=manuscripts.B[i];
    if(a.title!==b.title) titleChanges.push(id);
    if(a.body!==b.body && isDeepStrictEqual(paragraphs(a.body).map(p=>p.text),paragraphs(b.body).map(p=>p.text))) separatorOnly.push(id);
  }
  for(const version of versions) {
    const other=version==='A'?'B':'A';
    for(const p of all[version]) {
      const matches=all[other].filter(q=>q.text===p.text), same=matches.filter(q=>q.chapterId===p.chapterId);
      let kind='unchanged';
      if(!same.length) kind=matches.length===1?'cross_chapter_move':matches.length?'ambiguous_cross_chapter_match':'changed';
      else if(same.length>1 || all[version].filter(q=>q.chapterId===p.chapterId&&q.text===p.text).length>1) kind='ambiguous_repeat';
      else {
        // Unique shared paragraph order inversions identify reorder; mere shifts after insertion do not.
        const inverted=all[version].filter(q=>q.chapterId===p.chapterId&&q.text!==p.text).some(q=>{
          const local=all[version].filter(r=>r.chapterId===p.chapterId&&r.text===q.text);
          const opposing=all[other].filter(r=>r.chapterId===p.chapterId&&r.text===q.text);
          return local.length===1&&opposing.length===1&&(q.paragraphIndex-p.paragraphIndex)*(opposing[0].paragraphIndex-same[0].paragraphIndex)<0;
        });
        if(inverted) kind='reordered';
      }
      if(kind==='unchanged') continue;
      const chapter=manuscripts[version].find(c=>c.id===p.chapterId);
      const refs=citations.filter(e=>e.exactUnique===true&&e.version===version&&e.chapterId===p.chapterId&&Number.isInteger(e.start)&&Number.isInteger(e.end)&&e.start>=0&&e.end>e.start&&chapter.body.slice(e.start,e.end)===e.quote&&nonempty(e.quote)&&chapter.body.indexOf(e.quote)===e.start&&chapter.body.indexOf(e.quote,e.start+1)<0&&e.start<p.end&&e.end>p.start);
      const common=refs.filter(e=>manuscripts[other].some(c=>c.body.includes(e.quote)));
      const wording=refs.filter(e=>!common.includes(e));
      units.push({version,chapterId:p.chapterId,paragraphIndex:p.paragraphIndex,start:p.start,end:p.end,paragraphSHA256:sha256(p.text),kind,citationIds:refs.map(e=>e.id),commonWordingCitationIds:common.map(e=>e.id),distinctWordingCitationIds:wording.map(e=>e.id),coverage:refs.length?'cited':'uncovered',contextParagraphIndexes:[p.paragraphIndex-1,p.paragraphIndex+1].filter(n=>n>=0&&n<paragraphs(chapter.body).length)});
    }
  }
  return {schemaVersion:'continuous-review-change-coverage-1',units,separatorOnlyChapterIds:separatorOnly,titleChangedChapterIds:titleChanges,uncoveredUnitCount:units.filter(u=>u.coverage==='uncovered').length,interpretation:'location_only_requires_human_review',fullManuscriptAccepted:false};
}
export function validateReading({manuscripts,raw,expectedRawSHA256}) {
  checkManuscripts(manuscripts);
  if(typeof raw!=='string'&&!Buffer.isBuffer(raw)) throw Error('RAW_STRING_OR_BUFFER_REQUIRED');
  const bytes=Buffer.isBuffer(raw)?raw:Buffer.from(raw);
  const errors=[], references=[];
  const fail=(category,path,code)=>errors.push({category,path,code});
  const schema=(ok,path,code='SCHEMA_INVALID')=>{if(!ok)fail('schema',path,code);return ok;};
  if(expectedRawSHA256!==undefined&&sha256(bytes)!==expectedRawSHA256)fail('binding','/','RAW_HASH_MISMATCH');
  let response;
  try {response=JSON.parse(bytes.toString('utf8'));}catch {fail('schema','/','JSON_INVALID');}
  if(response!==undefined) {
    schema(exactKeys(response,['freeReading','overall','counterReading','dimensions','chapterReadings','factualChecks','evidence','scopeLimit']),'/');
    if(object(response)) {
      const ev=Array.isArray(response.evidence)?response.evidence:[];
      schema(Array.isArray(response.evidence)&&ev.length>0,'/evidence');
      const ids=new Set();
      for(const [i,e] of ev.entries()) {
        const path=`/evidence/${i}`;
        if(!schema(exactKeys(e,['id','version','chapterId','quote','supports']),path))continue;
        const validId=typeof e.id==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(e.id)&&!ids.has(e.id);
        schema(validId,path+'/id','EVIDENCE_ID_INVALID_OR_DUPLICATE');if(validId)ids.add(e.id);
        schema(versions.includes(e.version)&&chapterIds.includes(e.chapterId)&&nonempty(e.quote)&&[...e.quote].length<=240&&nonempty(e.supports),path);
        const body=versions.includes(e.version)?manuscripts[e.version].find(c=>c.id===e.chapterId)?.body:undefined;
        const start=typeof body==='string'&&nonempty(e.quote)?body.indexOf(e.quote):-1;
        const exactUnique=start>=0&&body.indexOf(e.quote,start+1)<0;
        references.push({id:e.id,version:e.version,chapterId:e.chapterId,quote:e.quote,start,end:start>=0?start+e.quote.length:null,exactUnique});
        if(!exactUnique)fail('citation',path+'/quote',start<0?'QUOTE_NOT_FOUND':'QUOTE_AMBIGUOUS');
      }
      const refs=(value,path,requiredVersions,chapterId)=>{
        if(!schema(Array.isArray(value)&&value.length>0&&new Set(value).size===value.length,path))return;
        const found=value.map(id=>ev.find(e=>object(e)&&e.id===id));
        if(found.some(e=>!e))fail('contract',path,'UNKNOWN_EVIDENCE_ID');
        for(const v of requiredVersions)if(!found.some(e=>e?.version===v&&(!chapterId||e.chapterId===chapterId)))fail('contract',path,'REQUIRED_SOURCE_MISSING');
        if(requiredVersions.length===1&&found.some(e=>e&&(e.version!==requiredVersions[0]||(chapterId&&e.chapterId!==chapterId))))fail('contract',path,'WRONG_SOURCE');
      };
      const prose=(v,path,keys)=>{if(!schema(exactKeys(v,keys),path))return false;for(const key of keys.filter(k=>k!=='evidenceIds'))schema(nonempty(v[key]),path+'/'+key);return true;};
      schema(Array.isArray(response.freeReading)&&response.freeReading.length===2,'/freeReading');
      for(const v of versions){const found=array(response.freeReading).filter(r=>r?.version===v);schema(found.length===1,'/freeReading','VERSION_COVERAGE');if(found.length)prose(found[0],'/freeReading/'+v,['version','overallImpression','progression','strongestMoment','uncertainty']);}
      if(prose(response.overall,'/overall',['assessment','preference','evidenceIds'])){
        schema(['A','B','no_clear_preference','tradeoff'].includes(response.overall.preference),'/overall/preference');refs(response.overall.evidenceIds,'/overall/evidenceIds',versions);
      }
      if(prose(response.counterReading,'/counterReading',['assessment','evidenceIds']))refs(response.counterReading.evidenceIds,'/counterReading/evidenceIds',versions);
      schema(Array.isArray(response.dimensions)&&response.dimensions.length===5,'/dimensions');
      for(const id of dimensions){
        const found=array(response.dimensions).filter(d=>d?.id===id);schema(found.length===1,'/dimensions/'+id);
        if(!found.length)continue;const d=found[0];schema(exactKeys(d,['id','A','B','comparison'])&&nonempty(d.comparison),'/dimensions/'+id);
        for(const v of versions)if(prose(d[v],'/dimensions/'+id+'/'+v,['assessment','evidenceIds']))refs(d[v].evidenceIds,'/dimensions/'+id+'/'+v+'/evidenceIds',[v]);
      }
      schema(Array.isArray(response.chapterReadings)&&response.chapterReadings.length===6,'/chapterReadings');
      for(const v of versions)for(const chapterId of chapterIds){const found=array(response.chapterReadings).filter(r=>r?.version===v&&r?.chapterId===chapterId);schema(found.length===1,'/chapterReadings/'+v+'/'+chapterId);if(found.length&&prose(found[0],'/chapterReadings',['version','chapterId','observation','evidenceIds']))refs(found[0].evidenceIds,'/chapterReadings/'+v+'/'+chapterId,[v],chapterId);}
      const facts=Array.isArray(response.factualChecks)?response.factualChecks:[];
      schema(Array.isArray(response.factualChecks)&&facts.length>=4,'/factualChecks');
      const factIds=new Set();
      for(const [i,f]of facts.entries()){
        if(!prose(f,'/factualChecks/'+i,['id','scope','kind','claim','evidenceIds','uncertainty']))continue;
        schema(!factIds.has(f.id),'/factualChecks/'+i+'/id');factIds.add(f.id);
        schema(['A','B','both'].includes(f.scope)&&['observation','inference'].includes(f.kind),'/factualChecks/'+i);
        refs(f.evidenceIds,'/factualChecks/'+i+'/evidenceIds',f.scope==='both'?versions:[f.scope]);
      }
      for(const scope of ['A','B','both'])if(!facts.some(f=>f?.scope===scope))fail('contract','/factualChecks','FACT_SCOPE_MISSING_'+scope);
      schema(nonempty(response.scopeLimit),'/scopeLimit');
    }
  }
  const schemaValid=!errors.some(e=>e.category==='schema');
  const citationsExact=references.length>0&&!errors.some(e=>e.category==='citation');
  const evidenceContractValid=schemaValid&&!errors.some(e=>e.category==='contract');
  const valid=errors.length===0&&citationsExact;
  const bodiesEqual=manuscripts.A.every((c,i)=>c.body===manuscripts.B[i].body);
  const identityLanguage=object(response)&&/完全相同|一字不差|逐字相同|没有任何差异/.test(JSON.stringify({overall:response.overall,factualChecks:response.factualChecks}));
  const factualWarnings=!bodiesEqual&&identityLanguage?['TEXT_IDENTITY_LANGUAGE_WITH_DIFFERENT_BODIES_REVIEW_SCOPE']:[];
  return {textFacts:{bodiesEqual},factualWarnings,schemaVersion:'continuous-review-reading-inspection-1',protocolVersion:PROTOCOL_VERSION,rawSHA256:sha256(bytes),rawByteLength:bytes.length,manuscriptsSHA256:sha256(JSON.stringify(manuscripts)),schemaValid,citationsExact,evidenceContractValid,valid,errors,references,preference:valid?response.overall.preference:null,changeCoverage:inspectChangeCoverage({manuscripts,citations:references}),factJudgment:'requires_human_review',literaryJudgment:'requires_human_review',fullManuscriptAccepted:false};
}
export function inspectExecution({planned,executions}) {
  const errors=[],records=[];
  if(!Array.isArray(planned)||!Array.isArray(executions)||planned.length!==2||executions.length!==2)return {valid:false,errors:['TWO_READERS_REQUIRED']};
  for(const p of planned){
    const matches=executions.filter(e=>e.readerId===p.readerId);
    if(matches.length!==1){errors.push('READER_MISSING_OR_DUPLICATE');continue;}
    const e=matches[0];
    if(!isDeepStrictEqual(e.messages,p.messages))errors.push('ACTUAL_MESSAGES_MISMATCH_'+p.readerId);
    if(!nonempty(e.receipt?.contextId)||!nonempty(e.receipt?.invocationId))errors.push('RECEIPT_ID_MISSING_'+p.readerId);
    if(typeof e.raw!=='string'&&!Buffer.isBuffer(e.raw))errors.push('RAW_MISSING_'+p.readerId);
    records.push({readerId:p.readerId,contextId:e.receipt?.contextId??null,invocationId:e.receipt?.invocationId??null,messagesSHA256:sha256(JSON.stringify(e.messages)??'null'),rawSHA256:typeof e.raw==='string'||Buffer.isBuffer(e.raw)?sha256(e.raw):null});
  }
  if(new Set(records.map(r=>r.contextId)).size!==2)errors.push('CONTEXTS_NOT_DISTINCT');
  if(new Set(records.map(r=>r.invocationId)).size!==2)errors.push('INVOCATIONS_NOT_DISTINCT');
  return {schemaVersion:'continuous-review-execution-inspection-1',valid:errors.length===0,errors,records,remoteIsolation:'not_independently_provable',fullManuscriptAccepted:false};
}
