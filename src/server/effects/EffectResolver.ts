import type {
  Game,
  GamePatch,
  PlayerId,
  StrategyId,
  BugId,
  EventLog,
  EventId,
} from "../../shared/types/domain";
import type { PendingIntervention } from "../../shared/types/domain";
import type { EffectContext } from "../../shared/types/effects";
import type { TriggerCondition, RuleSet } from "../../shared/types/rules";
import type { EffectRegistry } from "./EffectRegistry";
import { RULE_EFFECT_UNREGISTERED } from "../../shared/constants";
import { applyPatch } from "../game/GameEngine";

// ============================================================
// Forbidden bug → blocked strategy mapping (data-driven, D8/D12)
// ============================================================

/**
 * Builds the "Forbidden bug ID → suppressed strategy IDs" map from the ruleset
 * instead of a hardcoded table (D8/D12): a bug suppresses a strategy when the
 * bug's effect action is `invalidate_strategy` and it carries a `strategy_match`
 * constraint naming that strategy. Control-Forbidden lists all four Control
 * strategies in `rules/basic.yaml`, so it suppresses Control-Add/Sub/Mul/Div.
 * When one of these bugs is active (residualBugs), the corresponding strategy
 * handlers are skipped and a strategy_invalidated event is recorded.
 */
function forbiddenBugStrategyMap(ruleSet: RuleSet): Record<BugId, StrategyId[]> {
  const map: Record<BugId, StrategyId[]> = {};
  for (const bug of ruleSet.bugs) {
    if (bug.effect.action.type !== "invalidate_strategy") continue;
    const ids = (bug.effect.constraints ?? [])
      .filter((c): c is { type: "strategy_match"; strategyId: StrategyId } => c.type === "strategy_match")
      .map(c => c.strategyId);
    if (ids.length > 0) map[bug.id] = ids;
  }
  return map;
}

function isForbiddenStrategy(
  strategyId: StrategyId,
  residualBugs: BugId[],
  ruleSet: RuleSet,
): boolean {
  const map = forbiddenBugStrategyMap(ruleSet);
  for (const [bugId, strategies] of Object.entries(map)) {
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
      if (isForbiddenStrategy(strategyId, current.residualBugs, ctx.ruleSet)) {
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
    const forbiddenMap = forbiddenBugStrategyMap(ctx.ruleSet);
    for (const bugId of current.residualBugs) {
      // Forbidden-type bugs are handled in ActionValidator / strategy suppression above
      if (bugId in forbiddenMap) continue;

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

  /**
   * A1 (optional interventions): list the players whose on_card_played_by_other
   * strategy COULD activate right now — trigger matches, usage limit not
   * reached, not suppressed by a Forbidden bug, and the handler would actually
   * do something (dry-run returns a non-empty patch, so parity/from-operation
   * conditions are honored without duplicating handler logic).
   *
   * Candidates are returned in resolution-priority order: turn order starting
   * from the player after the actor (detail-design §8.3 — the doc fixes
   * "actor's effect → others' interventions" but not the order among multiple
   * others; turn order from the actor's next seat is the adopted ruling).
   *
   * Note: unlike the legacy auto-resolution, Forbidden-suppressed strategies
   * do NOT emit strategy_invalidated here — a candidate check is not an
   * activation attempt, and emitting would leak a hidden strategy.
   */
  collectInterventionCandidates(
    game: Game,
    ctx: EffectContext,
    playerStrategies: Record<PlayerId, StrategyId>,
  ): PendingIntervention["candidates"] {
    const candidates: PendingIntervention["candidates"] = [];

    for (const [playerId, strategyId] of Object.entries(playerStrategies)) {
      if (!shouldActivateForPlayer(playerId, "on_card_played_by_other", ctx.actorId)) continue;

      const strategyDef = ctx.ruleSet.strategies.find(s => s.id === strategyId);
      if (!strategyDef) continue;
      if (strategyDef.effect.trigger.type !== "on_card_played_by_other") continue;

      const limit = strategyDef.effect.usageLimit;
      const used = game.usedStrategyCounts[playerId]?.[strategyId] ?? 0;
      if (limit != null && used >= limit) continue;

      if (isForbiddenStrategy(strategyId, game.residualBugs, ctx.ruleSet)) continue;

      const handler = this.registry.get(strategyDef.effect.id);
      if (!handler) continue;

      // Dry-run: only offer when the effect would actually change something
      const patch = handler(game, { ...ctx, actorId: playerId });
      if (Object.keys(patch).length === 0) continue;

      candidates.push({ playerId, strategyId });
    }

    // Resolution priority: turn order starting after the actor
    const order = game.turnOrder;
    const start = order.indexOf(ctx.actorId);
    const priority = (pid: PlayerId): number => {
      const idx = order.indexOf(pid);
      if (idx === -1) return order.length; // not in turn order — last
      return (idx - start - 1 + order.length) % order.length;
    };
    candidates.sort((a, b) => priority(a.playerId) - priority(b.playerId));
    return candidates;
  }

  /**
   * A1: apply ONE accepted intervention. Runs the strategy handler with the
   * accepting player as actor and counts the usage centrally (only when the
   * effect actually did something — a no-op, e.g. the trigger card was already
   * removed by an earlier intervention, does not consume the usage right).
   */
  applyIntervention(
    game: Game,
    playerId: PlayerId,
    strategyId: StrategyId,
    ctx: EffectContext,
  ): GamePatch {
    const strategyDef = ctx.ruleSet.strategies.find(s => s.id === strategyId);
    if (!strategyDef) return {};

    // Defensive re-checks (state may have changed since the offer was made)
    const limit = strategyDef.effect.usageLimit;
    const used = game.usedStrategyCounts[playerId]?.[strategyId] ?? 0;
    if (limit != null && used >= limit) return {};
    if (isForbiddenStrategy(strategyId, game.residualBugs, ctx.ruleSet)) {
      return {
        appendEvents: [{
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "strategy_invalidated",
          actorId:   playerId,
          payload:   { strategyId, reason: "forbidden_bug" },
        }],
      };
    }

    const handler = this.registry.get(strategyDef.effect.id);
    if (!handler) return {};

    const patch = handler(game, { ...ctx, actorId: playerId });
    if (Object.keys(patch).length === 0) return {}; // no-op — usage not consumed

    return mergePatch(patch, {
      usedStrategyCounts: {
        ...game.usedStrategyCounts,
        [playerId]: {
          ...(game.usedStrategyCounts[playerId] ?? {}),
          [strategyId]: used + 1,
        },
      },
    });
  }
}
