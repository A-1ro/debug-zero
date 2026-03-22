import type {
  Room,
  Session,
  Game,
  PlayerId,
  StrategyId,
  Action,
} from "../../shared/types/domain";
import type { RuleSet } from "../../shared/types/rules";
import type { ClientMessage, ServerMessage } from "../../shared/types/messages";
import { RoomRepository } from "../room/RoomRepository";
import { RoomService } from "../room/RoomService";
import { SessionRepository } from "../session/SessionRepository";
import { SessionService } from "../session/SessionService";
import { EffectRegistry } from "../effects/EffectRegistry";
import { EffectResolver } from "../effects/EffectResolver";
import { registerAllHandlers } from "../effects/registerHandlers";
import { RuleSetLoader } from "../rules/RuleSetLoader";
import { applyAction } from "../game/GameEngine";
import { createGame, buildGameView } from "../game/GameInitializer";
// @ts-ignore – Vite ?raw import
import basicYaml from "../../../rules/basic.yaml?raw";

// ── Env type ─────────────────────────────────────────────────
export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

// ── Load rule sets once at module level ──────────────────────
const RULE_SETS: Record<string, RuleSet> = {};
try {
  const rs = RuleSetLoader.loadFromYaml(basicYaml as string);
  RULE_SETS[rs.id] = rs;
} catch {
  // ignore at module load time; will fail cleanly at runtime
}

// ── Helpers ──────────────────────────────────────────────────
function msgId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

interface WSAttachment {
  playerId: PlayerId;
  playerName: string;
}

// ── Durable Object ───────────────────────────────────────────
export class GameRoomDO {
  private room: Room | null = null;
  private session: Session | null = null;
  private game: Game | null = null;
  private playerStrategies: Record<PlayerId, StrategyId> = {};
  private readyPlayers: Set<PlayerId> = new Set();
  private ruleSet: RuleSet | null = null;

  private readonly effectResolver: EffectResolver;
  private readonly roomRepo: RoomRepository;
  private readonly roomService: RoomService;
  private readonly sessionRepo: SessionRepository;
  private readonly sessionService: SessionService;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    const registry = new EffectRegistry();
    registerAllHandlers(registry);
    this.effectResolver = new EffectResolver(registry);

    this.roomRepo      = new RoomRepository();
    this.roomService   = new RoomService(this.roomRepo);
    this.sessionRepo   = new SessionRepository();
    this.sessionService = new SessionService(this.sessionRepo);

    this.state.blockConcurrencyWhile(async () => {
      this.room             = (await this.state.storage.get<Room>("room"))             ?? null;
      this.session          = (await this.state.storage.get<Session>("session"))       ?? null;
      this.game             = (await this.state.storage.get<Game>("game"))             ?? null;
      this.playerStrategies = (await this.state.storage.get<Record<PlayerId, StrategyId>>("playerStrategies")) ?? {};
      const readyArr        = (await this.state.storage.get<PlayerId[]>("readyPlayers")) ?? [];
      this.readyPlayers     = new Set(readyArr);

      if (this.room)    this.roomRepo.save(this.room);
      if (this.session) this.sessionRepo.save(this.session);

      const ruleSetId = this.room?.ruleSetId;
      if (ruleSetId && RULE_SETS[ruleSetId]) {
        this.ruleSet = RULE_SETS[ruleSetId];
      }
    });
  }

  // ── fetch ──────────────────────────────────────────────────
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      return this.handleInit(request);
    }

    if (request.headers.get("Upgrade") === "websocket") {
      return this.handleWebSocketUpgrade(request);
    }

    return new Response("Not found", { status: 404 });
  }

  // ── Room init ──────────────────────────────────────────────
  private async handleInit(request: Request): Promise<Response> {
    const body = await request.json<{
      roomId: string;
      hostId: PlayerId;
      hostName: string;
      ruleSetId: string;
      maxPlayers?: number;
    }>();

    if (this.room) {
      return new Response(JSON.stringify({ error: "Room already exists" }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      });
    }

    const ruleSet = RULE_SETS[body.ruleSetId];
    if (!ruleSet) {
      return new Response(JSON.stringify({ error: "Unknown ruleSetId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    this.ruleSet = ruleSet;

    const result = this.roomService.createRoom({
      hostId:    body.hostId,
      hostName:  body.hostName,
      ruleSetId: body.ruleSetId,
      maxPlayers: body.maxPlayers ?? 4,
    });

    if (!result.ok) {
      return new Response(JSON.stringify({ error: result.errorCode }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    this.room = result.value;
    await this.persist();

    return new Response(JSON.stringify({ ok: true }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  // ── WebSocket upgrade ──────────────────────────────────────
  private handleWebSocketUpgrade(request: Request): Response {
    const url = new URL(request.url);
    const playerId   = url.searchParams.get("playerId");
    const playerName = url.searchParams.get("playerName") ?? "Anonymous";

    if (!playerId) {
      return new Response("Missing playerId", { status: 400 });
    }
    if (!this.room) {
      return new Response("Room not found", { status: 404 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    this.state.acceptWebSocket(server, [playerId]);
    server.serializeAttachment({ playerId, playerName } as WSAttachment);

    // Join room (or reconnect)
    const joinResult = this.roomService.joinRoom({
      roomId:    this.room.id,
      playerId,
      playerName,
    });
    if (joinResult.ok) {
      this.room = joinResult.value;
      this.persist().catch(console.error);
    }

    // Send current state to newly connected player
    if (this.session && this.game) {
      this.sendTo(server, {
        id:         msgId(),
        type:       "server:state_sync",
        roomId:     this.room.id,
        payload: {
          room:    this.room,
          session: this.session,
          game:    buildGameView(this.game, playerId),
        },
        visibility: "player",
        targetPlayerId: playerId,
      });
    } else {
      this.sendTo(server, {
        id:         msgId(),
        type:       "server:room_updated",
        roomId:     this.room.id,
        payload:    this.roomPayload(),
        visibility: "all",
      });
    }

    // Broadcast updated room to everyone else
    this.broadcast(
      {
        id:         msgId(),
        type:       "server:room_updated",
        roomId:     this.room.id,
        payload:    this.roomPayload(),
        visibility: "all",
      },
      playerId,
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── Hibernatable WebSocket handlers ───────────────────────
  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== "string") return;

    const att = ws.deserializeAttachment() as WSAttachment;
    let msg: ClientMessage;
    try {
      msg = JSON.parse(message) as ClientMessage;
    } catch {
      this.sendError(ws, "PARSE_ERROR", "Invalid JSON");
      return;
    }

    try {
      await this.dispatch(ws, att.playerId, msg);
    } catch (err) {
      const code = (err instanceof Error) ? err.message : "INTERNAL_ERROR";
      this.sendError(ws, code, String(err));
    }
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const att = ws.deserializeAttachment() as WSAttachment | null;
    if (!att || !this.room) return;

    const res = this.roomService.setPlayerConnectionStatus({
      roomId:   this.room.id,
      playerId: att.playerId,
      status:   "disconnected",
    });
    if (res.ok) {
      this.room = res.value;
      await this.persist();
      this.broadcastAll({
        id:         msgId(),
        type:       "server:room_updated",
        roomId:     this.room.id,
        payload:    this.roomPayload(),
        visibility: "all",
      });
    }
  }

  async webSocketError(_ws: WebSocket, error: unknown): Promise<void> {
    console.error("WebSocket error:", error);
  }

  // ── Message dispatch ───────────────────────────────────────
  private async dispatch(
    ws: WebSocket,
    playerId: PlayerId,
    msg: ClientMessage,
  ): Promise<void> {
    switch (msg.type) {
      case "client:leave_room":
        await this.handleLeaveRoom(ws, playerId);
        break;
      case "client:ready":
        await this.handleReady(ws, playerId);
        break;
      case "client:select_strategy":
        await this.handleSelectStrategy(
          ws,
          playerId,
          (msg.payload as { strategyId: string }).strategyId,
        );
        break;
      case "client:start_game":
        await this.handleStartGame(ws, playerId);
        break;
      case "client:action":
        await this.handleAction(
          ws,
          playerId,
          (msg.payload as { action: Action }).action,
        );
        break;
      case "client:reset_or_raid":
        await this.handleAction(ws, playerId, {
          type:   "reset_or_raid",
          choice: (msg.payload as { choice: "reset" | "raid" }).choice,
        });
        break;
      default:
        this.sendError(ws, "UNKNOWN_MESSAGE", `Unknown type: ${msg.type}`);
    }
  }

  // ── Handlers ──────────────────────────────────────────────

  private async handleLeaveRoom(ws: WebSocket, playerId: PlayerId): Promise<void> {
    if (!this.room) return;

    const res = this.roomService.leaveRoom({ roomId: this.room.id, playerId });
    if (!res.ok) {
      this.sendError(ws, res.errorCode, res.detail);
      return;
    }

    if (res.value === null) {
      // Room disbanded
      this.room = null;
      await this.persist();
    } else {
      this.room = res.value;
      await this.persist();
      this.broadcastAll({
        id:         msgId(),
        type:       "server:room_updated",
        roomId:     this.room.id,
        payload:    this.roomPayload(),
        visibility: "all",
      });
    }
  }

  private async handleReady(ws: WebSocket, playerId: PlayerId): Promise<void> {
    if (!this.room) return;

    this.readyPlayers.add(playerId);

    const activePlayers = this.room.players.filter((p) => p.role === "player");
    const allReady = activePlayers.every((p) =>
      this.readyPlayers.has(p.id),
    );

    if (allReady && this.room.status === "waiting") {
      const res = this.roomService.setStatus({
        roomId: this.room.id,
        status: "strategy-selection",
      });
      if (res.ok) this.room = res.value;
    }

    await this.persist();
    this.broadcastAll({
      id:         msgId(),
      type:       "server:room_updated",
      roomId:     this.room.id,
      payload:    this.roomPayload(),
      visibility: "all",
    });
  }

  private async handleSelectStrategy(
    ws: WebSocket,
    playerId: PlayerId,
    strategyId: string,
  ): Promise<void> {
    if (!this.room || !this.ruleSet) return;

    const validIds = this.ruleSet.strategies.map((s) => s.id);
    if (!validIds.includes(strategyId)) {
      this.sendError(ws, "SESSION_INVALID_STRATEGY", `Unknown strategy: ${strategyId}`);
      return;
    }

    this.playerStrategies[playerId] = strategyId;
    await this.persist();

    this.broadcastAll({
      id:         msgId(),
      type:       "server:room_updated",
      roomId:     this.room.id,
      payload:    this.roomPayload(),
      visibility: "all",
    });
  }

  private async handleStartGame(ws: WebSocket, playerId: PlayerId): Promise<void> {
    if (!this.room || !this.ruleSet) return;

    if (this.room.hostPlayerId !== playerId) {
      this.sendError(ws, "ROOM_HOST_REQUIRED", "Only the host can start the game");
      return;
    }

    const playerIds = this.room.players
      .filter((p) => p.role === "player")
      .map((p) => p.id);

    // Ensure all players have a strategy
    for (const pid of playerIds) {
      if (!this.playerStrategies[pid]) {
        this.sendError(
          ws,
          "SESSION_STRATEGY_NOT_SELECTED",
          `Player ${pid} has not selected a strategy`,
        );
        return;
      }
    }

    // Create session
    const sessResult = this.sessionService.createSession({
      roomId:          this.room.id,
      ruleSet:         this.ruleSet,
      playerIds,
      playerStrategies: this.playerStrategies,
    });

    if (!sessResult.ok) {
      this.sendError(ws, sessResult.errorCode, sessResult.detail);
      return;
    }
    this.session = sessResult.value;

    // Update room status
    const roomRes = this.roomService.setSessionId({
      roomId:    this.room.id,
      sessionId: this.session.id,
    });
    if (roomRes.ok) this.room = roomRes.value;

    // Create first game
    this.game = createGame({
      sessionId:       this.session.id,
      gameIndex:       1,
      playerIds,
      ruleSet:         this.ruleSet,
      playerStrategies: this.playerStrategies,
      effectResolver:  this.effectResolver,
    });

    await this.persist();

    // Broadcast session_started
    this.broadcastAll({
      id:         msgId(),
      type:       "server:session_started",
      roomId:     this.room.id,
      payload: {
        sessionId: this.session.id,
        players:   this.session.players,
        ruleSetId: this.ruleSet.id,
      },
      visibility: "all",
    });

    // Broadcast game_started (hand is per-player)
    this.broadcastGameStarted();
  }

  private async handleAction(
    ws: WebSocket,
    playerId: PlayerId,
    action: Action,
  ): Promise<void> {
    if (!this.room || !this.game || !this.session || !this.ruleSet) {
      this.sendError(ws, "ACTION_INVALID_PHASE", "No active game");
      return;
    }

    let updatedGame: Game;
    try {
      updatedGame = applyAction(this.game, action, {
        actorId:         playerId,
        ruleSet:         this.ruleSet,
        playerStrategies: this.playerStrategies,
        effectResolver:  this.effectResolver,
      });
    } catch (err) {
      const code = err instanceof Error ? err.message : "INVALID_ACTION";
      this.sendError(ws, code, String(err));
      return;
    }

    this.game = updatedGame;
    await this.persist();

    // Broadcast action result
    this.broadcastAll({
      id:         msgId(),
      type:       "server:action_result",
      roomId:     this.room.id,
      gameId:     this.game.id,
      payload: {
        action,
        actorId:        playerId,
        effectsApplied: [],
        deckCount:      this.game.deck.length,
        events:         this.game.events.slice(-5),
      },
      visibility: "all",
    });

    // Send updated hand to each player
    for (const ws2 of this.state.getWebSockets()) {
      const att2 = ws2.deserializeAttachment() as WSAttachment | null;
      if (!att2) continue;
      const pid2 = att2.playerId;
      this.sendTo(ws2, {
        id:             msgId(),
        type:           "server:hand_updated",
        roomId:         this.room.id,
        gameId:         this.game.id,
        payload:        { hand: this.game.hands[pid2] ?? [] },
        visibility:     "player",
        targetPlayerId: pid2,
      });
    }

    // Check game over
    if (this.game.status === "finished") {
      await this.handleGameOver();
    }
  }

  // ── Game lifecycle ─────────────────────────────────────────

  private broadcastGameStarted(): void {
    if (!this.room || !this.game || !this.ruleSet) return;

    // Send common game info to all, then individual hands
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (!att) continue;
      const pid = att.playerId;

      this.sendTo(ws, {
        id:         msgId(),
        type:       "server:game_started",
        roomId:     this.room.id,
        gameId:     this.game.id,
        payload: {
          gameId:      this.game.id,
          gameIndex:   this.game.gameIndex,
          setNumber:   this.game.setNumber,
          turnOrder:   this.game.turnOrder,
          deckCount:   this.game.deck.length,
          residualBugs: this.game.residualBugs,
          hand:        this.game.hands[pid] ?? [],
          handCounts:  Object.fromEntries(
            Object.entries(this.game.hands).map(([p, c]) => [p, c.length]),
          ),
        },
        visibility:     "player",
        targetPlayerId: pid,
      });
    }
  }

  private async handleGameOver(): Promise<void> {
    if (!this.game || !this.session || !this.ruleSet || !this.room) return;

    // Broadcast game_ended to all
    this.broadcastAll({
      id:         msgId(),
      type:       "server:game_ended",
      roomId:     this.room.id,
      gameId:     this.game.id,
      payload: {
        gameId:         this.game.id,
        winResult:      { type: "set_number_zero", winnerId: this.game.winnerId },
        sessionPlayers: this.session.players,
      },
      visibility: "all",
    });

    // Record in session
    const sessRes = this.sessionService.recordGameResult({
      sessionId:    this.session.id,
      gameId:       this.game.id,
      winnerId:     this.game.winnerId,
      winsRequired: this.ruleSet.winCondition.winsRequired,
    });

    if (!sessRes.ok) return;
    this.session = sessRes.value;
    await this.persist();

    if (this.session.status === "finished") {
      // Session over
      this.broadcastAll({
        id:         msgId(),
        type:       "server:session_ended",
        roomId:     this.room.id,
        payload: {
          sessionId: this.session.id,
          winnerId:  this.session.winnerId ?? "",
          players:   this.session.players,
        },
        visibility: "all",
      });

      // Reset room to waiting
      const res = this.roomService.setStatus({ roomId: this.room.id, status: "waiting" });
      if (res.ok) this.room = res.value;
      this.session = null;
      this.game    = null;
      this.readyPlayers.clear();
      this.playerStrategies = {};
      await this.persist();
    } else {
      // Start next game
      const playerIds = this.room.players
        .filter((p) => p.role === "player")
        .map((p) => p.id);

      this.game = createGame({
        sessionId:       this.session.id,
        gameIndex:       this.session.currentGameIndex + 1,
        playerIds,
        ruleSet:         this.ruleSet,
        playerStrategies: this.playerStrategies,
        effectResolver:  this.effectResolver,
      });
      await this.persist();
      this.broadcastGameStarted();
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private roomPayload() {
    return {
      room:             this.room!,
      readyPlayerIds:   [...this.readyPlayers],
      playerStrategies: this.playerStrategies,
    };
  }

  private sendTo(ws: WebSocket, msg: ServerMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // ignore closed socket
    }
  }

  private sendError(ws: WebSocket, code: string, detail?: string): void {
    try {
      ws.send(
        JSON.stringify({
          id:         msgId(),
          type:       "server:error",
          roomId:     this.room?.id ?? "",
          payload: {
            code,
            message:     code,
            detail,
            recoverable: true,
          },
          visibility: "player",
        }),
      );
    } catch {
      // ignore closed socket
    }
  }

  private broadcast(msg: ServerMessage, excludePlayerId?: PlayerId): void {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as WSAttachment | null;
      if (att?.playerId === excludePlayerId) continue;
      this.sendTo(ws, msg);
    }
  }

  private broadcastAll(msg: ServerMessage): void {
    this.broadcast(msg, undefined);
  }

  private async persist(): Promise<void> {
    const ops: Promise<void>[] = [
      this.state.storage.put("playerStrategies", this.playerStrategies),
      this.state.storage.put("readyPlayers", [...this.readyPlayers]),
    ];
    if (this.room)    ops.push(this.state.storage.put("room",    this.room));
    if (this.session) ops.push(this.state.storage.put("session", this.session));
    if (this.game)    ops.push(this.state.storage.put("game",    this.game));
    if (!this.room)   ops.push(this.state.storage.delete("room").then(() => {}));
    if (!this.session) ops.push(this.state.storage.delete("session").then(() => {}));
    if (!this.game)   ops.push(this.state.storage.delete("game").then(() => {}));
    await Promise.all(ops);
  }
}
