#!/usr/bin/env node
import {readFileSync} from 'node:fs';
import {prepareWholeQualityEvaluation,prepareStandaloneIndependentReading,prepareFollowupIndependentReading,validateStandaloneIndependentReading,mergeStandaloneIndependentReading,validateIndependentReading,validateBlindPairReview,validateGoalAudit,finalizeWholeQualityEvaluation} from './whole-quality-evaluation.mjs';

const usage=`Offline whole-manuscript quality protocol (JSON on stdout):
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs prepare REQUEST.json
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-prepare CREATION_REQUEST_OR_READING_INPUT.json
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-validate INPUT.json
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-followup INPUT.json
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs standalone-merge INPUT.json
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs validate INPUT.json
  node modules/validation/runtime/whole-quality-evaluation-cli.mjs finalize INPUT.json

validate input: {"stage":"independent|pair|goal","bundle":{...},"record":{...}}
finalize input: {"bundle":{...},"privateBinding":{...},"independentRecords":[...],"pairRecords":[...],"goalRecord":{...}}
No model, network, API key, service, or implicit file write is used.`;

try{
  const [command,path,...rest]=process.argv.slice(2);
  if(!command||command==='--help'){console.log(usage);process.exit(0);}
  if(!['prepare','standalone-prepare','standalone-validate','standalone-followup','standalone-merge','validate','finalize'].includes(command)||!path||rest.length)throw new Error('Usage error');
  const input=JSON.parse(readFileSync(path,'utf8'));
  let result;
  if(command==='prepare')result=prepareWholeQualityEvaluation(input);
  else if(command==='standalone-prepare')result=prepareStandaloneIndependentReading(input);
  else if(command==='standalone-validate')result=validateStandaloneIndependentReading(input.packet,input.record);
  else if(command==='standalone-followup')result=prepareFollowupIndependentReading(input);
  else if(command==='standalone-merge')result=mergeStandaloneIndependentReading(input);
  else if(command==='finalize')result=finalizeWholeQualityEvaluation(input);
  else{
    if(input.stage==='independent')result=validateIndependentReading(input.bundle,input.record);
    else if(input.stage==='pair')result=validateBlindPairReview(input.bundle,input.record);
    else if(input.stage==='goal')result=validateGoalAudit(input.bundle,input.record);
    else throw new Error('Unknown validation stage');
  }
  console.log(JSON.stringify(result,null,2));
}catch(error){console.error(`${error.code??error.name}: ${error.message}`);process.exitCode=1;}
