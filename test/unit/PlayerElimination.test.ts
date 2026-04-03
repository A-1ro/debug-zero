import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/server/game/GameEngine";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import type { Game, PlayerId } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";
import type { EngineContext } from "../../src/server/game/GameEngine";

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;
const P3 = "player-3" as PlayerId;

const aggroRuleSet: RuleSet = {
  id: "basic",
  version: "1.0",
  deck: { cards: [{ value: 5, count: 20 }] },
  strategies: [
    {
      id: "Aggro",
      effect: {
        id: "basic:aggro",
        trigger: { type: "on_card_played" },
        target:  { type: "self" },
        action:  { type: "multiply_effective_value", factor: 2 },
        usageLimit: null,
      },
    },
    {
      id: "None",
      effect: {
        id: "basic:none",
        trigger: { type: "on_game_start" },
        target:  { type: "self" },
        action:  { type: "add_card_to_hand", cardValue: 0 },
      },
    },
  ],
  bugs: [],
  phases: [
    { id: "normal",   transitionConditions: [{ type: "deck_empty", to: "showdown" }] },
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

function makeCtx(actorId: PlayerId, strategies: Record<string, string>): EngineContext {
  const registry = new EffectRegistry();
  registerAllHandlers(registry);
  return {
    actorId,
    ruleSet: aggroRuleSet,
    playerStrategies: strategies,
    effectResolver: new EffectResolver(registry),
    rng: () => 0.5,
  };
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id:                 "game-1",
    sessionId:          "session-1",
    gameIndex:          1,
    setNumber:          5,
    phase:              "normal",
    status:             "in-progress",
    deck:               ["5-001"],
    excludedCards:      [],
    field:              [],
    hands:              { [P1]: ["3-001"], [P2]: ["4-001"] },
    usedStrategyCounts: { [P1]: {}, [P2]: {} },
    turnOrder:          [P1, P2],
    currentTurnIndex:   0,
    resetCount:         0,
    residualBugs:       [],
    events:             [],
    ...overrides,
  };
}

// ============================================================
// 2人対戦: Aggroが負数→P2が勝利
// ============================================================

describe("Player elimination: 2-player Aggro bust", () => {
  it("AggroプレイヤーがsetNumberを負数にしたとき、そのプレイヤーが脱落しゲーム終了", () => {
    // setNumber=5, P1(Aggro) plays "3-001" sub → 5 - (3*2)=5-6=-1 → eliminated
    const game = makeGame({
      setNumber: 5,
      hands: { [P1]: ["3-001"], [P2]: ["4-001"] },
    });
    const strategies = { [P1]: "Aggro", [P2]: "None" };

    const g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1, strategies));

    expect(g.status).toBe("finished");
    expect(g.winnerId).toBe(P2);
    expect(g.turnOrder).toEqual([P2]);
    expect(g.events.some(e => e.type === "player_eliminated")).toBe(true);
    expect(g.events.some(e => e.type === "game_ended")).toBe(true);
    const endEvent = g.events.find(e => e.type === "game_ended");
    expect(endEvent?.payload?.reason).toBe("last_player_standing");
  });

  it("脱落イベントに eliminatedId が含まれる", () => {
    const game = makeGame({
      setNumber: 5,
      hands: { [P1]: ["3-001"], [P2]: ["4-001"] },
    });
    const strategies = { [P1]: "Aggro", [P2]: "None" };

    const g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1, strategies));

    const elimEvent = g.events.find(e => e.type === "player_eliminated");
    expect(elimEvent?.payload?.eliminatedId).toBe(P1);
    expect(elimEvent?.payload?.reason).toBe("set_number_negative");
  });
});

// ============================================================
// 3人対戦: Aggroが負数→ゲーム継続
// ============================================================

describe("Player elimination: 3-player Aggro bust continues game", () => {
  it("3人いる場合はAggroプレイヤー脱落後もゲームが継続する", () => {
    // setNumber=5, P1(Aggro) plays "3-001" sub → 5-6=-1 → eliminated
    // P2, P3 remain → game continues
    const game = makeGame({
      setNumber: 5,
      hands:              { [P1]: ["3-001"], [P2]: ["4-001"], [P3]: ["2-001"] },
      usedStrategyCounts: { [P1]: {}, [P2]: {}, [P3]: {} },
      turnOrder:          [P1, P2, P3],
    });
    const strategies = { [P1]: "Aggro", [P2]: "None", [P3]: "None" };

    const g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1, strategies));

    expect(g.status).toBe("in-progress");
    expect(g.winnerId).toBeUndefined();
    expect(g.turnOrder).toEqual([P2, P3]);
    // setNumber は bust 前に巻き戻る
    expect(g.setNumber).toBe(5);
    // 破滅カードはフィールドに残らない
    expect(g.field).toHaveLength(0);
    // 次のターンは P2（インデックス 0）
    expect(g.turnOrder[g.currentTurnIndex]).toBe(P2);
    expect(g.events.some(e => e.type === "player_eliminated")).toBe(true);
  });

  it("P1脱落後にP2が通常プレイを続けられる", () => {
    const game = makeGame({
      setNumber: 5,
      deck:               ["9-001"],
      hands:              { [P1]: ["3-001"], [P2]: ["2-001"], [P3]: ["1-001"] },
      usedStrategyCounts: { [P1]: {}, [P2]: {}, [P3]: {} },
      turnOrder:          [P1, P2, P3],
    });
    const strategies = { [P1]: "Aggro", [P2]: "None", [P3]: "None" };

    // P1(Aggro) busts
    let g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1, strategies));
    expect(g.status).toBe("in-progress");
    expect(g.setNumber).toBe(5);

    // P2 plays "2-001" sub → 5-2=3
    g = applyAction(g, { type: "play_card", cardId: "2-001", operation: "sub" }, makeCtx(P2, strategies));
    expect(g.setNumber).toBe(3);
    expect(g.status).toBe("in-progress");
  });
});

// ============================================================
// 非Aggroが負数にしてもゲーム続行
// ============================================================

describe("Non-Aggro player going negative — game continues", () => {
  it("非AggroプレイヤーがsetNumberを負数にしてもゲームは終了しない", () => {
    // setNumber=2, P1(None) plays "3-001" sub → 2-3=-1 → game continues
    const game = makeGame({
      setNumber: 2,
      deck:  ["9-001"],
      hands: { [P1]: ["3-001"], [P2]: ["4-001"] },
    });
    const strategies = { [P1]: "None", [P2]: "None" };

    const g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1, strategies));

    expect(g.status).toBe("in-progress");
    expect(g.setNumber).toBe(-1);
    expect(g.turnOrder).toEqual([P1, P2]); // 脱落なし
    expect(g.events.some(e => e.type === "player_eliminated")).toBe(false);
  });

  it("非Aggroが負数にした後、次のプレイヤーがプレイできる", () => {
    const game = makeGame({
      setNumber: 2,
      deck:  ["9-001"],
      hands: { [P1]: ["3-001"], [P2]: ["4-001"] },
    });
    const strategies = { [P1]: "None", [P2]: "None" };

    let g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1, strategies));
    expect(g.setNumber).toBe(-1);

    // P2 plays "4-001" add → -1+4=3
    g = applyAction(g, { type: "play_card", cardId: "4-001", operation: "add" }, makeCtx(P2, strategies));
    expect(g.setNumber).toBe(3);
    expect(g.status).toBe("in-progress");
  });
});
