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
  return (
    isRoomNavigateState(v) &&
    typeof (v as ResultNavigateState).session === "object" && (v as ResultNavigateState).session !== null &&
    typeof (v as ResultNavigateState).room    === "object" && (v as ResultNavigateState).room    !== null
  );
}
