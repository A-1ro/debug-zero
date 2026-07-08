import { describe, it, expect } from "vitest";
import { applyAction } from "../../src/server/game/GameEngine";
import { autoActionFor } from "../../src/server/game/AutoAction";
import { raidActor, raidTurnView } from "../../src/server/game/TurnManager";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import {
  SessionService,
  InMemorySessionStorage,
} from "../../src/server/session/SessionService";
import type { Game, PlayerId, SessionId, RoomId, StrategyId, RaidState } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";
import type { EngineContext } from "../../src/server/game/GameEngine";

// CLAUDE.md必須シナリオ: raidBossWin / raidPlayerWin / bugResidual
// レイド戦: 0カード→raid選択でボス討伐戦。bossHP=場のraw合計、プレイヤーHP=10。
// D2: 各ラウンドのバグは「ボスが選択」する（awaitingBugChoice → choose_raid_bug）。
// D3: 手番順は毎ラウンド1D10で決定（ボス除外・降順・同値は当該者のみ振り直し）。
//     RaidState.turnOrder はボスを含まない（§3.4）。

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
      // HPコスト付きバグ（D6テスト用）
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

/** 決定的だが値が変動するRNG（ダイスのタイが解ける）。 */
function seededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** 台本どおりの値を順に返すRNG（末尾に達したら最後の値を繰り返す）。 */
function scriptedRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function makeCtx(actorId: PlayerId, rng: () => number = () => 0.99): EngineContext {
  const registry = new EffectRegistry();
  registerAllHandlers(registry);
  return {
    actorId,
    ruleSet,
    playerStrategies: {},
    effectResolver: new EffectResolver(registry),
    rng,
  };
}

function makeRaidGame(overrides: Partial<Game> = {}): Game {
  // P3がボス（0カードを出してraidを選んだ想定）。レイドはラウンド進行中の状態。
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
      roundIndex: 1,
      turnOrder: [P1, P2],   // D3: ボスを含まないプレイヤーのみ
      currentTurnIndex: 0,
      bossTurn: false,
      bossActionsLeft: 1,    // ceil(2/2)
    },
    events: [],
    ...overrides,
  };
}

describe("Scenario: raid開始（0カード→raid選択）でボスのバグ選択待ちに入る（D2）", () => {
  it("raid選択直後はバグ選択待ち。ボスが選ぶまでバグは発生しない", () => {
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
    // D2: バグ選択待ち。まだバグは発生していない
    expect(g.raidState?.awaitingBugChoice).toBe(true);
    expect(g.raidState?.bugCandidates).toEqual(["Stack-Forbidden", "Odd-Forbidden"]);
    expect(g.residualBugs).toHaveLength(0);
    expect(g.events.some(e => e.type === "bug_activated")).toBe(false);
    expect(g.events.some(e => e.type === "raid_round_started")).toBe(false);
    expect(g.field).toHaveLength(0);
    expect(g.raidState?.roundIndex).toBe(1);
  });

  it("ボスがバグを選ぶとバグが発生し、1D10で手番順が決まりラウンドが始まる（D2/D3）", () => {
    let g = applyAction(
      makeRaidGame({
        phase: "normal",
        raidState: undefined,
        field: [
          { cardId: "9-002", playerId: P1, operation: "add", rawValue: 9, effectiveValue: 9 },
          { cardId: "5-002", playerId: P2, operation: "add", rawValue: 5, effectiveValue: 5 },
          { cardId: "0-001", playerId: P3, operation: "add", rawValue: 0, effectiveValue: 0 },
        ],
        currentTurnIndex: 2,
      }),
      { type: "reset_or_raid", choice: "raid" },
      makeCtx(P3),
    );

    g = applyAction(g, { type: "choose_raid_bug", bugId: "Odd-Forbidden" }, makeCtx(P3, seededRng(7)));

    expect(g.raidState?.awaitingBugChoice).toBe(false);
    expect(g.raidState?.activeBugId).toBe("Odd-Forbidden");
    expect(g.residualBugs).toContain("Odd-Forbidden");
    expect(g.events.some(e => e.type === "bug_activated")).toBe(true);

    const rr = g.events.find(e => e.type === "raid_round_started");
    expect(rr).toBeDefined();
    // D3: diceResults を含む
    expect(rr!.payload.diceResults).toBeDefined();
    expect(Object.keys(rr!.payload.diceResults as object).sort()).toEqual([P1, P2]);
    // ボスは手番順に含まれない
    expect(g.raidState?.turnOrder).not.toContain(P3);
    expect([...(g.raidState?.turnOrder ?? [])].sort()).toEqual([P1, P2]);
    expect(g.raidState?.diceResults).toBeDefined();
    expect(g.raidState?.currentTurnIndex).toBe(0);
  });
});

describe("Scenario: D3 ダイス手番順", () => {
  function makeAwaitingRaid(overrides: Partial<RaidState> = {}): Game {
    const g = makeRaidGame();
    return {
      ...g,
      raidState: {
        ...g.raidState!,
        awaitingBugChoice: true,
        bugCandidates: ["Stack-Forbidden", "Odd-Forbidden"],
        turnOrder: [],
        roundIndex: 1,
        playerHPs: { [P1]: 10, [P2]: 10 },
        ...overrides,
      },
    };
  }

  it("同値タイは当該プレイヤーのみ振り直して順位を決める", () => {
    // P1,P2 とも初回5でタイ → 振り直しで P1=8, P2=2
    // d10 = floor(v*10)+1 なので 0.4→5, 0.49→5, 0.7→8, 0.1→2
    const g = applyAction(
      makeAwaitingRaid(),
      { type: "choose_raid_bug", bugId: "Stack-Forbidden" },
      makeCtx(P3, scriptedRng([0.4, 0.49, 0.7, 0.1])),
    );
    expect(g.raidState?.turnOrder).toEqual([P1, P2]); // 8 > 2
    expect(g.raidState?.diceResults).toEqual({ [P1]: 8, [P2]: 2 }); // 最終ロール
  });

  it("ダイスの降順で手番順が決まる（高い方が先手）", () => {
    // P1=3, P2=9 → P2 が先
    const g = applyAction(
      makeAwaitingRaid(),
      { type: "choose_raid_bug", bugId: "Stack-Forbidden" },
      makeCtx(P3, scriptedRng([0.25, 0.85])),
    );
    expect(g.raidState?.turnOrder).toEqual([P2, P1]);
    expect(g.raidState?.diceResults).toEqual({ [P1]: 3, [P2]: 9 });
  });

  it("プレイヤーが1人（2人戦）ならその1人だけの手番順になる", () => {
    const g = applyAction(
      makeAwaitingRaid({ playerHPs: { [P1]: 10, [P2]: 0 } }), // P2脱落済み
      { type: "choose_raid_bug", bugId: "Stack-Forbidden" },
      makeCtx(P3, seededRng(3)),
    );
    expect(g.raidState?.turnOrder).toEqual([P1]);
    expect(Object.keys(g.raidState?.diceResults ?? {})).toEqual([P1]);
  });

  it("候補が空（全バグ発動済み）ならバグ選択を飛ばして即ラウンド開始", () => {
    const g = applyAction(
      makeRaidGame({
        phase: "normal",
        raidState: undefined,
        residualBugs: ["Stack-Forbidden", "Odd-Forbidden"], // 全バグ発動済み
        field: [
          { cardId: "9-002", playerId: P1, operation: "add", rawValue: 9, effectiveValue: 9 },
          { cardId: "0-001", playerId: P3, operation: "add", rawValue: 0, effectiveValue: 0 },
        ],
        currentTurnIndex: 2,
      }),
      { type: "reset_or_raid", choice: "raid" },
      makeCtx(P3, seededRng(11)),
    );
    // 選択待ちにならず、そのままラウンドが始まる（新バグなし）
    expect(g.raidState?.awaitingBugChoice).toBe(false);
    expect(g.raidState?.activeBugId).toBe("");
    expect(g.events.some(e => e.type === "raid_round_started")).toBe(true);
    expect(g.raidState?.turnOrder).not.toContain(P3);
  });
});

describe("Scenario: D2 バグ選択のバリデーション/代打", () => {
  function makeAwaiting(): Game {
    const g = makeRaidGame();
    return {
      ...g,
      raidState: {
        ...g.raidState!,
        awaitingBugChoice: true,
        bugCandidates: ["Stack-Forbidden", "Odd-Forbidden"],
        turnOrder: [],
      },
    };
  }

  it("ボス以外がバグを選ぶと ACTION_NOT_YOUR_TURN", () => {
    expect(() =>
      applyAction(makeAwaiting(), { type: "choose_raid_bug", bugId: "Stack-Forbidden" }, makeCtx(P1))
    ).toThrow("ACTION_NOT_YOUR_TURN");
  });

  it("候補にないバグを選ぶと ACTION_INVALID_BUG_CHOICE", () => {
    expect(() =>
      applyAction(makeAwaiting(), { type: "choose_raid_bug", bugId: "Value-Corruption" }, makeCtx(P3))
    ).toThrow("ACTION_INVALID_BUG_CHOICE");
  });

  it("選択待ち中は play_card / draw_card / remove_bug が拒否される（ACTION_INVALID_PHASE）", () => {
    const g = makeAwaiting();
    expect(() =>
      applyAction(g, { type: "play_card", cardId: "9-001", operation: "add", targetId: "boss" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_PHASE");
    expect(() =>
      applyAction(g, { type: "draw_card" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_PHASE");
    expect(() =>
      applyAction({ ...g, residualBugs: ["Stack-Forbidden"] }, { type: "remove_bug", bugId: "Stack-Forbidden" }, makeCtx(P1))
    ).toThrow("ACTION_INVALID_PHASE");
  });

  it("タイムアウト代打: ボスに choose_raid_bug（候補内のランダム）が返る", () => {
    const g = makeAwaiting();
    const auto = autoActionFor(g, P3, ruleSet);
    expect(auto?.type).toBe("choose_raid_bug");
    expect(["Stack-Forbidden", "Odd-Forbidden"]).toContain(
      (auto as { type: "choose_raid_bug"; bugId: string }).bugId,
    );
    // 非ボスには代打を返さない
    expect(autoActionFor(g, P1, ruleSet)).toBeNull();
  });
});

describe("Scenario: raidBossWin（ボスHPちょうど0で生存者全員勝利）", () => {
  it("bossHP=14 → 9+5でちょうど0にすると生存プレイヤー全員がwinnerIds", () => {
    const game = makeRaidGame();
    // P1が9でボス攻撃 → bossHP 5
    let g = applyAction(game, { type: "play_card", cardId: "9-001", operation: "add", targetId: "boss" }, makeCtx(P1));
    expect(g.raidState?.bossHP).toBe(5);
    expect(g.status).toBe("in-progress");

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
    const base = makeRaidGame({
      hands: { [P1]: ["6-001"], [P2]: ["4-001"], [P3]: ["7-001"] },
    });
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
    // ボス手番・両プレイヤーHP瀕死の状態を作る（bossTurn=true）
    const game = makeRaidGame({
      hands: { [P1]: ["1-001"], [P2]: ["1-002"], [P3]: ["9-001", "8-001"] },
      raidState: {
        ...makeRaidGame().raidState!,
        playerHPs: { [P1]: 5, [P2]: 3 },
        turnOrder: [P1, P2],
        currentTurnIndex: 2, // ボススロット（bossTurnで判定）
        bossTurn: true,
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
        turnOrder: [P2],      // P1は脱落済み
        currentTurnIndex: 1,
        bossTurn: true,
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
    expect(g.raidState?.bossTurn).toBe(false);
  });

  it("全プレイヤーが動くとボスの手番になる（bossTurn）", () => {
    // P2の手番から P2 が攻撃 → 全員行動済みでボス手番へ
    const game = makeRaidGame({
      raidState: { ...makeRaidGame().raidState!, currentTurnIndex: 1 }, // P2
    });
    const g = applyAction(game, { type: "play_card", cardId: "6-001", operation: "add", targetId: "boss" }, makeCtx(P2));
    expect(g.raidState?.bossTurn).toBe(true);
    expect(raidActor(g.raidState!)).toBe(P3); // ボスが手番
  });

  it("ボスのラウンド行動が終わると次ラウンドのバグ選択待ちに入る（D2）", () => {
    const game = makeRaidGame({
      hands: { [P1]: ["1-001"], [P2]: ["1-002"], [P3]: ["2-001"] },
      raidState: {
        ...makeRaidGame().raidState!,
        turnOrder: [P1, P2],
        currentTurnIndex: 2,
        bossTurn: true,
        bossActionsLeft: 1,  // これで最後のボス行動
      },
    });
    const g = applyAction(game, { type: "play_card", cardId: "2-001", operation: "add", targetId: P1 }, makeCtx(P3));
    // D2: 次ラウンドはボスのバグ選択待ちから始まる（まだバグは出ない）
    expect(g.raidState?.roundIndex).toBe(2);
    expect(g.raidState?.awaitingBugChoice).toBe(true);
    expect(g.raidState?.bugCandidates).toEqual(["Stack-Forbidden", "Odd-Forbidden"]);
    expect(g.residualBugs).toEqual([]);
    expect(g.events.some(e => e.type === "bug_activated")).toBe(false);

    // ボスが選ぶと新ラウンド開始（ダイスで手番順、バグ発生）
    const g2 = applyAction(g, { type: "choose_raid_bug", bugId: "Odd-Forbidden" }, makeCtx(P3, seededRng(5)));
    expect(g2.raidState?.roundIndex).toBe(2);
    expect(g2.raidState?.currentTurnIndex).toBe(0); // ラウンド頭に戻る
    expect(g2.residualBugs).toContain("Odd-Forbidden");
    expect(g2.events.some(e => e.type === "raid_round_started")).toBe(true);
  });
});

describe("action_result のレイド手番投影（サーバ側手番修正）", () => {
  const baseRs: RaidState = {
    bossPlayerId: P3,
    bossHP: 10,
    playerHPs: { [P1]: 10, [P2]: 10 },
    activeBugId: "",
    roundIndex: 1,
    turnOrder: [P2, P1], // ダイス順（ボス除外）
    currentTurnIndex: 1,
    bossTurn: false,
    bossActionsLeft: 1,
  };

  it("プレイヤー手番: ボスを末尾に足した投影で現在手番が引ける", () => {
    expect(raidTurnView(baseRs)).toEqual({ turnOrder: [P2, P1, P3], currentTurnIndex: 1 });
    expect(raidActor(baseRs)).toBe(P1);
  });

  it("ボス手番/バグ選択待ちは投影の末尾（ボス）を指す", () => {
    expect(raidTurnView({ ...baseRs, bossTurn: true })).toEqual({ turnOrder: [P2, P1, P3], currentTurnIndex: 2 });
    expect(raidActor({ ...baseRs, bossTurn: true })).toBe(P3);
    expect(raidActor({ ...baseRs, awaitingBugChoice: true, turnOrder: [] })).toBe(P3);
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
    expect(g.raidState?.turnOrder).toEqual([P2]); // P1が脱落（ボスは元々含まない）
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
        turnOrder: [P1],
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

describe("Scenario: レイド中のForbiddenバグとデッドロック回避（オーナー裁定1/2/3）", () => {
  const rs = () => makeRaidGame().raidState!;

  it("裁定1: ボスはForbiddenバグの影響を受けず、禁止パリティのカードでも攻撃できる", () => {
    // Odd-Forbidden有効。ボス(P3)が奇数7でP1を攻撃 → 通常プレイヤーなら禁止だがボスは免除。
    const game = makeRaidGame({
      residualBugs: ["Odd-Forbidden"],
      hands: { [P1]: ["2-001"], [P2]: ["2-002"], [P3]: ["7-001"] },
      raidState: {
        ...rs(),
        activeBugId: "Odd-Forbidden",
        turnOrder: [P1, P2],
        currentTurnIndex: 2, // ボススロット
        bossTurn: true,
        bossActionsLeft: 1,
      },
    });
    const g = applyAction(
      game,
      { type: "play_card", cardId: "7-001", operation: "add", targetId: P1 },
      makeCtx(P3),
    );
    expect(g.status).toBe("in-progress");
    expect(g.raidState?.playerHPs[P1]).toBe(3); // 10 - 7、免除で成立
  });

  it("裁定1: 同じ奇数カードでも非ボスプレイヤーは Odd-Forbidden で拒否される", () => {
    const game = makeRaidGame({
      residualBugs: ["Odd-Forbidden"],
      hands: { [P1]: ["9-001", "4-001"], [P2]: ["2-001"], [P3]: ["7-001"] },
      raidState: { ...rs(), activeBugId: "Odd-Forbidden", currentTurnIndex: 0 }, // P1の手番
    });
    // 奇数9は禁止
    expect(() =>
      applyAction(game, { type: "play_card", cardId: "9-001", operation: "add", targetId: "boss" }, makeCtx(P1)),
    ).toThrow("ACTION_BUG_FORBIDDEN");
    // 偶数4は合法（回帰: 合法な代替手があるプレイヤーには制約が効き続ける）
    const g = applyAction(
      game,
      { type: "play_card", cardId: "4-001", operation: "add", targetId: "boss" },
      makeCtx(P1),
    );
    expect(g.raidState?.bossHP).toBe(10); // 14 - 4
  });

  it("裁定2: 全札が禁止で補充も除去もできない非ボスプレイヤーは自動スキップされ、ゲームは続行する", () => {
    // Odd-Forbidden有効、山札切れ。P1の手札は全て奇数、除去は偶数札が要るが持っていない → 詰み。
    const game = makeRaidGame({
      deck: [],
      residualBugs: ["Odd-Forbidden"],
      hands: { [P1]: ["9-001", "7-001"], [P2]: ["2-001"], [P3]: ["8-001"] },
      raidState: {
        ...rs(),
        activeBugId: "Odd-Forbidden",
        turnOrder: [P2, P1],
        currentTurnIndex: 0, // P2の手番
        bossActionsLeft: 1,
      },
    });
    // P2が合法な偶数2を出す → 手番はP1へ進むが、P1は詰みなので同一処理内でスキップされボス手番へ
    const g = applyAction(
      game,
      { type: "play_card", cardId: "2-001", operation: "add", targetId: "boss" },
      makeCtx(P2),
    );
    expect(g.status).toBe("in-progress");         // フリーズしない
    expect(g.raidState?.bossHP).toBe(12);          // 14 - 2
    expect(g.raidState?.bossTurn).toBe(true);      // P1はスキップされボス手番へ
    expect(
      g.events.some((e) => e.type === "turn_skipped" && e.payload.playerId === P1),
    ).toBe(true);
  });

  it("裁定3: 詰み手札の代打はForbiddenカードではなく skip_turn を返し、適用してもフリーズしない", () => {
    const game = makeRaidGame({
      deck: [],
      residualBugs: ["Odd-Forbidden"],
      hands: { [P1]: ["9-001", "7-001"], [P2]: ["2-001"], [P3]: ["8-001"] },
      raidState: {
        ...rs(),
        activeBugId: "Odd-Forbidden",
        turnOrder: [P1, P2],
        currentTurnIndex: 0, // P1の手番（詰み）
        bossActionsLeft: 1,
      },
    });
    // 代打はForbiddenなカードプレイではなくスキップ
    const auto = autoActionFor(game, P1, ruleSet);
    expect(auto).toEqual({ type: "skip_turn" });
    // 適用してもフリーズせず手番が進む（アラーム連続性の担保となる合法手）
    const g = applyAction(game, auto!, makeCtx(P1));
    expect(g.status).toBe("in-progress");
    expect(g.events.some((e) => e.type === "turn_skipped")).toBe(true);
    expect(g.raidState?.turnOrder[g.raidState!.currentTurnIndex]).toBe(P2); // 合法手のあるP2へ
  });

  it("裁定2/3: 全札禁止でも偶数札で残バグを除去できるなら skip されず除去が代打になる", () => {
    // P1は奇数9のみだが偶数札4を持ち、Odd-Forbidden(除去コスト=偶数1枚)を払える → 詰みではない
    const game = makeRaidGame({
      deck: [],
      residualBugs: ["Odd-Forbidden"],
      hands: { [P1]: ["9-001", "4-001"], [P2]: ["2-001"], [P3]: ["8-001"] },
      raidState: {
        ...rs(),
        activeBugId: "Odd-Forbidden",
        turnOrder: [P1, P2],
        currentTurnIndex: 0,
        bossActionsLeft: 1,
      },
    });
    // 偶数4は合法カードなので、まずカードプレイが代打になる（除去より優先）
    const auto = autoActionFor(game, P1, ruleSet);
    expect(auto).toEqual({ type: "play_card", cardId: "4-001", operation: "add", targetId: "boss" });
    // skip_turn は合法手があるので拒否される
    expect(() => applyAction(game, { type: "skip_turn" }, makeCtx(P1))).toThrow("ACTION_NO_LEGAL_MOVE");
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

    const finishedGame1: Game = {
      ...start.value.game,
      status: "finished",
      winnerId: P1,
      residualBugs: ["Odd-Forbidden"],
      carriedBugs: [],
    };

    const next = await service.startNextGame({
      sessionId: "s-1" as SessionId,
      finishedGame: finishedGame1,
      ruleSet: { ...ruleSet, strategies: [{ id: "S" as StrategyId, effect: { id: "none", trigger: { type: "on_game_start" }, target: { type: "self" }, action: { type: "noop" } } }] },
      rng: () => 0.5,
    });
    expect(next.ok).toBe(true);
    if (!next.ok) return;

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

    const finishedGame2: Game = { ...game2, status: "finished", winnerId: P2 };
    const third = await service.startNextGame({
      sessionId: "s-1" as SessionId,
      finishedGame: finishedGame2,
      ruleSet: { ...ruleSet, strategies: [{ id: "S" as StrategyId, effect: { id: "none", trigger: { type: "on_game_start" }, target: { type: "self" }, action: { type: "noop" } } }] },
      rng: () => 0.5,
    });
    expect(third.ok).toBe(true);
    if (!third.ok) return;
    expect(third.value.game.residualBugs).toEqual([]);
  });
});
