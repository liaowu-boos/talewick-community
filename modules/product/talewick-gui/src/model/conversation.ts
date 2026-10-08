import { makeRuntimeRequest, readRuntimeBinding } from './runtime';
import type { AppState, ConversationSubmission, ConversationTurn, ConversationTurnStatus, Project, RuntimeRequest } from './types';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string';
const statuses: ConversationTurnStatus[] = ['running', 'completed', 'cancelled', 'failed', 'interrupted'];
const root = (projectId: string) => `/api/conversations/${encodeURIComponent(projectId)}`;
export const CONVERSATION_MESSAGE_LIMIT = 12000;
export const conversationBusy = (project?: Project): boolean => Boolean(project?.messages.some(message => message.role === 'assistant' && message.turnStatus === 'running'));

/** Chat history travels as conversation turns, separately from the initial creative idea. */
export function makeConversationSnapshot(project: Project, state: AppState, requestId: string, instruction: string, quote: string): RuntimeRequest {
  return makeRuntimeRequest({ ...project, extraIdeas: [] }, state, requestId, instruction, quote);
}

/** Bind every conversation turn to its project mode and the editor's current write permission. */
export function makeConversationSubmission(project: Project, state: AppState, turnId: string, requestId: string, text: string, quote: string, allowTools: boolean): ConversationSubmission {
  const snapshot = makeConversationSnapshot(project, state, requestId, text, quote);
  // 已阻挡的选区仍可参与讨论，但不能作为工具的写入定位。
  if (!allowTools) delete snapshot.quoteSource;
  const history = project.messages.some(message => message.turnId) ? undefined : project.messages.filter(message => message.text.trim()).map(message => ({ role: message.role, text: message.text }));
  return { turnId, text, mode: project.mode, snapshot, history, allowTools };
}

/** Match the known server and task boundaries before changing local draft state. */
export function conversationPreflightError({ text, snapshot, history }: ConversationSubmission, project: Project): string | null {
  if (text.length > CONVERSATION_MESSAGE_LIMIT) return `本次输入 ${text.length} 字符，最多 ${CONVERSATION_MESSAGE_LIMIT} 字符。请调整本次输入或分次发送；输入仍在编辑框，完整保存计划仍在发布复盘。`;
  if (snapshot.idea.length > 12000 || snapshot.instruction.length > 12000) return '本次创作要求超过任务容量。请调整本次输入或分次发送；输入仍在编辑框，完整保存计划仍在发布复盘。';
  if (Object.values(snapshot.context).some(value => value.length > 12000)) return '创作背景中有单项超过 12000 字符。请调整后发送；输入仍在编辑框。';
  if (JSON.stringify(snapshot).length > 180000) return '所选稿件和材料超过本次对话快照容量。请减少材料后发送；输入仍在编辑框。';
  if (history && (history.length > 400 || history.some(item => item.text.length > 20000))) return '历史对话超过本次传输容量。请在新项目携带必要摘要继续；输入仍在编辑框。';
  const imported = project.messages.filter(item => !item.turnId && item.text.trim()).map(({ role, text }) => ({ role, text }));
  const priorTurns = project.messages.filter(item => item.turnId).reduce((sum, item) => sum + item.text.length, 0);
  if (JSON.stringify(imported).length + priorTurns + text.length > 100000) return '本项目对话已超过上下文容量。请在新项目携带必要摘要继续；输入仍在编辑框。';
  return null;
}

export class ConversationError extends Error {
  constructor(message: string, public status = 0) { super(message); this.name = 'ConversationError'; }
}

function readTask(value: unknown, projectId: string): ConversationTurn['task'] {
  if (!record(value) || !record(value.request) || !record(value.task)) return undefined;
  const binding = readRuntimeBinding({ request: value.request, task: value.task, baseManuscript: { title: value.request.projectTitle ?? '', chapters: value.request.chapters } }, projectId);
  return binding?.task ? { request: binding.request, task: binding.task } : undefined;
}

export function readConversationTurn(value: unknown): ConversationTurn | undefined {
  if (!record(value) || !text(value.id) || !value.id || !text(value.projectId) || !text(value.userText) || !text(value.assistantText) || !statuses.includes(value.status as ConversationTurnStatus)) return undefined;
  const task = readTask(value.task, value.projectId);
  if (value.task !== undefined && !task) return undefined;
  return { id: value.id, projectId: value.projectId, userText: value.userText, assistantText: value.assistantText, status: value.status as ConversationTurnStatus,
    createdAt: text(value.createdAt) ? value.createdAt : '', updatedAt: text(value.updatedAt) ? value.updatedAt : '', error: text(value.error) ? value.error : undefined, task };
}

async function jsonRequest(url: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...(init?.body ? { 'Content-Type': 'application/json' } : {}) } });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ConversationError(record(value) && text(value.error) ? value.error : record(value) && text(value.message) ? value.message : `对话连接暂时不可用（${response.status}）。`, response.status);
    return value;
  } catch (error) { if (error instanceof ConversationError) throw error; throw new ConversationError('暂时无法连接对话服务，已保留输入和收到的回复。'); }
  finally { clearTimeout(timer); }
}

const responseTurn = (value: unknown, projectId: string, turnId?: string): ConversationTurn => {
  const turn = record(value) ? readConversationTurn(value.turn) : undefined;
  if (!turn || turn.projectId !== projectId || (turnId && turn.id !== turnId)) throw new ConversationError('对话记录无法识别，已保留现有内容。');
  return turn;
};
export async function getConversation(projectId: string): Promise<ConversationTurn[]> {
  let value: unknown;
  try { value = await jsonRequest(root(projectId)); } catch (error) { if (error instanceof ConversationError && error.status === 404) return []; throw error; }
  if (!record(value) || !Array.isArray(value.turns)) throw new ConversationError('暂时无法读取对话记录。');
  const turns = value.turns.map(readConversationTurn);
  if (turns.some(turn => !turn || turn.projectId !== projectId)) throw new ConversationError('对话记录无法识别，已保留本机内容。');
  return turns as ConversationTurn[];
}
export async function submitConversation(projectId: string, submission: ConversationSubmission): Promise<ConversationTurn> {
  return responseTurn(await jsonRequest(`${root(projectId)}/turns`, { method: 'POST', body: JSON.stringify(submission) }), projectId, submission.turnId);
}
export async function cancelConversation(projectId: string, turnId: string): Promise<ConversationTurn> {
  return responseTurn(await jsonRequest(`${root(projectId)}/turns/${encodeURIComponent(turnId)}/cancel`, { method: 'POST', body: '{}' }), projectId, turnId);
}

export type ConversationEvent =
  | { type: 'snapshot' | 'done'; turn: ConversationTurn }
  | { type: 'text'; delta: string }
  | ({ type: 'task' } & NonNullable<ConversationTurn['task']>);

const MAX_STREAM_MESSAGE_BYTES = 4 * 1024 * 1024;
function checkMessageSize(source: string): void {
  if (source.length > MAX_STREAM_MESSAGE_BYTES || new TextEncoder().encode(source).byteLength > MAX_STREAM_MESSAGE_BYTES) throw new ConversationError('对话消息过长，已保留已收到的回复。');
}

/** Both transports require the same authoritative first snapshot and task/turn identities. */
function streamParser(projectId: string, turnId: string, emit: (event: ConversationEvent) => void) {
  let snapshot = false;
  let done = false;
  return {
    get done() { return done; },
    read(source: string) {
      if (done) return;
      checkMessageSize(source);
      if (!source.trim()) return;
      let event: unknown;
      try { event = JSON.parse(source); } catch { throw new ConversationError('对话流暂时中断，正在重新连接。'); }
      if (!record(event)) throw new ConversationError('对话流格式无法识别。');
      if (event.type === 'snapshot' || event.type === 'done') {
        const turn = readConversationTurn(event.turn);
        if (!turn || turn.id !== turnId || turn.projectId !== projectId) throw new ConversationError('收到的对话身份不匹配。');
        if (!snapshot && event.type !== 'snapshot') throw new ConversationError('对话缺少恢复快照。');
        snapshot = true; emit({ type: event.type, turn }); done = turn.status !== 'running'; return;
      }
      if (!snapshot) throw new ConversationError('对话缺少恢复快照。');
      if (event.type === 'heartbeat') return;
      if (event.type === 'text' && text(event.delta)) { emit({ type: 'text', delta: event.delta }); return; }
      if (event.type === 'task') { const task = readTask(event, projectId); if (!task) throw new ConversationError('对话中的创作任务格式无法识别。'); emit({ type: 'task', ...task }); return; }
      throw new ConversationError('对话流事件无法识别。');
    },
  };
}

/** Cloudflare's temporary HTTP tunnel buffers NDJSON; its WebSocket upgrade carries real deltas. */
function streamSocket(projectId: string, turnId: string, signal: AbortSignal, emit: (event: ConversationEvent) => void): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  const url = new URL(`${root(projectId)}/turns/${encodeURIComponent(turnId)}/socket`, window.location.origin);
  url.protocol = 'wss:';
  // Native same-origin authentication applies; no credentials, query tokens or client messages.
  return new Promise<void>((resolve, reject) => {
    let socket: WebSocket;
    try { socket = new WebSocket(url.href); } catch { reject(new ConversationError('对话订阅暂时无法连接。')); return; }
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const parser = streamParser(projectId, turnId, emit);
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null;
      try { if (socket.readyState < 2) socket.close(); } catch { /* Closing an already broken subscription cannot restart generation. */ }
      if (error) reject(error); else resolve();
    };
    const abort = () => finish();
    const refreshTimeout = () => { clearTimeout(timer); timer = setTimeout(() => finish(new ConversationError('对话订阅暂时中断，正在恢复本轮回复。')), 45000); };
    socket.onopen = refreshTimeout;
    socket.onmessage = event => {
      if (settled) return;
      refreshTimeout();
      try {
        if (typeof event.data !== 'string') throw new ConversationError('对话订阅消息格式无法识别。');
        parser.read(event.data);
        if (parser.done) finish();
      } catch (error) { finish(error); }
    };
    socket.onerror = () => finish(new ConversationError('对话订阅连接中断，正在恢复本轮回复。'));
    socket.onclose = () => finish(new ConversationError('连接已断开，正在恢复本轮回复。'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) finish(); else refreshTimeout();
  });
}

/** Read one connection. The caller reconnects the same turn, never repeats its generation POST. */
export async function streamConversation(projectId: string, turnId: string, signal: AbortSignal, emit: (event: ConversationEvent) => void): Promise<void> {
  if (typeof window !== 'undefined' && window.location.hostname.endsWith('.trycloudflare.com')) return streamSocket(projectId, turnId, signal, emit);
  if (signal.aborted) return;
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refreshTimeout = () => { clearTimeout(timer); timer = setTimeout(() => idle.abort(), 45000); };
  refreshTimeout();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${root(projectId)}/turns/${encodeURIComponent(turnId)}/stream`, { signal: AbortSignal.any([signal, idle.signal]), headers: { Accept: 'application/x-ndjson' } });
    if (!response.ok) throw new ConversationError(`对话流暂时无法连接（${response.status}）。`, response.status);
    if (!response.body) throw new ConversationError('对话连接没有返回可读取的内容。');
    reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = '';
    const parser = streamParser(projectId, turnId, emit);
    while (!signal.aborted && !parser.done) {
      const chunk = await reader.read(); refreshTimeout();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0 && !parser.done) { parser.read(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (!parser.done) checkMessageSize(buffer);
      if (chunk.done) { if (buffer.trim() && !parser.done) parser.read(buffer); break; }
    }
    if (!parser.done && !signal.aborted) throw new ConversationError('连接已断开，正在恢复本轮回复。');
  } finally { clearTimeout(timer); await reader?.cancel().catch(() => {}); }
}
