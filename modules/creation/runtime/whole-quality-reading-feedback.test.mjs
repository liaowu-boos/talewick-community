import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {collectWholeQualityReadingEvidenceFeedback,createWholeQualityRequestSpec,runWholeManuscriptQualityRevision,
  inspectStoredWholeQualityReadingFailure,WHOLE_QUALITY_READING_REPAIR_VERSION,WHOLE_QUALITY_READING_FEEDBACK_LIMITS} from './whole-manuscript-quality.mjs';

const clone=value=>structuredClone(value),sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>Array.isArray(value)?value.map(canonical):value!==null&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const fingerprint=value=>sha(JSON.stringify(canonical(value)));
const ev=(chapterId,quote,extra={})=>({chapterId,quote,purpose:'合成字面位置测试',...extra});
const noModel={complete:async()=>assert.fail('unexpected model/provider call')};
function fixture(chapters=[{id:'ch-1',title:'一',body:'入口。共同句。出口。'},{id:'ch-2',title:'二',body:'入口。共同句。出口。'}]){
  const request={kind:'revise',revisionMode:'whole-manuscript-v2',baseRevision:'fixture-1',instruction:'保留判断，只测试引用。',chapters};
  const requestSpec=createWholeQualityRequestSpec(request),input={schemaVersion:'whole-quality-reading-input-1',requestSpec,chapters,
    responseBindings:{schemaVersion:'whole-quality-reading-1',sourceManuscriptSha256:requestSpec.sourceManuscriptSha256,checkedChapterIds:chapters.map(c=>c.id)}};
  const value={...input.responseBindings,inputHash:fingerprint(input),coverage:{status:'complete',omissions:[]},synopsis:'合成',sceneChanges:[],issues:[],strengths:[],unresolved:[]};
  return {input,value};
}
const feedback=f=>collectWholeQualityReadingEvidenceFeedback({input:f.input,rawResponse:JSON.stringify(f.value)});
const journal=()=>{const artifacts={};return {artifacts,checkpoint:async(key,value)=>{assert.equal(Object.hasOwn(artifacts,key),false);artifacts[key]=clone(value);}};};
const runtimeOptions=f=>({request:f.request,queryDeepReferences:async()=>assert.fail('reading failure must precede retrieval')});

test('all schema evidence positions are scanned; shared chapter and quote failures remain separate, valid literals ignored',()=>{
  const f=fixture(),bad=ev('ch-1','缺字句。'),valid=ev('ch-2','共同句。',{purpose:''});
  f.value.sceneChanges=[{chapterId:'ch-1',entryEvidence:bad,exitEvidence:valid,preservedStrengths:[bad]}];
  f.value.issues=[{evidence:[ev('not-a-chapter','共同句。')],counterEvidence:[bad],preservation:[valid,bad]}];
  f.value.strengths=[bad,valid];const before=clone(f),r=feedback(f);
  assert.equal(r.checkedLocationCount,9);assert.equal(r.totalInvalidCount,6);
  assert.deepEqual(r.locations.map(l=>l.fieldPath),['sceneChanges[0].entryEvidence','sceneChanges[0].preservedStrengths[0]',
    'issues[0].evidence[0]','issues[0].counterEvidence[0]','issues[0].preservation[1]','strengths[0]']);
  assert.match(r.locations[2].diagnostic,/章节无效/);assert.equal(r.locations[2].chapterBodySha256,undefined);
  assert.deepEqual(f,before);
});

test('ambiguity, invalid occurrence and UTF-16 start remain errors; exact whitespace and surrogate spans remain valid',()=>{
  const body='😀\r\n 同句。 \n同句。\n尾。',f=fixture([{id:'ch-1',title:'一',body}]);
  f.value.strengths=[ev('ch-1','同句。'),ev('ch-1','同句。',{occurrence:0}),ev('ch-1','同句。',{occurrence:3}),
    ev('ch-1','同句。',{occurrence:2}),ev('ch-1','尾。',{occurrence:2}),ev('ch-1','\r\n 同句。',{start:1}),
    ev('ch-1','\r\n 同句。',{start:2}),ev('ch-1',' 同句。 \n'),ev('ch-1','😀\n'),ev('ch-1','尾。',{start:null})];
  const r=feedback(f);assert.deepEqual(r.locations.map(l=>l.fieldPath),[0,1,2,4,5,8,9].map(n=>`strengths[${n}]`));
  assert.match(r.locations[0].diagnostic,/重复引文/);assert.match(r.locations[3].diagnostic,/唯一引文 occurrence/);
  assert.match(r.locations[4].diagnostic,/UTF-16/);assert.equal(r.locations[5].quote,'😀\n');
});

test('location and serialized-character caps retain exact remaining counts while scanning later evidence',()=>{
  const f=fixture();f.value.strengths=Array.from({length:47},()=>ev('ch-1','不存在。'));
  let r=feedback(f);assert.equal(r.totalInvalidCount,47);assert.equal(r.listedCount,24);assert.equal(r.remainingCount,23);
  assert.equal(r.locations.at(-1).fieldPath,'strengths[23]');
  f.value.strengths=Array.from({length:24},()=>ev('ch-1','错'.repeat(2000)));
  r=feedback(f);assert.equal(r.totalInvalidCount,24);assert.ok(r.listedCount>0&&r.listedCount<24);
  assert.equal(r.remainingCount,24-r.listedCount);assert.ok(JSON.stringify(r.locations).length<=WHOLE_QUALITY_READING_FEEDBACK_LIMITS.locationChars);
});

test('overlong values are omitted explicitly and hashed, never clipped into proposed quotes',()=>{
  const f=fixture(),quote='错'.repeat(2001),chapterId='x'.repeat(201);f.value.strengths=[ev(chapterId,quote)];
  const l=feedback(f).locations[0];assert.equal(l.quote,undefined);assert.equal(l.quoteOmitted,true);assert.equal(l.quoteLength,2001);assert.equal(l.quoteSha256,sha(quote));
  assert.equal(l.chapterId,null);assert.equal(l.chapterIdOmitted,true);assert.equal(l.chapterIdSha256,sha(chapterId));
  assert.equal(l.replacementQuote,undefined);assert.equal(f.value.strengths[0].quote,quote);
});

test('malformed JSON and non-object roots are explicitly unscanned; bad binding is not a clean report',()=>{
  const f=fixture();
  for(const rawResponse of ['{"sceneChanges":[','[]','null','x'.repeat(500001)]){
    const r=collectWholeQualityReadingEvidenceFeedback({input:f.input,rawResponse});
    assert.equal(r.scanStatus,'not_scanned');assert.equal(r.reason,'invalid_json_response');assert.equal(r.totalInvalidCount,null);assert.equal(r.remainingCount,null);assert.deepEqual(r.locations,[]);
  }
  f.value.inputHash='0'.repeat(64);const r=feedback(f);assert.equal(r.reason,'response_binding_mismatch');assert.equal(r.totalInvalidCount,null);
  f.input.chapters[0].body+='改';assert.throws(()=>feedback(f),{code:'WHOLE_QUALITY_REQUEST_SPEC'});
});
