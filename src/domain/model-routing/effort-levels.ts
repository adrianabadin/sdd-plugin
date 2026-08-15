/**
 * Normalize a model's actual OpenCode variant keys onto the canonical
 * three-level effort vocabulary the dispatcher uses: `low`, `medium`, `high`.
 *
 * Ranking (ascending effort):
 *   none < minimal < low < medium < high < xhigh < max
 *
 * Mapping rules:
 *   0 or 1 usable keys -> {}                                  (no levels)
 *   2 keys              -> { low: first, high: last }         (lowest / highest)
 *   3+ keys             -> { low, medium, high }              (first / middle / last)
 *
 * Unknown keys (e.g. "turbo") are ignored, never crashed on.
 * The mapped values are the model's actual variant keys; they are what
 * the generator writes into each agent's `variant:` frontmatter field.
 */

export type NormalizedEffortLevel = "low" | "medium" | "high";
export const NORMALIZED_LEVELS: ReadonlyArray<NormalizedEffortLevel> = ["low", "medium", "high"];

const EFFORT_RANK: Readonly<Record<string, number>> = {
  none: 0,
  minimal: 1,
  low: 2,
  medium: 3,
  high: 4,
  xhigh: 5,
  max: 6,
};

export interface EffortLevelMapping {
  readonly low: string;
  readonly medium?: string;
  readonly high: string;
}

/** Rank known keys ascending; ignore unknown keys. */
function rankKeys(variantKeys: ReadonlyArray<string>): string[] {
  const ranked: Array<{ key: string; rank: number }> = [];
  for (const key of variantKeys) {
    const r = EFFORT_RANK[key];
    if (typeof r === "number") ranked.push({ key, rank: r });
  }
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map((e) => e.key);
}

/**
 * 0 or 1 usable keys -> {} (no levels).
 * 2 keys              -> { low: first, high: last }.
 * 3+ keys             -> { low: first, medium: middle-most, high: last }.
 */
export function normalizeEffortLevels(
  variantKeys: ReadonlyArray<string>,
): Partial<EffortLevelMapping> {
  const ranked = rankKeys(variantKeys);
  if (ranked.length < 2) return {};
  const first = ranked[0]!;
  const last = ranked[ranked.length - 1]!;
  if (ranked.length === 2) {
    return { low: first, high: last };
  }
  const middle = ranked[Math.floor(ranked.length / 2)]!;
  return { low: first, medium: middle, high: last };
}

/**
 * Nearest available level when the requested one is not exposed.
 * The "distance" is the absolute difference in the ranked-effort scale,
 * restricted to the levels that ARE exposed by the model. Returns
 * `null` if the model has no levels at all.
 *
 * Tie-breaking: when the requested level sits exactly between two
 * exposed levels (e.g. `medium` with only `low` and `high` exposed),
 * the higher level wins — the dispatch prefers the more capable
 * variant when the operator did not specify.
 */
export function nearestLevel(
  requested: NormalizedEffortLevel,
  mapping: Partial<EffortLevelMapping>,
): NormalizedEffortLevel | null {
  if (mapping[requested]) return requested;
  const exposed: NormalizedEffortLevel[] = [];
  if (mapping.low) exposed.push("low");
  if (mapping.medium) exposed.push("medium");
  if (mapping.high) exposed.push("high");
  if (exposed.length === 0) return null;
  const order: Record<NormalizedEffortLevel, number> = { low: 0, medium: 1, high: 2 };
  const req = order[requested];
  let best: NormalizedEffortLevel = exposed[0]!;
  let bestDist = Math.abs(order[best] - req);
  for (let i = 1; i < exposed.length; i += 1) {
    const cand = exposed[i]!;
    const d = Math.abs(order[cand] - req);
    if (d < bestDist || (d === bestDist && order[cand] > order[best])) {
      best = cand;
      bestDist = d;
    }
  }
  return best;
}

/** True when a model exposes a level for the requested normalized level. */
export function isLevelExposed(
  requested: NormalizedEffortLevel,
  mapping: Partial<EffortLevelMapping>,
): boolean {
  return mapping[requested] !== undefined;
}
