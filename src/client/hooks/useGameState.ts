import { useReducer, useCallback } from "react";
import type { Room, Session, GameView } from "../../shared/types/domain";
import type { ServerMessage } from "../../shared/types/messages";

// ============================================================
// State shape
// ============================================================

export interface GameState {
  room:    Room    | null;
  session: Session | null;
  game:    GameView | null;
  error:   { code: string; message: string; recoverable: boolean } | null;
}

const initialState: GameState = {
  room:    null,
  session: null,
  game:    null,
  error:   null,
};

// ============================================================
// Reducer
// ============================================================

type Action = { type: "message"; payload: ServerMessage } | { type: "reset" };

function reducer(state: GameState, action: Action): GameState {
  if (action.type === "reset") return initialState;

  const msg = action.payload;

  switch (msg.type) {
    case "server:room_updated": {
      const p = msg.payload as { room: Room };
      return { ...state, room: p.room, error: null };
    }

    case "server:session_started": {
      const p = msg.payload as { sessionId: string; players: Session["players"]; ruleSetId: string };
      const session: Session = {
        id:               p.sessionId,
        roomId:           state.room?.id ?? "",
        ruleSetId:        p.ruleSetId,
        players:          p.players,
        gameIds:          [],
        currentGameIndex: 0,
        status:           "in-progress",
      };
      return { ...state, session, error: null };
    }

    case "server:game_started": {
      const p = msg.payload as {
        gameId: string; gameIndex: number; setNumber: number;
        turnOrder: string[]; deckCount: number; residualBugs: string[];
        hand: string[]; handCounts: Record<string, number>;
      };
      const game: GameView = {
        id:               p.gameId,
        gameIndex:        p.gameIndex,
        setNumber:        p.setNumber,
        phase:            "normal",
        status:           "in-progress",
        deckCount:        p.deckCount,
        field:            [],
        hand:             p.hand,
        handCounts:       p.handCounts,
        turnOrder:        p.turnOrder,
        currentTurnIndex: 0,
        resetCount:       0,
        residualBugs:     p.residualBugs,
        events:           [],
      };
      const session = state.session
        ? { ...state.session, gameIds: [...state.session.gameIds, p.gameId], currentGameIndex: state.session.currentGameIndex + 1 }
        : state.session;
      return { ...state, session, game, error: null };
    }

    case "server:hand_updated": {
      const p = msg.payload as { hand: string[] };
      if (!state.game) return state;
      return { ...state, game: { ...state.game, hand: p.hand } };
    }

    case "server:action_result": {
      const p = msg.payload as { deckCount: number; events: GameView["events"] };
      if (!state.game) return state;
      return {
        ...state,
        game: {
          ...state.game,
          deckCount: p.deckCount,
          events: [...state.game.events, ...p.events],
        },
      };
    }

    case "server:phase_changed": {
      const p = msg.payload as { from: string; to: GameView["phase"]; raidState?: GameView["raidState"] };
      if (!state.game) return state;
      return {
        ...state,
        game: { ...state.game, phase: p.to, raidState: p.raidState },
      };
    }

    case "server:game_ended": {
      const p = msg.payload as { sessionPlayers: Session["players"] };
      const session = state.session ? { ...state.session, players: p.sessionPlayers } : state.session;
      const game = state.game ? { ...state.game, status: "finished" as const } : state.game;
      return { ...state, session, game, error: null };
    }

    case "server:session_ended": {
      const p = msg.payload as { sessionId: string; winnerId: string; players: Session["players"] };
      const session = state.session
        ? { ...state.session, status: "finished" as const, winnerId: p.winnerId, players: p.players }
        : state.session;
      return { ...state, session, error: null };
    }

    case "server:state_sync": {
      // Full state overwrite on reconnect
      const p = msg.payload as { room: Room; session: Session; game: GameView };
      return { room: p.room, session: p.session, game: p.game, error: null };
    }

    case "server:error": {
      const p = msg.payload as { code: string; message: string; recoverable: boolean };
      return { ...state, error: { code: p.code, message: p.message, recoverable: p.recoverable } };
    }

    default:
      return state;
  }
}

// ============================================================
// Hook
// ============================================================

export function useGameState() {
  const [state, dispatch] = useReducer(reducer, initialState);

  const applyMessage = useCallback((msg: ServerMessage) => {
    dispatch({ type: "message", payload: msg });
  }, []);

  const reset = useCallback(() => {
    dispatch({ type: "reset" });
  }, []);

  return { state, applyMessage, reset };
}
