import { describe, it, expect } from "vitest";
import { aggro }          from "../../src/server/effects/handlers/strategies/aggro";
import { controlAdd }     from "../../src/server/effects/handlers/strategies/controlAdd";
import { hack }           from "../../src/server/effects/handlers/strategies/hack";
import { trickStar }      from "../../src/server/effects/handlers/strategies/trickStar";
import { valueCorruption } from "../../src/server/effects/handlers/bugs/valueCorruption";
import { applyAction } from "../../src/server/game/GameEngine";
import type { EngineContext } from "../../src/server/game/GameEngine";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import type { Game, PlayerId, FieldCard } from "../../src/shared/types/domain";
import type { EffectContext } from "../../src/shared/types/effects";
import type { RuleSet } from "../../src/shared/types/rules";

// ============================================================
// Fixtures
// ============================================================

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;

// Handlers don't use ruleSet directly; stub is sufficient
const ruleSet = {} as RuleSet;

function makeFieldCard(
  rawValue: number,
  operation: "add" | "sub" | "mul" | "div" = "add",
  playerId: PlayerId = P1,
): FieldCard {
  return {
    cardId:         `${rawValue}-001`,
    playerId,
    operation,
    rawValue,
    effectiveValue: rawValue,
  };
}

/**
 * Make a minimal Game with one field card already played.
 * `setNumberAfterCard` is the setNumber after the card was placed on the field.
 */
function makeGameWithLastCard(
  setNumberAfterCard: number,
  lastCard: FieldCard,
  overrides: Partial<Game> = {},
): Game {
  return {
    id:                 "game-1",
    sessionId:          "s-1",
    gameIndex:          1,
    setNumber:          setNumberAfterCard,
    phase:              "normal",
    status:             "in-progress",
    deck:               [],
    excludedCards:      [],
    field:              [lastCard],
    hands:              { [P1]: [], [P2]: [] },
    usedStrategyCounts: { [P1]: {}, [P2]: {} },
    turnOrder:          [P1, P2],
    currentTurnIndex:   0,
    resetCount:         0,
    residualBugs:       [],
    events:             [],
    ...overrides,
  };
}

function makeCtx(actorId: PlayerId, triggerCard: FieldCard): EffectContext {
  return { actorId, triggerCard, ruleSet };
}

// ============================================================
// aggro handler
// ============================================================

describe("aggro handler", () => {
  it("effectiveValue が rawValue*2 でない場合: 2倍に更新しsetNumberを再計算する", () => {
    // P1 played card(3, add), effectiveValue=3, setNumber = 10+3 = 13
    const card = makeFieldCard(3, "add", P1);
    const game = makeGameWithLastCard(13, card);

    const patch = aggro(game, makeCtx(P1, card));

    expect(patch.field).toBeDefined();
    expect(patch.field![0].effectiveValue).toBe(6); // rawValue*2 = 3*2
    // undo add(13-3=10), re-apply add(10+6=16)
    expect(patch.setNumber).toBe(16);
  });

  it("sub operation: undo と再適用が正しく計算される", () => {
    // P1 played card(4, sub): setNumber = 10-4 = 6
    const card = makeFieldCard(4, "sub", P1);
    const game = makeGameWithLastCard(6, card);

    const patch = aggro(game, makeCtx(P1, card));

    expect(patch.field![0].effectiveValue).toBe(8); // 4*2
    // undo sub(6+4=10), re-apply sub(10-8=2)
    expect(patch.setNumber).toBe(2);
  });

  it("effectiveValue がすでに rawValue*2 の場合: no-op（パッチなし）", () => {
    const card: FieldCard = { ...makeFieldCard(3, "add", P1), effectiveValue: 6 };
    const game = makeGameWithLastCard(16, card); // 10+6=16 (already doubled)

    const patch = aggro(game, makeCtx(P1, card));

    expect(patch.field).toBeUndefined();
    expect(patch.setNumber).toBeUndefined();
  });

  it("rawValue は変更されない", () => {
    const card = makeFieldCard(3, "add", P1);
    const game = makeGameWithLastCard(13, card);

    const patch = aggro(game, makeCtx(P1, card));

    expect(patch.field![0].rawValue).toBe(3); // rawValue unchanged
  });
});

// ============================================================
// controlAdd handler
// ============================================================

describe("controlAdd handler", () => {
  it("operation が sub → add に変更されsetNumberが再計算される", () => {
    // P1 played card(3, sub): setNumber = 10-3 = 7
    const card = makeFieldCard(3, "sub", P1);
    const game = makeGameWithLastCard(7, card, {
      usedStrategyCounts: { [P1]: {}, [P2]: {} },
    });

    // P2 has Control-Add (on_card_played_by_other)
    const patch = controlAdd(game, makeCtx(P2, card));

    expect(patch.field![0].operation).toBe("add");
    // undo sub(7+3=10), re-apply add(10+3=13)
    expect(patch.setNumber).toBe(13);
    // usedStrategyCounts はハンドラでは触らない（EffectResolverが中央で加算する）
    expect(patch.usedStrategyCounts).toBeUndefined();
    expect(patch.appendEvents!.some(e => e.type === "operation_changed")).toBe(true);
  });

  it("mul カードは対象外（yamlの from=sub 制約）: no-op", () => {
    const card = makeFieldCard(3, "mul", P1);
    const game = makeGameWithLastCard(30, card, {
      usedStrategyCounts: { [P1]: {}, [P2]: {} },
    });

    const patch = controlAdd(game, makeCtx(P2, card));

    expect(patch).toEqual({});
  });

  it("operation がすでに add の場合: no-op", () => {
    const card = makeFieldCard(3, "add", P1); // already "add"
    const game = makeGameWithLastCard(13, card);

    const patch = controlAdd(game, makeCtx(P2, card));

    expect(patch.field).toBeUndefined();
    expect(patch.setNumber).toBeUndefined();
  });
});

// ============================================================
// hack handler
// ============================================================

describe("hack handler", () => {
  it("偶数カードのとき: fieldCard.playerId が Hack 使用者に変わる", () => {
    const card = makeFieldCard(4, "add", P1); // rawValue=4 (even), owned by P1
    const game = makeGameWithLastCard(14, card);

    // P2 hacks P1's even card
    const patch = hack(game, makeCtx(P2, card));

    expect(patch.field).toBeDefined();
    expect(patch.field![0].playerId).toBe(P2);
    expect(patch.appendEvents!.some(e => e.type === "card_stolen")).toBe(true);
  });

  it("奇数カードのとき: 何も変わらない", () => {
    const card = makeFieldCard(3, "add", P1); // rawValue=3 (odd)
    const game = makeGameWithLastCard(13, card);

    const patch = hack(game, makeCtx(P2, card));

    expect(patch.field).toBeUndefined();
    expect(patch.appendEvents).toBeUndefined();
  });

  it("すでに Hack 使用者が所有している場合: no-op", () => {
    const card = makeFieldCard(4, "add", P2); // already owned by P2
    const game = makeGameWithLastCard(14, card);

    const patch = hack(game, makeCtx(P2, card));

    expect(patch.field).toBeUndefined();
  });

  it("0（偶数）カードのとき: 所有権が移る", () => {
    const card = makeFieldCard(0, "sub", P1); // rawValue=0 (even)
    const game = makeGameWithLastCard(10, card);

    const patch = hack(game, makeCtx(P2, card));

    expect(patch.field![0].playerId).toBe(P2);
  });
});

// ============================================================
// div 巻き戻し（D4: Math.ceil は逆算不能 → setNumberBefore を使う）
// ============================================================

describe("div演算の巻き戻し（D4）", () => {
  it("trickStar: 10 div 3 → ceil=4 のカードを除去すると setNumber が正確に 10 へ戻る", () => {
    // 10 div 3 = ceil(10/3) = 4。近似逆算（4*3=12）ではなく、
    // ctx.setNumberBefore に保持された演算前の値で正確に巻き戻す
    const card = makeFieldCard(3, "div", P1);
    const game = makeGameWithLastCard(4, card);

    const patch = trickStar(game, { ...makeCtx(P2, card), setNumberBefore: 10 });

    expect(patch.field).toHaveLength(0);
    expect(patch.setNumber).toBe(10);
  });

  it("valueCorruption: div カードの effectiveValue 汚染も setNumberBefore から再計算される", () => {
    // 10 div 3 = 4 → effectiveValue が 10 に汚染 → ceil(10/10) = 1
    const card = makeFieldCard(3, "div", P1);
    const game = makeGameWithLastCard(4, card);

    const patch = valueCorruption(game, { ...makeCtx(P1, card), setNumberBefore: 10 });

    expect(patch.field![0].effectiveValue).toBe(10);
    expect(patch.setNumber).toBe(1);
  });

  it("GameEngine経由: div カードが TrickStar に除去されると setNumber がプレイ前の値へ戻る", () => {
    // エンジンが effectCtx.setNumberBefore を渡していることのend-to-end確認
    const trickStarRuleSet: RuleSet = {
      id: "basic",
      version: "1.0",
      deck: { cards: [{ value: 1, count: 10 }] },
      strategies: [{
        id: "TrickStar",
        effect: {
          id: "basic:trickStar",
          trigger: { type: "on_card_played_by_other" },
          target:  { type: "field_card" },
          action:  { type: "remove_card" },
          usageLimit: 1,
        },
      }],
      bugs: [],
      phases: [
        { id: "normal",   transitionConditions: [] },
        { id: "showdown", transitionConditions: [] },
        { id: "raid",     transitionConditions: [] },
      ],
      winCondition:  { winsRequired: 3 },
      initialConfig: {
        recommendedPlayers: 2,
        initialHandSize:    5,
        initialHP:          10,
        setNumberFormula:   "gameIndex * 10",
      },
    };
    const registry = new EffectRegistry();
    registerAllHandlers(registry);
    const ctx: EngineContext = {
      actorId: P1,
      ruleSet: trickStarRuleSet,
      playerStrategies: { [P2]: "TrickStar" },
      effectResolver: new EffectResolver(registry),
      rng: () => 0.5,
    };

    // 場の直前カード rawValue=3 なので 3 の div は合法。10 div 3 → 4 → TrickStar除去 → 10
    const prevCard = makeFieldCard(3, "add", P2);
    const game: Game = {
      ...makeGameWithLastCard(10, prevCard),
      deck: ["1-001"],
      hands: { [P1]: ["3-002"], [P2]: [] },
    };

    const g = applyAction(game, { type: "play_card", cardId: "3-002", operation: "div" }, ctx);

    expect(g.setNumber).toBe(10); // 12（近似逆算）ではない
    expect(g.field.some(fc => fc.cardId === "3-002")).toBe(false); // 除去済み
  });
});

// ============================================================
// valueCorruption handler
// ============================================================

describe("valueCorruption handler", () => {
  it("effectiveValue が 10 に書き換えられ setNumber が再計算される", () => {
    // P1 played card(3, add): setNumber = 10+3 = 13
    const card = makeFieldCard(3, "add", P1);
    const game = makeGameWithLastCard(13, card);

    const patch = valueCorruption(game, makeCtx(P1, card));

    expect(patch.field![0].effectiveValue).toBe(10);
    // undo add(13-3=10), re-apply add(10+10=20)
    expect(patch.setNumber).toBe(20);
    expect(patch.appendEvents!.some(e => e.type === "bug_activated")).toBe(true);
  });

  it("sub operation のとき: undo と再適用が正しい", () => {
    // P1 played card(3, sub): setNumber = 10-3 = 7
    const card = makeFieldCard(3, "sub", P1);
    const game = makeGameWithLastCard(7, card);

    const patch = valueCorruption(game, makeCtx(P1, card));

    expect(patch.field![0].effectiveValue).toBe(10);
    // undo sub(7+3=10), re-apply sub(10-10=0)
    expect(patch.setNumber).toBe(0);
  });

  it("rawValue は変更されない（raid HP 計算は rawValue を使うため）", () => {
    const card = makeFieldCard(3, "add", P1);
    const game = makeGameWithLastCard(13, card);

    const patch = valueCorruption(game, makeCtx(P1, card));

    expect(patch.field![0].rawValue).toBe(3); // rawValue unchanged
    expect(patch.field![0].effectiveValue).toBe(10);
  });

  it("effectiveValue がすでに 10 の場合: no-op", () => {
    const card: FieldCard = { ...makeFieldCard(3, "add", P1), effectiveValue: 10 };
    const game = makeGameWithLastCard(20, card); // 10+10=20

    const patch = valueCorruption(game, makeCtx(P1, card));

    expect(patch.field).toBeUndefined();
    expect(patch.setNumber).toBeUndefined();
  });
});
