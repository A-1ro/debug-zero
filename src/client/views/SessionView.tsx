import { useEffect, useCallback } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useWebSocket, getPlayerId } from "../hooks/useWebSocket";
import { useGameState } from "../hooks/useGameState";
import { isRoomNavigateState } from "../types/navigation";
import { GameBoard } from "../components/GameBoard";
import type { Action } from "../../shared/types/domain";

export function SessionView() {
  const { roomId = "" } = useParams<{ roomId: string }>();
  const navigate         = useNavigate();
  const location         = useLocation();
  const playerId         = getPlayerId();

  const navState   = isRoomNavigateState(location.state) ? location.state : null;
  const playerName = navState?.playerName ?? "";
  const role       = navState?.role ?? "player";

  const { state, applyMessage } = useGameState();

  const { status, send } = useWebSocket({
    roomId,
    playerName,
    role,
    onMessage: (msg) => {
      applyMessage(msg);
    },
  });

  // Navigate to result when session ends
  useEffect(() => {
    if (state.session?.status === "finished") {
      navigate(`/room/${roomId}/result`, { replace: true, state: location.state });
    }
  }, [state.session?.status, navigate, roomId, location.state]);

  const sendAction = useCallback((action: Action) => {
    send("client:action", { action });
  }, [send]);

  const sendResetOrRaid = useCallback((choice: "reset" | "raid") => {
    send("client:reset_or_raid", { choice });
  }, [send]);

  return (
    <GameBoard
      game={state.game}
      session={state.session}
      room={state.room}
      playerId={playerId}
      role={role}
      wsStatus={status}
      onAction={sendAction}
      onResetOrRaid={sendResetOrRaid}
    />
  );
}
