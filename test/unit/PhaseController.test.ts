import { describe, it, expect } from "vitest";
import {
  checkPhaseTransition,
  resolveZeroCardTransition,
  isTerminalTransition,
  isPhaseTransition,
} from "../../src/server/game/PhaseController";
import type { Game, PlayerId } from "../../src/shared/types/domain";
import type { PhaseDef } from "../../src/shared/types/rules";

// ============================================================
// Fixtures
// ============================================================

const P1 = "player-1" as PlayerId;
const P2 = "player-2" as PlayerId;

function makeGame(overrides: Partial<Game> = {}): Game {
  return {
    id:                 "game-1",
    sessionId:          "session-1",
    gameIndex:          0,
    setNumber:          10,
    phase:              "normal",
    status:             "in-progress",
    deck:               ["1-1", "2-1"],
    excludedCards:      [],
    field:              [],
    hands:              { [P1]: ["3-1"], [P2]: ["2-1"] },
    usedStrategyCounts: { [P1]: {}, [P2]: {} },
    turnOrder:          [P1, P2],
    currentTurnIndex:   0,
    resetCount:         0,
    residualBugs:       [],
    events:             [],
    ...overrides,
  };
}

const normalPhaseWithDeckEmpty: PhaseDef = {
  id: "normal",
  transitionConditions: [{ type: "deck_empty", to: "showdown" }],
};

const raidPhaseWithBossHp: PhaseDef = {
  id: "raid",
  transitionConditions: [
    { type: "boss_hp_zero_or_less",       to: "finished"         },
    { type: "all_players_hp_zero_or_less", to: "session_win_boss" },
  ],
};

// ============================================================
// checkPhaseTransition
// ============================================================

describe("checkPhaseTransition", () => {
  it("returns null when no PhaseDef matches current phase", () => {
    const game = makeGame({ phase: "normal" });
    const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
    expect(result).toBeNull();
  });

  describe("deck_empty condition", () => {
    it("triggers showdown transition when deck is empty", () => {
      const game = makeGame({ phase: "normal", deck: [] });
      const result = checkPhaseTransition(game, [normalPhaseWithDeckEmpty]);
      expect(result).not.toBeNull();
      expect(result!.to).toBe("showdown");
      expect(result!.conditionType).toBe("deck_empty");
    });

    it("returns null when deck has cards", () => {
      const game = makeGame({ phase: "normal", deck: ["1-1"] });
      const result = checkPhaseTransition(game, [normalPhaseWithDeckEmpty]);
      expect(result).toBeNull();
    });
  });

  describe("boss_hp_zero_or_less condition", () => {
    it("triggers finished when bossHP <= 0", () => {
      const game = makeGame({
        phase: "raid",
        raidState: {
          bossPlayerId: P2, bossHP: 0,
          playerHPs: { [P1]: 5 },
          activeBugId: "some-bug", roundIndex: 0,
          turnOrder: [P1], currentTurnIndex: 0, bossActionsLeft: 1,
        },
      });
      const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
      expect(result!.to).toBe("finished");
      expect(result!.conditionType).toBe("boss_hp_zero_or_less");
    });

    it("triggers finished when bossHP is negative", () => {
      const game = makeGame({
        phase: "raid",
        raidState: {
          bossPlayerId: P2, bossHP: -3,
          playerHPs: { [P1]: 5 },
          activeBugId: "some-bug", roundIndex: 0,
          turnOrder: [P1], currentTurnIndex: 0, bossActionsLeft: 1,
        },
      });
      const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
      expect(result!.to).toBe("finished");
    });

    it("returns null when bossHP > 0", () => {
      const game = makeGame({
        phase: "raid",
        raidState: {
          bossPlayerId: P2, bossHP: 5,
          playerHPs: { [P1]: 5 },
          activeBugId: "some-bug", roundIndex: 0,
          turnOrder: [P1], currentTurnIndex: 0, bossActionsLeft: 1,
        },
      });
      const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
      expect(result).toBeNull();
    });

    it("returns null when raidState is absent", () => {
      const game = makeGame({ phase: "raid" });
      const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
      expect(result).toBeNull();
    });
  });

  describe("all_players_hp_zero_or_less condition", () => {
    it("triggers session_win_boss when all player HPs are <= 0", () => {
      const game = makeGame({
        phase: "raid",
        raidState: {
          bossPlayerId: P2, bossHP: 5,
          playerHPs: { [P1]: 0, [P2]: -1 },
          activeBugId: "some-bug", roundIndex: 0,
          turnOrder: [P1, P2], currentTurnIndex: 0, bossActionsLeft: 1,
        },
      });
      // Use a phase def where boss_hp_zero_or_less won't match (bossHP > 0)
      const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
      expect(result!.to).toBe("session_win_boss");
      expect(result!.conditionType).toBe("all_players_hp_zero_or_less");
    });

    it("returns null when at least one player has HP > 0", () => {
      const game = makeGame({
        phase: "raid",
        raidState: {
          bossPlayerId: P2, bossHP: 5,
          playerHPs: { [P1]: 3, [P2]: 0 },
          activeBugId: "some-bug", roundIndex: 0,
          turnOrder: [P1, P2], currentTurnIndex: 0, bossActionsLeft: 1,
        },
      });
      const result = checkPhaseTransition(game, [raidPhaseWithBossHp]);
      expect(result).toBeNull();
    });
  });

  describe("card_zero_played condition", () => {
    it("always returns null (handled by GameEngine, not PhaseController)", () => {
      const phaseWithZero: PhaseDef = {
        id: "normal",
        transitionConditions: [{ type: "card_zero_played", to: "raid" }],
      };
      const result = checkPhaseTransition(makeGame(), [phaseWithZero]);
      expect(result).toBeNull();
    });
  });
});

// ============================================================
// resolveZeroCardTransition
// ============================================================

describe("resolveZeroCardTransition", () => {
  it("returns 'raid' for choice 'raid'", () => {
    expect(resolveZeroCardTransition("raid")).toBe("raid");
  });

  it("returns 'normal' for choice 'reset'", () => {
    expect(resolveZeroCardTransition("reset")).toBe("normal");
  });
});

// ============================================================
// isTerminalTransition
// ============================================================

describe("isTerminalTransition", () => {
  it("returns true for 'finished'", () => {
    expect(isTerminalTransition("finished")).toBe(true);
  });

  it("returns true for 'session_win_boss'", () => {
    expect(isTerminalTransition("session_win_boss")).toBe(true);
  });

  it("returns false for 'normal'", () => {
    expect(isTerminalTransition("normal")).toBe(false);
  });

  it("returns false for 'showdown'", () => {
    expect(isTerminalTransition("showdown")).toBe(false);
  });

  it("returns false for 'raid'", () => {
    expect(isTerminalTransition("raid")).toBe(false);
  });
});

// ============================================================
// isPhaseTransition
// ============================================================

describe("isPhaseTransition", () => {
  it("returns true for 'normal'", () => {
    expect(isPhaseTransition("normal")).toBe(true);
  });

  it("returns true for 'showdown'", () => {
    expect(isPhaseTransition("showdown")).toBe(true);
  });

  it("returns true for 'raid'", () => {
    expect(isPhaseTransition("raid")).toBe(true);
  });

  it("returns false for 'finished'", () => {
    expect(isPhaseTransition("finished")).toBe(false);
  });

  it("returns false for 'session_win_boss'", () => {
    expect(isPhaseTransition("session_win_boss")).toBe(false);
  });
});
