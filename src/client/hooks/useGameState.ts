import { useReducer, useCallback } from "react";
import type { Room, Session, GameView } from "../../shared/types/domain";
import type { ServerMessage } from "../../shared/types/messages";

// ============================================================
// State shape
// ============================================================

export interface GameState {
  room:    Room     | null;
  session: Session  | null;
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

// Exported for unit tests (pure function — no React needed)
export function reducer(state: GameState, action: Action): GameState {
  if (action.type === "reset") return initialState;

  const msg = action.payload;

  // ServerMessage is a discriminated union — type narrows payload without casts
  switch (msg.type) {
    case "server:room_updated":
      return { ...state, room: msg.payload.room, error: null };

    case "server:session_started": {
      const { sessionId, players, ruleSetId } = msg.payload;
      const session: Session = {
        id:               sessionId,
        roomId:           state.room?.id ?? "",
        ruleSetId,
        players,
        gameIds:          [],
        currentGameIndex: 0,
        status:           "in-progress",
      };
      return { ...state, session, error: null };
    }

    case "server:game_started": {
      const { gameId, gameIndex, setNumber, turnOrder, deckCount, residualBugs, hand, handCounts } = msg.payload;
      const game: GameView = {
        id:               gameId,
        gameIndex,
        setNumber,
        phase:            "normal",
        status:           "in-progress",
        deckCount,
        field:            [],
        hand,
        handCounts,
        turnOrder,
        currentTurnIndex: 0,
        resetCount:       0,
        residualBugs,
        events:           [],
      };
      const session = state.session
        ? {
            ...state.session,
            gameIds:          [...state.session.gameIds, gameId],
            currentGameIndex: gameIndex,
          }
        : state.session;
      return { ...state, session, game, error: null };
    }

    case "server:hand_updated":
      if (!state.game) return state;
      return { ...state, game: { ...state.game, hand: msg.payload.hand } };

    case "server:action_result": {
      if (!state.game) return state;
      const { deckCount, events, fieldCard, fieldOverride, newSetNumber, handCounts,
              turnOrder, currentTurnIndex } = msg.payload;
      const newField = fieldOverride !== undefined
        ? fieldOverride
        : fieldCard
          ? [...state.game.field, fieldCard]
          : state.game.field;
      return {
        ...state,
        game: {
          ...state.game,
          deckCount,
          setNumber:        newSetNumber ?? state.game.setNumber,
          field:            newField,
          handCounts:       handCounts ?? state.game.handCounts,
          // Server is the single source of truth for turn state — never guess here
          // (zero-card keeps the turn, reset rewinds to 0, eliminations shrink turnOrder)
          turnOrder:        turnOrder ?? state.game.turnOrder,
          currentTurnIndex: currentTurnIndex ?? state.game.currentTurnIndex,
          events:           [...state.game.events, ...events],
        },
      };
    }

    case "server:phase_changed": {
      if (!state.game) return state;
      const { reason } = msg.payload;
      return {
        ...state,
        game: {
          ...state.game,
          phase:     msg.payload.to,
          raidState: msg.payload.raidState,
          // Clear field when a new set starts (reset) or raid begins (field moves to excludedCards)
          field:     reason === "card_zero_played_reset" || reason === "card_zero_played_raid"
            ? []
            : state.game.field,
        },
      };
    }

    case "server:game_ended": {
      const session = state.session
        ? { ...state.session, players: msg.payload.sessionPlayers }
        : state.session;
      const game = state.game ? { ...state.game, status: "finished" as const } : state.game;
      return { ...state, session, game, error: null };
    }

    case "server:session_ended": {
      const session = state.session
        ? {
            ...state.session,
            status:   "finished" as const,
            winnerId: msg.payload.winnerId,
            players:  msg.payload.players,
          }
        : state.session;
      return { ...state, session, error: null };
    }

    case "server:state_sync":
      // Full state overwrite on reconnect (session/game may be null in waiting phase)
      return {
        room:    msg.payload.room,
        session: msg.payload.session,
        game:    msg.payload.game,
        error:   null,
      };

    case "server:error":
      return {
        ...state,
        error: {
          code:        msg.payload.code,
          message:     msg.payload.message,
          recoverable: msg.payload.recoverable,
        },
      };

    case "server:raid_round_started":
      // Phase display only — no state update needed at this layer
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
