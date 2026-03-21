import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { undoOperation, applyOperation, newEventId } from "../_utils";

/**
 * Control-Div strategy effect handler.
 * Trigger: on_card_played_by_other
 *
 * Changes the latest field card's operation to "div" and recalculates setNumber.
 * Division uses Math.ceil (consistent with ArithmeticJudge).
 * Applicable only when ActionValidator has confirmed the div constraint
 * (field[-2].rawValue === triggerCard.value).
 * Increments usedStrategyCounts for "Control-Div".
 */
export function controlDiv(game: Game, ctx: EffectContext): GamePatch {
  const { actorId, triggerCard } = ctx;
  if (!triggerCard) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};
  if (lastField.operation === "div") return {}; // No change needed

  const newOp = "div" as const;
  const prevSetNumber = undoOperation(game.setNumber, lastField.operation, lastField.effectiveValue);
  const newSetNumber = applyOperation(prevSetNumber, newOp, lastField.effectiveValue);

  const updatedField = [...game.field];
  updatedField[lastIndex] = { ...lastField, operation: newOp };

  const currentCounts = game.usedStrategyCounts[actorId] ?? {};
  const updatedCounts = {
    ...game.usedStrategyCounts,
    [actorId]: {
      ...currentCounts,
      "Control-Div": (currentCounts["Control-Div"] ?? 0) + 1,
    },
  };

  return {
    field:              updatedField,
    setNumber:          newSetNumber,
    usedStrategyCounts: updatedCounts,
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
