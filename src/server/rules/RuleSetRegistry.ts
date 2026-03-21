import type { RuleSet, RuleSetId } from "../../shared/types/rules";
import { RULE_NOT_FOUND } from "../../shared/constants";

export class RuleSetRegistry {
  private readonly store = new Map<RuleSetId, RuleSet>();

  register(ruleSet: RuleSet): void {
    this.store.set(ruleSet.id, ruleSet);
  }

  get(id: RuleSetId): RuleSet {
    const ruleSet = this.store.get(id);
    if (!ruleSet) {
      throw Object.assign(new Error(`RuleSet not found: ${id}`), { code: RULE_NOT_FOUND });
    }
    return ruleSet;
  }

  has(id: RuleSetId): boolean {
    return this.store.has(id);
  }

  all(): RuleSet[] {
    return Array.from(this.store.values());
  }
}

export const globalRuleSetRegistry = new RuleSetRegistry();
