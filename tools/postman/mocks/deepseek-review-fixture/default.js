/** Local synthetic transport fixture; never a literary assessment. */
const http = require('http');
let sequence = 0;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url || '/', 'http://localhost').pathname;
  if (req.method !== 'POST' || !['/chat/completions', '/deepseek/chat/completions'].includes(pathname)) {
    res.writeHead(501, {'content-type': 'application/json'});
    return res.end(JSON.stringify({error: 'Unimplemented fixture endpoint'}));
  }
  try {
    let body = req.body;
    if (body === undefined) { let raw = ''; for await (const chunk of req) raw += chunk; body = raw; }
    if (typeof body === 'string') body = JSON.parse(body);
    if (!body || typeof body.model !== 'string' || body.messages?.length !== 2 || body.messages[0].role !== 'system' || body.messages[1].role !== 'user') throw new Error('Expected isolated system/user messages');
    let user = {}; try { user = JSON.parse(body.messages[1].content); } catch {}
    const envelope = user.packet || user;
    const contractFixture = typeof envelope.caseId === 'string' && envelope.caseId.startsWith('postman-synthetic-') && envelope.responseContract?.example;
    const output = user.__localTransportFixtureResponse || (contractFixture ? structuredClone(contractFixture) : {simulation: true, semanticResultProvided: false});
    const content = JSON.stringify(output);
    const id = `postman-review-fixture-${++sequence}`;
    const usage = {prompt_tokens: 0, completion_tokens: 0, total_tokens: 0};
    if (body.stream) {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write('data: ' + JSON.stringify({id, object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta: {role: 'assistant', content}, finish_reason: null}]}) + '\n\n');
      res.write('data: ' + JSON.stringify({id, object: 'chat.completion.chunk', model: body.model, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage}) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({id, object: 'chat.completion', model: body.model, choices: [{index: 0, message: {role: 'assistant', content}, finish_reason: 'stop'}], usage}));
  } catch (error) {
    res.writeHead(400, {'content-type': 'application/json'});
    res.end(JSON.stringify({error: error.message}));
  }
});
server.listen(process.env.PORT || 4932);
