import type { Session, Room } from "../../shared/types/domain";

/** State passed via react-router-dom navigate() to RoomView / SessionView */
export interface RoomNavigateState {
  playerName: string;
  role: "player" | "spectator";
}

export function isRoomNavigateState(v: unknown): v is RoomNavigateState {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as RoomNavigateState).playerName === "string" &&
    ((v as RoomNavigateState).role === "player" || (v as RoomNavigateState).role === "spectator")
  );
}

/** State passed via react-router-dom navigate() to ResultView */
export interface ResultNavigateState extends RoomNavigateState {
  session: Session;
  room:    Room;
}

export function isResultNavigateState(v: unknown): v is ResultNavigateState {
  if (!isRoomNavigateState(v)) return false;
  const r = v as ResultNavigateState;
  return (
    typeof r.session === "object" && r.session !== null &&
    Array.isArray(r.session.players) &&
    Array.isArray(r.session.gameIds) &&
    typeof r.room === "object" && r.room !== null &&
    typeof r.room.ruleSetId === "string" &&
    Array.isArray(r.room.players)
  );
}
