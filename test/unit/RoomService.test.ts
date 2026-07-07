import { describe, it, expect } from "vitest";
import { RoomService } from "../../src/server/room/RoomService";
import { RoomRepository } from "../../src/server/room/RoomRepository";

function makeService() {
  return new RoomService(new RoomRepository());
}

describe("RoomService.createRoom", () => {
  it("adopts the provided roomId as room.id (must match the joinable/DO id)", () => {
    const svc = makeService();
    const result = svc.createRoom({
      roomId: "ABCD1234",
      hostId: "host-1",
      hostName: "Alice",
      ruleSetId: "basic",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Regression: previously createRoom generated a fresh 6-char id, so the
      // broadcast/displayed id diverged from the URL id and the room was
      // unreachable by the id its own host saw.
      expect(result.value.id).toBe("ABCD1234");
      expect(result.value.hostPlayerId).toBe("host-1");
      expect(result.value.players).toHaveLength(1);
      expect(result.value.players[0]).toMatchObject({
        id: "host-1",
        name: "Alice",
        role: "player",
        connectionStatus: "connected",
      });
    }
  });

  it("lets a second player join by the same id the host created", () => {
    const svc = makeService();
    const created = svc.createRoom({
      roomId: "ROOM0001",
      hostId: "host-1",
      hostName: "Alice",
      ruleSetId: "basic",
    });
    expect(created.ok).toBe(true);

    const joined = svc.joinRoom({
      roomId: "ROOM0001",
      playerId: "guest-2",
      playerName: "Bob",
    });
    expect(joined.ok).toBe(true);
    if (joined.ok) {
      expect(joined.value.id).toBe("ROOM0001");
      expect(joined.value.players.map((p) => p.id)).toEqual(["host-1", "guest-2"]);
    }
  });
});
