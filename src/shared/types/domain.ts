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
  /** First session winner (kept for backward compatibility; = winnerIds[0]). */
  winnerId?:        PlayerId;
  /** All session winners — multiple players can reach winsRequired in the
   *  same game (showdown tie / raid exact-zero). Owner ruling A6. */
  winnerIds?:       PlayerId[];
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
  /** Bug active this round — chosen by the boss (owner ruling D2). */
  activeBugId:      BugId;
  roundIndex:       number;
  /** Player turn order for this round, decided by 1D10 per player each round,
   *  sorted descending (owner ruling D3). The boss is NOT included (§3.4). */
  turnOrder:        PlayerId[];
  currentTurnIndex: number;
  bossActionsLeft:  number;
  /** True while the boss is taking its actions for the round (after every
   *  player has acted). While true, currentTurnIndex sits past the last player
   *  slot and the boss is the actor. undefined = a player is on the clock. */
  bossTurn?:        boolean;
  /** Final 1D10 roll per player used to build this round's turnOrder (D3).
   *  Optional so in-progress raids from before this change deserialize cleanly. */
  diceResults?:     Record<PlayerId, number>;
  /** True while waiting for the boss to choose this round's bug (D2). No combat
   *  action is accepted until the boss chooses (or the choice times out). */
  awaitingBugChoice?: boolean;
  /** Not-yet-active bug ids the boss may choose from this round (D2). */
  bugCandidates?:   BugId[];
}

/**
 * Waiting state for optional intervention strategies (owner ruling A1).
 * When a played card triggers other players' on_card_played_by_other
 * strategies (Control-Add/Sub/Mul/Div, Hack, TrickStar), the effects are NOT
 * auto-applied. Instead each candidate is offered a choice (like calling a
 * tile in mahjong) and the game waits — turn does not advance — until every
 * candidate responds (or the server times them out as "pass").
 */
export interface PendingIntervention {
  /** Snapshot of the trigger card as it was on the field when played. */
  triggerCard:     FieldCard;
  /** The player who played the trigger card. */
  actorId:         PlayerId;
  /** setNumber before the trigger card's arithmetic (for undo/redo handlers). */
  setNumberBefore: number;
  /** Offer recipients, ordered by resolution priority (turn order, starting
   *  from the player after the actor). */
  candidates:      { playerId: PlayerId; strategyId: StrategyId }[];
  /** playerId → activate? Missing key = not yet responded. */
  responses:       Record<PlayerId, boolean>;
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
  /** Bugs carried in from the previous game — they clear after this game
   *  (only bugs newly spawned during this game's raid carry forward). */
  carriedBugs?:        BugId[];
  raidState?:          RaidState;
  showdownState?:      ShowdownState;
  /** Set while waiting for intervention responses (A1). All other actions
   *  are rejected until every candidate responds or times out. */
  pendingIntervention?: PendingIntervention;
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

/** Response to a server:intervention_offer (A1). activate=false is a pass —
 *  the strategy's once-per-game right is NOT consumed. */
export interface InterventionResponseAction {
  type:     "intervention_response";
  activate: boolean;
}

/** Boss's choice of the bug to spawn for a raid round (owner ruling D2).
 *  Sent in response to server:boss_bug_choice; bugId must be a candidate. */
export interface ChooseRaidBugAction {
  type:  "choose_raid_bug";
  bugId: BugId;
}

export type Action =
  | PlayCardAction
  | RemoveBugAction
  | DrawCardAction
  | ResetOrRaidAction
  | ShowdownSubmitAction
  | SelectStrategyAction
  | InterventionResponseAction
  | ChooseRaidBugAction;

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
  // pendingIntervention: null means clear; undefined means no change
  pendingIntervention?:  PendingIntervention | null;
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
  /** True while an intervention offer is being resolved (A1). Candidate
   *  identities/strategies are NOT exposed — boolean only (visibility). */
  interventionPending?: boolean;
  events:           EventLog[];
}
