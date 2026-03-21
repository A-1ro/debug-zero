import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { undoOperation, applyOperation, newEventId } from "../_utils";

const CORRUPTED_VALUE = 10;

/**
 * Value-Corruption bug effect handler.
 * Trigger: on_card_played
 *
 * Overrides the latest field card's effectiveValue to 10 and
 * recalculates setNumber accordingly.
 *
 * Note: for boss HP calculation in raid phase, rawValue is used (not effectiveValue),
 * so this handler only modifies effectiveValue and setNumber — not rawValue.
 *
 * Residual: if bossHP drops below 0 due to this bug, it is added to game.residualBugs
 * for the next game (handled by SessionService).
 *
 * Removal cost: HP -1 AND discard one hand card (composite cost).
 * (Cost is handled by GameEngine.applyRemoveBug via the bug's removalCost definition.)
 */
export function valueCorruption(game: Game, ctx: EffectContext): GamePatch {
  const { triggerCard } = ctx;
  if (!triggerCard) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};

  // No change needed if already corrupted
  if (lastField.effectiveValue === CORRUPTED_VALUE) return {};

  const prevSetNumber = undoOperation(game.setNumber, lastField.operation, lastField.effectiveValue);
  const newSetNumber = applyOperation(prevSetNumber, lastField.operation, CORRUPTED_VALUE);

  const updatedField = [...game.field];
  updatedField[lastIndex] = { ...lastField, effectiveValue: CORRUPTED_VALUE };

  return {
    field:     updatedField,
    setNumber: newSetNumber,
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "bug_activated",
      actorId:   "system",
      payload: {
        bugId:              "Value-Corruption",
        cardId:             lastField.cardId,
        oldEffectiveValue:  lastField.effectiveValue,
        newEffectiveValue:  CORRUPTED_VALUE,
        setNumberBefore:    game.setNumber,
        setNumberAfter:     newSetNumber,
      },
    }],
  };
}
