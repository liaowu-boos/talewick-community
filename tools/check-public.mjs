/** Fail closed on unexpected files before a public commit or in CI. Never print secrets. */
import { execFileSync } from 'node:child_process';
import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=await realpath(fileURLToPath(new URL('../',import.meta.url)));
const excluded=new Set(['node_modules','dist','.git','.local-runs','.local-releases','agent-evidence','runtime-evidence']);
async function walk(dir=''){
 const result=[];
 for(const item of await readdir(path.join(root,dir),{withFileTypes:true})){
  if(excluded.has(item.name)||item.name.endsWith('.tsbuildinfo')||item.name.endsWith('.log')||item.name==='.DS_Store'||(item.name.startsWith('.env')&&item.name!=='.env.example'))continue;
  const rel=path.posix.join(dir,item.name);
  if(item.isDirectory())result.push(...await walk(rel));else result.push(rel);
 }
 return result;
}
let files;
try{
 const top=execFileSync('git',['rev-parse','--show-toplevel'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();
 if(await realpath(top)!==root)throw Error('not a standalone repository');
 files=execFileSync('git',['ls-files','--cached','--others','--exclude-standard','-z'],{cwd:root,encoding:'utf8'}).split('\0').filter(Boolean);
}catch{files=await walk();}
const approvedRoots=new Set(['modules','examples','licenses','tools','.github']);
const approvedRootFiles=new Set(['README.md','README.en.md','CONTRIBUTING.md','CONTRIBUTING.en.md','LICENSE','THIRD_PARTY_NOTICES.md','VERIFICATION.md','.gitignore']);
// Review definitions and one audited synthetic fixture; never allow a whole JSON directory.
const approvedReviewJSON=new Set([
 'modules/creation/novel-review/checks.json',
 'modules/creation/novel-review/report_fields.json',
 'modules/creation/novel-review/SOURCE_SNAPSHOTS.json',
 'modules/creation/novel-review/acceptance/functional_cases.json',
]);
const forbidden=/(?:^|\/)(?:node_modules|dist|\.local-runs|\.local-releases|private|source-library|objects|project-archive|development|9月爆款分类|10月爆款分类|优秀文笔例文—爱意全家桶|小说样本数据补充-可信样本)(?:\/|$)/;
const secrets=/(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{24,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/;
const errors=[];let bytes=0;
for(const rel of new Set(files)){
 const p=path.join(root,rel);const st=await lstat(p);bytes+=st.size;
 if(st.isSymbolicLink()||!st.isFile()){errors.push([rel,'not a regular file']);continue;}
 if(forbidden.test(rel)||(!approvedRoots.has(rel.split('/')[0])&&!approvedRootFiles.has(rel)))errors.push([rel,'outside public scope']);
 if(/(?:^|\/)\.env(?:\.|$)/.test(rel)&&!rel.endsWith('/.env.example'))errors.push([rel,'private environment file']);
 if(st.size>10*1024*1024){errors.push([rel,'over 10 MiB']);continue;}
 const extension=path.extname(rel);
 if(extension==='.json'&&!approvedReviewJSON.has(rel)&&!/^modules\/product\/talewick-gui\/(?:package(?:-lock)?|tsconfig)\.json$/.test(rel))errors.push([rel,'unreviewed JSON data']);
 if(rel.includes('/source-snapshots/')&&rel!=='modules/creation/novel-review/source-snapshots/public-check-rules.md')errors.push([rel,'unreviewed rule snapshot']);
 if(rel.includes('/migration-evidence/'))errors.push([rel,'private historical evidence']);
 if(extension==='.txt'&&!rel.startsWith('licenses/')&&!rel.startsWith('examples/'))errors.push([rel,'text outside examples/licenses']);
 if(/\.(?:zip|gz|tar|pdf|sqlite|db|pem|key)$/i.test(rel))errors.push([rel,'unreviewed binary/archive/key file']);
 if(extension!=='.png'){
  const text=await readFile(p,'utf8');
  if(secrets.test(text))errors.push([rel,'possible secret (value hidden)']);
  if(/\/Users\/[^/\s]+\//.test(text))errors.push([rel,'personal absolute path']);
  if(extension==='.md')for(const match of text.matchAll(/\]\(([^)]+)\)/g)){
   const target=match[1].split('#')[0];if(!target||target.includes('://'))continue;
   try{await lstat(path.resolve(path.dirname(p),target));}catch{errors.push([rel,`missing link: ${target}`]);}
  }
 }
}
if(errors.length){for(const [file,reason]of errors)console.error(`${file}: ${reason}`);process.exitCode=1;}
else console.log(JSON.stringify({status:'PASS',files:new Set(files).size,bytes,scope:'public file allowlist and credential patterns; not a comprehensive security audit'}));
