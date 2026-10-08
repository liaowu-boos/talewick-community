import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const digest = value => createHash('sha256').update(value).digest();
const safeHeaders = {
  'cache-control': 'private, no-store, no-transform', 'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow, nosnippet',
  'x-frame-options': 'DENY',
};
const basicChallenge = 'Basic realm="Talewick remote workspace", charset="UTF-8"';
function externalOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/' || url.port) {
    throw new Error('远程入口必须是没有路径、账号或参数的 HTTPS 域名。');
  }
  return url;
}

/** A separate, authenticated front door. The existing app remains loopback-only. */
export function createRemoteAccess({ upstreamPort = 4326, username = 'talewick', password, publicOrigin } = {}) {
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1024 || upstreamPort > 65535) throw new Error('本机服务端口无效。');
  if (typeof username !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(username) || typeof password !== 'string' || password.length < 16) throw new Error('远程入口需要独立账号和至少 16 字符的密码。');
  const expected = digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  let origin = publicOrigin ? externalOrigin(publicOrigin) : null;
  const reply = (res, status, message, extra = {}) => {
    if (res.headersSent) { res.destroy(); return; }
    res.writeHead(status, { ...safeHeaders, 'Content-Type': 'application/json; charset=utf-8', ...extra });
    res.end(JSON.stringify({ error: message }));
  };
  const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 30000 }, (req, res) => {
    if (!timingSafeEqual(digest(req.headers.authorization || ''), expected)) {
      reply(res, 401, '请使用本次远程入口的账号和密码登录。', { 'WWW-Authenticate': basicChallenge });
      return;
    }
    if (!origin) { reply(res, 503, '远程地址尚未就绪，请稍后刷新。'); return; }
    const localPort = server.address()?.port;
    const hosts = new Set([origin.host, `127.0.0.1:${localPort}`, `localhost:${localPort}`]);
    if (!hosts.has(req.headers.host || '')) { reply(res, 403, '当前地址不属于本次远程入口。'); return; }
    if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.includes('\\')) { reply(res, 400, '请求地址无效。'); return; }
    const permittedOrigins = new Set([origin.origin, `http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`]);
    if (req.headers.origin && !permittedOrigins.has(req.headers.origin)) { reply(res, 403, '当前页面不能提交到此远程入口。'); return; }
    if (req.method === 'POST' && req.headers['sec-fetch-site'] === 'cross-site') { reply(res, 403, '拒绝跨站修改请求。'); return; }
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) { reply(res, 405, '此入口不支持当前操作。'); return; }
    if (Number(req.headers['content-length'] || 0) > 2 * 1024 * 1024) {
      reply(res, 413, '单次请求超过限制，请减少本次材料。'); return;
    }
    // The gateway first authenticates the user and checks the external origin. Only then does
    // it create a trusted local request; remote credentials and proxy headers never reach the app.
    const headers = { host: `127.0.0.1:${upstreamPort}` };
    for (const name of ['accept', 'accept-encoding', 'content-type', 'content-length', 'if-none-match', 'if-modified-since', 'range']) {
      if (req.headers[name] !== undefined) headers[name] = req.headers[name];
    }
    const upstream = http.request({ hostname: '127.0.0.1', port: upstreamPort, method: req.method, path: req.url, headers, timeout: 30000 }, response => {
      const forwarded = { ...response.headers };
      for (const key of ['connection', 'keep-alive', 'transfer-encoding', 'set-cookie', 'www-authenticate', 'access-control-allow-origin', 'access-control-allow-credentials']) delete forwarded[key];
      res.writeHead(response.statusCode || 502, { ...forwarded, ...safeHeaders });
      res.flushHeaders();
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.on('error', () => reply(res, 502, 'Mac mini 上的创作服务暂时不可用，请等待服务恢复。'));
    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
    let received = 0;
    req.on('data', chunk => {
      received += chunk.length;
      if (received > 2 * 1024 * 1024) {
        req.unpipe(upstream); upstream.destroy();
        reply(res, 413, '单次请求超过限制，请减少本次材料。');
        req.resume();
      }
    });
    req.pipe(upstream);
  });

  // Quick Tunnel buffers ordinary HTTP response bodies. This authenticated,
  // read-only socket relays the same conversation events without that buffer.
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
  const peers = new Map();
  const rejectUpgrade = (socket, status, message) => {
    const body = Buffer.from(JSON.stringify({ error: message }));
    const headers = { ...safeHeaders, 'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length, Connection: 'close', 'WWW-Authenticate': basicChallenge };
    socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}\r\n`).join('')}\r\n${body}`);
    const timer = setTimeout(() => socket.destroy(), 1000); timer.unref();
    socket.once('close', () => clearTimeout(timer));
  };
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!timingSafeEqual(digest(req.headers.authorization || ''), expected)) { rejectUpgrade(socket, 401, '请使用本次远程入口的账号和密码登录。'); return; }
    if (!origin) { rejectUpgrade(socket, 503, '远程地址尚未就绪，请稍后刷新。'); return; }
    const localPort = server.address()?.port;
    const hosts = new Set([origin.host, `127.0.0.1:${localPort}`, `localhost:${localPort}`]);
    if (!hosts.has(req.headers.host || '')) { rejectUpgrade(socket, 403, '当前地址不属于本次远程入口。'); return; }
    const permittedOrigins = new Set([origin.origin, `http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`]);
    if (req.headers.origin && !permittedOrigins.has(req.headers.origin)) { rejectUpgrade(socket, 403, '当前页面不能订阅此远程入口。'); return; }
    if (req.method !== 'GET') { rejectUpgrade(socket, 405, '对话订阅只支持读取。'); return; }
    if (!/^\/api\/conversations\/[\w-]{1,160}\/turns\/[\w-]{1,160}\/socket$/.test(req.url || '')) { rejectUpgrade(socket, 404, '找不到这个对话订阅入口。'); return; }
    websocketServer.handleUpgrade(req, socket, head, client => {
      // Only the already validated path crosses the boundary. Authentication,
      // cookies, Origin and all client forwarding headers stay at this gateway.
      const upstream = new WebSocket(`ws://127.0.0.1:${upstreamPort}${req.url}`, {
        handshakeTimeout: 10000, maxPayload: 4 * 1024 * 1024, perMessageDeflate: false, followRedirects: false,
      });
      let stopped = false;
      const stop = (code = 1000, message = '') => {
        if (stopped) return;
        stopped = true; peers.delete(client); upstream.terminate();
        if (client.readyState === WebSocket.OPEN) {
          client.close(code, message);
          const timer = setTimeout(() => client.terminate(), 1000); timer.unref();
          client.once('close', () => clearTimeout(timer));
        } else if (client.readyState !== WebSocket.CLOSED) client.terminate();
      };
      peers.set(client, { upstream, stop });
      client.on('message', () => stop(1008, '对话订阅为只读通道。'));
      client.on('close', () => stop());
      client.on('error', () => stop(1011, '对话连接已中断，请重新连接。'));
      upstream.on('message', (data, isBinary) => {
        if (stopped || client.readyState !== WebSocket.OPEN) return;
        if (client.bufferedAmount > 1024 * 1024) { stop(1013, '接收过慢，请重新连接恢复对话。'); return; }
        client.send(data, { binary: isBinary }, error => { if (error) stop(1011, '对话连接已中断，请重新连接。'); });
        if (client.bufferedAmount > 1024 * 1024) stop(1013, '接收过慢，请重新连接恢复对话。');
      });
      upstream.on('close', code => stop(code === 1000 ? 1000 : 1011, code === 1000 ? '' : '对话服务连接已中断，请重新连接。'));
      upstream.on('error', () => stop(1011, '对话服务暂时不可用，请重新连接。'));
      upstream.on('unexpected-response', (_request, response) => { response.resume(); stop(1011, '对话订阅暂时不可用，请重新连接。'); });
    });
  });
  let socketsClosed = false;
  const closeSockets = () => {
    if (socketsClosed) return;
    socketsClosed = true;
    for (const { stop } of peers.values()) stop(1001, '远程服务已停止。');
    for (const client of websocketServer.clients) client.terminate();
    websocketServer.close();
  };
  // Upgraded sockets can keep HTTP close pending; release them before waiting
  // for the HTTP server's close event, including normal supervisor shutdown.
  const closeHTTP = server.close.bind(server);
  server.close = (...args) => { closeSockets(); return closeHTTP(...args); };
  server.on('close', closeSockets);
  return { server, setPublicOrigin(value) { origin = externalOrigin(value); } };
}
