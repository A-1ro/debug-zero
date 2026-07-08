import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { preCardSetNumber, applyOperation, newEventId } from "../_utils";

/**
 * Control-Add strategy effect handler.
 * Trigger: on_card_played_by_other
 *
 * Changes the latest field card's operation to "add" and recalculates setNumber.
 * Increments usedStrategyCounts for "Control-Add".
 */
export function controlAdd(game: Game, ctx: EffectContext): GamePatch {
  const { actorId, triggerCard } = ctx;
  if (!triggerCard) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};
  // yaml: change_operation from=sub to=add — only sub cards may be flipped
  if (lastField.operation !== "sub") return {};

  const newOp = "add" as const;
  const prevSetNumber = preCardSetNumber(ctx, game.setNumber, lastField.operation, lastField.effectiveValue);
  const newSetNumber = applyOperation(prevSetNumber, newOp, lastField.effectiveValue);

  const updatedField = [...game.field];
  updatedField[lastIndex] = { ...lastField, operation: newOp };

  // usedStrategyCounts is incremented centrally by EffectResolver

  return {
    field:              updatedField,
    setNumber:          newSetNumber,
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "operation_changed",
      actorId,
      payload: {
        cardId:          lastField.cardId,
        from:            lastField.operation,
        to:              newOp,
        setNumberBefore: game.setNumber,
        setNumberAfter:  newSetNumber,
      },
    }],
  };
}
