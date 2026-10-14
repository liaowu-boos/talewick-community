import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createLibraryRouter, createRetrieveKnowledge, decodeImport, loadLibraryService, MAX_SOURCE_BYTES } from './library.mjs';

const source = { contractVersion: 'v04-contract-1', sourceId: 'source-1', title: '测试作品', status: 'partial', indexStatus: 'failed', progress: { completed: 2, total: null, label: '已保存两项' }, completeness: 'unknown', analysis: { overview: '保存的分析' }, text: '列表不应出现原文', secret: '不要返回' };
const upload = { requestId: 'request-1', fileName: '作品.txt', contentBase64: Buffer.from('真实输入字节').toString('base64') };
function harness(overrides = {}) {
  const calls = [];
  const library = Object.fromEntries(['importSource', 'get', 'retry', 'cancel'].map(method => [method, async (...args) => { calls.push([method, ...args]); return source; }]));
  library.list = async input => { calls.push(['list', input]); return { items: [source], nextCursor: 'next' }; };
  library.readSource = async (...args) => { calls.push(['readSource', ...args]); return { ...source, textVersion: 'v1', sourceSha256: 'sha', encoding: 'utf8', text: '原文' }; };
  Object.assign(library, overrides);
  const router = createLibraryRouter({ library, json: (res, status, body) => Object.assign(res, { status, body }), bodyJSON: async req => req.body });
  return { calls, library, async request(method, url, body) { const res = {}; const handled = await router({ method, body }, res, new URL(url, 'http://localhost')); return { ...res, handled }; } };
}

test('upload validates canonical base64, bound bytes, safe file names, and unknown completeness', () => {
  assert.equal(decodeImport(upload).completeness, 'unknown');
  assert.deepEqual(decodeImport(upload).bytes, Buffer.from('真实输入字节'));
  for (const contentBase64 of ['', 'YQ', 'YR==', 'YQ==\n', 'data:text/plain;base64,YQ==', '-___']) assert.throws(() => decodeImport({ ...upload, contentBase64 }), { code: 'INVALID_INPUT' });
  assert.equal(decodeImport({ ...upload, contentBase64: Buffer.alloc(MAX_SOURCE_BYTES).toString('base64') }).bytes.length, MAX_SOURCE_BYTES);
  assert.throws(() => decodeImport({ ...upload, contentBase64: Buffer.alloc(MAX_SOURCE_BYTES + 1).toString('base64') }), { code: 'FILE_TOO_LARGE' });
  for (const fileName of ['../x', 'a\\b', '..']) assert.throws(() => decodeImport({ ...upload, fileName }), { code: 'INVALID_INPUT' });
  assert.throws(() => decodeImport({ ...upload, completeness: 'complete' }), { code: 'INVALID_INPUT' });
});

test('contract routes upload real bytes and return summaries until explicit detail/text request', async () => {
  const h = harness();
  const created = await h.request('POST', '/api/library/sources', { ...upload, completeness: 'first_four' });
  assert.equal(created.status, 202); assert.equal(created.body.source.analysis, undefined);
  assert.equal(h.calls[0][1].completeness, 'first_four'); assert.deepEqual(h.calls[0][1].bytes, Buffer.from('真实输入字节'));
  const listed = await h.request('GET', '/api/library/sources?limit=2&cursor=current');
  assert.deepEqual(h.calls[1], ['list', { cursor: 'current', limit: 2 }]);
  assert.equal(listed.body.items[0].analysis, undefined); assert.equal(listed.body.items[0].text, undefined); assert.equal(listed.body.items[0].secret, undefined);
  assert.equal((await h.request('GET', '/api/library/sources/source-1')).body.source.analysis, undefined);
  const detailed = await h.request('GET', '/api/library/sources/source-1?analysis=1');
  assert.deepEqual(detailed.body.source.analysis, source.analysis); assert.equal(detailed.body.source.indexStatus, 'failed');
  const text = await h.request('GET', '/api/library/sources/source-1/text?version=v1');
  assert.deepEqual(h.calls.at(-1), ['readSource', 'source-1', { textVersion: 'v1' }]); assert.equal(text.body.source.text, '原文'); assert.equal(text.body.source.analysis, undefined);
  assert.equal((await h.request('POST', '/api/library/sources/source-1/retry', { stage: 'index' })).status, 200);
  assert.deepEqual(h.calls.at(-1), ['retry', 'source-1', { stage: 'index' }]);
  await h.request('POST', '/api/library/sources/source-1/cancel', {}); assert.deepEqual(h.calls.at(-1), ['cancel', 'source-1']);
});

test('pagination and action validation do not reach service', async () => {
  const h = harness();
  for (const path of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=-1', '?limit=1&limit=2', '?cursor=', '?cursor=%00', '?cursor=' + 'x'.repeat(2049)]) assert.equal((await h.request('GET', '/api/library/sources' + path)).status, 400);
  assert.equal((await h.request('POST', '/api/library/sources/source-1/retry', { stage: 'all' })).status, 400);
  assert.equal((await h.request('DELETE', '/api/library/sources/source-1')).status, 405);
  assert.equal((await h.request('GET', '/api/tasks')).handled, false); assert.equal(h.calls.length, 0);
});

test('only allowlisted business errors map to HTTP and provider details never escape', async () => {
  for (const [code, status] of [['SOURCE_NOT_FOUND', 404], ['REQUEST_ID_CONFLICT', 409], ['FILE_TOO_LARGE', 413], ['INVALID_INPUT', 400], ['INDEX_UNAVAILABLE', 503], ['providerSecret', 503]]) {
    const h = harness({ get: async () => { throw Object.assign(new Error('secret API key and stack'), { code, retryable: false }); } });
    const response = await h.request('GET', '/api/library/sources/a'); assert.equal(response.status, status); assert.doesNotMatch(JSON.stringify(response), /secret|stack|providerSecret/);
  }
});

test('missing integration is unavailable, not completed or uncovered', async () => {
  const router = createLibraryRouter({ library: null, json: (res, status, body) => Object.assign(res, { status, body }), bodyJSON: async () => ({}) });
  const res = {}; await router({ method: 'GET' }, res, new URL('http://localhost/api/library/sources'));
  assert.equal(res.status, 503); assert.equal(res.body.error.code, 'LIBRARY_UNAVAILABLE');
  const query = { contractVersion: 'v04-contract-1', stage: 'planning', query: '测试', context: '' };
  assert.equal((await createRetrieveKnowledge(null)(query)).status, 'unavailable');
  const unavailable = { status: 'unavailable', limits: ['索引失败'] };
  assert.equal(await createRetrieveKnowledge({ retrieve: async () => unavailable })(query), unavailable);
  const uncovered = { status: 'uncovered', materials: [] };
  assert.equal(await createRetrieveKnowledge({ retrieve: async () => uncovered })(query), uncovered);
  assert.equal((await createRetrieveKnowledge({ retrieve: async () => { throw new Error('secret'); } })(query)).status, 'unavailable');
});

test('retrieval preserves cancellation before, during, and after service call', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(createRetrieveKnowledge(null)({}, { signal: controller.signal }), { name: 'AbortError' });
  const during = new AbortController();
  await assert.rejects(createRetrieveKnowledge({ retrieve: async (_query, { signal }) => { assert.equal(signal, during.signal); during.abort(); return { status: 'matched' }; } })({}, { signal: during.signal }), { name: 'AbortError' });
  await assert.rejects(createRetrieveKnowledge({ retrieve: async () => { throw new DOMException('Cancelled', 'AbortError'); } })({}), { name: 'AbortError' });
});

test('dynamic integration detects only missing module and passes model/storage to real factory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'talewick-library-loader-'));
  try {
    const moduleURL = pathToFileURL(join(dir, 'library.mjs'));
    assert.deepEqual(await loadLibraryService({ moduleURL }), { library: null, available: false });
    await writeFile(moduleURL, 'export async function createLibraryService(options) { return { options, ' + ['importSource', 'list', 'get', 'readSource', 'retry', 'cancel', 'retrieve', 'close'].map(method => `${method}() {}`).join(', ') + ' }; }');
    await writeFile(new URL('./relevance.mjs', moduleURL), 'export function createRelevanceAssessor({model}) { return (input, options) => model.complete({...input, ...options}); }');
    const projector = async value => value;
    const model = { complete() {} }; const loaded = await loadLibraryService({ moduleURL, rootDir: dir, model, narrativeObservationProjector: projector });
    assert.equal(loaded.available, true); assert.equal(loaded.library.options.model, model); assert.equal(loaded.library.options.rootDir, dir); assert.equal(typeof loaded.library.options.assessRelevance, 'function');
    assert.equal(loaded.library.options.narrativeObservationProjector, projector);
    await assert.rejects(loadLibraryService({ moduleURL, rootDir: dir, model, narrativeObservationProjector: {} }), /must be a function/);
    const broken = pathToFileURL(join(dir, 'broken.mjs')); await writeFile(broken, 'import "./missing-dependency.mjs";');
    await assert.rejects(loadLibraryService({ moduleURL: broken }), { code: 'ERR_MODULE_NOT_FOUND' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('actual data codes preserve business HTTP classes and task errors remain readable', async()=>{
 const classes={400:['INVALID_INPUT','INVALID_ENCODING','INVALID_QUERY'],404:['NOT_FOUND','VERSION_NOT_FOUND'],409:['REQUEST_CONFLICT','TASK_BUSY','ANALYSIS_REQUIRED','CANCELLED','STORE_BUSY'],413:['INPUT_TOO_LARGE','CAPACITY_EXCEEDED'],503:['SERVICE_CLOSED','STORAGE_FAILED','SOURCE_BINDING','STORE_VERSION']};
 for(const [status,codes] of Object.entries(classes))for(const code of codes){
  const h=harness({list:async()=>{throw Object.assign(Error('PRIVATE_PROVIDER_MESSAGE'),{code});}});
  const result=await h.request('GET','/api/library/sources');assert.equal(result.status,Number(status));assert.equal(result.body.error.code,code);assert.doesNotMatch(JSON.stringify(result.body),/PRIVATE_PROVIDER_MESSAGE/);
 }
 const h=harness({get:async()=>({...source,error:{code:'INVALID_ANALYSIS',message:'provider internal',retryable:true}})});
 const result=await h.request('GET','/api/library/sources/source-1?analysis=1');assert.equal(result.status,200);assert.equal(result.body.source.error.code,'INVALID_ANALYSIS');assert.ok(result.body.source.analysis);
 await assert.rejects(createRetrieveKnowledge({retrieve:async()=>{throw Object.assign(Error('cancelled'),{code:'CANCELLED'});}})({}),{code:'CANCELLED'});
});

test('draft is opt-in detail only and diagnostics come from draft', async () => {
  const analysisDraft = { responseVersion: 'response-1', textVersion: 'v1', candidate: { overview: '<img src=x onerror=alert(1)>' }, diagnostics: [{ code: 'QUOTE_MISMATCH', path: 'units[0].evidence[0]', message: '引文与原文不一致', lineStart: 415, lineEnd: 415 }], createdAt: '2026-09-10' };
  const row = { ...source, analysisDraft, error: { code: 'INVALID_ANALYSIS', message: 'unsafe provider message', diagnostics: [{ message: 'wrong authority' }] } };
  const h = harness(Object.fromEntries(['get', 'importSource', 'retry', 'cancel'].map(method => [method, async () => row])));
  h.library.list = async () => ({ items: [row] });
  for (const route of ['/api/library/sources/source-1', '/api/library/sources/source-1?analysis=0']) assert.equal((await h.request('GET', route)).body.source.analysisDraft, undefined);
  assert.equal((await h.request('GET', '/api/library/sources')).body.items[0].analysisDraft, undefined);
  for (const [route, body] of [['/api/library/sources', upload], ['/api/library/sources/source-1/retry', { stage: 'analysis' }], ['/api/library/sources/source-1/cancel', {}]]) assert.equal((await h.request('POST', route, body)).body.source.analysisDraft, undefined);
  const detail = (await h.request('GET', '/api/library/sources/source-1?analysis=1')).body.source;
  assert.deepEqual(detail.analysisDraft, analysisDraft);
  assert.deepEqual(detail.analysis, source.analysis);
  assert.equal(detail.error.code, 'INVALID_ANALYSIS');
  assert.match(detail.error.message, /候选和诊断已保存/);
  assert.equal(detail.error.diagnostics, undefined);
  assert.equal((await h.request('GET', '/api/library/sources/source-1?analysis=0&analysis=1')).status, 400);
});

 test('rejected retry maps to a non-retryable conflict with retained-content wording', async () => {
  const h = harness({ retry: async () => { throw Object.assign(new Error('internal'), { code: 'REVIEW_REJECTED' }); } });
  const response = await h.request('POST', '/api/library/sources/a/retry', { stage: 'analysis' });
  assert.equal(response.status, 409); assert.equal(response.body.error.code, 'REVIEW_REJECTED'); assert.equal(response.body.error.retryable, false);
  assert.match(response.body.error.message, /此状态不支持直接重试拆解/); assert.doesNotMatch(response.body.error.message, /原文可检索|internal/);
 });

 test('rubric stays in opt-in analysis detail, including action and list projections', async () => {
   const record={...source,analysis:{...source.analysis,validation:{semanticReview:{approved:false,rubricVersion:'analysis-review-v2',checks:[{id:'fact_attribution',status:'needs_revision',notes:['归属需修订'],unitIds:['u1']}],notes:['旧意见仍保留']}}}};
   const h=harness({get:async()=>record,list:async()=>({items:[record],nextCursor:null}),retry:async()=>record});
   const full=await h.request('GET','/api/library/sources/source-1?analysis=1');
   assert.deepEqual(full.body.source.analysis,record.analysis);
   for(const reply of [await h.request('GET','/api/library/sources'),await h.request('GET','/api/library/sources/source-1'),await h.request('POST','/api/library/sources/source-1/retry',{stage:'index'})]) assert.doesNotMatch(JSON.stringify(reply),/analysis-review-v2|fact_attribution|归属需修订/);
 });
 test('optional evidenceType passes through retrieval adapter and old queries still work', async () => {
   const seen=[];const retrieve=createRetrieveKnowledge({retrieve:async query=>{seen.push(query);return {status:'uncovered',query,materials:[]};}});
   for(const evidenceType of [undefined,'narrative','performance']){const query={contractVersion:'v04-contract-1',stage:'planning',query:'测试',context:'',...(evidenceType?{evidenceType}:{})};assert.equal((await retrieve(query)).status,'uncovered');assert.equal(seen.at(-1),query);}
 });

test('review format errors do not prescribe reanalysis in public summary', async () => {
 const h=harness({get:async()=>({...source,error:{code:'INVALID_ANALYSIS'}})});
 const result=await h.request('GET','/api/library/sources/source-1');
 assert.match(result.body.source.error.message,/展开详情/);assert.doesNotMatch(result.body.source.error.message,/可重试拆解|已复核|拒绝/);
});

test('revision routes bind versions, keep summaries small and suppress raw responses', async () => {
 const revision={revisionId:'rev-1',parentAnalysisVersion:'a1',textVersion:'t1',status:'failed',instructions:'exact instructions',candidate:{overview:'new candidate'},analysisResponse:{rawResponse:'SECRET_RAW',diagnostics:[{code:'BAD',path:'$',message:'诊断'}]},previousSourceState:{secret:'SECRET_STATE'}};
 const calls=[];const h=harness({reviseAnalysis:async(id,input)=>{calls.push({id,input});return revision;},listRevisions:async()=>({items:[revision]}),getRevision:async()=>revision,readAnalysis:async(id,{analysisVersion})=>({sourceId:id,textVersion:'t1',analysis:{version:analysisVersion,overview:'old'}})});
 const created=await h.request('POST','/api/library/sources/source-1/revisions',{expectedAnalysisVersion:'a1',instructions:'  保留原样  '});assert.equal(created.status,202);assert.equal(calls[0].input.instructions,'  保留原样  ');assert.equal(created.body.attempt.candidate,undefined);
 const list=await h.request('GET','/api/library/sources/source-1/revisions');assert.equal(list.body.items[0].instructions,undefined);assert.equal(list.body.items[0].candidate,undefined);
 const detail=await h.request('GET','/api/library/sources/source-1/revisions/rev-1');assert.equal(detail.body.attempt.candidate.overview,'new candidate');assert.equal(detail.body.attempt.diagnostics.length,1);assert.doesNotMatch(JSON.stringify(detail),/SECRET_RAW|SECRET_STATE/);
 assert.equal((await h.request('GET','/api/library/sources/source-1?analysis=1')).body.source.revisionCount,1);assert.equal((await h.request('GET','/api/library/sources/source-1')).body.source.revisionCount,undefined);
 assert.equal((await h.request('GET','/api/library/sources/source-1/analysis?version=a1')).body.source.analysis.version,'a1');
 for(const instructions of ['', '   ', 'x'.repeat(8001)])assert.equal((await h.request('POST','/api/library/sources/source-1/revisions',{expectedAnalysisVersion:'a1',instructions})).status,400);
 const conflict=harness({reviseAnalysis:async()=>{throw Object.assign(Error('secret'),{code:'VERSION_CONFLICT'});}});const response=await conflict.request('POST','/api/library/sources/source-1/revisions',{expectedAnalysisVersion:'a1',instructions:'修改'});assert.equal(response.status,409);assert.match(response.body.error.message,/刷新详情/);
});

test('revision running summary exposes identity without stale analysis detail', async () => {
 const h=harness({get:async()=>({...source,status:'running',activeRevisionId:'rev-1'})});const response=await h.request('GET','/api/library/sources/source-1');assert.equal(response.body.source.activeRevisionId,'rev-1');assert.equal(response.body.source.analysis,undefined);
});

test('review-only endpoint binds parent, returns linked summary and leaves eligibility to core', async () => {
 const calls=[];const full={revisionId:'new',kind:'review_only',derivedFromRevisionId:'old',canRetryReview:false,parentAnalysisVersion:'parent',textVersion:'t',status:'queued',inputCandidateFingerprint:'fingerprint',candidate:{overview:'secret candidate'},instructions:'saved',analysisResponse:{rawResponse:'secret raw'}};
 const h=harness({retryRevisionReview:async(...args)=>{calls.push(args);return full;},getRevision:async()=>full,listRevisions:async()=>({items:[full]})});
 const res=await h.request('POST','/api/library/sources/s/revisions/old/review',{expectedAnalysisVersion:'parent'});assert.equal(res.status,202);assert.deepEqual(calls,[['s','old',{expectedAnalysisVersion:'parent'}]]);assert.equal(res.body.attempt.kind,'review_only');assert.equal(res.body.attempt.derivedFromRevisionId,'old');assert.equal(res.body.attempt.canRetryReview,false);assert.doesNotMatch(JSON.stringify(res),/secret|fingerprint/);
 const detail=await h.request('GET','/api/library/sources/s/revisions/new');assert.equal(detail.body.attempt.inputCandidateFingerprint,'fingerprint');assert.doesNotMatch(JSON.stringify(detail),/secret raw/);
 assert.equal((await h.request('GET','/api/library/sources/s/revisions/old/review')).status,405);
 for(const expectedAnalysisVersion of ['', 'x'.repeat(201),undefined])assert.equal((await h.request('POST','/api/library/sources/s/revisions/old/review',{expectedAnalysisVersion})).status,400);
 for(const [code,status,pattern] of [['REVIEW_RETRY_NOT_ALLOWED',409,/核对资格/],['REVIEW_UNAVAILABLE',503,/本次未创建尝试/],['CAPACITY_EXCEEDED',413,/100 次修订/]]){const h=harness({retryRevisionReview:async()=>{throw Object.assign(Error('provider detail'),{code});}});const result=await h.request('POST','/api/library/sources/s/revisions/old/review',{expectedAnalysisVersion:'parent'});assert.equal(result.status,status);assert.match(result.body.error.message,pattern);assert.doesNotMatch(result.body.error.message,/provider detail/);}
});

test('legacy retry directs users to eligible recovery instead of prescribing new analysis',async()=>{
 const h=harness({retry:async()=>{throw Object.assign(Error('internal'),{code:'VERSIONED_REVISION_REQUIRED'});}});
 const response=await h.request('POST','/api/library/sources/s/retry',{stage:'analysis'});
 assert.equal(response.status,409);assert.equal(response.body.error.retryable,false);
 assert.match(response.body.error.message,/符合条件时可仅重试复核/);assert.match(response.body.error.message,/内容修改请新建修订/);assert.doesNotMatch(response.body.error.message,/这会重新分析并复核|internal/);
});

test('explicit index stage survives list/detail/retry projection without defaulting old records',async()=>{
 const queued={...source,status:'queued',indexStatus:'stale',processingStage:'index'};
 const h=harness({list:async()=>({items:[queued],nextCursor:null}),get:async()=>queued,retry:async(id,input)=>{assert.deepEqual(input,{stage:'index'});return queued;}});
 assert.equal((await h.request('GET','/api/library/sources')).body.items[0].processingStage,'index');
 assert.equal((await h.request('GET','/api/library/sources/source-1?analysis=1')).body.source.processingStage,'index');
 assert.equal((await h.request('POST','/api/library/sources/source-1/retry',{stage:'index'})).body.source.processingStage,'index');
 assert.equal(Object.hasOwn((await harness().request('GET','/api/library/sources')).body.items[0],'processingStage'),false);
});
