import { DurableObject } from 'cloudflare:workers';
import { createRoom, newRoomId, readJson, RequestError, roomLifetime, roomRequest, roomRoute } from './room-service.mjs';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

function errorResponse(error) {
  if (!(error instanceof RequestError)) {
    console.error('Room service failed', error.name);
    return json({ error: '联机服务暂时不可用。' }, 500);
  }
  return json({ error: error.message }, error.status);
}

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const [, id, endpoint] = roomRoute.exec(url.pathname);
    const { method, headers } = request;
    try {
      const data = method === 'POST' && await readJson(headers.get('Content-Type'), request.body);
      return await this.ctx.blockConcurrencyWhile(async () => {
        const storage = this.ctx.storage;
        const room = await storage.get('room');
        const publicOrigin = this.env.GAME_URL;
        let result;
        let updatedRoom = room;
        try {
          if (method === 'POST' && !endpoint) {
            if (room) return json({ error: '请重试创建房间。' }, 409);
            const created = createRoom(id, data, publicOrigin);
            updatedRoom = created.room;
            result = { status: 201, body: created.body };
          } else {
            result = roomRequest(room, {
              method, endpoint, data, authorization: headers.get('Authorization'),
              since: url.searchParams.get('since'), publicOrigin,
            });
          }
        } catch (error) {
          return errorResponse(error);
        }
        if (method === 'POST') {
          await Promise.all([
            storage.put('room', updatedRoom),
            storage.setAlarm(updatedRoom.touched + roomLifetime),
          ]);
        }
        return json(result.body, result.status);
      });
    } catch (error) {
      return errorResponse(error);
    }
  }

  async alarm() {
    await this.ctx.blockConcurrencyWhile(async () => {
      const storage = this.ctx.storage;
      const room = await storage.get('room');
      if (!room) return;
      const expires = room.touched + roomLifetime;
      if (expires > Date.now()) await storage.setAlarm(expires);
      else await storage.delete('room');
    });
  }
}

async function route(request, url, env) {
  const { method } = request;
  if (method === 'GET' && url.pathname === '/api/health') {
    return json({ online: true, publicOrigin: env.GAME_URL });
  }
  if (method === 'POST' && url.pathname === '/api/rooms') {
    const address = request.headers.get('CF-Connecting-IP');
    if (address && env.ROOM_CREATION_LIMIT) {
      if (!(await env.ROOM_CREATION_LIMIT.limit({ key: address })).success) {
        return json({ error: '创建房间太频繁，请稍后再试。' }, 429);
      }
    }
    const id = newRoomId();
    url.pathname += '/' + id;
    return env.ROOMS.getByName(id).fetch(new Request(url, request));
  }
  const match = roomRoute.exec(url.pathname);
  if (!match) return json({ error: '没有找到这个页面。' }, 404);
  const [, id, endpoint] = match;
  if ((method === 'GET' && !endpoint) || (method === 'POST' && endpoint)) {
    return env.ROOMS.getByName(id).fetch(request);
  }
  return json({ error: '请求方式无效。' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const allowedOrigin = new URL(env.GAME_URL).origin;
    if (origin && origin !== allowedOrigin) return json({ error: '请从游戏页面打开联机。' }, 403);
    let response;
    try {
      response = request.method === 'OPTIONS' ? new Response(null, { status: 204 }) : await route(request, url, env);
    } catch (error) {
      response = errorResponse(error);
    }
    const headers = new Headers(response.headers);
    headers.set('Vary', 'Origin');
    if (origin) headers.set('Access-Control-Allow-Origin', allowedOrigin);
    if (request.method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.set('Access-Control-Max-Age', '3600');
    }
    return new Response(response.body, { status: response.status, headers });
  },
};
