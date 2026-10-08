import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { createRemoteAccess } from './remote-access.mjs';

// Exercise the actual boundary proxy with a local echo upstream. These are
// disposable test credentials; no model service or public tunnel is contacted.
const username = 'remote-test-user';
const password = 'remote-test-password-123456';
const publicOrigin = 'https://talewick-example.trycloudflare.com';
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server.address().port;
}

async function close(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function fixture(t) {
  const requests = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    try { for await (const chunk of req) body += chunk; }
    catch { res.destroy(); return; }
    const entry = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(entry);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' });
    res.end(JSON.stringify(entry));
  });
  const upstreamPort = await listen(upstream);
  const boundary = createRemoteAccess({ upstreamPort, username, password, publicOrigin });
  const port = await listen(boundary.server);
  t.after(async () => { await close(boundary.server); await close(upstream); });
  return { ...boundary, port, upstream, upstreamPort, requests };
}

async function request(boundary, { method = 'GET', path = '/', headers = {}, body = '', chunks, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: boundary.port, method, path,
      headers: { ...(authenticated ? { Authorization: authorization } : {}), ...headers },
      timeout: 5000,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Remote access test request timed out.')));
    if (chunks) for (const chunk of chunks) req.write(chunk);
    req.end(body);
  });
}

test('every resource and API requires exact Basic authentication', async (t) => {
  const boundary = await fixture(t);
  for (const path of ['/', '/assets/app.js', '/api/runtime', '/api/tasks', '/favicon.ico']) {
    const response = await request(boundary, { path, authenticated: false });
    assert.equal(response.status, 401, path);
    assert.match(response.headers['www-authenticate'], /^Basic\s/i);
  }
  for (const value of ['Bearer remote-test-password-123456', 'Basic !!!', `Basic ${Buffer.from(`${username}:incorrect`).toString('base64')}`]) {
    assert.equal((await request(boundary, { headers: { Authorization: value } })).status, 401);
  }
  const queryCredentials = await request(boundary, {
    authenticated: false, path: `/?username=${username}&password=${password}`,
  });
  assert.equal(queryCredentials.status, 401);
  assert.equal(boundary.requests.length, 0, 'Rejected authentication must never reach the application.');
});

test('authenticated application requests preserve method, path, query and body', async (t) => {
  const boundary = await fixture(t);
  const body = JSON.stringify({ projectId: 'remote-project', idea: '远程完整工作台提交测试。' });
  const response = await request(boundary, {
    method: 'POST', path: '/api/tasks?view=remote', body,
    headers: { Host: new URL(publicOrigin).host, Origin: publicOrigin, 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 200);
  assert.equal(boundary.requests.length, 1);
  const received = JSON.parse(response.text);
  assert.equal(received.method, 'POST');
  assert.equal(received.url, '/api/tasks?view=remote');
  assert.equal(received.body, body);
  assert.equal(received.headers.host, `127.0.0.1:${boundary.upstreamPort}`);
  assert.equal(received.headers.origin, undefined);
});

test('a small chunked POST survives an HTTP/1 tunnel hop without losing its body', async (t) => {
  const boundary = await fixture(t);
  const chunks = ['{"projectId":"remote-chunked",', '"idea":"分块传输提交测试。"}'];
  const response = await request(boundary, {
    method: 'POST', path: '/api/tasks', chunks,
    headers: { Host: new URL(publicOrigin).host, Origin: publicOrigin, 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 200);
  assert.equal(boundary.requests.length, 1);
  assert.equal(boundary.requests[0].body, chunks.join(''));
  assert.equal(boundary.requests[0].headers.origin, undefined);
});

test('NDJSON headers, text and heartbeats reach the client before the upstream finishes', { timeout: 5000 }, async (t) => {
  let upstreamResponse;
  const upstream = http.createServer((req, res) => {
    req.resume();
    upstreamResponse = res;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' });
    res.flushHeaders();
  });
  const upstreamPort = await listen(upstream);
  const boundary = createRemoteAccess({ upstreamPort, username, password, publicOrigin });
  const port = await listen(boundary.server);
  t.after(async () => { await close(boundary.server); await close(upstream); });
  const response = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/conversations/test/stream',
      headers: { Authorization: authorization }, timeout: 2000 }, resolve);
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('NDJSON headers were buffered.')));
    t.after(() => req.destroy());
    req.end();
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^application\/x-ndjson/);
  assert.match(response.headers['cache-control'], /(?:^|[,\s])no-transform(?:$|[,\s])/);
  assert.equal(upstreamResponse.writableEnded, false, 'Headers must arrive without any response body.');
  response.setEncoding('utf8');
  const received = [];
  response.on('data', chunk => received.push(chunk));
  // Each following upstream write waits for the client to acknowledge the
  // previous chunk. A buffering proxy cannot pass by returning a final body.
  for (const event of [{ type: 'text-delta', text: '你好' }, { type: 'heartbeat' }]) {
    const nextChunk = once(response, 'data');
    const line = JSON.stringify(event) + '\n';
    upstreamResponse.write(line);
    assert.equal((await nextChunk)[0], line);
    assert.equal(upstreamResponse.writableEnded, false);
  }
  const ended = once(response, 'end');
  upstreamResponse.end(JSON.stringify({ type: 'finish' }) + '\n');
  await ended;
  assert.deepEqual(received.join('').trim().split('\n').map(JSON.parse), [
    { type: 'text-delta', text: '你好' }, { type: 'heartbeat' }, { type: 'finish' },
  ]);
});

test('an oversized chunked POST returns 413 and cannot complete an upstream submission', async (t) => {
  const boundary = await fixture(t);
  const response = await request(boundary, {
    method: 'POST', path: '/api/tasks', chunks: Array.from({ length: 40 }, () => 'x'.repeat(64 * 1024)),
    headers: { Host: new URL(publicOrigin).host, Origin: publicOrigin, 'Content-Type': 'application/json' },
  });
  assert.equal(response.status, 413);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(boundary.requests.length, 0, 'The upstream must never receive a completed oversized submission.');
});

test('Host is limited to the published origin or this proxy loopback address', async (t) => {
  const boundary = await fixture(t);
  for (const host of [new URL(publicOrigin).host, `127.0.0.1:${boundary.port}`]) {
    assert.equal((await request(boundary, { headers: { Host: host } })).status, 200, host);
  }
  const before = boundary.requests.length;
  for (const host of ['attacker.example', `${new URL(publicOrigin).host}.attacker.example`, '127.0.0.1:1']) {
    assert.equal((await request(boundary, { headers: { Host: host } })).status, 403, host);
  }
  assert.equal(boundary.requests.length, before);
});

test('cross-origin mutations are rejected before upstream while same-origin mutations work', async (t) => {
  const boundary = await fixture(t);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    for (const origin of ['https://attacker.example', `${publicOrigin}.attacker.example`, 'null']) {
      const response = await request(boundary, {
        method, path: '/api/tasks', headers: { Origin: origin, Host: new URL(publicOrigin).host },
      });
      assert.equal(response.status, 403, `${method} ${origin}`);
    }
  }
  assert.equal(boundary.requests.length, 0);
  const response = await request(boundary, {
    method: 'POST', path: '/api/tasks', headers: { Origin: publicOrigin, Host: new URL(publicOrigin).host },
  });
  assert.equal(response.status, 200);
  assert.equal(boundary.requests[0].headers.origin, undefined);
});

test('proxy credentials and client forwarding headers never reach the application', async (t) => {
  const boundary = await fixture(t);
  const response = await request(boundary, {
    headers: {
      Cookie: 'session=do-not-forward',
      'Proxy-Authorization': 'Basic do-not-forward',
      Forwarded: 'for=192.0.2.1;host=attacker.example;proto=https',
      'X-Forwarded-For': '192.0.2.2',
      'X-Forwarded-Host': 'attacker.example',
      'X-Forwarded-Proto': 'https',
      'X-Real-IP': '192.0.2.3',
    },
  });
  assert.equal(response.status, 200);
  const received = JSON.parse(response.text);
  for (const name of ['authorization', 'cookie', 'proxy-authorization', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip']) {
    assert.equal(received.headers[name], undefined, `${name} must be stripped`);
  }
  assert.equal(response.text.includes(password), false);
  assert.equal(received.headers.host, `127.0.0.1:${boundary.upstreamPort}`);
});

test('successful and denied responses are not stored by browsers or intermediaries', async (t) => {
  const boundary = await fixture(t);
  for (const options of [{}, { authenticated: false }, { headers: { Host: 'attacker.example' } }]) {
    const response = await request(boundary, options);
    assert.match(response.headers['cache-control'], /(?:^|[,\s])no-store(?:$|[,\s])/);
    assert.doesNotMatch(response.headers['cache-control'], /public|max-age=3600/);
  }
});

test('request targets cannot supply credentials or select a different upstream', async (t) => {
  const boundary = await fixture(t);
  for (const path of [
    'http://user:password@127.0.0.1/api/runtime',
    'http://attacker.example/api/runtime',
    '//attacker.example/api/runtime',
  ]) {
    const response = await request(boundary, { path });
    assert.ok([400, 403].includes(response.status), `${path}: expected rejection, received ${response.status}`);
  }
  assert.equal(boundary.requests.length, 0);
  // A URL-shaped query remains ordinary data and cannot redirect proxy routing.
  const response = await request(boundary, { path: '/api/runtime?upstream=http%3A%2F%2Fattacker.example' });
  assert.equal(response.status, 200);
  assert.equal(boundary.requests.length, 1);
  assert.equal(boundary.requests[0].headers.host, `127.0.0.1:${boundary.upstreamPort}`);
});

test('upstream failure returns a non-cacheable 502 without exposing proxy credentials', async (t) => {
  const boundary = await fixture(t);
  await close(boundary.upstream);
  const response = await request(boundary, { path: '/api/runtime' });
  assert.equal(response.status, 502);
  assert.match(response.headers['cache-control'], /no-store/);
  assert.equal(response.text.includes(password), false);
  assert.equal(response.text.includes(authorization), false);
});

test('published origin validation rejects unsafe values and atomically changes Host access', async (t) => {
  const boundary = await fixture(t);
  for (const origin of [
    'not a URL', 'http://talewick-example.trycloudflare.com',
    'https://user:password@talewick-example.trycloudflare.com',
    `${publicOrigin}/nested`, `${publicOrigin}?token=unsafe`, `${publicOrigin}#unsafe`,
  ]) {
    assert.throws(() => boundary.setPublicOrigin(origin), undefined, origin);
  }
  assert.equal((await request(boundary, { headers: { Host: new URL(publicOrigin).host } })).status, 200);
  const replacement = 'https://talewick-replacement.trycloudflare.com';
  boundary.setPublicOrigin(replacement);
  assert.equal((await request(boundary, { headers: { Host: new URL(publicOrigin).host } })).status, 403);
  const response = await request(boundary, {
    method: 'POST', path: '/api/tasks', headers: { Host: new URL(replacement).host, Origin: replacement },
  });
  assert.equal(response.status, 200);
});

const socketPath = '/api/conversations/test-project/turns/test-turn/socket';
async function socketFixture(t) {
  const upstream = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const upgrades = [], messages = [];
  upstream.on('upgrade', (req, socket, head) => {
    upgrades.push({ url: req.url, headers: req.headers });
    sockets.handleUpgrade(req, socket, head, client => {
      client.on('message', message => messages.push(String(message)));
      client.on('error', () => {});
      sockets.emit('connection', client, req);
    });
  });
  const upstreamPort = await listen(upstream);
  const boundary = createRemoteAccess({ upstreamPort, username, password, publicOrigin });
  const port = await listen(boundary.server);
  t.after(async () => {
    await close(boundary.server);
    for (const client of sockets.clients) client.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await close(upstream);
  });
  return { ...boundary, port, sockets, upgrades, messages, upstream, upstreamPort };
}

async function rejectedSocket(boundary, { path = socketPath, headers = {}, authenticated = true } = {}) {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${boundary.port}${path}`, {
      headers: { ...(authenticated ? { Authorization: authorization } : {}), ...headers }, handshakeTimeout: 2000,
    });
    client.once('open', () => { client.terminate(); reject(new Error('A rejected upgrade unexpectedly opened.')); });
    client.on('error', () => {});
    client.once('unexpected-response', (_request, response) => {
      response.setEncoding('utf8'); let body = '';
      response.on('data', chunk => { body += chunk; });
      response.once('end', () => { client.terminate(); resolve({ status: response.statusCode, headers: response.headers, body }); });
      response.once('error', reject);
    });
  });
}

async function connectSocket(t, boundary, headers = {}, protocols = []) {
  const backendConnection = once(boundary.sockets, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${boundary.port}${socketPath}`, protocols, {
    headers: { Authorization: authorization, Origin: publicOrigin, Host: new URL(publicOrigin).host, ...headers }, handshakeTimeout: 2000,
  });
  client.on('error', () => {});
  t.after(() => client.terminate());
  await once(client, 'open');
  const [backend] = await backendConnection;
  return { client, backend };
}

test('WebSocket upgrades require Basic authentication, allowed Host and Origin, and the exact read-only route', { timeout: 5000 }, async t => {
  const boundary = await socketFixture(t);
  const cases = [
    [{ authenticated: false }, 401],
    [{ headers: { Authorization: 'Basic incorrect' } }, 401],
    [{ headers: { Host: 'attacker.example' } }, 403],
    [{ headers: { Origin: 'https://attacker.example' } }, 403],
    [{ headers: { Origin: 'null' } }, 403],
    [{ path: '/api/tasks' }, 404],
    [{ path: socketPath + '?password=do-not-use' }, 404],
    [{ path: '/api/conversations/../turns/test-turn/socket' }, 404],
  ];
  for (const [options, status] of cases) {
    const response = await rejectedSocket(boundary, options);
    assert.equal(response.status, status);
    assert.match(response.headers['www-authenticate'], /^Basic\s/i);
    assert.match(response.headers['cache-control'], /no-store/);
    assert.equal(response.body.includes(password), false);
  }
  assert.equal(boundary.upgrades.length, 0, 'Rejected upgrades must not reach the application.');
});

test('WebSocket relays separate snapshot, text and done messages before the source closes', { timeout: 5000 }, async t => {
  const boundary = await socketFixture(t);
  const { client, backend } = await connectSocket(t, boundary);
  const received = [];
  for (const event of [{ type: 'snapshot', text: '' }, { type: 'text', delta: '你好' }, { type: 'text', delta: '，继续聊。' }, { type: 'done' }]) {
    const arrival = once(client, 'message'); backend.send(JSON.stringify(event));
    const [data, isBinary] = await arrival; assert.equal(isBinary, false);
    received.push(JSON.parse(String(data))); assert.equal(backend.readyState, WebSocket.OPEN);
  }
  assert.deepEqual(received.map(event => event.type), ['snapshot', 'text', 'text', 'done']);
  const closed = once(client, 'close'); backend.close(1000); assert.equal((await closed)[0], 1000);
});

test('WebSocket gateway strips remote credentials, cookies, subprotocol and forwarding headers', { timeout: 5000 }, async t => {
  const boundary = await socketFixture(t);
  const { client } = await connectSocket(t, boundary, {
    Cookie: 'private-browser-cookie', Forwarded: 'for=192.0.2.1', 'X-Forwarded-For': '192.0.2.2',
    'Proxy-Authorization': 'Basic private-proxy-credential', 'X-Real-IP': '192.0.2.3',
  }, ['private-browser-protocol']);
  assert.equal(boundary.upgrades.length, 1);
  const upstream = boundary.upgrades[0];
  assert.equal(upstream.url, socketPath); assert.equal(upstream.headers.host, `127.0.0.1:${boundary.upstreamPort}`);
  for (const name of ['authorization', 'cookie', 'origin', 'forwarded', 'x-forwarded-for', 'proxy-authorization', 'x-real-ip', 'sec-websocket-protocol']) assert.equal(upstream.headers[name], undefined, name);
  assert.equal(JSON.stringify(upstream).includes(password), false); client.close();
});

test('client application messages are refused and never forwarded to the read-only upstream', { timeout: 5000 }, async t => {
  const boundary = await socketFixture(t);
  const { client, backend } = await connectSocket(t, boundary);
  const closed = once(client, 'close'); const backendClosed = once(backend, 'close');
  client.send(JSON.stringify({ action: 'create_task', idea: 'must not execute' }));
  assert.equal((await closed)[0], 1008); await backendClosed;
  assert.deepEqual(boundary.messages, []);
});

test('disconnecting the WebSocket client releases its upstream subscription', { timeout: 5000 }, async t => {
  const boundary = await socketFixture(t);
  const { client, backend } = await connectSocket(t, boundary);
  const backendClosed = once(backend, 'close'); client.terminate(); await backendClosed;
  assert.equal(backend.readyState, WebSocket.CLOSED); assert.equal(boundary.sockets.clients.size, 0);
});

test('closing the gateway releases both ends of open WebSocket subscriptions', { timeout: 5000 }, async t => {
  const boundary = await socketFixture(t);
  const { client, backend } = await connectSocket(t, boundary);
  const clientClosed = once(client, 'close'); const backendClosed = once(backend, 'close');
  await close(boundary.server); await Promise.all([clientClosed, backendClosed]);
  assert.equal(client.readyState, WebSocket.CLOSED); assert.equal(backend.readyState, WebSocket.CLOSED);
});
