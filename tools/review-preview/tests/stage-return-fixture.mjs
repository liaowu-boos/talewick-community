import {sha256} from '../src/evidence-store.mjs';
import {fixture} from './fixture.mjs';

export async function stageReturnFixture() {
  const f=await fixture(), source=f.manifest.sources[0], req=sha256('synthetic request');
  const failed='pair-a', accepted='pair-b', saved={preference:'first'}, valid={preference:'second',readerId:'reader-b'};
  const digest=v=>sha256(JSON.stringify(v));
  const validHash=digest(valid); // keys are in canonical order
  const seal={stageId:accepted,stage:'blind_pair',attemptId:'b',record:valid,recordSha256:validHash};
  const validation={ok:true,stage:'blind_pair',readerId:'reader-b',recordSha256:validHash};
  const journal=[{type:'created',requestHash:req,totalStages:4},
    {type:'dispatch_started',stageId:failed,attemptId:'a'},{type:'provider_returned',stage:'blind_pair',stageId:failed,attemptId:'a',inputHash:sha256('a')},
    {type:'stage_needs_attention',stageId:failed,attemptId:'a',code:'PARAGRAPH_REFERENCE_UNKNOWN'},
    {type:'provider_returned',stage:'blind_pair',stageId:accepted,attemptId:'b',inputHash:sha256('b')},
    {type:'stage_sealed',stage:'blind_pair',stageId:accepted,attemptId:'b',recordSha256:validHash},
  ].map(e=>JSON.stringify(e)+'\n').join('');
  const attempt=(id,state,raw,reason,code=null)=>({attemptId:id,state,reason,inputHash:sha256(id),providerReturnEvents:raw ? 1 : 0,rawResponse:raw ? {sha256:digest(raw),byteLength:Buffer.byteLength(JSON.stringify(raw))}:null,failureCode:code});
  const stages=[
    {stageId:failed,state:'returned_invalid',reason:'returned_with_saved_raw_and_rejection',attempts:[attempt('a','returned_invalid',saved,'returned_with_saved_raw_and_rejection','PARAGRAPH_REFERENCE_UNKNOWN')]},
    {stageId:'reader-c',state:'unknown',reason:'return_event_or_raw_missing',attempts:[attempt('c','unknown',null,'return_event_or_raw_missing')]},
    {stageId:'reader-d',state:'not_dispatched',reason:'no_attempt_in_snapshot',attempts:[]},
    {stageId:accepted,state:'sealed',reason:'existing_seal_observed',attempts:[attempt('b','sealed',valid,'existing_seal_observed')]},
  ];
  const diagnostic={schemaVersion:'independent-review-stage-diagnostics-1',requestHash:req,taskMetadataSHA256:sha256('synthetic metadata'),eventsSHA256:sha256(journal),stages,counts:{returned_invalid:1,unknown:1,not_dispatched:1,sealed:1}};
  source.stageDiagnostics={requestHash:req,taskMetadataSHA256:diagnostic.taskMetadataSHA256,diagnosticId:'diag',journalId:'events',attachments:[
    {stageId:failed,attemptId:'a',rawId:'rejected-raw'},{stageId:accepted,attemptId:'b',rawId:'accepted-raw',sealId:'seal',validationId:'validation'}]};
  async function save(events=journal){diagnostic.eventsSHA256=sha256(events);for(const [id,value] of Object.entries({diag:diagnostic,events,'rejected-raw':saved,'accepted-raw':valid,seal,validation}))await f.put(id,source.id,'evidence',value);}
  await save();return {...f,source,diagnostic,journal,save,sealRecord:seal,validation};
}
