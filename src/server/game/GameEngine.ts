import type {
  Game,
  GamePatch,
  Action,
  PlayCardAction,
  DrawCardAction,
  RemoveBugAction,
  ResetOrRaidAction,
  PlayerId,
  StrategyId,
  CardId,
  Card,
  FieldCard,
  EventLog,
  EventId,
} from "../../shared/types/domain";
import type { RuleSet, RemovalCost } from "../../shared/types/rules";
import type { EffectContext } from "../../shared/types/effects";
import { validate } from "./ActionValidator";
import { resolve as arithmeticResolve } from "./ArithmeticJudge";
import { nextTurnIndex, nextRaidTurnIndex } from "./TurnManager";
import {
  checkPhaseTransition,
  resolveZeroCardTransition,
  isTerminalTransition,
  isPhaseTransition,
} from "./PhaseController";
import type { EffectResolver } from "../effects/EffectResolver";

// ============================================================
// Context
// ============================================================

export interface EngineContext {
  actorId:          PlayerId;
  ruleSet:          RuleSet;
  /** Strategy selected by each player (from session data). */
  playerStrategies: Record<PlayerId, StrategyId>;
  effectResolver:   EffectResolver;
  /** Optional RNG override for testing (defaults to Math.random). */
  rng?:             () => number;
}

// ============================================================
// Helpers
// ============================================================

function newEventId(): EventId {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function cardValueFromId(cardId: CardId): number {
  return parseInt(cardId.split("-")[0], 10);
}

function shuffleArray<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function evaluateSetNumberFormula(formula: string, gameIndex: number): number {
  // Supports "gameIndex * N" format (the only format used in basic.yaml)
  const match = formula.match(/gameIndex\s*\*\s*(\d+)/);
  if (match) return gameIndex * parseInt(match[1], 10);
  return gameIndex * 10;
}

function mergePatch(base: GamePatch, patch: GamePatch): GamePatch {
  const result = { ...base, ...patch };
  if (base.appendEvents || patch.appendEvents) {
    result.appendEvents = [
      ...(base.appendEvents ?? []),
      ...(patch.appendEvents ?? []),
    ];
  }
  return result;
}

// ============================================================
// applyPatch — merge a GamePatch into a Game
// ============================================================

/**
 * Apply a GamePatch to the current Game state.
 * `appendEvents` is accumulated (appended, not replaced).
 * Pure function.
 */
export function applyPatch(game: Game, patch: GamePatch): Game {
  return {
    ...game,
    ...(patch.setNumber          !== undefined && { setNumber:          patch.setNumber }),
    ...(patch.phase              !== undefined && { phase:              patch.phase }),
    ...(patch.status             !== undefined && { status:             patch.status }),
    ...(patch.deck               !== undefined && { deck:               patch.deck }),
    ...(patch.excludedCards      !== undefined && { excludedCards:      patch.excludedCards }),
    ...(patch.field              !== undefined && { field:              patch.field }),
    ...(patch.hands              !== undefined && { hands:              patch.hands }),
    ...(patch.usedStrategyCounts !== undefined && { usedStrategyCounts: patch.usedStrategyCounts }),
    ...(patch.currentTurnIndex   !== undefined && { currentTurnIndex:   patch.currentTurnIndex }),
    ...(patch.resetCount         !== undefined && { resetCount:         patch.resetCount }),
    ...(patch.residualBugs       !== undefined && { residualBugs:       patch.residualBugs }),
    ...(patch.winnerId           !== undefined && { winnerId:           patch.winnerId }),
    // raidState: null means clear the field; undefined means no change
    ...(patch.raidState !== undefined && {
      raidState: patch.raidState === null ? undefined : patch.raidState,
    }),
    events: patch.appendEvents
      ? [...game.events, ...patch.appendEvents]
      : game.events,
  };
}

// ============================================================
// play_card
// ============================================================

function applyPlayCard(game: Game, action: PlayCardAction, ctx: EngineContext): Game {
  const { actorId, ruleSet, playerStrategies, effectResolver, rng = Math.random } = ctx;
  const value = cardValueFromId(action.cardId);
  const card: Card = { id: action.cardId, value };

  // Aggro is active when the actor has Aggro strategy AND Aggro-Forbidden is not active
  const isAggroActive =
    playerStrategies[actorId] === "Aggro" &&
    !game.residualBugs.includes("Aggro-Forbidden");

  const arith = arithmeticResolve(game.setNumber, card, action.operation, isAggroActive);

  const fieldCard: FieldCard = {
    cardId:         action.cardId,
    playerId:       actorId,
    operation:      action.operation,
    rawValue:       arith.rawValue,
    effectiveValue: arith.effectiveValue,
  };

  // Remove card from hand and add to field
  const newHand = (game.hands[actorId] ?? []).filter(id => id !== action.cardId);
  let gameAfterCard = applyPatch(game, {
    field: [...game.field, fieldCard],
    hands: { ...game.hands, [actorId]: newHand },
    setNumber: arith.after,
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "card_played",
      actorId,
      payload: {
        cardId:          action.cardId,
        operation:       action.operation,
        rawValue:        arith.rawValue,
        effectiveValue:  arith.effectiveValue,
        setNumberBefore: arith.before,
        setNumberAfter:  arith.after,
      },
    }],
  });

  // ── Effect resolution ──────────────────────────────────────
  const effectCtx: EffectContext = {
    actorId,
    triggerCard: fieldCard,
    ruleSet,
  };

  // 1. Actor's strategy effects (on_card_played)
  const ownPatch = effectResolver.resolve(gameAfterCard, "on_card_played", effectCtx, playerStrategies);
  gameAfterCard = applyPatch(gameAfterCard, ownPatch);

  // 2. Other players' strategy effects (on_card_played_by_other)
  const otherPatch = effectResolver.resolve(gameAfterCard, "on_card_played_by_other", effectCtx, playerStrategies);
  gameAfterCard = applyPatch(gameAfterCard, otherPatch);

  // ── Immediate defeat check (after all effects) ─────────────
  if (gameAfterCard.setNumber < 0) {
    return applyPatch(gameAfterCard, {
      status: "finished",
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "game_ended",
        actorId:   "system",
        payload:   { reason: "immediate_defeat", causedBy: actorId },
      }],
    });
  }

  // ── 0-card: wait for reset_or_raid choice ─────────────────
  // Turn does NOT advance — the same player must submit reset_or_raid next.
  if (value === 0) {
    return gameAfterCard;
  }

  // ── setNumber == 0 win ────────────────────────────────────
  if (gameAfterCard.setNumber === 0) {
    return applyPatch(gameAfterCard, {
      status:   "finished",
      winnerId: actorId,
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "game_ended",
        actorId:   "system",
        payload:   { reason: "set_number_zero", winnerId: actorId },
      }],
    });
  }

  // ── Draw replacement card ─────────────────────────────────
  if (gameAfterCard.deck.length > 0) {
    const [drawnCard, ...remainingDeck] = gameAfterCard.deck;
    const updatedHand = [...(gameAfterCard.hands[actorId] ?? []), drawnCard];
    gameAfterCard = applyPatch(gameAfterCard, {
      deck:  remainingDeck,
      hands: { ...gameAfterCard.hands, [actorId]: updatedHand },
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "card_drawn",
        actorId,
        payload:   { cardId: drawnCard },
      }],
    });
  }

  // ── Advance turn ──────────────────────────────────────────
  const nextIdx = nextTurnIndex(gameAfterCard);
  let gameAfterTurn = applyPatch(gameAfterCard, { currentTurnIndex: nextIdx });

  // ── Phase transition check ────────────────────────────────
  const transition = checkPhaseTransition(gameAfterTurn, ruleSet.phases);
  if (transition) {
    if (isTerminalTransition(transition.to)) {
      gameAfterTurn = applyPatch(gameAfterTurn, {
        status: "finished",
        appendEvents: [{
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "game_ended",
          actorId:   "system",
          payload:   { reason: transition.conditionType, to: transition.to },
        }],
      });
    } else if (isPhaseTransition(transition.to)) {
      gameAfterTurn = applyPatch(gameAfterTurn, {
        phase: transition.to,
        appendEvents: [{
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "phase_changed",
          actorId:   "system",
          payload: {
            from:   game.phase,
            to:     transition.to,
            reason: transition.conditionType,
          },
        }],
      });
    }
  }

  return gameAfterTurn;
}

// ============================================================
// draw_card
// ============================================================

function applyDrawCard(game: Game, _action: DrawCardAction, ctx: EngineContext): Game {
  const { actorId } = ctx;

  if (game.deck.length === 0) {
    // No cards available — just advance the turn
    return applyPatch(game, { currentTurnIndex: nextTurnIndex(game) });
  }

  const [drawnCard, ...remainingDeck] = game.deck;
  const updatedHand = [...(game.hands[actorId] ?? []), drawnCard];
  const gameAfterDraw = applyPatch(game, {
    deck:  remainingDeck,
    hands: { ...game.hands, [actorId]: updatedHand },
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "card_drawn",
      actorId,
      payload:   { cardId: drawnCard },
    }],
  });

  return applyPatch(gameAfterDraw, { currentTurnIndex: nextTurnIndex(gameAfterDraw) });
}

// ============================================================
// remove_bug
// ============================================================

function payRemovalCost(
  game: Game,
  actorId: PlayerId,
  cost: RemovalCost,
  costCardIds: CardId[],
  patch: GamePatch,
): GamePatch {
  switch (cost.type) {
    case "hp": {
      if (!game.raidState) return patch;
      const newHPs = {
        ...game.raidState.playerHPs,
        [actorId]: (game.raidState.playerHPs[actorId] ?? 0) - cost.amount,
      };
      return { ...patch, raidState: { ...game.raidState, playerHPs: newHPs } };
    }
    case "hand_card": {
      const toRemove = costCardIds.slice(0, cost.amount);
      const newHand = (game.hands[actorId] ?? []).filter(id => !toRemove.includes(id));
      return {
        ...patch,
        hands:        { ...game.hands, [actorId]: newHand },
        excludedCards: [...(patch.excludedCards ?? game.excludedCards), ...toRemove],
      };
    }
    case "composite": {
      return cost.costs.reduce(
        (acc, subCost) => payRemovalCost(game, actorId, subCost, costCardIds, acc),
        patch,
      );
    }
  }
}

function applyRemoveBug(game: Game, action: RemoveBugAction, ctx: EngineContext): Game {
  const { actorId, ruleSet } = ctx;
  const bugDef = ruleSet.bugs.find(b => b.id === action.bugId);
  if (!bugDef) return game; // Already validated upstream

  let patch: GamePatch = {
    residualBugs: game.residualBugs.filter(id => id !== action.bugId),
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "bug_removed",
      actorId,
      payload:   { bugId: action.bugId },
    }],
  };

  patch = payRemovalCost(game, actorId, bugDef.removalCost, action.costCardIds ?? [], patch);

  return applyPatch(game, patch);
}

// ============================================================
// reset_or_raid
// ============================================================

function applyReset(game: Game, actorId: PlayerId, ruleSet: RuleSet, rng: () => number): Game {
  // The 0 card is the last card on the field — move it to excludedCards
  const lastFieldCard = game.field[game.field.length - 1];
  const newField = game.field.slice(0, -1);
  const newExcluded = lastFieldCard
    ? [...game.excludedCards, lastFieldCard.cardId]
    : [...game.excludedCards];

  const newSetNumber = evaluateSetNumberFormula(
    ruleSet.initialConfig.setNumberFormula,
    game.gameIndex,
  );

  // Return all hands to deck and deal fresh hands
  const allHandCards = Object.values(game.hands).flat();
  const shuffledDeck = shuffleArray([...game.deck, ...allHandCards], rng);
  const { initialHandSize } = ruleSet.initialConfig;

  const newHands: Record<PlayerId, CardId[]> = {};
  let remaining = shuffledDeck;
  for (const pid of game.turnOrder) {
    newHands[pid] = remaining.slice(0, initialHandSize);
    remaining = remaining.slice(initialHandSize);
  }

  const newResetCount = game.resetCount + 1;

  return applyPatch(game, {
    field:            newField,
    excludedCards:    newExcluded,
    setNumber:        newSetNumber,
    deck:             remaining,
    hands:            newHands,
    resetCount:       newResetCount,
    currentTurnIndex: 0, // Turn resets to first player
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "game_reset",
      actorId,
      payload:   { newSetNumber, resetCount: newResetCount },
    }],
  });
}

function applyRaidStart(game: Game, actorId: PlayerId, ruleSet: RuleSet): Game {
  // bossHP = sum of rawValues of all field cards (not effectiveValue — CLAUDE.md spec)
  const bossHP = game.field.reduce((sum, fc) => sum + fc.rawValue, 0);

  const { initialHP } = ruleSet.initialConfig;
  const playerHPs: Record<PlayerId, number> = {};
  for (const pid of game.turnOrder) {
    playerHPs[pid] = initialHP;
  }

  // The player who played the 0 card becomes the boss
  const bossPlayerId = actorId;
  const playerTurnOrder = game.turnOrder.filter(pid => pid !== bossPlayerId);

  const raidState = {
    bossPlayerId,
    bossHP,
    playerHPs,
    activeBugId:      "",
    roundIndex:       0,
    turnOrder:        playerTurnOrder,
    currentTurnIndex: 0,
    bossActionsLeft:  Math.ceil(game.turnOrder.length / 2),
  };

  // Clear the field — move all field card IDs to excludedCards
  const allFieldCardIds = game.field.map(fc => fc.cardId);

  return applyPatch(game, {
    phase:        "raid",
    field:        [],
    excludedCards: [...game.excludedCards, ...allFieldCardIds],
    raidState,
    appendEvents: [
      {
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "raid_started",
        actorId,
        payload:   { bossHP, bossPlayerId },
      },
      {
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "phase_changed",
        actorId:   "system",
        payload:   { from: "normal", to: "raid", reason: "card_zero_played_raid" },
      },
    ],
  });
}

function applyResetOrRaid(game: Game, action: ResetOrRaidAction, ctx: EngineContext): Game {
  const { actorId, ruleSet, rng = Math.random } = ctx;
  const target = resolveZeroCardTransition(action.choice);

  if (target === "normal") {
    return applyReset(game, actorId, ruleSet, rng);
  } else {
    return applyRaidStart(game, actorId, ruleSet);
  }
}

// ============================================================
// applyAction — main entry point
// ============================================================

/**
 * Apply a game action and return the updated Game state.
 * Pure function (no I/O side effects; uses optional rng for shuffling).
 *
 * Processing order:
 *   ActionValidator → ArithmeticJudge → EffectResolver → TurnManager → PhaseController
 *
 * Throws an Error with errorCode if the action is invalid.
 */
export function applyAction(game: Game, action: Action, ctx: EngineContext): Game {
  const validation = validate(game, action, {
    actorId: ctx.actorId,
    ruleSet:  ctx.ruleSet,
  });

  if (!validation.valid) {
    throw new Error(validation.errorCode ?? "INVALID_ACTION");
  }

  switch (action.type) {
    case "play_card":
      return applyPlayCard(game, action, ctx);
    case "draw_card":
      return applyDrawCard(game, action, ctx);
    case "remove_bug":
      return applyRemoveBug(game, action, ctx);
    case "reset_or_raid":
      return applyResetOrRaid(game, action, ctx);
    case "select_strategy":
      // select_strategy is a session-level action; GameEngine returns game unchanged
      return game;
  }
}
