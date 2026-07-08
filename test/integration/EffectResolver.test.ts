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

// A1: 介入系（on_card_played_by_other）は自動発動ではなく
// collectInterventionCandidates（候補列挙）→ applyIntervention（accept時のみ適用）の2段。
describe("使用回数制限（A7: 1ゲーム1回）", () => {
  it("上限到達済みのControl-Subは候補に上がらない", () => {
    const card = fieldCard(3, "add", P1); // P2のControl-Subの対象
    const game = makeGame({
      field: [card],
      setNumber: 13,
      usedStrategyCounts: { [P1]: {}, [P2]: { "Control-Sub": 1 }, [P3]: {} },
    });
    const candidates = resolver.collectInterventionCandidates(
      game,
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId }
    );
    expect(candidates).toEqual([]);
  });

  it("発動（applyIntervention）でカウントが1になる（中央集計）", () => {
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [card], setNumber: 13 });
    const ctx = { actorId: P1, triggerCard: card, ruleSet };

    const candidates = resolver.collectInterventionCandidates(
      game, ctx, { [P2]: "Control-Sub" as StrategyId }
    );
    expect(candidates).toEqual([{ playerId: P2, strategyId: "Control-Sub" }]);

    const patch = resolver.applyIntervention(game, P2, "Control-Sub" as StrategyId, ctx);
    expect(patch.field![0].operation).toBe("sub");
    expect(patch.usedStrategyCounts![P2]["Control-Sub"]).toBe(1);
  });

  it("対象外カードはそもそも候補に上がらない", () => {
    const card = fieldCard(3, "mul", P1); // Control-Subの対象はaddのみ
    const game = makeGame({ field: [card], setNumber: 30 });
    const candidates = resolver.collectInterventionCandidates(
      game,
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId }
    );
    expect(candidates).toEqual([]);
  });

  it("発動後no-op（対象カード消滅等）では使用回数を消費しない", () => {
    // オファー時は対象だったが、解決時点でフィールドから消えているケース
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [], setNumber: 10 }); // カードは既に除去済み
    const patch = resolver.applyIntervention(
      game, P2, "Control-Sub" as StrategyId,
      { actorId: P1, triggerCard: card, ruleSet }
    );
    expect(patch).toEqual({});
  });
});

describe("D8: Control-Forbidden は Control系4戦略すべてを無効化する（yaml駆動）", () => {
  // trigger card の operation は各 Control 戦略の change_operation.from に一致させる
  const cases: { strategy: StrategyId; triggerOp: "add" | "sub" | "mul" | "div" }[] = [
    { strategy: "Control-Add" as StrategyId, triggerOp: "sub" },
    { strategy: "Control-Sub" as StrategyId, triggerOp: "add" },
    { strategy: "Control-Div" as StrategyId, triggerOp: "mul" },
    { strategy: "Control-Mul" as StrategyId, triggerOp: "div" },
  ];

  for (const { strategy, triggerOp } of cases) {
    it(`${strategy}: Control-Forbidden有効なら候補から除外される`, () => {
      const card = fieldCard(3, triggerOp, P1);
      const game = makeGame({
        field: [card],
        setNumber: 13,
        residualBugs: ["Control-Forbidden"],
      });
      const candidates = resolver.collectInterventionCandidates(
        game,
        { actorId: P1, triggerCard: card, ruleSet },
        { [P2]: strategy },
      );
      expect(candidates).toEqual([]);
    });

    it(`${strategy}: Control-Forbidden有効なら applyIntervention は strategy_invalidated を返し効果を出さない`, () => {
      const card = fieldCard(3, triggerOp, P1);
      const game = makeGame({
        field: [card],
        setNumber: 13,
        residualBugs: ["Control-Forbidden"],
      });
      const patch = resolver.applyIntervention(
        game, P2, strategy,
        { actorId: P1, triggerCard: card, ruleSet },
      );
      expect(patch.field).toBeUndefined(); // 演算は書き換わらない
      expect(
        (patch.appendEvents ?? []).some(
          e => e.type === "strategy_invalidated"
            && (e.payload as { reason?: string }).reason === "forbidden_bug"
            && (e.payload as { strategyId?: string }).strategyId === strategy,
        ),
      ).toBe(true);
    });
  }

  it("Control-Forbidden が無ければ Control-Sub は通常どおり候補に上がる（対照）", () => {
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [card], setNumber: 13, residualBugs: [] });
    const candidates = resolver.collectInterventionCandidates(
      game,
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId },
    );
    expect(candidates).toEqual([{ playerId: P2, strategyId: "Control-Sub" }]);
  });

  it("他のForbiddenバグ（Hack-Forbidden）はControl戦略を無効化しない（マップの取り違え防止）", () => {
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [card], setNumber: 13, residualBugs: ["Hack-Forbidden"] });
    const candidates = resolver.collectInterventionCandidates(
      game,
      { actorId: P1, triggerCard: card, ruleSet },
      { [P2]: "Control-Sub" as StrategyId },
    );
    expect(candidates).toEqual([{ playerId: P2, strategyId: "Control-Sub" }]);
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
  it("両者が発動を選んだ場合、TrickStar除去後のControl系は除去済みフィールドを見る", () => {
    // P1が奇数カード(3, add)を出す → P2のTrickStarとP3のControl-Subが両方accept。
    // 手番順（actorの次から）で P2 → P3 と解決され、P3のControl-Subは
    // 「除去後のフィールド」を対象にすべきで、除去されたカードへの
    // operation変更でフィールドを復活させてはいけない（no-op＝権利も不消費）
    const card = fieldCard(3, "add", P1);
    const game = makeGame({ field: [card], setNumber: 13 });
    const ctx = { actorId: P1, triggerCard: card, ruleSet };
    const strategies = { [P2]: "TrickStar" as StrategyId, [P3]: "Control-Sub" as StrategyId };

    const candidates = resolver.collectInterventionCandidates(game, ctx, strategies);
    // 候補順は手番順（P1の次 = P2 → P3）
    expect(candidates.map(c => c.playerId)).toEqual([P2, P3]);

    // 両者acceptを候補順に解決（GameEngine.applyInterventionResponse と同じ流れ）
    let after = game;
    for (const c of candidates) {
      after = applyPatch(after, resolver.applyIntervention(after, c.playerId, c.strategyId, ctx));
    }

    // TrickStarの除去が最終状態に残る（Control-Subの上書きで復活しない）
    expect(after.field).toHaveLength(0);
    // no-opになったControl-Subの権利は消費されない
    expect(after.usedStrategyCounts[P2]?.["TrickStar"]).toBe(1);
    expect(after.usedStrategyCounts[P3]?.["Control-Sub"]).toBeUndefined();
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
