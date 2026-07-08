import type { GameView, Room, PlayerId } from "../../shared/types/domain";
import s from "./FieldDisplay.module.css";

const OP_SYMBOL: Record<string, string> = {
  add: "+",
  sub: "−",
  mul: "×",
  div: "÷",
};

interface Props {
  game:     GameView | null;
  room:     Room     | null;
  playerId: PlayerId;
}

export function FieldDisplay({ game, room, playerId }: Props) {
  if (!game) return null;

  const currentPlayerId = game.turnOrder[game.currentTurnIndex];
  const currentPlayer   = room?.players.find((p) => p.id === currentPlayerId);
  const currentName     = currentPlayerId === playerId
    ? "YOU"
    : (currentPlayer?.name ?? currentPlayerId.slice(0, 8));

  const phaseClass =
    game.phase === "normal"   ? s.phaseNormal   :
    game.phase === "showdown" ? s.phaseShowdown  :
                                 s.phaseRaid;

  const phaseLabel =
    game.phase === "normal"   ? "NORMAL"   :
    game.phase === "showdown" ? "SHOWDOWN"  :
                                 "RAID";

  return (
    <div className={s.container}>
      {/* Header info */}
      <div className={s.setInfo}>
        <div>
          <div className={s.setLabel}>SET NUMBER</div>
          <div className={s.setNumber}>{game.setNumber}</div>
        </div>
        <div>
          <span className={`${s.phaseBadge} ${phaseClass}`}>{phaseLabel}</span>
        </div>
        <div>
          <div className={s.setLabel}>GAME</div>
          <div style={{ fontFamily: "var(--font-title)", fontSize: 18, color: "var(--text)", lineHeight: 1 }}>
            #{game.gameIndex + 1}
          </div>
        </div>
      </div>

      <div className={s.turnLine}>
        TURN: <span className={s.turnName}>{currentName}</span>
      </div>

      {/* Field cards */}
      <div>
        <div className={s.sectionLabel}>Field</div>
        <div className={s.cardRow}>
          {game.field.length === 0 ? (
            <span className={s.emptyField}>— FIELD EMPTY —</span>
          ) : (
            game.field.map((fc, i) => {
              const isLatest = i === game.field.length - 1;
              const isZero   = fc.rawValue === 0;
              const owner    = room?.players.find((p) => p.id === fc.playerId);
              const ownerName = fc.playerId === playerId
                ? "YOU"
                : (owner?.name ?? fc.playerId.slice(0, 6));
              return (
                <div
                  key={`${fc.cardId}-${i}`}
                  className={[
                    s.fieldCard,
                    isLatest && !isZero ? s.fieldCardLatest : "",
                    isZero ? s.fieldCardZero : "",
                  ].join(" ")}
                >
                  <span className={s.opSymbol}>
                    {OP_SYMBOL[fc.operation] ?? fc.operation}
                  </span>
                  <span className={s.cardValue}>{fc.effectiveValue}</span>
                  <span className={s.cardOwner}>{ownerName}</span>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Raid HP display */}
      {game.phase === "raid" && game.raidState && (
        <div className={s.raidSection}>
          <div className={s.raidTitle}>Raid Status</div>
          <div className={s.raidHpRow}>
            <span className={s.raidHpLabel}>BOSS HP</span>
            <span className={s.raidHpVal}>{game.raidState.bossHP}</span>
          </div>
          {game.turnOrder.map((pid) => {
            const hp    = game.raidState!.playerHPs[pid] ?? 0;
            const pName = room?.players.find((p) => p.id === pid)?.name ?? pid.slice(0, 8);
            return (
              <div key={pid} className={s.raidHpRow}>
                <span className={s.raidHpLabel}>{pid === playerId ? "YOU" : pName}</span>
                <span className={`${s.raidHpVal} ${s.raidHpValPlayer}`}>{hp}</span>
              </div>
            );
          })}
          <div className={s.raidBugId}>
            BUG: {game.raidState.activeBugId} · ROUND {game.raidState.roundIndex}
          </div>
          {game.raidState.diceResults && Object.keys(game.raidState.diceResults).length > 0 && (
            <div className={s.raidDice}>
              🎲{" "}
              {Object.entries(game.raidState.diceResults)
                .sort(([, a], [, b]) => b - a)
                .map(([pid, roll]) => {
                  const name = pid === playerId
                    ? "YOU"
                    : room?.players.find((p) => p.id === pid)?.name ?? pid.slice(0, 8);
                  return `${name} ${roll}`;
                })
                .join(" · ")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
