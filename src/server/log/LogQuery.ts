import type { Game, EventLog, EventType, PlayerId } from "../../shared/types/domain";

// ============================================================
// LogQuery
// ============================================================

/**
 * LogQuery — read-only queries over a Game's event history.
 * All methods are pure functions (no side effects).
 */
export class LogQuery {
  /**
   * Return all events of a specific type.
   */
  static byType(game: Game, type: EventType): EventLog[] {
    return game.events.filter((e) => e.type === type);
  }

  /**
   * Return all events triggered by a specific actor.
   */
  static byActor(game: Game, actorId: PlayerId | "system" | "boss"): EventLog[] {
    return game.events.filter((e) => e.actorId === actorId);
  }

  /**
   * Return events after a given timestamp (exclusive).
   */
  static since(game: Game, timestampMs: number): EventLog[] {
    return game.events.filter((e) => e.timestamp > timestampMs);
  }

  /**
   * Return the last N events.
   */
  static last(game: Game, count: number): EventLog[] {
    return game.events.slice(-count);
  }

  /**
   * Return the most recent event matching a type, or undefined.
   */
  static latestByType(game: Game, type: EventType): EventLog | undefined {
    for (let i = game.events.length - 1; i >= 0; i--) {
      if (game.events[i].type === type) {
        return game.events[i];
      }
    }
    return undefined;
  }

  /**
   * Return all events between two indices (inclusive).
   */
  static slice(game: Game, from: number, to?: number): EventLog[] {
    return game.events.slice(from, to);
  }

  /**
   * Count events of a given type for a specific actor.
   * Useful for checking strategy usage counts from event history.
   */
  static countByActorAndType(
    game: Game,
    actorId: PlayerId | "system" | "boss",
    type: EventType
  ): number {
    return game.events.filter(
      (e) => e.actorId === actorId && e.type === type
    ).length;
  }
}
