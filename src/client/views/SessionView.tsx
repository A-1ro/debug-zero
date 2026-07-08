import { useEffect, useCallback, useRef } from "react";
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

  // Capture location.state once on mount so it doesn't trigger the result-navigation
  // effect multiple times if location.state reference changes during the session.
  const initialLocationState = useRef(location.state);

  const { status, send } = useWebSocket({
    roomId,
    playerName,
    role,
    onMessage: (msg) => {
      applyMessage(msg);
    },
  });

  // Navigate to result when session ends — pass session + room so ResultView is self-contained.
  // Use initialLocationState ref (not live location.state) to avoid double-navigation on re-render.
  useEffect(() => {
    if (state.session?.status === "finished" && state.session && state.room) {
      navigate(`/room/${roomId}/result`, {
        replace: true,
        state: { ...initialLocationState.current, session: state.session, room: state.room },
      });
    }
  }, [state.session?.status, state.session, state.room, navigate, roomId]);

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
      interventionOffer={state.interventionOffer}
      onAction={sendAction}
      onResetOrRaid={sendResetOrRaid}
    />
  );
}
