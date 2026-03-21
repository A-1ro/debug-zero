import type { Game, PlayerId } from "../../shared/types/domain";

/**
 * Returns the next currentTurnIndex for the normal/showdown phase.
 * Skipping is not permitted — every player must take their turn in order.
 * Pure function with no side effects.
 */
export function nextTurnIndex(game: Game): number {
  const len = game.turnOrder.length;
  if (len === 0) return 0;
  return (game.currentTurnIndex + 1) % len;
}

/**
 * Returns the PlayerId whose turn it currently is in the normal/showdown phase.
 */
export function currentTurnPlayer(game: Game): PlayerId {
  return game.turnOrder[game.currentTurnIndex];
}

/**
 * Returns the next currentTurnIndex inside raidState.
 * Used during the raid phase player cycle.
 * Pure function with no side effects.
 */
export function nextRaidTurnIndex(
  currentTurnIndex: number,
  turnOrder: PlayerId[],
): number {
  const len = turnOrder.length;
  if (len === 0) return 0;
  return (currentTurnIndex + 1) % len;
}

/**
 * Returns the PlayerId whose turn it currently is in the raid phase.
 */
export function currentRaidTurnPlayer(game: Game): PlayerId | null {
  if (!game.raidState) return null;
  const { turnOrder, currentTurnIndex } = game.raidState;
  return turnOrder[currentTurnIndex] ?? null;
}
