import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createFull15Analyze } from './full15-analyze.mjs';
import { createModel } from './model.mjs';

const sha = text => createHash('sha256').update(text, 'utf8').digest('hex');
const prompts = Object.fromEntries(await Promise.all(['cold_read', 'check'].map(async stage =>
 [stage, await readFile(new URL(`../../../creation/novel-review/prompts/${stage}.md`, import.meta.url), 'utf8')])));
const packet = JSON.stringify({text:'第一片第二片',source_sha256:'b'.repeat(64)});
const parts = [packet.slice(0, 30), packet.slice(30)];
const chunks = parts.map((text,index)=>({index,text,start_char:index===0?0:30,end_char:index===0?30:packet.length,sha256:sha(text)}));
const forStage = stage => ({stage,contextKey:'context-from-adapter',prompt:prompts[stage],packetSha256:sha(packet),sourceSha256:'b'.repeat(64),rulesVersion:'rules',chunks,
 manifest:{schema_version:'full15-packet-read-1',stage,packet_sha256:sha(packet),chunk_char_limit:12000,chunk_count:chunks.length}});
const payload=forStage('cold_read');

test('provider bridge uses one stateless call and records actual response id plus delivered indices',async()=>{
 let call;const analyze=createFull15Analyze({model:{complete:async args=>{call=args;await args.onReceipt({provider:'deepseek',invocationId:'chatcmpl-real',contextId:'chatcmpl-real'});return '{"scope":{"read_chunks":[0,1]}}';}}});
 const result=await analyze(payload);assert.equal(call.stage,'full15-cold-read');assert.doesNotMatch(call.system,/只可通过 REVIEW_ENTRY/);assert.match(call.system,/C03：/);assert.match(call.user,/第一片/);
 assert.deepEqual(JSON.parse(call.user).inline_packet,{manifest:payload.manifest,chunks:payload.chunks});
 assert.equal(call.allowRecovery,false);
 assert.deepEqual(result.receipt,{provider:'deepseek',invocationId:'chatcmpl-real',contextId:'chatcmpl-real',packetSha256:payload.packetSha256,deliveredChunkIndices:[0,1]});
});

test('provider bridge fails closed when provider response has no actual id',async()=>{
 const analyze=createFull15Analyze({model:{complete:async()=>'{"scope":{}}'}});
 await assert.rejects(analyze(payload),error=>error.code==='provider_receipt_missing');
});

test('normal provider adapter forwards the actual response id to the full-text bridge',async()=>{
 const model=createModel({baseURL:'https://example.invalid/v1',apiKey:'synthetic-key',model:'deepseek-chat',timeoutMs:1000},async()=>Response.json({id:'chatcmpl-from-provider',choices:[{finish_reason:'stop',message:{content:'{"scope":{"read_chunks":[0,1]}}'}}]}));
 const result=await createFull15Analyze({model})(payload);assert.equal(result.receipt.invocationId,'chatcmpl-from-provider');assert.equal(result.receipt.contextId,'chatcmpl-from-provider');
});

test('Full15 stages do not hide a second provider request behind one receipt', async t => {
  for (const stage of ['cold_read', 'check']) for (const finish of ['length', 'stop']) {
    await t.test(`${stage}: ${finish === 'length' ? 'truncated output' : 'reasoning-only output'}`, async () => {
      let posts = 0;
      const model = createModel({ baseURL: 'https://api.deepseek.com', apiKey: 'synthetic-key', model: 'deepseek-flash', timeoutMs: 1000 }, async () => {
        posts += 1;
        return Response.json({ id: `synthetic-request-${posts}`, choices: [{ finish_reason: finish, message: { content: finish === 'length' ? '{"scope":' : '', reasoning_content: 'synthetic reasoning' } }] });
      });
      await assert.rejects(createFull15Analyze({ model })(forStage(stage)), finish === 'length' ? /长度上限/ : /没有返回正文/);
      assert.equal(posts, 1);
    });
  }
});
