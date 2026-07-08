import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/server/game/GameEngine";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import type { Game, PlayerId } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";
import type { EngineContext } from "../../src/server/game/GameEngine";

// CLAUDE.md必須シナリオ: showdown.test.ts
// 山札枯渇 → 決戦フェーズ → 2枚以下＋演算の提出 → 最近値プレイヤー勝利
// タイブレーク: 同値なら枚数の少ない方 → さらに同じなら全員勝利

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;
const P3 = "player-3" as PlayerId;

const ruleSet: RuleSet = {
  id: "basic",
  version: "1.0",
  deck: { cards: [{ value: 1, count: 10 }] },
  strategies: [],
  bugs: [],
  phases: [
    { id: "normal",   transitionConditions: [{ type: "deck_empty", to: "showdown" }] },
    { id: "showdown", transitionConditions: [] },
    { id: "raid",     transitionConditions: [] },
  ],
  winCondition:  { winsRequired: 3 },
  initialConfig: {
    recommendedPlayers: 3,
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
    playerStrategies: {},
    effectResolver: new EffectResolver(registry),
    rng: () => 0.5,
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
    hands:              { [P1]: [], [P2]: [], [P3]: [] },
    usedStrategyCounts: { [P1]: {}, [P2]: {}, [P3]: {} },
    turnOrder:          [P1, P2, P3],
    currentTurnIndex:   0,
    resetCount:         0,
    residualBugs:       [],
    events:             [],
    ...overrides,
  };
}

describe("Scenario: 山札枯渇 → showdown移行", () => {
  it("最後の1枚がplay_cardの自動補充で引かれるとshowdownへ遷移する（B5回帰）", () => {
    // D10: 通常フェーズの自発ドローは廃止。山札枯渇はカードプレイ後の自動補充で起きる。
    const game = makeGame({
      deck:      ["7-001"],
      setNumber: 10,
      hands:     { [P1]: ["1-001"], [P2]: ["2-001"], [P3]: ["3-001"] },
    });
    // P1 が 1 を sub → setNumber=9（勝利でも負数でもない）→ 自動補充で最後の7-001を引く→山札0→showdown
    const g = applyAction(game, { type: "play_card", cardId: "1-001", operation: "sub" }, makeCtx(P1));
    expect(g.deck).toHaveLength(0);
    expect(g.phase).toBe("showdown");
    expect(g.events.some(e => e.type === "phase_changed")).toBe(true);
  });

  it("通常フェーズの draw_card は ACTION_INVALID_PHASE で拒否される（D10）", () => {
    const game = makeGame({
      deck:  ["7-001"],
      hands: { [P1]: ["1-001"], [P2]: ["2-001"], [P3]: ["3-001"] },
    });
    expect(() =>
      applyAction(game, { type: "draw_card" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_PHASE");
  });

  it("showdown中はplay_card/draw_cardが拒否される", () => {
    const game = makeGame({
      phase: "showdown",
      hands: { [P1]: ["1-001"], [P2]: ["2-001"], [P3]: ["3-001"] },
    });
    expect(() =>
      applyAction(game, { type: "play_card", cardId: "1-001", operation: "add" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_PHASE");
    expect(() =>
      applyAction(game, { type: "draw_card" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_PHASE");
  });
});

describe("Scenario: 通常フェーズの詰み手番スキップ（D10）", () => {
  it("次の手番プレイヤーが全札禁止なら自動でスキップされ、動ける人まで手番が進む", () => {
    // Odd-Forbidden 有効。P1=偶数(出せる)/P2=奇数のみ(詰み)/P3=偶数(出せる)。
    const game = makeGame({
      setNumber:    10,
      residualBugs: ["Odd-Forbidden"],
      deck:         ["8-001", "6-001"], // P1の自動補充ぶん（枯渇→showdownを避ける）
      hands:        { [P1]: ["2-001"], [P2]: ["3-001"], [P3]: ["4-001"] },
    });
    // P1 が 2 を sub → 手番は P2 へ進むが P2 は詰み → 事後パスで P3 までスキップ
    const g = applyAction(game, { type: "play_card", cardId: "2-001", operation: "sub" }, makeCtx(P1));
    expect(g.phase).toBe("normal");
    expect(g.turnOrder[g.currentTurnIndex]).toBe(P3);
    const skips = g.events.filter(e => e.type === "turn_skipped");
    expect(skips.some(e => (e.payload as { playerId: string }).playerId === P2)).toBe(true);
  });

  it("全員が詰み（Odd+Even両方禁止）なら1周スキップ後にshowdownへ強制遷移する", () => {
    const game = makeGame({
      setNumber:    10,
      residualBugs: ["Odd-Forbidden", "Even-Forbidden"],
      deck:         [],
      hands:        { [P1]: ["3-001"], [P2]: ["4-001"], [P3]: ["5-001"] },
    });
    // P1 は詰み → 自分の手番を skip_turn。事後パスで全員スキップ→総詰み→showdown。
    const g = applyAction(game, { type: "skip_turn" }, makeCtx(P1));
    expect(g.phase).toBe("showdown");
    expect(
      g.events.some(e => e.type === "phase_changed" && (e.payload as { reason: string }).reason === "normal_deadlock"),
    ).toBe(true);
  });
});

describe("Scenario: showdown決着", () => {
  it("全員提出後、setNumberに最も近い提出者が勝つ", () => {
    // setNumber=10。P1: 6+3=9(距離1) / P2: 7(距離3) / P3: 9-8=1(距離9)
    const game = makeGame({
      phase: "showdown",
      setNumber: 10,
      hands: { [P1]: ["6-001", "3-001"], [P2]: ["7-001"], [P3]: ["9-001", "8-001"] },
    });
    let g = applyAction(game, { type: "showdown_submit", cardIds: ["6-001", "3-001"], operation: "add" }, makeCtx(P1));
    expect(g.status).toBe("in-progress"); // まだ全員提出していない
    g = applyAction(g, { type: "showdown_submit", cardIds: ["7-001"] }, makeCtx(P2));
    g = applyAction(g, { type: "showdown_submit", cardIds: ["9-001", "8-001"], operation: "sub" }, makeCtx(P3));

    expect(g.status).toBe("finished");
    expect(g.winnerIds).toEqual([P1]);
    expect(g.winnerId).toBe(P1);
    // 提出カードは手札から除外へ
    expect(g.hands[P1]).toHaveLength(0);
    expect(g.excludedCards).toContain("6-001");
  });

  it("距離同値なら枚数の少ない提出が勝つ", () => {
    // setNumber=10。P1: 6+4=10(2枚・距離0) / P2: 9+1=10(2枚・距離0)…ではなく
    // P2は1枚で距離0が作れないので、P1=2枚距離0 vs P2=1枚距離0 の構図にする
    const game = makeGame({
      phase: "showdown",
      setNumber: 9,
      turnOrder: [P1, P2],
      hands: { [P1]: ["6-001", "3-001"], [P2]: ["9-001"], [P3]: [] },
    });
    let g = applyAction(game, { type: "showdown_submit", cardIds: ["6-001", "3-001"], operation: "add" }, makeCtx(P1));
    g = applyAction(g, { type: "showdown_submit", cardIds: ["9-001"] }, makeCtx(P2));

    expect(g.status).toBe("finished");
    expect(g.winnerIds).toEqual([P2]); // 同距離0だが1枚のP2が勝ち
  });

  it("距離も枚数も同じなら全員勝利（winnerIds複数）", () => {
    const game = makeGame({
      phase: "showdown",
      setNumber: 8,
      turnOrder: [P1, P2],
      hands: { [P1]: ["8-001"], [P2]: ["8-002"], [P3]: [] },
    });
    let g = applyAction(game, { type: "showdown_submit", cardIds: ["8-001"] }, makeCtx(P1));
    g = applyAction(g, { type: "showdown_submit", cardIds: ["8-002"] }, makeCtx(P2));

    expect(g.status).toBe("finished");
    expect(g.winnerIds).toEqual([P1, P2]);
  });

  it("二重提出は拒否される", () => {
    const game = makeGame({
      phase: "showdown",
      turnOrder: [P1, P2],
      hands: { [P1]: ["6-001", "3-001"], [P2]: ["7-001"], [P3]: [] },
    });
    const g = applyAction(game, { type: "showdown_submit", cardIds: ["6-001"] }, makeCtx(P1));
    expect(() =>
      applyAction(g, { type: "showdown_submit", cardIds: ["3-001"] }, makeCtx(P1))
    ).toThrow("ACTION_ALREADY_SUBMITTED");
  });

  it("div提出はceil計算・0除算は拒否", () => {
    const game = makeGame({
      phase: "showdown",
      setNumber: 3,
      turnOrder: [P1, P2],
      hands: { [P1]: ["7-001", "3-001"], [P2]: ["5-001", "0-001"] },
    });
    // P1: ceil(7/3)=3 → 距離0
    let g = applyAction(game, { type: "showdown_submit", cardIds: ["7-001", "3-001"], operation: "div" }, makeCtx(P1));
    // P2の0除算は拒否
    expect(() =>
      applyAction(g, { type: "showdown_submit", cardIds: ["5-001", "0-001"], operation: "div" }, makeCtx(P2))
    ).toThrow("ACTION_INVALID_OPERATION");
    g = applyAction(g, { type: "showdown_submit", cardIds: ["5-001"] }, makeCtx(P2));
    expect(g.winnerIds).toEqual([P1]);
  });
});
