import type { MessageId, PlayerId, RoomId } from "../../shared/types/domain";
import type { ClientMessage, ClientMessageType } from "../../shared/types/messages";
import { WS_DUPLICATE_MESSAGE } from "../../shared/constants";

// ============================================================
// Storage interface for seen_msgs (backed by DO state.storage)
// ============================================================

export interface SeenMsgStorage {
  get(key: "seen_msgs"): Promise<SeenMsgEntry[] | undefined>;
  put(key: "seen_msgs", value: SeenMsgEntry[]): Promise<void>;
}

export interface SeenMsgEntry {
  id:     MessageId;
  expiry: number; // Unix ms
}

// ============================================================
// Handler registry
// ============================================================

export type MessageHandler = (
  message: ClientMessage,
  connectionId: string
) => Promise<void>;

// ============================================================
// MessageRouter
// ============================================================

const SEEN_MSG_TTL_MS = 60_000;

/**
 * MessageRouter — routes incoming ClientMessages to registered handlers.
 *
 * Responsibilities:
 *  1. Parse raw WebSocket message strings into ClientMessage
 *  2. Deduplicate messages via seen_msgs (TTL 60 seconds, persisted in DO storage)
 *  3. Dispatch to the handler registered for the message type
 *
 * Handler registration:
 *   router.on("client:action", async (msg, connId) => { ... });
 *
 * Invocation (from RoomDurableObject.webSocketMessage):
 *   await router.route(rawText, connectionId);
 */
export class MessageRouter {
  private handlers: Map<ClientMessageType, MessageHandler> = new Map();

  constructor(private readonly storage: SeenMsgStorage) {}

  // ── Handler registration ──────────────────────────────────────

  on(type: ClientMessageType, handler: MessageHandler): void {
    this.handlers.set(type, handler);
  }

  // ── Routing ──────────────────────────────────────────────────

  /**
   * Parse, deduplicate, and dispatch a raw WebSocket message.
   *
   * @returns { ok: false, errorCode } on duplicate or parse error,
   *          { ok: true } after successful dispatch.
   */
  async route(
    rawMessage: string,
    connectionId: string
  ): Promise<{ ok: true } | { ok: false; errorCode: string; detail?: string }> {
    // 1. Parse
    let message: ClientMessage;
    try {
      message = JSON.parse(rawMessage) as ClientMessage;
    } catch {
      return { ok: false, errorCode: "WS_INVALID_MESSAGE", detail: "JSON parse failed" };
    }

    if (!message.id || !message.type) {
      return { ok: false, errorCode: "WS_INVALID_MESSAGE", detail: "Missing id or type" };
    }

    // 2. Deduplicate (clean expired entries, then check)
    const isDuplicate = await this.checkAndRegister(message.id);
    if (isDuplicate) {
      return { ok: false, errorCode: WS_DUPLICATE_MESSAGE };
    }

    // 3. Dispatch
    const handler = this.handlers.get(message.type);
    if (!handler) {
      return { ok: false, errorCode: "WS_UNKNOWN_MESSAGE_TYPE", detail: message.type };
    }

    try {
      await handler(message, connectionId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      return { ok: false, errorCode: "WS_HANDLER_ERROR", detail };
    }
    return { ok: true };
  }

  // ── Deduplication ─────────────────────────────────────────────

  /**
   * Checks if the messageId has been seen within the TTL window.
   * Registers the messageId if new. Cleans expired entries on each call.
   * @returns true if duplicate, false if new
   */
  private async checkAndRegister(messageId: MessageId): Promise<boolean> {
    const now = Date.now();
    const entries: SeenMsgEntry[] = (await this.storage.get("seen_msgs")) ?? [];

    // Remove expired entries
    const active = entries.filter((e) => e.expiry > now);

    // Check for duplicate
    const isDuplicate = active.some((e) => e.id === messageId);
    if (isDuplicate) {
      // Write back cleaned list (no new entry)
      if (active.length !== entries.length) {
        await this.storage.put("seen_msgs", active);
      }
      return true;
    }

    // Register new entry
    active.push({ id: messageId, expiry: now + SEEN_MSG_TTL_MS });
    await this.storage.put("seen_msgs", active);
    return false;
  }
}
