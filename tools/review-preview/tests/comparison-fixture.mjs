import { readFile } from 'node:fs/promises';
import { fixture } from './fixture.mjs';

export async function comparisonFixture(sample) {
  const read = async name => JSON.parse(await readFile(new URL(`./fixtures/comparison-coverage/${name}.json`,import.meta.url)));
  const [input,coverage] = sample ?? await Promise.all([read('input'),read('result')]);
  const f = await fixture({baseline:JSON.stringify({chapters:input.baselineChapters}),candidate:JSON.stringify({chapters:input.candidateChapters})});
  const original = sample?.[2] ?? {preference:'second',comparisons:input.comparisons};
  const source = f.a.sourceId;
  f.a.citations = {...f.a.citations, total:coverage.citations.length, checked:coverage.citations.length, exact:coverage.citations.filter(r=>r.location==='exact').length, failures:coverage.citations.filter(r=>r.location!=='exact').map(r=>({code:r.location,location:r.pointer})),originalPassed:coverage.citations.every(r=>r.location==='exact')};
  f.a.comparisons = input.comparisons.map((comparison,index) => ({
    id:comparison.id, label:comparison.statement ?? '章题意见', originalId:'pair-record', index,
    coverageId:'pair-coverage', rolesByBlindId: input.rolesByBlindId,
  }));
  async function save() {
    await f.put('pair-record',source,'evidence',original);
    await f.put('pair-coverage',source,'evidence',coverage);
    await f.put('a',source,'source-report',f.a);
  }
  await save();
  return { ...f, original, coverage, save };
}
