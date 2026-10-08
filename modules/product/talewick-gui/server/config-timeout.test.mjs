import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {loadConfig,publicConfig} from './config.mjs';

async function fixture(t,text='') {
 const folder=await mkdtemp(path.join(os.tmpdir(),'talewick-timeout-config-'));
 t.after(()=>rm(folder,{recursive:true,force:true}));
 const file=path.join(folder,'.env.local');await writeFile(file,text);return file;
}
test('native V4 defaults match long thinking calls with a separate progress timeout',async t=>{
 const config=await loadConfig({},await fixture(t));
 assert.equal(config.timeoutMs,600000);assert.equal(config.idleTimeoutMs,180000);
 assert.equal(config.agentProvider,'deepseek');
 assert.equal(publicConfig(config).apiKey,undefined);
});
test('an explicitly configured total remains exact and environment wins over the file',async t=>{
 const file=await fixture(t,'TALEWICK_MODEL_TIMEOUT_MS=120000\nTALEWICK_MODEL_IDLE_TIMEOUT_MS=90000\n');
 const exact=await loadConfig({},file);assert.equal(exact.timeoutMs,120000);assert.equal(exact.idleTimeoutMs,90000);
 const env=await loadConfig({TALEWICK_MODEL_TIMEOUT_MS:'600000',TALEWICK_MODEL_IDLE_TIMEOUT_MS:'180000'},file);
 assert.equal(env.timeoutMs,600000);assert.equal(env.idleTimeoutMs,180000);
 const short=await loadConfig({TALEWICK_MODEL_TIMEOUT_MS:'2000'},await fixture(t));
 assert.equal(short.timeoutMs,2000);assert.equal(short.idleTimeoutMs,2000);
});
test('compatible and older models retain their original default total deadline',async t=>{
 const file=await fixture(t);
 for(const env of [{TALEWICK_API_BASE_URL:'https://example.invalid/v1'}, {TALEWICK_AGENT_PROVIDER:'openai-compatible'}, {TALEWICK_MODEL:'deepseek-chat'}]){
  const c=await loadConfig(env,file);assert.equal(c.timeoutMs,180000);assert.equal(c.idleTimeoutMs,180000);
 }
});
test('idle timeout validation cannot silently extend or remove the total bound',async t=>{
 const file=await fixture(t);
 for(const idle of ['0','999','600001','abc','180000.5'])await assert.rejects(loadConfig({TALEWICK_MODEL_IDLE_TIMEOUT_MS:idle},file),/无进展等待时间/);
 await assert.rejects(loadConfig({TALEWICK_MODEL_TIMEOUT_MS:'1000',TALEWICK_MODEL_IDLE_TIMEOUT_MS:'2000'},file),/无进展等待时间/);
});
