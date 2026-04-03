import { describe, it, expect } from "vitest";
import { canApplyOperation, resolve } from "../../src/server/game/ArithmeticJudge";
import type { FieldCard, CardId } from "../../src/shared/types/domain";
import { ACTION_INVALID_OPERATION } from "../../src/shared/constants";

// ============================================================
// Helpers
// ============================================================

function makeFieldCard(rawValue: number): FieldCard {
  return {
    cardId:         `${rawValue}-1`,
    playerId:       "p1",
    operation:      "add",
    rawValue,
    effectiveValue: rawValue,
  };
}

// ============================================================
// canApplyOperation
// ============================================================

describe("canApplyOperation", () => {
  describe("add / sub", () => {
    it("add is always valid regardless of lastFieldCard", () => {
      expect(canApplyOperation(undefined, { id: "3-1" as CardId, value: 3 }, "add")).toEqual({ valid: true });
      expect(canApplyOperation(makeFieldCard(5), { id: "3-1" as CardId, value: 3 }, "add")).toEqual({ valid: true });
    });

    it("sub is always valid regardless of lastFieldCard", () => {
      expect(canApplyOperation(undefined, { id: "3-1" as CardId, value: 3 }, "sub")).toEqual({ valid: true });
      expect(canApplyOperation(makeFieldCard(7), { id: "3-1" as CardId, value: 3 }, "sub")).toEqual({ valid: true });
    });
  });

  describe("mul", () => {
    it("valid when lastFieldCard.rawValue === card.value", () => {
      const result = canApplyOperation(makeFieldCard(4), { id: "4-1" as CardId, value: 4 }, "mul");
      expect(result).toEqual({ valid: true });
    });

    it("invalid when no lastFieldCard", () => {
      const result = canApplyOperation(undefined, { id: "4-1" as CardId, value: 4 }, "mul");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(ACTION_INVALID_OPERATION);
    });

    it("invalid when lastFieldCard.rawValue !== card.value", () => {
      const result = canApplyOperation(makeFieldCard(3), { id: "4-1" as CardId, value: 4 }, "mul");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(ACTION_INVALID_OPERATION);
    });
  });

  describe("div", () => {
    it("valid when lastFieldCard.rawValue === card.value", () => {
      const result = canApplyOperation(makeFieldCard(5), { id: "5-1" as CardId, value: 5 }, "div");
      expect(result).toEqual({ valid: true });
    });

    it("invalid when no lastFieldCard", () => {
      const result = canApplyOperation(undefined, { id: "5-1" as CardId, value: 5 }, "div");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(ACTION_INVALID_OPERATION);
    });

    it("invalid when lastFieldCard.rawValue !== card.value", () => {
      const result = canApplyOperation(makeFieldCard(2), { id: "5-1" as CardId, value: 5 }, "div");
      expect(result.valid).toBe(false);
      expect(result.errorCode).toBe(ACTION_INVALID_OPERATION);
    });
  });
});

// ============================================================
// resolve
// ============================================================

describe("resolve", () => {
  const card = { id: "3-1" as CardId, value: 3 };

  describe("operations without aggro", () => {
    it("add: setNumber + value", () => {
      const r = resolve(10, card, "add", false);
      expect(r.before).toBe(10);
      expect(r.after).toBe(13);
      expect(r.effectiveValue).toBe(3);
      expect(r.isImmediateDefeat).toBe(false);
    });

    it("sub: setNumber - value", () => {
      const r = resolve(10, card, "sub", false);
      expect(r.after).toBe(7);
      expect(r.isImmediateDefeat).toBe(false);
    });

    it("mul: setNumber * value", () => {
      const r = resolve(4, card, "mul", false);
      expect(r.after).toBe(12);
    });

    it("div: ceil(setNumber / value)", () => {
      const r = resolve(10, card, "div", false);
      expect(r.after).toBe(4); // ceil(10/3) = 4
    });

    it("div: exact division", () => {
      const r = resolve(9, card, "div", false);
      expect(r.after).toBe(3); // 9/3 = 3
    });
  });

  describe("aggro effect (effectiveValue = rawValue * 2)", () => {
    it("add with aggro: setNumber + value*2", () => {
      const r = resolve(10, card, "add", true);
      expect(r.effectiveValue).toBe(6);
      expect(r.after).toBe(16);
    });

    it("sub with aggro: setNumber - value*2", () => {
      const r = resolve(10, card, "sub", true);
      expect(r.effectiveValue).toBe(6);
      expect(r.after).toBe(4);
    });

    it("mul with aggro: setNumber * (value*2)", () => {
      const r = resolve(4, card, "mul", true);
      expect(r.effectiveValue).toBe(6);
      expect(r.after).toBe(24); // 4 * 6 = 24
    });
  });

  describe("isImmediateDefeat", () => {
    it("true when after < 0", () => {
      const r = resolve(2, card, "sub", false); // 2 - 3 = -1
      expect(r.after).toBe(-1);
      expect(r.isImmediateDefeat).toBe(true);
    });

    it("false when after === 0", () => {
      const r = resolve(3, card, "sub", false); // 3 - 3 = 0
      expect(r.after).toBe(0);
      expect(r.isImmediateDefeat).toBe(false);
    });
  });

  describe("division by zero guard", () => {
    it("returns currentSetNumber when effectiveValue === 0", () => {
      const zeroCard = { id: "0-1" as CardId, value: 0 };
      const r = resolve(10, zeroCard, "div", false);
      expect(r.after).toBe(10);
    });
  });
});
