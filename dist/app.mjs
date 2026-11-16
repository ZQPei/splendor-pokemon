import { CARDS } from './data/cards.mjs';
import { heuristicPolicy } from './ai/heuristic.mjs';
import { attachOnline, dismissRoomUrl, inviteFields, openOnline, sendRoomAction } from './online.mjs';
import {
  COLOR_ORDER, PAYABLE_ORDER, HAND_LIMIT, MAX_RESERVED, WIN_THRESHOLD, TAKE_TWO_MIN_PILE,
  applyAction, computePayment, createGame, emptyPool, gameWinners,
  legalEvolutions, legalMoves, makeRng, passTurn, refreshPlayerDerived, totalTokens,
} from './engine/index.mjs';

const colors = { red: '红球', blue: '蓝球', black: '黑球', pink: '粉球', yellow: '黄球', master: '大师球' };
const stages = { 1: '一阶', 2: '二阶', 3: '三阶', rare: '稀有', legendary: '传说' };
const byId = new Map(CARDS.map(card => [card.id, card]));
const variantsBySpecies = new Map();
for (const card of CARDS) {
  if (!variantsBySpecies.has(card.speciesId)) variantsBySpecies.set(card.speciesId, []);
  variantsBySpecies.get(card.speciesId).push(card);
}
const bySpecies = new Map([...variantsBySpecies].map(([id, cards]) => [id, cards[0]]));
const catalogSections = { normal: '进化链', rare: '稀有宝可梦', legendary: '传说宝可梦' };
const evolutionTargets = new Set(CARDS.map(card => card.evolvesToSpeciesId).filter(Boolean));
const families = [...bySpecies.values()]
  .filter(card => !evolutionTargets.has(card.speciesId))
  .sort((first, second) => first.dexId - second.dexId)
  .map(root => {
    const family = [];
    for (let card = root; card; card = bySpecies.get(card.evolvesToSpeciesId)) family.push(card);
    return family;
  });
const modes = { solo: '单人对战 · 电脑小茂', 2: '双人对战', 3: '三人对战', 4: '四人对战' };
const saveKey = 'splendor-pokemon.kanto.v1';
const screens = {
  home: document.querySelector('#home-screen'),
  catalog: document.querySelector('#catalog-screen'),
  game: document.querySelector('#game-screen'),
  online: document.querySelector('#online-screen'),
};
const search = document.querySelector('#card-search');
const modal = document.querySelector('#modal');
const market = document.querySelector('#market');
const trainers = document.querySelector('#trainers');
const supply = document.querySelector('#supply');
const team = document.querySelector('#team');
const status = document.querySelector('#announcement');
const chooseAI = heuristicPolicy();
const avatarIds = [25, 133, 4, 7];

let mode = 'solo';
const discovered = new Set();
let state = restore();
let localState = state;
let networkGame = false;
let remoteRoom;
let screen = 'home';
let catalogOrigin = 'home';
let catalogFilter = 'all';
let selected = emptyPool();
let teamTab = 'inventory';
let aiTimer;
let saved = true;

function start(nextMode) {
  mode = nextMode;
  const count = mode === 'solo' ? 2 : Number(mode);
  const players = Array.from({ length: count }, (_, index) => ({
    id: 'p' + index,
    name: mode === 'solo' ? ['你', '小茂'][index] : '训练家 ' + (index + 1),
    isAI: mode === 'solo' && index === 1,
  }));
  return createGame({ players, cards: CARDS, seed: crypto.getRandomValues(new Uint32Array(1))[0] });
}

function restore() {
  try {
    const data = JSON.parse(localStorage.getItem(saveKey));
    if (!data || !Object.hasOwn(modes, data.mode) || !Array.isArray(data.state?.players)) return null;
    for (const player of data.state.players) refreshPlayerDerived(player);
    mode = data.mode;
    for (const species of data.discovered ?? []) if (bySpecies.has(species)) discovered.add(species);
    return data.state;
  } catch {
    return null;
  }
}

function save() {
  try {
    localStorage.setItem(saveKey, JSON.stringify({ mode, state, discovered: [...discovered] }));
    saved = true;
  } catch {
    saved = false;
  }
}

const player = () => state.players[state.currentPlayerIndex];
const isHuman = () => screen === 'game' && !state.isGameOver &&
  (networkGame ? player().id === remoteRoom.you : !player().isAI);
const mainAction = () => isHuman() && !state.awaitingDiscard && !state.awaitingEvolve;
const disabled = condition => condition ? ' disabled' : '';
const esc = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);
const artwork = dexId => './assets/' + dexId + '.webp';
const ball = color => '<i class="ball" data-color="' + color + '" aria-hidden="true"></i>';

function costs(values, emptyMessage = '免费') {
  const list = PAYABLE_ORDER.filter(color => values[color] > 0);
  if (!list.length) return '<span class="free">' + emptyMessage + '</span>';
  return '<span class="costs">' + list.map(color =>
    '<span class="cost" title="' + colors[color] + '" aria-label="' + colors[color] + ' ' + values[color] + '">' +
      ball(color) + '<span>' + values[color] + '</span></span>'
  ).join('') + '</span>';
}

function points(card) {
  return '<span class="score-badge" title="' + card.points + ' 分"><i aria-hidden="true">★</i>' + card.points + '</span>';
}

function renderHome() {
  const continueButton = document.querySelector('#continue-game');
  const newGame = document.querySelector('#home-new-game');
  const summary = document.querySelector('#home-save');
  continueButton.hidden = !state;
  summary.hidden = !state;
  newGame.className = state ? 'home-secondary' : 'primary';
  if (!state) return;
  continueButton.textContent = state.isGameOver ? '查看上局' : '继续对局';
  summary.textContent = modes[mode] + ' · ' + (state.isGameOver ? '已结算' : '第 ' + roundNumber() + ' 轮');
}

function showScreen(next, focus = true) {
  screen = next;
  clearTimeout(aiTimer);
  if (modal.open) modal.close();
  for (const [name, element] of Object.entries(screens)) element.hidden = name !== screen;
  document.querySelector('#game-tools').hidden = screen !== 'game';
  document.querySelector('[data-do="invite"]').hidden = !networkGame;
  document.querySelector('#game-tools [data-do="setup"]').hidden = networkGame;
  const networkStatus = document.querySelector('#network-status');
  networkStatus.dataset.active = String(networkGame);
  networkStatus.hidden = !networkGame || !networkStatus.textContent;
  if (screen === 'home') renderHome();
  if (screen === 'catalog') {
    document.querySelector('#catalog-back').textContent = catalogOrigin === 'game' ? '← 返回对局' : '← 返回主菜单';
    renderCatalog();
  }
  if (screen === 'game') render();
  window.scrollTo(0, 0);
  if (focus) screens[screen].querySelector('h1').focus({ preventScroll: true });
}

function receiveRoom(room) {
  remoteRoom = room;
  if (!room) {
    if (networkGame) {
      networkGame = false;
      state = localState;
      showScreen('online');
    }
    return;
  }
  if (!room.state || (!networkGame && screen !== 'online')) return;
  const finishedNow = room.state.isGameOver && !state?.isGameOver;
  const entered = !networkGame || screen === 'online';
  networkGame = true;
  state = room.state;
  selected = emptyPool();
  if (entered) {
    teamTab = 'inventory';
    showScreen('game');
  } else if (screen === 'game') {
    render();
  }
  if (finishedNow && screen === 'game' && !modal.open) showResults();
}

function catalogSpecies(card) {
  const variants = variantsBySpecies.get(card.speciesId);
  return '<div class="catalog-entry"><button type="button" class="catalog-species" data-do="catalog-card" data-id="' + card.speciesId +
    '" aria-label="查看' + card.nameZh + '，' + variants.length + ' 张卡"><span class="catalog-art" data-color="' +
    card.bonus + '"><img loading="lazy" src="' + artwork(card.dexId) + '" alt=""></span><strong>' +
    card.nameZh + '</strong></button><div class="catalog-inline-variants">' + variants.map((variant, index) =>
      '<section class="catalog-inline-variant" aria-label="' + card.nameZh + '卡牌 ' + (index + 1) + '">' +
      '<p class="catalog-variant-title">' + (variants.length > 1 ? '<span>卡 ' + (index + 1) + '</span>' : '') +
      '<strong>' + variant.points + ' 分</strong></p>' +
      '<p><span>捕捉</span>' + costs(variant.cost) + '</p><p><span>进化</span>' +
      (variant.evolveCost ? costs(variant.evolveCost) : '<span class="free">无</span>') + '</p></section>'
    ).join('') + '</div></div>';
}

function catalogFamily(cards) {
  return '<div class="catalog-family">' + cards.map(card =>
    catalogSpecies(card) + (card.evolvesToSpeciesId ? '<div class="catalog-step" aria-label="进化所需永久加成">' +
      '<span class="catalog-arrow" aria-hidden="true">→</span>' + costs(card.evolveCost) + '</div>' : '')
  ).join('') + '</div>';
}

function renderCatalog() {
  const query = search.value.trim().toLowerCase();
  const dexQuery = /^#?\d+$/.test(query) ? Number(query.replace('#', '')) : null;
  const filtered = families.filter(family =>
    (catalogFilter === 'all' || family[0].kind === catalogFilter) &&
    family.some(card => card.nameZh.includes(query) || card.name.toLowerCase().includes(query) || card.dexId === dexQuery)
  );
  for (const button of screens.catalog.querySelectorAll('[data-do="catalog-filter"]')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === catalogFilter));
  }
  document.querySelector('#catalog-result').textContent = query ?
    (filtered.length ? '找到 ' + filtered.length + ' 组相关卡牌' : '没有找到匹配的宝可梦。') : '';
  document.querySelector('#catalog-groups').innerHTML = Object.entries(catalogSections).map(([kind, title]) => {
    const group = filtered.filter(family => family[0].kind === kind);
    if (!group.length) return '';
    const className = kind === 'normal' ? 'catalog-chains' : 'catalog-singles';
    return '<section class="catalog-section" aria-label="' + title + '"><h2>' + title + '</h2><div class="' +
      className + '">' + group.map(family => kind === 'normal' ? catalogFamily(family) : catalogSpecies(family[0])).join('') +
      '</div></section>';
  }).join('');
}

function showCatalogCard(id) {
  const variants = variantsBySpecies.get(id);
  const card = variants[0];
  const type = stages[card.kind === 'normal' ? card.stage : card.kind];
  const next = bySpecies.get(card.evolvesToSpeciesId);
  const body = '<div class="catalog-detail-head"><img class="detail-art" alt="" data-color="' + card.bonus +
    '" src="' + artwork(card.dexId) + '"><div><p>' + type + '宝可梦 · ' + variants.length + ' 张卡</p>' +
    (next ? '<p>进化为 <strong>' + next.nameZh + '</strong></p><p>所需永久加成 ' + costs(card.evolveCost) + '</p>' : '') +
    '</div></div><div class="catalog-variants">' + variants.map((variant, index) =>
      '<section class="catalog-variant"><h3>卡牌 ' + (index + 1) + ' ' + points(variant) + '</h3>' +
      '<p>捕捉费用 ' + costs(variant.cost) + '</p><p>永久加成 ' + costs({ [variant.bonus]: variant.bonusAmount }) +
      '</p></section>'
    ).join('') + '</div>';
  showDialog(card.nameZh, body);
}

function cardButton(card, source = 'board') {
  if (!card) return '<div class="empty-card">已取完</div>';
  const affordable = source !== 'owned' && mainAction() && computePayment(player(), card);
  const buttonAttrs = 'type="button" data-do="card" data-id="' + card.id + '" data-source="' + source +
    '" aria-label="查看' + card.nameZh + '"';
  if (card.kind !== 'normal') {
    return '<button ' + buttonAttrs + ' class="special-card ' + card.kind + (affordable ? ' affords' : '') +
      '"><span class="special-info"><span class="special-kind">' + stages[card.kind] +
      '宝可梦</span><strong class="special-name">' + card.nameZh + '</strong><span class="special-meta">' +
      points(card) + costs(card.cost) + '</span></span><img alt="" class="special-art" src="' +
      artwork(card.dexId) + '"></button>';
  }
  return '<button ' + buttonAttrs + ' class="card' + (affordable ? ' affords' : '') +
    '"><span class="card-art" data-color="' + (card.bonus ?? 'master') + '">' + points(card) +
    (card.bonus ? '<span class="bonus" title="永久加成">' + ball(card.bonus) + '+' + card.bonusAmount + '</span>' : '') +
    '<img src="' + artwork(card.dexId) + '" alt=""></span><span class="card-copy"><strong class="card-name">' + card.nameZh +
    '</strong>' + (source === 'owned' ? '' : costs(card.cost)) + '</span></button>';
}

function renderMarket() {
  const decks = state.decks;
  const special = key => decks[key].faceUp[0] ? cardButton(decks[key].faceUp[0]) :
    '<div class="special-card ' + key + '"><span class="special-kind">' + stages[key] + '宝可梦已取完</span></div>';
  market.innerHTML = '<div class="specials">' + special('rare') + special('legendary') + '</div>' +
    [1, 2, 3].map(tier => {
      const deck = decks[tier];
      const drawCount = deck.drawPile.length;
      const canDraw = mainAction() && player().reserved.length < MAX_RESERVED && drawCount > 0;
      return '<section class="tier" data-tier="' + tier + '"><div class="tier-header"><div class="tier-title">' +
        '<span class="stage-icon" aria-hidden="true">' + tier + '</span><h2>' + stages[tier] +
        '宝可梦</h2></div><button type="button" class="deck" data-do="deck" data-id="' + tier +
        '" aria-label="从' + stages[tier] + '牌堆盲抽，剩余 ' + drawCount + ' 张"' + disabled(!canDraw) + '>' +
        '牌堆 · ' + drawCount + ' 张</button></div><div class="cards">' +
        deck.faceUp.map(card => cardButton(card)).join('') + '</div></section>';
    }).join('');
}

function renderTrainers() {
  trainers.innerHTML = '<div class="panel-heading"><h2>训练家</h2><span>终局门槛 ' + WIN_THRESHOLD +
    ' 分</span></div><div class="trainer-list">' +
    state.players.map((person, index) =>
      '<button type="button" data-do="trainer" data-id="' + index + '" class="trainer' +
      (state.currentPlayerIndex === index && !state.isGameOver ? ' active' : '') +
      '"><img class="avatar" alt="" src="' + artwork(avatarIds[index]) + '"><span><span class="who">' +
      esc(person.name) + (person.isAI ? ' · 电脑' : '') +
      (networkGame && person.id === remoteRoom.you ? ' · 你' : '') + '</span><span class="trainer-counts"><span>球 ' +
      totalTokens(person.tokens) + '</span><span>保留 ' + person.reserved.length + '</span><span>进化 ' +
      person.evolved.length + '</span></span></span><span class="trainer-points">' + person.points +
      ' <small>分</small></span></button>'
    ).join('') + '</div>';
}

function takeAction() {
  const chosen = COLOR_ORDER.filter(color => selected[color] > 0);
  if (chosen.length === 1 && selected[chosen[0]] === 2) return { type: 'TAKE_TWO', color: chosen[0] };
  const required = Math.min(3, COLOR_ORDER.filter(color => state.tokenPool[color] > 0).length);
  if (required > 0 && (chosen.length === required || (required === 2 && chosen.length === 1))) {
    return { type: 'TAKE_THREE', colors: chosen };
  }
  return null;
}

function renderSupply() {
  const discarding = isHuman() && state.awaitingDiscard;
  const evolving = isHuman() && state.awaitingEvolve;
  const pool = discarding ? player().tokens : state.tokenPool;
  const heading = discarding ? '归还精灵球' : evolving ? '回合末进化' : '公共精灵球';
  supply.setAttribute('aria-label', heading);
  const excess = totalTokens(player().tokens) - HAND_LIMIT;
  const grid = PAYABLE_ORDER.map(color => {
    const canSelect = pool[color] > 0 && (discarding || (mainAction() && color !== 'master'));
    const count = selected[color];
    return '<button type="button" class="bank-ball' + (count ? ' selected' : '') +
      '" data-do="ball" data-color="' + color + '" aria-pressed="' + Boolean(count) +
      '" aria-label="' + colors[color] + '，共有 ' + pool[color] + (count ? '，已选 ' + count : '') + '"' +
      disabled(!canSelect) + '>' + ball(color) + '<span>' + colors[color] + '</span><b>' + pool[color] + '</b>' +
      (count ? '<em>' + (discarding ? '−' : '+') + count + '</em>' : '') + '</button>';
  }).join('');
  let controls = '';
  if (discarding) {
    controls = '<p>最多持有 ' + HAND_LIMIT + ' 个球。点选要归还的球，已选 ' + totalTokens(selected) +
      ' / ' + excess + '。</p><button class="primary" type="button" data-do="discard"' +
      disabled(totalTokens(selected) !== excess) + '>确认归还</button>';
  } else if (evolving) {
    const actions = legalEvolutions(state, player());
    controls = '<p>可选择一次免费进化，或直接结束回合。</p><div class="evolution-list">' +
      actions.map(action => '<button class="secondary" type="button" data-do="evolve" data-from="' +
        action.fromCardId + '" data-id="' + action.toCardId + '">' + byId.get(action.fromCardId).nameZh +
        ' → ' + byId.get(action.toCardId).nameZh + '</button>').join('') +
      '</div><button class="primary" type="button" data-do="end-turn">跳过进化</button>';
  } else if (mainAction()) {
    if (!legalMoves(state).length) {
      controls = '<p>当前没有可执行的动作。</p><button type="button" class="primary" data-do="pass">结束回合</button>';
    } else {
      const required = Math.min(3, COLOR_ORDER.filter(color => pool[color] > 0).length);
      const guidance = required > 0 ?
        '选 ' + (required === 2 ? '1–2' : required) + ' 个不同色，或在库存至少 4 个时连点同色取 2 个。' :
        '普通球已取完。请选择一张卡进行捕捉或保留。';
      controls = '<p>' + guidance + '</p><button class="primary" type="button" data-do="take"' +
        disabled(!takeAction()) + '>确认拿取' + (totalTokens(selected) ? '（' + totalTokens(selected) + '）' : '') + '</button>';
    }
  } else if (state.isGameOver) {
    controls = '<button class="secondary" type="button" data-do="results">查看结算</button>';
  }
  supply.innerHTML = '<div class="panel-heading"><h2>' + heading + '</h2><span>' +
    (discarding ? '当前 ' + totalTokens(pool) + ' / ' + HAND_LIMIT : evolving ? '可选动作' : '大师球来自保留') +
    '</span></div>' + (evolving ? '' : '<div class="bank-grid">' + grid + '</div>') +
    (controls ? '<div class="bank-actions">' + controls + '</div>' : '');
}

function inventoryGrid(person) {
  return '<div class="inventory">' + PAYABLE_ORDER.map(color =>
    '<span class="inventory-cell" title="' + colors[color] + '">' + ball(color) +
    '<span aria-label="' + colors[color] + ' ' + person.tokens[color] + '">' + person.tokens[color] + '</span>' +
    '<small aria-label="永久加成 ' + (person.bonuses[color] ?? 0) + '">' +
    (person.bonuses[color] ? '+' + person.bonuses[color] : '—') + '</small></span>'
  ).join('') + '</div><p class="inventory-legend">上方为持有球数，下方为永久加成</p>';
}

function renderTeam() {
  const me = networkGame ? state.players.find(person => person.id === remoteRoom.you) :
    state.isGameOver || mode === 'solo' ? state.players[0] : player();
  const tabs = [['inventory', '精灵球'], ['owned', '已捕捉 ' + me.purchased.length]];
  if (!me.isAI) tabs.push(['reserved', '已保留 ' + me.reserved.length]);
  const list = teamTab === 'owned' ? me.purchased : me.reserved;
  const hand = list.length ? '<div class="hand-grid">' + list.map(card => cardButton(card, teamTab)).join('') +
    '</div>' : '<p class="empty-state">' + (teamTab === 'owned' ? '还没有捕捉宝可梦。' : '还没有保留卡牌。') + '</p>';
  const history = state.log.slice(-8).reverse();
  const wasOpen = team.querySelector('details')?.open;
  team.innerHTML = '<div class="panel-heading"><h2>' + (networkGame || me.name === '你' ? '我的队伍' : esc(me.name) + '的队伍') +
    '</h2><span>' + totalTokens(me.tokens) + ' / ' + HAND_LIMIT + ' 球</span></div><div class="team-tabs">' +
    tabs.map(([id, label]) => '<button class="tab' + (teamTab === id ? ' active' : '') +
      '" type="button" data-do="tab" data-id="' + id + '" aria-pressed="' + (id === teamTab) + '">' +
      label + '</button>').join('') + '</div><div class="team-content">' +
    (teamTab === 'inventory' ? inventoryGrid(me) : hand) + '</div>' +
    (history.length ? '<details class="history"' + (wasOpen ? ' open' : '') + '><summary>对局记录</summary><ol>' +
      history.map(line => '<li>' + esc(line) + '</li>').join('') + '</ol></details>' : '');
}

function roundNumber() {
  return Math.floor((state.turnNumber - (state.isGameOver ? 2 : 1)) / state.players.length) + 1;
}

function render() {
  document.querySelector('#match-summary').textContent = (networkGame ? '联机 · ' + state.players.length + ' 人' : modes[mode]) +
    ' · 第 ' + roundNumber() + ' 轮' + (networkGame ? '' : saved ? ' · 自动保存' : ' · 存档不可用');
  const endRound = state.endTriggeredByPlayerIndex !== null;
  const label = state.isGameOver ? '对局结束' : (endRound ? '最后一轮 · ' : '') +
    (player().isAI ? player().name + '思考中' :
      (networkGame ? player().id === remoteRoom.you : player().name === '你') ? '轮到你了' : '轮到' + player().name);
  document.querySelector('#turn-state').innerHTML = '<span class="turn-pill' +
    (endRound ? ' final' : '') + '">' + esc(label) + '</span>';
  renderMarket();
  renderTrainers();
  renderSupply();
  renderTeam();
  scheduleAI();
}

function scheduleAI() {
  clearTimeout(aiTimer);
  if (screen !== 'game' || networkGame || state.isGameOver || !player().isAI) return;
  aiTimer = setTimeout(() => {
    const moves = legalMoves(state);
    const rng = makeRng((state.rngSeed + state.turnNumber) >>> 0);
    if (!moves.length) commit(null);
    else commit(chooseAI(moves, state, rng));
  }, 620);
}

function describeAction(action) {
  const { name } = player();
  switch (action?.type) {
    case 'TAKE_THREE': return name + '拿取 ' + action.colors.map(color => colors[color]).join('、');
    case 'TAKE_TWO': return name + '拿取 2 个' + colors[action.color];
    case 'RESERVE': return name + '保留 ' + (action.source.kind === 'board' ?
      byId.get(action.source.cardId).nameZh : '一张' + stages[action.source.pile] + '牌') +
      (state.tokenPool.master ? '，获得 1 个大师球' : '');
    case 'DISCARD': return name + '归还 ' + totalTokens(action.tokens) + ' 个球';
    default: return '';
  }
}

function commit(action) {
  const message = describeAction(action);
  const before = state;
  try {
    state = action ? applyAction(state, action) : passTurn(state);
  } catch (error) {
    status.textContent = error.message;
    return;
  }
  if (message) state.log.splice(before.log.length, 0, message);
  selected = emptyPool();
  if (mode !== 'solo' && state.currentPlayerIndex !== before.currentPlayerIndex) teamTab = 'inventory';
  if (action?.type === 'RESERVE' && !before.players[before.currentPlayerIndex].isAI &&
      (mode === 'solo' || state.currentPlayerIndex === before.currentPlayerIndex)) teamTab = 'reserved';
  if (state.isGameOver) {
    for (const person of state.players.filter(entry => !entry.isAI)) {
      for (const card of [...person.purchased, ...person.evolved]) discovered.add(card.speciesId);
    }
  }
  localState = state;
  save();
  status.textContent = message || state.log.at(-1) || '';
  render();
  if (state.isGameOver && !modal.open) showResults();
}

function selectBall(color) {
  if (state.awaitingDiscard) {
    const limit = Math.min(player().tokens[color], totalTokens(player().tokens) - HAND_LIMIT);
    selected[color] = (selected[color] + 1) % (limit + 1);
  } else {
    const count = totalTokens(selected);
    if (selected[color] === 1 && count === 1 && state.tokenPool[color] >= TAKE_TWO_MIN_PILE) {
      selected[color] = 2;
    } else if (selected[color]) {
      selected[color] = 0;
    } else {
      const pairedColor = COLOR_ORDER.find(value => selected[value] === 2);
      if (pairedColor) selected[pairedColor] = 1;
      if (count < 3) selected[color] = 1;
    }
  }
  renderSupply();
  supply.querySelector('[data-color="' + color + '"]').focus({ preventScroll: true });
}

function showDialog(title, body, buttons = '') {
  modal.innerHTML = '<div class="modal-head"><h2 id="modal-title">' + esc(title) +
    '</h2><button class="close" type="button" data-do="close" aria-label="关闭">×</button></div>' +
    body + (buttons ? '<div class="modal-actions">' + buttons + '</div>' : '');
  if (!modal.open) modal.showModal();
}

function showCard(card, source) {
  const me = player();
  const bought = source === 'owned';
  const canAct = mainAction() && !bought;
  const payable = canAct && computePayment(me, card);
  const canReserve = canAct && source === 'board' && card.kind === 'normal' && me.reserved.length < MAX_RESERVED;
  const next = bySpecies.get(card.evolvesToSpeciesId);
  const benefits = (card.bonus ? '<p>永久加成 ' +
    costs({ [card.bonus]: card.bonusAmount }) + '</p>' : '') +
    (next && card.evolveCost ? '<p>可进化为 <strong>' + next.nameZh + '</strong><br>所需永久加成 ' +
      costs(card.evolveCost) + '</p>' : '');
  const adjustable = payable && me.tokens.master > payable.payment.master && COLOR_ORDER.some(color => payable.payment[color] > 0);
  const paymentInputs = adjustable ? '<details class="payment"><summary>选择用大师球替代</summary><div>' +
    COLOR_ORDER.filter(color => payable.payment[color] > 0).map(color =>
      '<label>' + ball(color) + '<span>' + colors[color] + '</span><input class="pay-input" type="number" ' +
      'data-color="' + color + '" min="0" max="' + payable.payment[color] + '" value="' +
      payable.payment[color] + '" required></label>'
    ).join('') + '</div></details>' : '';
  const body = '<div class="card-detail"><img class="detail-art" alt="" data-color="' +
    (card.bonus ?? 'master') + '" src="' + artwork(card.dexId) + '"><div>' +
    '<p>' + stages[card.kind === 'normal' ? card.stage : card.kind] + '宝可梦　' + points(card) + '</p>' +
    '<p>捕捉费用 ' + costs(card.cost) + '</p>' + benefits + '</div></div>' +
    (canAct ? '<p class="guidance" id="payment-summary">' + (payable ? '本次支付 ' + costs(payable.payment) :
      '当前持有的精灵球和永久加成不足。') + '</p>' + paymentInputs : '') +
    (card.kind === 'normal' ? '<button class="catalog-shortcut" type="button" data-do="catalog" data-id="' +
      card.speciesId + '">查看完整进化链 →</button>' : '');
  const reserve = canReserve ? '<button class="secondary" type="button" data-do="reserve" data-id="' +
    card.id + '">保留' + (state.tokenPool.master ? '并拿大师球' : '') + '</button>' : '';
  const capture = canAct ? '<button class="primary" type="button" data-do="capture" data-id="' + card.id +
    '" data-source="' + source + '"' + disabled(!payable) + '>捕捉</button>' : '';
  showDialog(card.nameZh, body, reserve + capture);
}

function modalPayment(card) {
  const payable = computePayment(player(), card);
  if (!payable) return null;
  const payment = payable.payment;
  for (const input of modal.querySelectorAll('.pay-input')) {
    if (!input.validity.valid) return null;
    const color = input.dataset.color;
    payment.master += payment[color] - input.valueAsNumber;
    payment[color] = input.valueAsNumber;
  }
  return payment.master <= player().tokens.master ? payment : null;
}

function showTrainer(index) {
  const person = state.players[index];
  const roster = person.purchased.map(card => cardButton(card, 'owned')).join('');
  showDialog(person.name === '你' ? '我的队伍' : person.name + '的队伍', inventoryGrid(person) +
    (roster ? '<div class="hand-grid">' + roster + '</div>' : '<p class="empty-state">还没有捕捉宝可梦。</p>'));
}

function showDex() {
  const species = [...bySpecies.values()].sort((first, second) => first.dexId - second.dexId);
  showDialog('宝可梦图鉴', '<p class="guidance">已收集 ' + discovered.size + ' / ' + species.length +
    '。每局结算时登记捕捉和进化过的宝可梦。</p><div class="dex-grid">' +
    species.map(card => '<div class="dex-entry' + (discovered.has(card.speciesId) ? ' discovered' : '') + '">' +
      '<img alt="" loading="lazy" src="' + artwork(card.dexId) + '"><span>' +
      (discovered.has(card.speciesId) ? card.nameZh : '未收集') + '</span></div>'
    ).join('') + '</div>');
}

function showDeck(tier) {
  showDialog('保留一张' + stages[tier] + '牌',
    '<p>盲抽这叠牌最上方的一张，放入你的保留区。' +
    (state.tokenPool.master ? '同时获得 1 个大师球。' : '大师球库存为空。') + '</p>',
    '<button class="secondary" type="button" data-do="close">取消</button>' +
    '<button class="primary" type="button" data-do="blind" data-id="' + tier + '">确认盲抽</button>');
}

function showSetup() {
  const options = [['solo', '单人对战 · 电脑小茂'], ['2', '双人同屏'], ['3', '三人同屏'], ['4', '四人同屏']];
  showDialog('新对局', '<p>' + (state ? '开始新对局会替换当前自动存档。' : '选择对战模式。') + '</p><div class="setup-options">' +
    options.map(([id, label]) => '<label><input type="radio" name="mode" value="' + id + '"' +
      (mode === id ? ' checked' : '') + '>' + label + '</label>').join('') + '</div>',
    '<button class="secondary" type="button" data-do="close">取消</button>' +
    '<button class="primary" type="button" data-do="start">开始对局</button>');
}

function showRules() {
  showDialog('游戏规则',
    '<div class="rules"><ol>' +
    '<li>回合内选一种行动。拿 3 个不同颜色的普通球。库存仅剩 1–2 色时，可以拿 1 个球或 2 个不同色的球。也可以从至少有 4 个的颜色堆拿 2 个。</li>' +
    '<li>也可以保留一张普通卡，或从普通牌堆盲抽。最多保留 3 张，库存有大师球时获得 1 个。</li>' +
    '<li>点击展示区或自己保留区的卡可以捕捉。队伍的永久加成抵扣同色费用，大师球可以补普通球缺口。稀有和传说卡上标明的大师球费用必须用大师球支付。</li>' +
    '<li>如超过 10 个球，先归还多出的球。回合末最多进化一次，需满足永久加成条件，进化目标须在展示区或自己的保留区。</li>' +
    '<li>有人达到 18 分后，完成本轮再结算。分数相同时按进化次数、正面朝上的已捕捉卡数依次比较。</li>' +
    '</ol><p class="guidance">进度保存在当前浏览器。<br>插画来自 ' +
    '<a href="https://github.com/PokeAPI/sprites" target="_blank" rel="noopener">PokéAPI 图库</a>。</p></div>');
}

function showResults() {
  const winners = gameWinners(state);
  const names = winners.map(person => esc(person.name)).join('、');
  const title = winners.length > 1 ? '对局平局' : winners[0].name === '你' ? '你赢了' : winners[0].name + '获胜';
  const scores = state.players.map(person => '<li>' + esc(person.name) + ' · ' +
    person.points + ' 分 · 进化 ' + person.evolved.length + ' 次</li>').join('');
  showDialog(title, '<div class="rules"><p>' + names + '以 ' + winners[0].points +
    ' 分结束对局。</p><ol>' + scores + '</ol></div>',
    networkGame ? '<button class="primary" type="button" data-do="new-room">创建新房间</button>' :
      '<button class="primary" type="button" data-do="setup">再玩一局</button>');
}

function play(action) {
  if (modal.open) modal.close();
  if (networkGame) void sendRoomAction(action);
  else commit(action);
}

modal.addEventListener('input', event => {
  if (!event.target.matches('.pay-input')) return;
  const button = modal.querySelector('[data-do="capture"]');
  const payment = modalPayment(byId.get(button.dataset.id));
  button.disabled = !payment;
  modal.querySelector('#payment-summary').innerHTML = payment ?
    '本次支付 ' + costs(payment) : '请调整支付数量，确保大师球足够。';
});

search.addEventListener('input', renderCatalog);

document.addEventListener('click', event => {
  const button = event.target.closest('button[data-do]');
  if (!button || button.disabled) return;
  const { do: command, id, source, color, from } = button.dataset;
  switch (command) {
    case 'home':
      if (networkGame) {
        networkGame = false;
        state = localState;
        selected = emptyPool();
        teamTab = 'inventory';
      }
      dismissRoomUrl();
      showScreen('home');
      return;
    case 'continue': if (state) showScreen('game'); return;
    case 'online':
      showScreen('online');
      void openOnline();
      return;
    case 'new-room':
      networkGame = false;
      state = localState;
      showScreen('online');
      void openOnline(null, true);
      return;
    case 'invite':
      showDialog('邀请链接', '<div class="invite-panel">' + inviteFields() + '</div>');
      return;
    case 'catalog':
      catalogOrigin = screen;
      catalogFilter = id ? 'normal' : 'all';
      search.value = id ? bySpecies.get(id).nameZh : '';
      showScreen('catalog');
      return;
    case 'back': showScreen(catalogOrigin); return;
    case 'catalog-card': showCatalogCard(id); return;
    case 'catalog-filter':
      catalogFilter = id;
      renderCatalog();
      return;
    case 'rules': showRules(); return;
    case 'dex': showDex(); return;
    case 'trainer': showTrainer(Number(id)); return;
    case 'setup': showSetup(); return;
    case 'results': if (state.isGameOver) showResults(); return;
    case 'close': modal.close(); return;
    case 'start': {
      const choice = modal.querySelector('[name="mode"]:checked')?.value;
      if (!Object.hasOwn(modes, choice)) return;
      state = start(choice);
      localState = state;
      selected = emptyPool();
      teamTab = 'inventory';
      save();
      showScreen('game');
      return;
    }
    case 'card': showCard(byId.get(id), source); return;
    case 'tab':
      teamTab = id;
      renderTeam();
      team.querySelector('[data-id="' + id + '"]').focus({ preventScroll: true });
      return;
  }
  if (!isHuman()) return;
  if (command === 'ball' && (mainAction() || state.awaitingDiscard)) selectBall(color);
  if (command === 'discard' && state.awaitingDiscard) play({ type: 'DISCARD', tokens: selected });
  if (command === 'evolve' && state.awaitingEvolve) play({ type: 'EVOLVE', fromCardId: from, toCardId: id });
  if (command === 'end-turn' && state.awaitingEvolve) play({ type: 'END_TURN' });
  if (!mainAction()) return;
  switch (command) {
    case 'deck': showDeck(Number(id)); break;
    case 'blind': play({ type: 'RESERVE', source: { kind: 'deck', pile: Number(id) } }); break;
    case 'reserve': play({ type: 'RESERVE', source: { kind: 'board', cardId: id } }); break;
    case 'take': {
      const action = takeAction();
      if (action) play(action);
      break;
    }
    case 'pass': if (!legalMoves(state).length) play(null); break;
    case 'capture': {
      const payment = modalPayment(byId.get(id));
      if (payment) play({ type: 'BUY', source: { kind: source, cardId: id }, payment });
      break;
    }
  }
});

document.querySelector('#catalog-total').textContent =
  bySpecies.size + ' 种宝可梦 · ' + CARDS.length + ' 张卡 · 箭头旁为进化所需的永久加成';
attachOnline(receiveRoom);
const params = new URLSearchParams(location.search);
if (params.has('room') || params.has('online')) {
  showScreen('online', false);
  void openOnline(params.get('room'));
} else {
  showScreen('home', false);
}
