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
