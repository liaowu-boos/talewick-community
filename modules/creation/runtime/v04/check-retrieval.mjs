import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepareKnowledge } from '../../../data/runtime/knowledge.mjs';
import { retrievalQuery, validateRetrieval, prepareWorkflowKnowledge, knowledgeForAuthor } from './knowledge.mjs';
const canonical = v => v && typeof v === 'object' ? Array.isArray(v) ? v.map(canonical)
  : Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const requireThat = (ok, message) => { if (!ok) throw new Error(message); };

/** Offline consumer check of an actual response; no service/model calls or trust registration. */
export async function freezeRetrieval({ request, requirements, result }) {
  const base = await prepareKnowledge(request);
  const remaining = 30000 - base.materials.reduce((n, item) => n + item.content.length, 0);
  requireThat(remaining > 0, '基础材料已占满预算，不应供应新检索结果。');
  const query = retrievalQuery(request, requirements, remaining);
  validateRetrieval(result, query); // Fail explicitly instead of reporting fallback as success.
  const knowledge = await prepareWorkflowKnowledge({ request, requirements, prepareKnowledge,
    retrieveKnowledge: async received => {
      requireThat(digest(received) === digest(query), '实际查询与待冻结查询不同。');
      return structuredClone(result);
    } });
  requireThat(knowledge.retrieval.status === result.status, '材料合并未保留实际检索状态。');
  return sealKnowledge(knowledge);
}

export function sealKnowledge(knowledge) {
  return { schemaVersion: 'creation-knowledge-freeze-1', valueHash: digest(knowledge), knowledge: structuredClone(knowledge) };
}

/** Read an existing envelope without querying or upgrading a historical material contract. */
export function inspectFrozenKnowledge(envelope) {
  requireThat(envelope?.schemaVersion === 'creation-knowledge-freeze-1' && envelope.valueHash === digest(envelope.knowledge), '冻结知识包哈希或版本不一致。');
  const knowledge = structuredClone(envelope.knowledge);
  const authorView = knowledgeForAuthor(knowledge);
  return { status: 'integrity_checked', retrievalStatus: knowledge.retrieval?.status ?? 'legacy_unknown',
    evidenceType: knowledge.retrieval?.query?.evidenceType ?? null,
    materialCount: knowledge.materials.length, usedChars: knowledge.materials.reduce((n, item) => n + item.content.length, 0),
    authorView, limitations: ['仅检查供给合同、内容一致性及作者视图；未回查真实来源登记或语义复核，不证明文学效果。',
      '冻结检查不重新检索、不升级旧材料用途；该哈希不是密码学签名。'] };
}

const entryPath = process.argv[1] ? await realpath(resolve(process.argv[1])).catch(() => null) : null;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  const [mode, inputPath, newDirectory] = process.argv.slice(2);
  try {
    requireThat(['freeze', 'inspect'].includes(mode) && inputPath && newDirectory,
      '用法：freeze <case.json> <new-dir> | inspect <frozen.json> <new-dir>；case 含 request/requirements/result。');
    const input = JSON.parse(await readFile(inputPath, 'utf8'));
    const envelope = mode === 'freeze' ? await freezeRetrieval(input) : input;
    const report = inspectFrozenKnowledge(envelope);
    await mkdir(newDirectory, { recursive: false });
    await writeFile(join(newDirectory, 'frozen.json'), JSON.stringify(envelope, null, 2) + '\n', { flag: 'wx' });
    await writeFile(join(newDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    console.log(JSON.stringify({ status: report.status, materialCount: report.materialCount, evidenceType: report.evidenceType, directory: resolve(newDirectory) }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
