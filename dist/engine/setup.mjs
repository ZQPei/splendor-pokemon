// 开局:种子化洗牌,构建 5 个牌库(普通三阶 + 稀有 + 传说)、代币供给、玩家。
import {
  COLOR_ORDER,
  COLOR_SUPPLY_BY_PLAYERS,
  MASTER_SUPPLY,
  SPECIAL_SLOTS,
  TIER_SLOTS,

  pileOf,
} from './types.mjs';
import { makeRng, shuffleInPlace } from './rng.mjs';
import { emptyColorVector, emptyPool } from './util.mjs';



export const DEFAULT_CONFIG= {
  evolveFromReserved: true,
};

function makeDeck(key, cards, slots) {
  const pile = cards.slice();
  const faceUp= [];
  for (let i = 0; i < slots; i++) faceUp.push(pile.shift() ?? null);
  return { key, drawPile: pile, faceUp };
}

function makeTokenPool(playerCount) {
  const supply = COLOR_SUPPLY_BY_PLAYERS[playerCount];
  const pool = emptyPool();
  for (const c of COLOR_ORDER) pool[c] = supply;
  pool.master = MASTER_SUPPLY;
  return pool;
}

function makePlayer(seed) {
  return {
    id: seed.id,
    name: seed.name,
    isAI: seed.isAI,
    tokens: emptyPool(),
    purchased: [],
    reserved: [],
    evolved: [],
    bonuses: emptyColorVector(),
    ownedSpecies: new Set        (),
    points: 0,
  };
}

export function createGame(opts) {
  const n = opts.players.length;
  if (n < 2 || n > 4) throw new Error(`玩家数必须为 2–4，收到 ${n}`);
  const playerCount = n;
  const config= { ...DEFAULT_CONFIG, ...opts.config };
  const rng = makeRng(opts.seed);

  const byPile= { 1: [], 2: [], 3: [], rare: [], legendary: [] };
  for (const card of opts.cards) byPile[pileOf(card)].push(card);

  const decks= {
    1: makeDeck(1, shuffleInPlace(byPile[1], rng), TIER_SLOTS),
    2: makeDeck(2, shuffleInPlace(byPile[2], rng), TIER_SLOTS),
    3: makeDeck(3, shuffleInPlace(byPile[3], rng), TIER_SLOTS),
    rare: makeDeck('rare', shuffleInPlace(byPile.rare, rng), SPECIAL_SLOTS),
    legendary: makeDeck('legendary', shuffleInPlace(byPile.legendary, rng), SPECIAL_SLOTS),
  };

  return {
    players: opts.players.map(makePlayer),
    currentPlayerIndex: 0,
    tokenPool: makeTokenPool(playerCount),
    decks,
    turnNumber: 1,
    roundStartIndex: 0,
    lastProgressTurn: 1,
    config,
    endTriggeredByPlayerIndex: null,
    isGameOver: false,
    awaitingDiscard: false,
    awaitingEvolve: false,
    rngSeed: opts.seed,
    log: [],
  };
}
