/** No API key or model calls: boot the production entry with an empty library. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';
const app = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'talewick-fresh-'));
const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['server/index.mjs'], { cwd: app, env: { ...process.env, TALEWICK_PORT: String(port), TALEWICK_RUNS_DIR: dir, TALEWICK_LIBRARY_DIR: join(dir,'library'), TALEWICK_API_KEY: '', DEEPSEEK_API_KEY: '' }, stdio: ['ignore','pipe','pipe'] });
let output=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
let browser;
try {
  let status;
  for(let i=0;i<120;i++){try{status=await(await fetch(base+'/api/runtime')).json();break;}catch{await new Promise(r=>setTimeout(r,100));}}
  assert.ok(status, output); assert.equal(status.configured,false);assert.equal(status.library.available,true);
  const sources=await(await fetch(base+'/api/library/sources')).json();assert.deepEqual(sources.items,[]);
  const tasks=await(await fetch(base+'/api/tasks')).json();assert.deepEqual(tasks.tasks,[]);
  const pw=process.env.TALEWICK_PLAYWRIGHT_MODULE?await import(pathToFileURL(resolve(process.env.TALEWICK_PLAYWRIGHT_MODULE))):await import('playwright');
  browser=await pw.chromium.launch({headless:true,executablePath:process.env.TALEWICK_BROWSER_EXECUTABLE||undefined});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});const page=await context.newPage();
  const errors=[],failed=[],external=[];page.on('pageerror',e=>errors.push(e.message));page.on('response',r=>{if(r.status()>=400)failed.push([r.url(),r.status()]);});
  await context.route('**/*',route=>{if(route.request().url().startsWith(base+'/')||/^(data:|blob:)/.test(route.request().url()))return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(base,{waitUntil:'networkidle'});await page.getByRole('textbox',{name:'创作想法',exact:true}).waitFor();await page.evaluate(()=>document.fonts.ready);
  const capture=process.env.TALEWICK_SCREENSHOT;
  if(capture){await mkdir(resolve(capture,'..'),{recursive:true});await page.screenshot({path:capture,fullPage:true});}
  for(const width of [1440,390]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`overflow at ${width}`);}
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);assert.deepEqual(external,[]);
  console.log(JSON.stringify({status:'PASS',emptyLibrary:true,unconfiguredState:true,viewports:[1440,390],modelCalls:0}));
} finally {
  await browser?.close();child.kill('SIGTERM');await new Promise(r=>child.exitCode!==null?r():child.once('exit',r));await rm(dir,{recursive:true,force:true});
}
