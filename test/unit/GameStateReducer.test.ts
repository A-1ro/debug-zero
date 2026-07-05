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
  return { room: null, session: null, game, error: null };
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
