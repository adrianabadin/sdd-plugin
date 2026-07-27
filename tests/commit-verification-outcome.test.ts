/**
 * Finding 9/10 — Commit-verification outcome (PR4 RED).
 *
 * The durable commit must produce one of two outcomes:
 *   - `verified`: the read-after-write verifier agrees with the write; the
 *     runtime registry MAY publish and the TUI may swap its baseline.
 *   - `committed-unverified`: the write committed durably, but the verifier
 *     returned either a mismatch or `null`; the use case MUST NOT publish
 *     to the registry, MUST NOT throw, and MUST return a typed result with
 *     the mismatches and operational guidance so the caller can show a
 *     truthful warning.
 *
 * Pre-commit failures (validation, conflict) and infrastructure failures
 * (verifier connection lost) still throw — only mismatches/null AFTER a
 * durable commit become the typed outcome.
 *
 * RED contract (asserted before use case is updated):
 *   1. The use case throws on mismatch; the new contract must return a
 *      typed `committed-unverified` result.
 *   2. The use case throws on null readback; the new contract must return
 *      a typed `committed-unverified` result.
 *   3. The use case publishes to the registry on mismatch/null (it doesn't
 *      today, but the new contract must forbid it).
 *
 * GREEN contract (after use case is updated):
 *   1. Mismatch returns `{ outcome: 'committed-unverified', mismatches,
 *      guidance, updatedAt, envelopeHash }`; no publish, no throw.
 *   2. Null readback returns the same shape; the `null` readback is reported
 *      via `guidance`, not as a mismatch list.
 *   3. Verified returns `{ outcome: 'verified', updatedAt, envelopeHash }`
 *      and publishes.
 *   4. Conflict (DB write rejection) still throws.
 *   5. Pre-commit validation failure still throws.
 */
import assert from "node:assert/strict";

import { SaveModelDetailUseCase, type SaveModelDetailInput } from "../src/application/save-model-detail/save-model-detail.use-case.js";
import type { ModelDetailWritePort, SaveModelDetailCommand } from "../src/ports/model-detail-write.port.js";
import type { ModelDetailQueryPort, PersistedModelDetail } from "../src/ports/model-detail-query.port.js";
import type { ModelConfigRegistry, EffectiveModelConfig } from "../src/infrastructure/runtime/model-config-registry.js";

console.log("--- Finding 9/10: commit-verification outcome ---");

const BENCHMARKS = {
  mmlu: 88,
  humaneval: 90,
  sweBench: 45,
  gpqa: 53.4,
  math: 76.8,
  bbh: 83.1,
  mtBench: 8.9,
  multineedle: 99.1,
};

const PRICING = {
  inputPerMillion: 2.5,
  outputPerMillion: 10,
  cachedPerMillion: 1.25,
  currency: "USD",
};

class MockWriteAdapter implements ModelDetailWritePort {
  public savedCommand: SaveModelDetailCommand | null = null;
  public shouldConflict = false;
  async saveModelDetail(cmd: SaveModelDetailCommand) {
    if (this.shouldConflict) {
      throw new Error("Conflict: envelope hash mismatch");
    }
    this.savedCommand = cmd;
    return {
      updatedAt: new Date("2026-07-21T18:00:00Z"),
      envelopeHash: cmd.expectedEnvelopeHash || "new-hash-1234",
    };
  }
}

class MockRegistry implements ModelConfigRegistry {
  public published: EffectiveModelConfig[] = [];
  public revision = 0;
  publish(c: EffectiveModelConfig) {
    this.published.push(c);
    this.revision++;
  }
  get() { return undefined; }
  subscribe() { return () => {}; }
}

function makePersisted(overrides: Partial<PersistedModelDetail> = {}): PersistedModelDetail {
  return {
    providerId: "openai",
    providerName: "OpenAI",
    providerSubscription: "pro",
    providerIsBlocked: false,
    providerQuarantineType: null,
    providerQuarantineUntil: null,
    providerMetadata: { version: 1, planName: "Pro Tier", periodicCost: 20, includedUsage: 100, overageRate: 0.05 },
    modelId: "gpt-4o",
    modelName: "GPT-4o",
    benchmarks: { ...BENCHMARKS },
    modelQuarantineType: null,
    modelQuarantineUntil: null,
    modelMetadata: { version: 1, contextWindow: 128000, maxOutputTokens: 4096, capabilities: ["coding"] },
    updatedAt: new Date("2026-07-21T18:00:00Z"),
    metadataEnvelopeHash: "new-hash-1234",
    modelProviderQuarantineType: null,
    modelProviderQuarantineUntil: null,
    pricing: {
      id: "pricing-1",
      inputPerMillion: PRICING.inputPerMillion,
      outputPerMillion: PRICING.outputPerMillion,
      cachedPerMillion: PRICING.cachedPerMillion,
      currency: PRICING.currency,
      effectiveFrom: new Date("2026-07-21T18:00:00Z"),
      effectiveUntil: null,
    },
    ...overrides,
  } as PersistedModelDetail;
}

class MockVerifierQueryPort implements ModelDetailQueryPort {
  public callCount = 0;
  constructor(
    private behaviour:
      | { mode: "match" }
      | { mode: "mismatch" }
      | { mode: "null" }
      | { mode: "throw" } = { mode: "match" },
  ) {}
  async findModelDetail(): Promise<PersistedModelDetail | null> {
    this.callCount++;
    if (this.behaviour.mode === "throw") throw new Error("Verifier connection lost");
    if (this.behaviour.mode === "null") return null;
    if (this.behaviour.mode === "mismatch") {
      return makePersisted({ benchmarks: { ...BENCHMARKS, gpqa: 1.1 } });
    }
    return makePersisted();
  }
}

const input: SaveModelDetailInput = {
  providerId: "openai",
  modelId: "gpt-4o",
  providerName: "OpenAI",
  modelName: "GPT-4o",
  isBlocked: false,
  subscription: "pro",
  planName: "Pro Tier",
  periodicCost: 20,
  includedUsage: 100,
  overageRate: 0.05,
  contextWindow: 128000,
  maxOutputTokens: 4096,
  capabilities: ["coding"],
  benchmarks: { ...BENCHMARKS },
  pricing: { ...PRICING },
  expectedEnvelopeHash: null,
};

async function run(): Promise<void> {
  // === Scenario 1 — verified: write committed, verifier matches, registry published.
  {
    const adapter = new MockWriteAdapter();
    const registry = new MockRegistry();
    const verifier = new MockVerifierQueryPort({ mode: "match" });
    const useCase = new SaveModelDetailUseCase(adapter, registry, verifier);
    const result = await useCase.execute(input);

    assert.equal(result.outcome, "verified", "verified write must report outcome 'verified'");
    assert.equal(verifier.callCount, 1, "verifier must be queried exactly once per save");
    assert.equal(registry.published.length, 1, "verified write MUST publish exactly one registry entry");
    assert.equal(registry.published[0]?.providerId, "openai");
    assert.ok(result.envelopeHash, "verified write must surface the envelope hash");
    console.log("  pass: verified write publishes to registry and surfaces envelopeHash");
  }

  // === Scenario 2 — committed-unverified on mismatch: write committed but
  //     verifier disagrees; the use case MUST NOT publish and MUST NOT
  //     throw. It MUST return a typed result with mismatches and guidance.
  {
    const adapter = new MockWriteAdapter();
    const registry = new MockRegistry();
    const verifier = new MockVerifierQueryPort({ mode: "mismatch" });
    const useCase = new SaveModelDetailUseCase(adapter, registry, verifier);

    let caught: unknown = null;
    let result: Awaited<ReturnType<typeof useCase.execute>> | undefined;
    try {
      result = await useCase.execute(input);
    } catch (err) {
      caught = err;
    }
    assert.equal(caught, null, "mismatch after a durable commit MUST NOT throw");
    assert.ok(result !== undefined, "use case must return a result on mismatch");
    assert.equal(result!.outcome, "committed-unverified", "mismatch must report outcome 'committed-unverified'");
    assert.ok(Array.isArray(result!.mismatches) && (result!.mismatches as string[]).length > 0, "mismatches list must be populated");
    assert.ok(typeof result!.guidance === "string" && (result!.guidance as string).length > 0, "guidance must be a non-empty string");
    assert.equal(registry.published.length, 0, "committed-unverified MUST NOT publish to the registry");
    console.log("  pass: mismatch returns committed-unverified with mismatches + guidance and no publish");
  }

  // === Scenario 3 — committed-unverified on null readback: write committed,
  //     verifier returned null. Typed result with `committed-unverified`
  //     and a guidance message; no publish, no throw.
  {
    const adapter = new MockWriteAdapter();
    const registry = new MockRegistry();
    const verifier = new MockVerifierQueryPort({ mode: "null" });
    const useCase = new SaveModelDetailUseCase(adapter, registry, verifier);

    let caught: unknown = null;
    let result: Awaited<ReturnType<typeof useCase.execute>> | undefined;
    try {
      result = await useCase.execute(input);
    } catch (err) {
      caught = err;
    }
    assert.equal(caught, null, "null readback after durable commit MUST NOT throw");
    assert.ok(result !== undefined, "use case must return a result on null readback");
    assert.equal(result!.outcome, "committed-unverified", "null readback must report outcome 'committed-unverified'");
    assert.ok(typeof result!.guidance === "string" && (result!.guidance as string).length > 0, "null readback guidance must be a non-empty string");
    assert.equal(registry.published.length, 0, "null-readback committed-unverified MUST NOT publish to the registry");
    console.log("  pass: null readback returns committed-unverified with guidance and no publish");
  }

  // === Scenario 4 — verified still throws on DB conflict (pre-commit failure).
  {
    const adapter = new MockWriteAdapter();
    adapter.shouldConflict = true;
    const registry = new MockRegistry();
    const verifier = new MockVerifierQueryPort({ mode: "match" });
    const useCase = new SaveModelDetailUseCase(adapter, registry, verifier);
    let caught: unknown = null;
    try {
      await useCase.execute(input);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "DB conflict must throw");
    assert.match(String(caught), /Conflict/, "DB conflict error must mention Conflict");
    assert.equal(registry.published.length, 0, "DB conflict must NOT publish");
    console.log("  pass: DB conflict still throws and does not publish");
  }

  // === Scenario 5 — verified still throws on pre-commit validation failure.
  {
    const adapter = new MockWriteAdapter();
    const registry = new MockRegistry();
    const verifier = new MockVerifierQueryPort({ mode: "match" });
    const useCase = new SaveModelDetailUseCase(adapter, registry, verifier);
    const partial = { ...input, benchmarks: { mmlu: 88, humaneval: 90, sweBench: 45 } } as unknown as SaveModelDetailInput;
    let caught: unknown = null;
    try {
      await useCase.execute(partial);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof Error, "validation failure must throw");
    assert.match(String(caught), /missing required benchmark field/, "validation error must mention the missing field");
    assert.equal(adapter.savedCommand, null, "validation failure must not reach the write port");
    assert.equal(registry.published.length, 0, "validation failure must not publish");
    console.log("  pass: pre-commit validation failure still throws and does not publish");
  }
}

run()
  .then(() => {
    console.log("All commit-verification-outcome assertions passed!");
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });