/**
 * RED-first contract tests for `model-route:v1|base|reference` grammar
 * (authoritative design c96148ae-04f9-468f-9ca7-e14456dc1513):
 * 256-byte UTF-8 total; base `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`;
 * reference NFKC-trimmed, 1-160 bytes, no '|' or controls.
 * Non-prefixed inputs return null (legacy pass-through).
 * Malformed reserved prefixes throw ModelRouteGrammarError.
 */

import assert from "node:assert/strict";
import { parseModelRouteGrammar, ModelRouteGrammarError } from "../src/domain/model-routing/model-route-grammar.js";

async function runTests(): Promise<void> {
  console.log("--- model-route grammar (RED-first) ---");

  const happy = parseModelRouteGrammar(
    "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered",
  );
  assert.ok(happy !== null, "valid v1 string parses");
  assert.equal(happy?.version, "v1");
  assert.equal(happy?.base, "sdd-mr-base");
  assert.equal(happy?.reference, "google/antigravity-gemini-3.6-flash-tiered");
  console.log("  pass: valid model-route:v1|base|reference parses");

  for (const legacy of ["task-1", "general-purpose", "plan", "build", "explore", "sdd-apply"]) {
    assert.equal(parseModelRouteGrammar(legacy), null, `legacy "${legacy}" returns null`);
  }
  console.log("  pass: non-prefixed subagent_type returns null (legacy pass-through)");

  function expectGrammarError(input: string, matcher: RegExp, label: string): void {
    let thrown: unknown = null;
    try { parseModelRouteGrammar(input); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof ModelRouteGrammarError, `${label}: throws`);
    if (thrown instanceof ModelRouteGrammarError) {
      assert.match(thrown.message, matcher, `${label}: message matches`);
    }
  }

  // Each shape is a separate assertion — every error code path is exercised.
  const cases: Array<[string, RegExp, string]> = [
    ["model-route:v2|base|ref", /version/, "unknown version v2"],
    ["model-route:foo|base|ref", /version/, "non-numeric unknown version"],
    ["model-route:|base|ref", /version/, "missing version segment"],
    ["model-route:", /version|separator|missing/i, "empty reserved prefix"],
    ["model-route:v1|base", /separator|reference|missing/i, "only one '|'"],
    ["model-route:v1|base|ref|extra", /separator/, "extra '|'"],
    ["model-route:v1|a|b|c", /separator/, "three pipes"],
    ["model-route:v1||reference", /base/, "empty base"],
    ["model-route:v1|base|", /reference/, "empty reference"],
    ["model-route:v1|base|   ", /reference/, "whitespace-only reference"],
    ["model-route:v1|-leading|ref", /base/, "base starts with dash"],
    ["model-route:v1|!bang|ref", /base/, "base starts with punctuation"],
    [`model-route:v1|${"a" + "x".repeat(65)}|ref`, /base/, "base exceeds 64 chars"],
    [`model-route:v1|base|${"x".repeat(161)}`, /reference/, "reference exceeds 160 bytes"],
    ["model-route:v1|base|re\x00f", /reference|control/i, "NUL control"],
    ["model-route:v1|base|re\x7ff", /reference|control/i, "DEL control"],
    [`model-route:v1|base|${"x".repeat(245)}`, /byte|limit|256/i, "input exceeds 256 bytes"],
  ];
  for (const [input, matcher, label] of cases) {
    expectGrammarError(input, matcher, label);
  }
  console.log("  pass: malformed reserved prefixes throw ModelRouteGrammarError");

  assert.equal(
    parseModelRouteGrammar("model-route:v1|base|\uFB01nal-check")?.reference,
    "final-check",
    "NFKC normalizes compatibility ligature ﬁ -> fi",
  );
  assert.equal(
    parseModelRouteGrammar("model-route:v1|base|   google/gemini-1.5-pro   ")?.reference,
    "google/gemini-1.5-pro",
    "leading/trailing whitespace stripped from reference after NFKC",
  );
  console.log("  pass: reference is NFKC-normalized and trimmed");

  console.log("✅ All model-route grammar tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });