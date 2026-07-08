import { useCallback } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { isResultNavigateState } from "../types/navigation";
import type { SessionPlayer, PlayerId, Room } from "../../shared/types/domain";
import s from "./ResultView.module.css";

// ============================================================
// Helpers
// ============================================================

const MAX_WINS = 3;

function playerName(pid: PlayerId, room: Room): string {
  return room.players.find((p) => p.id === pid)?.name ?? pid.slice(0, 8);
}

function rankClass(rank: number) {
  if (rank === 1) return s.rankFirst;
  if (rank === 2) return s.rankSecond;
  if (rank === 3) return s.rankThird;
  return "";
}

function winCountClass(wins: number, isWinner: boolean) {
  if (isWinner) return s.winCountHigh;
  if (wins >= 2) return s.winCountMid;
  if (wins === 1) return s.winCountLow;
  return s.winCountNone;
}

// ============================================================
// Component
// ============================================================

export function ResultView() {
  const { roomId = "" } = useParams<{ roomId: string }>();
  const navigate         = useNavigate();
  const location         = useLocation();

  const navState = isResultNavigateState(location.state) ? location.state : null;

  // Fallback when accessed directly (no state)
  if (!navState) {
    return (
      <div className={s.fallback}>
        <div className={s.fallbackTitle}>SESSION ENDED</div>
        <button
          type="button"
          className={s.fallbackBtn}
          onClick={() => navigate("/")}
        >
          ↩ RETURN TO TOP
        </button>
      </div>
    );
  }

  const { playerName: myName, role, session, room } = navState;

  // Sort players by wins desc
  const sorted: SessionPlayer[] = [...session.players].sort((a, b) => b.wins - a.wins);

  // A6: multiple players can win the session simultaneously (winnerIds).
  // Fall back to the single winnerId for sessions recorded before winnerIds existed.
  const winnerIds: PlayerId[] = session.winnerIds?.length
    ? session.winnerIds
    : session.winnerId
      ? [session.winnerId]
      : [];
  // W-1: derive names from winnerPlayers to avoid split-brain between lookups
  const winnerPlayers: SessionPlayer[] = winnerIds
    .map((id) => session.players.find((p) => p.playerId === id))
    .filter((p): p is SessionPlayer => p !== undefined);
  const winnerPlayer = winnerPlayers[0] ?? null;
  const winnerName = winnerPlayers.length > 0
    ? winnerPlayers.map((p) => playerName(p.playerId, room)).join(" & ")
    : null;
  const totalGames = session.gameIds.length;

  // W-3: stable callbacks to avoid unnecessary re-renders of button subtrees
  const handleRematch = useCallback(() => {
    navigate(`/room/${roomId}`, { state: { playerName: myName, role } });
  }, [navigate, roomId, myName, role]);

  const handleDisband = useCallback(() => {
    navigate("/");
  }, [navigate]);

  return (
    <>
      {/* Background pulse glow */}
      <div className={s.winnerGlow} aria-hidden="true" />

      <div className={s.page}>
        {/* Header */}
        <header className={s.header}>
          <div className={s.breadcrumb}>
            <span className={s.logo}>DEBUG ZERO</span>
            <span className={s.sep}>›</span>
            <span className={s.crumb}>{roomId}</span>
            <span className={s.sep}>›</span>
            <span className={s.crumbActive}>SESSION RESULT</span>
          </div>
          <div className={s.headerRight}>
            <span style={{ color: "var(--text-muted)" }}>Session Complete</span>
            <span>{totalGames} Game{totalGames !== 1 ? "s" : ""} Played</span>
          </div>
        </header>

        {/* Main */}
        <main className={s.main}>
          <div className={s.sessionEndedLabel}>— Session Ended —</div>

          {/* Winner block */}
          <div className={s.winnerBlock}>
            <div className={`${s.winnerCorner} ${s.wcTL}`} aria-hidden="true" />
            <div className={`${s.winnerCorner} ${s.wcTR}`} aria-hidden="true" />
            <div className={`${s.winnerCorner} ${s.wcBL}`} aria-hidden="true" />
            <div className={`${s.winnerCorner} ${s.wcBR}`} aria-hidden="true" />

            <div className={s.winnerTag}>
              {winnerPlayers.length > 1 ? "▶ Session Winners" : "▶ Session Winner"}
            </div>

            {winnerName ? (
              <>
                <div className={s.winnerName}>{winnerName}</div>
                <div className={s.winnerSubtitle}>
                  {winnerPlayer?.wins ?? 0} wins —{" "}
                  {winnerPlayers.length > 1
                    ? "Simultaneous target reach"
                    : "First to reach target"}
                </div>
                {winnerPlayers.length > 0 && (
                  <div className={s.winnerStrategy}>
                    Strategy Revealed:{" "}
                    <span className={s.strategyRevealed}>
                      {winnerPlayers.map((p) => p.strategyId).join(" / ")}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <div className={s.winnerNameEmpty}>NO WINNER</div>
            )}
          </div>

          {/* Scoreboard */}
          <div className={s.scoreboard}>
            <div className={s.scoreboardGrid}>
              <span>#</span>
              <span>Player</span>
              <span>Wins</span>
              <span className={s.colHideMobile}>Games</span>
              <span className={s.colHideMobile}>Pips</span>
              <span className={s.colHideMobile}></span>
            </div>

            {sorted.map((sp, idx) => {
              const rank      = idx + 1;
              const isWinner  = winnerIds.includes(sp.playerId);
              const name      = playerName(sp.playerId, room);

              return (
                <div
                  key={sp.playerId}
                  className={[s.scoreboardRow, isWinner ? s.scoreboardRowWinner : ""].join(" ")}
                >
                  {/* Rank */}
                  <span className={`${s.rankNum} ${rankClass(rank)}`}>{rank}</span>

                  {/* Player + strategy */}
                  <div className={s.playerInfo}>
                    <span className={`${s.playerInfoName} ${isWinner ? s.playerInfoNameWinner : ""}`}>
                      {name}
                    </span>
                    <span className={s.playerInfoStrategy}>
                      Strategy:{" "}
                      <span className={s.strategyRevealed}>{sp.strategyId}</span>
                    </span>
                  </div>

                  {/* Wins */}
                  <div className={s.winsDisplay}>
                    <span className={`${s.winCount} ${winCountClass(sp.wins, isWinner)}`}>
                      {sp.wins}
                    </span>
                  </div>

                  {/* Games played (individual per-player data not in SessionPlayer, show session total) */}
                  <span className={`${s.statVal} ${s.colHideMobile}`}>{totalGames}</span>

                  {/* Pips */}
                  <div className={`${s.pipRow} ${s.colHideMobile}`}>
                    {Array.from({ length: MAX_WINS }).map((_, i) => {
                      const filled = i < sp.wins;
                      return (
                        <div
                          key={i}
                          className={[
                            s.pip,
                            filled && isWinner ? s.pipFilledCyan :
                            filled             ? s.pipFilled     : "",
                          ].join(" ")}
                        />
                      );
                    })}
                  </div>

                  {/* Badge */}
                  <span className={s.colHideMobile}>
                    {isWinner
                      ? <span className={s.badgeWinner}>▶ WINNER</span>
                      : <span className={s.badgeEmpty}>—</span>
                    }
                  </span>
                </div>
              );
            })}
          </div>

          {/* Summary strip */}
          <div className={s.summaryStrip}>
            <div className={s.summaryItem}>
              <div className={s.summaryLabel}>Total Games</div>
              <div className={`${s.summaryValue} ${s.summaryValueText}`}>{totalGames}</div>
              <div className={s.summarySub}>in this session</div>
            </div>
            <div className={s.summaryItem}>
              <div className={s.summaryLabel}>Winner Wins</div>
              <div className={`${s.summaryValue} ${s.summaryValueCyan}`}>
                {winnerPlayer?.wins ?? "—"}
              </div>
              <div className={s.summarySub}>game wins</div>
            </div>
            <div className={s.summaryItem}>
              <div className={s.summaryLabel}>Rule Set</div>
              <div className={`${s.summaryValue} ${s.summaryValueAmber}`}>
                {room.ruleSetId.toUpperCase()}
              </div>
              <div className={s.summarySub}>v1.0</div>
            </div>
            <div className={s.summaryItem}>
              <div className={s.summaryLabel}>Room</div>
              <div className={`${s.summaryValue} ${s.summaryValueRoom}`}>{roomId}</div>
              <div className={s.summarySub}>{room.players.length} players</div>
            </div>
          </div>

          {/* Action buttons */}
          <div className={s.actionRow}>
            <button type="button" className={`${s.btnAction} ${s.btnRematch}`} onClick={handleRematch}>
              ↺ REMATCH
            </button>
            <button type="button" className={`${s.btnAction} ${s.btnDisband}`} onClick={handleDisband}>
              ✕ DISBAND ROOM
            </button>
          </div>
          <div className={s.actionNote}>
            Rematch returns to room lobby · Disband returns all players to top
          </div>
        </main>

        {/* Footer */}
        <footer className={s.footer}>
          <span className={s.footerText}>
            ROOM: {roomId} · SESSION ENDED · RULE: {room.ruleSetId.toUpperCase()}
            {winnerName && ` · Winner: ${winnerName}`}
          </span>
        </footer>
      </div>
    </>
  );
}
