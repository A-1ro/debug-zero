import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";

/**
 * Odd-Forbidden bug effect handler.
 * Trigger: always
 *
 * Forbids playing odd-value cards. Enforced in ActionValidator
 * (returns ACTION_BUG_FORBIDDEN when card.value % 2 !== 0).
 *
 * Removal cost: discard one even-value hand card to excludedCards.
 * (Cost is handled by GameEngine.applyRemoveBug via the bug's removalCost definition.)
 *
 * This handler is a no-op — enforcement is in ActionValidator.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function oddForbidden(_game: Game, _ctx: EffectContext): GamePatch {
  return {};
}
