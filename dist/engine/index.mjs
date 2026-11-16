// 引擎公共入口。
export * from './types.mjs';
export { makeRng, shuffleInPlace,          } from './rng.mjs';
export {
  emptyColorVector,
  emptyPool,
  colorCostToVector,
  vectorToColorCost,
  totalTokens,
  sumCost,
  colorVectorMeets,
  clonePool,
} from './util.mjs';
export {
  computeBonuses,
  computeOwnedSpecies,
  computePoints,
  refreshPlayerDerived,
} from './derive.mjs';
export { resolveBuyCost, computePayment, canAfford, buildBuyAction } from './buy.mjs';
export { createGame, DEFAULT_CONFIG,                                      } from './setup.mjs';
export { legalMoves, legalEvolutions, canonicalDiscard, hasNoMoves } from './moves.mjs';
export { applyAction, passTurn, gameWinners } from './apply.mjs';
export { validateDeck } from './validate.mjs';
