import { load as yamlLoad } from "js-yaml";
import type { RuleSet, StrategyDef, BugDef, PhaseDef, DeckConfig, WinConditionDef, InitialConfig, EffectDef, TriggerCondition, TargetDef, EffectAction, ConstraintDef, RemovalCost, ExclusionCondition, TransitionCondition } from "../../shared/types/rules";
import { RULE_VALIDATION_FAILED, RULE_NOT_FOUND } from "../../shared/constants";
import { globalRuleSetRegistry } from "./RuleSetRegistry";

// ============================================================
// Validation helpers
// ============================================================

const VALID_TRIGGER_TYPES = new Set([
  "on_card_played",
  "on_card_played_by_other",
  "on_game_start",
  "on_round_start",
  "on_turn_start",
  "always",
]);

const VALID_ACTION_TYPES = new Set([
  "multiply_effective_value",
  "change_operation",
  "steal_card",
  "remove_field_card",
  "add_card_to_hand",
  "invalidate_strategy",
  "forbid_card_parity",
  "forbid_stack",
  "override_card_value",
]);

function validationError(msg: string): never {
  throw Object.assign(new Error(msg), { code: RULE_VALIDATION_FAILED });
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    validationError(`${field} must be a non-empty string`);
  }
  return value as string;
}

function assertPositiveInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    validationError(`${field} must be a positive integer`);
  }
  return value as number;
}

// ============================================================
// Parsing helpers
// ============================================================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Raw = any;

function parseEffectDef(raw: Raw, ruleSetId: string): EffectDef {
  const id = assertString(raw?.id, "effect.id");
  const expectedPrefix = `${ruleSetId}:`;
  if (!id.startsWith(expectedPrefix)) {
    validationError(`effect.id must follow "{ruleSetId}:{camelCase}" format, got: ${id}`);
  }

  const triggerType = raw?.trigger?.type as string;
  if (!VALID_TRIGGER_TYPES.has(triggerType)) {
    validationError(`Unknown trigger.type: ${triggerType}`);
  }

  const actionType = raw?.action?.type as string;
  if (!VALID_ACTION_TYPES.has(actionType)) {
    validationError(`Unknown action.type: ${actionType}`);
  }

  const constraints: ConstraintDef[] = [];
  if (Array.isArray(raw?.constraints)) {
    for (const c of raw.constraints) {
      constraints.push(c as ConstraintDef);
    }
  }

  return {
    id,
    trigger: raw.trigger as TriggerCondition,
    target: raw.target as TargetDef,
    action: raw.action as EffectAction,
    constraints: constraints.length > 0 ? constraints : undefined,
    usageLimit: raw.usageLimit ?? undefined,
  };
}

function parseDeck(raw: Raw): DeckConfig {
  if (!Array.isArray(raw?.cards)) {
    validationError("deck.cards must be an array");
  }
  for (const entry of raw.cards) {
    const v = entry?.value;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 9) {
      validationError(`deck.cards[].value must be integer 0–9, got: ${v}`);
    }
    if (typeof entry?.count !== "number" || entry.count < 1) {
      validationError("deck.cards[].count must be >= 1");
    }
  }
  return raw as DeckConfig;
}

function parseStrategies(raw: Raw, ruleSetId: string): StrategyDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((s: Raw) => {
    const def: StrategyDef = {
      id: assertString(s?.id, "strategy.id"),
      effect: parseEffectDef(s?.effect, ruleSetId),
    };
    if (s?.exclusionCondition != null) {
      def.exclusionCondition = s.exclusionCondition as ExclusionCondition;
    }
    return def;
  });
}

function parseBugs(raw: Raw, ruleSetId: string): BugDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((b: Raw) => ({
    id: assertString(b?.id, "bug.id"),
    effect: parseEffectDef(b?.effect, ruleSetId),
    removalCost: b?.removalCost as RemovalCost,
  }));
}

function parsePhases(raw: Raw): PhaseDef[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((p: Raw) => ({
    id: p?.id,
    transitionConditions: Array.isArray(p?.transitionConditions)
      ? (p.transitionConditions as TransitionCondition[])
      : [],
  }));
}

function parseWinCondition(raw: Raw): WinConditionDef {
  return { winsRequired: assertPositiveInt(raw?.winsRequired, "winCondition.winsRequired") };
}

function parseInitialConfig(raw: Raw): InitialConfig {
  return {
    recommendedPlayers: assertPositiveInt(raw?.recommendedPlayers, "initialConfig.recommendedPlayers"),
    initialHandSize:    assertPositiveInt(raw?.initialHandSize,    "initialConfig.initialHandSize"),
    initialHP:          assertPositiveInt(raw?.initialHP,          "initialConfig.initialHP"),
    setNumberFormula:   assertString(raw?.setNumberFormula,        "initialConfig.setNumberFormula"),
  };
}

// ============================================================
// merge helper (for extends)
// ============================================================

function mergeRuleSets(base: RuleSet, override: Partial<RuleSet> & { id: string; version: string }): RuleSet {
  const merged: RuleSet = { ...base, ...override };

  // Merge arrays by id
  if (override.strategies) {
    const map = new Map(base.strategies.map((s) => [s.id, s]));
    for (const s of override.strategies) {
      map.set(s.id, s);
    }
    merged.strategies = Array.from(map.values());
  }

  if (override.bugs) {
    const map = new Map(base.bugs.map((b) => [b.id, b]));
    for (const b of override.bugs) {
      map.set(b.id, b);
    }
    merged.bugs = Array.from(map.values());
  }

  if (override.phases) {
    const map = new Map(base.phases.map((p) => [p.id, p]));
    for (const p of override.phases) {
      map.set(p.id, p);
    }
    merged.phases = Array.from(map.values());
  }

  return merged;
}

// ============================================================
// RuleSetLoader
// ============================================================

export class RuleSetLoader {
  /**
   * Parse a YAML string and register the RuleSet into globalRuleSetRegistry.
   * Throws with { code: RULE_VALIDATION_FAILED } on schema errors.
   */
  static loadFromYaml(yamlText: string): RuleSet {
    const raw = yamlLoad(yamlText) as Raw;

    const id = assertString(raw?.id, "id");
    const version = assertString(raw?.version, "version");

    let ruleSet: RuleSet = {
      id,
      version,
      deck:          parseDeck(raw?.deck),
      strategies:    parseStrategies(raw?.strategies ?? [], id),
      bugs:          parseBugs(raw?.bugs ?? [], id),
      phases:        parsePhases(raw?.phases ?? []),
      winCondition:  parseWinCondition(raw?.winCondition),
      initialConfig: parseInitialConfig(raw?.initialConfig),
    };

    // Handle extends
    if (raw?.extends != null) {
      const parentId = assertString(raw.extends, "extends");
      if (!globalRuleSetRegistry.has(parentId)) {
        throw Object.assign(new Error(`extends references unknown ruleSetId: ${parentId}`), {
          code: RULE_NOT_FOUND,
        });
      }
      const parent = globalRuleSetRegistry.get(parentId);
      ruleSet = mergeRuleSets(parent, ruleSet);
    }

    globalRuleSetRegistry.register(ruleSet);
    return ruleSet;
  }
}
