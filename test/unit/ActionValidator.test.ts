import { describe, it, expect } from "vitest";
import { validate } from "../../src/server/game/ActionValidator";
import type { Game, PlayerId, CardId } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";
import {
  ACTION_NOT_YOUR_TURN,
  ACTION_HAND_EMPTY,
  ACTION_INVALID_CARD,
  ACTION_INVALID_OPERATION,
  ACTION_BUG_FORBIDDEN,
  ACTION_NO_LEGAL_MOVE,
  ACTION_RESET_LIMIT_EXCEEDED,
  ACTION_INVALID_BUG_REMOVAL_COST,
  ACTION_INVALID_PHASE,
  SESSION_INVALID_STRATEGY,
} from "../../src/shared/constants";

// ============================================================
// Fixtures
// ============================================================

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id:                 "game-1",
    sessionId:          "session-1",
    gameIndex:          0,
    setNumber:          10,
    phase:              "normal",
    status:             "in-progress",
    deck:               ["1-1", "2-1"],
    excludedCards:      [],
    field:              [],
    hands:              { [P1]: ["3-1", "5-1"], [P2]: ["2-1"] },
    usedStrategyCounts: { [P1]: {}, [P2]: {} },
    turnOrder:          [P1, P2],
    currentTurnIndex:   0,
    resetCount:         0,
    residualBugs:       [],
    events:             [],
    ...overrides,
  };
}

function makeRuleSet(overrides: Partial<RuleSet> = {}): RuleSet {
  return {
    id:           "basic",
    version:      "1.0",
    deck:         { cards: [] },
    strategies:   [{ id: "Aggro", effect: { id: "aggro-effect", trigger: { type: "on_card_played" }, target: { type: "self" }, action: { type: "multiply_effective_value", factor: 2 } } }],
    bugs:         [
      { id: "Odd-Forbidden",  effect: { id: "odd-f",   trigger: { type: "always" }, target: { type: "self" }, action: { type: "forbid_card_parity", parity: "odd"  } }, removalCost: { type: "hp", amount: 3 } },
      { id: "Even-Forbidden", effect: { id: "even-f",  trigger: { type: "always" }, target: { type: "self" }, action: { type: "forbid_card_parity", parity: "even" } }, removalCost: { type: "hp", amount: 3 } },
      { id: "Stack-Forbidden",effect: { id: "stack-f", trigger: { type: "always" }, target: { type: "self" }, action: { type: "forbid_stack" }                         }, removalCost: { type: "hp", amount: 3 } },
      { id: "Hack-Bug",       effect: { id: "hack-f",  trigger: { type: "always" }, target: { type: "self" }, action: { type: "forbid_stack" }                         }, removalCost: { type: "hand_card", value: "even", amount: 1 } },
    ],
    phases:       [{ id: "normal", transitionConditions: [] }],
    winCondition: { winsRequired: 3 },
    initialConfig: { recommendedPlayers: 2, initialHandSize: 5, initialHP: 10, setNumberFormula: "random" },
    ...overrides,
  };
}

const ctx = (actorId: PlayerId = P1) => ({ actorId, ruleSet: makeRuleSet() });

// ============================================================
// play_card
// ============================================================

describe("validate play_card", () => {
  it("fails when not actor's turn", () => {
    const result = validate(makeGame(), { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P2));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_NOT_YOUR_TURN);
  });

  it("fails when hand is empty", () => {
    const game = makeGame({ hands: { [P1]: [] as CardId[], [P2]: ["2-1"] } });
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_HAND_EMPTY);
  });

  it("fails when card not in hand", () => {
    const result = validate(makeGame(), { type: "play_card", cardId: "9-9", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_CARD);
  });

  it("fails mul when field is empty (no lastFieldCard)", () => {
    const result = validate(makeGame(), { type: "play_card", cardId: "3-1", operation: "mul" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_OPERATION);
  });

  it("fails mul when lastFieldCard.rawValue !== card.value", () => {
    const game = makeGame({ field: [{ cardId: "5-1", playerId: P2, operation: "add", rawValue: 5, effectiveValue: 5 }] });
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "mul" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_OPERATION);
  });

  it("succeeds mul when lastFieldCard.rawValue === card.value", () => {
    const game = makeGame({ field: [{ cardId: "3-2", playerId: P2, operation: "add", rawValue: 3, effectiveValue: 3 }] });
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "mul" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("fails with Odd-Forbidden bug active and odd card", () => {
    const game = makeGame({ residualBugs: ["Odd-Forbidden"] });
    // "3-1" has value 3 (odd) → forbidden
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_BUG_FORBIDDEN);
  });

  it("allows even card when Odd-Forbidden is active", () => {
    const game = makeGame({ residualBugs: ["Odd-Forbidden"] });
    // hands has "5-1" (odd) but let's use a game with even card
    const gameWithEven = makeGame({ residualBugs: ["Odd-Forbidden"], hands: { [P1]: ["4-1"], [P2]: [] } });
    const result = validate(gameWithEven, { type: "play_card", cardId: "4-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("fails with Even-Forbidden bug active and even card", () => {
    const game = makeGame({ residualBugs: ["Even-Forbidden"], hands: { [P1]: ["4-1"], [P2]: [] } });
    const result = validate(game, { type: "play_card", cardId: "4-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_BUG_FORBIDDEN);
  });

  it("allows odd card when Even-Forbidden is active", () => {
    const game = makeGame({ residualBugs: ["Even-Forbidden"] });
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("fails with Stack-Forbidden when card value equals top of field", () => {
    const game = makeGame({
      residualBugs: ["Stack-Forbidden"],
      field: [{ cardId: "3-2", playerId: P2, operation: "add", rawValue: 3, effectiveValue: 3 }],
    });
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_BUG_FORBIDDEN);
  });

  it("allows different value when Stack-Forbidden is active", () => {
    const game = makeGame({
      residualBugs: ["Stack-Forbidden"],
      field: [{ cardId: "5-2", playerId: P2, operation: "add", rawValue: 5, effectiveValue: 5 }],
    });
    const result = validate(game, { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("succeeds with a valid add play", () => {
    const result = validate(makeGame(), { type: "play_card", cardId: "3-1", operation: "add" }, ctx(P1));
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// draw_card
// ============================================================

describe("validate draw_card (D10: 通常フェーズの自発ドローは違法)", () => {
  it("通常フェーズのドローは ACTION_INVALID_PHASE で拒否される（手番あり・手札に空きあり）", () => {
    // P1 has 2 cards (< 5) and it is P1's turn — かつては合法だったが D10 で違法に
    const result = validate(makeGame(), { type: "draw_card" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_PHASE);
  });

  it("手札が満杯でも通常フェーズのドローは ACTION_INVALID_PHASE（フェーズ判定が先）", () => {
    const game = makeGame({ hands: { [P1]: ["1-1", "2-1", "3-1", "4-1", "5-1"], [P2]: [] } });
    const result = validate(game, { type: "draw_card" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_PHASE);
  });
});

// ============================================================
// skip_turn — normal phase (D10 zero-legal-moves)
// ============================================================

describe("validate skip_turn — normal phase (D10)", () => {
  it("全札が禁止バグ対象なら skip_turn は合法", () => {
    // Odd-Forbidden 有効・手札は全て奇数（3,5）→ 合法カードゼロ
    const game = makeGame({ residualBugs: ["Odd-Forbidden"], hands: { [P1]: ["3-1", "5-1"], [P2]: [] } });
    const result = validate(game, { type: "skip_turn" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("合法カードが1枚でもあれば skip_turn は ACTION_NO_LEGAL_MOVE で拒否", () => {
    // Odd-Forbidden 有効だが 2 は偶数で出せる → スキップ不可
    const game = makeGame({ residualBugs: ["Odd-Forbidden"], hands: { [P1]: ["3-1", "2-1"], [P2]: [] } });
    const result = validate(game, { type: "skip_turn" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_NO_LEGAL_MOVE);
  });

  it("バグが無ければ（通常は出せる）skip_turn は拒否", () => {
    const result = validate(makeGame(), { type: "skip_turn" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_NO_LEGAL_MOVE);
  });

  it("手番でなければ skip_turn は ACTION_NOT_YOUR_TURN", () => {
    const game = makeGame({ residualBugs: ["Odd-Forbidden"], hands: { [P1]: ["3-1"], [P2]: ["5-1"] } });
    const result = validate(game, { type: "skip_turn" }, ctx(P2));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_NOT_YOUR_TURN);
  });
});

// ============================================================
// remove_bug
// ============================================================

describe("validate remove_bug", () => {
  it("fails when bug is not in residualBugs", () => {
    const result = validate(makeGame(), { type: "remove_bug", bugId: "Odd-Forbidden" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_CARD);
  });

  it("fails when bug is unknown in ruleSet", () => {
    const game = makeGame({ residualBugs: ["Unknown-Bug"] });
    const result = validate(game, { type: "remove_bug", bugId: "Unknown-Bug" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_CARD);
  });

  it("fails when HP is insufficient for hp-cost bug", () => {
    // Odd-Forbidden costs 3 HP; raidState has only 2 HP
    const game = makeGame({
      residualBugs: ["Odd-Forbidden"],
      raidState: {
        bossPlayerId: P2, bossHP: 10,
        playerHPs: { [P1]: 2, [P2]: 5 },
        activeBugId: "Odd-Forbidden", roundIndex: 1,
        turnOrder: [P1], currentTurnIndex: 0, bossActionsLeft: 1,
      },
    });
    const result = validate(game, { type: "remove_bug", bugId: "Odd-Forbidden" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_BUG_REMOVAL_COST);
  });

  it("succeeds when HP is sufficient for hp-cost bug", () => {
    const game = makeGame({
      residualBugs: ["Odd-Forbidden"],
      raidState: {
        bossPlayerId: P2, bossHP: 10,
        playerHPs: { [P1]: 5, [P2]: 5 },
        activeBugId: "Odd-Forbidden", roundIndex: 1,
        turnOrder: [P1], currentTurnIndex: 0, bossActionsLeft: 1,
      },
    });
    const result = validate(game, { type: "remove_bug", bugId: "Odd-Forbidden" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("succeeds hand_card cost when correct card provided", () => {
    // Hack-Bug costs 1 even hand_card
    const game = makeGame({
      residualBugs: ["Hack-Bug"],
      hands: { [P1]: ["4-1", "3-1"], [P2]: [] },
    });
    const result = validate(game, { type: "remove_bug", bugId: "Hack-Bug", costCardIds: ["4-1"] }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("fails hand_card cost when wrong parity card provided", () => {
    // Hack-Bug costs 1 even hand_card; providing odd "3-1" fails
    const game = makeGame({
      residualBugs: ["Hack-Bug"],
      hands: { [P1]: ["3-1", "5-1"], [P2]: [] },
    });
    const result = validate(game, { type: "remove_bug", bugId: "Hack-Bug", costCardIds: ["3-1"] }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_BUG_REMOVAL_COST);
  });
});

// ============================================================
// reset_or_raid
// ============================================================

describe("validate reset_or_raid", () => {
  it("fails when not actor's turn", () => {
    const result = validate(makeGame(), { type: "reset_or_raid", choice: "reset" }, ctx(P2));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_NOT_YOUR_TURN);
  });

  it("fails when phase is not normal", () => {
    const game = makeGame({ phase: "raid" });
    const result = validate(game, { type: "reset_or_raid", choice: "reset" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_INVALID_PHASE);
  });

  it("fails reset when resetCount >= 2", () => {
    const game = makeGame({ resetCount: 2 });
    const result = validate(game, { type: "reset_or_raid", choice: "reset" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(ACTION_RESET_LIMIT_EXCEEDED);
  });

  it("allows raid even when resetCount >= 2", () => {
    const game = makeGame({ resetCount: 2 });
    const result = validate(game, { type: "reset_or_raid", choice: "raid" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  it("succeeds reset when resetCount < 2", () => {
    const result = validate(makeGame(), { type: "reset_or_raid", choice: "reset" }, ctx(P1));
    expect(result.valid).toBe(true);
  });
});

// ============================================================
// select_strategy
// ============================================================

describe("validate select_strategy", () => {
  it("fails when strategyId is unknown", () => {
    const result = validate(makeGame(), { type: "select_strategy", strategyId: "Unknown-Strategy" }, ctx(P1));
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe(SESSION_INVALID_STRATEGY);
  });

  it("succeeds when strategyId exists in ruleSet", () => {
    const result = validate(makeGame(), { type: "select_strategy", strategyId: "Aggro" }, ctx(P1));
    expect(result.valid).toBe(true);
  });

  // select_strategy does not check turn order by design — it is called during the
  // pre-game strategy selection phase, before turn-based play begins.
});
