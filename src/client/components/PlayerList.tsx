import type { GameView, Session, Room, PlayerId } from "../../shared/types/domain";
import s from "./PlayerList.module.css";

interface Props {
  game:     GameView | null;
  session:  Session  | null;
  room:     Room     | null;
  playerId: PlayerId;
}

export function PlayerList({ game, session, room, playerId }: Props) {
  if (!game || !session) return null;

  const currentPlayerId = game.turnOrder[game.currentTurnIndex];
  // Max wins to display pips (3 wins to win session, typical)
  const MAX_WINS = 3;

  return (
    <div className={s.panel}>
      <div className={s.sectionLabel}>Players</div>

      {game.turnOrder.map((pid) => {
        const roomPlayer    = room?.players.find((p) => p.id === pid);
        const sessionPlayer = session.players.find((p) => p.playerId === pid);
        const isSelf        = pid === playerId;
        const isActive      = pid === currentPlayerId;
        const isHost        = pid === room?.hostPlayerId;
        const handCount     = game.handCounts[pid] ?? 0;
        const wins          = sessionPlayer?.wins ?? 0;

        return (
          <div
            key={pid}
            className={[
              s.playerCard,
              isActive ? s.playerCardActive : "",
              isSelf   ? s.playerCardSelf   : "",
            ].join(" ")}
          >
            <div className={s.badgeRow}>
              {isSelf   && <span className={`${s.badge} ${s.badgeSelf}`}>YOU</span>}
              {isHost   && <span className={`${s.badge} ${s.badgeHost}`}>HOST</span>}
              {isActive && <span className={`${s.badge} ${s.badgeTurn}`}>TURN</span>}
            </div>
            <div className={[
              s.playerName,
              isSelf   ? s.playerNameSelf   : "",
              isActive ? s.playerNameActive  : "",
            ].join(" ")}>
              {roomPlayer?.name ?? pid.slice(0, 8)}
            </div>
            {sessionPlayer?.strategyId && (
              <div className={s.strategyRow}>
                <span className={s.strategyLabel}>{sessionPlayer.strategyId}</span>
              </div>
            )}
            <div className={s.statsRow}>
              <span>HAND</span>
              <span className={s.statsVal}>{isSelf ? game.hand.length : handCount}</span>
            </div>
            <div className={s.winsRow}>
              {Array.from({ length: MAX_WINS }).map((_, i) => (
                <div key={i} className={i < wins ? s.winPip : s.winPipEmpty} />
              ))}
            </div>
          </div>
        );
      })}

      <div className={s.deckInfo}>
        <span>DECK</span>
        <span className={s.deckCount}>{game.deckCount}</span>
      </div>
    </div>
  );
}
