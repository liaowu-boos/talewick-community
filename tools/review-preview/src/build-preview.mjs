import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {openEvidenceStore,sha256} from './evidence-store.mjs';
import {adaptResult,labels} from './result-adapter.mjs';

// Build arguments are trusted local CLI configuration; HTTP accepts no paths.
const [bundle,manifestHash,output,gui,dependencies=gui] = process.argv.slice(2);
assert(bundle&&manifestHash&&output&&gui,'Usage: npm run build -- BUNDLE MANIFEST_SHA OUTPUT GUI [DEPENDENCY_GUI]');
const store=await openEvidenceStore(bundle,manifestHash),view=adaptResult(store);
const require=createRequire(path.resolve(dependencies,'package.json'));
const {build}=require('esbuild'),ts=require('typescript');
const source=fileURLToPath(new URL('./ResultEvidencePanel.tsx',import.meta.url));
const deps=path.resolve(dependencies,'node_modules');
const program=ts.createProgram([source],{noEmit:true,strict:true,skipLibCheck:true,jsx:ts.JsxEmit.ReactJSX,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,baseUrl:path.dirname(source),paths:{'@/*':[path.resolve(gui,'src/*')],react:[path.join(deps,'@types/react/index.d.ts')],'react/jsx-runtime':[path.join(deps,'@types/react/jsx-runtime.d.ts')],'*':[path.join(deps,'*')]},typeRoots:[path.join(deps,'@types')]});
const diagnostics=ts.getPreEmitDiagnostics(program);
if(diagnostics.length)throw Error(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
await mkdir(output,{recursive:false});
await mkdir(path.join(output,'assets'));await mkdir(path.join(output,'evidence'));
const built=await build({stdin:{contents:`import {createElement} from 'react'; import {renderToStaticMarkup} from 'react-dom/server'; import {ResultEvidencePanel} from ${JSON.stringify(source)}; export const render=(view,labels)=>renderToStaticMarkup(createElement(ResultEvidencePanel,{view,labels}));`,resolveDir:path.resolve(gui),loader:'tsx'},bundle:true,platform:'node',format:'cjs',write:false,jsx:'automatic',alias:{'@':path.resolve(gui,'src')},nodePaths:[deps]});
const work=path.resolve(output,'../render-preview.cjs');await writeFile(work,built.outputFiles[0].contents);
const {render}=createRequire(import.meta.url)(work);
const markup=render(view,labels);
const entries=[];
async function put(url,relative,data,contentType,download=false){const bytes=Buffer.isBuffer(data)?data:Buffer.from(data);await writeFile(path.join(output,relative),bytes,{flag:'wx'});entries.push({url,path:relative,sha256:sha256(bytes),contentType,download});}
const index=await readFile(path.resolve(gui,'dist/index.html'),'utf8');
const cssRef=index.match(/href="(\.?\/assets\/[^"\s]+\.css)"/)?.[1];assert(cssRef,'Built BoardUI stylesheet required');
const cssPath=path.resolve(gui,'dist',cssRef.replace(/^\.?\//,''));const css=await readFile(cssPath);
await put('/assets/style.css','assets/style.css',css,'text/css; charset=utf-8');
for(const ref of new Set([...css.toString().matchAll(/url\(([^)]+)\)/g)].map(m=>m[1].trim().replace(/^['"]|['"]$/g,'')))){
 if(ref.startsWith('data:'))continue;assert(/^\.\/[\w.-]+\.woff2?$/.test(ref),'Unexpected CSS asset');
 const name=path.basename(ref);await put('/assets/'+name,'assets/'+name,await readFile(path.resolve(path.dirname(cssPath),ref)),name.endsWith('woff2')?'font/woff2':'font/woff');
}
await put('/','index.html','<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Talewick · 评阅证据</title><link rel="stylesheet" href="/assets/style.css"></head><body class="bg-background-full text-text-primary">'+markup+'</body></html>','text/html; charset=utf-8');
await put('/status.json','status.json',JSON.stringify(view,null,2)+'\n','application/json; charset=utf-8');
for(const entry of store.manifest.entries){const ref=store.ref(entry.id);await put(ref.url,'evidence/'+entry.id+'.txt',store.get(entry.id).bytes,'text/plain; charset=utf-8',true);}
const site=Buffer.from(JSON.stringify({schemaVersion:'review-static-site-1',sourceManifestSHA256:manifestHash,entries},null,2)+'\n');
await writeFile(path.join(output,'site-manifest.json'),site,{flag:'wx'});
const receipt={sourceManifestSHA256:manifestHash,siteManifestSHA256:sha256(site),typecheck:'passed',ssrBuild:'passed',routes:entries.length,providerCalls:0};
await writeFile(path.join(output,'BUILD.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify(receipt));
