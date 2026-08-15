/**
 * Skill resolution primitives (design scenario 3).
 *
 * A mapped skill name becomes a readable absolute path, or it becomes a
 * DIAGNOSIS. There is no third outcome and there is never a fabricated path:
 * `composePhasePrompt` turns a null into `UnresolvableSkillError` (PC-6), and
 * the attempts recorded here are what make that failure actionable.
 *
 * The three reasons are deliberately distinct — collapsing them is how an
 * operator ends up bisecting config by hand:
 *   - `name-absent` — the source never mapped this name. Fix the map.
 *   - `missing`     — the source mapped it, nothing exists there. Fix the path
 *                     or install the skill.
 *   - `unreadable`  — the source mapped it and something IS there, but it is
 *                     not a readable file (a directory, a relative path, an
 *                     access failure). Fix what the path points at.
 */

/** A declared source's `skill name -> absolute SKILL.md path` mapping. */
export type SkillPathMap = Readonly<Record<string, string>>;

export type ResolutionReason = "name-absent" | "missing" | "unreadable";

/**
 * One source's verdict for one skill name.
 *
 * `path` is present exactly when the source mapped the name — its absence is
 * itself information ("we never had a path to try"), so it is omitted rather
 * than set to a placeholder. `detail` explains a `missing`/`unreadable`
 * verdict (an errno, or why the path was rejected outright).
 */
export interface SkillResolutionAttempt {
  /** Which declared source was consulted, e.g. `injected` or `configured`. */
  readonly source: string;
  /** The key this source was asked for — qualified when the source is namespaced. */
  readonly lookupKey: string;
  /** The path this source mapped the name to; omitted when it mapped nothing. */
  readonly path?: string;
  readonly reason: ResolutionReason;
  /** Why a mapped path was rejected; omitted for `name-absent`. */
  readonly detail?: string;
}

/**
 * Resolves a skill name to a readable absolute path, or null.
 *
 * `attempts(skillName)` re-runs the same walk and reports what each consulted
 * source said, in precedence order. It is a pure query of the resolver's own
 * declared sources — never a snapshot of the last call — so a caller can ask
 * for the diagnosis of a specific failed name without racing other resolutions.
 */
export type SkillResolver = ((skillName: string) => string | null) & {
  readonly attempts: (skillName: string) => readonly SkillResolutionAttempt[];
};
