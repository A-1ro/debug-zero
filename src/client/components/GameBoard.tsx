import { useState, useEffect, useCallback, useRef } from "react";
import type {
  GameView, Session, Room, PlayerId, CardId, Action,
} from "../../shared/types/domain";
import type { WsStatus } from "../hooks/useWebSocket";
import type { InterventionOffer, BossBugChoiceOffer } from "../hooks/useGameState";
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
  wsStatus:      WsStatus;
  /** A1: private intervention offer addressed to this player */
  interventionOffer?: InterventionOffer | null;
  /** D2: private raid-bug choice offer addressed to the boss */
  bossBugChoice?: BossBugChoiceOffer | null;
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
  interventionOffer,
  bossBugChoice,
  onAction,
  onResetOrRaid,
}: Props) {
  const [selectedCardId, setSelectedCardId] = useState<CardId | null>(null);
  // Showdown: up to 2 cards
  const [selectedCardIds, setSelectedCardIds] = useState<CardId[]>([]);
  const [resetOrRaidPending, setResetOrRaidPending] = useState(false);
  const [activeTab, setActiveTab] = useState<"field" | "players" | "log">("field");
  // Auto-switch to FIELD tab when it's my turn
  const prevTurnRef = useRef<boolean>(false);

  const isMyTurn = game != null
    && game.turnOrder[game.currentTurnIndex] === playerId;

  const isShowdown = game?.phase === "showdown";
  // Showdown has no turn order — everyone submits once
  const hasSubmitted = isShowdown && game != null
    && game.events.some((e) => e.type === "showdown_submitted" && e.actorId === playerId);

  // Detect 0-value card played by ME to trigger ResetOrRaid UI.
  // Only check field.length changes — not isMyTurn — to avoid re-triggering
  // when the turn rotates to us after someone else played a 0.
  useEffect(() => {
    if (!game || game.field.length === 0) return;
    const lastCard = game.field[game.field.length - 1];
    if (lastCard.rawValue === 0 && lastCard.playerId === playerId) {
      setResetOrRaidPending(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game?.field.length]);

  // Clear selection when turn changes or game phase changes
  useEffect(() => {
    setSelectedCardId(null);
    setSelectedCardIds([]);
  }, [game?.currentTurnIndex, game?.phase]);

  // Showdown: toggle selection, max 2 cards
  const handleShowdownSelect = useCallback((cardId: CardId) => {
    setSelectedCardIds((prev) =>
      prev.includes(cardId)
        ? prev.filter((id) => id !== cardId)
        : prev.length >= 2
          ? prev
          : [...prev, cardId]
    );
  }, []);

  // Auto-switch to FIELD tab when it becomes my turn (mobile/tablet only)
  useEffect(() => {
    if (isMyTurn && !prevTurnRef.current) {
      setActiveTab("field");
    }
    prevTurnRef.current = isMyTurn;
  }, [isMyTurn]);

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

        {/* Tab bar — visible on tablet/mobile only */}
        <div className={s.tabBar}>
          <button
            type="button"
            className={`${s.tabBtn} ${activeTab === "field" ? s.tabBtnActive : ""}`}
            onClick={() => setActiveTab("field")}
          >
            FIELD
            {isMyTurn && <span className={s.tabDot} />}
          </button>
          <button
            type="button"
            className={`${s.tabBtn} ${activeTab === "players" ? s.tabBtnActive : ""}`}
            onClick={() => setActiveTab("players")}
          >
            PLAYERS
          </button>
          <button
            type="button"
            className={`${s.tabBtn} ${activeTab === "log" ? s.tabBtnActive : ""}`}
            onClick={() => setActiveTab("log")}
          >
            LOG
          </button>
        </div>

        {/* Main 3-column (desktop) / tab-content (tablet+mobile) */}
        <div className={s.main}>
          {/* Left — player list */}
          <div className={`${s.tabPanel} ${activeTab === "players" ? s.tabPanelActive : ""}`}>
            <PlayerList
              game={game}
              session={session}
              room={room}
              playerId={playerId}
            />
          </div>

          {/* Center */}
          <div className={`${s.center} ${s.tabPanel} ${activeTab === "field" ? s.tabPanelActive : ""}`}>
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
                  selectedCardIds={isShowdown ? selectedCardIds : undefined}
                  isMyTurn={isShowdown ? !hasSubmitted : isMyTurn}
                  onSelect={isShowdown ? handleShowdownSelect : setSelectedCardId}
                />
                <ActionPanel
                  hand={game.hand}
                  phase={game.phase}
                  isMyTurn={isMyTurn}
                  resetOrRaidPending={resetOrRaidPending}
                  interventionOffer={interventionOffer}
                  bossBugChoice={bossBugChoice}
                  interventionPending={game.interventionPending}
                  selectedCardId={selectedCardId}
                  selectedCardIds={selectedCardIds}
                  hasSubmitted={hasSubmitted}
                  lastFieldRawValue={game.field.at(-1)?.rawValue}
                  room={room}
                  playerId={playerId}
                  raidBossPlayerId={game.raidState?.bossPlayerId}
                  raidTurnOrder={game.raidState?.turnOrder}
                  raidTurnIndex={game.raidState?.currentTurnIndex}
                  onAction={handleAction}
                  onResetOrRaid={handleResetOrRaid}
                />
              </div>
            )}
          </div>

          {/* Right — event log */}
          <div className={`${s.tabPanel} ${activeTab === "log" ? s.tabPanelActive : ""}`}>
            <EventLogPanel
              events={game?.events ?? []}
              room={room}
              playerId={playerId}
            />
          </div>
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
