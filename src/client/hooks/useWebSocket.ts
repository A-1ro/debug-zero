import { useEffect, useRef, useCallback, useState } from "react";
import type { ClientMessage, ClientMessageType, ClientPayload, ServerMessage } from "../../shared/types/messages";
import type { PlayerId, RoomId } from "../../shared/types/domain";

// ============================================================
// playerId persistence (localStorage)
// ============================================================

const PLAYER_ID_KEY = "debug-zero:playerId";

function getOrCreatePlayerId(): PlayerId {
  const stored = localStorage.getItem(PLAYER_ID_KEY);
  if (stored) return stored;
  const id = crypto.randomUUID();
  localStorage.setItem(PLAYER_ID_KEY, id);
  return id;
}

// Module-level singleton so the same playerId is stable across hook remounts
const PLAYER_ID: PlayerId = getOrCreatePlayerId();

export function getPlayerId(): PlayerId {
  return PLAYER_ID;
}

// ============================================================
// Backoff config
// ============================================================

const BACKOFF_BASE_MS  = 1_000;
const BACKOFF_MAX_MS   = 30_000;

function nextBackoff(attempt: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
}

// ============================================================
// Connection status
// ============================================================

export type WsStatus = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

// ============================================================
// Hook params
// ============================================================

export interface UseWebSocketParams {
  roomId:      RoomId;
  playerName:  string;
  role?:       "player" | "spectator";
  onMessage:   (msg: ServerMessage) => void;
}

// ============================================================
// Hook
// ============================================================

export function useWebSocket(params: UseWebSocketParams) {
  const { roomId, playerName, role = "player", onMessage } = params;

  const [status, setStatus] = useState<WsStatus>("idle");
  const wsRef      = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const activeRef  = useRef(true);   // false when component unmounts
  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stable ref to the latest onMessage callback — avoids stale closure issues
  const onMessageRef = useRef(onMessage);
  useEffect(() => { onMessageRef.current = onMessage; }, [onMessage]);

  const connect = useCallback(() => {
    if (!activeRef.current) return;

    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const url = `${protocol}://${location.host}/room/${roomId}/ws`;

    setStatus(attemptRef.current === 0 ? "connecting" : "reconnecting");

    const ws = new WebSocket(url);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!activeRef.current) { ws.close(); return; }
      attemptRef.current = 0;
      setStatus("connected");

      // Send join_room immediately on connect
      sendRaw(ws, "client:join_room", {
        playerName,
        role,
      }, roomId);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        onMessageRef.current(msg);
      } catch {
        console.warn("[useWebSocket] Failed to parse message:", event.data);
      }
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (!activeRef.current) { setStatus("closed"); return; }

      const delay = nextBackoff(attemptRef.current);
      attemptRef.current += 1;
      setStatus("reconnecting");
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose fires after onerror — no extra handling needed
    };
  }, [roomId, playerName, role]);

  // Connect on mount, cleanup on unmount
  useEffect(() => {
    activeRef.current = true;
    connect();

    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      wsRef.current?.close(1000, "unmount");
    };
  }, [connect]);

  // Send a typed client message
  const send = useCallback(
    (type: ClientMessageType, payload: ClientPayload) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      sendRaw(ws, type, payload, roomId);
    },
    [roomId]
  );

  return { status, send, playerId: PLAYER_ID };
}

// ============================================================
// Helpers
// ============================================================

function sendRaw(
  ws: WebSocket,
  type: ClientMessageType,
  payload: ClientPayload,
  roomId: RoomId
): void {
  const message: ClientMessage = {
    id:       crypto.randomUUID(),
    type,
    roomId,
    senderId: PLAYER_ID,
    payload,
  };
  ws.send(JSON.stringify(message));
}
