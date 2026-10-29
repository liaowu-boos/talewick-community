// Synthetic HTTP dependency shared by the wire tests and local Postman simulation.
// It never forwards requests and contains no provider credentials or story inputs.
module.exports = async function nativePolicyFixture(req, res) {
  try {
    if (req.method !== 'POST' || !new URL(req.url, 'http://localhost').pathname.endsWith('/chat/completions')) {
      res.writeHead(501); return res.end('Unsupported fixture endpoint');
    }
    let body = req.body;
    if (body === undefined) { let bytes = ''; for await (const chunk of req) bytes += chunk; body = JSON.parse(bytes); }
    if (typeof body === 'string') body = JSON.parse(body);
    if (!Array.isArray(body.messages)) throw Error('Invalid fixture request');
    const truncated = body.messages.some(message => message.content === 'RECOVERY_FIXTURE') && body.thinking?.type !== 'disabled';
    const approve = body.tools?.some(tool => tool.function?.name === 'approve_plan');
    const message = { role: 'assistant', content: truncated ? 'partial' : '{"ok":true}',
      ...(truncated || approve ? { reasoning_content: 'Synthetic fixture reasoning.' } : {}),
      ...(approve ? { tool_calls: [{ id: 'local-call-1', type: 'function', function: { name: 'approve_plan', arguments: JSON.stringify({ reason: 'Synthetic transport check only.' }) } }] } : {}) };
    const finish = truncated ? 'length' : approve ? 'tool_calls' : 'stop';
    const base = { id: 'local-native-policy-fixture', created: 1, model: body.model };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Malformed synthetic request"}'); }
};
