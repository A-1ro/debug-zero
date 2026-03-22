import type {
  Game,
  GameId,
  GameView,
  SessionId,
  PlayerId,
  CardId,
  StrategyId,
} from "../../shared/types/domain";
import type { RuleSet } from "../../shared/types/rules";
import type { EffectResolver } from "../effects/EffectResolver";
import { applyPatch } from "./GameEngine";

function generateGameId(): GameId {
  return `game-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function evaluateSetNumber(formula: string, gameIndex: number): number {
  const match = formula.match(/gameIndex\s*\*\s*(\d+)/);
  if (match) return gameIndex * parseInt(match[1], 10);
  return gameIndex * 10;
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/**
 * Create a new Game for the given session/game index.
 * Deals hands, sets the initial setNumber, and applies on_game_start effects.
 */
export function createGame(params: {
  sessionId: SessionId;
  gameIndex: number;
  playerIds: PlayerId[];
  ruleSet: RuleSet;
  playerStrategies: Record<PlayerId, StrategyId>;
  effectResolver: EffectResolver;
  rng?: () => number;
}): Game {
  const {
    sessionId,
    gameIndex,
    playerIds,
    ruleSet,
    playerStrategies,
    effectResolver,
    rng = Math.random,
  } = params;

  // Build full deck with serial numbers
  const allCards: CardId[] = [];
  const cardSerials: Record<number, number> = {};
  for (const { value, count } of ruleSet.deck.cards) {
    for (let i = 0; i < count; i++) {
      const serial = (cardSerials[value] = (cardSerials[value] ?? 0) + 1);
      allCards.push(`${value}-${String(serial).padStart(3, "0")}`);
    }
  }

  const shuffled = shuffle(allCards, rng);
  const { initialHandSize } = ruleSet.initialConfig;

  const hands: Record<PlayerId, CardId[]> = {};
  let deck = shuffled;
  for (const pid of playerIds) {
    hands[pid] = deck.slice(0, initialHandSize);
    deck = deck.slice(initialHandSize);
  }

  const setNumber = evaluateSetNumber(
    ruleSet.initialConfig.setNumberFormula,
    gameIndex
  );

  const usedStrategyCounts: Record<PlayerId, Record<string, number>> = {};
  for (const pid of playerIds) {
    usedStrategyCounts[pid] = {};
  }

  let game: Game = {
    id: generateGameId(),
    sessionId,
    gameIndex,
    setNumber,
    phase: "normal",
    status: "in-progress",
    deck,
    excludedCards: [],
    field: [],
    hands,
    usedStrategyCounts,
    turnOrder: [...playerIds],
    currentTurnIndex: 0,
    resetCount: 0,
    residualBugs: [],
    events: [],
  };

  // Apply on_game_start effects (e.g., Zero strategy adds a 0-card)
  const startPatch = effectResolver.resolve(
    game,
    "on_game_start",
    { actorId: playerIds[0] ?? "system", ruleSet },
    playerStrategies
  );
  game = applyPatch(game, startPatch);

  return game;
}

/**
 * Build a player-specific GameView (hides other players' hand contents).
 */
export function buildGameView(game: Game, playerId: PlayerId): GameView {
  return {
    id: game.id,
    gameIndex: game.gameIndex,
    setNumber: game.setNumber,
    phase: game.phase,
    status: game.status,
    deckCount: game.deck.length,
    field: game.field,
    hand: game.hands[playerId] ?? [],
    handCounts: Object.fromEntries(
      Object.entries(game.hands).map(([pid, cards]) => [pid, cards.length])
    ),
    turnOrder: game.turnOrder,
    currentTurnIndex: game.currentTurnIndex,
    resetCount: game.resetCount,
    residualBugs: game.residualBugs,
    raidState: game.raidState,
    events: game.events,
  };
}
