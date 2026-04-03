import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/server/game/GameEngine";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import {
  SessionService,
  InMemorySessionStorage,
} from "../../src/server/session/SessionService";
import type { Game, PlayerId } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";
import type { EngineContext } from "../../src/server/game/GameEngine";

// ============================================================
// Fixtures
// ============================================================

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;

/**
 * Minimal RuleSet for scenario tests.
 * Both players use "Zero" strategy (trigger: on_game_start) which does NOT fire
 * on play_card / play_card_by_other — so effects never interfere with the scenarios.
 */
const ruleSet: RuleSet = {
  id: "basic",
  version: "1.0",
  deck: { cards: [{ value: 1, count: 10 }] },
  strategies: [
    {
      id: "Zero",
      effect: {
        id: "basic:zero",
        trigger: { type: "on_game_start" },
        target:  { type: "self" },
        action:  { type: "add_card_to_hand", cardValue: 0 },
      },
    },
  ],
  bugs: [],
  phases: [
    {
      id: "normal",
      transitionConditions: [{ type: "deck_empty", to: "showdown" }],
    },
    { id: "showdown", transitionConditions: [] },
    {
      id: "raid",
      transitionConditions: [
        { type: "boss_hp_zero_or_less",        to: "finished"         },
        { type: "all_players_hp_zero_or_less", to: "session_win_boss" },
      ],
    },
  ],
  winCondition:  { winsRequired: 3 },
  initialConfig: {
    recommendedPlayers: 2,
    initialHandSize:    5,
    initialHP:          10,
    setNumberFormula:   "gameIndex * 10",
  },
};

function makeCtx(actorId: PlayerId): EngineContext {
  const registry = new EffectRegistry();
  registerAllHandlers(registry);
  return {
    actorId,
    ruleSet,
    playerStrategies: { [P1]: "Zero", [P2]: "Zero" },
    effectResolver:   new EffectResolver(registry),
    rng: () => 0.5, // deterministic shuffle
  };
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id:                 "game-1",
    sessionId:          "session-1",
    gameIndex:          1,
    setNumber:          10,
    phase:              "normal",
    status:             "in-progress",
    deck:               [],
    excludedCards:      [],
    field:              [],
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

// ============================================================
// Scenario 1: 通常勝利 — setNumber → 0
// ============================================================

describe("Scenario: 通常勝利 (setNumber → 0)", () => {
  it("P1がカードを引いて最終的にsetNumber=0にするとgame.statusがfinishedになる", () => {
    // deck has enough cards so deck_empty transition never fires mid-scenario
    const game = makeGame({
      setNumber: 10,
      deck:  ["9-001", "8-001", "7-001"],
      hands: { [P1]: ["5-001", "1-001"], [P2]: ["4-001"] },
    });

    // P1 plays "5-001" sub → 10-5=5, draws "9-001" → hand=["1-001","9-001"]
    let g = applyAction(game, { type: "play_card", cardId: "5-001", operation: "sub" }, makeCtx(P1));
    expect(g.setNumber).toBe(5);
    expect(g.phase).toBe("normal");
    expect(g.status).toBe("in-progress");

    // P2 plays "4-001" sub → 5-4=1, draws "8-001"
    g = applyAction(g, { type: "play_card", cardId: "4-001", operation: "sub" }, makeCtx(P2));
    expect(g.setNumber).toBe(1);

    // P1 plays "1-001" sub → 1-1=0 → win
    g = applyAction(g, { type: "play_card", cardId: "1-001", operation: "sub" }, makeCtx(P1));
    expect(g.status).toBe("finished");
    expect(g.winnerId).toBe(P1);
    expect(g.events.some(e => e.type === "game_ended")).toBe(true);
  });

  it("setNumberが0に達した後はターンが進まない（ゲーム終了）", () => {
    const game = makeGame({
      setNumber: 3,
      deck:  ["9-001"],
      hands: { [P1]: ["3-001"], [P2]: ["4-001"] },
    });

    const g = applyAction(game, { type: "play_card", cardId: "3-001", operation: "sub" }, makeCtx(P1));
    expect(g.status).toBe("finished");
    expect(g.currentTurnIndex).toBe(0); // turn did not advance after win
  });
});

// ============================================================
// Scenario 2: デッキ枯渇 → showdown フェーズ移行
// ============================================================

describe("Scenario: デッキ枯渇 → showdown フェーズ移行", () => {
  it("デッキが空の状態でカードを出すとphase=showdownに遷移する", () => {
    const game = makeGame({
      setNumber: 10,
      deck:  [], // already empty — transition fires on first play
      hands: { [P1]: ["5-001"], [P2]: ["3-001"] },
    });

    // P1 plays "5-001" sub → 10-5=5, deck empty → no draw → checkPhaseTransition fires
    const g = applyAction(game, { type: "play_card", cardId: "5-001", operation: "sub" }, makeCtx(P1));
    expect(g.setNumber).toBe(5);
    expect(g.phase).toBe("showdown");
    expect(g.status).toBe("in-progress");
    expect(g.events.some(e => e.type === "phase_changed")).toBe(true);
  });

  it("引いた後もデッキが残っている場合はshowdownに遷移しない", () => {
    // deck has 2 cards: P1 draws 1 after playing → deck still has 1 left → no transition
    const game = makeGame({
      setNumber: 10,
      deck:  ["9-001", "8-001"],
      hands: { [P1]: ["5-001"], [P2]: [] },
    });

    const g = applyAction(game, { type: "play_card", cardId: "5-001", operation: "sub" }, makeCtx(P1));
    expect(g.phase).toBe("normal"); // "8-001" remains in deck
    expect(g.deck).toHaveLength(1);
  });
});

// ============================================================
// Scenario 3: 0カード → reset_or_raid
// ============================================================

describe("Scenario: 0カード → レイド開始", () => {
  it("0カードを出してraidを選択するとraidStateが設定される", () => {
    const game = makeGame({
      setNumber: 5,
      field: [
        { cardId: "3-001", playerId: P2, operation: "add", rawValue: 3, effectiveValue: 3 },
        { cardId: "2-001", playerId: P2, operation: "add", rawValue: 2, effectiveValue: 2 },
      ],
      hands: { [P1]: ["0-001"], [P2]: ["4-001"] },
    });

    // Step 1: P1 plays "0-001" sub → setNumber 5-0=5, value===0 → turn NOT advanced
    let g = applyAction(game, { type: "play_card", cardId: "0-001", operation: "sub" }, makeCtx(P1));
    expect(g.currentTurnIndex).toBe(0); // same player's turn
    expect(g.phase).toBe("normal");     // still waiting for choice

    // Step 2: P1 chooses raid
    g = applyAction(g, { type: "reset_or_raid", choice: "raid" }, makeCtx(P1));
    expect(g.phase).toBe("raid");
    expect(g.raidState).toBeDefined();
    // bossHP = sum of field rawValues: 3+2+0 = 5
    expect(g.raidState!.bossHP).toBe(5);
    expect(g.raidState!.bossPlayerId).toBe(P1);
    // playerHPs initialized to initialHP (10)
    expect(g.raidState!.playerHPs[P1]).toBe(10);
    expect(g.raidState!.playerHPs[P2]).toBe(10);
    // field cleared
    expect(g.field).toHaveLength(0);
    expect(g.events.some(e => e.type === "raid_started")).toBe(true);
  });

  it("0カードを出してresetを選択するとフィールドがクリアされsetNumberが再設定される", () => {
    const game = makeGame({
      setNumber: 5,
      hands: { [P1]: ["0-001"], [P2]: ["4-001"] },
      deck:  ["7-001", "8-001", "9-001", "6-001"],
    });

    let g = applyAction(game, { type: "play_card", cardId: "0-001", operation: "sub" }, makeCtx(P1));
    g = applyAction(g, { type: "reset_or_raid", choice: "reset" }, makeCtx(P1));

    expect(g.phase).toBe("normal");
    expect(g.raidState).toBeUndefined();
    expect(g.resetCount).toBe(1);
    // setNumber reset: evaluateSetNumberFormula("gameIndex * 10", 1) = 10
    expect(g.setNumber).toBe(10);
    expect(g.events.some(e => e.type === "game_reset")).toBe(true);
  });
});

// ============================================================
// Scenario 4: SessionService — residualBugs の引き継ぎ
// ============================================================

describe("Scenario: SessionService — residualBugs の引き継ぎ", () => {
  it("finishedGame の residualBugs が次ゲームに引き継がれる", async () => {
    const storage = new InMemorySessionStorage();
    const service = new SessionService(storage);

    const startResult = await service.startSession({
      roomId:    "room-1",
      sessionId: "session-1",
      players: [
        { playerId: P1, strategyId: "Zero" },
        { playerId: P2, strategyId: "Zero" },
      ],
      ruleSetId: "basic",
      ruleSet,
    });

    expect(startResult.ok).toBe(true);
    if (!startResult.ok) return;
    const { session, game } = startResult.value;

    // Simulate game finishing with a residual bug
    const finishedGame: Game = {
      ...game,
      status:       "finished",
      residualBugs: ["Value-Corruption"],
    };
    await service.saveGame(finishedGame);

    const nextResult = await service.startNextGame({
      sessionId:    session.id,
      finishedGame,
      ruleSet,
    });

    expect(nextResult.ok).toBe(true);
    if (!nextResult.ok) return;
    expect(nextResult.value.game.residualBugs).toContain("Value-Corruption");
  });

  it("residualBugs が空のゲームが終わった場合、次ゲームの residualBugs も空", async () => {
    const storage = new InMemorySessionStorage();
    const service = new SessionService(storage);

    const startResult = await service.startSession({
      roomId:    "room-2",
      sessionId: "session-2",
      players: [
        { playerId: P1, strategyId: "Zero" },
        { playerId: P2, strategyId: "Zero" },
      ],
      ruleSetId: "basic",
      ruleSet,
    });

    if (!startResult.ok) return;
    const { session, game } = startResult.value;

    const finishedGame: Game = {
      ...game,
      status:       "finished",
      residualBugs: [], // no bugs
    };

    const nextResult = await service.startNextGame({
      sessionId:    session.id,
      finishedGame,
      ruleSet,
    });

    if (!nextResult.ok) return;
    expect(nextResult.value.game.residualBugs).toHaveLength(0);
  });
});

// ============================================================
// Scenario 5: セッション勝利条件 — recordWin で3勝到達
// ============================================================

describe("Scenario: セッション勝利条件", () => {
  it("recordWin が winsRequired (3) 回達するとセッションが finished になる", async () => {
    const storage = new InMemorySessionStorage();
    const service = new SessionService(storage);

    const startResult = await service.startSession({
      roomId:    "room-3",
      sessionId: "session-3",
      players: [
        { playerId: P1, strategyId: "Zero" },
        { playerId: P2, strategyId: "Zero" },
      ],
      ruleSetId: "basic",
      ruleSet,
    });

    if (!startResult.ok) return;
    const { session } = startResult.value;

    await service.recordWin({ sessionId: session.id, winnerId: P1, ruleSet });
    await service.recordWin({ sessionId: session.id, winnerId: P1, ruleSet });
    const lastResult = await service.recordWin({ sessionId: session.id, winnerId: P1, ruleSet });

    expect(lastResult.ok).toBe(true);
    if (!lastResult.ok) return;
    expect(lastResult.value.status).toBe("finished");
    expect(lastResult.value.winnerId).toBe(P1);
  });

  it("2勝ではセッションは継続中のまま", async () => {
    const storage = new InMemorySessionStorage();
    const service = new SessionService(storage);

    const startResult = await service.startSession({
      roomId:    "room-4",
      sessionId: "session-4",
      players: [
        { playerId: P1, strategyId: "Zero" },
        { playerId: P2, strategyId: "Zero" },
      ],
      ruleSetId: "basic",
      ruleSet,
    });

    if (!startResult.ok) return;
    const { session } = startResult.value;

    await service.recordWin({ sessionId: session.id, winnerId: P1, ruleSet });
    const result = await service.recordWin({ sessionId: session.id, winnerId: P1, ruleSet });

    if (!result.ok) return;
    expect(result.value.status).toBe("in-progress");
  });
});
