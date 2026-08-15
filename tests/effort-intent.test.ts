/**
 * RED — Natural-intent parser extended to extract an effort level.
 *
 * Triggers (case- and diacritic-insensitive over the existing NFKC + Spanish-fold view):
 *   - "esfuerzo <level>"
 *   - "con esfuerzo <level>"
 *   - "effort <level>"
 * Allowed levels: low | medium | high. Anything else -> EFFORT_LEVEL_UNKNOWN.
 *
 * Effort is OPTIONAL. No trigger span + no model trigger -> legacy passthrough (null).
 * Effort-only phrase with no model trigger -> also no routing (effort does not pair alone).
 * Order of triggers in the prompt is irrelevant.
 * Original prompt bytes are NEVER mutated.
 */

import assert from "node:assert/strict";

import {
  parseNaturalModelIntent,
  EffortLevelUnknownError,
} from "../src/domain/model-routing/natural-model-intent.js";

async function run(): Promise<void> {
  console.log("--- effort intent parser (RED) ---");

  // 1) model + effort trigger: returned.
  {
    const out = parseNaturalModelIntent("usando opus 5 con esfuerzo high");
    assert.ok(out !== null, "parser returns a value when both model and effort trigger");
    assert.equal(out!.rawReference, "opus 5", "model reference is extracted");
    assert.equal(out!.effort, "high", "effort is extracted");
    console.log("  pass: model + esfuerzo high -> { rawReference, effort: high }");
  }

  // 2) model only, no effort -> default low.
  {
    const out = parseNaturalModelIntent("usando glm 5.2");
    assert.ok(out !== null, "parser returns a value when only a model trigger is present");
    assert.equal(out!.rawReference, "glm 5.2", "model reference is extracted");
    assert.equal(out!.effort, "low", "effort defaults to low when no effort trigger");
    console.log("  pass: model only -> effort defaults to low");
  }

  // 3) effort word not in the canonical levels -> EFFORT_LEVEL_UNKNOWN.
  {
    assert.throws(
      () => parseNaturalModelIntent("usando opus con esfuerzo máximo"),
      (err: unknown) => err instanceof EffortLevelUnknownError,
      "esfuerzo máximo (maximo) is not a canonical level and raises",
    );
    console.log("  pass: esfuerzo máximo -> EFFORT_LEVEL_UNKNOWN");
  }

  // 4) effort before model trigger: order-independent.
  {
    const out = parseNaturalModelIntent("effort medium usando terra");
    assert.ok(out !== null, "parser returns a value when effort precedes the model trigger");
    assert.equal(out!.rawReference, "terra", "model reference is extracted regardless of order");
    assert.equal(out!.effort, "medium", "effort is extracted regardless of order");
    console.log("  pass: effort medium usando terra -> { rawReference: 'terra', effort: 'medium' }");
  }

  // 5) effort-only phrase, no model trigger -> no routing (null).
  {
    const out = parseNaturalModelIntent("con esfuerzo high");
    assert.equal(out, null, "effort without a model trigger does not produce routing intent");
    console.log("  pass: bare effort phrase -> null (no routing)");
  }

  // 6) original prompt bytes are untouched.
  {
    const original = "usando opus 5 con esfuerzo high";
    const snapshot = original.slice();
    parseNaturalModelIntent(original);
    assert.equal(original, snapshot, "parser does not mutate the input string");
    console.log("  pass: original prompt bytes are untouched");
  }

  console.log("All effort-intent assertions passed!");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
