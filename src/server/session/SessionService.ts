import type {
  Session,
  SessionId,
  PlayerId,
  GameId,
  StrategyId,
} from "../../shared/types/domain";
import type { RuleSet } from "../../shared/types/rules";
import { SessionRepository } from "./SessionRepository";
import {
  SESSION_INVALID_STRATEGY,
  SESSION_NOT_IN_PROGRESS,
} from "../../shared/constants";

export type SessionResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode: string; detail?: string };

function ok<T>(value: T): SessionResult<T> {
  return { ok: true, value };
}

function fail<T>(errorCode: string, detail?: string): SessionResult<T> {
  return { ok: false, errorCode, detail };
}

function generateSessionId(): SessionId {
  return `sess-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export class SessionService {
  constructor(private readonly repo: SessionRepository) {}

  createSession(params: {
    roomId: string;
    ruleSet: RuleSet;
    playerIds: PlayerId[];
    playerStrategies: Record<PlayerId, StrategyId>;
  }): SessionResult<Session> {
    const { roomId, ruleSet, playerIds, playerStrategies } = params;

    const validStrategyIds = new Set(ruleSet.strategies.map((s) => s.id));
    for (const [pid, sid] of Object.entries(playerStrategies)) {
      if (!validStrategyIds.has(sid)) {
        return fail(
          SESSION_INVALID_STRATEGY,
          `Invalid strategy "${sid}" for player ${pid}`
        );
      }
    }

    // Check Zero strategy exclusion (only 1 player can have Zero)
    const zeroStrategy = ruleSet.strategies.find(
      (s) =>
        s.exclusionCondition?.type === "selection_count_threshold" &&
        s.exclusionCondition.min === 2
    );
    if (zeroStrategy) {
      const zeroCount = Object.values(playerStrategies).filter(
        (sid) => sid === zeroStrategy.id
      ).length;
      if (zeroCount >= 2) {
        return fail(
          SESSION_INVALID_STRATEGY,
          `Strategy "${zeroStrategy.id}" cannot be selected by more than 1 player`
        );
      }
    }

    const session: Session = {
      id: generateSessionId(),
      roomId,
      ruleSetId: ruleSet.id,
      players: playerIds.map((pid) => ({
        playerId: pid,
        strategyId: playerStrategies[pid] ?? ruleSet.strategies[0]?.id ?? "",
        wins: 0,
      })),
      gameIds: [],
      currentGameIndex: 0,
      status: "in-progress",
    };

    this.repo.save(session);
    return ok(session);
  }

  recordGameResult(params: {
    sessionId: SessionId;
    gameId: GameId;
    winnerId: PlayerId | undefined;
    winsRequired: number;
  }): SessionResult<Session> {
    const { sessionId, gameId, winnerId, winsRequired } = params;

    const session = this.repo.get(sessionId);
    if (!session) {
      return fail(SESSION_NOT_IN_PROGRESS, `Session ${sessionId} not found`);
    }
    if (session.status !== "in-progress") {
      return fail(SESSION_NOT_IN_PROGRESS, "Session is not in progress");
    }

    const updatedPlayers = session.players.map((sp) =>
      sp.playerId === winnerId ? { ...sp, wins: sp.wins + 1 } : sp
    );

    const sessionWinner = updatedPlayers.find(
      (sp) => sp.wins >= winsRequired
    );

    const updated: Session = {
      ...session,
      players: updatedPlayers,
      gameIds: [...session.gameIds, gameId],
      currentGameIndex: session.currentGameIndex + 1,
      status: sessionWinner ? "finished" : "in-progress",
      winnerId: sessionWinner?.playerId,
    };

    this.repo.save(updated);
    return ok(updated);
  }

  getSession(sessionId: SessionId): Session | undefined {
    return this.repo.get(sessionId);
  }
}
