import type { Game, PhaseId } from "../../shared/types/domain";
import type { PhaseDef, TransitionCondition } from "../../shared/types/rules";

/**
 * Destination of a phase transition.
 * "finished"          — current game ends (normal win / raid boss defeated)
 * "session_win_boss"  — all players dead; boss wins the entire session
 * PhaseId             — game continues in a new phase
 */
export type TransitionTarget = PhaseId | "finished" | "session_win_boss";

export interface PhaseTransitionResult {
  to: TransitionTarget;
  conditionType: TransitionCondition["type"];
}

// ============================================================
// Condition evaluators
// ============================================================

function evalDeckEmpty(game: Game): boolean {
  return game.deck.length === 0;
}

function evalBossHpZeroOrLess(game: Game): boolean {
  if (!game.raidState) return false;
  return game.raidState.bossHP <= 0;
}

function evalAllPlayersHpZeroOrLess(game: Game): boolean {
  if (!game.raidState) return false;
  return Object.values(game.raidState.playerHPs).every(hp => hp <= 0);
}

/**
 * Evaluate a single TransitionCondition against the current game state.
 * Returns the destination if the condition is met, otherwise null.
 *
 * Note: "card_zero_played" is NOT evaluated here because it requires
 * explicit player input (reset/raid choice) — the GameEngine handles
 * that transition directly when it resolves a ResetOrRaidAction.
 */
function evalCondition(
  game: Game,
  condition: TransitionCondition,
): TransitionTarget | null {
  switch (condition.type) {
    case "deck_empty":
      return evalDeckEmpty(game) ? condition.to : null;

    case "card_zero_played":
      // Handled by GameEngine when processing ResetOrRaidAction.
      return null;

    case "boss_hp_zero_or_less":
      return evalBossHpZeroOrLess(game) ? condition.to : null;

    case "all_players_hp_zero_or_less":
      return evalAllPlayersHpZeroOrLess(game) ? condition.to : null;
  }
}

// ============================================================
// Main entry points
// ============================================================

/**
 * Check whether a phase transition should occur given the current game state.
 *
 * Iterates over the PhaseDef for the current phase (found by ID in `phases`)
 * and returns the first matching transition, or null if none applies.
 *
 * Transition conditions are defined in the RuleSet (PhaseDef.transitionConditions)
 * and are NOT embedded in the engine — CLAUDE.md architectural principle.
 *
 * Pure function with no side effects.
 */
export function checkPhaseTransition(
  game: Game,
  phases: PhaseDef[],
): PhaseTransitionResult | null {
  const phaseDef = phases.find(p => p.id === game.phase);
  if (!phaseDef) return null;

  for (const condition of phaseDef.transitionConditions) {
    const to = evalCondition(game, condition);
    if (to !== null) {
      return { to, conditionType: condition.type };
    }
  }

  return null;
}

/**
 * Convenience helper: resolve the transition target for a "card_zero_played"
 * condition based on the player's explicit reset/raid choice.
 *
 * Called by GameEngine when processing a ResetOrRaidAction.
 */
export function resolveZeroCardTransition(
  choice: "reset" | "raid",
): TransitionTarget {
  return choice === "raid" ? "raid" : "normal";
}

/**
 * Returns true if the given transition target represents a game-ending state.
 */
export function isTerminalTransition(
  target: TransitionTarget,
): boolean {
  return target === "finished" || target === "session_win_boss";
}

/**
 * Returns true if the given transition target represents a phase within the game
 * (i.e. not a terminal state).
 */
export function isPhaseTransition(
  target: TransitionTarget,
): target is PhaseId {
  return target === "normal" || target === "showdown" || target === "raid";
}
