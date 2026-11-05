// Optional integrated check against a supplied local FULL15 inspector build.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {sha256} from '../src/evidence-store.mjs';
import {adaptResult,labels} from '../src/result-adapter.mjs';
import {comparisonFixture} from './comparison-fixture.mjs';

test('FULL15 output through the registered evidence store, adapter and renderer', async () => {
const validator=path.resolve(process.argv[2]);
const {inspectComparisonCitationCoverage}=await import(pathToFileURL(validator));
const input=JSON.parse(await readFile(new URL('./fixtures/comparison-coverage/input.json',import.meta.url)));
const expected=JSON.parse(await readFile(new URL('./fixtures/comparison-coverage/result.json',import.meta.url)));
const full=inspectComparisonCitationCoverage(input);
assert.deepEqual(full,expected);
const sample=await comparisonFixture([input,full]);
const tool=fileURLToPath(new URL('../',import.meta.url));
const gui=path.resolve(tool,'../../modules/product/talewick-gui');
const out=await mkdtemp(path.join(tmpdir(),'comparison-preview-'));
try {
  execFileSync(process.execPath,['src/build-preview.mjs',sample.dir,await sample.seal(),path.join(out,'site'),gui],{cwd:tool});
  const {render}=createRequire(import.meta.url)(path.join(out,'render-preview.cjs'));
  async function inspect(modified){
    const coverage=inspectComparisonCitationCoverage(modified);
    const f=await comparisonFixture([modified,coverage]);
    const view=adaptResult(await f.open());
    return {opinion:view.sources[0].comparisons[0],html:render(view,labels)};
  }
  const shared=structuredClone(input);shared.comparisons=[shared.comparisons[0]];delete shared.comparisons[0].counterEvidence;
  const a=await inspect(shared);assert.equal(a.opinion.exact,2);assert.equal(a.opinion.changedParagraphCount,0);assert.equal(a.opinion.preference,'second');assert(a.html.includes('主证据引文都在两稿共有段'));
  const repeated=structuredClone(input);repeated.comparisons=[repeated.comparisons[1]];repeated.comparisons[0].evidence.fill(repeated.comparisons[0].evidence[0]);
  const b=await inspect(repeated);assert.equal(b.opinion.exact,2);assert.equal(b.opinion.changedParagraphCount,1);assert(b.html.includes('<dd>1 段</dd>'));
  const partial=structuredClone(repeated);partial.comparisons[0].evidence[1]={...partial.comparisons[0].evidence[1],quote:'absent quote'};
  const c=await inspect(partial);assert.equal(c.opinion.exact,1);assert.equal(c.opinion.changedParagraphCount,null);assert.equal(c.opinion.knownChanged,1);assert(c.html.includes('<dd>待核</dd>'));
  const sealedReaders=[];
  if (process.argv[3]) {
    const records=JSON.parse(await readFile(process.argv[3]));
    for (const {readerId,input:readerInput,original,recordSha256} of records) {
      const coverage=inspectComparisonCitationCoverage(readerInput);
      const f=await comparisonFixture([readerInput,coverage,original]);
      const view=adaptResult(await f.open());const html=render(view,labels);
      const opinions=view.sources[0].comparisons;
      assert(opinions.every(op=>op.preference===original.preference));
      assert(html.includes('（'+original.preference+'）'));
      const totals=opinions.reduce((acc,op)=>[acc[0]+op.exact,acc[1]+Number(op.sharedOnly)*op.total], [0,0]);
      const hitIds=coverage.byChannel.evidence.changedUnitIds.filter(id=>coverage.units[id].field==='body');
      sealedReaders.push({readerId,recordSha256,preference:original.preference,exact:totals[0],shared:totals[1],changedBodyUnits:hitIds.length,perOpinion:opinions.map(op=>[op.exact,op.changedParagraphCount])});
    }
    assert.deepEqual(sealedReaders.map(r=>[r.exact,r.shared,r.changedBodyUnits]),[[12,12,0],[12,10,2]]);
  }
  console.log(JSON.stringify({sealedReaders,validatorSHA256:sha256(await readFile(validator)),actualOutputMatchesFixture:true,full15ToAdapterToSSR:true,allShared:[2,0,'second'],repeatedChanged:[2,1],partial:[1,null,1]}));
}finally{await rm(out,{recursive:true,force:true});}
});
