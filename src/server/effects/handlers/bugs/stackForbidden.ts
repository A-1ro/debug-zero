import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";

/**
 * Stack-Forbidden bug effect handler.
 * Trigger: always
 *
 * Forbids playing a card whose value equals the last field card's rawValue.
 * Enforced in ActionValidator (returns ACTION_BUG_FORBIDDEN on stack attempt).
 *
 * Removal cost: HP -3 (raidState.playerHPs[actorId] -= 3).
 * (Cost is handled by GameEngine.applyRemoveBug via the bug's removalCost definition.)
 *
 * This handler is a no-op — enforcement is in ActionValidator.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function stackForbidden(_game: Game, _ctx: EffectContext): GamePatch {
  return {};
}
