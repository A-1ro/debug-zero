import type { Game, PlayerId, RaidState } from "../../shared/types/domain";

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
 * The player who is on the clock in the raid phase. `RaidState.turnOrder`
 * holds only the players (boss excluded, owner ruling D3); the boss acts after
 * every player has acted (bossTurn) and when choosing the round bug
 * (awaitingBugChoice). Both cases resolve to the boss player.
 */
export function raidActor(rs: RaidState): PlayerId {
  if (rs.awaitingBugChoice || rs.bossTurn) return rs.bossPlayerId;
  return rs.turnOrder[rs.currentTurnIndex];
}

/**
 * Projection of the raid rotation for client/bot-facing messages: the boss is
 * appended after the players so that `turnOrder[currentTurnIndex]` always names
 * the current actor (boss included), even though RaidState.turnOrder itself
 * excludes the boss. Used to fill server:action_result during the raid phase.
 */
export function raidTurnView(rs: RaidState): { turnOrder: PlayerId[]; currentTurnIndex: number } {
  const turnOrder = [...rs.turnOrder, rs.bossPlayerId];
  const currentTurnIndex =
    rs.awaitingBugChoice || rs.bossTurn ? rs.turnOrder.length : rs.currentTurnIndex;
  return { turnOrder, currentTurnIndex };
}

/**
 * Returns the PlayerId whose turn it currently is in the raid phase.
 */
export function currentRaidTurnPlayer(game: Game): PlayerId | null {
  if (!game.raidState) return null;
  return raidActor(game.raidState) ?? null;
}
