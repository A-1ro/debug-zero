import { useState, useEffect, useCallback } from "react";
import type {
  GameView, Session, Room, PlayerId, CardId, Action,
} from "../../shared/types/domain";
import { PlayerList }    from "./PlayerList";
import { FieldDisplay }  from "./FieldDisplay";
import { HandDisplay }   from "./HandDisplay";
import { ActionPanel }   from "./ActionPanel";
import { BugDisplay }    from "./BugDisplay";
import { EventLogPanel } from "./EventLogPanel";
import s from "./GameBoard.module.css";

interface Props {
  game:          GameView | null;
  session:       Session  | null;
  room:          Room     | null;
  playerId:      PlayerId;
  role:          "player" | "spectator";
  wsStatus:      "connecting" | "connected" | "reconnecting" | "disconnected";
  onAction:      (action: Action) => void;
  onResetOrRaid: (choice: "reset" | "raid") => void;
}

export function GameBoard({
  game,
  session,
  room,
  playerId,
  role,
  wsStatus,
  onAction,
  onResetOrRaid,
}: Props) {
  const [selectedCardId, setSelectedCardId] = useState<CardId | null>(null);
  const [resetOrRaidPending, setResetOrRaidPending] = useState(false);

  const isMyTurn = game != null
    && game.turnOrder[game.currentTurnIndex] === playerId;

  // Detect 0-value card played to trigger ResetOrRaid UI
  useEffect(() => {
    if (!game || game.field.length === 0) return;
    const lastCard = game.field[game.field.length - 1];
    if (lastCard.rawValue === 0 && isMyTurn) {
      setResetOrRaidPending(true);
    }
  }, [game?.field.length, isMyTurn]);

  // Clear selection when turn changes or game phase changes
  useEffect(() => {
    setSelectedCardId(null);
  }, [game?.currentTurnIndex, game?.phase]);

  const handleAction = useCallback((action: Action) => {
    setSelectedCardId(null);
    onAction(action);
  }, [onAction]);

  const handleResetOrRaid = useCallback((choice: "reset" | "raid") => {
    setResetOrRaidPending(false);
    onResetOrRaid(choice);
  }, [onResetOrRaid]);

  const isConnected = wsStatus === "connected";

  return (
    <>
      {/* Connection overlay */}
      {(wsStatus === "connecting" || wsStatus === "reconnecting") && (
        <div className={s.overlay} role="status" aria-live="polite">
          <div className={s.overlayTitle}>
            {wsStatus === "connecting" ? "CONNECTING..." : "RECONNECTING..."}
          </div>
          <div className={s.overlayHint}>Game session</div>
        </div>
      )}

      <div className={s.page}>
        {/* Header */}
        <header className={s.header}>
          <div className={s.breadcrumb}>
            <span className={s.breadcrumbLogo}>DEBUG ZERO</span>
            <span className={s.breadcrumbSep}>›</span>
            <span className={s.breadcrumbSub}>GAME SESSION</span>
          </div>
          <div className={s.headerMeta}>
            {game && (
              <span>
                GAME #{game.gameIndex + 1}
                {session && ` · SESSION ${session.id.slice(0, 6)}`}
              </span>
            )}
            <div className={s.wsStatus}>
              <div className={`${s.dot} ${!isConnected ? s.dotOffline : ""}`} />
              {wsStatus.toUpperCase()}
            </div>
          </div>
        </header>

        {/* Game ended banner */}
        {game?.status === "finished" && (
          <div className={s.gameEndedBanner}>
            GAME OVER — waiting for next game or session end
          </div>
        )}

        {/* Main 3-column */}
        <div className={s.main}>
          {/* Left — player list */}
          <PlayerList
            game={game}
            session={session}
            room={room}
            playerId={playerId}
          />

          {/* Center */}
          <div className={s.center}>
            <div className={s.centerScroll}>
              {/* Field */}
              <FieldDisplay
                game={game}
                room={room}
                playerId={playerId}
              />

              {/* Bugs */}
              {game && (
                <BugDisplay
                  bugs={game.residualBugs}
                  isMyTurn={isMyTurn}
                  onAction={handleAction}
                />
              )}
            </div>

            {/* Hand + Action — hidden for spectators */}
            {role === "player" && game && (
              <div className={s.handArea}>
                <HandDisplay
                  hand={game.hand}
                  selectedCardId={selectedCardId}
                  isMyTurn={isMyTurn}
                  onSelect={setSelectedCardId}
                />
                <ActionPanel
                  hand={game.hand}
                  phase={game.phase}
                  isMyTurn={isMyTurn}
                  resetOrRaidPending={resetOrRaidPending}
                  selectedCardId={selectedCardId}
                  room={room}
                  playerId={playerId}
                  raidTurnOrder={game.raidState?.turnOrder}
                  raidTurnIndex={game.raidState?.currentTurnIndex}
                  onAction={handleAction}
                  onResetOrRaid={handleResetOrRaid}
                />
              </div>
            )}
          </div>

          {/* Right — event log */}
          <EventLogPanel
            events={game?.events ?? []}
            room={room}
            playerId={playerId}
          />
        </div>

        {/* Footer */}
        <footer className={s.footer}>
          <span className={s.footerText}>
            ROOM: {room?.id ?? "—"} · WebSocket: {wsStatus.toUpperCase()}
            {role === "spectator" && " · SPECTATING"}
          </span>
        </footer>
      </div>
    </>
  );
}
