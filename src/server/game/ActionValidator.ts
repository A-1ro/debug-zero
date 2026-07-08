import type {
  Game,
  Action,
  PlayCardAction,
  RemoveBugAction,
  DrawCardAction,
  ResetOrRaidAction,
  ShowdownSubmitAction,
  SelectStrategyAction,
  InterventionResponseAction,
  ChooseRaidBugAction,
  SkipTurnAction,
  ValidationResult,
  PlayerId,
  CardId,
} from "../../shared/types/domain";
import type { RuleSet, RemovalCost } from "../../shared/types/rules";
import { canApplyOperation } from "./ArithmeticJudge";
import { raidActor } from "./TurnManager";
import {
  ACTION_NOT_YOUR_TURN,
  ACTION_INVALID_CARD,
  ACTION_HAND_EMPTY,
  ACTION_HAND_FULL,
  ACTION_BUG_FORBIDDEN,
  ACTION_RESET_LIMIT_EXCEEDED,
  ACTION_INVALID_BUG_REMOVAL_COST,
  ACTION_INVALID_PHASE,
  ACTION_INVALID_OPERATION,
  ACTION_ALREADY_SUBMITTED,
  ACTION_INTERVENTION_PENDING,
  ACTION_NO_PENDING_INTERVENTION,
  ACTION_INVALID_BUG_CHOICE,
  ACTION_NO_LEGAL_MOVE,
  SESSION_INVALID_STRATEGY,
} from "../../shared/constants";

// Maximum number of resets allowed per game
const MAX_RESET_COUNT = 2;

export interface ValidateContext {
  actorId: PlayerId;
  ruleSet: RuleSet;
}

// ============================================================
// Helpers
// ============================================================

function ok(): ValidationResult {
  return { valid: true };
}

function fail(errorCode: string, detail?: string): ValidationResult {
  return { valid: false, errorCode, detail };
}

/** Parse numeric value from CardId format "{value}-{serial}" */
function cardValueFromId(cardId: CardId): number {
  return parseInt(cardId.split("-")[0], 10);
}

function isCurrentTurnPlayer(game: Game, actorId: PlayerId): boolean {
  return game.turnOrder[game.currentTurnIndex] === actorId;
}

// ============================================================
// play_card
// ============================================================

/**
 * Forbidden-bug play constraints (Odd/Even/Stack) — apply in normal and raid
 * phases. Evaluated data-drivenly from an `isBoss` context: the raid boss is
 * NOT affected by bugs (owner ruling), so a boss play is never constrained by a
 * forbidding bug. `isBoss` is always false outside the raid phase.
 */
export function checkForbiddenBugs(game: Game, value: number, isBoss: boolean): ValidationResult {
  // Owner ruling 1: the boss is exempt from bug-imposed card-play constraints.
  if (isBoss) return ok();

  const lastFieldCard = game.field.length > 0 ? game.field[game.field.length - 1] : undefined;

  if (game.residualBugs.includes("Odd-Forbidden") && value % 2 !== 0) {
    return fail(ACTION_BUG_FORBIDDEN, "Odd-Forbidden: odd cards are forbidden");
  }
  if (game.residualBugs.includes("Even-Forbidden") && value % 2 === 0) {
    return fail(ACTION_BUG_FORBIDDEN, "Even-Forbidden: even cards are forbidden");
  }
  if (
    game.residualBugs.includes("Stack-Forbidden") &&
    lastFieldCard !== undefined &&
    value === lastFieldCard.rawValue
  ) {
    return fail(ACTION_BUG_FORBIDDEN, "Stack-Forbidden: stacking the same value is forbidden");
  }
  return ok();
}

/** True if the given hand card is legal to play (bug constraints only). */
export function isRaidCardPlayable(game: Game, cardId: CardId, isBoss: boolean): boolean {
  return checkForbiddenBugs(game, cardValueFromId(cardId), isBoss).valid;
}

/**
 * Auto-selected cost cards to remove a bug during raid, or null if the player
 * cannot afford it. Mirrors the (lenient) affordability rules used by
 * validateRemoveBug/canPayRemovalCost so this stays consistent with what the
 * validator would accept.
 */
function raidRemovalCostCards(
  game: Game,
  actorId: PlayerId,
  cost: RemovalCost,
): CardId[] | null {
  switch (cost.type) {
    case "hp": {
      const hp = game.raidState?.playerHPs[actorId] ?? 0;
      return hp >= cost.amount ? [] : null;
    }
    case "hand_card": {
      const hand = game.hands[actorId] ?? [];
      const matching = hand.filter(id => {
        const v = cardValueFromId(id);
        if (cost.value === "any") return true;
        if (cost.value === "even") return v % 2 === 0;
        if (cost.value === "odd") return v % 2 !== 0;
        return v === cost.value;
      });
      return matching.length >= cost.amount ? matching.slice(0, cost.amount) : null;
    }
    case "composite": {
      const all: CardId[] = [];
      for (const sub of cost.costs) {
        const cc = raidRemovalCostCards(game, actorId, sub);
        if (cc === null) return null;
        all.push(...cc);
      }
      return all;
    }
  }
}

/**
 * A removable bug this raid player can currently afford to remove, with the
 * cost cards to spend, or null. Bugs carried in from the previous game cannot be
 * removed (same rule as validateRemoveBug).
 */
export function affordableRaidRemoval(
  game: Game,
  actorId: PlayerId,
  ruleSet: RuleSet,
): { bugId: string; costCardIds: CardId[] } | null {
  const carried = game.carriedBugs ?? [];
  for (const bugId of game.residualBugs) {
    if (carried.includes(bugId)) continue;
    const bugDef = ruleSet.bugs?.find(b => b.id === bugId);
    if (!bugDef) continue;
    const cc = raidRemovalCostCards(game, actorId, bugDef.removalCost);
    if (cc !== null) return { bugId, costCardIds: cc };
  }
  return null;
}

/**
 * Does this (non-boss) raid turn player have ANY legal action? Legal raid
 * actions are: play a non-forbidden card, refill by drawing, or remove an
 * affordable bug (owner ruling 2). The boss is exempt from bug constraints, so
 * a boss with any card always has a move.
 */
export function raidPlayerHasLegalMove(
  game: Game,
  playerId: PlayerId,
  ruleSet: RuleSet,
): boolean {
  const rs = game.raidState;
  if (!rs) return false;
  const hand = game.hands[playerId] ?? [];
  const isBoss = playerId === rs.bossPlayerId;
  if (isBoss) return hand.length > 0;

  if (hand.some(id => isRaidCardPlayable(game, id, false))) return true;
  if (game.deck.length > 0 && hand.length < ruleSet.initialConfig.initialHandSize) return true;
  if (affordableRaidRemoval(game, playerId, ruleSet)) return true;
  return false;
}

/** True if the given hand card is legal to play in the normal phase. Only bug
 *  constraints can block it — add/sub are always arithmetically legal, so a card
 *  is playable unless a forbidding bug (Odd/Even/Stack) forbids its value. */
export function isNormalCardPlayable(game: Game, cardId: CardId): boolean {
  return checkForbiddenBugs(game, cardValueFromId(cardId), false).valid;
}

/**
 * True if this player just played a 0-card and still owes the reset_or_raid
 * choice (the turn does not advance until they choose). Detected from field
 * state: the last field card is a 0 played by this player, still in the normal
 * phase. Such a player is NOT stuck — reset_or_raid is their legal move.
 */
export function normalZeroChoicePending(game: Game, playerId: PlayerId): boolean {
  if (game.phase !== "normal") return false;
  const last = game.field.length > 0 ? game.field[game.field.length - 1] : undefined;
  if (!last) return false;
  return cardValueFromId(last.cardId) === 0 && last.playerId === playerId;
}

/**
 * D10 (owner ruling): does this normal-phase player have ANY legal move? Their
 * only proactive turn action is play_card (self-draw is raid-only now); a card
 * is playable unless a forbidding bug blocks it. A pending reset_or_raid choice
 * also counts as a legal move. When this returns false the turn is skipped
 * (turn_skipped, reason no_legal_move) — same approach as the raid deadlock fix.
 */
export function normalPlayerHasLegalMove(game: Game, playerId: PlayerId): boolean {
  if (normalZeroChoicePending(game, playerId)) return true;
  const hand = game.hands[playerId] ?? [];
  return hand.some(id => isNormalCardPlayable(game, id));
}

function validatePlayCard(
  game: Game,
  action: PlayCardAction,
  ctx: ValidateContext,
): ValidationResult {
  const { actorId } = ctx;

  if (game.phase === "showdown") {
    return fail(ACTION_INVALID_PHASE, "Use showdown_submit during the showdown phase");
  }

  // Raid: turn comes from raidState; the boss attacks players, players attack the boss
  if (game.phase === "raid") {
    const rs = game.raidState;
    if (!rs) return fail(ACTION_INVALID_PHASE, "Raid state missing");
    if (rs.awaitingBugChoice) {
      return fail(ACTION_INVALID_PHASE, "The boss is choosing the round bug");
    }
    if (raidActor(rs) !== actorId) {
      return fail(ACTION_NOT_YOUR_TURN);
    }
    const hand = game.hands[actorId] ?? [];
    if (!hand.includes(action.cardId)) {
      return fail(ACTION_INVALID_CARD, `Card ${action.cardId} not in hand`);
    }
    if (actorId === rs.bossPlayerId) {
      const target = action.targetId;
      if (!target || target === "boss" || (rs.playerHPs[target] ?? 0) <= 0) {
        return fail(ACTION_INVALID_CARD, "Boss must target a surviving player");
      }
    } else if (action.targetId && action.targetId !== "boss") {
      return fail(ACTION_INVALID_CARD, "Players can only target the boss");
    }
    // Owner ruling 1: the boss is exempt from forbidding bugs during raid.
    return checkForbiddenBugs(game, cardValueFromId(action.cardId), actorId === rs.bossPlayerId);
  }

  if (!isCurrentTurnPlayer(game, actorId)) {
    return fail(ACTION_NOT_YOUR_TURN);
  }

  const hand = game.hands[actorId] ?? [];

  if (hand.length === 0) {
    return fail(ACTION_HAND_EMPTY);
  }

  if (!hand.includes(action.cardId)) {
    return fail(ACTION_INVALID_CARD, `Card ${action.cardId} not in hand`);
  }

  const value = cardValueFromId(action.cardId);
  const lastFieldCard = game.field.length > 0 ? game.field[game.field.length - 1] : undefined;

  // Arithmetic check via ArithmeticJudge
  const arithmeticCheck = canApplyOperation(
    lastFieldCard,
    { id: action.cardId, value },
    action.operation,
  );
  if (!arithmeticCheck.valid) {
    return fail(arithmeticCheck.errorCode ?? ACTION_INVALID_CARD);
  }

  // Normal phase has no boss — isBoss is always false here.
  const forbidden = checkForbiddenBugs(game, value, false);
  if (!forbidden.valid) return forbidden;

  return ok();
}

// ============================================================
// draw_card
// ============================================================

function validateDrawCard(game: Game, ctx: ValidateContext): ValidationResult {
  const { actorId, ruleSet } = ctx;

  if (game.phase === "showdown") {
    return fail(ACTION_INVALID_PHASE, "Use showdown_submit during the showdown phase");
  }

  // Raid refill (手札補充): players only, on their raid turn, deck must have cards
  if (game.phase === "raid") {
    const rs = game.raidState;
    if (!rs) return fail(ACTION_INVALID_PHASE, "Raid state missing");
    if (rs.awaitingBugChoice) {
      return fail(ACTION_INVALID_PHASE, "The boss is choosing the round bug");
    }
    if (actorId === rs.bossPlayerId) {
      return fail(ACTION_INVALID_PHASE, "The boss cannot refill");
    }
    if (raidActor(rs) !== actorId) {
      return fail(ACTION_NOT_YOUR_TURN);
    }
    if (game.deck.length === 0) {
      return fail(ACTION_INVALID_CARD, "Deck is empty");
    }
    const hand = game.hands[actorId] ?? [];
    if (hand.length >= ruleSet.initialConfig.initialHandSize) {
      return fail(ACTION_HAND_FULL, `Hand is full (max ${ruleSet.initialConfig.initialHandSize})`);
    }
    return ok();
  }

  // D10 (owner ruling): self-draw (hand refill) is a raid-phase-only action.
  // In the normal (and showdown) phase, drawing is illegal — the hand is
  // auto-refilled after each card play (see continueAfterCardEffects). Rule doc
  // §4.3/§5.3: the 手札補充 button is shown only during the raid phase.
  return fail(
    ACTION_INVALID_PHASE,
    "Drawing is only allowed during a raid; the normal-phase hand auto-refills after a play",
  );
}

// ============================================================
// remove_bug
// ============================================================

function validateRemoveBug(
  game: Game,
  action: RemoveBugAction,
  ctx: ValidateContext,
): ValidationResult {
  const { actorId, ruleSet } = ctx;

  if (!game.residualBugs.includes(action.bugId)) {
    return fail(ACTION_INVALID_CARD, `Bug ${action.bugId} is not active`);
  }

  // Raid: bug removal is one of the three turn actions — raid turn required,
  // boss excluded. Bugs carried over from the previous game cannot be removed.
  if (game.phase === "raid") {
    const rs = game.raidState;
    if (!rs) return fail(ACTION_INVALID_PHASE, "Raid state missing");
    if (rs.awaitingBugChoice) {
      return fail(ACTION_INVALID_PHASE, "The boss is choosing the round bug");
    }
    if (actorId === rs.bossPlayerId) {
      return fail(ACTION_INVALID_PHASE, "The boss cannot remove bugs");
    }
    if (raidActor(rs) !== actorId) {
      return fail(ACTION_NOT_YOUR_TURN);
    }
  }
  if ((game.carriedBugs ?? []).includes(action.bugId)) {
    return fail(ACTION_INVALID_CARD, "Residual bugs from the previous game cannot be removed");
  }

  const bugDef = ruleSet.bugs.find(b => b.id === action.bugId);
  if (!bugDef) {
    return fail(ACTION_INVALID_CARD, `Bug ${action.bugId} is unknown`);
  }

  const costCardIds = action.costCardIds ?? [];
  if (!canPayRemovalCost(game, actorId, bugDef.removalCost, costCardIds)) {
    return fail(ACTION_INVALID_BUG_REMOVAL_COST);
  }

  return ok();
}

function canPayRemovalCost(
  game: Game,
  actorId: PlayerId,
  cost: RemovalCost,
  costCardIds: CardId[],
): boolean {
  switch (cost.type) {
    case "hp": {
      const hp = game.raidState?.playerHPs[actorId] ?? 0;
      return hp >= cost.amount;
    }
    case "hand_card": {
      const hand = game.hands[actorId] ?? [];
      const matching = costCardIds.filter(id => {
        if (!hand.includes(id)) return false;
        const v = cardValueFromId(id);
        if (cost.value === "any") return true;
        if (cost.value === "even") return v % 2 === 0;
        if (cost.value === "odd") return v % 2 !== 0;
        return v === cost.value;
      });
      return matching.length >= cost.amount;
    }
    case "composite": {
      // Each sub-cost is checked against the provided costCardIds independently.
      // The caller is responsible for providing valid cards that satisfy all sub-costs.
      return cost.costs.every(subCost => canPayRemovalCost(game, actorId, subCost, costCardIds));
    }
  }
}

// ============================================================
// reset_or_raid
// ============================================================

function validateResetOrRaid(
  game: Game,
  action: ResetOrRaidAction,
  ctx: ValidateContext,
): ValidationResult {
  if (!isCurrentTurnPlayer(game, ctx.actorId)) {
    return fail(ACTION_NOT_YOUR_TURN);
  }

  if (game.phase !== "normal") {
    return fail(ACTION_INVALID_PHASE, "reset_or_raid is only available in normal phase");
  }

  if (action.choice === "reset" && game.resetCount >= MAX_RESET_COUNT) {
    return fail(ACTION_RESET_LIMIT_EXCEEDED, `Reset limit of ${MAX_RESET_COUNT} exceeded`);
  }

  return ok();
}

// ============================================================
// showdown_submit
// ============================================================

function validateShowdownSubmit(
  game: Game,
  action: ShowdownSubmitAction,
  ctx: ValidateContext,
): ValidationResult {
  const { actorId } = ctx;

  if (game.phase !== "showdown") {
    return fail(ACTION_INVALID_PHASE, "showdown_submit is only available in showdown phase");
  }
  // Showdown has no turn order, but eliminated players may not submit
  if (!game.turnOrder.includes(actorId)) {
    return fail(ACTION_NOT_YOUR_TURN, "Eliminated players cannot submit");
  }
  if (game.showdownState?.submissions[actorId]) {
    return fail(ACTION_ALREADY_SUBMITTED);
  }

  const hand = game.hands[actorId] ?? [];
  const unique = new Set(action.cardIds);
  if (action.cardIds.length < 1 || action.cardIds.length > 2 || unique.size !== action.cardIds.length) {
    return fail(ACTION_INVALID_CARD, "Submit 1 or 2 distinct cards");
  }
  for (const cardId of action.cardIds) {
    if (!hand.includes(cardId)) {
      return fail(ACTION_INVALID_CARD, `Card ${cardId} not in hand`);
    }
  }

  if (action.cardIds.length === 2) {
    if (!action.operation) {
      return fail(ACTION_INVALID_OPERATION, "operation is required for 2-card submissions");
    }
    if (action.operation === "div" && cardValueFromId(action.cardIds[1]) === 0) {
      return fail(ACTION_INVALID_OPERATION, "Cannot divide by zero");
    }
  }

  return ok();
}

// ============================================================
// select_strategy
// ============================================================

function validateSelectStrategy(
  action: SelectStrategyAction,
  ctx: ValidateContext,
): ValidationResult {
  const { ruleSet } = ctx;

  const strategyExists = ruleSet.strategies.some(s => s.id === action.strategyId);
  if (!strategyExists) {
    return fail(SESSION_INVALID_STRATEGY, `Strategy ${action.strategyId} is unknown`);
  }

  return ok();
}

// ============================================================
// intervention_response (A1)
// ============================================================

function validateInterventionResponse(
  game: Game,
  _action: InterventionResponseAction,
  ctx: ValidateContext,
): ValidationResult {
  const pi = game.pendingIntervention;
  if (!pi) {
    return fail(ACTION_NO_PENDING_INTERVENTION, "No intervention offer is pending");
  }
  if (!pi.candidates.some(c => c.playerId === ctx.actorId)) {
    return fail(ACTION_NOT_YOUR_TURN, "You are not an intervention candidate");
  }
  if (ctx.actorId in pi.responses) {
    return fail(ACTION_ALREADY_SUBMITTED, "Intervention response already submitted");
  }
  return ok();
}

// ============================================================
// choose_raid_bug (D2)
// ============================================================

function validateChooseRaidBug(
  game: Game,
  action: ChooseRaidBugAction,
  ctx: ValidateContext,
): ValidationResult {
  if (game.phase !== "raid" || !game.raidState) {
    return fail(ACTION_INVALID_PHASE, "choose_raid_bug is only available during a raid");
  }
  const rs = game.raidState;
  if (!rs.awaitingBugChoice) {
    return fail(ACTION_INVALID_PHASE, "No bug choice is pending");
  }
  if (ctx.actorId !== rs.bossPlayerId) {
    return fail(ACTION_NOT_YOUR_TURN, "Only the boss chooses the raid bug");
  }
  if (!(rs.bugCandidates ?? []).includes(action.bugId)) {
    return fail(ACTION_INVALID_BUG_CHOICE, `Bug ${action.bugId} is not a candidate`);
  }
  return ok();
}

// ============================================================
// skip_turn (owner ruling 2)
// ============================================================

/**
 * A turn player with zero legal moves may be skipped.
 *
 * - Normal phase (D10): the current player is skipped only when every card in
 *   hand is bug-forbidden (self-draw is no longer a legal escape) and no
 *   reset_or_raid choice is pending.
 * - Raid phase (owner ruling 2): the current non-boss player is skipped only
 *   when they genuinely have no legal action (all cards forbidden AND no draw
 *   AND no affordable removal). The boss is never skipped — it is exempt from
 *   bug constraints.
 */
function validateSkipTurn(
  game: Game,
  _action: SkipTurnAction,
  ctx: ValidateContext,
): ValidationResult {
  if (game.phase === "normal") {
    if (!isCurrentTurnPlayer(game, ctx.actorId)) {
      return fail(ACTION_NOT_YOUR_TURN);
    }
    if (normalPlayerHasLegalMove(game, ctx.actorId)) {
      return fail(ACTION_NO_LEGAL_MOVE, "A legal move is available; the turn cannot be skipped");
    }
    return ok();
  }

  if (game.phase === "raid" && game.raidState) {
    const rs = game.raidState;
    if (rs.awaitingBugChoice) {
      return fail(ACTION_INVALID_PHASE, "The boss is choosing the round bug");
    }
    if (ctx.actorId === rs.bossPlayerId) {
      return fail(ACTION_INVALID_PHASE, "The boss is exempt from bugs and is never skipped");
    }
    if (raidActor(rs) !== ctx.actorId) {
      return fail(ACTION_NOT_YOUR_TURN);
    }
    if (raidPlayerHasLegalMove(game, ctx.actorId, ctx.ruleSet)) {
      return fail(ACTION_NO_LEGAL_MOVE, "A legal move is available; the turn cannot be skipped");
    }
    return ok();
  }

  return fail(ACTION_INVALID_PHASE, "skip_turn is only available in the normal or raid phase");
}

// ============================================================
// Main entry point
// ============================================================

/**
 * Validate a game action before applying it.
 * Pure function — no side effects.
 */
export function validate(
  game: Game,
  action: Action,
  ctx: ValidateContext,
): ValidationResult {
  // A1: while an intervention offer is being resolved, the game is frozen —
  // only intervention responses are accepted (progress consistency).
  if (game.pendingIntervention && action.type !== "intervention_response") {
    return fail(ACTION_INTERVENTION_PENDING, "Waiting for intervention responses");
  }

  switch (action.type) {
    case "play_card":
      return validatePlayCard(game, action, ctx);
    case "draw_card":
      return validateDrawCard(game, ctx);
    case "remove_bug":
      return validateRemoveBug(game, action, ctx);
    case "reset_or_raid":
      return validateResetOrRaid(game, action, ctx);
    case "showdown_submit":
      return validateShowdownSubmit(game, action, ctx);
    case "intervention_response":
      return validateInterventionResponse(game, action, ctx);
    case "choose_raid_bug":
      return validateChooseRaidBug(game, action, ctx);
    case "skip_turn":
      return validateSkipTurn(game, action, ctx);
    case "select_strategy":
      return validateSelectStrategy(action, ctx);
  }
}
