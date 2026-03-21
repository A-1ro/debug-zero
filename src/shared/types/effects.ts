import type { Game, GamePatch, PlayerId, FieldCard } from "./domain";
import type { RuleSet } from "./rules";

export type { Game, GamePatch };

export interface EffectContext {
  actorId:      PlayerId;
  triggerCard?: FieldCard;
  targetId?:    PlayerId | "boss";
  ruleSet:      RuleSet;
}

export type EffectHandler = (game: Game, ctx: EffectContext) => GamePatch;
