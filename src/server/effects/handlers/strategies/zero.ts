import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { newEventId } from "../_utils";

/**
 * Zero strategy effect handler.
 * Trigger: on_game_start
 *
 * Draws one 0-value card from the deck and adds it to the actor's hand.
 *
 * Invalidation: if 2+ players selected Zero, the session service should
 * record strategy_invalidated events and NOT call this handler. The handler
 * itself assumes it has already been cleared for activation.
 */
export function zero(game: Game, ctx: EffectContext): GamePatch {
  const { actorId } = ctx;

  // Find the first 0-value card in the deck (cardId format: "0-NNN")
  const zeroCardIndex = game.deck.findIndex(cardId => cardId.startsWith("0-"));
  if (zeroCardIndex === -1) return {}; // No 0-card in deck

  const zeroCardId = game.deck[zeroCardIndex];
  const newDeck = [...game.deck.slice(0, zeroCardIndex), ...game.deck.slice(zeroCardIndex + 1)];
  const newHand = [...(game.hands[actorId] ?? []), zeroCardId];

  return {
    deck:  newDeck,
    hands: { ...game.hands, [actorId]: newHand },
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "card_drawn",
      actorId,
      payload: { cardId: zeroCardId, reason: "zero_strategy" },
    }],
  };
}
