import { RoomRepository } from "./RoomRepository";
import { RoomService } from "./RoomService";
import { SessionService } from "../session/SessionService";
import type { SessionStorage } from "../session/SessionService";
import { ConnectionManager } from "../ws/ConnectionManager";
import { Broadcaster } from "../ws/Broadcaster";
import { MessageRouter } from "../ws/MessageRouter";
import type { SeenMsgStorage, SeenMsgEntry } from "../ws/MessageRouter";
import { RuleSetRegistry } from "../rules/RuleSetRegistry";
import { RuleSetLoader } from "../rules/RuleSetLoader";
import { EffectRegistry } from "../effects/EffectRegistry";
import { EffectResolver } from "../effects/EffectResolver";
import { registerAllHandlers } from "../effects/registerHandlers";
import { applyAction, applyPatch } from "../game/GameEngine";
import type { EngineContext } from "../game/GameEngine";
import type {
  Room,
  Session,
  Game,
  GameView,
  PlayerId,
  RoomId,
  MessageId,
  GameId,
  SessionId,
} from "../../shared/types/domain";
import type {
  ClientMessage,
  JoinRoomPayload,
  SelectStrategyPayload,
  ActionPayload,
  ResetOrRaidPayload,
  ServerMessage,
} from "../../shared/types/messages";
import basicYaml from "../../../rules/basic.yaml";
import {
  ROOM_NOT_FOUND,
  ROOM_HOST_REQUIRED,
  SESSION_STRATEGY_NOT_SELECTED,
  WS_DUPLICATE_MESSAGE,
} from "../../shared/constants";

// ============================================================
// DO-backed storage implementations
// ============================================================

class DurableObjectSeenMsgStorage implements SeenMsgStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async get(key: "seen_msgs"): Promise<SeenMsgEntry[] | undefined> {
    return this.storage.get<SeenMsgEntry[]>(key);
  }

  async put(key: "seen_msgs", value: SeenMsgEntry[]): Promise<void> {
    await this.storage.put(key, value);
  }
}

class DurableObjectSessionStorage implements SessionStorage {
  constructor(private readonly storage: DurableObjectStorage) {}

  async getSession(sessionId: SessionId): Promise<Session | null> {
    return (await this.storage.get<Session>("session")) ?? null;
  }

  async saveSession(session: Session): Promise<void> {
    await this.storage.put("session", session);
  }

  async getGame(gameId: GameId): Promise<Game | null> {
    return (await this.storage.get<Game>(`game:${gameId}`)) ?? null;
  }

  async saveGame(game: Game): Promise<void> {
    await this.storage.put(`game:${game.id}`, game);
  }
}

// ============================================================
// Env type
// ============================================================

export interface Env {
  ROOM: DurableObjectNamespace;
}

// ============================================================
// RoomDurableObject
// ============================================================

/**
 * RoomDurableObject — one instance per room.
 * Handles WebSocket connections and all game state for a single room.
 *
 * Storage keys (§9.3):
 *   "room"         → Room
 *   "session"      → Session | null
 *   "game:{id}"    → Game
 *   "seen_msgs"    → SeenMsgEntry[]
 */
export class RoomDurableObject implements DurableObject {
  private readonly connectionManager: ConnectionManager;
  private readonly broadcaster: Broadcaster;
  private readonly router: MessageRouter;
  private readonly roomRepo: RoomRepository;
  private readonly roomService: RoomService;
  private readonly sessionService: SessionService;
  private readonly ruleSetRegistry: RuleSetRegistry;
  private readonly effectRegistry: EffectRegistry;
  private readonly effectResolver: EffectResolver;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {
    // Services
    this.connectionManager = new ConnectionManager();
    this.broadcaster = new Broadcaster(this.connectionManager);
    this.router = new MessageRouter(
      new DurableObjectSeenMsgStorage(state.storage)
    );
    this.roomRepo = new RoomRepository();
    this.roomService = new RoomService(this.roomRepo);
    this.sessionService = new SessionService(
      new DurableObjectSessionStorage(state.storage)
    );

    // Rules + effects
    this.ruleSetRegistry = new RuleSetRegistry();
    const ruleSet = RuleSetLoader.loadFromYaml(basicYaml);
    this.ruleSetRegistry.register(ruleSet);

    this.effectRegistry = new EffectRegistry();
    registerAllHandlers(this.effectRegistry);
    this.effectResolver = new EffectResolver(this.effectRegistry);

    // Register message handlers
    this.registerHandlers();
  }

  // ── HTTP / WebSocket upgrade ──────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }

      const { 0: client, 1: server } = new WebSocketPair();
      this.state.acceptWebSocket(server);

      const connectionId = crypto.randomUUID();
      this.connectionManager.add(connectionId, server);
      // Store connectionId on the WebSocket for retrieval in webSocketMessage
      server.serializeAttachment(connectionId);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Restore room from storage on first request
    await this.ensureRoomLoaded(url);

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const connectionId: string = ws.deserializeAttachment();
    const result = await this.router.route(
      typeof message === "string" ? message : new TextDecoder().decode(message),
      connectionId
    );

    if (!result.ok) {
      const playerId = this.connectionManager.findPlayerIdByWebSocket(ws);
      if (playerId && result.errorCode !== WS_DUPLICATE_MESSAGE) {
        await this.sendError(playerId, result.errorCode, result.detail, true);
      }
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const connectionId: string = ws.deserializeAttachment();
    const playerId = this.connectionManager.remove(connectionId);
    if (!playerId) return;

    // Update player status in room
    const room = await this.loadRoom();
    if (!room) return;

    const updatedPlayers = room.players.map((p) =>
      p.id === playerId ? { ...p, connectionStatus: "disconnected" as const } : p
    );
    const updatedRoom: Room = { ...room, players: updatedPlayers };
    await this.saveRoom(updatedRoom);

    await this.broadcastRoomUpdated(updatedRoom);
  }

  // ── Handler registration ──────────────────────────────────────

  private registerHandlers(): void {
    this.router.on("client:join_room", (msg, connId) =>
      this.handleJoinRoom(msg, connId)
    );
    this.router.on("client:leave_room", (msg, connId) =>
      this.handleLeaveRoom(msg, connId)
    );
    this.router.on("client:ready", (msg, connId) =>
      this.handleReady(msg, connId)
    );
    this.router.on("client:select_strategy", (msg, connId) =>
      this.handleSelectStrategy(msg, connId)
    );
    this.router.on("client:start_game", (msg, connId) =>
      this.handleStartGame(msg, connId)
    );
    this.router.on("client:action", (msg, connId) =>
      this.handleAction(msg, connId)
    );
    this.router.on("client:reset_or_raid", (msg, connId) =>
      this.handleResetOrRaid(msg, connId)
    );
    this.router.on("client:chat", (msg, connId) =>
      this.handleChat(msg, connId)
    );
  }

  // ── Message handlers ──────────────────────────────────────────

  private async handleJoinRoom(message: ClientMessage, connectionId: string): Promise<void> {
    const payload = message.payload as JoinRoomPayload;
    const room = await this.loadRoom();

    if (room && room.players.some((p) => p.id === message.senderId)) {
      // Player already in room (initial join or reconnect after DO reboot).
      // Rebind connection using DO storage as source of truth.
      const existingWs = this.connectionManager.getWebSocketByPlayerId(message.senderId);
      const newWs = this.connectionManager.getWebSocket(connectionId);
      if (existingWs && newWs) {
        this.connectionManager.reconnect(message.senderId, connectionId, newWs);
      } else {
        this.connectionManager.bind(message.senderId, connectionId);
      }
      await this.sendStateSync(message.senderId, room);
      return;
    }

    const result = room
      ? this.roomService.joinRoom({
          roomId: room.id,
          playerId: message.senderId,
          playerName: payload.playerName,
          role: payload.role,
        })
      : this.roomService.createRoom({
          hostId: message.senderId,
          hostName: payload.playerName,
          ruleSetId: "basic",
        });

    if (!result.ok) {
      await this.sendError(message.senderId, result.errorCode, result.detail, false);
      return;
    }

    this.connectionManager.bind(message.senderId, connectionId);
    const updatedRoom = result.value;
    await this.saveRoom(updatedRoom);
    await this.broadcastRoomUpdated(updatedRoom);
  }

  private async handleLeaveRoom(message: ClientMessage, _connectionId: string): Promise<void> {
    const room = await this.requireRoom(message.senderId);
    if (!room) return;

    const result = this.roomService.leaveRoom({
      roomId: room.id,
      playerId: message.senderId,
    });

    if (!result.ok) {
      await this.sendError(message.senderId, result.errorCode, result.detail, true);
      return;
    }

    const updatedRoom = result.value;
    if (!updatedRoom) {
      // Room disbanded (last player left) — nothing to broadcast
      await this.state.storage.delete("room");
      this.roomRepo.delete(room.id);
      return;
    }
    await this.saveRoom(updatedRoom);
    await this.broadcastRoomUpdated(updatedRoom);
  }

  private async handleReady(message: ClientMessage, _connectionId: string): Promise<void> {
    const room = await this.requireRoom(message.senderId);
    if (!room) return;

    const result = this.roomService.setReady({
      roomId: room.id,
      playerId: message.senderId,
    });

    if (!result.ok) {
      await this.sendError(message.senderId, result.errorCode, result.detail, true);
      return;
    }

    const updatedRoom = result.value;
    await this.saveRoom(updatedRoom);
    await this.broadcastRoomUpdated(updatedRoom);
  }

  private async handleSelectStrategy(message: ClientMessage, _connectionId: string): Promise<void> {
    const payload = message.payload as SelectStrategyPayload;
    const room = await this.requireRoom(message.senderId);
    if (!room) return;

    const result = this.roomService.selectStrategy({
      roomId: room.id,
      playerId: message.senderId,
      strategyId: payload.strategyId,
    });

    if (!result.ok) {
      await this.sendError(message.senderId, result.errorCode, result.detail, true);
      return;
    }

    const updatedRoom = result.value;
    await this.saveRoom(updatedRoom);
    await this.broadcastRoomUpdated(updatedRoom);
  }

  private async handleStartGame(message: ClientMessage, _connectionId: string): Promise<void> {
    const room = await this.requireRoom(message.senderId);
    if (!room) return;

    if (room.hostPlayerId !== message.senderId) {
      await this.sendError(message.senderId, ROOM_HOST_REQUIRED, undefined, true);
      return;
    }

    const strategies = this.roomService.getPlayerStrategies(room.id);
    if (!strategies.ok) {
      await this.sendError(message.senderId, SESSION_STRATEGY_NOT_SELECTED, undefined, true);
      return;
    }

    const ruleSet = this.ruleSetRegistry.get("basic");
    const sessionId = crypto.randomUUID() as SessionId;

    const result = await this.sessionService.startSession({
      roomId: room.id,
      sessionId,
      players: strategies.value,
      ruleSetId: "basic",
      ruleSet,
    });

    if (!result.ok) {
      await this.sendError(message.senderId, result.errorCode, result.detail, true);
      return;
    }

    const { session, game } = result.value;
    const updatedRoom: Room = { ...room, status: "in-session", sessionId };
    await this.saveRoom(updatedRoom);

    // Broadcast session_started to all
    await this.broadcast({
      id: crypto.randomUUID() as MessageId,
      type: "server:session_started",
      roomId: room.id,
      payload: {
        sessionId,
        players: session.players,
        ruleSetId: "basic",
      },
      visibility: "all",
    }, updatedRoom);

    // Broadcast game_started: hand counts to all, individual hands to each player
    const handCounts: Record<PlayerId, number> = {};
    for (const [pid, hand] of Object.entries(game.hands)) {
      handCounts[pid as PlayerId] = hand.length;
    }

    await this.broadcast({
      id: crypto.randomUUID() as MessageId,
      type: "server:game_started",
      roomId: room.id,
      gameId: game.id,
      payload: {
        gameId: game.id,
        gameIndex: game.gameIndex,
        setNumber: game.setNumber,
        turnOrder: game.turnOrder,
        deckCount: game.deck.length,
        residualBugs: game.residualBugs,
        hand: [],
        handCounts,
      },
      visibility: "all",
    }, updatedRoom);

    // Send individual hands
    for (const player of session.players) {
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:hand_updated",
        roomId: room.id,
        gameId: game.id,
        payload: { hand: game.hands[player.playerId] ?? [] },
        visibility: "player",
        targetPlayerId: player.playerId,
      }, updatedRoom);
    }
  }

  private async handleAction(message: ClientMessage, _connectionId: string): Promise<void> {
    const payload = message.payload as ActionPayload;
    const room = await this.requireRoom(message.senderId);
    if (!room || !room.sessionId) return;

    const session = await this.sessionService.getSession(room.sessionId);
    if (!session || !session.gameIds.length) return;

    const currentGameId = session.gameIds[session.gameIds.length - 1];
    const game = await this.sessionService.getGame(currentGameId);
    if (!game || game.status !== "in-progress") return;

    const ruleSet = this.ruleSetRegistry.get("basic");
    const playerStrategies: Record<PlayerId, string> = {};
    for (const sp of session.players) {
      playerStrategies[sp.playerId] = sp.strategyId;
    }

    const ctx: EngineContext = {
      actorId: message.senderId,
      ruleSet,
      playerStrategies,
      effectResolver: this.effectResolver,
    };

    const priorEventCount = game.events.length;
    let updatedGame: Game;
    try {
      updatedGame = applyAction(game, payload.action, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await this.sendError(message.senderId, "ACTION_INVALID", detail, true);
      return;
    }

    await this.sessionService.saveGame(updatedGame);
    const newEvents = updatedGame.events.slice(priorEventCount);

    // Broadcast action_result
    const handCounts: Record<PlayerId, number> = {};
    for (const [pid, hand] of Object.entries(updatedGame.hands)) {
      handCounts[pid as PlayerId] = hand.length;
    }

    await this.broadcast({
      id: crypto.randomUUID() as MessageId,
      type: "server:action_result",
      roomId: room.id,
      gameId: updatedGame.id,
      payload: {
        action: payload.action,
        actorId: message.senderId,
        effectsApplied: [],
        deckCount: updatedGame.deck.length,
        events: newEvents,
      },
      visibility: "all",
    }, room);

    // Send updated hand to actor
    await this.broadcast({
      id: crypto.randomUUID() as MessageId,
      type: "server:hand_updated",
      roomId: room.id,
      gameId: updatedGame.id,
      payload: { hand: updatedGame.hands[message.senderId] ?? [] },
      visibility: "player",
      targetPlayerId: message.senderId,
    }, room);

    // Check game end
    if (updatedGame.status === "finished" && updatedGame.winnerId) {
      await this.handleGameEnd(room, session, updatedGame, ruleSet);
    }

    // Check phase change
    if (updatedGame.phase !== game.phase) {
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:phase_changed",
        roomId: room.id,
        gameId: updatedGame.id,
        payload: {
          from: game.phase,
          to: updatedGame.phase,
          reason: "deck_empty",
          raidState: updatedGame.raidState,
        },
        visibility: "all",
      }, room);
    }
  }

  private async handleResetOrRaid(message: ClientMessage, _connectionId: string): Promise<void> {
    // Delegate to handleAction with a reset_or_raid action type
    const payload = message.payload as ResetOrRaidPayload;
    const wrappedMessage: ClientMessage = {
      ...message,
      payload: { action: { type: "reset_or_raid", choice: payload.choice } } as ActionPayload,
    };
    await this.handleAction(wrappedMessage, "");
  }

  private async handleChat(message: ClientMessage, _connectionId: string): Promise<void> {
    // Chat is logged but not persisted — just broadcast
    const room = await this.loadRoom();
    if (!room) return;

    // For now: re-broadcast to all (chat spec not in detail-design.md)
  }

  // ── Game end flow ─────────────────────────────────────────────

  private async handleGameEnd(
    room: Room,
    session: Session,
    game: Game,
    ruleSet: ReturnType<typeof this.ruleSetRegistry.get>
  ): Promise<void> {
    let winType: import("../../shared/types/domain").GameWinType;
    if (game.phase === "raid") {
      if (!game.winnerId) {
        winType = "raid_all_players_dead";
      } else {
        // Determine exact vs below zero from raidState boss HP
        const bossHp = game.raidState?.bossHP ?? -1;
        winType = bossHp === 0 ? "raid_boss_hp_exact_zero" : "raid_boss_hp_below_zero";
      }
    } else if (game.phase === "showdown") {
      winType = "showdown_closest";
    } else {
      winType = "set_number_zero";
    }
    const winResult: import("../../shared/types/domain").WinResult = {
      type: winType,
      winnerId: game.winnerId,
    };

    const sessionResult = game.winnerId
      ? await this.sessionService.recordWin({
          sessionId: session.id,
          winnerId: game.winnerId,
          ruleSet,
        })
      : { ok: false as const, errorCode: "NO_WINNER" };

    const updatedSession = sessionResult.ok ? sessionResult.value : session;

    await this.broadcast({
      id: crypto.randomUUID() as MessageId,
      type: "server:game_ended",
      roomId: room.id,
      gameId: game.id,
      payload: {
        gameId: game.id,
        winResult,
        sessionPlayers: updatedSession.players,
      },
      visibility: "all",
    }, room);

    if (updatedSession.status === "finished") {
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:session_ended",
        roomId: room.id,
        payload: {
          sessionId: session.id,
          winnerId: updatedSession.winnerId ?? "",
          players: updatedSession.players,
        },
        visibility: "all",
      }, room);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────

  /** Persist room to both DO storage and in-memory RoomRepository (always call together). */
  private async saveRoom(room: Room): Promise<void> {
    this.roomRepo.save(room);
    await this.state.storage.put("room", room);
  }

  private async loadRoom(): Promise<Room | undefined> {
    const stored = await this.state.storage.get<Room>("room");
    if (stored && !this.roomRepo.has(stored.id)) {
      this.roomRepo.save(stored);
    }
    return stored;
  }

  private async requireRoom(playerId: PlayerId): Promise<Room | undefined> {
    const room = await this.loadRoom();
    if (!room) {
      await this.sendError(playerId, ROOM_NOT_FOUND, undefined, false);
      return undefined;
    }
    return room;
  }

  private async ensureRoomLoaded(_url: URL): Promise<void> {
    await this.loadRoom();
  }

  private async sendStateSync(playerId: PlayerId, room: Room): Promise<void> {
    const session = room.sessionId
      ? await this.state.storage.get<Session>("session")
      : null;

    if (!session || !session.gameIds.length) return;

    const currentGameId = session.gameIds[session.gameIds.length - 1];
    const game = await this.state.storage.get<Game>(`game:${currentGameId}`);
    if (!game) return;

    const gameView: GameView = {
      id: game.id,
      gameIndex: game.gameIndex,
      setNumber: game.setNumber,
      phase: game.phase,
      status: game.status,
      deckCount: game.deck.length,
      field: game.field,
      hand: game.hands[playerId] ?? [],
      handCounts: Object.fromEntries(
        Object.entries(game.hands).map(([pid, h]) => [pid, h.length])
      ) as Record<PlayerId, number>,
      turnOrder: game.turnOrder,
      currentTurnIndex: game.currentTurnIndex,
      resetCount: game.resetCount,
      residualBugs: game.residualBugs,
      raidState: game.raidState,
      events: game.events,
    };

    this.broadcaster.send(
      {
        id: crypto.randomUUID() as MessageId,
        type: "server:state_sync",
        roomId: room.id,
        gameId: game.id,
        payload: { room, session, game: gameView },
        visibility: "player",
        targetPlayerId: playerId,
      },
      () => "player",
      [playerId]
    );
  }

  private async broadcast(message: ServerMessage, room: Room): Promise<void> {
    const allPlayerIds = room.players.map((p) => p.id);
    const roleOf = (pid: PlayerId) =>
      room.players.find((p) => p.id === pid)?.role ?? "player";
    this.broadcaster.send(message, roleOf, allPlayerIds);
  }

  private async broadcastRoomUpdated(room: Room): Promise<void> {
    await this.broadcast(
      {
        id: crypto.randomUUID() as MessageId,
        type: "server:room_updated",
        roomId: room.id,
        payload: { room },
        visibility: "all",
      },
      room
    );
  }

  private async sendError(
    playerId: PlayerId,
    errorCode: string,
    detail: string | undefined,
    recoverable: boolean
  ): Promise<void> {
    const room = await this.loadRoom();
    if (!room) return;
    await this.broadcast(
      {
        id: crypto.randomUUID() as MessageId,
        type: "server:error",
        roomId: room.id,
        payload: { code: errorCode, message: errorCode, detail, recoverable },
        visibility: "player",
        targetPlayerId: playerId,
      },
      room
    );
  }
}
