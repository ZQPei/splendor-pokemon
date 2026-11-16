// 纯函数 reducer:applyAction(state, action) -> 新 GameState(不改入参)。
import {
  HAND_LIMIT,
  COLOR_ORDER,
  MAX_RESERVED,
  TAKE_TWO_MIN_PILE,
  WIN_THRESHOLD,
  ALL_PILES,
  PAYABLE_ORDER,
} from './types.mjs';
import { resolveBuyCost } from './buy.mjs';
import { refreshPlayerDerived } from './derive.mjs';
import { legalEvolutions } from './moves.mjs';
import { colorVectorMeets, totalTokens } from './util.mjs';

const STALEMATE_LIMIT = 100;

// 快速深拷:卡牌不可变(全程只读),故卡牌数组浅拷(共享卡引用)即可,
// 避开 structuredClone 对 ~90 张卡的无谓深拷。行为与 structuredClone 等价(已验证:
// 引擎单测全过 + 自对弈逐局 turnNumber 完全一致)。
function clone(state) {
  const players= new Array(state.players.length);
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const t = p.tokens, bn = p.bonuses;
    players[i] = {
      id: p.id, name: p.name, isAI: p.isAI,
      tokens: { red: t.red, blue: t.blue, black: t.black, pink: t.pink, yellow: t.yellow, master: t.master },
      purchased: p.purchased.slice(),
      reserved: p.reserved.slice(),
      evolved: p.evolved.slice(),
      bonuses: { red: bn.red, blue: bn.blue, black: bn.black, pink: bn.pink, yellow: bn.yellow },
      ownedSpecies: new Set(p.ownedSpecies),
      points: p.points,
    };
  }
  const decks = {}                      ;
  for (const key of ALL_PILES) {
    const d = state.decks[key];
    decks[key] = { key: d.key, drawPile: d.drawPile.slice(), faceUp: d.faceUp.slice() };
  }
  const tp = state.tokenPool;
  return {
    players,
    currentPlayerIndex: state.currentPlayerIndex,
    tokenPool: { red: tp.red, blue: tp.blue, black: tp.black, pink: tp.pink, yellow: tp.yellow, master: tp.master },
    decks,
    turnNumber: state.turnNumber,
    roundStartIndex: state.roundStartIndex,
    lastProgressTurn: state.lastProgressTurn,
    config: state.config, // 不可变,共享
    endTriggeredByPlayerIndex: state.endTriggeredByPlayerIndex,
    isGameOver: state.isGameOver,
    winnerId: state.winnerId,
    awaitingDiscard: state.awaitingDiscard,
    awaitingEvolve: state.awaitingEvolve,
    rngSeed: state.rngSeed,
    log: state.log.slice(),
  };
}

function findFaceUp(state, cardId) {
  for (const pile of ALL_PILES) {
    const slot = state.decks[pile].faceUp.findIndex((c) => c?.id === cardId);
    if (slot >= 0) return { pile, slot, card: state.decks[pile].faceUp[slot]  };
  }
  return null;
}

function refill(state, pile, slot) {
  state.decks[pile].faceUp[slot] = state.decks[pile].drawPile.shift() ?? null;
}

/** Players still tied after points, evolutions, and owned-card count. */
export function gameWinners(state) {
  const maxP = Math.max(...state.players.map((p) => p.points));
  let contenders = state.players.filter((p) => p.points === maxP);
  // tiebreak:先比已进化数量,再比拥有宝可梦总数
  const maxEvo = Math.max(...contenders.map((p) => p.evolved.length));
  contenders = contenders.filter((p) => p.evolved.length === maxEvo);
  const maxOwned = Math.max(...contenders.map((p) => p.purchased.length));
  return contenders.filter((p) => p.purchased.length === maxOwned);
}

function finishGame(state, stalemate = false) {
  state.isGameOver = true;
  if (stalemate) state.log.push(`僵局:连续 ${STALEMATE_LIMIT} 回合无人推进,按当前分数判定。`);
  const winners = gameWinners(state);
  const maxP = winners[0].points;
  state.winnerId = winners[0].id;
  state.log.push(
    winners.length > 1
      ? `平局共享胜利:${winners.map((w) => w.name).join('、')}(${maxP} 分)`
      : `${winners[0].name} 获胜!(${maxP} 分)`,
  );
}

function advanceTurn(state) {
  state.awaitingEvolve = false;
  const n = state.players.length;
  if (state.endTriggeredByPlayerIndex === null) {
    const reacher = state.players.findIndex((p) => p.points >= WIN_THRESHOLD);
    if (reacher >= 0) {
      state.endTriggeredByPlayerIndex = reacher;
      state.log.push(`${state.players[reacher].name} 达到 ${WIN_THRESHOLD} 分,进入最终回合!`);
    }
  }
  const next = (state.currentPlayerIndex + 1) % n;
  state.turnNumber += 1;
  if (next === state.roundStartIndex && state.players.some((p) => p.points >= WIN_THRESHOLD)) {
    finishGame(state);
    return;
  }
  if (state.turnNumber - state.lastProgressTurn > STALEMATE_LIMIT) {
    finishGame(state, true);
    return;
  }
  state.currentPlayerIndex = next;
}

/** 主动作后:若有合法进化则进入进化子阶段,否则结束回合。 */
function enterEvolveOrAdvance(state) {
  const me = state.players[state.currentPlayerIndex];
  if (legalEvolutions(state, me).length > 0) state.awaitingEvolve = true;
  else advanceTurn(state);
}

// ----------------------------- 动作 ----------------------------------------

function applyTakeThree(state, me, colors) {
  if (new Set(colors).size !== colors.length) throw new Error('取不同色:颜色须互异');
  const required = Math.min(3, COLOR_ORDER.filter(color => state.tokenPool[color] > 0).length);
  if (!required || (colors.length !== required && !(required === 2 && colors.length === 1))) {
    throw new Error(`请选择 ${required} 种不同颜色的球`);
  }
  for (const c of colors) {
    if (!COLOR_ORDER.includes(c)) throw new Error('只能拿取普通球');
    if (state.tokenPool[c] <= 0) throw new Error(`供给区无 ${String(c)}`);
    state.tokenPool[c] -= 1;
    me.tokens[c] += 1;
  }
}

function applyTakeTwo(state, me, color) {
  if (!COLOR_ORDER.includes(color)) throw new Error('只能拿取普通球');
  if (state.tokenPool[color] < TAKE_TWO_MIN_PILE) throw new Error(`取 2 同色要求该堆 ≥${TAKE_TWO_MIN_PILE}`);
  state.tokenPool[color] -= 2;
  me.tokens[color] += 2;
}

function applyReserve(state, me, action) {
  if (me.reserved.length >= MAX_RESERVED) throw new Error('预订区已满(3)');
  let card;
  if (action.source.kind === 'board') {
    const found = findFaceUp(state, action.source.cardId);
    if (!found) throw new Error('预订目标不在展示区');
    if (found.card.kind !== 'normal') throw new Error('稀有/传说卡不可预订');
    card = found.card;
    refill(state, found.pile, found.slot);
  } else {
    const pile = action.source.pile;
    if (pile !== 1 && pile !== 2 && pile !== 3) throw new Error('只能盲抽普通阶');
    const deck = state.decks[pile];
    if (deck.drawPile.length === 0) throw new Error('该层牌库已空');
    card = deck.drawPile.shift() ;
  }
  me.reserved.push(card);
  if (state.tokenPool.master > 0) {
    state.tokenPool.master -= 1;
    me.tokens.master += 1;
  }
}

function applyBuy(state, me, action) {
  let card;
  let from= null;
  if (action.source.kind === 'board') {
    const found = findFaceUp(state, action.source.cardId);
    if (!found) throw new Error('购买目标不在展示区');
    card = found.card;
    from = { pile: found.pile, slot: found.slot };
  } else {
    const i = me.reserved.findIndex((c) => c.id === action.source.cardId);
    if (i < 0) throw new Error('购买目标不在预订区');
    card = me.reserved[i];
    me.reserved.splice(i, 1);
  }

  const { finalColorCost, masterRequired } = resolveBuyCost(me, card);
  const payment = action.payment;
  let masterCost = masterRequired;
  for (const color of COLOR_ORDER) {
    const need = finalColorCost[color] ?? 0;
    if (!Number.isInteger(payment[color]) || payment[color] < 0 || payment[color] > need) {
      throw new Error('精灵球支付数量无效');
    }
    masterCost += need - payment[color];
  }
  if (payment.master !== masterCost || PAYABLE_ORDER.some(color => payment[color] > me.tokens[color])) {
    throw new Error(`${me.name} 无法负担 ${card.nameZh}`);
  }
  for (const color of PAYABLE_ORDER) {
    me.tokens[color] -= payment[color];
    state.tokenPool[color] += payment[color];
  }

  if (from) refill(state, from.pile, from.slot);
  me.purchased.push(card);
  refreshPlayerDerived(me);
  state.lastProgressTurn = state.turnNumber;
  state.log.push(`${me.name} 捕捉 ${card.nameZh}(${card.points}分${masterCost ? `,大师球-${masterCost}` : ''})`);
}

function applyDiscard(state, me, action) {
  if (!state.awaitingDiscard) throw new Error('当前无需弃牌');
  const excess = totalTokens(me.tokens) - HAND_LIMIT;
  let sum = 0;
  for (const t of PAYABLE_ORDER) sum += action.tokens[t];
  if (sum !== excess) throw new Error(`需弃 ${excess} 个,收到 ${sum}`);
  for (const t of PAYABLE_ORDER) {
    if (!Number.isInteger(action.tokens[t]) || action.tokens[t] < 0 || action.tokens[t] > me.tokens[t]) {
      throw new Error('请归还手中持有的球');
    }
    me.tokens[t] -= action.tokens[t];
    state.tokenPool[t] += action.tokens[t];
  }
  state.awaitingDiscard = false;
}

function applyEvolve(state, me, action) {
  const x = me.purchased.find((c) => c.id === action.fromCardId);
  if (!x) throw new Error('进化来源不在你的桌面');
  if (x.kind !== 'normal' || x.stage >= 3 || !x.evolveCost || !x.evolvesToSpeciesId) throw new Error('该卡不可进化');
  if (!colorVectorMeets(me.bonuses, x.evolveCost)) throw new Error('永久加成不满足进化需求');

  // 定位目标(展示区或预订区)
  let target= null;
  let from= null;
  const found = findFaceUp(state, action.toCardId);
  if (found) {
    target = found.card;
    from = { pile: found.pile, slot: found.slot };
  } else if (state.config.evolveFromReserved) {
    const i = me.reserved.findIndex((c) => c.id === action.toCardId);
    if (i >= 0) {
      target = me.reserved[i];
      me.reserved.splice(i, 1);
    }
  }
  if (!target) throw new Error('进化目标不可用');
  if (target.kind !== 'normal' || target.speciesId !== x.evolvesToSpeciesId) throw new Error('进化目标物种不符');

  // 低阶卡面朝下入训练师板;高阶卡入桌面
  me.purchased.splice(me.purchased.indexOf(x), 1);
  me.evolved.push(x);
  if (from) refill(state, from.pile, from.slot);
  me.purchased.push(target);
  refreshPlayerDerived(me);
  state.lastProgressTurn = state.turnNumber;
  state.log.push(`${me.name} 进化 ${x.nameZh} → ${target.nameZh}(免费)`);
}

// ----------------------------- 入口 ------------------------------------------

export function applyAction(prev, action) {
  if (prev.isGameOver) throw new Error('对局已结束');
  const state = clone(prev);
  const me = state.players[state.currentPlayerIndex];

  if (state.awaitingDiscard && action.type !== 'DISCARD') throw new Error('需先弃牌至 10');
  if (state.awaitingEvolve && action.type !== 'EVOLVE' && action.type !== 'END_TURN') {
    throw new Error('回合末:只能进化或结束回合');
  }
  if ((action.type === 'EVOLVE' || action.type === 'END_TURN') && !state.awaitingEvolve) {
    throw new Error('当前不在回合末进化阶段');
  }

  switch (action.type) {
    case 'TAKE_THREE': applyTakeThree(state, me, action.colors); break;
    case 'TAKE_TWO': applyTakeTwo(state, me, action.color); break;
    case 'RESERVE': applyReserve(state, me, action); break;
    case 'BUY': applyBuy(state, me, action); break;
    case 'DISCARD': applyDiscard(state, me, action); break;
    case 'EVOLVE': applyEvolve(state, me, action); break;
    case 'END_TURN': break;
  }

  if (action.type === 'DISCARD') {
    enterEvolveOrAdvance(state);
  } else if (action.type === 'EVOLVE' || action.type === 'END_TURN') {
    advanceTurn(state);
  } else if (totalTokens(me.tokens) > HAND_LIMIT) {
    state.awaitingDiscard = true;
  } else {
    enterEvolveOrAdvance(state);
  }

  return state;
}

/** 安全网:当前玩家无任何合法动作时跳过回合(极罕见)。 */
export function passTurn(prev) {
  if (prev.isGameOver) return prev;
  const state = clone(prev);
  state.log.push(`${state.players[state.currentPlayerIndex].name} 无合法动作,跳过`);
  advanceTurn(state);
  return state;
}
