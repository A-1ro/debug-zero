import type {
  Game,
  GamePatch,
  Action,
  PlayCardAction,
  DrawCardAction,
  RemoveBugAction,
  ResetOrRaidAction,
  ShowdownSubmitAction,
  InterventionResponseAction,
  ChooseRaidBugAction,
  SkipTurnAction,
  Operation,
  PlayerId,
  StrategyId,
  CardId,
  BugId,
  Card,
  FieldCard,
  RaidState,
  EventLog,
  EventId,
} from "../../shared/types/domain";
import type { RuleSet, RemovalCost } from "../../shared/types/rules";
import type { EffectContext } from "../../shared/types/effects";
import { validate, raidPlayerHasLegalMove, normalPlayerHasLegalMove } from "./ActionValidator";
import { resolve as arithmeticResolve } from "./ArithmeticJudge";
import { nextTurnIndex } from "./TurnManager";
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
    ...(patch.turnOrder          !== undefined && { turnOrder:          patch.turnOrder }),
    ...(patch.currentTurnIndex   !== undefined && { currentTurnIndex:   patch.currentTurnIndex }),
    ...(patch.resetCount         !== undefined && { resetCount:         patch.resetCount }),
    ...(patch.residualBugs       !== undefined && { residualBugs:       patch.residualBugs }),
    ...(patch.winnerId           !== undefined && { winnerId:           patch.winnerId }),
    ...(patch.winnerIds          !== undefined && { winnerIds:          patch.winnerIds }),
    ...(patch.showdownState      !== undefined && { showdownState:      patch.showdownState }),
    // raidState: null means clear the field; undefined means no change
    ...(patch.raidState !== undefined && {
      raidState: patch.raidState === null ? undefined : patch.raidState,
    }),
    // pendingIntervention: null means clear; undefined means no change
    ...(patch.pendingIntervention !== undefined && {
      pendingIntervention: patch.pendingIntervention === null ? undefined : patch.pendingIntervention,
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
  // Raid combat has entirely different card semantics (HP damage, no arithmetic)
  if (game.phase === "raid") {
    return applyRaidPlayCard(game, action, ctx);
  }

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
    // Exact pre-card setNumber so handlers can undo the card's arithmetic
    // without reverse-computing (div/Math.ceil is not exactly reversible)
    setNumberBefore: arith.before,
  };

  // 1. Actor's strategy effects (on_card_played)
  const ownPatch = effectResolver.resolve(gameAfterCard, "on_card_played", effectCtx, playerStrategies);
  gameAfterCard = applyPatch(gameAfterCard, ownPatch);

  // 2. Other players' intervention strategies (on_card_played_by_other) are
  //    OPTIONAL (owner ruling A1): instead of auto-resolving, offer the choice
  //    to every candidate and wait. The turn does NOT advance and no
  //    replacement card is drawn until all candidates respond (or time out).
  //    Zero candidates → continue immediately with no waiting at all.
  const candidates = effectResolver.collectInterventionCandidates(
    gameAfterCard, effectCtx, playerStrategies,
  );
  if (candidates.length > 0) {
    return applyPatch(gameAfterCard, {
      pendingIntervention: {
        triggerCard:     gameAfterCard.field[gameAfterCard.field.length - 1],
        actorId,
        setNumberBefore: arith.before,
        candidates,
        responses:       {},
      },
    });
  }

  return continueAfterCardEffects(gameAfterCard, {
    cardId:          action.cardId,
    value,
    actorId,
    setNumberBefore: arith.before,
    isAggroActive,
    ruleSet,
  });
}

// ============================================================
// Shared play_card continuation (post-effect resolution)
// ============================================================

/**
 * Everything that happens after a played card's effects are settled:
 * Aggro bust check → 0-card wait → setNumber==0 win → replacement draw →
 * turn advance → phase transition. Shared by the no-candidate play_card path
 * and the intervention-resolution path (A1).
 */
function continueAfterCardEffects(
  gameAfterCard: Game,
  params: {
    cardId:          CardId;
    value:           number;
    actorId:         PlayerId;
    setNumberBefore: number;
    isAggroActive:   boolean;
    ruleSet:         RuleSet;
  },
): Game {
  const { cardId, value, actorId, setNumberBefore, isAggroActive, ruleSet } = params;

  // ── Aggro bust: eliminate actor when Aggro causes setNumber < 0 ─
  // Non-Aggro players going negative is allowed (game continues).
  if (gameAfterCard.setNumber < 0 && isAggroActive) {
    const survivingPlayers = gameAfterCard.turnOrder.filter(pid => pid !== actorId);
    const eliminatedEvent = {
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "player_eliminated" as const,
      actorId:   "system" as const,
      payload:   { eliminatedId: actorId, reason: "set_number_negative" },
    };

    // Clear the eliminated player's hand (so it won't re-enter deck on reset)
    const handsWithoutActor = { ...gameAfterCard.hands, [actorId]: [] as typeof gameAfterCard.hands[typeof actorId] };

    if (survivingPlayers.length === 0) {
      // Degenerate case (should not happen in normal play)
      return applyPatch(gameAfterCard, {
        status: "finished",
        appendEvents: [eliminatedEvent],
      });
    }

    if (survivingPlayers.length === 1) {
      // Last player standing — they win
      return applyPatch(gameAfterCard, {
        status:    "finished",
        winnerId:  survivingPlayers[0],
        turnOrder: survivingPlayers,
        hands:     handsWithoutActor,
        appendEvents: [
          eliminatedEvent,
          {
            id:        newEventId(),
            timestamp: Date.now(),
            type:      "game_ended",
            actorId:   "system",
            payload:   { reason: "last_player_standing", winnerId: survivingPlayers[0] },
          },
        ],
      });
    }

    // Multiple players survive — undo the bust and continue
    const nextTurnIdx = gameAfterCard.currentTurnIndex % survivingPlayers.length;
    return applyPatch(gameAfterCard, {
      turnOrder:        survivingPlayers,
      currentTurnIndex: nextTurnIdx,
      setNumber:        setNumberBefore,
      // Remove the bust card by cardId (not slice) to be safe against future field effects
      field:            gameAfterCard.field.filter(fc => fc.cardId !== cardId),
      excludedCards:    [...gameAfterCard.excludedCards, cardId],
      hands:            handsWithoutActor,
      appendEvents:     [eliminatedEvent],
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
            from:   gameAfterCard.phase,
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
// intervention_response (A1)
// ============================================================

/**
 * Record one candidate's accept/pass. When every candidate has responded,
 * resolve the accepted interventions in candidate order (turn order starting
 * after the actor), then run the normal play_card continuation.
 *
 * Pass (activate=false) and timeout do NOT consume the strategy's
 * once-per-game usage right — only an actual activation counts (the rule
 * documents never state that declining consumes the right; adopted ruling).
 */
function applyInterventionResponse(
  game: Game,
  action: InterventionResponseAction,
  ctx: EngineContext,
): Game {
  const pi = game.pendingIntervention!; // validated upstream
  const { effectResolver, ruleSet, playerStrategies } = ctx;

  const responses = { ...pi.responses, [ctx.actorId]: action.activate };

  // Still waiting for other candidates — just record the response
  if (!pi.candidates.every(c => c.playerId in responses)) {
    return applyPatch(game, {
      pendingIntervention: { ...pi, responses },
    });
  }

  // All responded — resolve accepted interventions in candidate order.
  // Effects see the results of previously-resolved interventions (e.g.
  // TrickStar removing the card makes a later Control-* a no-op, which then
  // does not consume its usage right).
  let resolved = applyPatch(game, { pendingIntervention: null });
  const effectCtx: EffectContext = {
    actorId:         pi.actorId,
    triggerCard:     pi.triggerCard,
    ruleSet,
    setNumberBefore: pi.setNumberBefore,
  };
  for (const candidate of pi.candidates) {
    if (!responses[candidate.playerId]) continue; // pass — right preserved
    const patch = effectResolver.applyIntervention(
      resolved, candidate.playerId, candidate.strategyId, effectCtx,
    );
    resolved = applyPatch(resolved, patch);
  }

  const isAggroActive =
    playerStrategies[pi.actorId] === "Aggro" &&
    !resolved.residualBugs.includes("Aggro-Forbidden");

  return continueAfterCardEffects(resolved, {
    cardId:          pi.triggerCard.cardId,
    value:           pi.triggerCard.rawValue,
    actorId:         pi.actorId,
    setNumberBefore: pi.setNumberBefore,
    isAggroActive,
    ruleSet,
  });
}

// ============================================================
// draw_card
// ============================================================

function applyDrawCard(game: Game, _action: DrawCardAction, ctx: EngineContext): Game {
  const { actorId } = ctx;

  // D10 (owner ruling): self-draw (手札補充) is a raid-phase-only action.
  // Normal-phase draws are rejected upstream by validateDrawCard; the normal
  // hand auto-refills after each card play (see continueAfterCardEffects). This
  // guard is defensive — applyAction never reaches here outside a raid.
  const rs = game.raidState;
  if (game.phase !== "raid" || !rs) {
    return game;
  }

  // Raid refill: draw one card, then pass the raid turn
  const [drawnCard, ...remainingDeck] = game.deck;
  return applyPatch(game, {
    deck:  remainingDeck,
    hands: { ...game.hands, [actorId]: [...(game.hands[actorId] ?? []), drawnCard] },
    raidState: {
      ...rs,
      ...advanceRaidPlayerTurn(rs),
    },
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "card_drawn",
      actorId,
      payload:   { cardId: drawnCard, raid: true },
    }],
  });
}

// ============================================================
// showdown_submit
// ============================================================

/** Combine up to two card values with an operation (div rounds up, like ArithmeticJudge). */
function combineShowdownValue(values: number[], operation?: Operation): number {
  if (values.length === 1) return values[0];
  const [a, b] = values;
  switch (operation) {
    case "add": return a + b;
    case "sub": return a - b;
    case "mul": return a * b;
    case "div": return Math.ceil(a / b); // b=0 is rejected by the validator
    default:    return a + b; // unreachable (validator requires operation for 2 cards)
  }
}

/**
 * Showdown (§5.3 決戦フェーズ): each surviving player submits 1-2 cards with an
 * operation; once everyone has submitted, the value closest to setNumber wins.
 * Ties: fewer cards wins; still tied → all tied players win.
 */
function applyShowdownSubmit(game: Game, action: ShowdownSubmitAction, ctx: EngineContext): Game {
  const { actorId } = ctx;

  const value = combineShowdownValue(action.cardIds.map(cardValueFromId), action.operation);
  const submissions = {
    ...(game.showdownState?.submissions ?? {}),
    [actorId]: { cardIds: action.cardIds, value },
  };
  const newHand = (game.hands[actorId] ?? []).filter(id => !action.cardIds.includes(id));

  let updated = applyPatch(game, {
    hands:         { ...game.hands, [actorId]: newHand },
    excludedCards: [...game.excludedCards, ...action.cardIds],
    showdownState: { submissions },
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "showdown_submitted",
      actorId,
      payload:   { cardIds: action.cardIds, value },
    }],
  });

  // Judge once every surviving player has submitted
  const alive = updated.turnOrder;
  if (!alive.every(pid => submissions[pid])) return updated;

  let winners: PlayerId[] = [];
  let bestDist = Infinity;
  let bestCount = Infinity;
  for (const pid of alive) {
    const sub = submissions[pid];
    const dist = Math.abs(updated.setNumber - sub.value);
    const count = sub.cardIds.length;
    if (dist < bestDist || (dist === bestDist && count < bestCount)) {
      winners = [pid];
      bestDist = dist;
      bestCount = count;
    } else if (dist === bestDist && count === bestCount) {
      winners.push(pid);
    }
  }

  return applyPatch(updated, {
    status:    "finished",
    winnerId:  winners[0],
    winnerIds: winners,
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "game_ended",
      actorId:   "system",
      payload: {
        winType:  "showdown_closest",
        winnerIds: winners,
        distance:  bestDist,
        submissions,
      },
    }],
  });
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
      // Only cards that actually satisfy the cost criteria may be spent —
      // slicing the raw list allowed paying an even-card cost with an odd card
      const hand = game.hands[actorId] ?? [];
      const eligible = costCardIds.filter(id => {
        if (!hand.includes(id)) return false;
        const v = cardValueFromId(id);
        if (cost.value === "any") return true;
        if (cost.value === "even") return v % 2 === 0;
        if (cost.value === "odd") return v % 2 !== 0;
        return v === cost.value;
      });
      const toRemove = eligible.slice(0, cost.amount);
      const newHand = hand.filter(id => !toRemove.includes(id));
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

  // Raid: bug removal consumes the player's raid turn and clears the active bug
  if (game.phase === "raid" && game.raidState) {
    const rs = patch.raidState && patch.raidState !== null ? patch.raidState : game.raidState;

    // An HP removal cost may knock the payer out (e.g. paying HP-3 at exactly
    // 3 HP) — same elimination path as being hit by the boss (D6). The remover
    // is always the current (non-boss) player, so removal always ends their turn.
    const events: EventLog[] = [];
    let turn: { turnOrder: PlayerId[]; currentTurnIndex: number; bossTurn: boolean };
    if ((rs.playerHPs[actorId] ?? 1) <= 0) {
      turn = removeRaidPlayerFromTurn(rs, actorId);
      events.push({
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "player_eliminated",
        actorId:   "system",
        payload:   { playerId: actorId, reason: "raid_hp_zero" },
      });
    } else {
      turn = advanceRaidPlayerTurn(rs);
    }

    patch = {
      ...patch,
      raidState: {
        ...rs,
        activeBugId: rs.activeBugId === action.bugId ? "" : rs.activeBugId,
        turnOrder:        turn.turnOrder,
        currentTurnIndex: turn.currentTurnIndex,
        bossTurn:         turn.bossTurn,
      },
      appendEvents: [...(patch.appendEvents ?? []), ...events],
    };

    // All players may now be dead (boss wins) — same end check as boss attacks
    return resolveRaidEnd(applyPatch(game, patch), actorId);
  }

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

// ── Raid round machinery (D2 boss bug choice / D3 1D10 turn order) ─────────

/** Not-yet-active bugs the boss may choose from at a round start (D2). */
function raidBugCandidates(residualBugs: BugId[], ruleSet: RuleSet): BugId[] {
  return ruleSet.bugs.map(b => b.id).filter(id => !residualBugs.includes(id));
}

/** One 1D10 roll (1..10). */
function rollD10(rng: () => number): number {
  return Math.floor(rng() * 10) + 1;
}

/**
 * D3: roll 1D10 per player and order them by roll, descending. Ties are
 * re-rolled among the tied players only, recursively, until each rank is
 * unique. `diceResults` records each player's FINAL roll (the one that placed
 * them). A depth cap guards against a degenerate rng that can never break a tie
 * (falls back to playerId order for the still-tied group).
 */
function rollRaidTurnOrder(
  players: PlayerId[],
  rng: () => number,
): { order: PlayerId[]; diceResults: Record<PlayerId, number> } {
  const diceResults: Record<PlayerId, number> = {};

  const rank = (group: PlayerId[], depth: number): PlayerId[] => {
    const rolls: Record<PlayerId, number> = {};
    for (const p of group) rolls[p] = rollD10(rng);

    const byRoll = new Map<number, PlayerId[]>();
    for (const p of group) {
      const bucket = byRoll.get(rolls[p]) ?? [];
      bucket.push(p);
      byRoll.set(rolls[p], bucket);
    }

    const out: PlayerId[] = [];
    for (const value of [...byRoll.keys()].sort((a, b) => b - a)) {
      const tied = byRoll.get(value)!;
      if (tied.length === 1 || depth >= 100) {
        // resolved (or give up re-rolling: deterministic playerId fallback)
        const ordered = tied.length === 1 ? tied : [...tied].sort();
        for (const p of ordered) { diceResults[p] = value; out.push(p); }
      } else {
        // re-roll among the tied players only (D3)
        out.push(...rank(tied, depth + 1));
      }
    }
    return out;
  };

  return { order: rank(players, 0), diceResults };
}

/** Advance the raid turn after a player has acted: next player, or the boss. */
function advanceRaidPlayerTurn(
  rs: RaidState,
): { turnOrder: PlayerId[]; currentTurnIndex: number; bossTurn: boolean } {
  const nextIdx = rs.currentTurnIndex + 1;
  if (nextIdx >= rs.turnOrder.length) {
    // every player has acted → the boss's turn(s)
    return { turnOrder: rs.turnOrder, currentTurnIndex: rs.turnOrder.length, bossTurn: true };
  }
  return { turnOrder: rs.turnOrder, currentTurnIndex: nextIdx, bossTurn: false };
}

/**
 * Remove the acting player from the raid rotation (their HP hit 0). Since the
 * remover is the current player, the following player shifts into the same
 * slot; if they were the last player, the boss takes over.
 */
function removeRaidPlayerFromTurn(
  rs: RaidState,
  actorId: PlayerId,
): { turnOrder: PlayerId[]; currentTurnIndex: number; bossTurn: boolean } {
  const turnOrder = rs.turnOrder.filter(pid => pid !== actorId);
  if (rs.currentTurnIndex >= turnOrder.length) {
    return { turnOrder, currentTurnIndex: turnOrder.length, bossTurn: true };
  }
  return { turnOrder, currentTurnIndex: rs.currentTurnIndex, bossTurn: false };
}

/** Alive (HP > 0) non-boss players — the ones who roll for turn order. */
function aliveRaidPlayers(playerHPs: Record<PlayerId, number>): PlayerId[] {
  return Object.keys(playerHPs).filter(pid => (playerHPs[pid] ?? 0) > 0) as PlayerId[];
}

/**
 * Refill the boss's hand up to `targetSize` by drawing from the top of the deck
 * (C ruling: レイド戦でボスも手札を補充する). Bounded by deck size — never draws
 * more cards than exist. Returns updated hands/deck plus the cards drawn (empty
 * when the boss is already at/above target or the deck is empty). Pure.
 */
function refillBossHand(
  hands: Record<PlayerId, CardId[]>,
  deck: CardId[],
  bossPlayerId: PlayerId,
  targetSize: number,
): { hands: Record<PlayerId, CardId[]>; deck: CardId[]; drawn: CardId[] } {
  const bossHand = hands[bossPlayerId] ?? [];
  const need = Math.min(Math.max(0, targetSize - bossHand.length), deck.length);
  if (need === 0) return { hands, deck, drawn: [] };
  const drawn = deck.slice(0, need);
  return {
    hands: { ...hands, [bossPlayerId]: [...bossHand, ...drawn] },
    deck:  deck.slice(need),
    drawn,
  };
}

/**
 * Begin a raid round once the bug is decided (D3): roll the 1D10 turn order,
 * activate the chosen bug, reset the boss action budget, and refill the boss's
 * hand (C ruling). Returns the fresh RaidState plus residualBugs, updated
 * hands/deck, and the round-start events.
 *
 * Boss refill (C ruling): mirrors how players top their hand up from the deck,
 * but at each round's start (the boss's natural cadence — it acts as a burst of
 * `bossActionsLeft` attacks, not a single draw-and-pass turn). The refill target
 * is max(bossHandSize, bossActionsLeft) so the boss can always complete its
 * attacks; the deck is recycled from the field at round end, so cards are
 * available here. This makes the empty-handed-boss freeze unreachable.
 */
function beginRaidRound(
  base: RaidState,
  chosenBug: BugId,
  residualBugs: BugId[],
  roundIndex: number,
  rng: () => number,
  hands: Record<PlayerId, CardId[]>,
  deck: CardId[],
  bossHandSize: number,
): {
  raidState: RaidState;
  residualBugs: BugId[];
  events: EventLog[];
  hands: Record<PlayerId, CardId[]>;
  deck: CardId[];
} {
  const alive = aliveRaidPlayers(base.playerHPs);
  const { order, diceResults } = rollRaidTurnOrder(alive, rng);
  const bossActionsLeft = Math.ceil(alive.length / 2);

  const newResidual = chosenBug && !residualBugs.includes(chosenBug)
    ? [...residualBugs, chosenBug]
    : residualBugs;

  const events: EventLog[] = [];
  if (chosenBug) {
    events.push({
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "bug_activated",
      actorId:   "system",
      payload:   { bugId: chosenBug, roundIndex },
    });
  }
  events.push({
    id:        newEventId(),
    timestamp: Date.now(),
    type:      "raid_round_started",
    actorId:   "system",
    payload:   { roundIndex, activeBugId: chosenBug, turnOrder: order, diceResults },
  });

  // Boss refill (C ruling): top the boss hand up so it can make all its attacks.
  const refill = refillBossHand(
    hands,
    deck,
    base.bossPlayerId,
    Math.max(bossHandSize, bossActionsLeft),
  );
  if (refill.drawn.length > 0) {
    events.push({
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "boss_hand_refilled",
      actorId:   "boss",
      payload:   { count: refill.drawn.length, roundIndex, raid: true },
    });
  }

  const raidState: RaidState = {
    ...base,
    activeBugId:      chosenBug,
    roundIndex,
    turnOrder:        order,
    diceResults,
    currentTurnIndex: 0,
    bossTurn:         false,
    bossActionsLeft,
    awaitingBugChoice: false,
    bugCandidates:    undefined,
  };

  return {
    raidState,
    residualBugs: newResidual,
    events,
    hands: refill.hands,
    deck:  refill.deck,
  };
}

/**
 * Start the next raid round. If any bug is still available the boss must first
 * choose one (D2) — enter the awaiting-choice state and wait. Otherwise (every
 * bug already active) roll the turn order and begin immediately.
 */
/**
 * Optional data-driven floor for the boss's per-round hand refill (C ruling).
 * Unset (0) means "refill to exactly the round's action budget" (bossActionsLeft);
 * a positive value gives the boss a reserve above its budget. The effective
 * target is computed in beginRaidRound as max(bossActionsLeft, this).
 */
function bossHandTarget(ruleSet: RuleSet): number {
  return ruleSet.initialConfig.raidBossHandSize ?? 0;
}

function enterNextRaidRound(
  combat: { bossPlayerId: PlayerId; bossHP: number; playerHPs: Record<PlayerId, number> },
  residualBugs: BugId[],
  ruleSet: RuleSet,
  roundIndex: number,
  rng: () => number,
  hands: Record<PlayerId, CardId[]>,
  deck: CardId[],
): {
  raidState: RaidState;
  residualBugs: BugId[];
  events: EventLog[];
  hands: Record<PlayerId, CardId[]>;
  deck: CardId[];
} {
  const base: RaidState = {
    bossPlayerId:     combat.bossPlayerId,
    bossHP:           combat.bossHP,
    playerHPs:        combat.playerHPs,
    activeBugId:      "",
    roundIndex,
    turnOrder:        [],
    currentTurnIndex: 0,
    bossActionsLeft:  0,
    bossTurn:         false,
  };

  const candidates = raidBugCandidates(residualBugs, ruleSet);
  if (candidates.length === 0) {
    // No bug to choose → the round begins now, so refill the boss here.
    return beginRaidRound(base, "", residualBugs, roundIndex, rng, hands, deck, bossHandTarget(ruleSet));
  }
  // The boss must first pick a bug; the round (and boss refill) begins once the
  // choice resolves in applyChooseRaidBug. Leave hands/deck untouched for now.
  return {
    raidState: { ...base, awaitingBugChoice: true, bugCandidates: candidates },
    residualBugs,
    events: [],
    hands,
    deck,
  };
}

function applyRaidStart(game: Game, actorId: PlayerId, ruleSet: RuleSet, rng: () => number): Game {
  // bossHP = sum of rawValues of all field cards (not effectiveValue — CLAUDE.md spec)
  const bossHP = game.field.reduce((sum, fc) => sum + fc.rawValue, 0);

  const { initialHP } = ruleSet.initialConfig;
  const playerHPs: Record<PlayerId, number> = {};
  for (const pid of game.turnOrder) {
    if (pid !== actorId) playerHPs[pid] = initialHP; // the 0-card player is the boss
  }

  // Round 1: the boss chooses the bug (D2), then 1D10 decides the order (D3).
  const next = enterNextRaidRound(
    { bossPlayerId: actorId, bossHP, playerHPs },
    game.residualBugs, ruleSet, 1, rng, game.hands, game.deck,
  );

  // Clear the field — move all field card IDs to excludedCards
  const allFieldCardIds = game.field.map(fc => fc.cardId);

  const events: EventLog[] = [
    {
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "raid_started",
      actorId,
      payload:   { bossHP, bossPlayerId: actorId },
    },
    {
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "phase_changed",
      actorId:   "system",
      payload:   { from: "normal", to: "raid", reason: "card_zero_played_raid" },
    },
    ...next.events,
  ];

  return applyPatch(game, {
    phase:         "raid",
    field:         [],
    hands:         next.hands,
    deck:          next.deck,
    excludedCards: [...game.excludedCards, ...allFieldCardIds],
    residualBugs:  next.residualBugs,
    raidState:     next.raidState,
    appendEvents:  events,
  });
}

/** D2: the boss's chosen bug resolves the awaiting state and begins the round. */
function applyChooseRaidBug(game: Game, action: ChooseRaidBugAction, ctx: EngineContext): Game {
  const rs = game.raidState!; // validated upstream (awaitingBugChoice, boss, candidate)
  const { ruleSet, rng = Math.random } = ctx;
  const begun = beginRaidRound(
    rs, action.bugId, game.residualBugs, rs.roundIndex, rng,
    game.hands, game.deck, bossHandTarget(ruleSet),
  );
  return applyPatch(game, {
    hands:        begun.hands,
    deck:         begun.deck,
    residualBugs: begun.residualBugs,
    raidState:    begun.raidState,
    appendEvents: begun.events,
  });
}

function applyResetOrRaid(game: Game, action: ResetOrRaidAction, ctx: EngineContext): Game {
  const { actorId, ruleSet, rng = Math.random } = ctx;
  const target = resolveZeroCardTransition(action.choice);

  if (target === "normal") {
    return applyReset(game, actorId, ruleSet, rng);
  } else {
    return applyRaidStart(game, actorId, ruleSet, rng);
  }
}

// ============================================================
// raid combat
// ============================================================

/**
 * Raid-phase play_card (§5.3 レイド戦ラウンド):
 *  - players attack the boss: bossHP -= rawValue
 *  - the boss attacks a player: playerHP -= rawValue, ceil(playerCount/2) times
 *    per round; after the boss finishes, a new round starts (new bug spawns,
 *    empty deck is refilled by shuffling the field back in)
 * HP math always uses rawValue (Value-Corruption never affects HP — CLAUDE.md).
 */
function applyRaidPlayCard(game: Game, action: PlayCardAction, ctx: EngineContext): Game {
  const rs = game.raidState!;
  const { actorId, ruleSet, rng = Math.random } = ctx;
  const isBoss = actorId === rs.bossPlayerId;
  const value = cardValueFromId(action.cardId);
  const events: EventLog[] = [];

  // Card moves hand → field (the raid field is recycled into the deck at round end)
  const newHands = {
    ...game.hands,
    [actorId]: (game.hands[actorId] ?? []).filter(id => id !== action.cardId),
  };
  let field: FieldCard[] = [...game.field, {
    cardId:         action.cardId,
    playerId:       actorId,
    operation:      "add",
    rawValue:       value,
    effectiveValue: value,
  }];
  let deck = game.deck;
  let residualBugs = game.residualBugs;

  let bossHP = rs.bossHP;
  const playerHPs = { ...rs.playerHPs };
  let turnOrder = [...rs.turnOrder];
  let currentTurnIndex = rs.currentTurnIndex;
  let bossTurn = rs.bossTurn ?? false;
  let bossActionsLeft = rs.bossActionsLeft;
  let roundIndex = rs.roundIndex;
  let activeBugId = rs.activeBugId;
  let diceResults = rs.diceResults;
  let awaitingBugChoice = false;
  let bugCandidates: BugId[] | undefined = undefined;

  events.push({
    id:        newEventId(),
    timestamp: Date.now(),
    type:      "card_played",
    actorId,
    payload:   { cardId: action.cardId, target: isBoss ? action.targetId : "boss", raid: true },
  });

  if (isBoss) {
    const target = action.targetId as PlayerId;
    playerHPs[target] = (playerHPs[target] ?? 0) - value;
    events.push({
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "hp_changed",
      actorId,
      payload:   { target, delta: -value, hp: playerHPs[target] },
    });
    // A player at 0 HP drops out of the raid rotation. The boss holds the turn
    // (bossTurn), so the boss slot stays at the end of the shrunken order.
    if (playerHPs[target] <= 0 && turnOrder.includes(target)) {
      turnOrder = turnOrder.filter(pid => pid !== target);
      currentTurnIndex = turnOrder.length;
      events.push({
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "player_eliminated",
        actorId:   "system",
        payload:   { playerId: target, reason: "raid_hp_zero" },
      });
    }

    bossActionsLeft--;
    if (bossActionsLeft <= 0 && aliveRaidPlayers(playerHPs).length > 0) {
      // Round complete → next round. An empty deck is rebuilt by shuffling the
      // field back in (§5.3-5), then the boss chooses the next bug (D2) and
      // 1D10 re-decides the order (D3).
      if (deck.length === 0 && field.length > 0) {
        deck = shuffleArray(field.map(fc => fc.cardId), rng);
        field = [];
      }
      const next = enterNextRaidRound(
        { bossPlayerId: rs.bossPlayerId, bossHP, playerHPs },
        residualBugs, ruleSet, roundIndex + 1, rng, newHands, deck,
      );
      residualBugs = next.residualBugs;
      Object.assign(newHands, next.hands);
      deck = next.deck;
      events.push(...next.events);
      const ns = next.raidState;
      turnOrder = ns.turnOrder;
      currentTurnIndex = ns.currentTurnIndex;
      bossTurn = ns.bossTurn ?? false;
      bossActionsLeft = ns.bossActionsLeft;
      roundIndex = ns.roundIndex;
      activeBugId = ns.activeBugId;
      diceResults = ns.diceResults;
      awaitingBugChoice = ns.awaitingBugChoice ?? false;
      bugCandidates = ns.bugCandidates;
    }
    // else: boss keeps the turn (bossTurn stays true) until its actions run out
  } else {
    bossHP -= value;
    events.push({
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "hp_changed",
      actorId,
      payload:   { target: "boss", delta: -value, hp: bossHP },
    });
    const adv = advanceRaidPlayerTurn({ ...rs, turnOrder, currentTurnIndex });
    currentTurnIndex = adv.currentTurnIndex;
    bossTurn = adv.bossTurn;
  }

  const updated = applyPatch(game, {
    hands: newHands,
    field,
    deck,
    residualBugs,
    raidState: {
      ...rs,
      bossHP,
      playerHPs,
      turnOrder,
      currentTurnIndex,
      bossTurn,
      bossActionsLeft,
      roundIndex,
      activeBugId,
      diceResults,
      awaitingBugChoice,
      bugCandidates,
    },
    appendEvents: events,
  });

  return resolveRaidEnd(updated, actorId);
}

/** Decide raid victory/defeat after an attack (§5.3-6 checkRaidEnd). */
function resolveRaidEnd(game: Game, actorId: PlayerId): Game {
  const rs = game.raidState!;

  if (rs.bossHP <= 0) {
    const exactZero = rs.bossHP === 0;
    // Exact 0: every surviving player wins (+1 each), bugs are cleared.
    // Below 0: only the player who dealt the final blow wins, and the bugs
    // spawned in this raid stay residual for the next game (§11.5).
    const survivors = Object.entries(rs.playerHPs)
      .filter(([, hp]) => hp > 0)
      .map(([pid]) => pid as PlayerId);
    const winners = exactZero ? survivors : [actorId];
    return applyPatch(game, {
      status:    "finished",
      winnerId:  winners[0],
      winnerIds: winners,
      ...(exactZero ? { residualBugs: [] } : {}),
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "game_ended",
        actorId:   "system",
        payload: {
          winType: exactZero ? "raid_boss_hp_exact_zero" : "raid_boss_hp_below_zero",
          winnerIds: winners,
          bossHP: rs.bossHP,
        },
      }],
    });
  }

  const allPlayersDead = Object.values(rs.playerHPs).every(hp => hp <= 0);
  if (allPlayersDead) {
    // Boss defeats everyone — boss takes the whole session (handled upstream)
    return applyPatch(game, {
      status: "finished",
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "game_ended",
        actorId:   "system",
        payload:   { winType: "raid_all_players_dead", bossPlayerId: rs.bossPlayerId },
      }],
    });
  }

  return game;
}

// ============================================================
// skip_turn (owner ruling 2)
// ============================================================

/**
 * Skip the current (non-boss) raid player who has no legal move: advance the
 * raid rotation to the next player (or the boss) and record a turn_skipped
 * event. Validated upstream (validateSkipTurn). The applyAction post-pass then
 * cascades through any further stuck players.
 */
function applySkipTurn(game: Game, ctx: EngineContext): Game {
  // D10: normal-phase skip — the current player has no legal card to play and
  // self-draw is illegal. Advance the turn and record the skip.
  if (game.phase === "normal") {
    return applyPatch(game, {
      currentTurnIndex: nextTurnIndex(game),
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "turn_skipped",
        actorId:   "system",
        payload:   { playerId: ctx.actorId, reason: "no_legal_move" },
      }],
    });
  }

  const rs = game.raidState!; // validated upstream
  const adv = advanceRaidPlayerTurn(rs);
  return applyPatch(game, {
    raidState: {
      ...rs,
      turnOrder:        adv.turnOrder,
      currentTurnIndex: adv.currentTurnIndex,
      bossTurn:         adv.bossTurn,
    },
    appendEvents: [{
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "turn_skipped",
      actorId:   "system",
      payload:   { playerId: ctx.actorId, reason: "no_legal_move", roundIndex: rs.roundIndex },
    }],
  });
}

/**
 * Owner ruling 2 (proactive skip + deadlock fix): while the raid turn is on a
 * non-boss player who has zero legal moves (all cards forbidden, no draw, no
 * affordable removal), advance past them and emit turn_skipped. Cascades until
 * a player with a legal move is on the clock, or the boss's turn begins, or the
 * bug-choice wait is reached. Guarantees the raid can never freeze on a
 * fully-forbidden hand. Pure function.
 */
function skipStuckRaidPlayers(game: Game, ruleSet: RuleSet): Game {
  let g = game;
  let guard = 0;
  while (g.raidState && g.phase === "raid" && g.status === "in-progress") {
    const rs = g.raidState;
    if (rs.awaitingBugChoice || rs.bossTurn) break;
    const actor = rs.turnOrder[rs.currentTurnIndex];
    if (actor === undefined) break;
    if (raidPlayerHasLegalMove(g, actor, ruleSet)) break;
    // Safety net: currentTurnIndex only increases here, but never loop forever.
    if (guard++ > rs.turnOrder.length) break;
    const adv = advanceRaidPlayerTurn(rs);
    g = applyPatch(g, {
      raidState: {
        ...rs,
        turnOrder:        adv.turnOrder,
        currentTurnIndex: adv.currentTurnIndex,
        bossTurn:         adv.bossTurn,
      },
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "turn_skipped",
        actorId:   "system",
        payload:   { playerId: actor, reason: "no_legal_move", roundIndex: rs.roundIndex },
      }],
    });
  }
  return g;
}

/**
 * D10 (owner ruling): while the normal-phase turn is on a player who has zero
 * legal moves (every card bug-forbidden; self-draw is illegal), advance past
 * them and emit turn_skipped. Cascades until a player with a legal move is on
 * the clock. If a FULL rotation is skipped without anyone able to move (total
 * deadlock — e.g. both Odd- and Even-Forbidden active), the game is forced to
 * the showdown phase so it resolves instead of skipping forever (adopted ruling;
 * the old code drained the deck via draws to reach showdown, which draw removal
 * would otherwise strand). Pure function. Never runs while an intervention is
 * pending or a reset_or_raid choice is owed.
 */
function skipStuckNormalPlayers(game: Game, _ruleSet: RuleSet): Game {
  let g = game;
  let skipped = 0;
  while (
    g.phase === "normal" &&
    g.status === "in-progress" &&
    !g.pendingIntervention
  ) {
    const actor = g.turnOrder[g.currentTurnIndex];
    if (actor === undefined) break;
    if (normalPlayerHasLegalMove(g, actor)) break;

    if (skipped >= g.turnOrder.length) {
      // Went a full lap and nobody can move → force showdown to resolve.
      g = applyPatch(g, {
        phase: "showdown",
        appendEvents: [{
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "phase_changed",
          actorId:   "system",
          payload:   { from: "normal", to: "showdown", reason: "normal_deadlock" },
        }],
      });
      break;
    }

    g = applyPatch(g, {
      currentTurnIndex: nextTurnIndex(g),
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "turn_skipped",
        actorId:   "system",
        payload:   { playerId: actor, reason: "no_legal_move" },
      }],
    });
    skipped++;
  }
  return g;
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

  let result: Game;
  switch (action.type) {
    case "play_card":
      result = applyPlayCard(game, action, ctx); break;
    case "draw_card":
      result = applyDrawCard(game, action, ctx); break;
    case "remove_bug":
      result = applyRemoveBug(game, action, ctx); break;
    case "reset_or_raid":
      result = applyResetOrRaid(game, action, ctx); break;
    case "showdown_submit":
      result = applyShowdownSubmit(game, action, ctx); break;
    case "intervention_response":
      result = applyInterventionResponse(game, action, ctx); break;
    case "choose_raid_bug":
      result = applyChooseRaidBug(game, action, ctx); break;
    case "skip_turn":
      result = applySkipTurn(game, ctx); break;
    case "select_strategy":
      // select_strategy is a session-level action; GameEngine returns game unchanged
      result = game; break;
  }

  // Owner ruling 2 (deadlock fix): after any raid action, proactively skip any
  // non-boss player who is now on the clock with zero legal moves so the game
  // never stalls on a fully bug-forbidden hand.
  if (result.phase === "raid" && result.status === "in-progress" && result.raidState) {
    result = skipStuckRaidPlayers(result, ctx.ruleSet);
  } else if (
    result.phase === "normal" &&
    result.status === "in-progress" &&
    !result.pendingIntervention
  ) {
    // D10 (deadlock fix): after any normal-phase action, proactively skip any
    // player now on the clock with zero legal moves so the game never stalls on
    // a fully bug-forbidden hand (self-draw is no longer a legal escape).
    result = skipStuckNormalPlayers(result, ctx.ruleSet);
  }
  return result;
}
