import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useLocation } from "react-router-dom";
import { useWebSocket } from "../hooks/useWebSocket";
import { useGameState } from "../hooks/useGameState";
import { getPlayerId } from "../hooks/useWebSocket";
import type { RoomNavigateState } from "../types/navigation";
import type { Room, StrategyId } from "../../shared/types/domain";
import s from "./RoomView.module.css";

// ============================================================
// Strategy definitions (basic ruleset, hardcoded)
// ============================================================

interface StrategyDef {
  id: StrategyId;
  effect: string;
  type: string;
}

const STRATEGIES: StrategyDef[] = [
  { id: "Aggro",       effect: "自分のカード効果値を×2に変換する",           type: "OFFENSIVE" },
  { id: "Control-Add", effect: "他者の加算を減算に変換する (1回/ゲーム)",    type: "CONTROL"   },
  { id: "Control-Sub", effect: "他者の減算を加算に変換する (1回/ゲーム)",    type: "CONTROL"   },
  { id: "Control-Div", effect: "他者の除算を乗算に変換する (1回/ゲーム)",    type: "CONTROL"   },
  { id: "Control-Mul", effect: "他者の乗算を除算に変換する (1回/ゲーム)",    type: "CONTROL"   },
  { id: "Hack",        effect: "場の最後のカードを自分のものにする",          type: "STEAL"     },
  { id: "TrickStar",   effect: "場からカード1枚を除外する",                  type: "REMOVAL"   },
  { id: "Zero",        effect: "手札に0のカードを1枚追加 (3人以上選択で無効)", type: "UTILITY"  },
];

// ============================================================
// Type guard for navigate state
// ============================================================

function isRoomNavigateState(v: unknown): v is RoomNavigateState {
  return (
    typeof v === "object" && v !== null &&
    typeof (v as RoomNavigateState).playerName === "string" &&
    ((v as RoomNavigateState).role === "player" || (v as RoomNavigateState).role === "spectator")
  );
}

// ============================================================
// Helpers
// ============================================================

function nowHHMMSS(): string {
  return new Date().toTimeString().slice(0, 8);
}

function allStrategiesChosen(room: Room): boolean {
  const playerMembers = room.players.filter((p) => p.role === "player");
  if (playerMembers.length === 0) return false;
  return playerMembers.every((p) => room.selectedStrategies?.[p.id] != null);
}

// ============================================================
// Component
// ============================================================

export function RoomView() {
  const { roomId = "" } = useParams<{ roomId: string }>();
  const navigate        = useNavigate();
  const location        = useLocation();
  const playerId        = getPlayerId();

  // Type-safe extraction of navigate state
  const navState   = isRoomNavigateState(location.state) ? location.state : null;
  const playerName = navState?.playerName ?? "";
  const role       = navState?.role ?? "player";

  const { state, applyMessage } = useGameState();

  // Stable ref for room — avoids stale closure in onMessage callback (C-1)
  const roomRef = useRef<Room | null>(null);
  useEffect(() => { roomRef.current = state.room; }, [state.room]);

  const [log, setLog]                         = useState<string[]>([]);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyId | null>(null);
  const logBodyRef                              = useRef<HTMLDivElement>(null);

  const { status, send } = useWebSocket({
    roomId,
    playerName,
    role,
    onMessage: (msg) => {
      applyMessage(msg);

      const t = nowHHMMSS();
      switch (msg.type) {
        case "server:room_updated": {
          // Use roomRef.current (not state.room) to avoid stale closure
          if (!roomRef.current) {
            setLog((l) => [...l, `${t} Room ${msg.payload.room.id} ready — waiting for players`]);
          }
          break;
        }
        case "server:error":
          setLog((l) => [...l, `${t} ERROR: ${msg.payload.message}`]);
          break;
        default:
          break;
      }
    },
  });

  // Auto-scroll log
  useEffect(() => {
    const el = logBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  // Navigate to game when game starts
  useEffect(() => {
    if (state.game) {
      navigate(`/room/${roomId}/game`, { replace: true });
    }
  }, [state.game, navigate, roomId]);

  const room    = state.room;
  const players = room?.players ?? [];

  // C-2: use hostPlayerId from Room type (not players[0])
  const isHost  = room?.hostPlayerId === playerId;

  const playerMembers = players.filter((p) => p.role === "player");
  const readyCount    = playerMembers.filter((p) => p.ready).length;
  const playerCount   = playerMembers.length;

  // W-1: derive isReady from server state, not local state
  const selfPlayer    = playerMembers.find((p) => p.id === playerId);
  const isReady       = selfPlayer?.ready ?? false;

  // W-2: guard against empty player array (every([]) is true)
  const allStrategiesSelected = room != null && allStrategiesChosen(room);

  function handleReady() {
    if (isReady) return;
    send("client:ready", {});
    setLog((l) => [...l, `${nowHHMMSS()} You marked yourself as ready`]);
  }

  function handleSelectStrategy(strategyId: StrategyId) {
    if (room?.status !== "strategy-selection") return;
    if (role === "spectator") return;
    setSelectedStrategy(strategyId);
    send("client:select_strategy", { strategyId });
    setLog((l) => [...l, `${nowHHMMSS()} Strategy selected: ${strategyId}`]);
  }

  function handleStartGame() {
    if (!isHost || !allStrategiesSelected) return;
    send("client:start_game", {});
    setLog((l) => [...l, `${nowHHMMSS()} Starting game...`]);
  }

  function handleLeave() {
    send("client:leave_room", {});
    navigate("/");
  }

  const roomStatus  = room?.status ?? "waiting";
  const statusLabel =
    roomStatus === "waiting"            ? "WAITING" :
    roomStatus === "strategy-selection" ? "STRATEGY SELECTION" :
                                          "IN SESSION";

  const isConnected = status === "connected";

  // Host display name
  const hostPlayer = players.find((p) => p.id === room?.hostPlayerId);

  return (
    <>
      {/* Connection overlay */}
      {(status === "connecting" || status === "reconnecting") && (
        <div className={s.connectingOverlay} role="status" aria-live="polite">
          <div className={s.connectingText}>
            {status === "connecting" ? "CONNECTING..." : "RECONNECTING..."}
          </div>
          <div className={s.connectingHint}>Room: {roomId}</div>
        </div>
      )}

      <div className={s.page}>
        {/* Header */}
        <header className={s.header}>
          <div className={s.breadcrumb}>
            <span className={s.breadcrumbLogo}>DEBUG ZERO</span>
            <span className={s.breadcrumbSep}>›</span>
            <span className={s.breadcrumbCurrent}>ROOM LOBBY</span>
          </div>
          <div className={s.headerRight}>
            <div className={s.roomIdDisplay}>
              <span className={s.roomIdLabel}>ROOM ID</span>
              <span className={s.roomIdValue}>{roomId}</span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {isConnected && <div className={s.dot} aria-label="connected" />}
              <span>{statusLabel}</span>
            </div>
            <button className={s.btnGhost} onClick={handleLeave} type="button">
              ✕ LEAVE
            </button>
          </div>
        </header>

        {/* Main */}
        <div className={s.main}>
          {/* Left column */}
          <div className={s.leftCol}>
            {/* Players */}
            <div>
              <div className={s.sectionLabel}>
                Players ({playerCount}/4)
              </div>
              <div className={s.playerGrid}>
                {Array.from({ length: 4 }).map((_, i) => {
                  const player = playerMembers[i];
                  if (!player) {
                    return (
                      <div key={i} className={`${s.playerSlot} ${s.playerSlotEmpty}`}>
                        <span className={s.emptySlotText}>EMPTY SLOT</span>
                      </div>
                    );
                  }
                  const isSelf       = player.id === playerId;
                  const isPlayerHost = player.id === room?.hostPlayerId;
                  const strategySelected = room?.selectedStrategies?.[player.id];
                  return (
                    <div
                      key={player.id}
                      className={[
                        s.playerSlot,
                        s.playerSlotFilled,
                        isSelf ? s.playerSlotSelf : "",
                      ].join(" ")}
                    >
                      <span className={s.playerSlotNum}>P{i + 1}</span>
                      <div className={s.playerBadges}>
                        {isPlayerHost && <span className={`${s.playerBadge} ${s.badgeHost}`}>HOST</span>}
                        {isSelf       && <span className={`${s.playerBadge} ${s.badgeYou}`}>YOU</span>}
                        {player.ready
                          ? <span className={`${s.playerBadge} ${s.badgeReady}`}>READY</span>
                          : <span className={`${s.playerBadge} ${s.badgeWaiting}`}>NOT READY</span>
                        }
                      </div>
                      <div className={`${s.playerName} ${isSelf ? s.playerNameSelf : ""}`}>
                        {player.name}
                      </div>
                      <div className={s.playerConn}>
                        <div className={
                          player.connectionStatus === "connected"
                            ? s.connDotGreen
                            : s.connDotGray
                        } />
                        <span>{player.connectionStatus}</span>
                      </div>
                      <div className={s.playerStrategy}>
                        Strategy:{" "}
                        {isSelf && selectedStrategy
                          ? <span className={s.strategyName}>{selectedStrategy}</span>
                          : strategySelected
                            ? <span className={s.strategyName}>SELECTED</span>
                            : <span className={s.strategyPending}>— selecting —</span>
                        }
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Strategy selection: visible in strategy-selection phase for players */}
            {role === "player" && roomStatus === "strategy-selection" && (
              <div>
                <div className={s.sectionLabel}>Strategy Selection</div>
                <div className={s.strategyArea}>
                  <div className={s.strategyHeader}>
                    <span className={s.strategyTitle}>Choose Your Strategy</span>
                    <span className={s.strategyHint}>Secret — hidden from others until session ends</span>
                  </div>
                  <div className={s.strategyGrid}>
                    {STRATEGIES.map((st) => {
                      const isSelected = selectedStrategy === st.id;
                      return (
                        <button
                          key={st.id}
                          type="button"
                          className={[
                            s.strategyCard,
                            isSelected ? s.strategyCardSelected : "",
                          ].join(" ")}
                          onClick={() => handleSelectStrategy(st.id)}
                        >
                          <div className={s.strategyCardName}>{st.id}</div>
                          <div className={s.strategyCardEffect}>{st.effect}</div>
                          <div className={s.strategyCardType}>{st.type}</div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Right column */}
          <div className={s.rightCol}>
            {/* Room Status */}
            <div className={s.statusList}>
              <div className={s.statusListHeader}>Room Status</div>
              <div className={s.statusRow}>
                <span className={s.statusKey}>ROOM ID</span>
                <span className={`${s.statusVal} ${s.statusValAmber}`}>{roomId}</span>
              </div>
              <div className={s.statusRow}>
                <span className={s.statusKey}>RULE SET</span>
                <span className={`${s.statusVal} ${s.statusValCyan}`}>BASIC</span>
              </div>
              <div className={s.statusRow}>
                <span className={s.statusKey}>PLAYERS</span>
                <span className={s.statusVal}>{playerCount} / 4</span>
              </div>
              <div className={s.statusRow}>
                <span className={s.statusKey}>STATUS</span>
                <span className={`${s.statusVal} ${s.statusValAmber}`}>{statusLabel}</span>
              </div>
              {hostPlayer && (
                <div className={s.statusRow}>
                  <span className={s.statusKey}>HOST</span>
                  <span className={`${s.statusVal} ${s.statusValCyan}`}>{hostPlayer.name}</span>
                </div>
              )}
            </div>

            {/* Ready progress */}
            <div className={s.readyProgress}>
              <div className={s.readyProgressLabel}>
                <span>READY STATUS</span>
                <span className={s.readyCount}>{readyCount} / {playerCount}</span>
              </div>
              <div className={s.progressBarBg}>
                <div
                  className={s.progressBarFill}
                  style={{ width: playerCount > 0 ? `${(readyCount / playerCount) * 100}%` : "0%" }}
                />
              </div>
              <div className={s.progressHint}>
                All players must be ready before host can start
              </div>
            </div>

            {/* Actions */}
            <div className={s.controlPanel}>
              <div className={s.controlHeader}>Actions</div>
              <div className={s.controlBody}>
                {/* W-4 fix: distinct labels for ready states */}
                {role === "player" && roomStatus === "waiting" && (
                  <button
                    type="button"
                    className={`${s.btnLg} ${isReady ? s.btnReadyDone : s.btnReady}`}
                    onClick={handleReady}
                    disabled={isReady}
                  >
                    {isReady ? "✓ READY" : "MARK AS READY"}
                  </button>
                )}

                {isHost && roomStatus === "strategy-selection" && (
                  <button
                    type="button"
                    className={`${s.btnLg} ${s.btnStart}`}
                    onClick={handleStartGame}
                    disabled={!allStrategiesSelected}
                  >
                    ▶ START GAME
                  </button>
                )}

                {roomStatus === "waiting" && !isReady && role === "player" && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.1em", textAlign: "center" }}>
                    Click MARK AS READY when you are prepared
                  </div>
                )}

                {roomStatus === "strategy-selection" && !isHost && (
                  <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.1em", textAlign: "center" }}>
                    Waiting for host to start the game...
                  </div>
                )}
              </div>
            </div>

            {/* Activity Log */}
            <div className={s.logArea}>
              <div className={s.logHeader}>Activity Log</div>
              <div className={s.logBody} ref={logBodyRef}>
                {log.length === 0 ? (
                  <div className={s.logEntry}>
                    <span className={s.logText} style={{ color: "var(--text-muted)" }}>
                      Connecting to room...
                    </span>
                  </div>
                ) : (
                  log.map((entry, i) => {
                    const spaceIdx = entry.indexOf(" ");
                    const time = entry.slice(0, spaceIdx);
                    const text = entry.slice(spaceIdx + 1);
                    return (
                      <div key={i} className={s.logEntry}>
                        <span className={s.logTime}>{time}</span>
                        <span className={s.logText}>{text}</span>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className={s.footer}>
          <span className={s.footerText}>
            ROOM: {roomId} · RULE: BASIC · WebSocket: {status.toUpperCase()}
          </span>
        </footer>
      </div>
    </>
  );
}
