import type { Operation, EventId } from "../../../shared/types/domain";

/**
 * Reverse an arithmetic operation to recover the setNumber before the card was played.
 * Used by Control and TrickStar handlers to compute the pre-card setNumber.
 */
export function undoOperation(setNumber: number, op: Operation, effectiveValue: number): number {
  switch (op) {
    case "add": return setNumber - effectiveValue;
    case "sub": return setNumber + effectiveValue;
    case "mul": return effectiveValue !== 0 ? setNumber / effectiveValue : setNumber;
    case "div": return setNumber * effectiveValue; // approximate reversal of Math.ceil
  }
}

/**
 * Apply an arithmetic operation (same logic as ArithmeticJudge.resolve).
 */
export function applyOperation(setNumber: number, op: Operation, effectiveValue: number): number {
  switch (op) {
    case "add": return setNumber + effectiveValue;
    case "sub": return setNumber - effectiveValue;
    case "mul": return setNumber * effectiveValue;
    case "div": return effectiveValue === 0 ? setNumber : Math.ceil(setNumber / effectiveValue);
  }
}

export function newEventId(): EventId {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
