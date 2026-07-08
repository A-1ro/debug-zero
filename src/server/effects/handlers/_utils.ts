import type { Operation, EventId } from "../../../shared/types/domain";
import type { EffectContext } from "../../../shared/types/effects";

/**
 * Recover the setNumber as it was before the trigger card's operation was applied.
 *
 * Prefers ctx.setNumberBefore (the exact pre-card value recorded by GameEngine
 * when the card was played). Falls back to reverse-computing from the current
 * setNumber only when the context does not carry it (e.g. legacy callers) —
 * note that the fallback cannot exactly reverse div (Math.ceil loses information).
 */
export function preCardSetNumber(
  ctx: EffectContext,
  currentSetNumber: number,
  op: Operation,
  effectiveValue: number,
): number {
  return ctx.setNumberBefore ?? undoOperation(currentSetNumber, op, effectiveValue);
}

/**
 * Reverse an arithmetic operation to recover the setNumber before the card was played.
 * Fallback only — div is an approximation (Math.ceil cannot be reversed exactly).
 * Prefer preCardSetNumber(), which uses the exact value carried in EffectContext.
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
