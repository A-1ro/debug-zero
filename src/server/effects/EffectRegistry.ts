import type { EffectId } from "../../shared/types/domain";
import type { EffectHandler } from "../../shared/types/effects";

/**
 * Registry that maps EffectIds to their handler functions.
 * New handlers are added by calling register() — no other code needs to change.
 */
export class EffectRegistry {
  private readonly handlers: Map<EffectId, EffectHandler> = new Map();

  register(effectId: EffectId, handler: EffectHandler): void {
    this.handlers.set(effectId, handler);
  }

  get(effectId: EffectId): EffectHandler | undefined {
    return this.handlers.get(effectId);
  }

  has(effectId: EffectId): boolean {
    return this.handlers.has(effectId);
  }
}
