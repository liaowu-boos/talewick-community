import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';

export const PROTOCOL_VERSION='isolated-anchor-reading-2';
const templates=JSON.parse(readFileSync(new URL('./prompt-templates.json',import.meta.url),'utf8'));
export const sha256=value=>createHash('sha256').update(value).digest('hex');
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const sorted=v=>Array.isArray(v)?v.map(sorted):object(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sorted(v[k])])):v;
export const valueSHA256=v=>sha256(JSON.stringify(sorted(v)));
const nonempty=v=>typeof v==='string'&&v.trim().length>0;
const exact=(v,keys)=>object(v)&&isDeepStrictEqual(Object.keys(v).sort(),[...keys].sort());
const legalChapterId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value);
if(templates.protocolVersion!==PROTOCOL_VERSION)throw new Error('TEMPLATE_PROTOCOL_VERSION');
const dims=['consequence_credibility','character_pressure','pacing','ending_force','causal_continuity'];
const ensure=(condition,code)=>{if(!condition)throw Object.assign(new Error(code),{code});};
const string={type:'string',minLength:1};
const enumeration=values=>({type:'string',enum:values});
const array=(items,minItems=0,maxItems)=>({type:'array',items,minItems,...(maxItems===undefined?{}:{maxItems})});
const record=properties=>({type:'object',properties,required:Object.keys(properties),additionalProperties:false});
const refs={...array(string,1),uniqueItems:true};
const assessment=record({assessment:string,evidenceIds:refs});

function contract(mode,chapterIds){
  const evidence=record({id:{...string,pattern:'^[A-Za-z][A-Za-z0-9_-]{0,39}$'},version:string,chapterId:enumeration(chapterIds),anchorId:string,supports:string});
  const single=mode==='single';
  return record({
    kind:enumeration([single?'single_reading':'assisted_comparison']),
    freeReading:string,
    ...(!single?{textIdentity:enumeration(['identical','different','uncertain'])}:{}),
    overall:single?assessment:record({assessment:string,preference:enumeration(['A','B','no_clear_preference','tradeoff']),evidenceIds:refs}),
    dimensions:array(single?record({id:enumeration(dims),assessment:string,evidenceIds:refs}):record({id:enumeration(dims),A:assessment,B:assessment,comparison:string}),5,5),
    chapterReadings:array(single?record({chapterId:enumeration(chapterIds),observation:string,evidenceIds:refs}):record({version:enumeration(['A','B']),chapterId:enumeration(chapterIds),observation:string,evidenceIds:refs}),single?chapterIds.length:2*chapterIds.length,single?chapterIds.length:2*chapterIds.length),
    ...(!single?{changeReadings:array(record({differenceId:string,description:string,effect:enumeration(['A_has_advantage','B_has_advantage','tradeoff','no_material_effect','uncertain']),assessment:string,counterReading:string,evidenceIds:refs}))}:{}),
    factualChecks:array(record({id:string,...(!single?{scope:enumeration(['A','B','both'])}:{}),kind:enumeration(['observation','inference']),claim:string,evidenceIds:refs,uncertainty:string}),single?3:4),
    counterReading:assessment,
    evidence:array(evidence,1),
    scopeLimit:string
  });
}
function checkChapterIds(chapterIds){
  ensure(Array.isArray(chapterIds)&&chapterIds.length>0,'ORDERED_CHAPTER_IDS_REQUIRED');
  ensure(chapterIds.every(legalChapterId),'CHAPTER_ID_INVALID');
  ensure(new Set(chapterIds).size===chapterIds.length,'CHAPTER_ID_DUPLICATE');
}
function checkChapters(chapters,chapterIds){
  ensure(Array.isArray(chapters)&&chapters.length===chapterIds.length,'CHAPTER_RANGE_LENGTH');
  chapters.forEach((c,i)=>ensure(exact(c,['id','title','body'])&&c.id===chapterIds[i]&&nonempty(c.title)&&nonempty(c.body),'CHAPTER_BINDING'));
}
function spans(body){
  const output=[];let start=0;
  const add=end=>{const text=body.slice(start,end);if(nonempty(text))output.push({start,end,text});};
  for(const m of body.matchAll(/\r?\n[\t ]*\r?\n(?:[\t ]*\r?\n)*/g)){add(m.index);start=m.index+m[0].length;}
  add(body.length);return output;
}
function catalog(requestId,manuscripts){
  return manuscripts.flatMap(m=>m.chapters.flatMap(c=>{
    const prefix=requestId+'-'+m.version+'-'+c.id;
    const make=(suffix,field,text,start,end,index)=>({anchorId:prefix+'-'+suffix,version:m.version,chapterId:c.id,field,start,end,text,textSHA256:sha256(text),paragraphIndex:index});
    return [make('T','title',c.title,0,c.title.length,null),...spans(c.body).map((p,i)=>make('P'+String(i+1).padStart(3,'0'),'body',p.text,p.start,p.end,i))];
  }));
}
function differences(manuscripts,anchors){
  const result=[],chapters=[];
  const get=(version,chapterId,field)=>anchors.filter(a=>a.version===version&&a.chapterId===chapterId&&a.field===field);
  const add=(chapterId,kind,A,B,extra={})=>result.push({differenceId:'D'+String(result.length+1).padStart(3,'0'),chapterId,kind,A,B,...extra});
  const side=(region,context)=>({regionAnchorIds:region.map(p=>p.anchorId),contextAnchorIds:context.map(p=>p.anchorId)});
  for(let c=0;c<manuscripts[0].chapters.length;c++){
    const a=manuscripts[0].chapters[c],b=manuscripts[1].chapters[c],id=a.id;
    chapters.push({chapterId:id,titleEqual:a.title===b.title,bodyEqual:a.body===b.body,A:{titleSHA256:sha256(a.title),bodySHA256:sha256(a.body)},B:{titleSHA256:sha256(b.title),bodySHA256:sha256(b.body)}});
    const at=get('A',id,'title'),bt=get('B',id,'title'),ap=get('A',id,'body'),bp=get('B',id,'body');
    if(a.title!==b.title)add(id,'title',side(at,[]),side(bt,[]));
    if(a.body===b.body)continue;
    ensure((ap.length+1)*(bp.length+1)<=1000000,'ALIGNMENT_SIZE_LIMIT');
    const table=Array.from({length:ap.length+1},()=>new Uint32Array(bp.length+1));
    for(let i=ap.length-1;i>=0;i--)for(let j=bp.length-1;j>=0;j--)table[i][j]=ap[i].text===bp[j].text?1+table[i+1][j+1]:Math.max(table[i+1][j],table[i][j+1]);
    const pairs=[];let i=0,j=0;
    while(i<ap.length&&j<bp.length){if(ap[i].text===bp[j].text){pairs.push([i++,j++]);}else if(table[i+1][j]>=table[i][j+1])i++;else j++;}
    const repeated=[ap,bp].some(list=>new Set(list.map(p=>p.text)).size!==list.length);
    let ai=0,bi=0;
    for(const [endA,endB]of [...pairs,[ap.length,bp.length]]){
      const ac=[ap[ai-1],ap[endA]].filter(Boolean),bc=[bp[bi-1],bp[endB]].filter(Boolean);
      const range=(body,list,startIndex,endIndex)=>{
        const start=startIndex?list[startIndex-1].end:0,end=endIndex<list.length?list[endIndex].start:body.length;
        return {start,end,text:body.slice(start,end)};
      };
      const rawDifference={A:range(a.body,ap,ai,endA),B:range(b.body,bp,bi,endB)};
      if(endA>ai||endB>bi){
        add(id,'body_region',side(ap.slice(ai,endA),ac.length?ac:at),side(bp.slice(bi,endB),bc.length?bc:bt),{alignment:'deterministic_exact_paragraph_LCS',repeatedParagraphAmbiguity:repeated,rawDifference});
      }else if(rawDifference.A.text!==rawDifference.B.text){
        add(id,'separator_or_whitespace',side([],ac.length?ac:at),side([],bc.length?bc:bt),{rawDifference});
      }
      ai=endA+1;bi=endB+1;
    }
  }
  return {identity:{identical:chapters.every(c=>c.titleEqual&&c.bodyEqual),chapters},differences:result};
}
function buildPacket(requestId,mode,manuscripts,chapterIds){
  checkChapterIds(chapterIds);
  manuscripts=structuredClone(manuscripts);
  manuscripts.forEach(m=>checkChapters(m.chapters,chapterIds));
  const anchors=catalog(requestId,manuscripts);
  const diff=mode==='comparison'?differences(manuscripts,anchors):{identity:null,differences:[]};
  return {protocolVersion:PROTOCOL_VERSION,requestId,mode,chapterIds:[...chapterIds],instructions:templates[mode],manuscripts,anchors,...diff,responseContract:structuredClone(contract(mode,chapterIds))};
}
function request(packet){
  const messages=[{role:'system',content:templates.system},{role:'user',content:JSON.stringify(packet)}];
  return {requestId:packet.requestId,packet,packetSHA256:valueSHA256(packet),messages,messagesSHA256:valueSHA256(messages)};
}
export function buildReadingPlan({manuscripts,chapterIds}){
  checkChapterIds(chapterIds);
  ensure(exact(manuscripts,['A','B']),'MANUSCRIPTS_AB_REQUIRED');
  const A=structuredClone(manuscripts.A),B=structuredClone(manuscripts.B);
  checkChapters(A,chapterIds);checkChapters(B,chapterIds);
  const body={protocolVersion:PROTOCOL_VERSION,chapterIds:[...chapterIds],privateBindings:{S1:'A',S2:'B',C1:['A','B']},requests:[
    request(buildPacket('S1','single',[{version:'X',chapters:A}],chapterIds)),
    request(buildPacket('S2','single',[{version:'X',chapters:B}],chapterIds)),
    request(buildPacket('C1','comparison',[{version:'A',chapters:A},{version:'B',chapters:B}],chapterIds))
  ]};
  return {...body,planSHA256:valueSHA256(body)};
}
function verifyPacket(packet,expectedPacketSHA256){
  ensure(typeof expectedPacketSHA256==='string'&&/^[a-f0-9]{64}$/.test(expectedPacketSHA256),'EXPECTED_PACKET_HASH_REQUIRED');
  ensure(valueSHA256(packet)===expectedPacketSHA256,'PACKET_HASH_MISMATCH');
  ensure(packet?.protocolVersion===PROTOCOL_VERSION,'PROTOCOL_VERSION');
  const single=['S1','S2'].includes(packet.requestId);
  ensure(single?packet.mode==='single':packet.requestId==='C1'&&packet.mode==='comparison','REQUEST_MODE_BINDING');
  ensure(Array.isArray(packet.manuscripts)&&isDeepStrictEqual(packet.manuscripts.map(m=>m.version),single?['X']:['A','B']),'MANUSCRIPT_ROLE_BINDING');
  ensure(packet.manuscripts.every(m=>exact(m,['version','chapters'])),'MANUSCRIPT_FIELDS');
  const rebuilt=buildPacket(packet.requestId,packet.mode,packet.manuscripts,packet.chapterIds);
  ensure(isDeepStrictEqual(rebuilt,packet),'PACKET_CATALOG_OR_CONTRACT_BINDING');
}
function schemaErrors(value,schema,path='',errors=[]){
  const fail=code=>errors.push({category:'schema',path:path||'/',code});
  if(schema.type==='object'){
    if(!object(value)){fail('OBJECT_REQUIRED');return errors;}
    for(const k of schema.required)if(!Object.hasOwn(value,k))errors.push({category:'schema',path:path+'/'+k,code:'FIELD_REQUIRED'});
    for(const k of Object.keys(value)){if(!Object.hasOwn(schema.properties,k))errors.push({category:'schema',path:path+'/'+k,code:'UNEXPECTED_FIELD'});else schemaErrors(value[k],schema.properties[k],path+'/'+k,errors);}
  }else if(schema.type==='array'){
    if(!Array.isArray(value)){fail('ARRAY_REQUIRED');return errors;}
    if(value.length<schema.minItems||(schema.maxItems!==undefined&&value.length>schema.maxItems))fail('ARRAY_LENGTH');
    if(schema.uniqueItems&&new Set(value.map(v=>JSON.stringify(v))).size!==value.length)fail('ARRAY_DUPLICATES');
    value.forEach((v,i)=>schemaErrors(v,schema.items,path+'/'+i,errors));
  }else if(schema.type==='string'){
    if(!nonempty(value)){fail('NONEMPTY_STRING_REQUIRED');return errors;}
    if(schema.enum&&!schema.enum.includes(value))fail('ENUM_VALUE');
    if(schema.pattern&&!new RegExp(schema.pattern).test(value))fail('STRING_PATTERN');
  }
  return errors;
}
export function validateResponse({packet,expectedPacketSHA256,raw,expectedRawSHA256}){
  const errors=[],resolvedEvidence=[],differenceCoverage=[];
  const fail=(category,path,code,extra={})=>errors.push({category,path,code,...extra});
  const bytes=typeof raw==='string'?Buffer.from(raw):Buffer.isBuffer(raw)?raw:null;
  if(!bytes)fail('binding','/raw','RAW_STRING_OR_BUFFER_REQUIRED');
  let bindingValid=true;
  try{verifyPacket(packet,expectedPacketSHA256);}catch(e){bindingValid=false;fail('binding','/packet',e.code??'PACKET_INVALID');}
  if(bytes&&expectedRawSHA256!==undefined&&sha256(bytes)!==expectedRawSHA256){bindingValid=false;fail('binding','/raw','RAW_HASH_MISMATCH');}
  let response=null;try{if(bytes)response=JSON.parse(bytes.toString('utf8'));}catch{fail('schema','/','JSON_INVALID');}
  let identityCheck=null;
  if(bindingValid&&bytes){
    schemaErrors(response,packet.responseContract,'',errors);
    if(!errors.some(e=>e.category==='schema')){
      const single=packet.mode==='single',versions=single?['X']:['A','B'];
      const catalogById=new Map(packet.anchors.map(a=>[a.anchorId,a])),byEvidence=new Map(),evidenceIds=new Set();
      for(const [i,e]of response.evidence.entries()){
        const path='/evidence/'+i;
        if(evidenceIds.has(e.id)){fail('anchor',path+'/id','DUPLICATE_EVIDENCE_ID');continue;}evidenceIds.add(e.id);
        const anchor=catalogById.get(e.anchorId);
        if(!anchor){fail('anchor',path+'/anchorId','ANCHOR_UNKNOWN');continue;}
        if(e.version!==anchor.version||e.chapterId!==anchor.chapterId){fail('anchor',path,'ANCHOR_SOURCE_MISMATCH');continue;}
        const item={id:e.id,anchorId:anchor.anchorId,version:anchor.version,chapterId:anchor.chapterId,field:anchor.field,start:anchor.start,end:anchor.end,quote:anchor.text,textSHA256:anchor.textSHA256,paragraphIndex:anchor.paragraphIndex};
        byEvidence.set(e.id,item);resolvedEvidence.push(item);
      }
      const checkRefs=(list,path,requiredVersions,chapterId)=>{
        const found=list.map(id=>byEvidence.get(id));
        if(found.some(v=>!v))fail('contract',path,'EVIDENCE_UNKNOWN_OR_INVALID');
        for(const version of requiredVersions)if(!found.some(e=>e?.version===version&&(!chapterId||(e.chapterId===chapterId&&e.field==='body'))))fail('contract',path,'REQUIRED_SOURCE_MISSING',{version});
        if(requiredVersions.length===1&&found.some(e=>e&&(e.version!==requiredVersions[0]||(chapterId&&e.chapterId!==chapterId))))fail('contract',path,'WRONG_SOURCE');
        return found.filter(Boolean);
      };
      checkRefs(response.overall.evidenceIds,'/overall/evidenceIds',versions);
      checkRefs(response.counterReading.evidenceIds,'/counterReading/evidenceIds',versions);
      for(const id of dims){
        const found=response.dimensions.filter(d=>d.id===id);
        if(found.length!==1){fail('contract','/dimensions','DIMENSION_COVERAGE',{id});continue;}
        if(single)checkRefs(found[0].evidenceIds,'/dimensions/'+id+'/evidenceIds',['X']);
        else for(const version of versions)checkRefs(found[0][version].evidenceIds,'/dimensions/'+id+'/'+version+'/evidenceIds',[version]);
      }
      for(const version of versions)for(const chapterId of packet.chapterIds){
        const found=response.chapterReadings.filter(c=>c.chapterId===chapterId&&(single||c.version===version));
        if(found.length!==1){fail('contract','/chapterReadings','CHAPTER_COVERAGE',{version,chapterId});continue;}
        checkRefs(found[0].evidenceIds,'/chapterReadings/'+version+'/'+chapterId,[version],chapterId);
      }
      const factIds=new Set();
      for(const [i,f]of response.factualChecks.entries()){
        if(factIds.has(f.id))fail('contract','/factualChecks/'+i,'DUPLICATE_FACT_ID');factIds.add(f.id);
        checkRefs(f.evidenceIds,'/factualChecks/'+i+'/evidenceIds',single?['X']:f.scope==='both'?versions:[f.scope]);
      }
      if(!single){
        for(const scope of ['A','B','both'])if(!response.factualChecks.some(f=>f.scope===scope))fail('contract','/factualChecks','FACT_SCOPE_MISSING',{scope});
        const actual=packet.identity.identical?'identical':'different';
        identityCheck={declared:response.textIdentity,actual,consistent:response.textIdentity===actual,uncertain:response.textIdentity==='uncertain'};
        if(!identityCheck.consistent&&!identityCheck.uncertain)fail('identity','/textIdentity','TEXT_IDENTITY_CONTRADICTION');
        const known=new Set(packet.differences.map(d=>d.differenceId));
        for(const c of response.changeReadings)if(!known.has(c.differenceId))fail('contract','/changeReadings','UNKNOWN_DIFFERENCE_ID',{differenceId:c.differenceId});
        for(const diff of packet.differences){
          const found=response.changeReadings.filter(c=>c.differenceId===diff.differenceId);
          const item={differenceId:diff.differenceId,kind:diff.kind,sides:[],covered:false};
          if(found.length!==1)fail('coverage','/changeReadings','DIFFERENCE_READING_MISSING_OR_DUPLICATE',{differenceId:diff.differenceId});
          const cited=found.length===1?checkRefs(found[0].evidenceIds,'/changeReadings/'+diff.differenceId,versions):[];
          for(const version of versions){
            const region=diff[version].regionAnchorIds,context=diff[version].contextAnchorIds;
            const eligible=region.length?region:context;
            const hits=cited.filter(e=>e.version===version&&eligible.includes(e.anchorId));
            const other=packet.manuscripts.find(m=>m.version!==version);
            item.sides.push({version,requiredRole:region.length?'region':'context',eligibleAnchorIds:eligible,citedAnchorIds:hits.map(e=>e.anchorId),commonWordingAnchorIds:hits.filter(e=>other.chapters.some(c=>c.body.includes(e.quote)||c.title.includes(e.quote))).map(e=>e.anchorId),missingRegionAnchorIds:region.filter(id=>!hits.some(e=>e.anchorId===id)),covered:region.length?region.every(id=>hits.some(e=>e.anchorId===id)):hits.length>0});
            if(!item.sides.at(-1).covered)fail('coverage','/changeReadings/'+diff.differenceId,'DIFFERENCE_SIDE_NOT_FULLY_CITED',{differenceId:diff.differenceId,version,requiredRole:region.length?'region':'context'});
          }
          item.covered=item.sides.every(s=>s.covered);differenceCoverage.push(item);
        }
      }
    }
  }
  if(!bytes)bindingValid=false;
  const schemaValid=bindingValid&&bytes!==null&&!errors.some(e=>e.category==='schema');
  const anchorsValid=schemaValid&&!errors.some(e=>e.category==='anchor');
  const evidenceContractValid=anchorsValid&&!errors.some(e=>['contract','coverage'].includes(e.category));
  const valid=bindingValid&&schemaValid&&errors.length===0;
  return {schemaVersion:'isolated-anchor-reading-inspection-2',protocolVersion:PROTOCOL_VERSION,chapterIds:bindingValid?[...packet.chapterIds]:null,requestId:packet?.requestId??null,packetSHA256:bindingValid?expectedPacketSHA256:null,rawSHA256:bytes?sha256(bytes):null,rawByteLength:bytes?.length??null,bindingValid,schemaValid,anchorsValid,evidenceContractValid,identityCheck,differenceCoverage,valid,errors,resolvedEvidence,rawPreference:object(response?.overall)?response.overall.preference??null:null,validatedPreference:valid&&packet.mode==='comparison'?response.overall.preference:null,factJudgment:'requires_human_review',literaryJudgment:'requires_human_review',fullManuscriptAccepted:false};
}
export function inspectExecution({plan,executions}){
  const errors=[],records=[];
  try{
    ensure(plan?.protocolVersion===PROTOCOL_VERSION,'PROTOCOL_VERSION');
    const c=plan.requests.find(r=>r.requestId==='C1').packet.manuscripts;
    ensure(isDeepStrictEqual(buildReadingPlan({manuscripts:Object.fromEntries(c.map(m=>[m.version,m.chapters])),chapterIds:plan.chapterIds}),plan),'PLAN_BINDING');
  }catch{errors.push('PLAN_BINDING');}
  if(!Array.isArray(executions)||executions.length!==3)errors.push('THREE_EXECUTIONS_REQUIRED');
  if(!errors.length)for(const request of plan.requests){
    const found=executions.filter(e=>e?.requestId===request.requestId);
    if(found.length!==1){errors.push('EXECUTION_MISSING_OR_DUPLICATE');continue;}
    const e=found[0];
    if(!isDeepStrictEqual(e.messages,request.messages))errors.push('ACTUAL_MESSAGES_MISMATCH_'+request.requestId);
    if(!nonempty(e.receipt?.contextId)||!nonempty(e.receipt?.invocationId))errors.push('RECEIPT_ID_MISSING_'+request.requestId);
    const raw=typeof e.raw==='string'||Buffer.isBuffer(e.raw)?e.raw:null;
    if(raw===null)errors.push('RAW_MISSING_'+request.requestId);
    records.push({requestId:request.requestId,contextId:e.receipt?.contextId??null,invocationId:e.receipt?.invocationId??null,messagesSHA256:valueSHA256(e.messages??null),rawSHA256:raw===null?null:sha256(raw)});
  }
  if(records.length===3){
    if(new Set(records.map(r=>r.contextId)).size!==3)errors.push('CONTEXTS_NOT_DISTINCT');
    if(new Set(records.map(r=>r.invocationId)).size!==3)errors.push('INVOCATIONS_NOT_DISTINCT');
  }
  return {schemaVersion:'isolated-anchor-execution-inspection-2',protocolVersion:PROTOCOL_VERSION,valid:errors.length===0,errors,records,remoteIsolation:'not_independently_provable',fullManuscriptAccepted:false};
}
