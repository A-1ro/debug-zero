import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { newEventId } from "../_utils";

/**
 * Hack strategy effect handler.
 * Trigger: on_card_played_by_other (even card only)
 *
 * Transfers ownership of the played field card to the Hack actor.
 * Only activates when triggerCard.rawValue is even.
 *
 * The transferred card's ownership affects showdown and raid phase outcomes.
 * setNumber is unchanged — only the card's playerId is updated.
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
  const updatedField = [...game.field];
  updatedField[lastIndex] = { ...lastField, playerId: actorId };

  return {
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
      },
    }],
  };
}
