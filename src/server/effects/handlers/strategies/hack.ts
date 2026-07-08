import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { preCardSetNumber, applyOperation, newEventId } from "../_utils";

/**
 * Hack strategy effect handler.
 * Trigger: on_card_played_by_other (even card only)
 *
 * Transfers ownership of the played field card to the Hack actor and
 * recalculates effectiveValue with the new owner's strategy (§8.4 Hack).
 * Only activates when triggerCard.rawValue is even.
 *
 * The Hack actor's strategy is Hack itself (one strategy per player), which
 * has no value modifier — so the recalculated effectiveValue is always
 * rawValue. When the previous owner's strategy had inflated the value
 * (e.g. Aggro's rawValue*2), setNumber is re-derived by undoing the old
 * effectiveValue and re-applying the new one.
 *
 * The transferred card's ownership affects showdown and raid phase outcomes.
 */
export function hack(game: Game, ctx: EffectContext): GamePatch {
  const { actorId, triggerCard } = ctx;
  if (!triggerCard) return {};

  // Only activates for even cards
  if (triggerCard.rawValue % 2 !== 0) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};
  // Already owned by actorId — no-op
  if (lastField.playerId === actorId) return {};

  const fromPlayer = lastField.playerId;

  // Recalculate effectiveValue for the new owner (Hack has no value modifier)
  const newEffectiveValue = lastField.rawValue;
  const valueChanged = lastField.effectiveValue !== newEffectiveValue;

  const updatedField = [...game.field];
  updatedField[lastIndex] = {
    ...lastField,
    playerId: actorId,
    effectiveValue: newEffectiveValue,
  };

  const patch: GamePatch = {
    field: updatedField,
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "card_stolen",
      actorId,
      payload: {
        cardId:     lastField.cardId,
        fromPlayer,
        toPlayer:   actorId,
        ...(valueChanged ? {
          oldEffectiveValue: lastField.effectiveValue,
          newEffectiveValue,
        } : {}),
      },
    }],
  };

  if (valueChanged) {
    // Undo the old effectiveValue and re-apply with the recalculated one
    const prevSetNumber = preCardSetNumber(ctx, game.setNumber, lastField.operation, lastField.effectiveValue);
    patch.setNumber = applyOperation(prevSetNumber, lastField.operation, newEffectiveValue);
  }

  return patch;
}
