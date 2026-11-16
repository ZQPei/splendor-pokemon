import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { CARDS } from './dist/data/cards.mjs';
import { applyAction, createGame, legalMoves, passTurn } from './dist/engine/index.mjs';

const port = Number(process.env.PORT ?? 8766);
const host = process.env.BIND_HOST ?? '127.0.0.1';
const publicOrigin = process.env.PUBLIC_ORIGIN ? new URL(process.env.PUBLIC_ORIGIN).origin : '';
const rooms = new Map();
const roomLifetime = 24 * 60 * 60 * 1000;
const capacity = 4;
const roomLimit = 200;
const permittedActions = new Set(['TAKE_THREE', 'TAKE_TWO', 'RESERVE', 'BUY', 'DISCARD', 'EVOLVE', 'END_TURN', 'PASS']);
const media = { html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', mjs: 'text/javascript; charset=utf-8', webp: 'image/webp' };

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, code, data) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new RequestError(415, '请求格式无效。');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new RequestError(413, '请求过大。');
    chunks.push(chunk);
  }
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new RequestError(400, '请求格式无效。');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new RequestError(400, '请求格式无效。');
  return data;
}

function seat(room, data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || [...name].length > 18 || /[\p{C}]/u.test(name)) throw new RequestError(400, '请填写 1–18 个字符的昵称。');
  if (room.members.some(member => member.name === name)) throw new RequestError(409, '这个昵称已有人使用。');
  const player = { id: 'p' + room.members.length, name, token: randomBytes(24).toString('base64url') };
  room.members.push(player);
  room.revision++;
  room.touched = Date.now();
  return player;
}

function view(room, player) {
  const game = room.game;
  const state = game && {
    players: game.players.map(person => ({
      id: person.id,
      name: person.name,
      isAI: false,
      purchased: person.purchased,
      reserved: person.id === player.id ? person.reserved : Array(person.reserved.length).fill(null),
      evolved: person.evolved,
      bonuses: person.bonuses,
      tokens: person.tokens,
      points: person.points,
    })),
    decks: Object.fromEntries(Object.entries(game.decks).map(([key, deck]) => [key, {
      faceUp: deck.faceUp, drawPile: Array(deck.drawPile.length).fill(null),
    }])),
    tokenPool: game.tokenPool,
    config: game.config,
    currentPlayerIndex: game.currentPlayerIndex,
    endTriggeredByPlayerIndex: game.endTriggeredByPlayerIndex,
    turnNumber: game.turnNumber,
    isGameOver: game.isGameOver,
    awaitingDiscard: game.awaitingDiscard,
    awaitingEvolve: game.awaitingEvolve,
    log: game.log.slice(-15),
  };
  return {
    id: room.id,
    owner: room.members[0].id,
    you: player.id,
    members: room.members.map(({ id, name }) => ({ id, name })),
    revision: room.revision,
    publicOrigin,
    state,
  };
}

function gameAction(room, member, data) {
  const game = room.game;
  const action = data.action;
  if (!game || game.isGameOver) throw new RequestError(409, '当前没有进行中的对局。');
  if (game.players[game.currentPlayerIndex].id !== member.id) throw new RequestError(409, '还没轮到你。');
  if (!action || !permittedActions.has(action.type)) throw new RequestError(400, '动作无效。');
  if ((action.type === 'BUY' && !['board', 'reserved'].includes(action.source?.kind)) ||
      (action.type === 'RESERVE' && !['board', 'deck'].includes(action.source?.kind))) {
    throw new RequestError(400, '卡牌来源无效。');
  }
  if (action.type === 'PASS' && legalMoves(game).length) throw new RequestError(400, '本回合还有可执行的动作。');
  let next;
  try {
    next = action.type === 'PASS' ? passTurn(game) : applyAction(game, action);
  } catch {
    throw new RequestError(400, '当前无法执行这个动作。');
  }
  const summary = {
    TAKE_THREE: '拿取了精灵球', TAKE_TWO: '拿取了 2 个同色球', DISCARD: '归还了多余的球',
    RESERVE: '保留了一张卡',
  }[action.type];
  if (summary) next.log.splice(game.log.length, 0, member.name + ' ' + summary + '。');
  room.game = next;
}

async function api(request, response, url) {
  if (request.method === 'GET' && url.pathname === '/api/health') return json(response, 200, { online: true, publicOrigin });
  if (request.method === 'POST' && request.headers.origin) {
    const sameHost = request.headers.origin === 'https://' + request.headers.host ||
      request.headers.origin === 'http://' + request.headers.host || request.headers.origin === publicOrigin;
    if (!sameHost) throw new RequestError(403, '请从游戏页面打开联机。');
  }
  if (request.method === 'POST' && url.pathname === '/api/rooms') {
    const data = await readJson(request);
    for (const [id, room] of rooms) if (Date.now() - room.touched > roomLifetime) rooms.delete(id);
    if (rooms.size >= roomLimit) throw new RequestError(503, '房间数量已达上限，请稍后再试。');
    const room = { id: randomBytes(9).toString('base64url'), members: [], revision: 0, game: null, touched: Date.now() };
    const member = seat(room, data);
    rooms.set(room.id, room);
    return json(response, 201, { token: member.token, room: view(room, member) });
  }

  const match = /^\/api\/rooms\/([\w-]{12})(?:\/(join|start|action))?$/.exec(url.pathname);
  if (!match) throw new RequestError(404, '没有找到这个页面。');
  const [, id, endpoint] = match;
  const room = rooms.get(id);
  if (!room || Date.now() - room.touched > roomLifetime) {
    rooms.delete(id);
    throw new RequestError(404, '房间不存在或已过期。');
  }
  if (request.method === 'POST' && endpoint === 'join') {
    const data = await readJson(request);
    if (room.game) throw new RequestError(409, '对局已开始，无法加入新玩家。');
    if (room.members.length >= capacity) throw new RequestError(409, '房间已满。');
    const member = seat(room, data);
    return json(response, 201, { token: member.token, room: view(room, member) });
  }
  const token = request.headers.authorization;
  const member = room.members.find(entry => token === 'Bearer ' + entry.token);
  if (!member) throw new RequestError(401, '此设备还未加入房间。');
  if (request.method === 'GET' && !endpoint) {
    const unchanged = url.searchParams.get('since') === String(room.revision);
    return json(response, 200, unchanged ? { revision: room.revision } : { room: view(room, member) });
  }
  if (request.method !== 'POST') throw new RequestError(405, '请求方式无效。');
  const data = await readJson(request);
  if (endpoint === 'start') {
    if (member !== room.members[0]) throw new RequestError(403, '只有房主可以开局。');
    if (room.game || room.members.length < 2) throw new RequestError(409, '至少两位训练家加入后才能开局。');
    room.game = createGame({
      players: room.members.map(({ id, name }) => ({ id, name, isAI: false })),
      cards: CARDS,
      seed: randomBytes(4).readUInt32LE(0),
    });
  } else if (endpoint === 'action') {
    if (data.revision !== room.revision) throw new RequestError(409, '对局状态有更新，请重试。');
    gameAction(room, member, data);
  } else {
    throw new RequestError(405, '请求方式无效。');
  }
  room.revision++;
  room.touched = Date.now();
  return json(response, 200, { room: view(room, member) });
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
