import type {
  Game,
  Action,
  PlayCardAction,
  RemoveBugAction,
  DrawCardAction,
  ResetOrRaidAction,
  ShowdownSubmitAction,
  SelectStrategyAction,
  ValidationResult,
  PlayerId,
  CardId,
} from "../../shared/types/domain";
import type { RuleSet, RemovalCost } from "../../shared/types/rules";
import { canApplyOperation } from "./ArithmeticJudge";
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

function validatePlayCard(
  game: Game,
  action: PlayCardAction,
  ctx: ValidateContext,
): ValidationResult {
  const { actorId } = ctx;

  if (game.phase === "showdown") {
    return fail(ACTION_INVALID_PHASE, "Use showdown_submit during the showdown phase");
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

  // Bug constraint: Odd-Forbidden (odd cards are forbidden)
  if (game.residualBugs.includes("Odd-Forbidden") && value % 2 !== 0) {
    return fail(ACTION_BUG_FORBIDDEN, "Odd-Forbidden: odd cards are forbidden");
  }

  // Bug constraint: Even-Forbidden (even cards are forbidden)
  if (game.residualBugs.includes("Even-Forbidden") && value % 2 === 0) {
    return fail(ACTION_BUG_FORBIDDEN, "Even-Forbidden: even cards are forbidden");
  }

  // Bug constraint: Stack-Forbidden (same value as top of field is forbidden)
  if (
    game.residualBugs.includes("Stack-Forbidden") &&
    lastFieldCard !== undefined &&
    value === lastFieldCard.rawValue
  ) {
    return fail(ACTION_BUG_FORBIDDEN, "Stack-Forbidden: stacking the same value is forbidden");
  }

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

  if (!isCurrentTurnPlayer(game, actorId)) {
    return fail(ACTION_NOT_YOUR_TURN);
  }

  const hand = game.hands[actorId] ?? [];
  const maxHandSize = ruleSet.initialConfig.initialHandSize;

  if (hand.length >= maxHandSize) {
    return fail(ACTION_HAND_FULL, `Hand is full (max ${maxHandSize})`);
  }

  return ok();
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
    case "select_strategy":
      return validateSelectStrategy(action, ctx);
  }
}
