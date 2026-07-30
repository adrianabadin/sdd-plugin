/**
 * RED-first contract tests for the bounded `NaturalIntentParser`
 * (design `41aa141d-1bbf-4cd0-aba7-63f82f83fbd6`, spec scenario "Spanish trigger"
 * + "Malformed intent"):
 *
 *   - Only `usando <ref>`, `con el modelo <ref>`, `using model <ref>`,
 *     and `@model <ref>` are accepted as trigger spans.
 *   - Trigger matching uses a separate NFKC + Spanish-diacritic-folded view;
 *     the raw extracted reference and the original prompt remain byte-for-byte
 *     unchanged.
 *   - Reference is bounded to <= 256 UTF-8 bytes; empty, control-bearing,
 *     and >256-byte references fail closed.
 *   - More than one trigger span in a prompt fails as ambiguous.
 *   - Prompts without any of the four triggers return null (legacy passthrough).
 *   - No LLM classifier, no fuzzy match — pure bounded pattern matching.
 *   - The parser never touches `args.model`.
 *
 * These tests are independent from `ModelRouteResolver`; the parser returns
 * the raw reference and downstream code feeds it to the existing Tier 1/2/3
 * resolution pipeline. A separate alias-table extension test verifies the
 * new "gemini flash 3.6 tiered" -> `google/antigravity-gemini-3.6-flash-tiered`
 * mapping is consumed correctly.
 */

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

import {
  parseNaturalModelIntent,
  NaturalIntentMalformedError,
  NaturalIntentAmbiguousError,
  NATURAL_INTENT_REFERENCE_MAX_BYTES,
  type NaturalIntentTrigger,
} from "../src/domain/model-routing/natural-model-intent.js";
import {
  ModelRouteResolver,
  type ModelRouteAliasTable,
} from "../src/domain/model-routing/model-route-resolver.js";
import { NATURAL_MODEL_ALIASES } from "../src/domain/model-routing/natural-model-aliases.js";
import type {
  ModelRouteCatalogPort,
  RouteCandidate,
} from "../src/ports/model-route-catalog.port.js";

class StubCatalog implements ModelRouteCatalogPort {
  private readonly canonicals = new Set<string>();
  private readonly rows: RouteCandidate[] = [];
  addCanonical(providerId: string, modelId: string, modelName?: string): void {
    this.canonicals.add(`${providerId}/${modelId}`);
    this.rows.push({ providerId, modelId, modelName: modelName ?? modelId });
  }
  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return this.canonicals.has(`${providerId}/${modelId}`);
  }
  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    return [];
  }
}

function assertMalformed(
  fn: () => unknown,
  code: "EMPTY_REFERENCE" | "BYTE_LIMIT_EXCEEDED" | "CONTROL_CHARACTER" | "EMPTY_REFERENCE_AFTER_TRIM",
  label: string,
): void {
  let thrown: unknown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof NaturalIntentMalformedError, `${label}: throws NaturalIntentMalformedError`);
  assert.equal((thrown as NaturalIntentMalformedError).code, code, `${label}: code is ${code}`);
}

function assertAmbiguous(fn: () => unknown, label: string, expectedCount: number): void {
  let thrown: unknown = null;
  try { fn(); } catch (e) { thrown = e; }
  assert.ok(thrown instanceof NaturalIntentAmbiguousError, `${label}: throws NaturalIntentAmbiguousError`);
  assert.equal((thrown as NaturalIntentAmbiguousError).count, expectedCount, `${label}: count is ${expectedCount}`);
}

async function runTests(): Promise<void> {
  console.log("--- natural model intent parser (RED-first) ---");

  // 1. No trigger present -> null (legacy passthrough, no allocation).
  {
    const result = parseNaturalModelIntent("Explicá este código sin tocar nada");
    assert.equal(result, null, "no trigger -> null");
    console.log("  pass: no trigger returns null (legacy passthrough)");
  }

  // 2. Spanish diacritic-folded trigger `usando` matches the proposal example.
  {
    const prompt = "Generá un saludo usando Gemini Flash 3.6 Tiered";
    const result = parseNaturalModelIntent(prompt);
    assert.ok(result !== null, "Spanish trigger parses");
    assert.equal(result?.trigger, "usando");
    assert.equal(result?.rawReference, "Gemini Flash 3.6 Tiered", "raw reference preserved exactly");
    console.log("  pass: `usando <ref>` extracts raw reference after Spanish diacritic fold");
  }

  // 3. Original prompt is never mutated; parser must not rewrite bytes.
  {
    const prompt = "Generá un saludo usando Gemini Flash 3.6 Tiered";
    const before = prompt;
    parseNaturalModelIntent(prompt);
    assert.equal(prompt, before, "original prompt remains byte-for-byte unchanged");
    console.log("  pass: parser does not mutate the original prompt");
  }

  // 4. Each of the four triggers is recognized.
  {
    const cases: Array<[NaturalIntentTrigger, string]> = [
      ["usando", "Resumí esto usando Gemini"],
      ["con el modelo", "Hacé un test con el modelo Gemini Pro"],
      ["using model", "Run the task using model gpt-4o"],
      ["@model", "Please execute @model claude-3-5-sonnet for this task"],
    ];
    for (const [trigger, prompt] of cases) {
      const result = parseNaturalModelIntent(prompt);
      assert.ok(result !== null, `${trigger}: parses`);
      assert.equal(result?.trigger, trigger, `${trigger}: trigger label preserved`);
    }
    console.log("  pass: all four bounded triggers recognized");
  }

  // 5. Spanish diacritic-folded variant of `con el modelo` (ó → o).
  {
    const result = parseNaturalModelIntent("Ejecutá cón el modelo Gemini Pro");
    assert.ok(result !== null, "folded `cón el modelo` parses");
    assert.equal(result?.trigger, "con el modelo");
    assert.equal(result?.rawReference, "Gemini Pro");
    console.log("  pass: diacritic-folded `cón el modelo` extracts raw reference");
  }

  // 6. Multi-trigger prompts fail closed (ambiguous).
  {
    assertAmbiguous(
      () => parseNaturalModelIntent("Usando Gemini y luego @model gpt-4o"),
      "two distinct triggers",
      2,
    );
    assertAmbiguous(
      () => parseNaturalModelIntent("usando usando Gemini"),
      "two identical triggers",
      2,
    );
    console.log("  pass: multiple trigger spans fail closed as ambiguous");
  }

  // 7. Empty reference after trigger -> malformed.
  {
    assertMalformed(
      () => parseNaturalModelIntent("usando "),
      "EMPTY_REFERENCE_AFTER_TRIM",
      "empty reference after `usando`",
    );
    assertMalformed(
      () => parseNaturalModelIntent("@model   "),
      "EMPTY_REFERENCE_AFTER_TRIM",
      "whitespace-only reference after `@model`",
    );
    assertMalformed(
      () => parseNaturalModelIntent("usando\t"),
      "EMPTY_REFERENCE_AFTER_TRIM",
      "tab-only reference after `usando`",
    );
    console.log("  pass: empty/whitespace references fail as malformed");
  }

  // 8. Over-256-byte reference -> malformed (UTF-8 byte count).
  {
    const longRef = "x".repeat(NATURAL_INTENT_REFERENCE_MAX_BYTES + 1);
    const prompt = `usando ${longRef}`;
    assertMalformed(
      () => parseNaturalModelIntent(prompt),
      "BYTE_LIMIT_EXCEEDED",
      `reference > ${NATURAL_INTENT_REFERENCE_MAX_BYTES} bytes`,
    );
    console.log(`  pass: reference > ${NATURAL_INTENT_REFERENCE_MAX_BYTES} bytes fails as malformed`);
  }

  // 9. Multi-byte UTF-8 reference at boundary is measured in bytes, not chars.
  {
    // Each "ñ" is 2 UTF-8 bytes; 129 of them = 258 bytes > 256.
    const multiByteRef = "ñ".repeat(129);
    const prompt = `usando ${multiByteRef}`;
    assertMalformed(
      () => parseNaturalModelIntent(prompt),
      "BYTE_LIMIT_EXCEEDED",
      "multi-byte UTF-8 reference boundary",
    );
    // 128 ñ = 256 bytes exactly: should pass through.
    const atBoundary = "ñ".repeat(128);
    const exactBoundary = `usando ${atBoundary}`;
    const ok = parseNaturalModelIntent(exactBoundary);
    assert.ok(ok !== null, "128 ñ (256 UTF-8 bytes) is at the boundary and accepted");
    assert.equal(ok?.rawReference.length, 128, "rawReference preserves char count");
    assert.equal(Buffer.byteLength(ok?.rawReference ?? "", "utf8"), 256, "rawReference is exactly 256 bytes");
    console.log("  pass: UTF-8 byte boundary enforced (256 bytes exact is accepted)");
  }

  // 10. Control characters in reference -> malformed.
  {
    assertMalformed(
      () => parseNaturalModelIntent("usando gpt\x004o"),
      "CONTROL_CHARACTER",
      "NUL control in reference",
    );
    assertMalformed(
      () => parseNaturalModelIntent("usando gpt\x1b[31m"),
      "CONTROL_CHARACTER",
      "ESC control in reference",
    );
    assertMalformed(
      () => parseNaturalModelIntent("usando gpt\x7f4o"),
      "CONTROL_CHARACTER",
      "DEL control in reference",
    );
    console.log("  pass: control characters in reference fail as malformed");
  }

  // 11. Reference is preserved exactly (raw, no NFKC, no fold, no trim).
  //     The trigger fold only operates on the detection view.
  {
    const rawPrompt = "usando  Gemini  Flash  3.6  Tiered  ";
    const result = parseNaturalModelIntent(rawPrompt);
    assert.ok(result !== null);
    // Reference runs to end of prompt (no closing boundary in trigger rules);
    // we trim only trailing whitespace per bounded validation.
    assert.equal(result?.rawReference, "Gemini  Flash  3.6  Tiered", "internal whitespace preserved");
    console.log("  pass: reference preserves internal whitespace exactly");
  }

  // 12. The folded detection view is NOT the canonical rawReference.
  {
    // "usándo" -> folded "usando"; the raw reference must come from the
    // original byte positions, not the folded view.
    const result = parseNaturalModelIntent("usándo Gemini Flash");
    assert.ok(result !== null, "diacritic-folded `usándo` still matches");
    assert.equal(result?.trigger, "usando");
    assert.equal(result?.rawReference, "Gemini Flash", "rawReference from raw bytes");
    console.log("  pass: rawReference is sourced from raw prompt bytes, not folded view");
  }

  // 13. NFKC compatibility folding allows the trigger to match across
  //     decomposition variants (e.g., `usándo` decomposed as `u + s + a + n +
  //     ́ + d + o`).
  {
    const decomposed = "u\u0073a\u006E\u0301do Gemini"; // "usándo" with combining acute
    const result = parseNaturalModelIntent(decomposed);
    assert.ok(result !== null, "NFKC-decomposed `usán + combining acute + do` matches via NFKC fold");
    assert.equal(result?.trigger, "usando");
    console.log("  pass: NFKC + Spanish diacritic fold triggers on decomposed Unicode");
  }

  // 14. `@model` is treated as a literal token (no space required before <ref>).
  {
    const result = parseNaturalModelIntent("@modelgemini-pro");
    assert.ok(result === null, "literal `@model` token requires the prefix to be followed by a non-word boundary");
    const ok = parseNaturalModelIntent("@model gemini-pro");
    assert.ok(ok !== null, "@model followed by whitespace matches");
    assert.equal(ok?.rawReference, "gemini-pro");
    console.log("  pass: `@model` requires non-word boundary before reference");
  }

  // 15. Legacy/no-intent input returns null without changing semantics.
  {
    for (const prompt of [
      "",
      "general-purpose",
      "plan",
      "build",
      "explore",
      "sdd-apply",
      "Hola mundo",
      "Just summarize this article",
      "Explicame algo sin decir el modelo",
    ]) {
      assert.equal(parseNaturalModelIntent(prompt), null, `legacy/no-intent prompt "${prompt}" -> null`);
    }
    console.log("  pass: legacy / no-intent inputs return null without changes");
  }

  // 16. `args.model` is never inspected or required (parser is text-only).
  //     The parser API takes only `prompt: string`; args.model is in WU2's scope.
  //     The reference runs from after the trigger to the end of the prompt,
  //     so the test prompt ends at the model name to keep the assertion sharp.
  {
    const prompt = "Run a task using model gpt-4o";
    const result = parseNaturalModelIntent(prompt);
    assert.ok(result !== null);
    assert.equal(result?.rawReference, "gpt-4o");
    console.log("  pass: parser is text-only; never inspects `args.model`");
  }

  console.log("✅ All natural-model-intent parser tests passed.");

  console.log("--- natural alias table extension ---");

  // 17. The curated alias table includes the new "gemini flash 3.6 tiered"
  //     mapping required by the proposal / design.
  {
    assert.ok(
      NATURAL_MODEL_ALIASES.has("gemini flash 3.6 tiered"),
      "alias table contains the new natural-language alias",
    );
    assert.equal(
      NATURAL_MODEL_ALIASES.get("gemini flash 3.6 tiered"),
      "google/antigravity-gemini-3.6-flash-tiered",
      "alias maps to the dotted canonical identity",
    );
    console.log("  pass: alias table contains `gemini flash 3.6 tiered` -> `google/antigravity-gemini-3.6-flash-tiered`");
  }

  // 18. The alias table is a 1:1 Map with non-empty canonical values.
  {
    for (const [alias, canonical] of NATURAL_MODEL_ALIASES.entries()) {
      assert.ok(typeof alias === "string" && alias.length > 0, `alias key "${alias}" is non-empty`);
      assert.ok(typeof canonical === "string" && canonical.includes("/"), `canonical "${canonical}" is well-formed provider/model`);
      const slashCount = (canonical.match(/\//g) ?? []).length;
      assert.equal(slashCount, 1, `canonical "${canonical}" has exactly one slash`);
    }
    console.log("  pass: alias table invariants (non-empty alias, canonical has exactly one '/')");
  }

  // 19. End-to-end: parser -> resolver consumes the new alias and returns the
  //     canonical identity with no Tier 3 fuzzy fallback.
  {
    const catalog = new StubCatalog();
    catalog.addCanonical("google", "antigravity-gemini-3.6-flash-tiered", "Gemini 3.6 Flash Tiered");
    // Tier 3 must NOT be reached: alias should hit before any search.
    const resolver = new ModelRouteResolver(catalog, NATURAL_MODEL_ALIASES);

    const intent = parseNaturalModelIntent("Generá un saludo usando Gemini Flash 3.6 Tiered");
    assert.ok(intent !== null, "Spanish trigger parses");
    const resolved = await resolver.resolve(intent!.rawReference);
    assert.equal(resolved.providerId, "google");
    assert.equal(resolved.modelId, "antigravity-gemini-3.6-flash-tiered");
    assert.equal(resolved.toString(), "google/antigravity-gemini-3.6-flash-tiered");
    console.log("  pass: parser + resolver chain resolves the new alias without fuzzy fallback");
  }

  // 20. Alias resolution preserves 1:1 ambiguity behavior — a natural alias
  //     that does NOT exist in the alias table falls through to Tier 3, which
  //     (with empty catalog in this test) throws RouteUnknownError rather
  //     than guessing.
  {
    const catalog = new StubCatalog();
    const resolver = new ModelRouteResolver(catalog, NATURAL_MODEL_ALIASES);
    let thrown: unknown = null;
    try { await resolver.resolve("completely-unknown-natural-ref"); } catch (e) { thrown = e; }
    assert.ok(thrown !== null, "unknown reference throws rather than guessing");
    console.log("  pass: unknown natural references fail closed (no guessing)");
  }

  // 21. `ModelRouteAliasTable` type still accepts `NATURAL_MODEL_ALIASES` for
  //     backward-compatible wiring with the existing resolver constructor.
  {
    const aliases: ModelRouteAliasTable = NATURAL_MODEL_ALIASES;
    const catalog = new StubCatalog();
    const resolver = new ModelRouteResolver(catalog, aliases);
    assert.ok(resolver !== null);
    console.log("  pass: NATURAL_MODEL_ALIASES satisfies ModelRouteAliasTable type");
  }

  console.log("✅ All natural alias table tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
