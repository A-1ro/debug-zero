import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";

/**
 * Hack-Forbidden bug effect handler.
 * Trigger: (suppression only — handler never called via EffectResolver)
 *
 * Suppresses the Hack strategy handler for the affected player.
 * Enforcement is in EffectResolver's strategy loop via the data-driven forbiddenBugStrategyMap (built from the ruleset invalidate_strategy + strategy_match constraints).
 *
 * Removal cost: HP -3.
 * (Cost is handled by GameEngine.applyRemoveBug via the bug's removalCost definition.)
 *
 * This handler is a no-op — suppression is in EffectResolver.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function hackForbidden(_game: Game, _ctx: EffectContext): GamePatch {
  return {};
}
