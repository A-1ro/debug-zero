import type { Game, EventLog, EventId, EventType, PlayerId } from "../../shared/types/domain";
import type { GamePatch } from "../../shared/types/domain";

// ============================================================
// EventLogger
// ============================================================

/**
 * EventLogger — creates EventLog entries to be appended to a Game.
 *
 * Does NOT mutate Game directly. Returns a GamePatch with `appendEvents`
 * so callers can apply it via GameEngine.applyPatch (pure function pattern).
 */
export class EventLogger {
  /**
   * Create a patch that appends a single event to a game.
   */
  static log(params: {
    type:    EventType;
    actorId: PlayerId | "system" | "boss";
    payload: Record<string, unknown>;
  }): GamePatch {
    const event: EventLog = {
      id:        EventLogger.generateEventId(),
      timestamp: Date.now(),
      type:      params.type,
      actorId:   params.actorId,
      payload:   params.payload,
    };
    return { appendEvents: [event] };
  }

  /**
   * Create a patch that appends multiple events at once.
   */
  static logMany(
    events: Array<{
      type:    EventType;
      actorId: PlayerId | "system" | "boss";
      payload: Record<string, unknown>;
    }>
  ): GamePatch {
    // Each event gets its own timestamp to avoid LogQuery.since() boundary issues
    // when multiple events share the exact same millisecond.
    return {
      appendEvents: events.map((e) => ({
        id:        EventLogger.generateEventId(),
        timestamp: Date.now(),
        type:      e.type,
        actorId:   e.actorId,
        payload:   e.payload,
      })),
    };
  }

  /**
   * Extract only the events appended since a given event index.
   * Useful for sending only the newly-added events in action_result.
   */
  static getNewEvents(game: Game, priorEventCount: number): EventLog[] {
    return game.events.slice(priorEventCount);
  }

  private static generateEventId(): EventId {
    return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }
}
