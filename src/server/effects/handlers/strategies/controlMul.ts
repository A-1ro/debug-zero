import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { preCardSetNumber, applyOperation, newEventId } from "../_utils";

/**
 * Control-Mul strategy effect handler.
 * Trigger: on_card_played_by_other
 *
 * Changes the latest field card's operation to "mul" and recalculates setNumber.
 * Applicable only when ActionValidator has confirmed the mul constraint
 * (field[-2].rawValue === triggerCard.value).
 * Increments usedStrategyCounts for "Control-Mul".
 */
export function controlMul(game: Game, ctx: EffectContext): GamePatch {
  const { actorId, triggerCard } = ctx;
  if (!triggerCard) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};
  // yaml: change_operation from=div to=mul — only div cards may be flipped
  // (div's play-time constraint equals mul's, so validity is preserved)
  if (lastField.operation !== "div") return {};

  const newOp = "mul" as const;
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
