import type { Room, SessionPlayer, PlayerId, StrategyId } from "../../shared/types/domain";

/**
 * Strategy visibility sanitizers (§spec: 戦略IDはセッション終了まで本人にのみ公開).
 *
 * The UI already renders "???" for other players, but the raw strategy ids were
 * being broadcast in room_updated / session_started / game_ended / state_sync —
 * trivially readable from DevTools, which defeats the Control-* counterplay.
 * These helpers mask everything except the viewer's own strategy. session_ended
 * intentionally does NOT mask (strategies are revealed at session end).
 */

/** Placeholder that keeps "selected" truthiness without leaking the id. */
export const MASKED_STRATEGY = "***" as StrategyId;

/** Return a copy of room with other players' selected strategies masked. */
export function sanitizeRoomFor(room: Room, viewerId: PlayerId): Room {
  if (!room.selectedStrategies) return room;
  const masked: Record<PlayerId, StrategyId> = {};
  for (const [pid, sid] of Object.entries(room.selectedStrategies)) {
    masked[pid as PlayerId] = pid === viewerId ? sid : MASKED_STRATEGY;
  }
  return { ...room, selectedStrategies: masked };
}

/** Return session players with other players' strategy ids masked. */
export function maskSessionPlayers(
  players: SessionPlayer[],
  viewerId: PlayerId
): SessionPlayer[] {
  return players.map((p) =>
    p.playerId === viewerId ? p : { ...p, strategyId: MASKED_STRATEGY }
  );
}
