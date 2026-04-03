import type { PlayerId } from "../../shared/types/domain";

/**
 * Minimal WebSocket interface.
 * Cloudflare Workers and browser WebSocket both satisfy this shape.
 * Using a structural interface avoids environment-specific type imports.
 */
export interface WSLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

/**
 * ConnectionManager — maps connection IDs to WebSocket instances and player IDs.
 *
 * Owned by RoomDurableObject and passed by reference to MessageRouter/Broadcaster.
 * All state is in-memory (Map). No DO storage interaction.
 *
 * Reconnection flow (§9.5):
 *  1. Client reconnects → sends client:join_room with same playerId
 *  2. MessageRouter calls reconnect(playerId, newConnectionId, newWs)
 *  3. ConnectionManager updates the mapping → Broadcaster can resume sending
 */
export class ConnectionManager {
  /** connectionId → WebSocket */
  private connections: Map<string, WSLike> = new Map();
  /** playerId → connectionId */
  private playerConnections: Map<PlayerId, string> = new Map();

  // ── Connection lifecycle ─────────────────────────────────────

  /**
   * Register a new WebSocket connection.
   * Call this immediately after the WebSocket upgrade, before any join_room message.
   */
  add(connectionId: string, ws: WSLike): void {
    this.connections.set(connectionId, ws);
  }

  /**
   * Associate a playerId with an existing connectionId.
   * Call after client:join_room is processed successfully.
   */
  bind(playerId: PlayerId, connectionId: string): void {
    this.playerConnections.set(playerId, connectionId);
  }

  /**
   * Handle reconnection: rebind the playerId to a new connectionId/WebSocket.
   * The old connection entry is cleaned up if it still exists.
   */
  reconnect(playerId: PlayerId, connectionId: string, ws: WSLike): void {
    const oldConnectionId = this.playerConnections.get(playerId);
    if (oldConnectionId) {
      const oldWs = this.connections.get(oldConnectionId);
      // Close the old WebSocket before removing it.
      // CF Workers Hibernatable WebSocket may keep delivering messages to the old instance
      // unless explicitly closed, causing double-receive for the same playerId.
      oldWs?.close(4000, "reconnected");
      this.connections.delete(oldConnectionId);
    }
    this.connections.set(connectionId, ws);
    this.playerConnections.set(playerId, connectionId);
  }

  /**
   * Remove a connection by connectionId.
   * Also removes the playerConnections entry if it points to this connection.
   * Returns the playerId that was associated with this connection, if any.
   */
  remove(connectionId: string): PlayerId | undefined {
    this.connections.delete(connectionId);

    for (const [playerId, connId] of this.playerConnections) {
      if (connId === connectionId) {
        this.playerConnections.delete(playerId);
        return playerId;
      }
    }
    return undefined;
  }

  // ── Lookups ──────────────────────────────────────────────────

  getWebSocket(connectionId: string): WSLike | undefined {
    return this.connections.get(connectionId);
  }

  getConnectionId(playerId: PlayerId): string | undefined {
    return this.playerConnections.get(playerId);
  }

  getWebSocketByPlayerId(playerId: PlayerId): WSLike | undefined {
    const connId = this.playerConnections.get(playerId);
    return connId ? this.connections.get(connId) : undefined;
  }

  findPlayerIdByWebSocket(ws: WSLike): PlayerId | undefined {
    for (const [playerId, connId] of this.playerConnections) {
      if (this.connections.get(connId) === ws) {
        return playerId;
      }
    }
    return undefined;
  }

  isConnected(playerId: PlayerId): boolean {
    const connId = this.playerConnections.get(playerId);
    return connId !== undefined && this.connections.has(connId);
  }

  getAllConnections(): Map<string, WSLike> {
    return this.connections;
  }

  getConnectedPlayerIds(): PlayerId[] {
    return Array.from(this.playerConnections.keys()).filter((pid) =>
      this.isConnected(pid)
    );
  }
}
