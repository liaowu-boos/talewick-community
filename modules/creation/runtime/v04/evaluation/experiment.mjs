import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runWorkflow } from '../../workflow.mjs';
import { prepareKnowledge } from '../../../../data/runtime/knowledge.mjs';
import { prepareWorkflowKnowledge, validateRetrieval, retrievalQuery } from '../knowledge.mjs';
import { TRUSTED_PACKETS } from './trusted-packets.mjs';

const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const json = v => JSON.stringify(canonical(v));
export const digest = v => createHash('sha256').update(json(v)).digest('hex');
const copy = v => structuredClone(v);
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };
const read = async path => JSON.parse(await readFile(path, 'utf8'));
const put = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const arms = ['baseline', 'materials'];
async function readCheckpoint(path, fingerprint, key) {
  const entry = await read(path);
  requireThat(entry?.fingerprint === fingerprint, '检查点输入绑定不一致');
  requireThat(entry.key === key, '检查点阶段绑定不一致');
  requireThat(Object.hasOwn(entry, 'value') && entry.valueHash === digest(entry.value), '检查点内容哈希不一致');
  return entry;
}
async function runtimeDigest() {
  const files = ['../../workflow.mjs', '../../business-tools.mjs', '../../chapter-budget.mjs', '../knowledge.mjs', '../reference-needs.mjs', '../followup.mjs', '../../../../data/runtime/followup-materials.mjs', '../psychology.mjs', '../../../../data/runtime/knowledge.mjs', '../../../../validation/runtime/checks.mjs', './experiment.mjs', './trusted-packets.mjs'];
  return digest(await Promise.all(files.map(async file => [file, await readFile(new URL(file, import.meta.url), 'utf8')])));
}
export const LIMITATION = '单次 A/B 不能证明因果增益；采用声明不等于正文采用；模型评读不是真人金标准。';

export function baselineRetrieval(query) {
  return { contractVersion: 'v04-contract-1', packetId: 'ab-baseline-uncovered', query: copy(query), status: 'uncovered', materials: [], candidates: [], usedChars: 0, limits: ['对照设计明确不供应新检索材料。'] };
}
function acceptPacket(packet, query, mode) {
  validateRetrieval(packet, query);
  requireThat(packet.status === 'matched' && packet.materials.every(m => m.use === 'reviewed_analysis'), '需要已固定的已复核分析命中包');
  if (mode === 'engineering') return { status: 'SYNTHETIC_NOT_REVIEWED', evidence: [] };
  const anchor = TRUSTED_PACKETS[packet.packetId];
  requireThat(anchor && anchor.sha256 === digest(packet) && anchor.evidence?.length, '没有独立审核登记的固定材料包；自称已复核的输入不能执行');
  return copy(anchor);
}

// Prepare uses a local serializer as the requirements adapter, never a provider.
// Capturing through the workflow preserves its input normalization and frozen rules.
export async function prepareExperiment({ directory, request, requirements, modelSpec, packet, mode = 'real' }) {
  requireThat(['real', 'engineering'].includes(mode), 'mode 无效');
  requireThat(request?.kind === 'create' && request.idea?.trim() && requirements?.summary?.trim(), '需要明确完整短篇创作 request 与 requirements');
  requireThat(requirements.completeEnding === true && requirements.usesChapter4Cut === false, '必须明确完整结局且不使用四章截断');
  requireThat(modelSpec?.id?.trim() && modelSpec?.provider?.trim() && modelSpec.parameters && typeof modelSpec.parameters === 'object', '需要固定 provider、model id 与 parameters');
  requireThat(Object.keys(modelSpec).every(k => ['id', 'provider', 'parameters'].includes(k)), 'modelSpec 只接受非密钥规格');
  let spec;
  const stop = new Error('offline capture');
  try {
    await runWorkflow({ request, followupMode: 'fixed_materials', model: { complete: async ({ stage }) => { requireThat(stage === 'requirements', '离线准备不允许正文调用'); return JSON.stringify(requirements); } },
      retrieveKnowledge: baselineRetrieval, checkpoint: async (key, value) => { requireThat(key === 'requestSpec', 'unexpected checkpoint'); spec = value; throw stop; } });
  } catch (error) { if (error !== stop) throw error; }
  const base = await prepareKnowledge(request);
  const query = retrievalQuery(request, spec.requirements, 30000 - base.materials.reduce((n, m) => n + m.content.length, 0));
  let trust = null, knowledge = null;
  if (packet) {
    trust = acceptPacket(packet, query, mode);
    knowledge = {};
    for (const arm of arms) {
      knowledge[arm] = await prepareWorkflowKnowledge({ request, requirements: spec.requirements, prepareKnowledge,
        retrieveKnowledge: arm === 'baseline' ? baselineRetrieval : () => copy(packet) });
      requireThat(knowledge[arm].retrieval.status === (arm === 'baseline' ? 'uncovered' : 'matched'), '材料准备失败，禁止退化为两臂无材料');
    }
  }
  const manifest = { version: 'creation-ab-1', runtimeDigest: await runtimeDigest(), mode, request: copy(request), modelSpec: copy(modelSpec), requestSpec: spec,
    packet: packet ? copy(packet) : null, trust, knowledge, status: packet ? 'ready' : 'blocked_missing_reviewed_packet', limitation: LIMITATION };
  await mkdir(directory, { recursive: false });
  await put(join(directory, 'manifest.json'), manifest);
  await put(join(directory, 'seal.json'), { fingerprint: digest(manifest) });
  for (const arm of arms) {
    await mkdir(join(directory, arm));
    for (const [key, value] of Object.entries({ requestSpec: spec, ...(knowledge ? { knowledge: knowledge[arm] } : {}) })) {
      await put(join(directory, arm, `${key}.json`), { key, value, valueHash: digest(value), fingerprint: digest(manifest) });
    }
  }
  await mkdir(join(directory, 'calls'));
  return { status: manifest.status, fingerprint: digest(manifest), limitation: LIMITATION };
}

export async function checkExperiment(directory) {
  const manifest = await read(join(directory, 'manifest.json'));
  requireThat(manifest.version === 'creation-ab-1', '实验版本无效');
  requireThat((await read(join(directory, 'seal.json'))).fingerprint === digest(manifest), '冻结清单已变化，请新建实验');
  requireThat(manifest.runtimeDigest === await runtimeDigest(), '运行代码已变化，请新建实验');
  if (manifest.packet) {
    acceptPacket(manifest.packet, manifest.knowledge.materials.retrieval.query, manifest.mode);
    requireThat(manifest.knowledge.baseline.retrieval.status === 'uncovered', '基线必须 uncovered');
  }
  const files = (await readdir(join(directory, 'calls'))).filter(f => f.endsWith('.started.json'));
  return { status: manifest.status, mode: manifest.mode, calls: files.length, fingerprint: digest(manifest), limitation: LIMITATION };
}

export async function executeExperiment({ directory, execute = false, maxCalls, model }) {
  const checked = await checkExperiment(directory);
  if (execute !== true) return checked; // No adapter invocation by default.
  requireThat(Number.isSafeInteger(maxCalls) && maxCalls > 0, '执行需要正整数全局 maxCalls');
  requireThat(model && typeof model.complete === 'function', '执行需要显式注入 model');
  requireThat(model.singleRequest === true, '适配器必须声明 singleRequest=true，禁用内部重试与续写');
  requireThat(checked.status === 'ready', '缺少已复核材料，实验尚不可执行');
  const manifest = await read(join(directory, 'manifest.json'));
  requireThat(json(model.spec) === json(manifest.modelSpec), 'model specs 不一致');
  requireThat(manifest.mode !== 'engineering' || model.engineering === true, '工程材料只允许显式工程替身');
  const lock = join(directory, 'execution.lock');
  await put(lock, { pid: process.pid }); // Concurrent runs cannot share a budget.
  try {
    const bindingPath = join(directory, 'execution.json');
    let binding;
    try { binding = await read(bindingPath); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const expected = { fingerprint: checked.fingerprint, maxCalls };
    if (binding) requireThat(json(binding) === json(expected), '恢复不能改变输入、规则、材料或全局预算');
    else await put(bindingPath, expected);
    for (const arm of arms) {
      const artifacts = { requestSpec: copy(manifest.requestSpec), knowledge: copy(manifest.knowledge[arm]) };
      for (const file of await readdir(join(directory, arm))) {
        if (!file.endsWith('.json')) continue;
        const entry = await readCheckpoint(join(directory, arm, file), checked.fingerprint, decodeURIComponent(file.slice(0, -5)));
        if (entry.key === 'requestSpec' || entry.key === 'knowledge') requireThat(json(entry.value) === json(artifacts[entry.key]), '两臂冻结规格或材料被改变');
        artifacts[entry.key] = entry.value;
      }
      await runWorkflow({ request: copy(manifest.request), artifacts,
        retrieveKnowledge: () => { throw new Error('冻结后禁止重查'); },
        checkpoint: async (key, value) => put(join(directory, arm, `${encodeURIComponent(key)}.json`), { key, value, valueHash: digest(value), fingerprint: checked.fingerprint }),
        model: { complete: async args => {
          const input = { stage: args.stage, system: args.system, user: args.user, maxTokens: args.maxTokens };
          const inputHash = digest({ arm, input });
          const starts = (await readdir(join(directory, 'calls'))).filter(f => f.endsWith('.started.json')).sort();
          for (const file of starts) {
            const call = await read(join(directory, 'calls', file));
            const callId = file.slice(0, -'.started.json'.length);
            requireThat(call?.id === callId && call.fingerprint === checked.fingerprint && arms.includes(call.arm)
              && json(call.modelSpec) === json(manifest.modelSpec), '调用记录绑定不一致');
            requireThat(call.inputHash === digest({ arm: call.arm, input: { stage: call.stage, system: call.system, user: call.user, maxTokens: call.maxTokens } }), '调用输入哈希不一致');
            if (call.inputHash !== inputHash) continue;
            let output;
            try { output = await read(join(directory, 'calls', file.replace('.started.', '.output.'))); }
            catch (e) { if (e.code === 'ENOENT') throw new Error('存在未确认调用；禁止自动重发，保留现场新建实验'); throw e; }
            requireThat(output?.id === call.id && output.fingerprint === checked.fingerprint && output.arm === arm
              && output.stage === args.stage && output.inputHash === inputHash && output.startedHash === digest(call), '模型输出记录绑定不一致');
            requireThat(output.status === 'returned', '失败调用不自动重试；保留现场新建实验');
            requireThat(typeof output.text === 'string' && output.outputHash === digest(output.text), '模型输出内容哈希不一致');
            return output.text;
          }
          requireThat(starts.length < maxCalls, '全局调用预算耗尽');
          const id = String(starts.length + 1).padStart(5, '0');
          const call = { id, fingerprint: checked.fingerprint, arm, inputHash, ...input, modelSpec: manifest.modelSpec };
          await put(join(directory, 'calls', `${id}.started.json`), call);
          const outputBinding = { id, fingerprint: checked.fingerprint, arm, stage: args.stage, inputHash, startedHash: digest(call) };
          let output;
          try { output = await model.complete({ ...args, modelSpec: copy(manifest.modelSpec) }); }
          catch { await put(join(directory, 'calls', `${id}.output.json`), { ...outputBinding, status: 'failed' }); throw new Error('模型调用失败，已计入预算'); }
          requireThat(typeof output === 'string', '模型输出须为字符串；调用保留未确认状态');
          await put(join(directory, 'calls', `${id}.output.json`), { ...outputBinding, status: 'returned', text: output, outputHash: digest(output) });
          return output;
        } } });
    }
    return { ...(await checkExperiment(directory)), status: 'completed' };
  } finally { await unlink(lock); }
}

export async function exportReading(directory, destination) {
  const checked = await checkExperiment(directory);
  const manifest = await read(join(directory, 'manifest.json'));
  const report = { limitation: LIMITATION, mode: manifest.mode, fingerprint: digest(manifest), arms: {} };
  for (const arm of arms) {
    const entry = await readCheckpoint(join(directory, arm, 'result.json'), checked.fingerprint, 'result');
    const plan = await readCheckpoint(join(directory, arm, 'plan.json'), checked.fingerprint, 'plan');
    report.arms[arm] = { chapters: entry.value.chapters, review: entry.value.review, checks: entry.value.checks,
      adoptionDeclarations: plan.value.materialDecisions ?? [], actualAdoption: 'NOT_EVALUATED',
      humanReading: { characterExperienceAndChoice: null, emotionalDevelopment: null, middleAndEnding: null, preservedStrengths: null, evidenceQuotes: [], reviewer: null } };
  }
  await put(destination, report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command = 'help', directory, argument] = process.argv.slice(2);
  try {
    if (command === 'prepare') console.log(await prepareExperiment({ ...(await read(argument)), directory }));
    else if (command === 'check') console.log(await checkExperiment(directory));
    else if (command === 'export') await exportReading(directory, argument);
    else console.log('prepare <new-dir> <spec.json> | check <dir> | export <dir> <new-file.json>\nExecution only via executeExperiment({execute:true,maxCalls,model}); no built-in network adapter.');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
