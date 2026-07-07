import { Hono } from "hono";
import { RoomDurableObject } from "./room/RoomDurableObject";
import type { Env } from "./room/RoomDurableObject";

// Re-export the Durable Object class so Wrangler can bind it
export { RoomDurableObject };

// ============================================================
// Hono app — HTTP entry point
// ============================================================

const app = new Hono<{ Bindings: Env }>();

/**
 * WebSocket upgrade endpoint.
 * Routes to the ROOM Durable Object identified by roomId.
 *
 * GET /room/:roomId/ws
 */
app.get("/room/:roomId/ws", async (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.ROOM.idFromName(roomId);
  const stub = c.env.ROOM.get(id);
  const wsUrl = new URL(c.req.raw.url);
  wsUrl.pathname = "/ws";
  // The DO cannot recover the idFromName() string it was addressed by, so pass
  // the URL roomId explicitly — it is the room's authoritative identity.
  const req = new Request(wsUrl.toString(), c.req.raw);
  req.headers.set("X-Room-Id", roomId);
  return stub.fetch(req);
});

/**
 * Catch-all: forward any /room/:roomId/* requests to the DO.
 */
app.all("/room/:roomId/*", async (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.ROOM.idFromName(roomId);
  const stub = c.env.ROOM.get(id);
  const req = new Request(c.req.raw);
  req.headers.set("X-Room-Id", roomId);
  return stub.fetch(req);
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
