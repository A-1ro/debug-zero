import type { Game, GamePatch } from "../../../../shared/types/effects";
import type { EffectContext } from "../../../../shared/types/effects";
import { preCardSetNumber, applyOperation } from "../_utils";

/**
 * Aggro strategy effect handler.
 * Trigger: on_card_played (actor's own card)
 *
 * Doubles the effectiveValue of the played card (rawValue * 2) and
 * recalculates setNumber accordingly.
 *
 * Note: GameEngine also pre-applies Aggro via isAggroActive in ArithmeticJudge.
 * This handler acts as a safety confirmation — if effectiveValue is already
 * doubled, it returns an empty patch (no-op).
 */
export function aggro(game: Game, ctx: EffectContext): GamePatch {
  const { triggerCard } = ctx;
  if (!triggerCard) return {};

  const lastIndex = game.field.length - 1;
  if (lastIndex < 0) return {};

  const lastField = game.field[lastIndex];
  if (lastField.cardId !== triggerCard.cardId) return {};

  const newEffectiveValue = lastField.rawValue * 2;
  // Engine already applied this — no-op if already correct
  if (lastField.effectiveValue === newEffectiveValue) return {};

  const prevSetNumber = preCardSetNumber(ctx, game.setNumber, lastField.operation, lastField.effectiveValue);
  const newSetNumber = applyOperation(prevSetNumber, lastField.operation, newEffectiveValue);

  const updatedField = [...game.field];
  updatedField[lastIndex] = { ...lastField, effectiveValue: newEffectiveValue };

  return {
    field:     updatedField,
    setNumber: newSetNumber,
  };
}
