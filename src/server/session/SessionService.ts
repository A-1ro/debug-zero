import type {
  Session,
  SessionId,
  SessionPlayer,
  SessionStatus,
  Game,
  GameId,
  GameStatus,
  PlayerId,
  StrategyId,
  CardId,
  EventLog,
  EventId,
  RoomId,
} from "../../shared/types/domain";
import type { RuleSet } from "../../shared/types/rules";
import {
  SESSION_INVALID_STRATEGY,
  SESSION_NOT_IN_PROGRESS,
} from "../../shared/constants";

// ============================================================
// Result type
// ============================================================

export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode: string; detail?: string };

function ok<T>(value: T): SessionResult<T> {
  return { ok: true, value };
}

function fail<T>(errorCode: string, detail?: string): SessionResult<T> {
  return { ok: false, errorCode, detail };
}

// ============================================================
// Storage interface
// ============================================================

/**
 * Abstracts session/game persistence.
 * The Durable Objects implementation will satisfy this interface.
 * An in-memory implementation can be used for testing.
 */
export interface SessionStorage {
  getSession(sessionId: SessionId): Promise<Session | null>;
  saveSession(session: Session): Promise<void>;
  getGame(gameId: GameId): Promise<Game | null>;
  saveGame(game: Game): Promise<void>;
}

// ============================================================
// ID generators
// ============================================================

function generateUUID(): string {
  return crypto.randomUUID();
}

function generateEventId(): EventId {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

// ============================================================
// Deck helpers
// ============================================================

/**
 * Build a full deck of CardIds from the RuleSet's DeckConfig.
 * Card IDs follow the format "{value}-{serial}" (e.g. "3-007").
 */
function buildDeck(ruleSet: RuleSet): CardId[] {
  const cards: CardId[] = [];
  for (const { value, count } of ruleSet.deck.cards) {
    for (let i = 0; i < count; i++) {
      const serial = String(i + 1).padStart(3, "0");
      cards.push(`${value}-${serial}`);
    }
  }
  return cards;
}

function shuffleDeck(deck: CardId[], rng: () => number): CardId[] {
  const result = [...deck];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function cardValueFromId(cardId: CardId): number {
  return parseInt(cardId.split("-")[0], 10);
}

// ============================================================
// Turn order determination
// ============================================================

/**
 * Determines initial turn order.
 * Each player "draws" the top card; the player with the highest value goes first.
 * Ties are broken by player order in the input array (earlier index = higher priority).
 * Returns [turnOrder, updatedDeck] — the drawn cards are returned to the deck.
 */
function determineTurnOrder(
  playerIds: PlayerId[],
  deck: CardId[],
  rng: () => number
): { turnOrder: PlayerId[]; deck: CardId[] } {
  if (deck.length < playerIds.length) {
    throw new Error(
      `Deck too small for turn order draw: ${deck.length} cards, ${playerIds.length} players`
    );
  }

  // Each player draws one card from the top
  const drawn: { playerId: PlayerId; cardId: CardId; value: number }[] = [];
  const remainingDeck = [...deck];

  for (const playerId of playerIds) {
    const cardId = remainingDeck.shift()!;
    drawn.push({ playerId, cardId, value: cardValueFromId(cardId) });
  }

  // Sort by value descending; ties keep original order (stable)
  const sorted = [...drawn].sort((a, b) => b.value - a.value);
  const turnOrder = sorted.map((d) => d.playerId);

  // Return drawn cards to the bottom of the deck (they are effectively "used" for ordering only)
  // Per spec: drawn cards are put back and deck is reshuffled before dealing hands
  const drawnCardIds = drawn.map((d) => d.cardId);
  const deckAfterReturn = shuffleDeck([...remainingDeck, ...drawnCardIds], rng);

  return { turnOrder, deck: deckAfterReturn };
}

// ============================================================
// Zero strategy validity
// ============================================================

/**
 * Checks whether the Zero strategy is effectively disabled.
 * Per rules: Zero is invalidated if 2 or more players select it.
 */
function getInvalidatedStrategies(
  sessionPlayers: SessionPlayer[],
  ruleSet: RuleSet
): StrategyId[] {
  const strategyCounts: Record<StrategyId, number> = {};
  for (const sp of sessionPlayers) {
    strategyCounts[sp.strategyId] = (strategyCounts[sp.strategyId] ?? 0) + 1;
  }

  const invalidated: StrategyId[] = [];
  for (const stratDef of ruleSet.strategies) {
    if (stratDef.exclusionCondition?.type === "selection_count_threshold") {
      const count = strategyCounts[stratDef.id] ?? 0;
      if (count >= stratDef.exclusionCondition.min) {
        invalidated.push(stratDef.id);
      }
    }
  }
  return invalidated;
}

// ============================================================
// Game initializer
// ============================================================

/**
 * Creates the initial Game state for a new game within a session.
 * Implements the initialization sequence from detail-design.md §5.2:
 *  §5.2-1. Determine turn order (each player draws 1 card, highest wins, clockwise)
 *  §5.2-2. Shuffle deck & deal initialHandSize cards per player
 *  §5.2-3. Calculate setNumber = gameIndex * 10
 *  §5.2-4. Apply residual bugs from the previous game (passed as parameter)
 *  §5.2-5. Check Zero strategy validity (invalidate if 2+ players selected it)
 *
 * Note: Game is created directly as "in-progress". The "initializing" GameStatus
 * exists in the type for future async initialization flows (e.g. waiting for player ack).
 * Current synchronous initialization does not require the intermediate state.
 */
function initializeGame(params: {
  sessionId: SessionId;
  gameIndex: number;
  sessionPlayers: SessionPlayer[];
  residualBugs: string[];
  ruleSet: RuleSet;
  rng: () => number;
}): Game {
  const { sessionId, gameIndex, sessionPlayers, residualBugs, ruleSet, rng } = params;
  const gameId = generateUUID();
  const now = Date.now();

  const playerIds = sessionPlayers.map((sp) => sp.playerId);
  const initialHandSize = ruleSet.initialConfig.initialHandSize;

  // §5.2-1: Build deck, determine turn order (each player draws top card; highest goes first)
  const rawDeck = buildDeck(ruleSet);
  const shuffledDeck = shuffleDeck(rawDeck, rng);
  const { turnOrder, deck: deckAfterTurnDraw } = determineTurnOrder(playerIds, shuffledDeck, rng);

  // §5.2-2: Deal hands (initialHandSize cards per player)
  const hands: Record<PlayerId, CardId[]> = {};
  let deckCursor = [...deckAfterTurnDraw];
  for (const playerId of playerIds) {
    hands[playerId] = deckCursor.splice(0, initialHandSize);
  }

  // §5.2-3: setNumber = gameIndex * 10
  const setNumber = gameIndex * 10;

  // §5.2-4: Residual bugs carried from previous game (provided as parameter)

  // §5.2-5: Zero strategy validity events
  const invalidatedStrategies = getInvalidatedStrategies(sessionPlayers, ruleSet);
  const events: EventLog[] = [];

  if (invalidatedStrategies.length > 0) {
    events.push({
      id: generateEventId(),
      timestamp: now,
      type: "strategy_invalidated",
      actorId: "system",
      payload: { strategyIds: invalidatedStrategies, reason: "selection_count_threshold" },
    });
  }

  events.push({
    id: generateEventId(),
    timestamp: now,
    type: "game_started",
    actorId: "system",
    payload: { gameId, gameIndex, setNumber, turnOrder, residualBugs },
  });

  const usedStrategyCounts: Record<PlayerId, Record<StrategyId, number>> = {};
  for (const playerId of playerIds) {
    usedStrategyCounts[playerId] = {};
  }

  const game: Game = {
    id: gameId,
    sessionId,
    gameIndex,
    setNumber,
    phase: "normal",
    status: "in-progress" as GameStatus,
    deck: deckCursor,
    excludedCards: [],
    field: [],
    hands,
    usedStrategyCounts,
    turnOrder,
    currentTurnIndex: 0,
    resetCount: 0,
    residualBugs,
    raidState: undefined,
    winnerId: undefined,
    events,
  };

  return game;
}

// ============================================================
// SessionService
// ============================================================

export class SessionService {
  constructor(private readonly storage: SessionStorage) {}

  /**
   * Start a new session.
   * Creates the Session, validates that all players have selected a strategy,
   * initializes the first game, and persists both.
   */
  async startSession(params: {
    roomId: RoomId;
    sessionId: SessionId;
    players: { playerId: PlayerId; strategyId: StrategyId }[];
    ruleSetId: string;
    ruleSet: RuleSet;
    rng?: () => number;
  }): Promise<SessionResult<{ session: Session; game: Game }>> {
    const { roomId, sessionId, players, ruleSetId, ruleSet, rng = Math.random } = params;

    // Validate all strategies exist
    const validStrategyIds = new Set(ruleSet.strategies.map((s) => s.id));
    for (const { strategyId } of players) {
      if (!validStrategyIds.has(strategyId)) {
        return fail(SESSION_INVALID_STRATEGY, `Unknown strategyId: ${strategyId}`);
      }
    }

    const sessionPlayers: SessionPlayer[] = players.map(({ playerId, strategyId }) => ({
      playerId,
      strategyId,
      wins: 0,
    }));

    const session: Session = {
      id: sessionId,
      roomId,
      ruleSetId,
      players: sessionPlayers,
      gameIds: [],
      currentGameIndex: 0,
      status: "in-progress" as SessionStatus,
      winnerId: undefined,
    };

    const game = initializeGame({
      sessionId,
      gameIndex: 1,
      sessionPlayers,
      residualBugs: [],
      ruleSet,
      rng,
    });

    session.gameIds.push(game.id);

    await this.storage.saveSession(session);
    await this.storage.saveGame(game);

    return ok({ session, game });
  }

  /**
   * Start the next game within an existing session.
   * Carries over residual bugs from the finished game.
   */
  async startNextGame(params: {
    sessionId: SessionId;
    finishedGame: Game;
    ruleSet: RuleSet;
    rng?: () => number;
  }): Promise<SessionResult<{ session: Session; game: Game }>> {
    const { sessionId, finishedGame, ruleSet, rng = Math.random } = params;

    const session = await this.storage.getSession(sessionId);
    if (!session) {
      return fail(SESSION_NOT_IN_PROGRESS, `Session not found: ${sessionId}`);
    }
    if (session.status !== "in-progress") {
      return fail(SESSION_NOT_IN_PROGRESS, "Session is already finished");
    }

    // game.gameIndex is 1-based; currentGameIndex is 0-based.
    // After the session starts with game #1, gameIds.length = 1, so next game is #2.
    const nextGameIndex = session.gameIds.length + 1; // 1-based game number
    const nextCurrentIndex = session.currentGameIndex + 1; // 0-based session tracker
    const residualBugs = finishedGame.residualBugs ?? [];

    const game = initializeGame({
      sessionId,
      gameIndex: nextGameIndex,
      sessionPlayers: session.players,
      residualBugs,
      ruleSet,
      rng,
    });

    const updatedSession: Session = {
      ...session,
      gameIds: [...session.gameIds, game.id],
      currentGameIndex: nextCurrentIndex,
    };

    await this.storage.saveSession(updatedSession);
    await this.storage.saveGame(game);

    return ok({ session: updatedSession, game });
  }

  /**
   * Record a win for a player and check if the session is over.
   * Returns the updated session (and sets winnerId if session is finished).
   */
  async recordWin(params: {
    sessionId: SessionId;
    winnerId: PlayerId;
    ruleSet: RuleSet;
  }): Promise<SessionResult<Session>> {
    const { sessionId, winnerId, ruleSet } = params;

    const session = await this.storage.getSession(sessionId);
    if (!session) {
      return fail(SESSION_NOT_IN_PROGRESS, `Session not found: ${sessionId}`);
    }
    if (session.status !== "in-progress") {
      return fail(SESSION_NOT_IN_PROGRESS, "Session is already finished");
    }

    const updatedPlayers = session.players.map((sp) =>
      sp.playerId === winnerId ? { ...sp, wins: sp.wins + 1 } : sp
    );

    const winner = updatedPlayers.find((sp) => sp.playerId === winnerId);
    const sessionFinished =
      winner !== undefined && winner.wins >= ruleSet.winCondition.winsRequired;

    const updatedSession: Session = {
      ...session,
      players: updatedPlayers,
      ...(sessionFinished
        ? { status: "finished" as SessionStatus, winnerId }
        : {}),
    };

    await this.storage.saveSession(updatedSession);

    return ok(updatedSession);
  }

  /**
   * End the session without a specific game winner (e.g. boss wins all players).
   * Marks the session as finished with no individual winnerId.
   * Idempotent: calling on an already-finished session overwrites winnerId but does not error.
   */
  async endSession(params: {
    sessionId: SessionId;
    winnerId?: PlayerId;
  }): Promise<SessionResult<Session>> {
    const { sessionId, winnerId } = params;

    const session = await this.storage.getSession(sessionId);
    if (!session) {
      return fail(SESSION_NOT_IN_PROGRESS, `Session not found: ${sessionId}`);
    }

    const updatedSession: Session = {
      ...session,
      status: "finished" as SessionStatus,
      winnerId,
    };

    await this.storage.saveSession(updatedSession);

    return ok(updatedSession);
  }

  // ── Storage proxy methods (for DO direct access) ─────────────

  async getSession(sessionId: SessionId): Promise<Session | null> {
    return this.storage.getSession(sessionId);
  }

  async getGame(gameId: GameId): Promise<Game | null> {
    return this.storage.getGame(gameId);
  }

  async saveGame(game: Game): Promise<void> {
    return this.storage.saveGame(game);
  }

  /**
   * Returns current standings sorted by wins descending.
   */
  async getStandings(sessionId: SessionId): Promise<SessionResult<SessionPlayer[]>> {
    const session = await this.storage.getSession(sessionId);
    if (!session) {
      return fail(SESSION_NOT_IN_PROGRESS, `Session not found: ${sessionId}`);
    }

    const sorted = [...session.players].sort((a, b) => b.wins - a.wins);
    return ok(sorted);
  }
}

// ============================================================
// In-memory storage (for testing and local dev)
// ============================================================

export class InMemorySessionStorage implements SessionStorage {
  private sessions: Map<SessionId, Session> = new Map();
  private games: Map<GameId, Game> = new Map();

  async getSession(sessionId: SessionId): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async saveSession(session: Session): Promise<void> {
    this.sessions.set(session.id, session);
  }

  async getGame(gameId: GameId): Promise<Game | null> {
    return this.games.get(gameId) ?? null;
  }

  async saveGame(game: Game): Promise<void> {
    this.games.set(game.id, game);
  }
}
