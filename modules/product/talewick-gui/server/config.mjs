import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { agentProviderFor, usesDeepSeekThinking } from './model-policy.mjs';
import { engineBinding, ENGINE_LABELS } from './engines.mjs';

export const appRoot = fileURLToPath(new URL('../', import.meta.url));

const RELEVANCE_MODELS = new Set(['deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro']);

/** Opt-in is explicit; an absent property preserves the original DeepSeek contract. */
export function validateRelevanceProvider(config) {
  const provider = Object.hasOwn(config, 'relevanceProvider') ? config.relevanceProvider : 'deepseek';
  if (!['deepseek', 'codex-cli'].includes(provider)) throw new Error('材料筛选服务只支持 deepseek 或 codex-cli。');
  if (provider === 'codex-cli') {
    if (config.relevanceModel !== 'gpt-6.1-sol' || config.relevanceEffort !== 'high')
      throw new Error('Codex CLI 材料筛选必须显式选择 gpt-6.1-sol 与 high。');
    if (typeof config.relevanceCliExecutable !== 'string' || !path.isAbsolute(config.relevanceCliExecutable)
      || /[\x00-\x1f\x7f]/.test(config.relevanceCliExecutable))
      throw new Error('Codex CLI 材料筛选必须显式配置可执行文件的绝对路径。');
    if (Object.hasOwn(config, 'relevanceAcceptDisabledHostNotice') && typeof config.relevanceAcceptDisabledHostNotice !== 'boolean')
      throw new Error('Codex CLI 固定通知兼容选项必须为布尔值。');
  } else {
    if (Object.hasOwn(config, 'relevanceEffort')) throw new Error('材料筛选 effort 仅适用于 codex-cli。');
    if (Object.hasOwn(config, 'relevanceCliExecutable') || Object.hasOwn(config, 'relevanceAcceptDisabledHostNotice'))
      throw new Error('CLI 路径和固定通知兼容选项仅适用于 codex-cli。');
  }
  return provider;
}

/** An optional stage override is supported only on the official native endpoint. */
export function validateRelevanceModel(config) {
  if (validateRelevanceProvider(config) === 'codex-cli') return config.relevanceModel;
  if (!Object.hasOwn(config, 'relevanceModel')) return undefined;
  const selected = config.relevanceModel;
  if (typeof selected !== 'string' || !RELEVANCE_MODELS.has(selected))
    throw new Error('材料筛选模型只支持 deepseek-flash、deepseek-v4-flash 或 deepseek-v4-pro。');
  const endpoint = new URL(config.baseURL);
  if (endpoint.origin !== 'https://api.deepseek.com' || agentProviderFor(config) !== 'deepseek')
    throw new Error('材料筛选模型覆盖只支持官方 DeepSeek native 服务。');
  return selected;
}

/** Read a local settings file without executing shell expressions or changing process.env. */
export async function loadConfig(env = process.env, file = path.join(appRoot, '.env.local'), baseRoot = appRoot) {
  let local = {};
  try {
    const text = await readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || !['TALEWICK_API_BASE_URL', 'TALEWICK_API_KEY', 'TALEWICK_MODEL', 'TALEWICK_RELEVANCE_MODEL', 'TALEWICK_RELEVANCE_PROVIDER', 'TALEWICK_RELEVANCE_EFFORT', 'TALEWICK_RELEVANCE_CODEX_EXECUTABLE', 'TALEWICK_RELEVANCE_ACCEPT_DISABLED_HOST_NOTICE', 'DEEPSEEK_API_KEY', 'TALEWICK_PORT', 'TALEWICK_RUNS_DIR', 'TALEWICK_LIBRARY_DIR', 'TALEWICK_MODEL_TIMEOUT_MS', 'TALEWICK_MODEL_IDLE_TIMEOUT_MS', 'TALEWICK_ENGINE', 'TALEWICK_AGENT_PROVIDER'].includes(match[1])) continue;
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      local[match[1]] = value;
    }
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法读取本机模型配置文件。'); }
  const settings = { ...local, ...env };
  const baseURL = (settings.TALEWICK_API_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '');
  const url = new URL(baseURL);
  if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) throw new Error('模型地址应是没有账号、查询参数的 HTTP(S) 基础地址。');
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('远端模型地址需要使用 HTTPS。');
  const apiKey = settings.TALEWICK_API_KEY || settings.DEEPSEEK_API_KEY || '';
  const model = settings.TALEWICK_MODEL || 'deepseek-flash';
  const port = Number(settings.TALEWICK_PORT || 4326);
  const { engine } = engineBinding(settings.TALEWICK_ENGINE || 'ai-sdk');
  const agentProvider = settings.TALEWICK_AGENT_PROVIDER || (url.hostname === 'api.deepseek.com' ? 'deepseek' : 'openai-compatible');
  if (Object.hasOwn(settings, 'TALEWICK_RELEVANCE_ACCEPT_DISABLED_HOST_NOTICE')
    && !['true', 'false'].includes(settings.TALEWICK_RELEVANCE_ACCEPT_DISABLED_HOST_NOTICE))
    throw new Error('固定通知兼容配置只接受 true 或 false。');
  const relevanceSelection = {
    ...(Object.hasOwn(settings, 'TALEWICK_RELEVANCE_PROVIDER') ? { relevanceProvider: settings.TALEWICK_RELEVANCE_PROVIDER } : {}),
    ...(Object.hasOwn(settings, 'TALEWICK_RELEVANCE_MODEL') ? { relevanceModel: settings.TALEWICK_RELEVANCE_MODEL } : {}),
    ...(Object.hasOwn(settings, 'TALEWICK_RELEVANCE_EFFORT') ? { relevanceEffort: settings.TALEWICK_RELEVANCE_EFFORT } : {}),
    ...(Object.hasOwn(settings, 'TALEWICK_RELEVANCE_CODEX_EXECUTABLE') ? { relevanceCliExecutable: settings.TALEWICK_RELEVANCE_CODEX_EXECUTABLE } : {}),
    ...(Object.hasOwn(settings, 'TALEWICK_RELEVANCE_ACCEPT_DISABLED_HOST_NOTICE')
      ? { relevanceAcceptDisabledHostNotice: settings.TALEWICK_RELEVANCE_ACCEPT_DISABLED_HOST_NOTICE === 'true' }
      : settings.TALEWICK_RELEVANCE_PROVIDER === 'codex-cli' ? { relevanceAcceptDisabledHostNotice: false } : {}),
  };
  validateRelevanceModel({ baseURL, agentProvider, ...relevanceSelection });
  // V4 的推理与正文共用较长输出预算；总截止时间与无生成进展的时限分别设置。
  const nativeV4 = usesDeepSeekThinking({ agentProvider, model, baseURL });
  const timeoutMs = Number(settings.TALEWICK_MODEL_TIMEOUT_MS || (nativeV4 ? 600000 : 180000));
  const idleTimeoutMs = Number(settings.TALEWICK_MODEL_IDLE_TIMEOUT_MS || Math.min(180000, timeoutMs));
  if (!['deepseek', 'openai-compatible'].includes(agentProvider)) throw new Error('Agent 模型适配请选择 deepseek 或 openai-compatible。');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('本地服务端口应在 1024–65535 之间。');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new Error('模型等待时间应在 1000–600000 毫秒之间。');
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > timeoutMs) throw new Error('模型无进展等待时间应在 1000 毫秒与总等待时间之间。');
  return { baseURL, apiKey, model, port, timeoutMs, idleTimeoutMs, engine, agentProvider, libraryDir: path.resolve(baseRoot, settings.TALEWICK_LIBRARY_DIR || path.join(settings.TALEWICK_RUNS_DIR || '.local-runs', 'library')), runsDir: path.resolve(baseRoot, settings.TALEWICK_RUNS_DIR || '.local-runs'), ...relevanceSelection };
}

/** Safe configuration summary for the browser; never return a credential. */
export function publicConfig(config) {
  const configured = Boolean(config.apiKey && config.model);
  const binding = engineBinding(config.engine);
  const relevanceModel = validateRelevanceModel(config);
  return { configured, ready: configured, provider: new URL(config.baseURL).hostname, model: config.model, ...binding, engineLabel: ENGINE_LABELS[binding.engine], message: configured ? '本地创作服务已就绪。' : '模型尚未配置。请在本机 .env.local 中填写模型服务信息后重启创作服务。', ...(relevanceModel ? { relevanceModel } : {}), ...(Object.hasOwn(config, 'relevanceProvider') ? { relevanceProvider: config.relevanceProvider } : {}), ...(config.relevanceProvider === 'codex-cli' ? { relevanceEffort: config.relevanceEffort } : {}) };
}
