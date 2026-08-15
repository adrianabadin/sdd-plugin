/**
 * Per-call skill resolver bound to a project's OWN persisted init config
 * (design scenario 2).
 *
 * This is the production replacement for the markdown skill registry. The
 * registry resolved against a machine-local, gitignored `.atl/skill-registry.md`
 * written by a binary outside this repository — a file a fresh clone never has,
 * in a format nobody declares. The skill map now lives where every other
 * project fact already lives: the init checkpoint at `sdd-init/{hash}`, written
 * through `sdd_save_config` and validated there before it is ever persisted.
 *
 * The factory is deliberately NOT bound to a project at construction time. It
 * returns a function that `buildSddTools` invokes with the per-call
 * `args.projectRoot` on every compose (W-N1), and it reads that root's
 * checkpoint on every invocation. Two consequences, both load-bearing:
 *
 *   - one tool surface serving two project roots resolves each against its own
 *     config, with no cross-root leakage — a startup capture or a memoized
 *     first-root config would make a prompt claim the executor should load
 *     skill files belonging to a different project;
 *   - editing the config takes effect on the next compose, with no restart.
 *
 * Reading the checkpoint is async, so the returned factory is async — the tool
 * awaits it before composing. The resolver it produces is synchronous, which
 * is what `composePhasePrompt` requires.
 */
import { canonicalizeProjectRoot } from "../../domain/sdd/project-identity.js";
import { initConfigKey } from "../../domain/sdd/sdd-keys.js";
import type { SkillPathMap, SkillResolver } from "../../domain/sdd/skill-resolution.js";
import type { SddArtifactStorePort } from "../../ports/sdd-artifact-store.port.js";
import { createConfiguredSkillResolver } from "./configured-skill-resolver.adapter.js";

/** The `ProjectConfig` field the map is persisted under. */
const SKILL_PATHS_FIELD = "skillPaths";

/**
 * Reported as the attempt's `source`, so `UnresolvableSkillError` says WHICH
 * config was read rather than the bare "configured".
 */
const PROJECT_CONFIG_SOURCE = "project-config";

/**
 * Lifts `skillPaths` out of a persisted config record.
 *
 * `mergeConfig` validates the map before it can be persisted, so a config
 * written through `sdd_save_config` always holds string values. A hand-edited
 * checkpoint could still hold something else; a non-string entry is DROPPED
 * rather than coerced, because coercion would manufacture a path the operator
 * never wrote and then report it as `missing` — a diagnosis about a value that
 * does not exist. Dropped entries surface as `name-absent` against a lookup key
 * that names the exact checkpoint field to inspect.
 */
function readSkillPaths(content: unknown): SkillPathMap {
  if (typeof content !== "object" || content === null) return {};
  const raw = (content as Record<string, unknown>)[SKILL_PATHS_FIELD];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "",
    ),
  );
}

/**
 * Reads a root's persisted `skillPaths` map, or `{}` when the root has no init
 * checkpoint at all. Exported because the startup readiness signal
 * (`checkSkillResolutionReadiness`) has to inspect exactly the same map the
 * per-call resolver will consult — deriving it twice is how the two drift and
 * the startup log starts describing a config nobody resolves against.
 */
export async function readProjectConfigSkillPaths(
  store: Pick<SddArtifactStorePort, "readCheckpoint">,
  projectRoot: string,
): Promise<SkillPathMap> {
  const record = await store.readCheckpoint(
    initConfigKey(canonicalizeProjectRoot(projectRoot).projectRootHash),
  );
  return readSkillPaths(record?.content);
}

/**
 * Reported as the `source` for the per-call injected map. Not the generic
 * `injected`: when this entry is the one that failed, the repair is to fix the
 * ORCHESTRATOR'S CALL, not any file on disk — and an operator grepping their
 * config for a path that was never in it wastes the whole diagnosis.
 */
const ORCHESTRATOR_INJECTION_SOURCE = "orchestrator-injection";

export function createProjectConfigSkillResolverFactory(
  store: Pick<SddArtifactStorePort, "readCheckpoint">,
): (projectRoot: string, injected?: SkillPathMap | null) => Promise<SkillResolver> {
  return async (projectRoot: string, injected?: SkillPathMap | null): Promise<SkillResolver> => {
    const configKey = initConfigKey(canonicalizeProjectRoot(projectRoot).projectRootHash);
    return createConfiguredSkillResolver({
      projectRoot,
      // Per-call injection outranks the persisted config, and a BAD injection
      // is a hard stop inside the adapter — the config is not consulted as a
      // fallback, because resolving to a file the caller explicitly overrode
      // would make the composed prompt lie about what it told the executor to
      // load.
      injected: injected ?? null,
      injectedSource: ORCHESTRATOR_INJECTION_SOURCE,
      configured: await readProjectConfigSkillPaths(store, projectRoot),
      // Qualifying the lookup key with the checkpoint key is what makes the
      // failure actionable across roots: `sdd-init/<hash>.skillPaths.<skill>`
      // names the exact record and field to edit, not just a field name that
      // every project shares.
      configKey: `${configKey}.${SKILL_PATHS_FIELD}`,
      configSource: PROJECT_CONFIG_SOURCE,
    });
  };
}
