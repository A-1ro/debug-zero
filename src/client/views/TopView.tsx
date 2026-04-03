import { useState } from "react";
import { useNavigate } from "react-router-dom";
import s from "./TopView.module.css";

export function TopView() {
  const navigate = useNavigate();

  // Create Room state
  const [createName, setCreateName]   = useState("");
  const [createError, setCreateError] = useState("");

  // Join Room state
  const [joinName,   setJoinName]   = useState("");
  const [joinRoomId, setJoinRoomId] = useState("");
  const [joinRole,   setJoinRole]   = useState<"player" | "spectator">("player");
  const [joinError,  setJoinError]  = useState("");

  function handleCreate() {
    if (!createName.trim()) {
      setCreateError("PLAYER NAME REQUIRED");
      return;
    }
    const roomId = crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    navigate(`/room/${roomId}`, {
      state: { playerName: createName.trim(), role: "player" as const },
    });
  }

  function handleJoin() {
    if (!joinName.trim()) {
      setJoinError("PLAYER NAME REQUIRED");
      return;
    }
    if (!joinRoomId.trim()) {
      setJoinError("ROOM ID REQUIRED");
      return;
    }
    navigate(`/room/${joinRoomId.trim().toUpperCase()}`, {
      state: { playerName: joinName.trim(), role: joinRole },
    });
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
                <label className={s.fieldLabel}>Player Name</label>
                <input
                  className={`${s.fieldInput}${createError ? ` ${s.fieldInputError}` : ""}`}
                  type="text"
                  placeholder="ENTER YOUR NAME"
                  value={createName}
                  onChange={(e) => { setCreateName(e.target.value); setCreateError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                  maxLength={20}
                />
              </div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Max Players</label>
                <input
                  className={s.fieldInput}
                  type="number"
                  defaultValue={4}
                  min={2}
                  max={4}
                  readOnly
                />
              </div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Rule Set</label>
                <input
                  className={s.fieldInput}
                  type="text"
                  value="BASIC"
                  readOnly
                />
              </div>
              {createError && <span className={s.fieldError}>{createError}</span>}
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
                <label className={s.fieldLabel}>Player Name</label>
                <input
                  className={`${s.fieldInput}${joinError === "PLAYER NAME REQUIRED" ? ` ${s.fieldInputError}` : ""}`}
                  type="text"
                  placeholder="ENTER YOUR NAME"
                  value={joinName}
                  onChange={(e) => { setJoinName(e.target.value); setJoinError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  maxLength={20}
                />
              </div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Room ID</label>
                <input
                  className={`${s.fieldInput}${joinError === "ROOM ID REQUIRED" ? ` ${s.fieldInputError}` : ""}`}
                  type="text"
                  placeholder="e.g. ABC12345"
                  value={joinRoomId}
                  onChange={(e) => { setJoinRoomId(e.target.value); setJoinError(""); }}
                  onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                  maxLength={8}
                  style={{ letterSpacing: "0.3em", textTransform: "uppercase" }}
                />
              </div>
              <div className={s.fieldGroup}>
                <label className={s.fieldLabel}>Join as</label>
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
              {joinError && <span className={s.fieldError}>{joinError}</span>}
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
