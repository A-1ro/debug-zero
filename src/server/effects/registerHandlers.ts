import type { EffectRegistry } from "./EffectRegistry";

// Strategy handlers
import { aggro }       from "./handlers/strategies/aggro";
import { controlAdd }  from "./handlers/strategies/controlAdd";
import { controlSub }  from "./handlers/strategies/controlSub";
import { controlMul }  from "./handlers/strategies/controlMul";
import { controlDiv }  from "./handlers/strategies/controlDiv";
import { hack }        from "./handlers/strategies/hack";
import { trickStar }   from "./handlers/strategies/trickStar";
import { zero }        from "./handlers/strategies/zero";

// Bug handlers
import { oddForbidden }       from "./handlers/bugs/oddForbidden";
import { evenForbidden }      from "./handlers/bugs/evenForbidden";
import { stackForbidden }     from "./handlers/bugs/stackForbidden";
import { aggroForbidden }     from "./handlers/bugs/aggroForbidden";
import { controlForbidden }   from "./handlers/bugs/controlForbidden";
import { hackForbidden }      from "./handlers/bugs/hackForbidden";
import { trickStarForbidden } from "./handlers/bugs/trickStarForbidden";
import { valueCorruption }    from "./handlers/bugs/valueCorruption";

/**
 * Register all effect handlers with the provided EffectRegistry.
 *
 * Effect ID naming convention: "{ruleSetId}:{camelCaseEffectName}"
 * (detail-design.md §8.2)
 *
 * Call this once at startup before any game action is processed.
 * To add a new handler: implement it in handlers/ and add one register() call here.
 */
export function registerAllHandlers(registry: EffectRegistry): void {
  // ── Strategy handlers ────────────────────────────────────────
  registry.register("basic:aggro",      aggro);
  registry.register("basic:controlAdd", controlAdd);
  registry.register("basic:controlSub", controlSub);
  registry.register("basic:controlMul", controlMul);
  registry.register("basic:controlDiv", controlDiv);
  registry.register("basic:hack",       hack);
  registry.register("basic:trickStar",  trickStar);
  registry.register("basic:zero",       zero);

  // ── Bug handlers ─────────────────────────────────────────────
  registry.register("basic:oddForbidden",       oddForbidden);
  registry.register("basic:evenForbidden",      evenForbidden);
  registry.register("basic:stackForbidden",     stackForbidden);
  registry.register("basic:aggroForbidden",     aggroForbidden);
  registry.register("basic:controlForbidden",   controlForbidden);
  registry.register("basic:hackForbidden",      hackForbidden);
  registry.register("basic:trickStarForbidden", trickStarForbidden);
  registry.register("basic:valueCorruption",    valueCorruption);
}
