import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { RoomNavigateState } from "../types/navigation";
import s from "./TopView.module.css";

export function TopView() {
  const navigate = useNavigate();

  // Create Room state
  const [createName, setCreateName]   = useState("");
  const [createError, setCreateError] = useState("");

  // Join Room state — errors keyed by field to avoid string-comparison coupling
  const [joinName,   setJoinName]   = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinRole,   setJoinRole]   = useState<"player" | "spectator">("player");
  const [joinErrors, setJoinErrors] = useState<{ name?: string; roomId?: string }>({});

  function handleCreate() {
    if (!createName.trim()) {
      setCreateError("PLAYER NAME REQUIRED");
      return;
    }
    const roomId = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    const state: RoomNavigateState = { playerName: createName.trim(), role: "player" };
    navigate(`/room/${roomId}`, { state });
  }

  function handleJoin() {
    const errors: { name?: string; roomId?: string } = {};
    if (!joinName.trim())   errors.name   = "PLAYER NAME REQUIRED";
    if (!joinRoomId.trim()) errors.roomId = "ROOM ID REQUIRED";
    if (Object.keys(errors).length > 0) {
      setJoinErrors(errors);
      return;
    }
    const state: RoomNavigateState = { playerName: joinName.trim(), role: joinRole };
    navigate(`/room/${joinRoomId.trim().toUpperCase()}`, { state });
  }

  return (
    <>
      {/* Header */}
      <header className={s.header}>
        <span className={s.logo}>DEBUG ZERO</span>
        <span className={s.version}>v1.0.0-basic</span>
        <div className={s.statusBar}>
          <div className={s.dot} />
          <span>SERVER ONLINE</span>
          <span>|</span>
          <span>RULESET: BASIC</span>
        </div>
      </header>

      {/* Decoration numbers */}
      <span className={s.decoLeft} aria-hidden="true">0 · 1 · 2 · 3 · 4 · 5 · 6 · 7 · 8 · 9</span>
      <span className={s.decoRight} aria-hidden="true">+ · - · × · ÷ · = · 0</span>

      <main className={s.page}>
        {/* Hero */}
        <div className={s.hero}>
          <h1 className={s.heroTitle}>DEBUG ZERO</h1>
          <p className={s.heroSubtitle}>Number Card Battle System</p>
          <p className={s.heroDesc}>
            数字カード 0〜9 と四則演算で目標値を <strong className={s.heroEmphasis}>0</strong> にせよ<br />
            戦略・バグ・交渉が絡み合う非対称ボードゲーム
          </p>
          <div className={s.tags}>
            <span className={`${s.tag} ${s.tagCyan}`}>REALTIME</span>
            <span className={`${s.tag} ${s.tagPurple}`}>STRATEGY</span>
            <span className={`${s.tag} ${s.tagGreen}`}>WEBSOCKET</span>
          </div>
          <div className={s.cardPreview}>
            <div className={s.numCard}>3</div>
            <div className={s.numCard}>+</div>
            <div className={s.numCard}>7</div>
            <div className={s.numCard}>=</div>
            <div className={`${s.numCard} ${s.numCardZero}`}>0</div>
          </div>
        </div>

        {/* Main action panels */}
        <div className={s.cardArea}>
          {/* Create Room */}
          <div className={s.panel}>
            <div className={s.cornerTl} />
            <div className={s.cornerBr} />
            <div className={s.panelHeader}>
              <span className={s.panelIcon}>▶</span>
              <span className={s.panelTitle}>Create Room</span>
            </div>
            <div className={s.panelBody}>
              <div className={s.fieldGroup}>
                <label htmlFor="create-player-name" className={s.fieldLabel}>Player Name</label>
                <input
                  id="create-player-name"
                  className={`${s.fieldInput}${createError ? ` ${s.fieldInputError}` : ""}`}
                  type="text"
                  placeholder="ENTER YOUR NAME"
                  value={createName}
                  onChange={(e) => { setCreateName(e.target.value); setCreateError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  maxLength={20}
                />
                {createError && <span className={s.fieldError}>{createError}</span>}
              </div>
              <div className={s.fieldGroup}>
                <span className={s.fieldLabel}>Max Players</span>
                <div className={s.fieldReadonly}>4</div>
              </div>
              <div className={s.fieldGroup}>
                <span className={s.fieldLabel}>Rule Set</span>
                <div className={s.fieldReadonlyCyan}>BASIC</div>
              </div>
              <div className={s.divider} />
              <button className={`${s.btn} ${s.btnPrimary}`} onClick={handleCreate}>
                ▶ CREATE ROOM
              </button>
            </div>
          </div>

          {/* Join Room */}
          <div className={s.panel}>
            <div className={s.cornerTl} />
            <div className={s.cornerBr} />
            <div className={s.panelHeader}>
              <span className={s.panelIcon}>◈</span>
              <span className={s.panelTitle}>Join Room</span>
            </div>
            <div className={s.panelBody}>
              <div className={s.fieldGroup}>
                <label htmlFor="join-player-name" className={s.fieldLabel}>Player Name</label>
                <input
                  id="join-player-name"
                  className={`${s.fieldInput}${joinErrors.name ? ` ${s.fieldInputError}` : ""}`}
                  type="text"
                  placeholder="ENTER YOUR NAME"
                  value={joinName}
                  onChange={(e) => { setJoinName(e.target.value); setJoinErrors((p) => ({ ...p, name: undefined })); }}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  maxLength={20}
                />
                {joinErrors.name && <span className={s.fieldError}>{joinErrors.name}</span>}
              </div>
              <div className={s.fieldGroup}>
                <label htmlFor="join-room-id" className={s.fieldLabel}>Room ID</label>
                <input
                  id="join-room-id"
                  className={`${s.fieldInput}${joinErrors.roomId ? ` ${s.fieldInputError}` : ""}`}
                  type="text"
                  placeholder="e.g. ABC12345"
                  value={joinRoomId}
                  onChange={(e) => { setJoinRoomId(e.target.value); setJoinErrors((p) => ({ ...p, roomId: undefined })); }}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  maxLength={8}
                  style={{ letterSpacing: "0.3em", textTransform: "uppercase" }}
                />
                {joinErrors.roomId && <span className={s.fieldError}>{joinErrors.roomId}</span>}
              </div>
              <div className={s.fieldGroup}>
                <span className={s.fieldLabel}>Join as</span>
                <div className={s.roleSelector}>
                  <button
                    className={`${s.roleOption}${joinRole === "player" ? ` ${s.roleOptionActive}` : ""}`}
                    onClick={() => setJoinRole("player")}
                    type="button"
                  >
                    ● PLAYER
                  </button>
                  <button
                    className={`${s.roleOption}${joinRole === "spectator" ? ` ${s.roleOptionActive}` : ""}`}
                    onClick={() => setJoinRole("spectator")}
                    type="button"
                  >
                    ○ SPECTATOR
                  </button>
                </div>
              </div>
              <div className={s.divider} />
              <button className={`${s.btn} ${s.btnSecondary}`} onClick={handleJoin}>
                ◈ JOIN ROOM
              </button>
            </div>
          </div>
        </div>

        {/* Info strip */}
        <div className={s.infoPanel}>
          <div className={s.infoItem}>
            <div className={s.infoLabel}>Players</div>
            <div className={s.infoValue}>2–4</div>
            <div className={s.infoDesc}>recommended 4</div>
          </div>
          <div className={s.infoItem}>
            <div className={s.infoLabel}>Win Condition</div>
            <div className={s.infoValue}>3</div>
            <div className={s.infoDesc}>wins required</div>
          </div>
          <div className={s.infoItem}>
            <div className={s.infoLabel}>Cards</div>
            <div className={s.infoValue}>0–9</div>
            <div className={s.infoDesc}>arithmetic battle</div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className={s.footer}>
        <span className={s.footerLeft}>DEBUG ZERO / RULE: BASIC / © 2025</span>
        <span className={s.footerRight}>Cloudflare Workers + Hono + React / WebSocket</span>
      </footer>
    </>
  );
}
