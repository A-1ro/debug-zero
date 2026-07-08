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

describe("autoActionFor — normal phase", () => {
  it("引ける状況ではドローを選ぶ（勝敗や0カード分岐を避ける安全策）", () => {
    const a = autoActionFor(makeGame(), P1, ruleSet);
    expect(a).toEqual({ type: "draw_card" });
  });

  it("手札が満杯ならドローできず最小カードをsubで出す", () => {
    const g = makeGame({ hands: { [P1]: ["5-001", "4-002", "3-002", "2-002", "1-001"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a).toEqual({ type: "play_card", cardId: "1-001", operation: "sub" });
  });

  it("山札が空ならドローできず最小カードをsubで出す", () => {
    const g = makeGame({ deck: [], hands: { [P1]: ["7-001", "2-001"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a).toEqual({ type: "play_card", cardId: "2-001", operation: "sub" });
  });

  it("プレイ時は0カードを避けて0以外の最小カードを出す（reset/raid選択待ちを防ぐ）", () => {
    // 手札満杯・0を含む → 0ではなく1を出すべき
    const g = makeGame({ hands: { [P1]: ["0-001", "5-001", "3-001", "1-001", "0-002"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a).toEqual({ type: "play_card", cardId: "1-001", operation: "sub" });
  });

  it("全部0カードのときは仕方なく0を出す（フォールバック）", () => {
    const g = makeGame({ deck: [], hands: { [P1]: ["0-001", "0-002"], [P2]: [] } });
    const a = autoActionFor(g, P1, ruleSet);
    expect(a).toEqual({ type: "play_card", cardId: "0-001", operation: "sub" });
  });

  it("手札も山札も無ければnull（代打不能）", () => {
    const g = makeGame({ deck: [], hands: { [P1]: [], [P2]: [] } });
    expect(autoActionFor(g, P1, ruleSet)).toBeNull();
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
