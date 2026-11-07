import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {renderIsolatedReport} from '../src/isolated-report.mjs';
import {createDemoInput} from '../demo-isolated-input.mjs';
import {sha256,validateResponse} from '../../isolated-anchor-reading/review-tools.mjs';

test('returned, protocol, human, preference and editorial states remain distinct in the rendered report',()=>{
  const html=renderIsolatedReport(createDemoInput(),{synthetic:true});
  const [s1,s2,c1]=[...html.matchAll(/<article>([\s\S]*?)<\/article>/g)].map(x=>x[1]);
  assert.match(s1,/回包止于此处/);assert.match(s1,/协议校验未通过/);
  assert.match(s2,/协议与冻结锚点校验通过/);assert.match(s2,/人工语义复核未通过/);
  const panel=s2.split('<summary>事实主张与冻结原句</summary>')[1].split('</details>')[0];
  assert.match(panel,/访客在结尾拿走了柜台上的钥匙。/);assert.match(panel,/访客把伞靠在门边。/);
  for(const s of [s1,s2]){assert.match(s,/单稿阅读不适用稿间偏好/);assert.doesNotMatch(s,/机械核验有效偏好/);}
  assert.match(c1,/当前快照没有可读的回包记录/);assert.match(html,/编辑采纳未决定/);assert.match(html,/全稿未验收/);
  assert.match(html,/合成演示 · 无真实评阅/);assert.doesNotMatch(html,/<script\b|(?:src|href|action)\s*=/i);
});

test('untrusted text cannot create markup; duplicated evidence is not a reliable location',()=>{
  const input=createDemoInput(), r=input.manifest.requests[1], q=input.plan.requests[1];
  const data=JSON.parse(input.get(r.rawId).bytes);
  data.factualChecks[0].claim='<img src=x onerror="boom">';
  const cited=data.evidence.find(e=>e.id===data.factualChecks[0].evidenceIds[0]);
  data.evidence.push({...cited});
  const raw=JSON.stringify(data);const inspection=validateResponse({packet:q.packet,expectedPacketSHA256:q.packetSHA256,raw});
  const overrides=new Map([[r.rawId,raw],[r.inspectionId,JSON.stringify(inspection)]]);
  const html=renderIsolatedReport({...input,get:id=>{
    if(!overrides.has(id))return input.get(id);
    const bytes=Buffer.from(overrides.get(id));return {bytes,entry:{sha256:sha256(bytes)}};
  }});
  assert.doesNotMatch(html,/<img\b/);assert.match(html,/&lt;img /);
  const panel=html.split('<summary>事实主张与冻结原句</summary>')[1].split('</details>')[0];
  assert.match(panel,/未可靠定位（证据 ID 重复）/);assert.match(html,/人工复核记录绑定失败/);
});

test('a mismatched trusted plan digest aborts report generation',()=>{
  assert.throws(()=>renderIsolatedReport({...createDemoInput(),expectedPlanSHA256:'0'.repeat(64)}),/hash mismatch/);
});

test('demo CLI creates once and refuses to replace an existing file',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'talewick-report-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const dest=path.join(dir,'report.html'),cli=fileURLToPath(new URL('../isolated-report-demo.mjs',import.meta.url));
  execFileSync(process.execPath,[cli,dest]);const generated=await readFile(dest,'utf8');assert.match(generated,/合成演示/);
  assert.throws(()=>execFileSync(process.execPath,[cli,dest],{stdio:'pipe'}));
  assert.equal(await readFile(dest,'utf8'),generated);
});
