import {runWorkflow} from './workflow.mjs';
import {manuscriptFingerprint} from '../../validation/runtime/checks.mjs';
import {createHash} from 'node:crypto';
import {mkdir, readFile, writeFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', {flag:'wx'});

/** Internal API; model.complete is supplied by the caller, including accounting.
 * A fresh run never accepts review/adjudication artifacts supplied by callers.
 * Retained output is append-only. Resume uses this run's own checkpoints.
 */
export async function runReviewExisting({request, model, outputDirectory, sourceFiles, resume = false, mode = 'review-existing-v1', signal} = {}) {
  if (!['review-existing-v1','review-existing-v2','review-existing-v3'].includes(mode)) throw new Error('未知已有稿审阅版本。');
  if (typeof model?.complete !== 'function' || !outputDirectory) throw new Error('需要注入模型适配器及独立输出目录。');
  if (request?.kind !== 'revise' || request?.quoteSource) throw new Error('需要已有完整稿的 revise 请求，不能传入选段授权。');
  if (!Array.isArray(sourceFiles) || !sourceFiles.length) throw new Error('需要原稿来源文件与SHA绑定。');
  const origins = structuredClone(sourceFiles);
  for (const source of origins) {
    if (typeof source.path !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '') || sha(await readFile(source.path)) !== source.sha256) throw new Error('来源文件SHA不匹配，未调用模型。');
  }
  const boundRequest = structuredClone(request);
  const requestSha256 = sha(JSON.stringify(boundRequest));
  await mkdir(outputDirectory, {recursive:true});
  const files = await readdir(outputDirectory);
  let artifacts = {};
  if (!resume && files.length) throw new Error('输出目录非空；不会覆盖既有运行。');
  if (resume) {
    const origin = JSON.parse(await readFile(join(outputDirectory, 'source.json'), 'utf8'));
    if ((origin.mode ?? 'review-existing-v1') !== mode || origin.requestSha256 !== requestSha256 || JSON.stringify(origin.sourceFiles) !== JSON.stringify(origins)) throw new Error('恢复请求与本轮原稿不一致。');
    for (const f of files.filter(f => /^checkpoint-\d+\.json$/.test(f)).sort()) {
      const item = JSON.parse(await readFile(join(outputDirectory, f), 'utf8'));
      artifacts[item.key] = item.value;
    }
  } else {
    await save(join(outputDirectory, 'source.json'), {version:'review-existing-run-1',...(mode !== 'review-existing-v1' ? {mode} : {}),requestSha256,sourceFiles:origins,manuscriptSha256:manuscriptFingerprint(boundRequest.chapters),request:boundRequest,chapters:boundRequest.chapters.map(c => ({id:c.id,bodySha256:sha(c.body),utf16Length:c.body.length}))});
  }
  let index = files.filter(f => /^call-\d+\.request\.json$/.test(f)).length;
  let checkpointIndex = files.filter(f => /^checkpoint-\d+\.json$/.test(f)).length;
  const loggedModel = {async complete(args) {
    const id = String(++index).padStart(6,'0');
    const prefix = join(outputDirectory, `call-${id}`);
    const {signal:unused, ...input} = args;
    await save(prefix+'.request.json', input);
    try {
      const response = await model.complete(args);
      await save(prefix+'.response.json', {response,sha256:sha(typeof response === 'string' ? response : JSON.stringify(response))});
      return response;
    } catch (error) {
      await save(prefix+'.failure.json', {code:error.code ?? null,message:error.message});
      throw error;
    }
  }};
  const attempt = String(files.filter(f => /^attempt-\d+\.(result|failure)\.json$/.test(f)).length+1).padStart(6,'0');
  try {
    const result = await runWorkflow({request:boundRequest,model:loggedModel,artifacts,signal,
      existingReviewMode:mode,followupMode:'fixed_materials',
      checkpoint:async(key,value) => {
        await save(join(outputDirectory, `checkpoint-${String(++checkpointIndex).padStart(6,'0')}.json`), {key,value});
      }});
    await save(join(outputDirectory, `attempt-${attempt}.result.json`), result);
    return result;
  } catch (error) {
    await save(join(outputDirectory, `attempt-${attempt}.failure.json`), {code:error.code ?? null,message:error.message,callCount:index,semanticAcceptance:false});
    throw error;
  }
}
