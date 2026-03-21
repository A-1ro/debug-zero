import type { Card, FieldCard, Operation } from "../../shared/types/domain";
import { ACTION_INVALID_OPERATION } from "../../shared/constants";

// ============================================================
// Result types
// ============================================================

export interface ArithmeticJudgeResult {
  before:            number;
  after:             number;
  operation:         Operation;
  cardValue:         number;
  rawValue:          number;
  effectiveValue:    number;
  isImmediateDefeat: boolean;
}

export interface ArithmeticValidation {
  valid:      boolean;
  errorCode?: string;
}

// ============================================================
// Pure functions
// ============================================================

/**
 * Check whether an operation can be applied given the last field card.
 * - add / sub: always allowed
 * - mul / div: only when lastFieldCard.rawValue === card.value
 */
export function canApplyOperation(
  lastFieldCard: FieldCard | undefined,
  card: Card,
  operation: Operation,
): ArithmeticValidation {
  if (operation === "mul" || operation === "div") {
    if (!lastFieldCard || lastFieldCard.rawValue !== card.value) {
      return { valid: false, errorCode: ACTION_INVALID_OPERATION };
    }
  }
  return { valid: true };
}

/**
 * Resolve the arithmetic result of playing a card. Pure function.
 *
 * @param currentSetNumber - setNumber before this card is played
 * @param card             - the card being played
 * @param operation        - the chosen operation
 * @param lastFieldCard    - the last card on the field (undefined if field is empty)
 * @param isAggroActive    - whether Aggro effect is active for the actor
 */
export function resolve(
  currentSetNumber: number,
  card: Card,
  operation: Operation,
  lastFieldCard: FieldCard | undefined,
  isAggroActive: boolean,
): ArithmeticJudgeResult {
  const rawValue       = card.value;
  const effectiveValue = isAggroActive ? rawValue * 2 : rawValue;

  let after: number;
  switch (operation) {
    case "add":
      after = currentSetNumber + effectiveValue;
      break;
    case "sub":
      after = currentSetNumber - effectiveValue;
      break;
    case "mul":
      after = currentSetNumber * effectiveValue;
      break;
    case "div":
      // Guard against division by zero (0-card handled upstream, but be safe)
      after = effectiveValue === 0 ? currentSetNumber : Math.ceil(currentSetNumber / effectiveValue);
      break;
  }

  return {
    before:            currentSetNumber,
    after,
    operation,
    cardValue:         card.value,
    rawValue,
    effectiveValue,
    isImmediateDefeat: after < 0,
  };
}
