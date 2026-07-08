import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { RuleSetLoader } from "../../src/server/rules/RuleSetLoader";
import { EffectRegistry } from "../../src/server/effects/EffectRegistry";
import { EffectResolver } from "../../src/server/effects/EffectResolver";
import { registerAllHandlers } from "../../src/server/effects/registerHandlers";
import { applyAction } from "../../src/server/game/GameEngine";
import type { EngineContext } from "../../src/server/game/GameEngine";
import { validate } from "../../src/server/game/ActionValidator";
import {
  ACTION_INTERVENTION_PENDING,
  ACTION_NO_PENDING_INTERVENTION,
  ACTION_NOT_YOUR_TURN,
  ACTION_ALREADY_SUBMITTED,
} from "../../src/shared/constants";
import type { RuleSet } from "../../src/shared/types/rules";
import type {
  Game, GameId, SessionId, PlayerId, StrategyId,
} from "../../src/shared/types/domain";

// A1（オーナー裁定）: 介入系戦略（Control-Add/Sub/Mul/Div・Hack・TrickStar）の任意発動化。
// トリガー成立時に自動発動せず、候補者へオファー → 全員応答（accept/pass）まで
// ゲームは凍結（手番前進なし）。パス/タイムアウトは1ゲーム1回の権利を消費しない。

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

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "g-1" as GameId,
    sessionId: "s-1" as SessionId,
    gameIndex: 1,
    setNumber: 10,
    phase: "normal",
    status: "in-progress",
    deck: ["9-001", "9-002"],
    excludedCards: [],
    field: [],
    hands: { [P1]: ["3-002", "8-002", "0-001", "4-002"], [P2]: ["1-001"], [P3]: ["2-001"] },
    usedStrategyCounts: { [P1]: {}, [P2]: {}, [P3]: {} },
    turnOrder: [P1, P2, P3],
    currentTurnIndex: 0,
    resetCount: 0,
    residualBugs: [],
    events: [],
    ...overrides,
  };
}

function ctx(
  actorId: PlayerId,
  playerStrategies: Record<PlayerId, StrategyId>,
): EngineContext {
  return {
    actorId,
    ruleSet,
    playerStrategies,
    effectResolver: resolver,
    rng: () => 0.5,
  };
}

describe("オファー成立（pendingIntervention）", () => {
  it("候補ありのプレイでは手番が進まず、補充ドローもされず、待機状態になる", () => {
    const game = makeGame();
    const strategies = { [P1]: "Aggro", [P2]: "Control-Sub" } as Record<PlayerId, StrategyId>;

    const g = applyAction(game, { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, strategies));

    expect(g.pendingIntervention).toBeDefined();
    expect(g.pendingIntervention!.actorId).toBe(P1);
    expect(g.pendingIntervention!.candidates).toEqual([{ playerId: P2, strategyId: "Control-Sub" }]);
    expect(g.pendingIntervention!.responses).toEqual({});
    // 手番は進まない・補充も引かれない（凍結）
    expect(g.currentTurnIndex).toBe(0);
    expect(g.deck).toHaveLength(2);
    expect(g.hands[P1]).not.toContain("3-002"); // カード自体は場に出ている
  });

  it("候補ゼロなら従来どおり即続行する（回帰ゼロ・一切待たない）", () => {
    const game = makeGame();
    // P2/P3 は介入戦略を持たない
    const strategies = { [P1]: "Aggro", [P2]: "Zero", [P3]: "Aggro" } as Record<PlayerId, StrategyId>;

    const g = applyAction(game, { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, strategies));

    expect(g.pendingIntervention).toBeUndefined();
    expect(g.currentTurnIndex).toBe(1); // 手番前進
    expect(g.deck).toHaveLength(1);     // 補充済み
  });

  it("Forbiddenバグ有効時は候補に上がらず、待ちも発生しない", () => {
    const game = makeGame({ residualBugs: ["Control-Forbidden"] });
    const strategies = { [P1]: "Aggro", [P2]: "Control-Sub" } as Record<PlayerId, StrategyId>;

    const g = applyAction(game, { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, strategies));

    expect(g.pendingIntervention).toBeUndefined();
    expect(g.currentTurnIndex).toBe(1);
  });

  it("複数候補は手番順（actorの次から）に並ぶ", () => {
    // P2 がプレイ → 候補順は P3 → P1
    const game = makeGame({ currentTurnIndex: 1 });
    const strategies = {
      [P1]: "Control-Sub",  // addカードが対象
      [P2]: "Aggro",
      [P3]: "TrickStar",    // 奇数カードが対象
    } as Record<PlayerId, StrategyId>;

    const g = applyAction(game, { type: "play_card", cardId: "1-001", operation: "add" }, ctx(P2, strategies));

    expect(g.pendingIntervention!.candidates.map(c => c.playerId)).toEqual([P3, P1]);
  });
});

describe("オファー中のアクションブロック", () => {
  function pendingGame(): Game {
    const strategies = { [P1]: "Aggro", [P2]: "Control-Sub" } as Record<PlayerId, StrategyId>;
    return applyAction(
      makeGame(), { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, strategies),
    );
  }

  it("オファー中の play_card / draw_card は ACTION_INTERVENTION_PENDING で拒否される", () => {
    const g = pendingGame();
    const vCtx = { actorId: P1, ruleSet };
    expect(validate(g, { type: "play_card", cardId: "8-002", operation: "add" }, vCtx).errorCode)
      .toBe(ACTION_INTERVENTION_PENDING);
    expect(validate(g, { type: "draw_card" }, vCtx).errorCode)
      .toBe(ACTION_INTERVENTION_PENDING);
  });

  it("候補者以外の intervention_response は拒否される", () => {
    const g = pendingGame();
    const result = validate(g, { type: "intervention_response", activate: true }, { actorId: P3, ruleSet });
    expect(result.errorCode).toBe(ACTION_NOT_YOUR_TURN);
  });

  it("二重応答は拒否される", () => {
    const strategies = { [P1]: "Aggro", [P2]: "Control-Sub" } as Record<PlayerId, StrategyId>;
    let g = pendingGame();
    // 2候補いないので applyAction すると解決してしまう — responses を直接検証用に細工
    g = { ...g, pendingIntervention: { ...g.pendingIntervention!, responses: { [P2]: false } } };
    const result = validate(g, { type: "intervention_response", activate: true }, { actorId: P2, ruleSet });
    expect(result.errorCode).toBe(ACTION_ALREADY_SUBMITTED);
    void strategies;
  });

  it("オファーが無いときの intervention_response は拒否される", () => {
    const result = validate(makeGame(), { type: "intervention_response", activate: false }, { actorId: P2, ruleSet });
    expect(result.errorCode).toBe(ACTION_NO_PENDING_INTERVENTION);
  });
});

describe("応答の解決", () => {
  const strategies = { [P1]: "Aggro", [P2]: "Control-Sub" } as Record<PlayerId, StrategyId>;

  function playPending(): Game {
    // P1(Aggro) が 3(add): 10 + 3*2 = 16
    return applyAction(
      makeGame(), { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, strategies),
    );
  }

  it("パス（activate:false）では発動せず、権利も消費せず、ゲームが続行する", () => {
    const pending = playPending();
    const g = applyAction(pending, { type: "intervention_response", activate: false }, ctx(P2, strategies));

    expect(g.pendingIntervention).toBeUndefined();
    expect(g.setNumber).toBe(16); // 効果なし
    expect(g.field.at(-1)!.operation).toBe("add");
    expect(g.usedStrategyCounts[P2]?.["Control-Sub"]).toBeUndefined(); // 権利温存
    expect(g.currentTurnIndex).toBe(1); // 手番前進
    expect(g.deck).toHaveLength(1);     // 補充済み
  });

  it("パスした権利は温存され、次のトリガーで再び候補に上がる", () => {
    // 山札を厚めにして deck_empty → showdown 遷移を避ける
    const pending = applyAction(
      makeGame({ deck: ["9-001", "9-002", "9-003", "9-004"] }),
      { type: "play_card", cardId: "3-002", operation: "add" },
      ctx(P1, strategies),
    );
    let g = applyAction(pending, { type: "intervention_response", activate: false }, ctx(P2, strategies));
    // P2 の手番: 介入対象にならない手を打つ（P2自身のプレイは自分の戦略対象外）
    g = applyAction(g, { type: "play_card", cardId: "1-001", operation: "sub" }, ctx(P2, strategies));
    // P2 は候補にならない（自分のカード）が、P3 の手番後にまた P1 がプレイしたら…
    // 簡潔化のため直接 P3 に手番を回さず、P2 プレイ時点で候補ゼロ→凍結なしを確認
    expect(g.pendingIntervention).toBeUndefined();
    // P3 の手番で add プレイ → Control-Sub のトリガーが再成立し、P2 が再び候補に
    const g2 = applyAction(g, { type: "play_card", cardId: "2-001", operation: "add" }, ctx(P3, strategies));
    expect(g2.pendingIntervention?.candidates).toEqual([{ playerId: P2, strategyId: "Control-Sub" }]);
  });

  it("accept で効果が適用され、権利を消費し、手番が進む", () => {
    const pending = playPending();
    const g = applyAction(pending, { type: "intervention_response", activate: true }, ctx(P2, strategies));

    expect(g.pendingIntervention).toBeUndefined();
    // Control-Sub: add → sub に変更、10 - 6(=3*2) = 4
    expect(g.field.at(-1)!.operation).toBe("sub");
    expect(g.setNumber).toBe(4);
    expect(g.usedStrategyCounts[P2]["Control-Sub"]).toBe(1);
    expect(g.currentTurnIndex).toBe(1);
  });

  it("複数候補は全員の応答が揃うまで解決されない", () => {
    const multi = { [P1]: "Aggro", [P2]: "Control-Sub", [P3]: "TrickStar" } as Record<PlayerId, StrategyId>;
    // 3(奇数, add) → P2(Control-Sub) と P3(TrickStar) の両方が候補
    const pending = applyAction(
      makeGame(), { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, multi),
    );
    expect(pending.pendingIntervention!.candidates.map(c => c.playerId)).toEqual([P2, P3]);

    const afterOne = applyAction(pending, { type: "intervention_response", activate: true }, ctx(P2, multi));
    expect(afterOne.pendingIntervention).toBeDefined(); // まだ P3 待ち
    expect(afterOne.setNumber).toBe(16);                // 未解決

    const done = applyAction(afterOne, { type: "intervention_response", activate: true }, ctx(P3, multi));
    expect(done.pendingIntervention).toBeUndefined();
    // 解決順は手番順: P2 の Control-Sub（add→sub, 10-6=4）→ P3 の TrickStar（除去, →10）
    expect(done.field).toHaveLength(0);
    expect(done.setNumber).toBe(10);
    expect(done.usedStrategyCounts[P2]["Control-Sub"]).toBe(1);
    expect(done.usedStrategyCounts[P3]["TrickStar"]).toBe(1);
  });

  it("先行acceptで対象が消えた後続acceptはno-opとなり権利を消費しない", () => {
    const multi = { [P1]: "Aggro", [P2]: "TrickStar", [P3]: "Control-Sub" } as Record<PlayerId, StrategyId>;
    const pending = applyAction(
      makeGame(), { type: "play_card", cardId: "3-002", operation: "add" }, ctx(P1, multi),
    );
    // 候補順は P2(TrickStar) → P3(Control-Sub)
    let g = applyAction(pending, { type: "intervention_response", activate: true }, ctx(P2, multi));
    g = applyAction(g, { type: "intervention_response", activate: true }, ctx(P3, multi));

    expect(g.field).toHaveLength(0); // TrickStar が除去
    expect(g.usedStrategyCounts[P2]["TrickStar"]).toBe(1);
    expect(g.usedStrategyCounts[P3]?.["Control-Sub"]).toBeUndefined(); // no-op → 不消費
  });
});

describe("解決後の連鎖（勝利・バスト・0カード待ち）", () => {
  it("全員パス後に setNumber==0 勝利が正しく発火する", () => {
    const strategies = { [P1]: "Zero", [P2]: "Control-Add" } as Record<PlayerId, StrategyId>;
    // setNumber=8 で 8(sub) → 0。subカードは Control-Add の対象なのでオファーが立つ
    const game = makeGame({ setNumber: 8 });
    const pending = applyAction(game, { type: "play_card", cardId: "8-002", operation: "sub" }, ctx(P1, strategies));
    expect(pending.pendingIntervention).toBeDefined();
    expect(pending.status).toBe("in-progress"); // 勝利判定はオファー解決まで保留

    const g = applyAction(pending, { type: "intervention_response", activate: false }, ctx(P2, strategies));
    expect(g.status).toBe("finished");
    expect(g.winnerId).toBe(P1);
  });

  it("accept で 0 勝利が阻止される（Control-Add が sub→add に変更）", () => {
    const strategies = { [P1]: "Zero", [P2]: "Control-Add" } as Record<PlayerId, StrategyId>;
    const game = makeGame({ setNumber: 8 });
    const pending = applyAction(game, { type: "play_card", cardId: "8-002", operation: "sub" }, ctx(P1, strategies));

    const g = applyAction(pending, { type: "intervention_response", activate: true }, ctx(P2, strategies));
    expect(g.status).toBe("in-progress");
    expect(g.setNumber).toBe(16); // 8 + 8
  });

  it("accept の結果 Aggro プレイヤーが負数になったらバースト処理が走る", () => {
    const strategies = { [P1]: "Aggro", [P2]: "Control-Sub" } as Record<PlayerId, StrategyId>;
    // setNumber=3 で P1(Aggro) が 4(add): 3 + 8 = 11 → Control-Sub accept: 3 - 8 = -5
    const game = makeGame({ setNumber: 3 });
    const pending = applyAction(game, { type: "play_card", cardId: "4-002", operation: "add" }, ctx(P1, strategies));

    const g = applyAction(pending, { type: "intervention_response", activate: true }, ctx(P2, strategies));
    // 3人戦: P1 が脱落してゲーム続行、setNumber はプレイ前に巻き戻し
    expect(g.status).toBe("in-progress");
    expect(g.turnOrder).toEqual([P2, P3]);
    expect(g.setNumber).toBe(3);
    expect(g.excludedCards).toContain("4-002");
    expect(g.events.some(e => e.type === "player_eliminated")).toBe(true);
  });

  it("0カードプレイのオファー解決後も reset_or_raid 待ちが維持される", () => {
    const strategies = { [P1]: "Zero", [P2]: "Hack" } as Record<PlayerId, StrategyId>;
    // 0 は偶数 → Hack の候補が立つ
    const game = makeGame();
    const pending = applyAction(game, { type: "play_card", cardId: "0-001", operation: "sub" }, ctx(P1, strategies));
    expect(pending.pendingIntervention!.candidates).toEqual([{ playerId: P2, strategyId: "Hack" }]);

    const g = applyAction(pending, { type: "intervention_response", activate: true }, ctx(P2, strategies));
    expect(g.field.at(-1)!.playerId).toBe(P2); // Hack が奪取
    expect(g.currentTurnIndex).toBe(0);        // 手番は進まない（0カード待ち）
    // P1 の reset_or_raid が合法（オファー解決済みなので凍結も解除）
    const v = validate(g, { type: "reset_or_raid", choice: "reset" }, { actorId: P1, ruleSet });
    expect(v.valid).toBe(true);
  });
});
