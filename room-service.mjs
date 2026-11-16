import { CARDS } from './dist/data/cards.mjs';
import { applyAction, createGame, legalMoves, passTurn } from './dist/engine/index.mjs';

export const roomLifetime = 24 * 60 * 60 * 1000;
export const roomRoute = /^\/api\/rooms\/([\w-]{12})(?:\/(join|start|action))?$/;
const permittedActions = new Set(['TAKE_THREE', 'TAKE_TWO', 'RESERVE', 'BUY', 'DISCARD', 'EVOLVE', 'END_TURN', 'PASS']);

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function randomId(length) {
  return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length))))
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function newRoomId() {
  return randomId(9);
}

export async function readJson(contentType, stream) {
  if (!contentType?.startsWith('application/json')) throw new RequestError(415, '请求格式无效。');
  const decoder = new TextDecoder();
  let text = '';
  let size = 0;
  if (!stream) throw new RequestError(400, '请求格式无效。');
  for await (const chunk of stream) {
    size += chunk.byteLength;
    if (size > 4096) throw new RequestError(413, '请求过大。');
    text += decoder.decode(chunk, { stream: true });
  }
  text += decoder.decode();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new RequestError(400, '请求格式无效。');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RequestError(400, '请求格式无效。');
  }
  return data;
}

function seat(room, data) {
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || [...name].length > 18 || /[\p{C}]/u.test(name)) throw new RequestError(400, '请填写 1–18 个字符的昵称。');
  if (room.members.some(member => member.name === name)) throw new RequestError(409, '这个昵称已有人使用。');
  const player = { id: 'p' + room.members.length, name, token: randomId(24) };
  room.members.push(player);
  room.revision++;
  room.touched = Date.now();
  return player;
}

function view(room, player, publicOrigin) {
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

export function createRoom(id, data, publicOrigin) {
  const room = { id, members: [], revision: 0, game: null, touched: Date.now() };
  const member = seat(room, data);
  return { room, body: { token: member.token, room: view(room, member, publicOrigin) } };
}

export function roomRequest(room, { method, endpoint, data, authorization, since, publicOrigin }) {
  if (!room || Date.now() - room.touched >= roomLifetime) {
    throw new RequestError(404, '房间不存在或已过期。');
  }
  if (method === 'POST' && endpoint === 'join') {
    if (room.game) throw new RequestError(409, '对局已开始，无法加入新玩家。');
    if (room.members.length >= 4) throw new RequestError(409, '房间已满。');
    const member = seat(room, data);
    return { status: 201, body: { token: member.token, room: view(room, member, publicOrigin) } };
  }
  const member = room.members.find(entry => authorization === 'Bearer ' + entry.token);
  if (!member) throw new RequestError(401, '此设备还未加入房间。');
  if (method === 'GET' && !endpoint) {
    const unchanged = since === String(room.revision);
    return { status: 200, body: unchanged ? { revision: room.revision } : { room: view(room, member, publicOrigin) } };
  }
  if (method !== 'POST') throw new RequestError(405, '请求方式无效。');
  if (endpoint === 'start') {
    if (member !== room.members[0]) throw new RequestError(403, '只有房主可以开局。');
    if (room.game || room.members.length < 2) throw new RequestError(409, '至少两位训练家加入后才能开局。');
    room.game = createGame({
      players: room.members.map(({ id, name }) => ({ id, name, isAI: false })),
      cards: CARDS,
      seed: crypto.getRandomValues(new Uint32Array(1))[0],
    });
  } else if (endpoint === 'action') {
    if (data.revision !== room.revision) throw new RequestError(409, '对局状态有更新，请重试。');
    gameAction(room, member, data);
  } else {
    throw new RequestError(405, '请求方式无效。');
  }
  room.revision++;
  room.touched = Date.now();
  return { status: 200, body: { room: view(room, member, publicOrigin) } };
}
