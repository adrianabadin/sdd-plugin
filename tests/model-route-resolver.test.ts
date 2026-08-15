/**
 * RED-first tests for `ModelRouteResolver`.
 *
 * Rev 2: the resolver is now backed by `RouteWhitelist` (loaded from
 * `routes.json`). There is no catalog port and no I/O.
 *
 * Tiers: exact canonical -> explicit alias -> unique normalized.
 * Failures: 0 -> RouteUnknownError; >1 -> RouteAmbiguousError with sorted candidates.
 * Identity decisions NEVER consult benchmark/pricing/subscription metadata
 * (the whitelist exposes only identity fields, asserting this by construction).
 */

import assert from "node:assert/strict";
import {
  ModelRouteResolver,
  RouteUnknownError,
  RouteAmbiguousError,
} from "../src/domain/model-routing/model-route-resolver.js";
import { RouteWhitelist, type WhitelistedRoute } from "../src/domain/model-routing/route-whitelist.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";

function whitelistWith(rows: ReadonlyArray<{ providerId: string; modelId: string }>): RouteWhitelist {
  const whitelisted: WhitelistedRoute[] = rows.map((r) => ({
    baseTemplate: "sdd-mr-base",
    providerId: r.providerId,
    modelId: r.modelId,
    hostName: hashHostName("sdd-mr-base", { providerId: r.providerId, modelId: r.modelId }),
  }));
  return new RouteWhitelist(whitelisted);
}

async function runTests(): Promise<void> {
  console.log("--- model-route resolver (RED-first) ---");

  const whitelist = whitelistWith([
    { providerId: "google", modelId: "antigravity-gemini-3-6-flash-tiered" },
    { providerId: "openai", modelId: "gpt-4o" },
    { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
  ]);

  const aliases = new Map<string, string>([
    ["gemini-tiered", "google/antigravity-gemini-3-6-flash-tiered"],
    ["claude-sonnet", "anthropic/claude-3-5-sonnet"],
  ]);

  const resolver = new ModelRouteResolver(whitelist, aliases);

  // Tier 1: exact canonical.
  {
    const result = await resolver.resolve("openai/gpt-4o");
    assert.equal(result.providerId, "openai");
    assert.equal(result.modelId, "gpt-4o");
    assert.equal(result.toString(), "openai/gpt-4o");
    console.log("  pass: Tier 1 exact canonical resolves to single identity");
  }

  // Tier 2: explicit alias.
  {
    const result = await resolver.resolve("gemini-tiered");
    assert.equal(result.providerId, "google");
    assert.equal(result.modelId, "antigravity-gemini-3-6-flash-tiered");
    console.log("  pass: Tier 2 explicit alias resolves to mapped identity");
  }

  // Tier 3: unique normalized (substring on "provider/model").
  {
    const result = await resolver.resolve("gpt-4o");
    assert.equal(result.providerId, "openai");
    assert.equal(result.modelId, "gpt-4o");
    console.log("  pass: Tier 3 unique normalized match resolves to single identity");
  }

  // Tier precedence: alias beats fuzzy.
  {
    const result = await resolver.resolve("claude-sonnet");
    assert.equal(result.providerId, "anthropic");
    assert.equal(result.modelId, "claude-3-5-sonnet");
    console.log("  pass: Tier 2 alias precedence over Tier 3 fuzzy");
  }

  // Zero matches -> RouteUnknownError.
  {
    let thrown: unknown = null;
    try { await resolver.resolve("no-such-model-anywhere"); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof RouteUnknownError, "zero matches throws RouteUnknownError");
    assert.equal((thrown as RouteUnknownError).reference, "no-such-model-anywhere");
    console.log("  pass: zero matches -> RouteUnknownError");
  }

  // Many matches -> RouteAmbiguousError with sorted candidates.
  {
    const ambigWhitelist = whitelistWith([
      { providerId: "google", modelId: "gemini-3-6-flash" },
      { providerId: "google", modelId: "antigravity-gemini-3-6-flash-tiered" },
      { providerId: "openai", modelId: "gpt-4o" },
    ]);
    const r = new ModelRouteResolver(ambigWhitelist, new Map());

    let thrown: unknown = null;
    try { await r.resolve("gemini"); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof RouteAmbiguousError, "many matches throws RouteAmbiguousError");
    const err = thrown as RouteAmbiguousError;
    assert.equal(err.reference, "gemini");
    assert.equal(err.candidates.length, 2, "both candidates listed");
    const sortedIds = err.candidates.map((c) => c.modelId).sort();
    assert.deepEqual(
      sortedIds,
      ["antigravity-gemini-3-6-flash-tiered", "gemini-3-6-flash"],
      "candidate modelIds sorted for stable error payload",
    );
    console.log("  pass: many matches -> RouteAmbiguousError with sorted candidates");
  }

  // Empty reference rejected at the boundary.
  {
    let thrown: unknown = null;
    try { await resolver.resolve(""); } catch (e) { thrown = e; }
    assert.ok(thrown instanceof RouteUnknownError, "empty reference is rejected at the boundary");
    console.log("  pass: empty reference rejected");
  }

  // Determinism across alias-table configurations.
  {
    const a = new ModelRouteResolver(whitelist, new Map());
    const b = new ModelRouteResolver(whitelist, aliases);
    const ra = await a.resolve("openai/gpt-4o");
    const rb = await b.resolve("openai/gpt-4o");
    assert.equal(ra.providerId, rb.providerId);
    assert.equal(ra.modelId, rb.modelId);
    console.log("  pass: Tier 1 deterministic across alias-table configurations");
  }

  console.log("✅ All model-route resolver tests passed.");
}

runTests().catch((err) => { console.error("Test failed:", err); process.exit(1); });
