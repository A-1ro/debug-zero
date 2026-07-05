import { describe, it, expect } from "vitest";
import { sanitizeRoomFor, maskSessionPlayers, MASKED_STRATEGY } from "../../src/server/room/sanitize";
import { MessageRouter } from "../../src/server/ws/MessageRouter";
import type { SeenMsgStorage, SeenMsgEntry } from "../../src/server/ws/MessageRouter";
import type { Room, SessionPlayer, PlayerId, RoomId, StrategyId, MessageId } from "../../src/shared/types/domain";
import type { ClientMessage } from "../../src/shared/types/messages";

const p = (s: string) => s as PlayerId;
const st = (s: string) => s as StrategyId;

// ── 戦略IDのマスク（レビューC2: DevToolsで他人の戦略が見えてしまう問題の回帰テスト）──

describe("sanitizeRoomFor", () => {
  const room: Room = {
    id: "R1" as RoomId,
    hostPlayerId: p("alice"),
    players: [],
    maxPlayers: 4,
    status: "waiting",
    ruleSetId: "basic",
    selectedStrategies: { [p("alice")]: st("aggro"), [p("bob")]: st("hack") },
  };

  it("自分の戦略はそのまま・他人はマスクされる", () => {
    const view = sanitizeRoomFor(room, p("alice"));
    expect(view.selectedStrategies?.[p("alice")]).toBe(st("aggro"));
    expect(view.selectedStrategies?.[p("bob")]).toBe(MASKED_STRATEGY);
  });

  it("マスク後も「選択済み」の真偽値は保たれる（UIの選択済み表示用）", () => {
    const view = sanitizeRoomFor(room, p("carol"));
    expect(view.selectedStrategies?.[p("alice")]).toBeTruthy();
    expect(view.selectedStrategies?.[p("bob")]).toBeTruthy();
  });

  it("元のroomオブジェクトは変更しない", () => {
    sanitizeRoomFor(room, p("carol"));
    expect(room.selectedStrategies?.[p("alice")]).toBe(st("aggro"));
  });
});

describe("maskSessionPlayers", () => {
  const players: SessionPlayer[] = [
    { playerId: p("alice"), strategyId: st("aggro"), wins: 1 },
    { playerId: p("bob"), strategyId: st("hack"), wins: 0 },
  ];

  it("本人以外のstrategyIdをマスクする", () => {
    const view = maskSessionPlayers(players, p("bob"));
    expect(view.find((x) => x.playerId === p("bob"))?.strategyId).toBe(st("hack"));
    expect(view.find((x) => x.playerId === p("alice"))?.strategyId).toBe(MASKED_STRATEGY);
  });

  it("winsなど他のフィールドは保持する", () => {
    const view = maskSessionPlayers(players, p("bob"));
    expect(view.find((x) => x.playerId === p("alice"))?.wins).toBe(1);
  });
});

// ── senderIdなりすましガード（レビューC1の回帰テスト）──

class MemStorage implements SeenMsgStorage {
  private entries: SeenMsgEntry[] = [];
  async get(): Promise<SeenMsgEntry[]> { return this.entries; }
  async put(_: "seen_msgs", value: SeenMsgEntry[]): Promise<void> { this.entries = value; }
}

function msg(type: string, senderId: string, id = crypto.randomUUID()): string {
  return JSON.stringify({
    id: id as MessageId,
    type,
    roomId: "R1",
    senderId,
    payload: {},
  } satisfies Partial<ClientMessage> & { type: string; senderId: string });
}

describe("MessageRouter authorizer (senderId spoofing guard)", () => {
  function buildRouter(boundPlayerId: string | undefined) {
    const router = new MessageRouter(new MemStorage());
    const handled: string[] = [];
    router.on("client:action", async (m) => { handled.push(m.senderId); });
    router.on("client:join_room", async (m) => { handled.push(m.senderId); });
    router.setAuthorizer((message, _connId) => {
      if (message.type === "client:join_room") return { ok: true };
      if (!boundPlayerId || boundPlayerId !== message.senderId) {
        return { ok: false, errorCode: "WS_AUTH_FAILED" };
      }
      return { ok: true };
    });
    return { router, handled };
  }

  it("bind済みplayerIdと一致するsenderIdは通す", async () => {
    const { router, handled } = buildRouter("alice");
    const result = await router.route(msg("client:action", "alice"), "conn-1");
    expect(result.ok).toBe(true);
    expect(handled).toEqual(["alice"]);
  });

  it("他人のsenderIdを名乗るメッセージを拒否する", async () => {
    const { router, handled } = buildRouter("alice");
    const result = await router.route(msg("client:action", "bob"), "conn-1");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorCode).toBe("WS_AUTH_FAILED");
    expect(handled).toEqual([]);
  });

  it("未bind接続からのaction系メッセージを拒否する", async () => {
    const { router, handled } = buildRouter(undefined);
    const result = await router.route(msg("client:action", "alice"), "conn-1");
    expect(result.ok).toBe(false);
    expect(handled).toEqual([]);
  });

  it("join_roomは未bindでも通す（初回参加）", async () => {
    const { router, handled } = buildRouter(undefined);
    const result = await router.route(msg("client:join_room", "alice"), "conn-1");
    expect(result.ok).toBe(true);
    expect(handled).toEqual(["alice"]);
  });

  it("拒否されたメッセージはdedupに登録されない（bind後の正規再送が通る）", async () => {
    const router = new MessageRouter(new MemStorage());
    const handled: string[] = [];
    let bound: string | undefined; // bind状態を後から変えられるようにする
    router.on("client:action", async (m) => { handled.push(m.senderId); });
    router.setAuthorizer((message) => {
      if (!bound || bound !== message.senderId) {
        return { ok: false, errorCode: "WS_AUTH_FAILED" };
      }
      return { ok: true };
    });

    const id = crypto.randomUUID();
    const rejected = await router.route(msg("client:action", "alice", id), "conn-1");
    expect(rejected.ok).toBe(false);

    bound = "alice"; // join完了に相当
    const retried = await router.route(msg("client:action", "alice", id), "conn-1");
    expect(retried.ok).toBe(true); // dedupに食われずハンドラまで届く
    expect(handled).toEqual(["alice"]);
  });
});
