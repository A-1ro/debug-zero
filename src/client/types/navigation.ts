/** State passed via react-router-dom navigate() to RoomView */
export interface RoomNavigateState {
  playerName: string;
  role: "player" | "spectator";
}
