/**
 * Task 7 Integration Test — Model edit end-to-end + publish-failure resilience.
 *
 * Acceptance scenarios (design.md):
 *   - "A full model edit persists and is visible to the next task without restart."
 *   - "A publish failure still leaves the durable save and rehydrates on the next
 *      interception."
 *
 * Contract under test:
 *   SaveModelDetailUseCase.execute()
 *     -> PrismaModelRepositoryAdapter.saveModelDetail() (single $transaction)
 *     -> registry.publish() updates the in-memory model config registry
 *     -> next SddPlugin hook on tool.execute.before observes the update
 *        (a) via the in-memory registry, AND
 *        (b) via DB read-through hydration when the registry is empty.
 *   Publish failure isolation:
 *     When the registry publish throws, the DB commit MUST still succeed and
 *     the use case MUST surface a warning. Next interception repopulates the
 *     registry from the DB read-through path.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { SddPlugin } from "../src/bootstrap/index.js";
import { PrismaModelRepositoryAdapter } from "../src/infrastructure/prisma/prisma-model-repository.adapter.js";
import { SaveModelDetailUseCase } from "../src/application/save-model-detail/save-model-detail.use-case.js";
import {
  getOrCreateModelConfigRegistry,
  type ModelConfigRegistry,
  type EffectiveModelConfig,
} from "../src/infrastructure/runtime/model-config-registry.js";

console.log("--- Task 7 Integration: Model Edit End-to-End + Publish-Failure Resilience ---");

const failures: string[] = [];

function assertOk(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

const dbPath = path.resolve(`opencode-models.test-e2e-${randomUUID()}.db`);
process.env.SDD_PLUGIN_DB_PATH = dbPath;
process.env.DATABASE_URL = `file:${dbPath}`;

execSync("npx prisma db push --accept-data-loss", { stdio: "ignore" });

const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter: prismaAdapter });

/** Test double registry that records publishes but throws on first call. */
class ThrowOnFirstPublishRegistry implements ModelConfigRegistry {
  private _revision = 0;
  private entries = new Map<string, EffectiveModelConfig>();
  public publishCount = 0;
  get revision(): number {
    return this._revision;
  }
  publish(config: EffectiveModelConfig): void {
    this.publishCount++;
    if (this.publishCount === 1) throw new Error("simulated registry publish failure");
    const key = `${config.providerId}/${config.modelId}`;
    this.entries.set(key, config);
    this._revision++;
  }
  get(providerId: string, modelId: string): EffectiveModelConfig | undefined {
    return this.entries.get(`${providerId}/${modelId}`);
  }
  subscribe(): () => void {
    return () => {};
  }
}

async function run() {
  // Seed provider + model + modelProvider
  await prisma.provider.upsert({
    where: { id: "anthropic" },
    update: {},
    create: { id: "anthropic", name: "Anthropic" },
  });
  await prisma.model.upsert({
    where: { id: "claude-3-5-sonnet" },
    update: {},
    create: { id: "claude-3-5-sonnet", name: "Claude 3.5 Sonnet" },
  });
  await prisma.modelProvider.upsert({
    where: {
      modelId_providerId: { modelId: "claude-3-5-sonnet", providerId: "anthropic" },
    },
    update: {},
    create: { modelId: "claude-3-5-sonnet", providerId: "anthropic" },
  });

  // Sanity: registry starts empty for this key.
  const registry = getOrCreateModelConfigRegistry();
  const initialRevision = registry.revision;
  assertOk(
    registry.get("anthropic", "claude-3-5-sonnet") === undefined,
    "registry starts empty for anthropic/claude-3-5-sonnet",
  );

  // === Use case wires through shared resolver + adapter ===
  const adapter = new PrismaModelRepositoryAdapter(prisma);
  const useCase = new SaveModelDetailUseCase(adapter, registry);

  const result = await useCase.execute({
    providerId: "anthropic",
    modelId: "claude-3-5-sonnet",
    providerName: "Anthropic",
    modelName: "Claude 3.5 Sonnet v2",
    isBlocked: false,
    subscription: "max",
    planName: "Team",
    periodicCost: 30,
    includedUsage: 500,
    overageRate: 0.02,
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    capabilities: ["coding", "vision"],
    benchmarks: { mmlu: 88.7, humaneval: 92.0, sweBench: 49.0 },
    pricing: {
      inputPerMillion: 3.0,
      outputPerMillion: 15.0,
      cachedPerMillion: 0.75,
      currency: "USD",
    },
    expectedEnvelopeHash: null,
  });

  assertOk(result.success === true, "use case reports success");
  assertOk(typeof result.envelopeHash === "string" && result.envelopeHash.length > 0, "envelope hash returned");

  // Registry reflects the immediate application
  const publishedConfig = registry.get("anthropic", "claude-3-5-sonnet");
  assertOk(publishedConfig !== undefined, "registry publishes effective config immediately");
  if (publishedConfig) {
    assertOk(publishedConfig.contextWindow === 200_000, "registry carries updated contextWindow");
    assertOk(publishedConfig.maxOutputTokens === 8192, "registry carries updated maxOutputTokens");
    assertOk(
      Array.isArray(publishedConfig.capabilities) &&
        publishedConfig.capabilities.includes("coding") &&
        publishedConfig.capabilities.includes("vision"),
      "registry carries updated capabilities",
    );
    assertOk(publishedConfig.inputPerMillion === 3.0, "registry carries updated input pricing");
    assertOk(publishedConfig.subscription === "max", "registry carries updated subscription");
    assertOk(publishedConfig.isBlocked === false, "registry carries updated isBlocked flag");
    assertOk(
      publishedConfig.metadataEnvelopeHash === result.envelopeHash,
      "registry envelopeHash matches DB envelopeHash",
    );
  }
  assertOk(registry.revision > initialRevision, "registry revision incremented on publish");

  // DB has the persisted record
  const persisted = await prisma.provider.findUnique({ where: { id: "anthropic" } });
  assertOk(persisted !== null && persisted.name === "Anthropic", "DB provider row persists updated name");
  const persistedModel = await prisma.model.findUnique({ where: { id: "claude-3-5-sonnet" } });
  assertOk(
    persistedModel !== null && persistedModel.mmlu === 88.7 && persistedModel.humaneval === 92.0,
    "DB model row persists updated benchmarks",
  );

  // === Next task interception: simulate "next task without restart" ===
  // The acceptance contract guarantees the next task observes the saved
  // configuration. In the same process this is delivered by the in-memory
  // registry publish. We assert this end-to-end through the real bootstrap
  // hook on tool.execute.before.
  const plugin = await SddPlugin({ project: "test-e2e", client: {}, directory: "" });
  const hook = plugin["tool.execute.before"];
  const output = { args: { subagent_type: "task-next", model: "anthropic/claude-3-5-sonnet" } };
  await hook({ tool: "task" }, output);

  const rehydrated = registry.get("anthropic", "claude-3-5-sonnet");
  assertOk(rehydrated !== undefined, "next task interception observes the saved config in registry");
  if (rehydrated) {
    assertOk(
      rehydrated.contextWindow === 200_000,
      "next task interception observes updated contextWindow",
    );
    assertOk(
      rehydrated.metadataEnvelopeHash === result.envelopeHash,
      "next task interception observes the saved envelopeHash",
    );
    assertOk(
      rehydrated.inputPerMillion === 3.0,
      "next task interception observes updated pricing",
    );
  }

  // === Cross-process rehydration: simulate a process restart that loses the
  // in-memory registry, then triggers a fresh interception. The bootstrap
  // hook must rebuild the registry from the DB so the next task observes the
  // same envelope hash without a manual save.
  const REGISTRY_SYMBOL = Symbol.for("sdd-plugin.model-config-registry.v1");
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL];
  const freshPlugin = await SddPlugin({ project: "test-e2e-restart", client: {}, directory: "" });
  const freshHook = freshPlugin["tool.execute.before"];
  await freshHook({ tool: "task" }, { args: { subagent_type: "task-restart", model: "anthropic/claude-3-5-sonnet" } });
  const restarted = getOrCreateModelConfigRegistry().get("anthropic", "claude-3-5-sonnet");
  assertOk(restarted !== undefined, "fresh registry rehydrates from DB on next interception after restart");
  if (restarted) {
    assertOk(
      restarted.metadataEnvelopeHash === result.envelopeHash,
      "fresh registry carries the saved envelopeHash after DB read-through",
    );
    assertOk(restarted.contextWindow === 200_000, "fresh registry carries saved contextWindow from DB");
  }

  // === Publish-failure resilience ===
  // Seed a separate provider/model for the failure path.
  await prisma.provider.upsert({
    where: { id: "google" },
    update: {},
    create: { id: "google", name: "Google" },
  });
  await prisma.model.upsert({
    where: { id: "gemini-1-5-pro" },
    update: {},
    create: { id: "gemini-1-5-pro", name: "Gemini 1.5 Pro" },
  });
  await prisma.modelProvider.upsert({
    where: { modelId_providerId: { modelId: "gemini-1-5-pro", providerId: "google" } },
    update: {},
    create: { modelId: "gemini-1-5-pro", providerId: "google" },
  });

  const throwOnce = new ThrowOnFirstPublishRegistry();
  const failUseCase = new SaveModelDetailUseCase(adapter, throwOnce);
  const failResult = await failUseCase.execute({
    providerId: "google",
    modelId: "gemini-1-5-pro",
    providerName: "Google",
    modelName: "Gemini 1.5 Pro",
    isBlocked: false,
    subscription: null,
    planName: null,
    periodicCost: null,
    includedUsage: null,
    overageRate: null,
    contextWindow: 1_000_000,
    maxOutputTokens: 8192,
    capabilities: ["coding"],
    benchmarks: { mmlu: 80, humaneval: 70, sweBench: 30 },
    pricing: null,
    expectedEnvelopeHash: null,
  });
  assertOk(failResult.success === true, "save with failing publish reports success");
  assertOk(typeof failResult.warning === "string", "save with failing publish surfaces warning");
  assertOk(throwOnce.publishCount === 1, "failing publish attempted exactly once");

  const persistedAfterFail = await prisma.model.findUnique({ where: { id: "gemini-1-5-pro" } });
  assertOk(persistedAfterFail?.mmlu === 80, "DB persists benchmark despite publish failure");

  // Next interception rehydrates from DB
  delete (globalThis as Record<symbol, unknown>)[REGISTRY_SYMBOL];
  const rehydratePlugin = await SddPlugin({ project: "test-fail-rehydrate", client: {}, directory: "" });
  await rehydratePlugin["tool.execute.before"](
    { tool: "task" },
    { args: { subagent_type: "task-fail-rehydrate", model: "google/gemini-1-5-pro" } },
  );
  const rehydratedAfterFail = getOrCreateModelConfigRegistry().get("google", "gemini-1-5-pro");
  assertOk(rehydratedAfterFail !== undefined, "next interception repopulates registry after publish failure");
  if (rehydratedAfterFail) {
    assertOk(
      rehydratedAfterFail.metadataEnvelopeHash === failResult.envelopeHash,
      "rehydrated config after publish failure carries the saved envelopeHash",
    );
    assertOk(rehydratedAfterFail.contextWindow === 1_000_000, "rehydrated config after publish failure carries contextWindow");
  }

  await prisma.$disconnect();

  console.log("\n=== INTEGRATION MODEL EDIT + PUBLISH-FAILURE SUMMARY ===");
  if (failures.length === 0) {
    console.log("All model edit + publish-failure assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

run().catch(async (e) => {
  console.error(e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});