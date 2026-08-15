/**
 * Filesystem-validating skill resolver over DECLARED sources (design scenario 3).
 *
 * Two sources, consulted in this order:
 *   1. `injected`   — an in-process map. A caller that injects a path is
 *                     stating intent about which file to load.
 *   2. `configured` — the map lifted out of the project config; `configKey`
 *                     names the config field it came from, so a failure message
 *                     points at the field the operator has to edit.
 *
 * PRECEDENCE IS A HARD STOP, not a fallback chain. If `injected` maps the name
 * but the path fails validation, resolution returns null immediately and
 * `configured` is never consulted: silently loading a DIFFERENT skill file than
 * the one the caller injected would make the prompt lie about what it loaded.
 * `configured` is only reached when `injected` mapped nothing at all.
 *
 * Validation is deliberately strict — absolute, `statSync().isFile()`, and
 * readable — because the path is inlined into a prompt as a "load this before
 * you work" instruction. A relative path is rejected outright rather than
 * resolved against `projectRoot`: the skill files live outside the repo (user
 * config dirs), so guessing a base would manufacture paths that happen not to
 * exist and report them as `missing`, which is a lie about what was declared.
 *
 * The file is stat'ed on every call rather than cached: mapped skills per phase
 * are few (at most two today), and installing a skill should not require a
 * plugin restart to take effect.
 */
import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

import type {
  SkillPathMap,
  SkillResolutionAttempt,
  SkillResolver,
} from "../../domain/sdd/skill-resolution.js";

export interface ConfiguredSkillResolverOptions {
  /** Diagnostic context: named in the rejection detail for a relative path. */
  readonly projectRoot: string;
  /** In-process overrides; consulted first. */
  readonly injected?: SkillPathMap | null;
  /** The skill map lifted out of the project config. */
  readonly configured?: SkillPathMap | null;
  /** The config field `configured` came from; qualifies its lookup keys. */
  readonly configKey?: string;
  /**
   * The label reported as `source` for the `configured` map. Defaults to the
   * generic `configured`; a caller that knows WHERE the map came from should
   * say so (e.g. `project-config`), because "edit your config" is only
   * actionable once the operator knows which config was read.
   */
  readonly configSource?: string;
}

const DEFAULT_CONFIG_KEY = "skillPaths";
const DEFAULT_CONFIG_SOURCE = "configured";

/** A source that failed; `null` means the candidate path validated. */
function validate(candidate: string, projectRoot: string): { reason: "missing" | "unreadable"; detail: string } | null {
  if (!path.isAbsolute(candidate)) {
    return {
      reason: "unreadable",
      detail: `path is not absolute; skill paths are never resolved relative to the project root (${projectRoot})`,
    };
  }
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(candidate);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT is the one case where nothing is there at all. Everything else
    // (EACCES, ELOOP, ENOTDIR, ...) means something is there and we cannot use
    // it — a different fix for the operator, so a different reason.
    return code === "ENOENT"
      ? { reason: "missing", detail: "ENOENT" }
      : { reason: "unreadable", detail: code ?? String(err) };
  }
  if (!stats.isFile()) {
    return { reason: "unreadable", detail: "path exists but is not a file" };
  }
  try {
    accessSync(candidate, constants.R_OK);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { reason: "unreadable", detail: `not readable${code !== undefined ? ` (${code})` : ""}` };
  }
  return null;
}

export function createConfiguredSkillResolver(options: ConfiguredSkillResolverOptions): SkillResolver {
  const {
    projectRoot,
    injected,
    configured,
    configKey = DEFAULT_CONFIG_KEY,
    configSource = DEFAULT_CONFIG_SOURCE,
  } = options;

  const sources: readonly { readonly source: string; readonly map: SkillPathMap; readonly qualify: (name: string) => string }[] = [
    { source: "injected", map: injected ?? {}, qualify: (name) => name },
    { source: configSource, map: configured ?? {}, qualify: (name) => `${configKey}.${name}` },
  ];

  /**
   * Single walk shared by the callable and by `attempts()`, so the diagnosis a
   * caller reads can never drift from the decision the resolver actually made.
   */
  function walk(skillName: string): { readonly resolved: string | null; readonly attempts: SkillResolutionAttempt[] } {
    const attempts: SkillResolutionAttempt[] = [];
    for (const { source, map, qualify } of sources) {
      const lookupKey = qualify(skillName);
      const candidate = Object.prototype.hasOwnProperty.call(map, skillName) ? map[skillName] : undefined;
      if (candidate === undefined || candidate === "") {
        attempts.push({ source, lookupKey, reason: "name-absent" });
        continue;
      }
      const failure = validate(candidate, projectRoot);
      if (failure === null) return { resolved: candidate, attempts };
      // Hard stop: this source DECLARED a path and it is bad. Falling through
      // to a lower-precedence source would resolve to a file nobody asked for.
      attempts.push({ source, lookupKey, path: candidate, reason: failure.reason, detail: failure.detail });
      return { resolved: null, attempts };
    }
    return { resolved: null, attempts };
  }

  return Object.assign((skillName: string): string | null => walk(skillName).resolved, {
    attempts: (skillName: string): readonly SkillResolutionAttempt[] => walk(skillName).attempts,
  });
}
