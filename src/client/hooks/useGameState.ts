import { useReducer, useCallback } from "react";
import type { Room, Session, GameView, FieldCard, StrategyId, BugId } from "../../shared/types/domain";
import type { ServerMessage } from "../../shared/types/messages";

// ============================================================
// State shape
// ============================================================

/** A1: a private intervention offer addressed to this player. */
export interface InterventionOffer {
  triggerCard: FieldCard;
  strategyId:  StrategyId;
  timeoutMs:   number;
  deadline:    number;
}

/** D2: a private "choose this raid round's bug" offer addressed to the boss. */
export interface BossBugChoiceOffer {
  roundIndex: number;
  candidates: BugId[];
  timeoutMs:  number;
  deadline:   number;
}

export interface GameState {
  room:    Room     | null;
  session: Session  | null;
  game:    GameView | null;
  /** A1: set while this player holds an unanswered intervention offer. */
  interventionOffer: InterventionOffer | null;
  /** D2: set while the boss holds an unanswered raid-bug choice offer. */
  bossBugChoice: BossBugChoiceOffer | null;
  error:   { code: string; message: string; recoverable: boolean } | null;
}

const initialState: GameState = {
  room:    null,
  session: null,
  game:    null,
  interventionOffer: null,
  bossBugChoice: null,
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
              turnOrder, currentTurnIndex, interventionPending } = msg.payload;
      const newField = fieldOverride !== undefined
        ? fieldOverride
        : fieldCard
          ? [...state.game.field, fieldCard]
          : state.game.field;
      return {
        ...state,
        // A1: once the freeze lifts (all candidates responded / timed out),
        // any offer still shown locally is stale — drop it
        interventionOffer: interventionPending ? state.interventionOffer : null,
        game: {
          ...state.game,
          deckCount,
          setNumber:        newSetNumber ?? state.game.setNumber,
          field:            newField,
          handCounts:       handCounts ?? state.game.handCounts,
          interventionPending: interventionPending ?? false,
          // Server is the single source of truth for turn state — never guess here
          // (zero-card keeps the turn, reset rewinds to 0, eliminations shrink turnOrder)
          turnOrder:        turnOrder ?? state.game.turnOrder,
          currentTurnIndex: currentTurnIndex ?? state.game.currentTurnIndex,
          events:           [...state.game.events, ...events],
        },
      };
    }

    case "server:intervention_offer":
      return {
        ...state,
        interventionOffer: {
          triggerCard: msg.payload.triggerCard,
          strategyId:  msg.payload.strategyId,
          timeoutMs:   msg.payload.timeoutMs,
          deadline:    msg.payload.deadline,
        },
      };

    case "server:boss_bug_choice":
      // D2: private offer to the boss to pick this round's bug.
      return {
        ...state,
        bossBugChoice: {
          roundIndex: msg.payload.roundIndex,
          candidates: msg.payload.candidates,
          timeoutMs:  msg.payload.timeoutMs,
          deadline:   msg.payload.deadline,
        },
      };

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
            status:    "finished" as const,
            winnerId:  msg.payload.winnerId,
            winnerIds: msg.payload.winnerIds ?? (msg.payload.winnerId ? [msg.payload.winnerId] : []),
            players:   msg.payload.players,
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
        // A private offer cannot be reconstructed from state_sync — the server
        // will time it out (pass / random fallback) if it is still open
        interventionOffer: null,
        bossBugChoice:     null,
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

    case "server:raid_round_started": {
      // D2/D3: a new raid round began. The boss's bug choice (if any) is now
      // resolved — drop any offer still shown locally. Also refresh the raid
      // display with this round's diced turn order + chosen bug so multi-round
      // raids stay current (raidState is otherwise only set at phase change).
      const { roundIndex, activeBugId, turnOrder, diceResults } = msg.payload;
      const raidState = state.game?.raidState
        ? { ...state.game.raidState, roundIndex, activeBugId, turnOrder, diceResults,
            awaitingBugChoice: false }
        : state.game?.raidState;
      return {
        ...state,
        bossBugChoice: null,
        game: state.game ? { ...state.game, raidState } : state.game,
      };
    }
  }

  // Unknown / future message types leave state untouched.
  return state;
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
