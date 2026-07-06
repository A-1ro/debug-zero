// debug-zero エージェント用CLIクライアント
// サブエージェントが1プレイヤーとして対戦するための「1コマンド=1アクション」インターフェース。
// 毎回新しいWebSocketで接続し（サーバの再接続パスを利用）、結果を要約JSONで出力して終了する。
//
// 使い方:
//   node tools/agent-client.mjs <roomId> <playerId> <name> <cmd> [args...]
// cmd:
//   join                     ルームに参加（初回は名前で作成/参加）
//   ready                    準備完了にする
//   strategy <StrategyId>    戦略を選ぶ（例: Aggro, Hack, Zero, Control-Add…）
//   start                    ゲーム開始（ホストのみ）
//   state                    現在の状態を見る
//   wait                     自分の手番（またはゲーム終了）まで待って状態を返す（最大60秒）
//   play <cardId> <add|sub|mul|div> [targetId|boss]   カードを出す
//   draw                     山札から引く（レイド中は手札補充）
//   choose <reset|raid>      0カード後の選択
//   submit <cardId[,cardId]> [op]   決戦フェーズの提出（1〜2枚）
//   remove <bugId> [cardIds,csv]    バグ除去
//
// 環境変数 DZ_BASE でサーバを指定（デフォルト ws://localhost:8788）

const BASE = process.env.DZ_BASE ?? "ws://localhost:8788";
const [roomId, playerId, playerName, cmd, ...args] = process.argv.slice(2);
if (!roomId || !playerId || !cmd) {
  console.error("usage: node tools/agent-client.mjs <roomId> <playerId> <name> <cmd> [args]");
  process.exit(2);
}

const state = { room: null, session: null, game: null, hand: null, errors: [], events: [] };

function summarize() {
  const g = state.game;
  const me = playerId;
  const summary = {
    playerId: me,
    room: state.room && {
      id: state.room.id,
      status: state.room.status,
      players: state.room.players.map((p) => ({ id: p.id, name: p.name, ready: p.ready, conn: p.connectionStatus })),
    },
    session: state.session && {
      status: state.session.status,
      wins: Object.fromEntries(state.session.players.map((p) => [p.playerId, p.wins])),
      winnerId: state.session.winnerId,
    },
    game: g && {
      phase: g.phase,
      status: g.status,
      setNumber: g.setNumber,
      deckCount: g.deckCount,
      turnOrder: g.turnOrder,
      currentTurn: g.turnOrder?.[g.currentTurnIndex],
      myTurn: g.turnOrder?.[g.currentTurnIndex] === me,
      fieldTail: (g.field ?? []).slice(-3).map((f) => `${f.rawValue}(${f.operation})by:${f.playerId}`),
      winnerIds: g.winnerIds,
      raid: g.raidState && {
        boss: g.raidState.bossPlayerId,
        bossHP: g.raidState.bossHP,
        playerHPs: g.raidState.playerHPs,
        raidTurn: g.raidState.turnOrder?.[g.raidState.currentTurnIndex],
        myRaidTurn: g.raidState.turnOrder?.[g.raidState.currentTurnIndex] === me,
      },
      showdownSubmittedByMe: (g.events ?? []).concat(state.events).some(
        (e) => e.type === "showdown_submitted" && e.actorId === me
      ),
    },
    myHand: state.hand,
    recentEvents: state.events.slice(-8).map((e) => `${e.type}:${e.actorId ?? ""}`),
    errors: state.errors,
  };
  return summary;
}

const uuid = () => crypto.randomUUID();
const ws = new WebSocket(`${BASE}/room/${roomId}/ws`);
let finished = false;

function finish(code = 0) {
  if (finished) return;
  finished = true;
  console.log(JSON.stringify(summarize(), null, 1));
  try { ws.close(); } catch {}
  process.exit(code);
}

function send(type, payload) {
  ws.send(JSON.stringify({ id: uuid(), type, roomId, senderId: playerId, payload }));
}

function myTurnNow() {
  const g = state.game;
  if (!g || g.status !== "in-progress") return false;
  if (g.phase === "showdown") {
    const submitted = (g.events ?? []).concat(state.events).some(
      (e) => e.type === "showdown_submitted" && e.actorId === playerId
    );
    return !submitted && g.turnOrder.includes(playerId);
  }
  if (g.phase === "raid" && g.raidState) {
    return g.raidState.turnOrder?.[g.raidState.currentTurnIndex] === playerId;
  }
  return g.turnOrder?.[g.currentTurnIndex] === playerId;
}

let actionSent = false;
let settleTimer = null;
const settle = (ms = 1200) => {
  clearTimeout(settleTimer);
  settleTimer = setTimeout(() => finish(0), ms);
};

// wait モード: 自分の手番 or 終了まで待つ（最大60秒）
const WAIT_MODE = cmd === "wait";
const waitDeadline = Date.now() + 60_000;
function maybeResolveWait() {
  if (!WAIT_MODE) return;
  const g = state.game;
  if ((g && (g.status === "finished" || myTurnNow())) || Date.now() > waitDeadline) {
    settle(300);
  }
}

ws.addEventListener("open", () => {
  send("client:join_room", { playerName: playerName || playerId, role: "player" });
});

ws.addEventListener("message", (ev) => {
  let m;
  try { m = JSON.parse(ev.data); } catch { return; }
  switch (m.type) {
    case "server:room_updated":
      state.room = m.payload.room;
      break;
    case "server:state_sync":
      state.room = m.payload.room;
      state.session = m.payload.session;
      state.game = m.payload.game;
      if (m.payload.game) state.hand = m.payload.game.hand;
      onSynced();
      break;
    case "server:game_started":
      state.game = { ...(state.game ?? {}), ...m.payload, phase: "normal", status: "in-progress",
        currentTurnIndex: 0, field: [], events: [] };
      break;
    case "server:hand_updated":
      state.hand = m.payload.hand;
      break;
    case "server:action_result": {
      const g = state.game;
      if (g) {
        g.setNumber = m.payload.newSetNumber ?? g.setNumber;
        g.deckCount = m.payload.deckCount;
        g.turnOrder = m.payload.turnOrder ?? g.turnOrder;
        g.currentTurnIndex = m.payload.currentTurnIndex ?? g.currentTurnIndex;
        if (m.payload.fieldOverride) g.field = m.payload.fieldOverride;
        else if (m.payload.fieldCard) g.field = [...(g.field ?? []), m.payload.fieldCard];
      }
      state.events.push(...(m.payload.events ?? []));
      break;
    }
    case "server:phase_changed":
      if (state.game) {
        state.game.phase = m.payload.to;
        state.game.raidState = m.payload.raidState ?? state.game.raidState;
      }
      break;
    case "server:game_ended":
      if (state.game) state.game.status = "finished";
      state.events.push({ type: "game_ended", actorId: "system" });
      break;
    case "server:session_ended":
      if (state.session) { state.session.status = "finished"; state.session.winnerId = m.payload.winnerId; }
      state.events.push({ type: "session_ended", actorId: "system" });
      break;
    case "server:error":
      state.errors.push(`${m.payload.code}${m.payload.detail ? ":" + m.payload.detail : ""}`);
      break;
  }
  maybeResolveWait();
  if (actionSent) settle();
});

let synced = false;
function onSynced() {
  if (synced) return;
  synced = true;

  switch (cmd) {
    case "join":
    case "state":
      settle(800);
      return;
    case "wait":
      maybeResolveWait();
      return;
    case "ready":
      send("client:ready", {});
      break;
    case "strategy":
      send("client:select_strategy", { strategyId: args[0] });
      break;
    case "start":
      send("client:start_game", {});
      break;
    case "play": {
      const [cardId, operation, targetId] = args;
      send("client:action", { action: { type: "play_card", cardId, operation, ...(targetId ? { targetId } : {}) } });
      break;
    }
    case "draw":
      send("client:action", { action: { type: "draw_card" } });
      break;
    case "choose":
      send("client:reset_or_raid", { choice: args[0] });
      break;
    case "submit": {
      const cardIds = args[0].split(",");
      const operation = args[1];
      send("client:action", { action: { type: "showdown_submit", cardIds, ...(operation ? { operation } : {}) } });
      break;
    }
    case "remove": {
      const bugId = args[0];
      const costCardIds = args[1] ? args[1].split(",") : [];
      send("client:action", { action: { type: "remove_bug", bugId, costCardIds } });
      break;
    }
    default:
      state.errors.push(`unknown cmd: ${cmd}`);
      settle(100);
      return;
  }
  actionSent = true;
  settle(1500);
}

ws.addEventListener("error", () => { state.errors.push("ws error"); finish(1); });
setTimeout(() => { state.errors.push("timeout"); finish(1); }, 70_000);
