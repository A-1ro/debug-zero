import { describe, it, expect, beforeAll } from "vitest";
import { join } from "path";
import { RuleSetLoader } from "../../src/server/rules/RuleSetLoader";
import type { RuleSet } from "../../src/shared/types/rules";

// ============================================================
// Load basic.yaml once before all tests
// ============================================================

let ruleSet: RuleSet;

// NOTE: loadFromFile() writes to globalRuleSetRegistry. The registry has no clear() method,
// so state persists across test files when run in the same process. This is acceptable as
// basic.yaml is idempotent to re-register. An afterAll cleanup can be added if
// globalRuleSetRegistry gains an unregister/clear API in future.
beforeAll(async () => {
  const yamlPath = join(process.cwd(), "rules", "basic.yaml");
  ruleSet = await RuleSetLoader.loadFromFile(yamlPath);
});

// ============================================================
// RuleSetLoader: basic.yaml のパース
// ============================================================

describe("RuleSetLoader: basic.yaml のパース", () => {
  it("ruleSet が正しくロードされる", () => {
    expect(ruleSet).toBeDefined();
    expect(ruleSet.id).toBe("basic");
    expect(ruleSet.version).toBe("1.0.0");
  });

  it("strategies が 8 件あること", () => {
    expect(ruleSet.strategies).toHaveLength(8);
  });

  it("bugs が 8 件あること", () => {
    expect(ruleSet.bugs).toHaveLength(8);
  });

  it("phases が 3 件あること (normal / showdown / raid)", () => {
    const ids = ruleSet.phases.map(p => p.id);
    expect(ids).toContain("normal");
    expect(ids).toContain("showdown");
    expect(ids).toContain("raid");
  });

  it("winCondition.winsRequired が 3 であること", () => {
    expect(ruleSet.winCondition.winsRequired).toBe(3);
  });

  it("initialConfig.initialHandSize が 5 であること", () => {
    expect(ruleSet.initialConfig.initialHandSize).toBe(5);
  });

  it("initialConfig.initialHP が 10 であること", () => {
    expect(ruleSet.initialConfig.initialHP).toBe(10);
  });

  it("Aggro strategy が含まれること", () => {
    expect(ruleSet.strategies.some(s => s.id === "Aggro")).toBe(true);
  });

  it("Control-Add strategy が含まれること", () => {
    expect(ruleSet.strategies.some(s => s.id === "Control-Add")).toBe(true);
  });

  it("Value-Corruption bug が含まれること", () => {
    expect(ruleSet.bugs.some(b => b.id === "Value-Corruption")).toBe(true);
  });

  it("Control-Forbidden が Control系4戦略すべてを strategy_match で宣言すること（D8）", () => {
    const bug = ruleSet.bugs.find(b => b.id === "Control-Forbidden")!;
    expect(bug).toBeDefined();
    expect(bug.effect.action.type).toBe("invalidate_strategy");
    const matched = (bug.effect.constraints ?? [])
      .filter(c => c.type === "strategy_match")
      .map(c => (c as { strategyId: string }).strategyId);
    expect(matched).toEqual(
      expect.arrayContaining(["Control-Add", "Control-Sub", "Control-Mul", "Control-Div"]),
    );
    expect(matched).toHaveLength(4);
  });

  it("Odd-Forbidden bug が含まれること", () => {
    expect(ruleSet.bugs.some(b => b.id === "Odd-Forbidden")).toBe(true);
  });

  it("normal phase が deck_empty → showdown の遷移条件を持つこと", () => {
    const normal = ruleSet.phases.find(p => p.id === "normal")!;
    const cond = normal.transitionConditions.find(c => c.type === "deck_empty");
    expect(cond).toBeDefined();
    expect((cond as any).to).toBe("showdown");
  });

  it("deck に 0〜9 の値が含まれること", () => {
    const values = ruleSet.deck.cards.map(c => c.value);
    for (let v = 0; v <= 9; v++) {
      expect(values).toContain(v);
    }
  });
});
