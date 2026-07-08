import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/server/game/GameEngine";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import {
  SessionService,
  InMemorySessionStorage,
} from "../../src/server/session/SessionService";
import type { Game, PlayerId, SessionId, RoomId, StrategyId } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";
import type { EngineContext } from "../../src/server/game/GameEngine";

// CLAUDE.md必須シナリオ: raidBossWin / raidPlayerWin / bugResidual
// レイド戦: 0カード→raid選択でボス討伐戦。bossHP=場のraw合計、プレイヤーHP=10。
// プレイヤーはボスを攻撃、ボスは各ラウンド ceil(人数/2) 回プレイヤーを攻撃。

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;
const P3 = "player-3" as PlayerId;

const ruleSet: RuleSet = {
  id: "basic",
  version: "1.0",
  deck: { cards: [{ value: 1, count: 10 }] },
  strategies: [],
  bugs: [
    {
      // HPコスト付きバグ（D6テスト用）。Odd-Forbiddenより前に置く:
      // rng=0.99のpickRaidBugは候補末尾を選ぶため、既存テストの
      // 「新ラウンドでOdd-Forbiddenが発生する」期待値を保つ
      id: "Stack-Forbidden",
      effect: {
        id: "basic:stackForbidden",
        trigger: { type: "always" },
        target: { type: "all_players" },
        action: { type: "forbid_stack" },
      },
      removalCost: { type: "hp", amount: 3 },
    },
    {
      id: "Odd-Forbidden",
      effect: {
        id: "basic:oddForbidden",
        trigger: { type: "on_card_played" },
        target: { type: "all_players" },
        action: { type: "forbid_parity", parity: "odd" },
      },
      removalCost: { type: "hand_card", value: "even", amount: 1 },
    },
  ],
  phases: [
    { id: "normal",   transitionConditions: [{ type: "deck_empty", to: "showdown" }] },
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
    rng: () => 0.99, // 決定的（バグ候補の末尾を選ぶ）
  };
}

function makeRaidGame(overrides: Partial<Game> = {}): Game {
  // P3がボス（0カードを出してraidを選んだ想定）
  return {
    id: "game-1",
    sessionId: "session-1",
    gameIndex: 1,
    setNumber: 0,
    phase: "raid",
    status: "in-progress",
    deck: ["1-001", "1-002"],
    excludedCards: [],
    field: [],
    hands: {
      [P1]: ["9-001", "5-001"],
      [P2]: ["6-001", "4-001"],
      [P3]: ["7-001", "8-001"],
    },
    usedStrategyCounts: { [P1]: {}, [P2]: {}, [P3]: {} },
    turnOrder: [P1, P2, P3],
    currentTurnIndex: 0,
    resetCount: 0,
    residualBugs: [],
    raidState: {
      bossPlayerId: P3,
      bossHP: 14,
      playerHPs: { [P1]: 10, [P2]: 10 },
      activeBugId: "",
      roundIndex: 1, // 1始まり（detail-design.md §3 RaidState）
      turnOrder: [P1, P2, P3], // プレイヤー→最後にボス
      currentTurnIndex: 0,
      bossActionsLeft: 1, // ceil(2/2)
    },
    events: [],
    ...overrides,
  };
}

describe("Scenario: raid開始（0カード→raid選択）", () => {
  it("bossHP=場のraw合計・プレイヤーHP=10・バグが1つ発生する", () => {
    const game = makeRaidGame({
      phase: "normal",
      raidState: undefined,
      field: [
        { cardId: "9-002", playerId: P1, operation: "add", rawValue: 9, effectiveValue: 9 },
        { cardId: "5-002", playerId: P2, operation: "add", rawValue: 5, effectiveValue: 5 },
        { cardId: "0-001", playerId: P3, operation: "add", rawValue: 0, effectiveValue: 0 },
      ],
      setNumber: 0,
      currentTurnIndex: 2, // P3の手番（0カードを出した直後）
    });
    const g = applyAction(game, { type: "reset_or_raid", choice: "raid" }, makeCtx(P3));

    expect(g.phase).toBe("raid");
    expect(g.raidState?.bossHP).toBe(14); // 9+5+0
    expect(g.raidState?.bossPlayerId).toBe(P3);
    expect(g.raidState?.playerHPs).toEqual({ [P1]: 10, [P2]: 10 });
    expect(g.raidState?.turnOrder).toEqual([P1, P2, P3]); // ボスは最後
    expect(g.raidState?.roundIndex).toBe(1); // D11: 1始まり
    expect(g.field).toHaveLength(0);
    expect(g.residualBugs).toHaveLength(1); // ラウンド開始でバグ発生
    expect(g.events.some(e => e.type === "bug_activated")).toBe(true);
  });
});

describe("Scenario: raidBossWin（ボスHPちょうど0で生存者全員勝利）", () => {
  it("bossHP=14 → 9+5でちょうど0にすると生存プレイヤー全員がwinnerIds", () => {
    const game = makeRaidGame();
    // P1が9でボス攻撃 → bossHP 5
    let g = applyAction(game, { type: "play_card", cardId: "9-001", operation: "add", targetId: "boss" }, makeCtx(P1));
    expect(g.raidState?.bossHP).toBe(5);
    expect(g.status).toBe("in-progress");
    // P2が5…は持ってないので構成上P2の5はP1に。P2は4を出すとbossHP=1になるためやり直し。
    // → P2が6を出すと-1(below zero)なので、このテストでは5を持つP2にする
    const game2 = makeRaidGame({
      hands: { [P1]: ["9-001"], [P2]: ["5-001"], [P3]: ["7-001"] },
    });
    g = applyAction(game2, { type: "play_card", cardId: "9-001", operation: "add", targetId: "boss" }, makeCtx(P1));
    g = applyAction(g, { type: "play_card", cardId: "5-001", operation: "add", targetId: "boss" }, makeCtx(P2));

    expect(g.raidState?.bossHP).toBe(0);
    expect(g.status).toBe("finished");
    expect(g.winnerIds).toEqual([P1, P2]); // 生存者全員（ボスは含まない）
    expect(g.residualBugs).toEqual([]); // ちょうど0はバグもクリア
  });

  it("bossHPが0未満ならトドメを刺したプレイヤーだけが勝つ＋バグは残留する", () => {
    // bossHP=5の状態でP1が6を出す → -1 (below zero)
    const base = makeRaidGame({
      hands: { [P1]: ["6-001"], [P2]: ["4-001"], [P3]: ["7-001"] },
      residualBugs: ["Even-Forbidden"], // raid中に発生済みの別バグ（プレイ制約に触れない構成にしない）
    });
    // Even-Forbiddenだと6が出せないので、制約に触れないダミーIDを使う
    const game = { ...base, residualBugs: ["Loop-Trap"] };
    const g = applyAction(
      { ...game, raidState: { ...game.raidState!, bossHP: 5 } },
      { type: "play_card", cardId: "6-001", operation: "add", targetId: "boss" },
      makeCtx(P1)
    );
    expect(g.raidState?.bossHP).toBe(-1);
    expect(g.status).toBe("finished");
    expect(g.winnerIds).toEqual([P1]); // トドメを刺したP1だけ
    expect(g.residualBugs).toEqual(["Loop-Trap"]); // below zeroはバグ残留
  });
});

describe("Scenario: raidPlayerWin（全プレイヤーHP0でボスのセッション勝利）", () => {
  it("ボスの攻撃で全プレイヤーHPが0以下になるとゲーム終了・勝者なし", () => {
    // ボス手番・両プレイヤーHP瀕死の状態を作る
    const game = makeRaidGame({
      hands: { [P1]: ["1-001"], [P2]: ["1-002"], [P3]: ["9-001", "8-001"] },
      raidState: {
        ...makeRaidGame().raidState!,
        playerHPs: { [P1]: 5, [P2]: 3 },
        currentTurnIndex: 2, // ボスの手番
        bossActionsLeft: 2,
      },
    });
    // ボスがP1へ9 → P1のHP -4で脱落
    let g = applyAction(game, { type: "play_card", cardId: "9-001", operation: "add", targetId: P1 }, makeCtx(P3));
    expect(g.raidState?.playerHPs[P1]).toBeLessThanOrEqual(0);
    expect(g.raidState?.turnOrder).not.toContain(P1); // 脱落
    expect(g.status).toBe("in-progress"); // P2がまだ生存
    // ボスがP2へ8 → 全滅
    g = applyAction(g, { type: "play_card", cardId: "8-001", operation: "add", targetId: P2 }, makeCtx(P3));
    expect(g.status).toBe("finished");
    expect(g.winnerId).toBeUndefined(); // 勝者なし＝ボスのセッション勝利（DO側でendSession）
    expect(g.events.some(e => e.type === "game_ended")).toBe(true);
  });

  it("ボスは生存プレイヤーしか攻撃できない", () => {
    const game = makeRaidGame({
      raidState: {
        ...makeRaidGame().raidState!,
        playerHPs: { [P1]: 0, [P2]: 10 },
        turnOrder: [P2, P3],
        currentTurnIndex: 1, // ボス手番
      },
    });
    expect(() =>
      applyAction(game, { type: "play_card", cardId: "7-001", operation: "add", targetId: P1 }, makeCtx(P3))
    ).toThrow("ACTION_INVALID_CARD");
  });
});

describe("Scenario: raidの手番と補充", () => {
  it("プレイヤーの手番でないと攻撃できない", () => {
    const game = makeRaidGame(); // P1の手番
    expect(() =>
      applyAction(game, { type: "play_card", cardId: "6-001", operation: "add", targetId: "boss" }, makeCtx(P2))
    ).toThrow("ACTION_NOT_YOUR_TURN");
  });

  it("手札補充(draw)は1枚引いて手番が進む", () => {
    const game = makeRaidGame();
    const g = applyAction(game, { type: "draw_card" }, makeCtx(P1));
    expect(g.hands[P1]).toHaveLength(3);
    expect(g.raidState?.currentTurnIndex).toBe(1); // P2へ
  });

  it("ボスのラウンド行動が終わるとラウンドが進み新しいバグが発生する", () => {
    const game = makeRaidGame({
      hands: { [P1]: ["1-001"], [P2]: ["1-002"], [P3]: ["2-001"] },
      raidState: {
        ...makeRaidGame().raidState!,
        currentTurnIndex: 2, // ボス手番
        bossActionsLeft: 1,  // これで最後のボス行動
      },
    });
    const g = applyAction(game, { type: "play_card", cardId: "2-001", operation: "add", targetId: P1 }, makeCtx(P3));
    expect(g.raidState?.roundIndex).toBe(2); // ラウンド1 → 2（1始まり）
    expect(g.raidState?.currentTurnIndex).toBe(0); // ラウンド頭に戻る
    expect(g.residualBugs).toContain("Odd-Forbidden"); // 新ラウンドでバグ発生
    expect(g.events.some(e => e.type === "raid_round_started")).toBe(true);
  });
});

describe("Scenario: バグ除去のHPコストで脱落・全滅する（D6）", () => {
  it("HP3ちょうどでHP-3コストを払うとHP0になり脱落し、他プレイヤーが残ればゲームは続行する", () => {
    const game = makeRaidGame({
      residualBugs: ["Stack-Forbidden"],
      raidState: {
        ...makeRaidGame().raidState!,
        playerHPs: { [P1]: 3, [P2]: 10 },
        activeBugId: "Stack-Forbidden",
        currentTurnIndex: 0, // P1の手番
      },
    });

    const g = applyAction(game, { type: "remove_bug", bugId: "Stack-Forbidden" }, makeCtx(P1));

    expect(g.raidState?.playerHPs[P1]).toBe(0);
    expect(g.raidState?.turnOrder).toEqual([P2, P3]); // P1が脱落
    expect(g.raidState?.turnOrder[g.raidState!.currentTurnIndex]).toBe(P2); // 手番はP2へ
    expect(g.residualBugs).not.toContain("Stack-Forbidden"); // 除去自体は成立
    expect(g.status).toBe("in-progress"); // P2が生存しているため続行
    expect(g.events.some(
      e => e.type === "player_eliminated" && e.payload.playerId === P1
    )).toBe(true);
  });

  it("最後の1人がHPコストで倒れると全滅＝ボス勝利でゲーム終了する", () => {
    // P2は既にHP0で脱落済み、生存者はP1のみ（HP3）
    const game = makeRaidGame({
      residualBugs: ["Stack-Forbidden"],
      raidState: {
        ...makeRaidGame().raidState!,
        playerHPs: { [P1]: 3, [P2]: 0 },
        activeBugId: "Stack-Forbidden",
        turnOrder: [P1, P3],
        currentTurnIndex: 0, // P1の手番
      },
    });

    const g = applyAction(game, { type: "remove_bug", bugId: "Stack-Forbidden" }, makeCtx(P1));

    expect(g.raidState?.playerHPs[P1]).toBe(0);
    expect(g.status).toBe("finished");
    expect(g.winnerId).toBeUndefined(); // 勝者なし＝ボスのセッション勝利（DO側でendSession）
    expect(g.events.some(
      e => e.type === "game_ended" && e.payload.winType === "raid_all_players_dead"
    )).toBe(true);
  });

  it("HPがコスト未満だと除去できない（ACTION_INVALID_BUG_REMOVAL_COST）", () => {
    const game = makeRaidGame({
      residualBugs: ["Stack-Forbidden"],
      raidState: {
        ...makeRaidGame().raidState!,
        playerHPs: { [P1]: 2, [P2]: 10 },
        activeBugId: "Stack-Forbidden",
        currentTurnIndex: 0,
      },
    });

    expect(() =>
      applyAction(game, { type: "remove_bug", bugId: "Stack-Forbidden" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_BUG_REMOVAL_COST");
  });
});

describe("Scenario: bugResidual（バグ残留と1ゲーム後クリア）", () => {
  it("below-zero勝利で残ったバグは次ゲームに引き継がれ、そのゲーム中は除去不可、その次のゲームでクリアされる", async () => {
    const service = new SessionService(new InMemorySessionStorage());
    const start = await service.startSession({
      roomId: "r-1" as RoomId,
      sessionId: "s-1" as SessionId,
      players: [
        { playerId: P1, strategyId: "S" as StrategyId },
        { playerId: P2, strategyId: "S" as StrategyId },
      ],
      ruleSetId: "basic",
      ruleSet: { ...ruleSet, strategies: [{ id: "S" as StrategyId, effect: { id: "none", trigger: { type: "on_game_start" }, target: { type: "self" }, action: { type: "noop" } } }] },
      rng: () => 0.5,
    });
    expect(start.ok).toBe(true);
    if (!start.ok) return;

    // ゲーム1がbelow-zeroで終わり、Odd-Forbiddenが残留した状態を作る
    const finishedGame1: Game = {
      ...start.value.game,
      status: "finished",
      winnerId: P1,
      residualBugs: ["Odd-Forbidden"],
      carriedBugs: [], // このゲームで新規発生
    };

    const next = await service.startNextGame({
      sessionId: "s-1" as SessionId,
      finishedGame: finishedGame1,
      ruleSet: { ...ruleSet, strategies: [{ id: "S" as StrategyId, effect: { id: "none", trigger: { type: "on_game_start" }, target: { type: "self" }, action: { type: "noop" } } }] },
      rng: () => 0.5,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;

    // ゲーム2: バグが引き継がれ、carriedBugsに入る（=除去不可）
    const game2 = next.value.game;
    expect(game2.residualBugs).toEqual(["Odd-Forbidden"]);
    expect(game2.carriedBugs).toEqual(["Odd-Forbidden"]);
    expect(() =>
      applyAction(
        { ...game2, hands: { ...game2.hands, [P1]: ["2-099", ...game2.hands[P1]] } },
        { type: "remove_bug", bugId: "Odd-Forbidden", costCardIds: ["2-099"] },
        makeCtx(P1)
      )
    ).toThrow("ACTION_INVALID_CARD");

    // ゲーム2が終了 → ゲーム3では引き継ぎ分がクリアされる
    const finishedGame2: Game = { ...game2, status: "finished", winnerId: P2 };
    const third = await service.startNextGame({
      sessionId: "s-1" as SessionId,
      finishedGame: finishedGame2,
      ruleSet: { ...ruleSet, strategies: [{ id: "S" as StrategyId, effect: { id: "none", trigger: { type: "on_game_start" }, target: { type: "self" }, action: { type: "noop" } } }] },
      rng: () => 0.5,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.game.residualBugs).toEqual([]); // 1ゲーム後にクリア
  });
});
