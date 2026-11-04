import path from 'node:path';
import {tmpdir} from 'node:os';
import {after} from 'node:test';
import {mkdir,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {sha256,openEvidenceStore} from '../src/evidence-store.mjs';
const root=await mkdtemp(path.join(tmpdir(),'talewick-review-fixtures-'));
after(()=>rm(root,{recursive:true,force:true}));
export async function fixture(){
 await mkdir(root,{recursive:true});const dir=await mkdtemp(path.join(root,'synthetic-'));await mkdir(path.join(dir,'data'));
 const docs={baseline:'Synthetic baseline only.',candidate:'Synthetic candidate only.'};
 const binding={caseId:'synthetic-story',baselineSHA256:sha256(docs.baseline),candidateSHA256:sha256(docs.candidate)};
 const entries=[];
 async function put(id,sourceId,kind,value){const bytes=Buffer.from(typeof value==='string'?value:JSON.stringify(value));await writeFile(path.join(dir,'data',id+'.json'),bytes);const e={id,sourceId,kind,path:'data/'+id+'.json',sha256:sha256(bytes),...binding};const at=entries.findIndex(x=>x.id===id);if(at<0)entries.push(e);else entries[at]=e;}
 await put('baseline','manuscript','manuscript',docs.baseline);await put('candidate','manuscript','manuscript',docs.candidate);
 const report=(sourceId,failed)=>({schemaVersion:'review-source-result-1',...binding,sourceId,process:{status:'complete',completed:1,total:1,summary:'Synthetic process only'},citations:{total:2,checked:2,exact:failed?1:2,failures:failed?[{code:'QUOTE_NOT_IN_ANCHOR',location:'/evidence/1',anchorId:'S2'}]:[],originalPassed:!failed,summary:'Synthetic citation check'},references:[sourceId+'-raw']});
 const a=report('reviewer-a',false),b=report('reviewer-b',true);
 for(const s of ['reviewer-a','reviewer-b'])await put(s+'-raw',s,'evidence','Synthetic original '+s);
 await put('a','reviewer-a','source-report',a);await put('b','reviewer-b','source-report',b);
 await put('audit','coordinator','evidence','Synthetic human audit');
 const conclusion={schemaVersion:'review-conclusion-result-1',...binding,sourceId:'coordinator',authority:'coordinator',factReview:{status:'complete_with_corrections',summary:'Correction preserved separately',references:['audit']},literaryQuality:{status:'tradeoff',summary:'Synthetic tradeoff',references:['audit']},adoption:{status:'recommend_candidate',summary:'Recommendation only',references:['audit']}};
 await put('conclusion','coordinator','conclusion',conclusion);
 const manifest={schemaVersion:'review-evidence-manifest-1',...binding,title:'Synthetic story',versionLabel:'Synthetic version X',baselineId:'baseline',candidateId:'candidate',sources:[{id:'reviewer-a',label:'Reviewer A',reportId:'a'},{id:'reviewer-b',label:'Reviewer B',reportId:'b'}],conclusionId:'conclusion',entries};
 const seal=async()=>{const bytes=Buffer.from(JSON.stringify(manifest));await writeFile(path.join(dir,'manifest.json'),bytes);return sha256(bytes);};
 const open=async()=>openEvidenceStore(dir,await seal());
 return {dir,manifest,a,b,conclusion,put,seal,open};
}
