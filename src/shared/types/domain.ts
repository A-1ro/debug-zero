// ============================================================
// Primitive types
// ============================================================

export type PlayerId   = string;
export type RoomId     = string;
export type SessionId  = string;
export type GameId     = string;
export type CardId     = string; // "{value}-{serial}" e.g. "3-007"
export type BugId      = string;
export type StrategyId = string;
export type RuleSetId  = string;
export type EffectId   = string;
export type MessageId  = string;
export type EventId    = string;

// ============================================================
// Card types
// ============================================================

export interface Card {
  id:    CardId;
  value: number;
}

export interface FieldCard {
  cardId:         CardId;
  playerId:       PlayerId;
  operation:      Operation;
  rawValue:       number;
  effectiveValue: number;
}

export type Operation = "add" | "sub" | "mul" | "div";

// ============================================================
// Room / Player
// ============================================================

export type RoomStatus = "waiting" | "strategy-selection" | "in-session";

export type ConnectionStatus = "connected" | "disconnected" | "reconnecting";

export interface Player {
  id:               PlayerId;
  name:             string;
  role:             "player" | "spectator";
  connectionStatus: ConnectionStatus;
  ready?:           boolean;
}

export interface Room {
  id:                  RoomId;
  hostPlayerId:        PlayerId;
  players:             Player[];
  maxPlayers:          number;
  status:              RoomStatus;
  ruleSetId:           RuleSetId;
  sessionId?:          SessionId;
  selectedStrategies?: Record<PlayerId, StrategyId>;
}

// ============================================================
// Session
// ============================================================

export type SessionStatus = "in-progress" | "finished";

export interface SessionPlayer {
  playerId:   PlayerId;
  strategyId: StrategyId;
  wins:       number;
}

export interface Session {
  id:               SessionId;
  roomId:           RoomId;
  ruleSetId:        RuleSetId;
  players:          SessionPlayer[];
  gameIds:          GameId[];
  currentGameIndex: number;
  status:           SessionStatus;
  winnerId?:        PlayerId;
}

// ============================================================
// Game
// ============================================================

export type GameStatus = "initializing" | "in-progress" | "finished";

export type PhaseId = "normal" | "showdown" | "raid";

export interface RaidState {
  bossPlayerId:     PlayerId;
  bossHP:           number;
  playerHPs:        Record<PlayerId, number>;
  activeBugId:      BugId;
  roundIndex:       number;
  turnOrder:        PlayerId[];
  currentTurnIndex: number;
  bossActionsLeft:  number;
}

export interface Game {
  id:                  GameId;
  sessionId:           SessionId;
  gameIndex:           number;
  setNumber:           number;
  phase:               PhaseId;
  status:              GameStatus;
  deck:                CardId[];
  excludedCards:       CardId[];
  field:               FieldCard[];
  hands:               Record<PlayerId, CardId[]>;
  usedStrategyCounts:  Record<PlayerId, Record<StrategyId, number>>;
  turnOrder:           PlayerId[];
  currentTurnIndex:    number;
  resetCount:          number;
  residualBugs:        BugId[];
  raidState?:          RaidState;
  showdownState?:      ShowdownState;
  winnerId?:           PlayerId;
  winnerIds?:          PlayerId[];
  events:              EventLog[];
}

// Showdown（決戦フェーズ）: 各プレイヤーが手札から2枚以下＋演算で値を作り、
// 全員提出後にセット数へ最接近のプレイヤーが勝つ（同値→枚数少ない方→全員勝利）
export interface ShowdownSubmission {
  cardIds: CardId[];      // 1〜2枚
  value:   number;        // 提出値（2枚時は operation を適用した結果）
}

export interface ShowdownState {
  submissions: Record<PlayerId, ShowdownSubmission>;
}

// ============================================================
// Actions
// ============================================================

export interface PlayCardAction {
  type:      "play_card";
  cardId:    CardId;
  operation: Operation;
  targetId?: PlayerId | "boss";
}

export interface RemoveBugAction {
  type:         "remove_bug";
  bugId:        BugId;
  costCardIds?: CardId[];
}

export interface DrawCardAction {
  type: "draw_card";
}

export interface ResetOrRaidAction {
  type:   "reset_or_raid";
  choice: "reset" | "raid";
}

export interface ShowdownSubmitAction {
  type:       "showdown_submit";
  cardIds:    CardId[];     // 1〜2枚（手札から）
  operation?: Operation;    // 2枚のとき必須: value = op(card1, card2)
}

export interface SelectStrategyAction {
  type:       "select_strategy";
  strategyId: StrategyId;
}

export type Action =
  | PlayCardAction
  | RemoveBugAction
  | DrawCardAction
  | ResetOrRaidAction
  | ShowdownSubmitAction
  | SelectStrategyAction;

// ============================================================
// Result types
// ============================================================

export interface ValidationResult {
  valid:       boolean;
  errorCode?:  string;
  detail?:     string;
}

export interface ArithmeticResult {
  before:    number;
  after:     number;
  operation: Operation;
  cardValue: number;
}

export type GameWinType =
  | "set_number_zero"
  | "showdown_closest"
  | "raid_boss_hp_exact_zero"
  | "raid_boss_hp_below_zero"
  | "raid_all_players_dead";

export interface WinResult {
  type:       GameWinType;
  winnerId?:  PlayerId;
  winnerIds?: PlayerId[];
}

// ============================================================
// GamePatch
// ============================================================

export interface GamePatch {
  setNumber?:            number;
  phase?:                PhaseId;
  status?:               GameStatus;
  deck?:                 CardId[];
  excludedCards?:        CardId[];
  field?:                FieldCard[];
  hands?:                Record<PlayerId, CardId[]>;
  usedStrategyCounts?:   Record<PlayerId, Record<StrategyId, number>>;
  turnOrder?:            PlayerId[];
  currentTurnIndex?:     number;
  resetCount?:           number;
  raidState?:            RaidState | null;
  showdownState?:        ShowdownState;
  winnerId?:             PlayerId;
  winnerIds?:            PlayerId[];
  residualBugs?:         BugId[];
  appendEvents?:         EventLog[];
}

// ============================================================
// Event log
// ============================================================

export type EventType =
  | "game_started"
  | "card_played"
  | "operation_changed"
  | "card_stolen"
  | "card_removed_from_field"
  | "strategy_invalidated"
  | "bug_activated"
  | "bug_removed"
  | "bug_residual"
  | "phase_changed"
  | "showdown_submitted"
  | "game_reset"
  | "raid_started"
  | "raid_round_started"
  | "hp_changed"
  | "card_drawn"
  | "player_eliminated"
  | "game_ended"
  | "session_ended"
  | "negotiation_declared"
  | "illegal_negotiation_flagged";

export type EventPayload = Record<string, unknown>;

export interface EventLog {
  id:        EventId;
  timestamp: number;
  type:      EventType;
  actorId:   PlayerId | "system" | "boss";
  payload:   EventPayload;
}

// ============================================================
// GameView (visibility-filtered Game for clients)
// ============================================================

export interface GameView {
  id:               GameId;
  gameIndex:        number;
  setNumber:        number;
  phase:            PhaseId;
  status:           GameStatus;
  deckCount:        number;
  field:            FieldCard[];
  hand:             CardId[];
  handCounts:       Record<PlayerId, number>;
  turnOrder:        PlayerId[];
  currentTurnIndex: number;
  resetCount:       number;
  residualBugs:     BugId[];
  raidState?:       RaidState;
  events:           EventLog[];
}
