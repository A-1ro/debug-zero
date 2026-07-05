import type {
  Game,
  GamePatch,
  PlayerId,
  StrategyId,
  BugId,
  EventLog,
  EventId,
} from "../../shared/types/domain";
import type { EffectContext } from "../../shared/types/effects";
import type { TriggerCondition } from "../../shared/types/rules";
import type { EffectRegistry } from "./EffectRegistry";
import { RULE_EFFECT_UNREGISTERED } from "../../shared/constants";
import { applyPatch } from "../game/GameEngine";

// ============================================================
// Forbidden bug → blocked strategy mapping
// ============================================================

/**
 * Maps each Forbidden bug ID to the strategy IDs it suppresses.
 * When one of these bugs is active (residualBugs), the corresponding
 * strategy handlers are skipped and a strategy_invalidated event is recorded.
 */
const FORBIDDEN_BUG_STRATEGY_MAP: Record<BugId, StrategyId[]> = {
  "Aggro-Forbidden":     ["Aggro"],
  "Control-Forbidden":   ["Control-Add", "Control-Sub", "Control-Mul", "Control-Div"],
  "Hack-Forbidden":      ["Hack"],
  "TrickStar-Forbidden": ["TrickStar"],
};

function isForbiddenStrategy(strategyId: StrategyId, residualBugs: BugId[]): boolean {
  for (const [bugId, strategies] of Object.entries(FORBIDDEN_BUG_STRATEGY_MAP)) {
    if (residualBugs.includes(bugId) && strategies.includes(strategyId)) {
      return true;
    }
  }
  return false;
}

// ============================================================
// Trigger activation helpers
// ============================================================

/**
 * Determines whether a given player's strategy should activate
 * for a particular trigger type, given who the card-playing actor is.
 */
function shouldActivateForPlayer(
  playerId: PlayerId,
  triggerType: TriggerCondition["type"],
  actorId: PlayerId,
): boolean {
  switch (triggerType) {
    case "on_card_played":
      // Only the player who played the card activates their own strategy
      return playerId === actorId;
    case "on_card_played_by_other":
      // All OTHER players may activate their strategies
      return playerId !== actorId;
    case "on_game_start":
    case "on_round_start":
    case "on_turn_start":
    case "always":
      return true;
  }
}

// ============================================================
// Patch merge helper
// ============================================================

function mergePatch(base: GamePatch, patch: GamePatch): GamePatch {
  const result = { ...base, ...patch };
  // appendEvents must be accumulated, not replaced
  if (base.appendEvents || patch.appendEvents) {
    result.appendEvents = [
      ...(base.appendEvents ?? []),
      ...(patch.appendEvents ?? []),
    ];
  }
  return result;
}

function newEventId(): EventId {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================
// EffectResolver
// ============================================================

/**
 * Resolves all effect handlers for a given trigger type.
 *
 * Processing order (per detail-design ch8.3):
 *   1. Actor's strategy effect (on_card_played)
 *   2. Other players' strategy effects (on_card_played_by_other)
 *   3. Bug effects (non-Forbidden)
 *
 * Forbidden-type bugs (Aggro/Control/Hack/TrickStar-Forbidden) suppress the
 * corresponding strategy handlers and record strategy_invalidated events.
 * The Forbidden bugs themselves are enforced in ActionValidator.
 *
 * Unregistered effect IDs are skipped with a strategy_invalidated event.
 */
export class EffectResolver {
  constructor(private readonly registry: EffectRegistry) {}

  resolve(
    game: Game,
    triggerType: TriggerCondition["type"],
    ctx: EffectContext,
    playerStrategies: Record<PlayerId, StrategyId>,
  ): GamePatch {
    let accumulated: GamePatch = {};
    // Effects must see the results of previously-resolved effects in the same
    // resolution pass — otherwise two patches computed from the same base state
    // overwrite each other on merge (e.g. TrickStar's removal being undone by
    // a Control-* operation change).
    let current = game;
    const invalidatedEvents: EventLog[] = [];

    const apply = (patch: GamePatch): void => {
      if (Object.keys(patch).length === 0) return;
      accumulated = mergePatch(accumulated, patch);
      current = applyPatch(current, patch);
    };

    // ── Strategy effects ──────────────────────────────────────
    for (const [playerId, strategyId] of Object.entries(playerStrategies)) {
      if (!shouldActivateForPlayer(playerId, triggerType, ctx.actorId)) continue;

      const strategyDef = ctx.ruleSet.strategies.find(s => s.id === strategyId);
      if (!strategyDef) continue;
      if (strategyDef.effect.trigger.type !== triggerType) continue;

      // Usage limit (e.g. Control/Hack/TrickStar are once per game).
      // Counted centrally here — handlers must not touch usedStrategyCounts.
      const limit = strategyDef.effect.usageLimit;
      const used = current.usedStrategyCounts[playerId]?.[strategyId] ?? 0;
      if (limit != null && used >= limit) continue;

      // Check Forbidden bugs — skip and record invalidation event
      if (isForbiddenStrategy(strategyId, current.residualBugs)) {
        invalidatedEvents.push({
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "strategy_invalidated",
          actorId:   playerId,
          payload:   { strategyId, reason: "forbidden_bug" },
        });
        continue;
      }

      const handler = this.registry.get(strategyDef.effect.id);
      if (!handler) {
        // Handler not yet registered — record and skip
        invalidatedEvents.push({
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "strategy_invalidated",
          actorId:   playerId,
          payload:   {
            strategyId,
            effectId: strategyDef.effect.id,
            reason:   RULE_EFFECT_UNREGISTERED,
          },
        });
        continue;
      }

      // Execute handler with the activating player as actorId
      const handlerCtx: EffectContext = { ...ctx, actorId: playerId };
      const patch = handler(current, handlerCtx);
      if (Object.keys(patch).length === 0) continue; // no-op — does not consume usage

      apply(patch);
      // Central usage counting (only when the effect actually did something)
      apply({
        usedStrategyCounts: {
          ...current.usedStrategyCounts,
          [playerId]: {
            ...(current.usedStrategyCounts[playerId] ?? {}),
            [strategyId]: used + 1,
          },
        },
      });
    }

    // ── Bug effects (non-Forbidden bugs only) ─────────────────
    for (const bugId of current.residualBugs) {
      // Forbidden-type bugs are handled in ActionValidator / strategy suppression above
      if (bugId in FORBIDDEN_BUG_STRATEGY_MAP) continue;

      const bugDef = ctx.ruleSet.bugs.find(b => b.id === bugId);
      if (!bugDef) continue;
      // "always" bugs (e.g. Value-Corruption) fire once per played card;
      // matching them on every trigger type would double-fire per action
      const t = bugDef.effect.trigger.type;
      const matches = t === triggerType || (t === "always" && triggerType === "on_card_played");
      if (!matches) continue;

      const handler = this.registry.get(bugDef.effect.id);
      if (!handler) continue; // Unregistered bug handler — skip silently

      apply(handler(current, ctx));
    }

    // Append any invalidation events
    if (invalidatedEvents.length > 0) {
      accumulated = mergePatch(accumulated, { appendEvents: invalidatedEvents });
    }

    return accumulated;
  }
}
