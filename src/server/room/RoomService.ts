import type {
  Room,
  RoomId,
  Player,
  PlayerId,
  RuleSetId,
  SessionId,
  StrategyId,
} from "../../shared/types/domain";
import {
  ROOM_NOT_FOUND,
  ROOM_FULL,
  ROOM_ALREADY_STARTED,
  ROOM_HOST_REQUIRED,
} from "../../shared/constants";
import { RoomRepository } from "./RoomRepository";

// ============================================================
// Result type
// ============================================================

export type RoomResult<T> =
  | { ok: true; value: T }
  | { ok: false; errorCode: string; detail?: string };

function ok<T>(value: T): RoomResult<T> {
  return { ok: true, value };
}

function fail<T>(errorCode: string, detail?: string): RoomResult<T> {
  return { ok: false, errorCode, detail };
}

// ============================================================
// ID generators
// ============================================================

/** Generates a short uppercase room ID (e.g. "ABC123"). */
function generateRoomId(): RoomId {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Generates a UUID v4. */
function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================
// RoomService
// ============================================================

export class RoomService {
  constructor(private readonly repository: RoomRepository) {}

  /**
   * Create a new room with the given host player.
   * The host player is automatically added as a "player" with "connected" status.
   */
  createRoom(params: {
    hostId: PlayerId;
    hostName: string;
    ruleSetId: RuleSetId;
    maxPlayers?: number;
  }): RoomResult<Room> {
    const { hostId, hostName, ruleSetId, maxPlayers = 4 } = params;

    const host: Player = {
      id: hostId,
      name: hostName,
      role: "player",
      connectionStatus: "connected",
    };

    // Ensure unique room ID
    let roomId: RoomId;
    do {
      roomId = generateRoomId();
    } while (this.repository.has(roomId));

    const room: Room = {
      id: roomId,
      hostPlayerId: hostId,
      players: [host],
      maxPlayers,
      status: "waiting",
      ruleSetId,
    };

    this.repository.save(room);
    return ok(room);
  }

  /**
   * Join an existing room.
   * Returns ROOM_NOT_FOUND, ROOM_FULL, or ROOM_ALREADY_STARTED on failure.
   * If the player is already in the room, returns the current room (re-join / reconnect).
   */
  joinRoom(params: {
    roomId: RoomId;
    playerId: PlayerId;
    playerName: string;
    role?: "player" | "spectator";
  }): RoomResult<Room> {
    const { roomId, playerId, playerName, role = "player" } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    // Re-join: player is already in the room
    const existing = room.players.find((p) => p.id === playerId);
    if (existing) {
      const updated: Room = {
        ...room,
        players: room.players.map((p) =>
          p.id === playerId ? { ...p, connectionStatus: "connected" } : p
        ),
      };
      this.repository.save(updated);
      return ok(updated);
    }

    if (room.status !== "waiting") {
      return fail(
        ROOM_ALREADY_STARTED,
        `Room ${roomId} is already in ${room.status} status`
      );
    }

    if (room.players.filter((p) => p.role === "player").length >= room.maxPlayers) {
      return fail(ROOM_FULL, `Room ${roomId} is full (${room.maxPlayers} players)`);
    }

    const newPlayer: Player = {
      id: playerId,
      name: playerName,
      role,
      connectionStatus: "connected",
    };

    const updated: Room = {
      ...room,
      players: [...room.players, newPlayer],
    };

    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Leave a room.
   * - If the leaving player is the host, host is transferred to the next player.
   * - If the room becomes empty, the room is disbanded automatically.
   * Returns ROOM_NOT_FOUND if the room does not exist.
   */
  leaveRoom(params: {
    roomId: RoomId;
    playerId: PlayerId;
  }): RoomResult<Room | null> {
    const { roomId, playerId } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const remainingPlayers = room.players.filter((p) => p.id !== playerId);

    // Empty room — disband
    if (remainingPlayers.length === 0) {
      this.repository.delete(roomId);
      return ok(null);
    }

    // Transfer host if the leaving player was the host
    let newHostId = room.hostPlayerId;
    if (room.hostPlayerId === playerId) {
      newHostId = remainingPlayers[0].id;
    }

    const updated: Room = {
      ...room,
      hostPlayerId: newHostId,
      players: remainingPlayers,
    };

    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Disband a room entirely. Only the host may disband.
   * Returns ROOM_NOT_FOUND or ROOM_HOST_REQUIRED on failure.
   */
  disbandRoom(params: {
    roomId: RoomId;
    requesterId: PlayerId;
  }): RoomResult<void> {
    const { roomId, requesterId } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    if (room.hostPlayerId !== requesterId) {
      return fail(ROOM_HOST_REQUIRED, "Only the host can disband the room");
    }

    this.repository.delete(roomId);
    return ok(undefined);
  }

  /**
   * Update the session ID associated with a room (called when a session starts).
   */
  setSessionId(params: {
    roomId: RoomId;
    sessionId: SessionId;
  }): RoomResult<Room> {
    const { roomId, sessionId } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const updated: Room = { ...room, sessionId, status: "in-session" };
    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Update the room status.
   */
  setStatus(params: {
    roomId: RoomId;
    status: Room["status"];
  }): RoomResult<Room> {
    const { roomId, status } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const updated: Room = { ...room, status };
    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Update a player's connection status within a room.
   */
  setPlayerConnectionStatus(params: {
    roomId: RoomId;
    playerId: PlayerId;
    status: Player["connectionStatus"];
  }): RoomResult<Room> {
    const { roomId, playerId, status } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const updated: Room = {
      ...room,
      players: room.players.map((p) =>
        p.id === playerId ? { ...p, connectionStatus: status } : p
      ),
    };

    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Mark a player as ready.
   * When all non-spectator players are ready, transitions the room to "strategy-selection".
   */
  setReady(params: {
    roomId: RoomId;
    playerId: PlayerId;
  }): RoomResult<Room> {
    const { roomId, playerId } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const updatedPlayers = room.players.map((p) =>
      p.id === playerId ? { ...p, ready: true } : p
    );

    const allReady = updatedPlayers
      .filter((p) => p.role === "player")
      .every((p) => p.ready === true);

    const updated: Room = {
      ...room,
      players: updatedPlayers,
      status: allReady ? "strategy-selection" : room.status,
    };

    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Record a player's selected strategy.
   */
  selectStrategy(params: {
    roomId: RoomId;
    playerId: PlayerId;
    strategyId: StrategyId;
  }): RoomResult<Room> {
    const { roomId, playerId, strategyId } = params;

    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const updated: Room = {
      ...room,
      selectedStrategies: {
        ...room.selectedStrategies,
        [playerId]: strategyId,
      },
    };

    this.repository.save(updated);
    return ok(updated);
  }

  /**
   * Return all player strategies as an array ready for session creation.
   * Returns ROOM_NOT_FOUND if the room doesn't exist.
   * Returns SESSION_STRATEGY_NOT_SELECTED if any player has not selected a strategy.
   */
  getPlayerStrategies(
    roomId: RoomId
  ): RoomResult<Array<{ playerId: PlayerId; strategyId: StrategyId }>> {
    const room = this.repository.get(roomId);
    if (!room) {
      return fail(ROOM_NOT_FOUND, `Room ${roomId} not found`);
    }

    const strategies = room.selectedStrategies ?? {};
    const playerIds = room.players
      .filter((p) => p.role === "player")
      .map((p) => p.id);

    for (const pid of playerIds) {
      if (!strategies[pid]) {
        return fail("SESSION_STRATEGY_NOT_SELECTED", `Player ${pid} has not selected a strategy`);
      }
    }

    const result = playerIds.map((pid) => ({
      playerId: pid,
      strategyId: strategies[pid],
    }));

    return ok(result);
  }

  /** Retrieve a room by ID. */
  getRoom(roomId: RoomId): Room | undefined {
    return this.repository.get(roomId);
  }
}
