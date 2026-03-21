import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { undoOperation, newEventId } from "../_utils";

/**
 * TrickStar strategy effect handler.
 * Trigger: on_card_played_by_other (odd card only)
 *
 * Removes the latest field card from the field, moves it to excludedCards,
 * and reverts the setNumber to what it was before the card was played.
 * Only activates when triggerCard.rawValue is odd.
 */
export function trickStar(game: Game, ctx: EffectContext): GamePatch {
  const { actorId, triggerCard } = ctx;
  if (!triggerCard) return {};

  // Only activates for odd cards
  if (triggerCard.rawValue % 2 === 0) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};

  // Reverse the arithmetic to recover the pre-card setNumber
  const prevSetNumber = undoOperation(game.setNumber, lastField.operation, lastField.effectiveValue);

  const newField = game.field.slice(0, lastIndex);
  const newExcluded = [...game.excludedCards, lastField.cardId];

  return {
    field:         newField,
    excludedCards: newExcluded,
    setNumber:     prevSetNumber,
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "card_removed_from_field",
      actorId,
      payload: {
        cardId:          lastField.cardId,
        originalPlayer:  lastField.playerId,
        setNumberBefore: game.setNumber,
        setNumberAfter:  prevSetNumber,
      },
    }],
  };
}
