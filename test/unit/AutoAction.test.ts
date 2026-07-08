import { describe, it, expect } from "vitest";
import { autoActionFor } from "../../src/server/game/AutoAction";
import type { Game, PlayerId } from "../../src/shared/types/domain";
import type { RuleSet } from "../../src/shared/types/rules";

// 手番タイムアウト時の代打アクション（autoActionFor）の検証。
// 「ゲームを止めない安全な一手」を各フェーズで返すことを確認する。

const P1 = "p1" as PlayerId;
const P2 = "p2" as PlayerId;

const ruleSet = {
  initialConfig: { initialHandSize: 5, initialHP: 10, recommendedPlayers: 4, setNumberFormula: "gameIndex * 10" },
} as RuleSet;

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id: "g", sessionId: "s", gameIndex: 1, setNumber: 10,
    phase: "normal", status: "in-progress",
    deck: ["3-001", "4-001"], excludedCards: [], field: [],
    hands: { [P1]: ["5-001", "2-001"], [P2]: ["6-001"] },
    usedStrategyCounts: { [P1]: {}, [P2]: {} },
    turnOrder: [P1, P2], currentTurnIndex: 0, resetCount: 0,
    residualBugs: [], events: [],
    ...overrides,
  };
}

describe("autoActionFor — normal phase (D10: 自発ドロー廃止・ランダム合法カード)", () => {
  it("ドローではなく合法カードを1枚subで出す（自発ドローはレイド専用）", () => {
    const g = makeGame({ hands: { [P1]: ["5-001", "2-001"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    // どのカードが選ばれるかはランダムだが、必ず手札のカードを sub で出す
    expect(a?.type).toBe("play_card");
    expect(a && a.type === "play_card" ? a.operation : null).toBe("sub");
    expect(a && a.type === "play_card" ? ["5-001", "2-001"].includes(a.cardId) : false).toBe(true);
  });

  it("0カードを避けて0以外の合法カードを出す（reset/raid選択待ちを防ぐ）", () => {
    // 0を含む手札 → 選ばれるのは必ず非0カード
    const g = makeGame({ hands: { [P1]: ["0-001", "5-001", "3-001", "1-001", "0-002"], [P2]: [] } });
    for (let i = 0; i < 20; i++) {
      const a = autoActionFor(g, P1, ruleSet);
      expect(a?.type).toBe("play_card");
      const cid = a && a.type === "play_card" ? a.cardId : "";
      expect(["5-001", "3-001", "1-001"]).toContain(cid);
    }
  });

  it("全部0カードのときは仕方なく0を出す（フォールバック）", () => {
    const g = makeGame({ deck: [], hands: { [P1]: ["0-001", "0-002"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a?.type).toBe("play_card");
    const cid = a && a.type === "play_card" ? a.cardId : "";
    expect(["0-001", "0-002"]).toContain(cid);
  });

  it("合法カードが1枚も無ければ skip_turn を返す（全札が禁止バグ対象）", () => {
    // Odd-Forbidden 有効・手札は全て奇数 → 合法カードゼロ → スキップ
    const g = makeGame({
      residualBugs: ["Odd-Forbidden"],
      deck: [],
      hands: { [P1]: ["5-001", "3-001", "1-001"], [P2]: [] },
    });
    expect(autoActionFor(g, P1, ruleSet)).toEqual({ type: "skip_turn" });
  });

  it("手札が空なら skip_turn（出せる札がない）", () => {
    const g = makeGame({ deck: [], hands: { [P1]: [], [P2]: [] } });
    expect(autoActionFor(g, P1, ruleSet)).toEqual({ type: "skip_turn" });
  });
});

describe("autoActionFor — 介入オファー待ち（A1）", () => {
  const card = {
    cardId: "3-001", playerId: P2, operation: "add" as const,
    rawValue: 3, effectiveValue: 3,
  };
  const pendingGame = (responses: Record<PlayerId, boolean> = {}) => makeGame({
    field: [card],
    pendingIntervention: {
      triggerCard: card,
      actorId: P2,
      setNumberBefore: 7,
      candidates: [{ playerId: P1, strategyId: "Control-Sub" }],
      responses,
    },
  });

  it("未応答の候補者にはパス（intervention_response activate:false）を返す", () => {
    const a = autoActionFor(pendingGame(), P1, ruleSet);
    expect(a).toEqual({ type: "intervention_response", activate: false });
  });

  it("応答済みの候補者にはnull", () => {
    const a = autoActionFor(pendingGame({ [P1]: false }), P1, ruleSet);
    expect(a).toBeNull();
  });

  it("候補者でないプレイヤーにはnull（介入待ち中は他の代打もしない）", () => {
    const a = autoActionFor(pendingGame(), P2, ruleSet);
    expect(a).toBeNull();
  });
});

describe("autoActionFor — showdown phase", () => {
  it("手札の最小カード1枚を提出する", () => {
    const g = makeGame({ phase: "showdown", hands: { [P1]: ["8-001", "3-001"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a).toEqual({ type: "showdown_submit", cardIds: ["3-001"] });
  });

  it("手札が空ならnull", () => {
    const g = makeGame({ phase: "showdown", hands: { [P1]: [], [P2]: [] } });
    expect(autoActionFor(g, P1, ruleSet)).toBeNull();
  });
});

describe("autoActionFor — raid phase", () => {
  const raidBase = (overrides = {}) => makeGame({
    phase: "raid",
    hands: { [P1]: ["9-001", "2-001"], [P2]: ["7-001", "1-001"] },
    raidState: {
      bossPlayerId: P2, bossHP: 14, playerHPs: { [P1]: 10 },
      activeBugId: "", roundIndex: 1, turnOrder: [P1, P2], currentTurnIndex: 0,
      bossActionsLeft: 1,
    },
    ...overrides,
  });

  it("プレイヤーはボスへ最小カード攻撃", () => {
    const a = autoActionFor(raidBase(), P1, ruleSet);
    expect(a).toEqual({ type: "play_card", cardId: "2-001", operation: "add", targetId: "boss" });
  });

  it("ボスは生存プレイヤーへ最小カード攻撃", () => {
    const g = raidBase({
      raidState: {
        bossPlayerId: P2, bossHP: 14, playerHPs: { [P1]: 10 },
        activeBugId: "", roundIndex: 1, turnOrder: [P1, P2], currentTurnIndex: 1,
        bossActionsLeft: 1,
      },
    });
    const a = autoActionFor(g, P2, ruleSet);
    expect(a).toEqual({ type: "play_card", cardId: "1-001", operation: "add", targetId: P1 });
  });

  it("手番でないプレイヤーにはnull", () => {
    const a = autoActionFor(raidBase(), P2, ruleSet); // currentTurnIndex=0はP1
    expect(a).toBeNull();
  });

  it("プレイヤーが手札切れならドローで補充", () => {
    const g = raidBase({ hands: { [P1]: [], [P2]: ["7-001"] }, deck: ["5-001"] });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a).toEqual({ type: "draw_card" });
  });
});
