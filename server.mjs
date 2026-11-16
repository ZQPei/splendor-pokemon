import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRoom, newRoomId, readJson, RequestError, roomLifetime, roomRequest, roomRoute } from './room-service.mjs';

const port = Number(process.env.PORT ?? 8766);
const host = process.env.BIND_HOST ?? '127.0.0.1';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : '';
const rooms = new Map();
const roomLimit = 200;
const media = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', mjs: 'text/javascript; charset=utf-8', webp: 'image/webp' };

function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function api(request, response, url) {
  const { method, headers } = request;
  if (method === 'GET' && url.pathname === '/api/health') return json(response, 200, { online: true, publicOrigin });
  if (method === 'POST' && headers.origin) {
    const sameHost = headers.origin === 'https://' + headers.host ||
      headers.origin === 'http://' + headers.host || headers.origin === publicOrigin;
    if (!sameHost) throw new RequestError(403, '请从游戏页面打开联机。');
  }
  if (method === 'POST' && url.pathname === '/api/rooms') {
    const data = await readJson(headers['content-type'], request);
    for (const [id, room] of rooms) if (Date.now() - room.touched >= roomLifetime) rooms.delete(id);
    if (rooms.size >= roomLimit) throw new RequestError(503, '房间数量已达上限，请稍后再试。');
    let id;
    do { id = newRoomId(); } while (rooms.has(id));
    const { room, body } = createRoom(id, data, publicOrigin);
    rooms.set(id, room);
    return json(response, 201, body);
  }

  const match = roomRoute.exec(url.pathname);
  if (!match) throw new RequestError(404, '没有找到这个页面。');
  const [, id, endpoint] = match;
  const data = method === 'POST' && await readJson(headers['content-type'], request);
  const result = roomRequest(rooms.get(id), {
    method, endpoint, data, authorization: headers.authorization,
    since: url.searchParams.get('since'), publicOrigin,
  });
  return json(response, result.status, result.body);
}

const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) return await api(request, response, url);
    if (!['GET', 'HEAD'].includes(request.method)) throw new RequestError(405, '请求方式无效。');
    const relative = url.pathname.replace(/^\/splendor-pokemon\/dist\//, '/').slice(1) || 'index.html';
    if (!/^(?:index\.html|style\.css|(?:app|online)\.mjs|(?:ai|engine|data)\/[a-z-]+\.mjs|assets\/\d+\.webp)$/.test(relative)) {
      throw new RequestError(404, '没有找到这个页面。');
    }
    const content = await readFile(new URL('./dist/' + relative, import.meta.url));
    const extension = relative.split('.').at(-1);
    response.writeHead(200, {
      'Content-Type': media[extension],
      'Cache-Control': extension === 'webp' ? 'public, max-age=86400' : 'no-cache',
    });
    response.end(content);
  } catch (error) {
    const code = error.status ?? (error.code === 'ENOENT' ? 404 : 500);
    json(response, code, { error: code === 500 ? '服务器暂时不可用。' : error.message });
  }
});
server.requestTimeout = 15000;
server.listen(port, host, () => console.log('宝可梦联机服务 http://' + host + ':' + port));
