import { Hono } from "hono";
import { renderer } from "./renderer";
import { TopPage } from "./pages/TopPage";
import { RoomPage } from "./pages/RoomPage";
import type { Env } from "./server/durable-objects/GameRoomDO";
export { GameRoomDO } from "./server/durable-objects/GameRoomDO";

// ── ID helpers ───────────────────────────────────────────────
function generateRoomId(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function generateUUID(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ── App ──────────────────────────────────────────────────────
const app = new Hono<{ Bindings: Env }>();

app.use(renderer);

// ── Pages ────────────────────────────────────────────────────

app.get("/", (c) => c.render(<TopPage />));

app.get("/room/:roomId", (c) => {
  const roomId = c.req.param("roomId");
  return c.render(<RoomPage roomId={roomId} />);
});

// ── API: create room ─────────────────────────────────────────

app.post("/api/rooms", async (c) => {
  const body = await c.req.json<{
    hostName:   string;
    ruleSetId:  string;
    maxPlayers?: number;
    hostId?:    string;
  }>();

  if (!body.hostName || !body.ruleSetId) {
    return c.json({ error: "hostName and ruleSetId are required" }, 400);
  }

  const roomId  = generateRoomId();
  const playerId = body.hostId ?? generateUUID();

  // Forward room init to the Durable Object
  const doId = c.env.GAME_ROOM.idFromName(roomId);
  const stub = c.env.GAME_ROOM.get(doId);

  const initRes = await stub.fetch(
    new Request("http://internal/init", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        roomId,
        hostId:    playerId,
        hostName:  body.hostName,
        ruleSetId: body.ruleSetId,
        maxPlayers: body.maxPlayers ?? 4,
      }),
    }),
  );

  if (!initRes.ok) {
    const err = await initRes.json<{ error: string }>();
    return c.json({ error: err.error ?? "Failed to create room" }, 500);
  }

  return c.json({ roomId, playerId });
});

// ── WebSocket upgrade ────────────────────────────────────────

app.get("/ws/:roomId", async (c) => {
  const upgrade = c.req.header("Upgrade");
  if (upgrade !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }

  const roomId = c.req.param("roomId");
  const doId   = c.env.GAME_ROOM.idFromName(roomId);
  const stub   = c.env.GAME_ROOM.get(doId);

  // Forward the WebSocket upgrade to the DO
  return stub.fetch(c.req.raw);
});

export default app;
