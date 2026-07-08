import type { Operation, RuleSetId, StrategyId, EffectId, PhaseId } from "./domain";

export type { RuleSetId };

// ============================================================
// Deck
// ============================================================

export interface DeckConfig {
  cards: { value: number; count: number }[];
}

// ============================================================
// Effect definition
// ============================================================

export type TriggerCondition =
  | { type: "on_card_played" }
  | { type: "on_card_played_by_other" }
  | { type: "on_game_start" }
  | { type: "on_round_start" }
  | { type: "on_turn_start" }
  | { type: "always" };

export type TargetDef =
  | { type: "self" }
  | { type: "actor" }
  | { type: "field_card" }
  | { type: "any_player" }
  | { type: "boss" }
  | { type: "all_players" }
  | { type: "hand" };

export type EffectAction =
  | { type: "multiply_effective_value"; factor: number }
  | { type: "change_operation"; from: Operation; to: Operation }
  | { type: "steal_card" }
  | { type: "remove_field_card" }
  | { type: "add_card_to_hand"; cardValue: number }
  | { type: "invalidate_strategy" }
  | { type: "forbid_card_parity"; parity: "odd" | "even" }
  | { type: "forbid_stack" }
  | { type: "override_card_value"; value: number };

export type ConstraintDef =
  | { type: "usage_limit_per_game"; limit: number }
  | { type: "no_retroactive" }
  | { type: "card_parity"; parity: "odd" | "even" }
  | { type: "strategy_match"; strategyId: StrategyId }
  | { type: "selection_count_threshold"; min: number };

export interface EffectDef {
  id:           EffectId;
  trigger:      TriggerCondition;
  target:       TargetDef;
  action:       EffectAction;
  constraints?: ConstraintDef[];
  usageLimit?:  number;
}

// ============================================================
// Exclusion / RemovalCost
// ============================================================

export interface ExclusionCondition {
  type: "selection_count_threshold";
  min:  number;
}

export type RemovalCost =
  | { type: "hp"; amount: number }
  | { type: "hand_card"; value: "even" | "odd" | number | "any"; amount: number }
  | { type: "composite"; costs: RemovalCost[] };

// ============================================================
// Strategy / Bug definitions
// ============================================================

export interface StrategyDef {
  id:                  StrategyId;
  effect:              EffectDef;
  exclusionCondition?: ExclusionCondition;
}

export interface BugDef {
  id:          string;
  effect:      EffectDef;
  removalCost: RemovalCost;
}

// ============================================================
// Phase definition
// ============================================================

export type TransitionCondition =
  | { type: "deck_empty"; to: "showdown" }
  | { type: "card_zero_played"; to: "raid" | "reset" }
  | { type: "boss_hp_zero_or_less"; to: "finished" }
  | { type: "all_players_hp_zero_or_less"; to: "session_win_boss" };

export interface PhaseDef {
  id:                   PhaseId;
  transitionConditions: TransitionCondition[];
}

// ============================================================
// Win condition / Initial config
// ============================================================

export interface WinConditionDef {
  winsRequired: number;
}

export interface InitialConfig {
  recommendedPlayers: number;
  initialHandSize:    number;
  initialHP:          number;
  setNumberFormula:   string;
  /** レイド戦で各ラウンド開始時にボスの手札を補充する枚数の floor（C裁定）。
   *  実際の補充目標は max(この値, そのラウンドのボス行動回数=ceil(生存者/2))。
   *  未指定（0扱い）だと行動回数ちょうどを補充する最小補充。正の値でボスに予備を持たせる。 */
  raidBossHandSize?:  number;
}

// ============================================================
// RuleSet (top-level)
// ============================================================

/** 手番タイムアウト（ミリ秒）。未指定はデフォルト値を使う。 */
export interface TurnTimeouts {
  normal:   number;
  showdown: number;
  raid:     number;
  /** 介入オファーの応答待ち（A1）。省略時 5000ms。無応答はパス扱い。 */
  intervention?: number;
  /** レイド戦ラウンド開始時のボスのバグ選択待ち（D2）。省略時は intervention、
   *  それも無ければ 5000ms。無応答はランダム選択で代打。 */
  bossBugChoice?: number;
}

export interface RuleSet {
  id:            RuleSetId;
  version:       string;
  extends?:      RuleSetId;
  deck:          DeckConfig;
  strategies:    StrategyDef[];
  bugs:          BugDef[];
  phases:        PhaseDef[];
  winCondition:  WinConditionDef;
  initialConfig: InitialConfig;
  timeouts?:     TurnTimeouts;
}
