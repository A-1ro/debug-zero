import type { Room, RoomId } from "../../shared/types/domain";

/**
 * RoomRepository — in-memory storage for Room state.
 * Provides simple CRUD operations. No side effects.
 */
export class RoomRepository {
  private readonly rooms: Map<RoomId, Room> = new Map();

  get(id: RoomId): Room | undefined {
    return this.rooms.get(id);
  }

  getAll(): Room[] {
    return Array.from(this.rooms.values());
  }

  save(room: Room): void {
    this.rooms.set(room.id, room);
  }

  delete(id: RoomId): void {
    this.rooms.delete(id);
  }

  has(id: RoomId): boolean {
    return this.rooms.has(id);
  }
}
