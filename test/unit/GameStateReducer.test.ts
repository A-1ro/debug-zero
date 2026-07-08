import { describe, it, expect } from "vitest";
import { reducer, type GameState } from "../../src/client/hooks/useGameState";
import type { GameView, PlayerId, GameId, MessageId, RoomId } from "../../src/shared/types/domain";
import type { ServerMessage } from "../../src/shared/types/messages";

// action_result はサーバの権威的な手番情報（turnOrder / currentTurnIndex）を
// そのまま反映し、クライアント側で +1 推測しないことを検証する。
// （0カードは手番を進めない・リセットは0に戻す・脱落でturnOrderが縮むため、
//   推測はサーバ状態と必ずズレる — レビュー指摘B1の回帰テスト）

const p = (s: string) => s as PlayerId;

function gameWith(turnOrder: PlayerId[], currentTurnIndex: number): GameView {
  return {
    id: "game-1" as GameId,
    gameIndex: 0,
    setNumber: 20,
    phase: "normal",
    status: "in-progress",
    deckCount: 30,
    field: [],
    hand: [],
    handCounts: {},
    turnOrder,
    currentTurnIndex,
    resetCount: 0,
    residualBugs: [],
    events: [],
  };
}

function actionResult(
  overrides: Partial<{ turnOrder: PlayerId[]; currentTurnIndex: number }>
): ServerMessage {
  return {
    id: "m-1" as MessageId,
    type: "server:action_result",
    roomId: "room-1" as RoomId,
    gameId: "game-1" as GameId,
    visibility: "all",
    payload: {
      action: { type: "draw_card" },
      actorId: p("alice"),
      effectsApplied: [],
      deckCount: 29,
      turnOrder: overrides.turnOrder ?? [p("alice"), p("bob"), p("carol")],
      currentTurnIndex: overrides.currentTurnIndex ?? 1,
      events: [],
    },
  } as ServerMessage;
}

function stateWith(game: GameView): GameState {
  return { room: null, session: null, game, interventionOffer: null, bossBugChoice: null, error: null };
}

describe("GameState reducer — action_result turn sync (B1)", () => {
  it("サーバのcurrentTurnIndexをそのまま採用する（+1推測しない）", () => {
    // 0カードプレイ時: サーバは手番を進めない（index 0 のまま）
    const state = stateWith(gameWith([p("alice"), p("bob"), p("carol")], 0));
    const next = reducer(state, {
      type: "message",
      payload: actionResult({ currentTurnIndex: 0 }),
    });
    expect(next.game?.currentTurnIndex).toBe(0); // 推測なら1になってしまう
  });

  it("リセットで手番が0に巻き戻るケースを反映する", () => {
    const state = stateWith(gameWith([p("alice"), p("bob"), p("carol")], 2));
    const next = reducer(state, {
      type: "message",
      payload: actionResult({ currentTurnIndex: 0 }),
    });
    expect(next.game?.currentTurnIndex).toBe(0);
  });

  it("脱落でturnOrderが縮んだ場合はサーバのturnOrderで置き換える", () => {
    const state = stateWith(gameWith([p("alice"), p("bob"), p("carol")], 1));
    const next = reducer(state, {
      type: "message",
      payload: actionResult({ turnOrder: [p("alice"), p("carol")], currentTurnIndex: 1 }),
    });
    expect(next.game?.turnOrder).toEqual([p("alice"), p("carol")]);
    expect(next.game?.currentTurnIndex).toBe(1);
  });
});

// ------------------------------------------------------------
// D2: boss raid-bug choice offer (server:boss_bug_choice) flows into
// bossBugChoice and is cleared once the round actually starts.
// ------------------------------------------------------------

function bossBugChoiceMsg(
  candidates: string[],
  roundIndex = 0,
  deadline = Date.now() + 5000
): ServerMessage {
  return {
    id: "m-bbc" as MessageId,
    type: "server:boss_bug_choice",
    roomId: "room-1" as RoomId,
    gameId: "game-1" as GameId,
    visibility: "player",
    targetPlayerId: p("boss"),
    payload: { gameId: "game-1" as GameId, roundIndex, candidates, timeoutMs: 5000, deadline },
  } as ServerMessage;
}

function raidRoundStartedMsg(
  overrides: Partial<{
    roundIndex: number;
    activeBugId: string;
    turnOrder: PlayerId[];
    diceResults: Record<PlayerId, number>;
  }> = {}
): ServerMessage {
  return {
    id: "m-rrs" as MessageId,
    type: "server:raid_round_started",
    roomId: "room-1" as RoomId,
    gameId: "game-1" as GameId,
    visibility: "all",
    payload: {
      roundIndex:  overrides.roundIndex  ?? 1,
      activeBugId: overrides.activeBugId ?? "null-pointer",
      turnOrder:   overrides.turnOrder   ?? [p("bob"), p("alice")],
      diceResults: overrides.diceResults ?? { [p("alice")]: 3, [p("bob")]: 8 },
    },
  } as ServerMessage;
}

describe("GameState reducer — boss raid-bug choice (D2)", () => {
  it("server:boss_bug_choice で bossBugChoice に候補が入る", () => {
    const state = stateWith(gameWith([p("alice"), p("bob")], 0));
    const next = reducer(state, {
      type: "message",
      payload: bossBugChoiceMsg(["null-pointer", "race-condition"], 0),
    });
    expect(next.bossBugChoice).not.toBeNull();
    expect(next.bossBugChoice?.candidates).toEqual(["null-pointer", "race-condition"]);
    expect(next.bossBugChoice?.roundIndex).toBe(0);
  });

  it("ラウンド開始（server:raid_round_started）で offer がクリアされる", () => {
    const withOffer: GameState = {
      ...stateWith(gameWith([p("alice"), p("bob")], 0)),
      bossBugChoice: { roundIndex: 0, candidates: ["null-pointer"], timeoutMs: 5000, deadline: Date.now() + 5000 },
    };
    const next = reducer(withOffer, { type: "message", payload: raidRoundStartedMsg() });
    expect(next.bossBugChoice).toBeNull();
  });

  it("state_sync で offer は復元されずクリアされる", () => {
    const withOffer: GameState = {
      ...stateWith(gameWith([p("alice"), p("bob")], 0)),
      bossBugChoice: { roundIndex: 0, candidates: ["null-pointer"], timeoutMs: 5000, deadline: Date.now() + 5000 },
    };
    const syncMsg = {
      id: "m-sync" as MessageId,
      type: "server:state_sync",
      roomId: "room-1" as RoomId,
      visibility: "player",
      payload: { room: null, session: null, game: null },
    } as ServerMessage;
    const next = reducer(withOffer, { type: "message", payload: syncMsg });
    expect(next.bossBugChoice).toBeNull();
  });
});

describe("GameState reducer — raid round dice/roundIndex refresh (D3)", () => {
  it("server:raid_round_started が raidState の dice/turnOrder/bug を更新する", () => {
    const base = gameWith([p("alice"), p("bob")], 0);
    base.phase = "raid";
    base.raidState = {
      bossPlayerId:     p("boss"),
      bossHP:           50,
      playerHPs:        { [p("alice")]: 10, [p("bob")]: 10 },
      activeBugId:      "old-bug",
      roundIndex:       0,
      turnOrder:        [p("alice"), p("bob")],
      currentTurnIndex: 0,
      bossActionsLeft:  1,
      diceResults:      { [p("alice")]: 1, [p("bob")]: 2 },
      awaitingBugChoice: true,
    };
    const next = reducer(stateWith(base), {
      type: "message",
      payload: raidRoundStartedMsg({
        roundIndex: 2,
        activeBugId: "race-condition",
        turnOrder: [p("bob"), p("alice")],
        diceResults: { [p("alice")]: 4, [p("bob")]: 9 },
      }),
    });
    expect(next.game?.raidState?.roundIndex).toBe(2);
    expect(next.game?.raidState?.activeBugId).toBe("race-condition");
    expect(next.game?.raidState?.turnOrder).toEqual([p("bob"), p("alice")]);
    expect(next.game?.raidState?.diceResults).toEqual({ [p("alice")]: 4, [p("bob")]: 9 });
    expect(next.game?.raidState?.awaitingBugChoice).toBe(false);
    // 既存フィールド（HP等）は保持される
    expect(next.game?.raidState?.bossHP).toBe(50);
  });
});
