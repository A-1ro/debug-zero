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
import { autoActionFor } from "../game/AutoAction";
import type { RuleSet } from "../../shared/types/rules";
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
import basicYaml from "../../../rules/basic.yaml?raw";
import {
  ROOM_NOT_FOUND,
  ROOM_ALREADY_STARTED,
  ROOM_HOST_REQUIRED,
  ROOM_REBIND_UNAUTHORIZED,
  SESSION_STRATEGY_NOT_SELECTED,
  WS_DUPLICATE_MESSAGE,
  WS_AUTH_FAILED,
} from "../../shared/constants";
import { sanitizeRoomFor, maskSessionPlayers } from "./sanitize";
import { verifyRebind } from "./rebindAuth";

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

// ── WebSocket attachment stored via serializeAttachment ───────
// Stored immediately on upgrade (playerId unknown yet).
// Updated to include playerId after client:join_room is processed.
// Used on cold-start to restore ConnectionManager from getWebSockets().
type WsAttachment = { connectionId: string; playerId?: PlayerId };

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
 *   "rebind_tokens" → Record<PlayerId, string> (rejoin auth secrets)
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

    // senderId spoofing guard: except for the initial join, the senderId must
    // match the playerId bound to this connection. Without this any client
    // could act (play cards, leave, ready) as any other player.
    this.router.setAuthorizer((message, connectionId) => {
      if (message.type === "client:join_room") return { ok: true };
      const bound = this.connectionManager.getBoundPlayerId(connectionId);
      if (!bound || bound !== message.senderId) {
        return {
          ok: false,
          errorCode: WS_AUTH_FAILED,
          detail: "senderId does not match the connection's bound player",
        };
      }
      return { ok: true };
    });

    // Restore Hibernatable WebSocket connections after DO restart.
    // CF Workers may evict the DO from memory between messages; acceptWebSocket()
    // keeps WS connections alive but ConnectionManager is reset on each cold start.
    // Iterate getWebSockets() to re-register connections so broadcasts reach all clients.
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | string | null;
      if (!att) continue;
      const connectionId = typeof att === "string" ? att : att.connectionId;
      const playerId    = typeof att === "string" ? undefined : att.playerId;
      if (connectionId) {
        this.connectionManager.add(connectionId, ws);
        if (playerId) this.connectionManager.bind(playerId, connectionId);
      }
    }
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
      // Store connectionId on the WebSocket for retrieval in webSocketMessage.
      // playerId is added later (after client:join_room) for hibernation recovery.
      server.serializeAttachment({ connectionId } as WsAttachment);

      return new Response(null, { status: 101, webSocket: client });
    }

    // Restore room from storage on first request
    await this.ensureRoomLoaded(url);

    return new Response("Not found", { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as WsAttachment | string | null;
    const connectionId = typeof att === "string" ? att : (att?.connectionId ?? "");
    if (!connectionId) { ws.close(4001, "missing attachment"); return; }
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
    const att = ws.deserializeAttachment() as WsAttachment | string | null;
    const connectionId = typeof att === "string" ? att : (att?.connectionId ?? "");
    if (!connectionId) return;
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

    // If the disconnecting player is currently on the clock, don't make everyone
    // wait the full timeout — bring the alarm forward so the auto-action fires soon.
    if (updatedRoom.sessionId) {
      const guard = await this.state.storage.get<{ player: PlayerId; deadline: number }>("turnGuard");
      if (guard && guard.player === playerId) {
        const soon = Date.now() + 3000;
        if (soon < guard.deadline) {
          await this.state.storage.put("turnGuard", { ...guard, deadline: soon });
          await this.state.storage.setAlarm(soon);
        }
      }
    }
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
      // Takeover guard: the rejoining connection must present the rebind
      // token issued at the original join — senderId alone is guessable.
      const tokens = await this.loadRebindTokens();
      const decision = verifyRebind(tokens[message.senderId], payload.rebindToken);
      if (!decision.allow) {
        this.sendErrorToConnection(connectionId, room.id, ROOM_REBIND_UNAUTHORIZED,
          "invalid or missing rebind token for this playerId");
        return;
      }
      const existingWs = this.connectionManager.getWebSocketByPlayerId(message.senderId);
      const newWs = this.connectionManager.getWebSocket(connectionId);
      if (existingWs && newWs) {
        this.connectionManager.reconnect(message.senderId, connectionId, newWs);
      } else {
        this.connectionManager.bind(message.senderId, connectionId);
      }
      this.updateWsAttachment(connectionId, message.senderId);
      if (decision.issueNew) {
        // Player joined before token support — issue one now that the
        // connection is bound (private sends are routed by playerId).
        await this.issueRebindToken(message.senderId, room.id, tokens);
      }
      // Reconnect restores the player's connection status; without this the
      // player stays "disconnected" for everyone else forever.
      const me = room.players.find((p) => p.id === message.senderId);
      if (me && me.connectionStatus !== "connected") {
        const restoredRoom: Room = {
          ...room,
          players: room.players.map((p) =>
            p.id === message.senderId ? { ...p, connectionStatus: "connected" as const } : p
          ),
        };
        await this.saveRoom(restoredRoom);
        await this.broadcastRoomUpdated(restoredRoom);
        await this.sendStateSync(message.senderId, restoredRoom);
        return;
      }
      await this.sendStateSync(message.senderId, room);
      return;
    }

    // Input validation: client-side maxLength is advisory only
    const playerName = typeof payload.playerName === "string" ? payload.playerName.trim() : "";
    if (!playerName || playerName.length > 20) {
      this.sendErrorToConnection(connectionId, room?.id ?? "", "ROOM_INVALID_PLAYER_NAME",
        "playerName must be 1-20 characters");
      return;
    }
    const role = payload.role === "spectator" ? "spectator" : "player";

    const result = room
      ? this.roomService.joinRoom({
          roomId: room.id,
          playerId: message.senderId,
          playerName,
          role,
        })
      : this.roomService.createRoom({
          hostId: message.senderId,
          hostName: playerName,
          ruleSetId: "basic",
        });

    if (!result.ok) {
      // The connection is not bound to a playerId yet, so Broadcaster cannot
      // reach it — send the error straight to the raw socket and close it,
      // otherwise a rejected join (e.g. ROOM_FULL) hangs on "CONNECTING..." forever.
      this.sendErrorToConnection(connectionId, room?.id ?? "", result.errorCode, result.detail);
      return;
    }

    this.connectionManager.bind(message.senderId, connectionId);
    this.updateWsAttachment(connectionId, message.senderId);
    const updatedRoom = result.value;
    await this.saveRoom(updatedRoom);
    await this.issueRebindToken(message.senderId, updatedRoom.id, await this.loadRebindTokens());
    await this.broadcastRoomUpdated(updatedRoom);
  }

  // ── Rebind token management ───────────────────────────────────

  private async loadRebindTokens(): Promise<Record<PlayerId, string>> {
    return (await this.state.storage.get<Record<PlayerId, string>>("rebind_tokens")) ?? {};
  }

  /** Generate, persist, and privately deliver a fresh rebind token. */
  private async issueRebindToken(
    playerId: PlayerId,
    roomId: Room["id"],
    tokens: Record<PlayerId, string>
  ): Promise<void> {
    const token = crypto.randomUUID();
    tokens[playerId] = token;
    await this.state.storage.put("rebind_tokens", tokens);
    this.broadcaster.send(
      {
        id:             crypto.randomUUID() as MessageId,
        type:           "server:rebind_token",
        roomId,
        payload:        { token },
        visibility:     "player",
        targetPlayerId: playerId,
      },
      () => "player",
      [playerId]
    );
  }

  private async deleteRebindToken(playerId: PlayerId): Promise<void> {
    const tokens = await this.loadRebindTokens();
    if (!(playerId in tokens)) return;
    delete tokens[playerId];
    await this.state.storage.put("rebind_tokens", tokens);
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
      await this.state.storage.delete("rebind_tokens");
      this.roomRepo.delete(room.id);
      return;
    }
    await this.deleteRebindToken(message.senderId);
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

    // The strategy must exist in the rule set — otherwise a session could
    // start with an undefined strategy id
    const ruleSet = this.ruleSetRegistry.get(room.ruleSetId);
    if (!ruleSet.strategies.some((s) => s.id === payload.strategyId)) {
      await this.sendError(message.senderId, "RULE_UNKNOWN_STRATEGY",
        `strategy ${String(payload.strategyId)} is not defined in rule set ${room.ruleSetId}`, true);
      return;
    }

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

    // Double-start guard: a re-sent start_game must not create a fresh session
    // (that would discard the running game and reset everyone's wins)
    if (room.status === "in-session") {
      await this.sendError(message.senderId, ROOM_ALREADY_STARTED, undefined, true);
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
      effectResolver: this.effectResolver,
    });

    if (!result.ok) {
      await this.sendError(message.senderId, result.errorCode, result.detail, true);
      return;
    }

    const { session, game } = result.value;
    const updatedRoom: Room = { ...room, status: "in-session", sessionId };
    await this.saveRoom(updatedRoom);

    // session_started: per-player sends so each recipient only sees their own
    // strategy id (others are masked until session end)
    for (const player of updatedRoom.players) {
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:session_started",
        roomId: room.id,
        payload: {
          sessionId,
          players: maskSessionPlayers(session.players, player.id),
          ruleSetId: "basic",
        },
        visibility: "player",
        targetPlayerId: player.id,
      }, updatedRoom);
    }

    await this.broadcastGameStart(updatedRoom, session, game);
  }

  /** Broadcast game_started (counts to all) + individual hand_updated per player. */
  private async broadcastGameStart(room: Room, session: Session, game: Game): Promise<void> {
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
    }, room);

    for (const player of session.players) {
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:hand_updated",
        roomId: room.id,
        gameId: game.id,
        payload: { hand: game.hands[player.playerId] ?? [] },
        visibility: "player",
        targetPlayerId: player.playerId,
      }, room);
    }

    // Start the first turn's timeout clock
    await this.scheduleTurnAlarm(game, this.ruleSetRegistry.get("basic"));
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

    await this.applyAndBroadcast(room, session, game, payload.action, message.senderId, {
      onInvalid: (detail) => this.sendError(message.senderId, "ACTION_INVALID", detail, true),
    });
  }

  /**
   * Apply an action, persist, broadcast the result, and (re)arm the turn-timeout
   * alarm. Shared by client-driven handleAction and the alarm-driven auto-action.
   */
  private async applyAndBroadcast(
    room: Room,
    session: Session,
    game: Game,
    action: ActionPayload["action"],
    actorId: PlayerId,
    opts: { onInvalid?: (detail: string) => Promise<void> } = {},
  ): Promise<void> {
    const ruleSet = this.ruleSetRegistry.get("basic");
    const playerStrategies: Record<PlayerId, string> = {};
    for (const sp of session.players) {
      playerStrategies[sp.playerId] = sp.strategyId;
    }

    const ctx: EngineContext = {
      actorId,
      ruleSet,
      playerStrategies,
      effectResolver: this.effectResolver,
    };

    const priorEventCount = game.events.length;
    let updatedGame: Game;
    try {
      updatedGame = applyAction(game, action, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (opts.onInvalid) await opts.onInvalid(detail);
      return;
    }

    await this.sessionService.saveGame(updatedGame);
    const newEvents = updatedGame.events.slice(priorEventCount);
    const message = { senderId: actorId, payload: { action } } as ClientMessage;

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
        action,
        actorId,
        effectsApplied: [],
        newSetNumber: updatedGame.setNumber,
        deckCount: updatedGame.deck.length,
        fieldCard: action.type === "play_card" ? updatedGame.field.at(-1) : undefined,
        fieldOverride: action.type === "reset_or_raid" ? updatedGame.field : undefined,
        handCounts,
        turnOrder: updatedGame.turnOrder,
        currentTurnIndex: updatedGame.currentTurnIndex,
        events: newEvents,
      },
      visibility: "all",
    }, room);

    // Send updated hands to every player whose hand changed (reset redeals all,
    // Hack/TrickStar mutate other players' hands — not just the actor's).
    // Patches keep unchanged hand arrays by reference, so reference compare works.
    for (const [pid, hand] of Object.entries(updatedGame.hands)) {
      const playerId = pid as PlayerId;
      if (playerId !== message.senderId && game.hands[playerId] === hand) continue;
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:hand_updated",
        roomId: room.id,
        gameId: updatedGame.id,
        payload: { hand },
        visibility: "player",
        targetPlayerId: playerId,
      }, room);
    }

    // Check game end (winnerId may be absent — e.g. boss victory in raid)
    if (updatedGame.status === "finished") {
      await this.state.storage.deleteAlarm();
      await this.state.storage.delete("turnGuard");
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
          reason: action.type === "reset_or_raid" ? "card_zero_played_raid" : "deck_empty",
          raidState: updatedGame.raidState,
        },
        visibility: "all",
      }, room);
    }

    // (Re)arm the turn-timeout alarm for whoever is on the clock now.
    // The 0-card reset/raid choice is deliberately not auto-resolved (it needs
    // human intent), so no alarm is set while that choice is pending.
    if (updatedGame.status === "in-progress") {
      await this.scheduleTurnAlarm(updatedGame, ruleSet);
    }
  }

  // ── Turn timeout (DO alarm) ───────────────────────────────────

  private turnTimeoutMs(game: Game, ruleSet: RuleSet): number {
    const t = ruleSet.timeouts ?? { normal: 45000, showdown: 30000, raid: 30000 };
    return game.phase === "showdown" ? t.showdown : game.phase === "raid" ? t.raid : t.normal;
  }

  /** The player currently on the clock (raid uses raidState's rotation). */
  private currentClockPlayer(game: Game): PlayerId | undefined {
    if (game.phase === "raid" && game.raidState) {
      return game.raidState.turnOrder[game.raidState.currentTurnIndex];
    }
    if (game.phase === "showdown") {
      // showdown has no single turn — the first player who hasn't submitted
      const submitted = new Set(
        game.events.filter((e) => e.type === "showdown_submitted").map((e) => e.actorId),
      );
      return game.turnOrder.find((p) => !submitted.has(p));
    }
    return game.turnOrder[game.currentTurnIndex];
  }

  /** Store a guard token + set the DO alarm at the current turn's deadline. */
  private async scheduleTurnAlarm(game: Game, ruleSet: RuleSet): Promise<void> {
    const player = this.currentClockPlayer(game);
    if (!player) { await this.state.storage.deleteAlarm(); return; }
    const deadline = Date.now() + this.turnTimeoutMs(game, ruleSet);
    // guard lets alarm() detect stale fires (turn already moved on)
    await this.state.storage.put("turnGuard", {
      gameId: game.id,
      player,
      phase: game.phase,
      turnKey: this.turnKey(game),
      deadline,
    });
    await this.state.storage.setAlarm(deadline);
  }

  /** A value that changes whenever the turn advances (for stale-alarm detection). */
  private turnKey(game: Game): string {
    if (game.phase === "raid" && game.raidState) {
      return `raid:${game.raidState.roundIndex}:${game.raidState.currentTurnIndex}`;
    }
    if (game.phase === "showdown") {
      const submitted = game.events.filter((e) => e.type === "showdown_submitted").length;
      return `showdown:${submitted}`;
    }
    return `normal:${game.currentTurnIndex}:${game.field.length}`;
  }

  async alarm(): Promise<void> {
    const guard = await this.state.storage.get<{
      gameId: GameId; player: PlayerId; phase: string; turnKey: string; deadline: number;
    }>("turnGuard");
    if (!guard) return;

    const room = await this.loadRoom();
    if (!room || !room.sessionId) return;
    const session = await this.sessionService.getSession(room.sessionId);
    if (!session || !session.gameIds.length) return;
    const currentGameId = session.gameIds[session.gameIds.length - 1];
    const game = await this.sessionService.getGame(currentGameId);
    if (!game || game.status !== "in-progress" || game.id !== guard.gameId) return;

    // Stale fire: the turn already advanced since this alarm was armed → ignore
    // (a fresh alarm was set by that action).
    if (this.turnKey(game) !== guard.turnKey) return;

    // Alarms can fire early — re-check the real deadline.
    if (Date.now() < guard.deadline) {
      await this.state.storage.setAlarm(guard.deadline);
      return;
    }

    const ruleSet = this.ruleSetRegistry.get("basic");
    const player = this.currentClockPlayer(game);
    if (!player) return;

    const auto = autoActionFor(game, player, ruleSet);
    if (!auto) { await this.state.storage.delete("turnGuard"); return; }

    // Record a turn_timeout marker, then run the auto action through the normal
    // apply+broadcast path (which will re-arm the next turn's alarm).
    await this.applyAndBroadcast(room, session, game, auto, player);
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
      ...(game.winnerIds?.length ? { winnerIds: game.winnerIds } : {}),
    };

    // Record a win for every winner (showdown ties can produce multiple winners)
    const winners = game.winnerIds?.length
      ? game.winnerIds
      : game.winnerId
        ? [game.winnerId]
        : [];
    let updatedSession = session;
    for (const winnerId of winners) {
      const res = await this.sessionService.recordWin({
        sessionId: session.id,
        winnerId,
        ruleSet,
      });
      if (res.ok) updatedSession = res.value;
    }

    // No winner at all = the raid boss defeated every player — the boss takes
    // the whole session (session_win_boss)
    if (winners.length === 0) {
      const ended = await this.sessionService.endSession({
        sessionId: session.id,
        winnerId: game.raidState?.bossPlayerId,
      });
      if (ended.ok) updatedSession = ended.value;
    }

    // game_ended: strategies stay masked while the session continues
    // (session_ended below reveals them once the session is decided)
    for (const player of room.players) {
      await this.broadcast({
        id: crypto.randomUUID() as MessageId,
        type: "server:game_ended",
        roomId: room.id,
        gameId: game.id,
        payload: {
          gameId: game.id,
          winResult,
          sessionPlayers: maskSessionPlayers(updatedSession.players, player.id),
        },
        visibility: "player",
        targetPlayerId: player.id,
      }, room);
    }

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
      return;
    }

    // Session continues — start the next game (best-of-N: first to winsRequired).
    // Without this the session used to stall forever after game 1.
    const next = await this.sessionService.startNextGame({
      sessionId: session.id,
      finishedGame: game,
      ruleSet,
      effectResolver: this.effectResolver,
    });
    if (next.ok) {
      await this.broadcastGameStart(room, next.value.session, next.value.game);
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
    // Always send current room state so reconnecting players see the lobby correctly.
    this.broadcaster.send(
      {
        id:            crypto.randomUUID() as MessageId,
        type:          "server:room_updated",
        roomId:        room.id,
        payload:       { room: sanitizeRoomFor(room, playerId) },
        visibility:    "player",
        targetPlayerId: playerId,
      },
      () => "player",
      [playerId]
    );

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

    // Strategies are revealed only after the session has finished
    const syncSession: Session = session.status === "finished"
      ? session
      : { ...session, players: maskSessionPlayers(session.players, playerId) };

    this.broadcaster.send(
      {
        id: crypto.randomUUID() as MessageId,
        type: "server:state_sync",
        roomId: room.id,
        gameId: game.id,
        payload: { room: sanitizeRoomFor(room, playerId), session: syncSession, game: gameView },
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

  /**
   * Update the WebSocket attachment to include playerId.
   * Called after bind() so the next cold-start can restore both
   * connectionId AND playerId into ConnectionManager.
   */
  private updateWsAttachment(connectionId: string, playerId: PlayerId): void {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WsAttachment | string | null;
      if (!att) continue;
      const cid = typeof att === "string" ? att : att.connectionId;
      if (cid === connectionId) {
        try {
          ws.serializeAttachment({ connectionId, playerId } as WsAttachment);
        } catch {
          // ws may have been closed (e.g. during reconnect); safe to ignore
        }
        break;
      }
    }
  }

  private async broadcastRoomUpdated(room: Room): Promise<void> {
    // Per-player sends: each recipient sees only their own strategy id;
    // everyone else's is masked (strategy ids are secret until session end).
    for (const player of room.players) {
      await this.broadcast(
        {
          id: crypto.randomUUID() as MessageId,
          type: "server:room_updated",
          roomId: room.id,
          payload: { room: sanitizeRoomFor(room, player.id) },
          visibility: "player",
          targetPlayerId: player.id,
        },
        room
      );
    }
  }

  /** Send a fatal error directly to a not-yet-bound connection, then close it. */
  private sendErrorToConnection(
    connectionId: string,
    roomId: string,
    errorCode: string,
    detail: string | undefined
  ): void {
    const ws = this.connectionManager.getWebSocket(connectionId);
    if (!ws) return;
    const message: ServerMessage = {
      id: crypto.randomUUID() as MessageId,
      type: "server:error",
      roomId: roomId as Room["id"],
      payload: { code: errorCode, message: errorCode, detail, recoverable: false },
      visibility: "player",
    };
    try {
      ws.send(JSON.stringify(message));
      ws.close(4001, errorCode);
    } catch {
      // Connection already gone — nothing to do
    }
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
