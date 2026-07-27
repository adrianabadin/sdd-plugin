import assert from "node:assert/strict";
import {
  isQuarantineActive,
  resolveQuarantinePrecedence,
  ttlHoursToUntil,
  validateQuarantineDraft,
  type QuarantineDraft,
  type QuarantineEntry,
} from "../src/domain/model/quarantine.js";

async function runTests() {
  console.log("--- Quarantine Domain Helpers Unit Tests ---");

  const baseDate = new Date("2026-07-21T12:00:00.000Z");
  const pastDate = new Date("2026-07-21T11:59:59.000Z");
  const futureDate = new Date("2026-07-21T12:00:01.000Z");

  // Test 1: TTL boundary active check
  const ttlActive: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: futureDate,
  };
  const ttlExpired: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until: pastDate,
  };
  const permanent: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "permanent",
  };

  console.assert(isQuarantineActive(ttlActive, baseDate) === true, "TTL future must be active");
  console.assert(isQuarantineActive(ttlExpired, baseDate) === false, "TTL past must be inactive");
  console.assert(isQuarantineActive(ttlExpired, pastDate) === false, "TTL exact boundary must be inactive");
  console.assert(isQuarantineActive(permanent, baseDate) === true, "Permanent must be active");

  // Test 2: Precedence resolution: provider > model > modelProvider
  const entries: QuarantineEntry[] = [
    {
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
    },
    {
      level: "model",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
    },
    {
      level: "provider",
      providerId: "openai",
      type: "permanent",
    },
  ];

  const resolved = resolveQuarantinePrecedence(entries, "openai", "gpt-4o", baseDate);
  console.assert(resolved !== null, "Must resolve an entry");
  console.assert(resolved?.level === "provider", "Provider level must override model and connection");

  // Test 3: Model overrides modelProvider if provider is inactive
  const entriesNoProvider: QuarantineEntry[] = [
    {
      level: "modelProvider",
      providerId: "openai",
      modelId: "gpt-4o",
      type: "ttl",
      until: futureDate,
    },
    {
      level: "model",
      modelId: "gpt-4o",
      type: "permanent",
    },
  ];
  const resolvedModel = resolveQuarantinePrecedence(entriesNoProvider, "openai", "gpt-4o", baseDate);
  console.assert(resolvedModel?.level === "model", "Model level must override connection");

  // Test 5: Draft validation is pure and accepts trimmed non-empty reasons
  const validProviderDraft: QuarantineDraft = {
    level: "provider",
    providerId: "openai",
    reason: "  provider outage  ",
    duration: { kind: "permanent" },
  };
  const draftBeforeValidation = structuredClone(validProviderDraft);
  const validDraftResult = validateQuarantineDraft(validProviderDraft);
  assert.equal(validDraftResult.ok, true, "a permanent provider draft with a trimmed non-empty reason is valid");
  assert.deepEqual(validProviderDraft, draftBeforeValidation, "draft validation does not mutate the draft");
  assert.equal(
    validateQuarantineDraft({
      ...validProviderDraft,
      reason: "",
    }).ok,
    false,
    "an empty reason is rejected",
  );
  assert.equal(
    validateQuarantineDraft({
      ...validProviderDraft,
      reason: "   ",
    }).ok,
    false,
    "a whitespace-only reason is rejected after trimming",
  );
  assert.equal(
    ttlHoursToUntil({ kind: "permanent" }, baseDate),
    null,
    "permanent duration has no expiry",
  );
  assert.equal(ttlHoursToUntil(null, baseDate), null, "null TTL has no expiry for permanent storage");

  // Test 6: TTL conversion accepts only positive finite hours
  const ttlUntil = ttlHoursToUntil(1.5, baseDate);
  assert.equal(ttlUntil.getTime() - baseDate.getTime(), 90 * 60 * 1000, "TTL hours convert to milliseconds");
  const validTtlResult = validateQuarantineDraft({
    level: "model",
    modelId: "gpt-4o",
    reason: "temporary incident",
    duration: { kind: "ttl", hours: 2 },
  });
  assert.equal(validTtlResult.ok, true, "a positive finite TTL is valid");

  for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "abc"] as unknown[]) {
    const invalidTtlResult = validateQuarantineDraft({
      level: "provider",
      providerId: "openai",
      reason: "incident",
      duration: { kind: "ttl", hours: hours as number },
    });
    assert.equal(invalidTtlResult.ok, false, `TTL ${String(hours)} is rejected by pure validation`);
    assert.throws(
      () => ttlHoursToUntil(hours as number, baseDate),
      /positive finite number/,
      `TTL ${String(hours)} is rejected by conversion`,
    );
  }

  // Test 7: Scope identifiers are validated without touching persistence
  assert.equal(
    validateQuarantineDraft({ level: "provider", reason: "incident", duration: { kind: "permanent" } }).ok,
    false,
    "provider drafts require a provider id",
  );
  assert.equal(
    validateQuarantineDraft({ level: "model", reason: "incident", duration: { kind: "permanent" } }).ok,
    false,
    "model drafts require a model id",
  );
  assert.equal(
    validateQuarantineDraft({
      level: "modelProvider",
      providerId: "openai",
      reason: "incident",
      duration: { kind: "permanent" },
    }).ok,
    false,
    "modelProvider drafts require both provider and model ids",
  );

  // Test 8: Provider scope covers future models while model and modelProvider remain distinct
  const providerQuarantine: QuarantineEntry = {
    level: "provider",
    providerId: "openai",
    type: "permanent",
  };
  assert.equal(
    resolveQuarantinePrecedence([providerQuarantine], "openai", "future-model", baseDate)?.level,
    "provider",
    "provider scope applies to a future model of that provider",
  );
  assert.equal(
    resolveQuarantinePrecedence([providerQuarantine], "anthropic", "future-model", baseDate),
    null,
    "provider scope does not affect another provider",
  );

  const modelQuarantine: QuarantineEntry = {
    level: "model",
    modelId: "shared-model",
    type: "permanent",
  };
  const connectionQuarantine: QuarantineEntry = {
    level: "modelProvider",
    providerId: "openai",
    modelId: "shared-model",
    type: "permanent",
  };
  assert.equal(
    resolveQuarantinePrecedence([modelQuarantine], "anthropic", "shared-model", baseDate)?.level,
    "model",
    "model scope matches the model id across providers",
  );
  assert.equal(
    resolveQuarantinePrecedence([connectionQuarantine], "openai", "shared-model", baseDate)?.level,
    "modelProvider",
    "modelProvider scope matches the exact provider/model connection",
  );
  assert.equal(
    resolveQuarantinePrecedence([connectionQuarantine], "anthropic", "shared-model", baseDate),
    null,
    "modelProvider scope does not match the same model through another provider",
  );
  assert.equal(
    resolveQuarantinePrecedence([connectionQuarantine], "openai", "other-model", baseDate),
    null,
    "modelProvider scope does not match another model through the same provider",
  );

  console.log("✅ All domain quarantine helper tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
