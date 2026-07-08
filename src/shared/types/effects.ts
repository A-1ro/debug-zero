import type { Game, GamePatch, PlayerId, FieldCard } from "./domain";
import type { RuleSet } from "./rules";

export type { Game, GamePatch };

export interface EffectContext {
  actorId:      PlayerId;
  triggerCard?: FieldCard;
  targetId?:    PlayerId | "boss";
  ruleSet:      RuleSet;
  /**
   * setNumber as it was BEFORE the trigger card's operation was applied.
   * Handlers that undo/redo the trigger card's arithmetic must prefer this
   * over reverse-computing from the current setNumber — div uses Math.ceil
   * and cannot be reversed exactly (D4).
   */
  setNumberBefore?: number;
}

export type EffectHandler = (game: Game, ctx: EffectContext) => GamePatch;
