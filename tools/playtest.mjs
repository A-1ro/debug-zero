// debug-zero プレイテスト・オーケストレーター
// 4接続を保持したまま1セッションを最後まで対戦し、実況ログを1行ずつ吐く。
// 各プレイヤーは簡単な「性格」ロジックで自律的に手を選ぶ。
//
// 使い方: node tools/playtest.mjs [roomId]
// 出力: 標準出力に "▶ ..." 形式の実況ログ。最後に RESULT: JSON。

const BASE = process.env.DZ_BASE ?? "ws://localhost:8788";
const ROOM = process.argv[2] ?? ("PLAY" + Math.floor(Date.now() / 1000 % 100000));
const uuid = () => crypto.randomUUID();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

const PLAYERS = [
  { id: "p1", name: "アグロ子",   strategy: "Aggro",       persona: "とにかく前のめり" },
  { id: "p2", name: "コント郎",   strategy: "Control-Sub", persona: "相手の加算を減算に" },
  { id: "p3", name: "ハック美",   strategy: "Hack",        persona: "偶数を奪う" },
  { id: "p4", name: "ゼロ吉",     strategy: "Zero",        persona: "0を握る" },
];
const NAME = Object.fromEntries(PLAYERS.map((p) => [p.id, p.name]));

// ── 各プレイヤーの接続 ──
class Conn {
  constructor(p) {
    this.p = p;
    this.hand = [];
    this.ws = new WebSocket(`${BASE}/room/${ROOM}/ws`);
    this.ready = false;
    this.ws.addEventListener("message", (ev) => this.onMsg(JSON.parse(ev.data)));
  }
  send(type, payload) {
    this.ws.send(JSON.stringify({ id: uuid(), type, roomId: ROOM, senderId: this.p.id, payload }));
  }
  onMsg(m) {
    if (m.type === "server:hand_updated") this.hand = m.payload.hand;
    if (m.type === "server:game_started" || m.type === "server:state_sync") {
      if (m.payload.hand) this.hand = m.payload.hand;
    }
    // 共有ゲーム状態はorchestratorが p1 の受信で追う
    hub.onMsg(this.p.id, m);
  }
  open() { return new Promise((res) => this.ws.addEventListener("open", res, { once: true })); }
}

// ── 全体ゲーム状態（p1の受信を正とする） ──
const hub = {
  game: null, session: null, room: null, events: [],
  onMsg(pid, m) {
    switch (m.type) {
      case "server:room_updated": this.room = m.payload.room; break;
      case "server:game_started":
        if (pid === "p1") {
          this.game = { ...m.payload, phase: "normal", status: "in-progress", currentTurnIndex: 0, field: [] };
          log(`\n🎲 ゲーム${(m.payload.gameIndex ?? 0)}開始！ setNumber=${m.payload.setNumber} 手番順=${m.payload.turnOrder.map((x)=>NAME[x]).join("→")}`);
        }
        break;
      case "server:action_result":
        if (pid === "p1" && this.game) {
          const g = this.game, pl = m.payload;
          g.setNumber = pl.newSetNumber ?? g.setNumber;
          g.deckCount = pl.deckCount;
          g.turnOrder = pl.turnOrder ?? g.turnOrder;
          g.currentTurnIndex = pl.currentTurnIndex ?? g.currentTurnIndex;
          if (pl.fieldOverride) g.field = pl.fieldOverride;
          else if (pl.fieldCard) g.field = [...(g.field ?? []), pl.fieldCard];
          this.events.push(...(pl.events ?? []));
          this.narrate(pl);
        }
        break;
      case "server:phase_changed":
        if (pid === "p1" && this.game) {
          this.game.phase = m.payload.to;
          this.game.raidState = m.payload.raidState ?? this.game.raidState;
          log(`  ⟳ フェーズ移行: ${m.payload.from} → ${m.payload.to}`);
        }
        break;
      case "server:game_ended":
        if (pid === "p1") { if (this.game) this.game.status = "finished"; log(`  🏁 ゲーム終了`); }
        break;
      case "server:session_ended":
        if (pid === "p1") { this.sessionWinner = m.payload.winnerId; this.sessionDone = true;
          log(`\n👑 セッション決着！ 勝者=${NAME[m.payload.winnerId] ?? m.payload.winnerId ?? "（ボス/なし）"}`); }
        break;
      case "server:error":
        if (m.payload.code && !/DUPLICATE/.test(m.payload.code))
          this.events.push({ type: "error", info: m.payload.code });
        break;
    }
  },
  narrate(pl) {
    const actor = NAME[pl.actorId] ?? pl.actorId;
    const a = pl.action;
    if (a?.type === "play_card") {
      const v = a.cardId.split("-")[0];
      log(`  ▶ ${actor} が [${v}] を ${a.operation}${a.targetId ? "→"+(NAME[a.targetId]||a.targetId) : ""} → setNumber=${pl.newSetNumber}`);
    } else if (a?.type === "draw_card") {
      log(`  ▶ ${actor} は山札から1枚ドロー（残${pl.deckCount}）`);
    } else if (a?.type === "reset_or_raid") {
      log(`  ▶ ${actor} が0カードで【${a.choice === "raid" ? "⚔レイド" : "↺リセット"}】を選択！`);
    } else if (a?.type === "showdown_submit") {
      log(`  ▶ ${actor} が決戦提出 [${a.cardIds.join(",")}]`);
    }
  },
};

const conns = {};
for (const p of PLAYERS) conns[p.id] = new Conn(p);

// ── プレイヤーの意思決定 ──
function cardVal(id) { return parseInt(id.split("-")[0], 10); }
function decide(pid) {
  const g = hub.game, c = conns[pid];
  if (!g || g.status !== "in-progress") return null;
  const hand = c.hand ?? [];
  const last = g.field?.at(-1);

  // showdown: setNumberに近い値を1〜2枚で作る
  if (g.phase === "showdown") {
    if (!hand.length) return null;
    // 単純に最大カード1枚
    const best = [...hand].sort((x, y) => cardVal(y) - cardVal(x))[0];
    return { type: "showdown_submit", cardIds: [best] };
  }

  // raid: プレイヤーはボスを殴る／ボスは生存者を殴る
  if (g.phase === "raid" && g.raidState) {
    const rs = g.raidState;
    if (rs.turnOrder[rs.currentTurnIndex] !== pid) return null;
    if (!hand.length) return null;
    if (pid === rs.bossPlayerId) {
      const target = Object.entries(rs.playerHPs).filter(([, hp]) => hp > 0).map(([id]) => id)[0];
      if (!target) return null;
      const big = [...hand].sort((x, y) => cardVal(y) - cardVal(x))[0];
      return { type: "play_card", cardId: big, operation: "add", targetId: target };
    }
    // ボスHPちょうど0を狙う、無理なら最大で削る
    const exact = hand.find((h) => cardVal(h) === rs.bossHP);
    const pick = exact ?? [...hand].sort((x, y) => cardVal(y) - cardVal(x))[0];
    return { type: "play_card", cardId: pick, operation: "add", targetId: "boss" };
  }

  // normal: 自分の手番のみ
  if (g.turnOrder?.[g.currentTurnIndex] !== pid) return null;
  if (!hand.length) return { type: "draw_card" };

  // setNumberを0に近づける手を探す（add/sub、mul/divは条件を満たすとき）
  const s = g.setNumber;
  let best = null, bestDist = Math.abs(s);
  for (const h of hand) {
    const v = cardVal(h);
    const cands = [["sub", s - v], ["add", s + v]];
    if (last && last.rawValue === v && v !== 0) { cands.push(["mul", s * v], ["div", Math.ceil(s / v)]); }
    for (const [op, res] of cands) {
      const d = Math.abs(res);
      if (d < bestDist || (best === null && op === "sub")) { best = { cardId: h, operation: op }; bestDist = d; }
    }
  }
  if (!best) best = { cardId: hand[0], operation: "sub" };
  // 0カードを出したら後続でreset/raidを選ぶ必要 → ここではreset優先で安定
  return { type: "play_card", ...best };
}

async function act(pid) {
  const d = decide(pid);
  if (!d) return false;
  conns[pid].send("client:action", { action: d });
  // 0カードでsetNumber=0になったら reset/raid 選択が要る
  if (d.type === "play_card" && cardVal(d.cardId) === 0) {
    await sleep(400);
    // 半々でraid（レイド戦も見たいので）
    const choice = Math.random() < 0.5 ? "raid" : "reset";
    conns[pid].send("client:reset_or_raid", { choice });
  }
  return true;
}

// ── メイン進行 ──
(async () => {
  await Promise.all(PLAYERS.map((p) => conns[p.id].open()));
  log(`🏟️ アリーナ「${ROOM}」に4選手が集結！`);
  // 全員join
  for (const p of PLAYERS) { conns[p.id].send("client:join_room", { playerName: p.name, role: "player" }); await sleep(250); }
  await sleep(600);
  log(`   ${PLAYERS.map((p) => `${p.name}(${p.strategy}/${p.persona})`).join("・")}`);
  // 戦略選択
  for (const p of PLAYERS) { conns[p.id].send("client:select_strategy", { strategyId: p.strategy }); await sleep(150); }
  await sleep(400);
  // 全員ready
  for (const p of PLAYERS) { conns[p.id].send("client:ready", {}); await sleep(150); }
  await sleep(500);
  // ホスト(p1)がスタート
  log(`\n🚩 ホスト ${NAME.p1} がゲーム開始！`);
  conns.p1.send("client:start_game", {});
  await sleep(1200);

  // 進行ループ（安全のため最大200手）
  let moves = 0;
  while (!hub.sessionDone && moves < 200) {
    const g = hub.game;
    if (!g || g.status !== "in-progress") {
      // 次ゲームの開始待ち
      await sleep(600);
      moves++;
      if (moves > 6 && (!hub.game || hub.game.status !== "in-progress") && hub.sessionDone) break;
      continue;
    }
    // 手番のプレイヤーを特定して動かす
    let mover = null;
    if (g.phase === "raid" && g.raidState) mover = g.raidState.turnOrder[g.raidState.currentTurnIndex];
    else if (g.phase === "showdown") mover = PLAYERS.map((p) => p.id).find((id) => {
      const submitted = hub.events.some((e) => e.type === "showdown_submitted" && e.actorId === id);
      return !submitted && g.turnOrder.includes(id);
    });
    else mover = g.turnOrder?.[g.currentTurnIndex];

    if (mover) await act(mover);
    await sleep(650);
    moves++;
  }

  await sleep(500);
  const result = {
    room: ROOM,
    wins: hub.room ? undefined : undefined,
    sessionWinner: hub.sessionWinner ? NAME[hub.sessionWinner] ?? hub.sessionWinner : null,
    moves,
    errors: hub.events.filter((e) => e.type === "error").map((e) => e.info).slice(0, 10),
  };
  log(`\nRESULT: ${JSON.stringify(result)}`);
  for (const p of PLAYERS) try { conns[p.id].ws.close(); } catch {}
  process.exit(0);
})();
