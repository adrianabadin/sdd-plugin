/**
 * RED — `normalizeEffortLevels` maps a model's actual variant keys
 * onto the canonical low / medium / high levels the dispatcher uses.
 *
 *   0 or 1 keys  -> {} (no levels)
 *   2 keys       -> { low, high }            (lowest / highest)
 *   3+ keys      -> { low, medium, high }    (middle-most of the ranked list)
 * Unknown keys are ignored, never crashed on.
 */

import assert from "node:assert/strict";

import { normalizeEffortLevels } from "../src/domain/model-routing/effort-levels.js";

async function run(): Promise<void> {
  console.log("--- effort normalization (RED) ---");

  // 0 keys -> no levels.
  assert.deepEqual(normalizeEffortLevels([]), {}, "empty input yields no levels");

  // 2 keys -> low/high.
  assert.deepEqual(
    normalizeEffortLevels(["high", "max"]),
    { low: "high", high: "max" },
    "2 keys map to lowest/highest",
  );

  // 5 keys -> middle is index 2.
  assert.deepEqual(
    normalizeEffortLevels(["minimal", "low", "medium", "high", "xhigh"]),
    { low: "minimal", medium: "medium", high: "xhigh" },
    "5 keys map to first/middle/last of ranked list",
  );

  // 3 keys -> identity mapping.
  assert.deepEqual(
    normalizeEffortLevels(["low", "medium", "high"]),
    { low: "low", medium: "medium", high: "high" },
    "3 canonical keys map identity",
  );

  // 3 keys with non-canonical ordering.
  assert.deepEqual(
    normalizeEffortLevels(["none", "minimal", "low"]),
    { low: "none", medium: "minimal", high: "low" },
    "non-canonical 3 keys map to lowest/middle/highest of the ranking",
  );

  // Unknown keys are ignored, not crashed on. With only one known key left
  // the result is "no levels" (1-key rule).
  assert.deepEqual(
    normalizeEffortLevels(["turbo", "ultra", "high"]),
    {},
    "unknown keys are ignored; one known key left -> no levels",
  );

  // Mix of unknown and known that lands at 2 levels.
  assert.deepEqual(
    normalizeEffortLevels(["turbo", "low", "high", "ultra"]),
    { low: "low", high: "high" },
    "unknown keys are filtered, remaining keys are ranked",
  );

  // Determinism: same input -> same output.
  const a = normalizeEffortLevels(["minimal", "low", "medium", "high", "xhigh"]);
  const b = normalizeEffortLevels(["minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(a, b, "normalizeEffortLevels is deterministic");

  console.log("  pass: 7 cases of normalizeEffortLevels contract");
  console.log("All effort-normalization assertions passed!");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
