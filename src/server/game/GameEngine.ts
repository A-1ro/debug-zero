import type {
  Game,
  GamePatch,
  Action,
  PlayCardAction,
  DrawCardAction,
  RemoveBugAction,
  ResetOrRaidAction,
  ShowdownSubmitAction,
  Operation,
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

  // 2. Other players' strategy effects (on_card_played_by_other)
  const otherPatch = effectResolver.resolve(gameAfterCard, "on_card_played_by_other", effectCtx, playerStrategies);
  gameAfterCard = applyPatch(gameAfterCard, otherPatch);

  // ── Aggro bust: eliminate actor when Aggro causes setNumber < 0 ─
  // Non-Aggro players going negative is allowed (game continues).
  if (gameAfterCard.setNumber < 0 && isAggroActive) {
    const survivingPlayers = game.turnOrder.filter(pid => pid !== actorId);
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
    const nextTurnIdx = game.currentTurnIndex % survivingPlayers.length;
    return applyPatch(gameAfterCard, {
      turnOrder:        survivingPlayers,
      currentTurnIndex: nextTurnIdx,
      setNumber:        arith.before,
      // Remove the bust card by cardId (not slice) to be safe against future field effects
      field:            gameAfterCard.field.filter(fc => fc.cardId !== action.cardId),
      excludedCards:    [...gameAfterCard.excludedCards, action.cardId],
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
  const { actorId, ruleSet } = ctx;

  // Raid refill (手札補充): draw one card, then pass the raid turn
  if (game.phase === "raid" && game.raidState) {
    const rs = game.raidState;
    const [drawnCard, ...remainingDeck] = game.deck;
    return applyPatch(game, {
      deck:  remainingDeck,
      hands: { ...game.hands, [actorId]: [...(game.hands[actorId] ?? []), drawnCard] },
      raidState: {
        ...rs,
        currentTurnIndex: nextRaidTurnIndex(rs.currentTurnIndex, rs.turnOrder),
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

  let gameAfterDraw = game;
  if (game.deck.length > 0) {
    const [drawnCard, ...remainingDeck] = game.deck;
    const updatedHand = [...(game.hands[actorId] ?? []), drawnCard];
    gameAfterDraw = applyPatch(game, {
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
  }

  const gameAfterTurn = applyPatch(gameAfterDraw, {
    currentTurnIndex: nextTurnIndex(gameAfterDraw),
  });

  // Deck may have just run out — the deck-empty → showdown transition must
  // fire on draws too, not only on card plays (otherwise the game stalls in
  // normal phase until someone happens to play a card)
  const transition = checkPhaseTransition(gameAfterTurn, ruleSet.phases);
  if (transition && isPhaseTransition(transition.to)) {
    return applyPatch(gameAfterTurn, {
      phase: transition.to,
      appendEvents: [{
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "phase_changed",
        actorId:   "system",
        payload: {
          from:   gameAfterTurn.phase,
          to:     transition.to,
          reason: transition.conditionType,
        },
      }],
    });
  }

  return gameAfterTurn;
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
    let turnOrder = rs.turnOrder;
    let currentTurnIndex = nextRaidTurnIndex(rs.currentTurnIndex, rs.turnOrder);

    // An HP removal cost may knock the payer out (e.g. paying HP-3 at exactly
    // 3 HP) — same elimination path as being hit by the boss (D6)
    const events: EventLog[] = [];
    if ((rs.playerHPs[actorId] ?? 1) <= 0) {
      const elim = eliminateRaidPlayer(turnOrder, currentTurnIndex, actorId);
      if (elim.removed) {
        turnOrder = elim.turnOrder;
        currentTurnIndex = elim.currentTurnIndex;
        events.push({
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "player_eliminated",
          actorId:   "system",
          payload:   { playerId: actorId, reason: "raid_hp_zero" },
        });
      }
    }

    patch = {
      ...patch,
      raidState: {
        ...rs,
        activeBugId: rs.activeBugId === action.bugId ? "" : rs.activeBugId,
        turnOrder,
        currentTurnIndex,
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

/** Pick a random not-yet-active bug for a new raid round ("" if none left). */
function pickRaidBug(residualBugs: string[], ruleSet: RuleSet, rng: () => number): string {
  const candidates = ruleSet.bugs.map(b => b.id).filter(id => !residualBugs.includes(id));
  if (candidates.length === 0) return "";
  return candidates[Math.floor(rng() * candidates.length)];
}

function applyRaidStart(game: Game, actorId: PlayerId, ruleSet: RuleSet, rng: () => number): Game {
  // bossHP = sum of rawValues of all field cards (not effectiveValue — CLAUDE.md spec)
  const bossHP = game.field.reduce((sum, fc) => sum + fc.rawValue, 0);

  const { initialHP } = ruleSet.initialConfig;
  const playerHPs: Record<PlayerId, number> = {};
  for (const pid of game.turnOrder) {
    if (pid !== actorId) playerHPs[pid] = initialHP;
  }

  // The player who played the 0 card becomes the boss
  const bossPlayerId = actorId;
  const playerCount = game.turnOrder.length - 1;
  // Boss takes the last slot of each round (players act first, then the boss
  // acts ceil(playerCount / 2) times)
  const raidTurnOrder = [...game.turnOrder.filter(pid => pid !== bossPlayerId), bossPlayerId];

  // Round start: a bug spawns (removable during the raid via remove_bug)
  const spawnedBug = pickRaidBug(game.residualBugs, ruleSet, rng);

  const raidState = {
    bossPlayerId,
    bossHP,
    playerHPs,
    activeBugId:      spawnedBug,
    roundIndex:       1, // 1-based (detail-design.md §3 RaidState: 1始まり)
    turnOrder:        raidTurnOrder,
    currentTurnIndex: 0,
    bossActionsLeft:  Math.ceil(playerCount / 2),
  };

  // Clear the field — move all field card IDs to excludedCards
  const allFieldCardIds = game.field.map(fc => fc.cardId);

  const events: EventLog[] = [
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
  ];
  if (spawnedBug) {
    events.push({
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "bug_activated",
      actorId:   "system",
      payload:   { bugId: spawnedBug, roundIndex: raidState.roundIndex },
    });
  }

  return applyPatch(game, {
    phase:        "raid",
    field:        [],
    excludedCards: [...game.excludedCards, ...allFieldCardIds],
    residualBugs:  spawnedBug ? [...game.residualBugs, spawnedBug] : game.residualBugs,
    raidState,
    appendEvents:  events,
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
 * Remove a raid player whose HP reached 0 from the raid rotation, keeping
 * currentTurnIndex pointing at the same next actor (with wraparound).
 * Shared by boss attacks and HP removal costs (D6).
 */
function eliminateRaidPlayer(
  turnOrder: PlayerId[],
  currentTurnIndex: number,
  target: PlayerId,
): { turnOrder: PlayerId[]; currentTurnIndex: number; removed: boolean } {
  const removedIdx = turnOrder.indexOf(target);
  if (removedIdx === -1) return { turnOrder, currentTurnIndex, removed: false };

  const newOrder = turnOrder.filter(pid => pid !== target);
  let idx = currentTurnIndex;
  if (removedIdx < idx) idx--;
  idx = newOrder.length > 0 ? idx % newOrder.length : 0;
  return { turnOrder: newOrder, currentTurnIndex: idx, removed: true };
}

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
  let bossActionsLeft = rs.bossActionsLeft;
  let roundIndex = rs.roundIndex;
  let activeBugId = rs.activeBugId;

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
    // A player at 0 HP drops out of the raid rotation
    const elim = playerHPs[target] <= 0
      ? eliminateRaidPlayer(turnOrder, currentTurnIndex, target)
      : null;
    if (elim?.removed) {
      turnOrder = elim.turnOrder;
      currentTurnIndex = elim.currentTurnIndex;
      events.push({
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "player_eliminated",
        actorId:   "system",
        payload:   { playerId: target, reason: "raid_hp_zero" },
      });
    }

    bossActionsLeft--;
    if (bossActionsLeft <= 0) {
      // Round complete → next round: players act again, a new bug spawns,
      // and an empty deck is rebuilt by shuffling the field back in (§5.3-5)
      roundIndex++;
      const alivePlayers = turnOrder.filter(pid => pid !== rs.bossPlayerId);
      bossActionsLeft = Math.ceil(alivePlayers.length / 2);
      currentTurnIndex = 0;
      if (deck.length === 0 && field.length > 0) {
        deck = shuffleArray(field.map(fc => fc.cardId), rng);
        field = [];
      }
      const spawned = pickRaidBug(residualBugs, ruleSet, rng);
      if (spawned) {
        residualBugs = [...residualBugs, spawned];
        activeBugId = spawned;
        events.push({
          id:        newEventId(),
          timestamp: Date.now(),
          type:      "bug_activated",
          actorId:   "system",
          payload:   { bugId: spawned, roundIndex },
        });
      }
      events.push({
        id:        newEventId(),
        timestamp: Date.now(),
        type:      "raid_round_started",
        actorId:   "system",
        payload:   { roundIndex, bossActionsLeft },
      });
    }
    // Boss keeps the turn until its actions for the round run out
  } else {
    bossHP -= value;
    events.push({
      id:        newEventId(),
      timestamp: Date.now(),
      type:      "hp_changed",
      actorId,
      payload:   { target: "boss", delta: -value, hp: bossHP },
    });
    currentTurnIndex = nextRaidTurnIndex(currentTurnIndex, turnOrder);
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
      bossActionsLeft,
      roundIndex,
      activeBugId,
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
    case "showdown_submit":
      return applyShowdownSubmit(game, action, ctx);
    case "select_strategy":
      // select_strategy is a session-level action; GameEngine returns game unchanged
      return game;
  }
}
