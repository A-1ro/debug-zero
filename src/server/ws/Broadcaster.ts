import type { PlayerId, MessageId } from "../../shared/types/domain";
import type { ServerMessage, ErrorPayload } from "../../shared/types/messages";
import type { ConnectionManager } from "./ConnectionManager";

/**
 * Broadcaster — sends ServerMessages to connected clients.
 *
 * Visibility rules (§3.9, §6.1):
 *  - "all"      → send to every connected player and spectator
 *  - "player"   → send only to targetPlayerId
 *  - "spectator"→ send only to connections whose role is spectator
 *
 * Role tracking is delegated to the caller: the caller provides a
 * `roleOf` function so Broadcaster stays free of Room state.
 */
export class Broadcaster {
  constructor(private readonly connections: ConnectionManager) {}

  /**
   * Send a message according to its visibility setting.
   *
   * @param message  The ServerMessage to send (must have visibility set)
   * @param roleOf   Function that returns "player" | "spectator" for a given playerId
   * @param allPlayerIds All playerIds currently in the room (connected or not)
   */
  send(
    message: ServerMessage,
    roleOf: (playerId: PlayerId) => "player" | "spectator",
    allPlayerIds: PlayerId[]
  ): void {
    const payload = JSON.stringify(message);

    switch (message.visibility) {
      case "all": {
        for (const playerId of allPlayerIds) {
          this.sendToPlayer(playerId, payload);
        }
        break;
      }
      case "player": {
        if (message.targetPlayerId) {
          this.sendToPlayer(message.targetPlayerId, payload);
        } else {
          // visibility="player" requires targetPlayerId — log and skip to avoid silent drops
          console.warn(
            `[Broadcaster] visibility="player" message has no targetPlayerId (type=${message.type})`
          );
        }
        break;
      }
      case "spectator": {
        for (const playerId of allPlayerIds) {
          if (roleOf(playerId) === "spectator") {
            this.sendToPlayer(playerId, payload);
          }
        }
        break;
      }
    }
  }

  /**
   * Broadcast an error to a specific player only.
   * Convenience wrapper for visibility="player" error messages.
   */
  sendError(
    targetPlayerId: PlayerId,
    params: { id: MessageId; roomId: string; payload: ErrorPayload }
  ): void {
    const message: ServerMessage = {
      id:            params.id,
      type:          "server:error",
      roomId:        params.roomId,
      payload:       params.payload,
      visibility:    "player",
      targetPlayerId,
    };
    this.sendToPlayer(targetPlayerId, JSON.stringify(message));
  }

  /**
   * Send a raw JSON string to a single player's WebSocket.
   * Silently skips if the player is not connected.
   */
  private sendToPlayer(playerId: PlayerId, payload: string): void {
    const ws = this.connections.getWebSocketByPlayerId(playerId);
    if (ws) {
      try {
        ws.send(payload);
      } catch {
        // Connection may have closed between isConnected check and send — ignore
      }
    }
  }
}
