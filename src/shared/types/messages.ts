import type {
  MessageId,
  PlayerId,
  RoomId,
  GameId,
  SessionId,
  CardId,
  BugId,
  RuleSetId,
  StrategyId,
  PhaseId,
  Action,
  ArithmeticResult,
  FieldCard,
  EffectId,
  EventLog,
  WinResult,
  Room,
  Session,
  SessionPlayer,
  RaidState,
  GameView,
} from "./domain";

// ============================================================
// Client → Server message types
// ============================================================

export type ClientMessageType =
  | "client:join_room"
  | "client:leave_room"
  | "client:ready"
  | "client:select_strategy"
  | "client:start_game"
  | "client:action"
  | "client:reset_or_raid"
  | "client:chat";

// ============================================================
// Server → Client message types
// ============================================================

export type ServerMessageType =
  | "server:room_updated"
  | "server:session_started"
  | "server:game_started"
  | "server:action_result"
  | "server:intervention_offer"
  | "server:hand_updated"
  | "server:phase_changed"
  | "server:raid_round_started"
  | "server:game_ended"
  | "server:session_ended"
  | "server:state_sync"
  | "server:rebind_token"
  | "server:error";

// ============================================================
// Client payloads
// ============================================================

export type ClientPayload =
  | JoinRoomPayload
  | LeaveRoomPayload
  | ReadyPayload
  | SelectStrategyPayload
  | StartGamePayload
  | ActionPayload
  | ResetOrRaidPayload
  | ChatPayload;

export interface JoinRoomPayload {
  playerName: string;
  role:       "player" | "spectator";
  /** Proof of identity when rejoining as an existing player (issued via server:rebind_token) */
  rebindToken?: string;
}

export interface LeaveRoomPayload {}
export interface ReadyPayload {}
export interface StartGamePayload {}

export interface SelectStrategyPayload {
  strategyId: StrategyId;
}

export interface ActionPayload {
  action: Action;
}

export interface ResetOrRaidPayload {
  choice: "reset" | "raid";
}

export interface ChatPayload {
  text: string;
}

// ============================================================
// Client message
// ============================================================

export interface ClientMessage {
  id:       MessageId;
  type:     ClientMessageType;
  roomId:   RoomId;
  gameId?:  GameId;
  senderId: PlayerId;
  payload:  ClientPayload;
}

// ============================================================
// Server payloads
// ============================================================

export interface RoomUpdatedPayload {
  room: Room;
}

export interface SessionStartedPayload {
  sessionId: SessionId;
  players:   SessionPlayer[];
  ruleSetId: RuleSetId;
}

export interface GameStartedPayload {
  gameId:      GameId;
  gameIndex:   number;
  setNumber:   number;
  turnOrder:   PlayerId[];
  deckCount:   number;
  residualBugs: BugId[];
  hand:        CardId[];
  handCounts:  Record<PlayerId, number>;
}

export interface ActionResultPayload {
  action:            Action;
  actorId:           PlayerId;
  arithmeticResult?: ArithmeticResult;
  fieldCard?:        FieldCard;
  fieldOverride?:    FieldCard[];
  effectsApplied:    EffectId[];
  newSetNumber?:     number;
  raidHpChanges?:    Record<PlayerId | "boss", number>;
  deckCount:         number;
  handCounts?:       Record<PlayerId, number>;
  // Authoritative turn state. Clients must render these values as-is instead of
  // guessing (+1 wraps break on: zero-card plays that keep the turn, resets that
  // rewind to 0, and eliminations that shrink turnOrder).
  turnOrder:         PlayerId[];
  currentTurnIndex:  number;
  events:            EventLog[];
  /** A1: true while the game is frozen waiting for intervention responses.
   *  Deliberately a bare boolean — candidate identities/strategies are secret. */
  interventionPending?: boolean;
}

/**
 * A1: sent privately (visibility="player") to each intervention candidate when
 * another player's card triggers their optional strategy. The candidate must
 * answer with a client:action { type: "intervention_response", activate } —
 * no answer within timeoutMs counts as a pass (server-authoritative; the
 * client countdown is display only).
 */
export interface InterventionOfferPayload {
  gameId:      GameId;
  /** The card that triggered the offer (as it currently sits on the field). */
  triggerCard: FieldCard;
  /** The recipient's own strategy that may activate. */
  strategyId:  StrategyId;
  /** Response window in ms (rules timeouts.intervention; default 5000). */
  timeoutMs:   number;
  /** Approximate server deadline (epoch ms) — display only. */
  deadline:    number;
}

export interface HandUpdatedPayload {
  hand: CardId[];
}

export type TransitionReason =
  | "deck_empty"
  | "card_zero_played_reset"
  | "card_zero_played_raid";

export interface PhaseChangedPayload {
  from:       PhaseId;
  to:         PhaseId;
  reason:     TransitionReason;
  raidState?: RaidState;
}

export interface RaidRoundStartedPayload {
  roundIndex:  number;
  activeBugId: BugId;
  turnOrder:   PlayerId[];
  diceResults: Record<PlayerId, number>;
}

export interface GameEndedPayload {
  gameId:         GameId;
  winResult:      WinResult;
  sessionPlayers: SessionPlayer[];
}

export interface SessionEndedPayload {
  sessionId: SessionId;
  /** First winner (backward compatibility; = winnerIds[0], "" when boss wins). */
  winnerId:  PlayerId;
  /** All session winners (A6: simultaneous winsRequired reach → multiple winners). */
  winnerIds: PlayerId[];
  players:   SessionPlayer[];
}

export interface StateSyncPayload {
  room:     Room;
  /** null when reconnecting before any session has started (waiting phase) */
  session:  Session  | null;
  /** null when reconnecting before any session has started (waiting phase) */
  game:     GameView | null;
}

export interface RebindTokenPayload {
  /** Secret the client must present in JoinRoomPayload.rebindToken to rejoin as this player */
  token: string;
}

export interface ErrorPayload {
  code:        string;
  message:     string;
  detail?:     string;
  recoverable: boolean;
}

export type ServerPayload =
  | RoomUpdatedPayload
  | SessionStartedPayload
  | GameStartedPayload
  | ActionResultPayload
  | InterventionOfferPayload
  | HandUpdatedPayload
  | PhaseChangedPayload
  | RaidRoundStartedPayload
  | GameEndedPayload
  | SessionEndedPayload
  | StateSyncPayload
  | RebindTokenPayload
  | ErrorPayload;

// ============================================================
// Server message — discriminated union so `type` narrows `payload`
// ============================================================

interface ServerMessageBase {
  id:              MessageId;
  roomId:          RoomId;
  gameId?:         GameId;
  visibility:      "all" | "player" | "spectator";
  targetPlayerId?: PlayerId;
}

export type ServerMessage =
  | (ServerMessageBase & { type: "server:room_updated";      payload: RoomUpdatedPayload      })
  | (ServerMessageBase & { type: "server:session_started";   payload: SessionStartedPayload   })
  | (ServerMessageBase & { type: "server:game_started";      payload: GameStartedPayload      })
  | (ServerMessageBase & { type: "server:action_result";     payload: ActionResultPayload     })
  | (ServerMessageBase & { type: "server:intervention_offer"; payload: InterventionOfferPayload })
  | (ServerMessageBase & { type: "server:hand_updated";      payload: HandUpdatedPayload      })
  | (ServerMessageBase & { type: "server:phase_changed";     payload: PhaseChangedPayload     })
  | (ServerMessageBase & { type: "server:raid_round_started"; payload: RaidRoundStartedPayload })
  | (ServerMessageBase & { type: "server:game_ended";        payload: GameEndedPayload        })
  | (ServerMessageBase & { type: "server:session_ended";     payload: SessionEndedPayload     })
  | (ServerMessageBase & { type: "server:state_sync";        payload: StateSyncPayload        })
  | (ServerMessageBase & { type: "server:rebind_token";      payload: RebindTokenPayload      })
  | (ServerMessageBase & { type: "server:error";             payload: ErrorPayload            });
