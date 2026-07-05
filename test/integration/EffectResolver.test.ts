import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { RuleSetLoader } from "../../src/server/rules/RuleSetLoader";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import { applyPatch } from "../../src/server/game/GameEngine";
import { SessionService } from "../../src/server/session/SessionService";
import type { SessionStorage } from "../../src/server/session/SessionService";
import type { RuleSet } from "../../src/shared/types/rules";
import type {
  Game, Session, GameId, SessionId, RoomId, PlayerId, StrategyId, FieldCard,
} from "../../src/shared/types/domain";

// EffectResolver を「実際の配線」（yaml + registry）で通すテスト。
// レビューA6/A7/A8と効果合成（後勝ち上書き）の回帰テスト。

const P1 = "p1" as PlayerId;
const P2 = "p2" as PlayerId;
const P3 = "p3" as PlayerId;

let ruleSet: RuleSet;
let resolver: EffectResolver;

beforeAll(async () => {
  ruleSet = await RuleSetLoader.loadFromFile(join(process.cwd(), "rules", "basic.yaml"));
  const registry = new EffectRegistry();
  registerAllHandlers(registry);
  resolver = new EffectResolver(registry);
});

function fieldCard(
  rawValue: number,
  operation: "add" | "sub" | "mul" | "div",
  playerId: PlayerId
): FieldCard {
  return {
    cardId: `${rawValue}-001`,
    playerId,
    operation,
    rawValue,
    effectiveValue: rawValue,
  };
}

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "g-1" as GameId,
    sessionId: "s-1" as SessionId,
    gameIndex: 1,
    setNumber: 10,
    phase: "normal",
    status: "in-progress",
    deck: [],
    excludedCards: [],
    field: [],
    hands: { [P1]: [], [P2]: [], [P3]: [] },
    usedStrategyCounts: { [P1]: {}, [P2]: {}, [P3]: {} },
    turnOrder: [P1, P2, P3],
    currentTurnIndex: 0,
    resetCount: 0,
    residualBugs: [],
    events: [],
    ...overrides,
  };
}

describe("使用回数制限（A7: 1ゲーム1回）", () => {
  it("上限到達済みのControl-Subは発動しない", () => {
    const card = fieldCard(3, "add", P1); // P2のControl-Subの対象
    const game = makeGame({
      field: [card],
      setNumber: 13,
      usedStrategyCounts: { [P1]: {}, [P2]: { "Control-Sub": 1 }, [P3]: {} },
    });
    const patch = resolver.resolve(
      game, "on_card_played_by_other",
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId }
    );
    expect(patch.field).toBeUndefined(); // 発動していない
  });

  it("初回発動でEffectResolverがカウントを1にする（中央集計）", () => {
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [card], setNumber: 13 });
    const patch = resolver.resolve(
      game, "on_card_played_by_other",
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId }
    );
    expect(patch.field![0].operation).toBe("sub");
    expect(patch.usedStrategyCounts![P2]["Control-Sub"]).toBe(1);
  });

  it("no-op（対象外カード）では使用回数を消費しない", () => {
    const card = fieldCard(3, "mul", P1); // Control-Subの対象はaddのみ
    const game = makeGame({ field: [card], setNumber: 30 });
    const patch = resolver.resolve(
      game, "on_card_played_by_other",
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId }
    );
    expect(patch.usedStrategyCounts).toBeUndefined();
  });
});

describe("alwaysトリガーのバグ（A8: Value-Corruption）", () => {
  it("on_card_playedの解決時に発動してeffectiveValueを書き換える", () => {
    const card = fieldCard(3, "add", P1);
    const game = makeGame({
      field: [card],
      setNumber: 13,
      residualBugs: ["Value-Corruption"],
    });
    const patch = resolver.resolve(
      game, "on_card_played",
      { actorId: P1, triggerCard: card, ruleSet },
      {}
    );
    expect(patch.field![0].effectiveValue).toBe(10);
  });

  it("on_card_played_by_otherの解決時には発動しない（1アクション1回）", () => {
    const card = fieldCard(3, "add", P1);
    const game = makeGame({
      field: [card],
      setNumber: 13,
      residualBugs: ["Value-Corruption"],
    });
    const patch = resolver.resolve(
      game, "on_card_played_by_other",
      { actorId: P1, triggerCard: card, ruleSet },
      {}
    );
    expect(patch.field).toBeUndefined();
  });
});

describe("効果の逐次合成（後勝ち上書きの回帰テスト）", () => {
  it("TrickStar除去後のControl系は除去済みフィールドを見る", () => {
    // P1が奇数カード(3, add)を出す → P2のTrickStarが除去(no-op以外)、
    // P3のControl-Subは「除去後のフィールド」を対象にすべきで、
    // 除去されたカードへのoperation変更でフィールドを復活させてはいけない
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [card], setNumber: 13 });
    const patch = resolver.resolve(
      game, "on_card_played_by_other",
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "TrickStar" as StrategyId, [P3]: "Control-Sub" as StrategyId }
    );
    const after = applyPatch(game, patch);
    // TrickStarの除去が最終状態に残る（Control-Subの上書きで復活しない）
    expect(after.field).toHaveLength(0);
  });
});

// ── Zeroストラテジー（A6: on_game_start） ──

class MemSessionStorage implements SessionStorage {
  private session: Session | null = null;
  private games = new Map<string, Game>();
  async getSession(): Promise<Session | null> { return this.session; }
  async saveSession(s: Session): Promise<void> { this.session = s; }
  async getGame(id: GameId): Promise<Game | null> { return this.games.get(id) ?? null; }
  async saveGame(g: Game): Promise<void> { this.games.set(g.id, g); }
}

// シャッフルを決定的にする擬似乱数（LCG）。Math.randomのままだと
// 0カードが全て初期手札に配られて山札に残らない回があり、テストがフレークする
function seededRng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

describe("Zeroストラテジー（A6: on_game_start）", () => {
  it("ゲーム開始時に0カードが手札へ追加される", async () => {
    const service = new SessionService(new MemSessionStorage());
    const result = await service.startSession({
      roomId: "r-1" as RoomId,
      sessionId: "s-1" as SessionId,
      players: [
        { playerId: P1, strategyId: "Zero" as StrategyId },
        { playerId: P2, strategyId: "Aggro" as StrategyId },
      ],
      ruleSetId: "basic",
      ruleSet,
      effectResolver: resolver,
      rng: seededRng(42),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { game } = result.value;
    const zeroCards = game.hands[P1].filter((c) => c.startsWith("0-"));
    expect(zeroCards.length).toBeGreaterThanOrEqual(1);
    // 手札は 初期枚数 + 1
    expect(game.hands[P1].length).toBe(game.hands[P2].length + 1);
  });

  it("2人以上がZeroを選ぶと発動しない（exclusion）", async () => {
    const service = new SessionService(new MemSessionStorage());
    const result = await service.startSession({
      roomId: "r-1" as RoomId,
      sessionId: "s-2" as SessionId,
      players: [
        { playerId: P1, strategyId: "Zero" as StrategyId },
        { playerId: P2, strategyId: "Zero" as StrategyId },
      ],
      ruleSetId: "basic",
      ruleSet,
      effectResolver: resolver,
      rng: seededRng(42),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { game } = result.value;
    expect(game.hands[P1].length).toBe(game.hands[P2].length); // 追加なし
  });
});
