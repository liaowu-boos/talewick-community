// Local-only HTTP verification. All task/story records are synthetic and isolated.
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createRuntime } from '../server/index.mjs';
import { createProjectImportFixture, saveProjectImportFixture } from '../server/fixtures/project-import.mjs';

const infoPath=process.argv[2];
if(!infoPath)throw new Error('Provide an unused local JSON info path.');
const runsDir=await mkdtemp(path.join(os.tmpdir(),'talewick-import-smoke-')),fixture=await createProjectImportFixture();
await saveProjectImportFixture(runsDir,fixture);let modelCalls=0;
const runtime=await createRuntime({config:{runsDir,apiKey:'synthetic-local-only',baseURL:'http://127.0.0.1:1',model:'synthetic',port:0},
  model:{complete:async()=>{modelCalls++;throw new Error('All provider requests are forbidden in this smoke.');}},
  workflow:async()=>{throw new Error('GET smoke cannot start a workflow.');},library:null,full15Adapter:null,independentReviewAdapter:null,
  publicationFeedback:{list:async()=>[],close:async()=>{}}});
runtime.server.listen(0,'127.0.0.1');await once(runtime.server,'listening');
const info={baseURL:`http://127.0.0.1:${runtime.server.address().port}`,projectId:fixture.task.projectId,
  sourceTaskId:fixture.task.id,failedTaskId:fixture.failed.id,runsDir,pid:process.pid,fixtureOnly:true,
  syntheticFixtureCompletions:fixture.syntheticCompletions,modelCalls:0,providerRequests:0};
await writeFile(infoPath,JSON.stringify(info,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({status:'listening',...info}));
let closing=false;
async function close(){
  if(closing)return;closing=true;runtime.server.closeAllConnections();
  await new Promise(resolve=>runtime.server.close(resolve));await runtime.close();
  await writeFile(`${infoPath}.closed.json`,JSON.stringify({...info,closed:true,modelCalls,providerRequests:0},null,2)+'\n',{flag:'wx'});
  await rm(runsDir,{recursive:true,force:true});
}
process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
