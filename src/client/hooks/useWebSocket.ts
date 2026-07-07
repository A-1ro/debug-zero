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
// Rebind token persistence (localStorage, one per room)
// ============================================================

const REBIND_TOKEN_PREFIX = "debug-zero:rebindToken:";

function getRebindToken(roomId: RoomId): string | undefined {
  return localStorage.getItem(REBIND_TOKEN_PREFIX + roomId) ?? undefined;
}

function saveRebindToken(roomId: RoomId, token: string): void {
  localStorage.setItem(REBIND_TOKEN_PREFIX + roomId, token);
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

  // Stable refs for values that must not re-trigger connect on change
  const onMessageRef   = useRef(onMessage);
  const playerNameRef  = useRef(playerName);
  const roleRef        = useRef(role);
  useEffect(() => { onMessageRef.current  = onMessage;   }, [onMessage]);
  useEffect(() => { playerNameRef.current = playerName;  }, [playerName]);
  useEffect(() => { roleRef.current       = role;        }, [role]);

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

      // Send join_room immediately on connect — read latest values from refs
      sendRaw(ws, "client:join_room", {
        playerName:  playerNameRef.current,
        role:        roleRef.current,
        rebindToken: getRebindToken(roomId),
      }, roomId);
    };

    ws.onmessage = (event: MessageEvent<string>) => {
      try {
        const msg = JSON.parse(event.data) as ServerMessage;
        // Infrastructure message — persist the rejoin secret, don't forward to views
        if (msg.type === "server:rebind_token") {
          saveRebindToken(roomId, msg.payload.token);
          return;
        }
        onMessageRef.current(msg);
      } catch {
        console.warn("[useWebSocket] Failed to parse message:", event.data);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      wsRef.current = null;
      if (!activeRef.current) { setStatus("closed"); return; }

      // Server-initiated terminal closes — do NOT reconnect:
      //  4000 "reconnected": this playerId opened a newer connection (e.g. another tab)
      //  4001 join rejected: ROOM_FULL etc. — retrying would loop forever
      if (event.code === 4000 || event.code === 4001) {
        setStatus("closed");
        return;
      }

      const delay = nextBackoff(attemptRef.current);
      attemptRef.current += 1;
      setStatus("reconnecting");
      timerRef.current = setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // onclose fires after onerror — no extra handling needed
    };
  }, [roomId]); // playerName/role are read via refs — not deps to avoid reconnect on value change

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
