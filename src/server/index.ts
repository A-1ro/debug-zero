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
  return stub.fetch(c.req.raw);
});

/**
 * Catch-all: forward any /room/:roomId/* requests to the DO.
 */
app.all("/room/:roomId/*", async (c) => {
  const roomId = c.req.param("roomId");
  const id = c.env.ROOM.idFromName(roomId);
  const stub = c.env.ROOM.get(id);
  return stub.fetch(c.req.raw);
});

app.get("/health", (c) => c.json({ ok: true }));

export default app;
