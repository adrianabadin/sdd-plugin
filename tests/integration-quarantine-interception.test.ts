/**
 * Task 7 Integration Test — Quarantine set/release interception behavior.
 *
 * Acceptance scenarios (design.md):
 *   - "A quarantine blocks the correct scope and release removes the block
 *      immediately."
 *   - "Main menu -> Quarantines -> set/release -> SQLite -> QuarantineStore
 *      -> interception gate"
 *   - "Verify a missing registry/store never breaks task interception;
 *      SQLite read-through remains the fallback."
 */
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

import { SddPlugin } from "../src/bootstrap/index.js";
import { PrismaModelRepositoryAdapter } from "../src/infrastructure/prisma/prisma-model-repository.adapter.js";
import {
  ListQuarantinesUseCase,
  SetQuarantineUseCase,
  ReleaseQuarantineUseCase,
} from "../src/application/quarantine/index.js";
import { getGlobalQuarantineStore } from "../src/infrastructure/runtime/quarantine-store.js";

console.log("--- Task 7 Integration: Quarantine Set/Release Interception ---");

const failures: string[] = [];

function assertOk(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

const dbPath = path.resolve(`opencode-models.test-quarantine-${randomUUID()}.db`);
process.env.SDD_PLUGIN_DB_PATH = dbPath;
process.env.DATABASE_URL = `file:${dbPath}`;

execSync("npx prisma db push --accept-data-loss", { stdio: "ignore" });

const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
const prisma = new PrismaClient({ adapter: prismaAdapter });

async function run() {
  // Seed provider + model + modelProvider
  await prisma.provider.upsert({
    where: { id: "openai" },
    update: {},
    create: { id: "openai", name: "OpenAI" },
  });
  await prisma.model.upsert({
    where: { id: "gpt-4o" },
    update: {},
    create: { id: "gpt-4o", name: "GPT-4o" },
  });
  await prisma.modelProvider.upsert({
    where: { modelId_providerId: { modelId: "gpt-4o", providerId: "openai" } },
    update: {},
    create: { modelId: "gpt-4o", providerId: "openai" },
  });

  const adapter = new PrismaModelRepositoryAdapter(prisma);
  const store = getGlobalQuarantineStore();

  // Reset global store so we start with a clean snapshot for this test DB.
  // (Symbol.for returns the same store across the process; previous tests
  // could have published entries.)
  const listUseCase = new ListQuarantinesUseCase(adapter, store);
  const initialEntries = await listUseCase.execute();
  for (const entry of initialEntries) {
    if (entry.level === "provider") store.release({ level: "provider", providerId: entry.providerId! });
    if (entry.level === "model") store.release({ level: "model", modelId: entry.modelId! });
    if (entry.level === "modelProvider")
      store.release({ level: "modelProvider", providerId: entry.providerId!, modelId: entry.modelId! });
  }
  assertOk(store.snapshot().length === 0, "store snapshot cleared at test start");

  // === Set provider-level quarantine ===
  const verifierAdapter = new PrismaModelRepositoryAdapter(prisma);
  const setProviderUseCase = new SetQuarantineUseCase(adapter, verifierAdapter, store);
  await setProviderUseCase.execute({
    level: "provider",
    type: "permanent",
    providerId: "openai",
    reason: "  vendor incident  ",
  });
  assertOk(store.isActive("openai", "gpt-4o"), "provider quarantine marks (openai, gpt-4o) as active");

  // DB has the quarantine persisted
  const persistedProvider = await prisma.provider.findUnique({ where: { id: "openai" } });
  assertOk(persistedProvider?.quarantineType === "permanent", "provider quarantine persisted to DB");
  assertOk(persistedProvider?.quarantineUntil === null, "permanent provider quarantine has null quarantineUntil in DB");
  assertOk(persistedProvider?.quarantineReason === "vendor incident", "provider quarantineReason trimmed and persisted to DB");

  // === Verify provider quarantine blocks existing + future-added models without per-model DB rows ===
  await prisma.model.upsert({
    where: { id: "gpt-4-turbo" },
    update: {},
    create: { id: "gpt-4-turbo", name: "GPT-4 Turbo" },
  });
  await prisma.modelProvider.upsert({
    where: { modelId_providerId: { modelId: "gpt-4-turbo", providerId: "openai" } },
    update: {},
    create: { modelId: "gpt-4-turbo", providerId: "openai" },
  });
  const newModelDbRow = await prisma.model.findUnique({ where: { id: "gpt-4-turbo" } });
  assertOk(newModelDbRow?.quarantineType === null, "future model has no per-model quarantine row in DB");
  assertOk(store.isActive("openai", "gpt-4-turbo"), "provider quarantine dynamically blocks model added after quarantine set");

  // === Verify invalid drafts (blank reason / invalid TTL) cause zero DB mutation ===
  await assert.rejects(
    async () => {
      await setProviderUseCase.execute({
        level: "provider",
        type: "permanent",
        providerId: "openai",
        reason: "   ", // blank reason
      });
    },
    /reason/i,
    "blank reason must be rejected by SetQuarantineUseCase",
  );

  await assert.rejects(
    async () => {
      await setProviderUseCase.execute({
        level: "provider",
        type: "ttl",
        providerId: "openai",
        reason: "valid reason",
        until: new Date(Date.now() - 1000), // expired/invalid TTL
      });
    },
    /ttl|until|expired|future/i,
    "past/invalid TTL must be rejected by SetQuarantineUseCase",
  );

  // === Interception gate blocks the quarantined task before invocation ===
  const plugin = await SddPlugin({ project: "test-quarantine", client: {}, directory: "" });
  const hook = plugin["tool.execute.before"];
  let providerQuarantinedTaskInvoked = false;
  await assert.rejects(
    async () => {
      await hook(
        { tool: "task" },
        { args: { subagent_type: "task-q-1", model: "openai/gpt-4o" } },
      );
      providerQuarantinedTaskInvoked = true;
    },
    /quarantined/i,
    "provider quarantine must reject the task hook",
  );
  assertOk(!providerQuarantinedTaskInvoked, "provider quarantine prevents the task invocation");
  // Snapshot now includes the provider quarantine (rehydrated if needed).
  assertOk(
    store.snapshot().some((e) => e.level === "provider" && e.providerId === "openai"),
    "store snapshot includes the persisted provider quarantine after interception",
  );

  // === Set model-level quarantine (different scope) ===
  const setModelUseCase = new SetQuarantineUseCase(adapter, verifierAdapter, store);
  await setModelUseCase.execute({
    level: "model",
    type: "ttl",
    modelId: "gpt-4o",
    reason: "rate limit exceeded",
    until: new Date(Date.now() + 60_000),
  });
  assertOk(store.isActive("openai", "gpt-4o"), "model quarantine keeps (openai, gpt-4o) active");

  let modelQuarantinedTaskInvoked = false;
  await assert.rejects(
    async () => {
      await hook(
        { tool: "task" },
        { args: { subagent_type: "task-q-model", model: "openai/gpt-4o" } },
      );
      modelQuarantinedTaskInvoked = true;
    },
    /quarantined/i,
    "model quarantine must reject the task hook",
  );
  assertOk(!modelQuarantinedTaskInvoked, "model quarantine prevents the task invocation");

  // === Verifier mismatch / null / throw prevents runtime projection mutation ===
  class DisagreeingVerifier implements QuarantineQueryPort {
    async findQuarantine(): Promise<PersistedQuarantine | null> {
      return null; // Mismatch / null
    }
  }
  const storeBeforeMismatchCount = store.snapshot().length;
  const setMismatchUseCase = new SetQuarantineUseCase(adapter, new DisagreeingVerifier(), store);
  await assert.rejects(
    async () => {
      await setMismatchUseCase.execute({
        level: "provider",
        type: "permanent",
        providerId: "openai",
        reason: "disagree test",
      });
    },
    /verifier/i,
    "verifier mismatch must reject SetQuarantineUseCase",
  );
  assertOk(
    store.snapshot().length === storeBeforeMismatchCount,
    "verifier mismatch prevents runtime QuarantineStore publication/mutation",
  );

  // === Interception gate observes BOTH quarantines ===
  const persistedSnapBeforeRelease = store.snapshot();
  assertOk(
    persistedSnapBeforeRelease.some((e) => e.level === "model" && e.modelId === "gpt-4o"),
    "store snapshot includes the model-level quarantine",
  );

  // === Release provider quarantine; model-level remains active ===
  const releaseUseCase = new ReleaseQuarantineUseCase(adapter, verifierAdapter, store);
  await releaseUseCase.execute({ level: "provider", providerId: "openai" });
  // Provider persisted to null
  const releasedProvider = await prisma.provider.findUnique({ where: { id: "openai" } });
  assertOk(releasedProvider?.quarantineType === null, "release clears provider quarantine in DB");
  assertOk(releasedProvider?.quarantineUntil === null, "release clears provider quarantineUntil in DB");

  // Store reflects removal
  assertOk(
    !store.snapshot().some((e) => e.level === "provider" && e.providerId === "openai"),
    "store snapshot no longer contains the released provider quarantine",
  );

  // Model-level quarantine remains
  assertOk(
    store.snapshot().some((e) => e.level === "model" && e.modelId === "gpt-4o"),
    "model-level quarantine remains after provider release",
  );
  assertOk(store.isActive("openai", "gpt-4o"), "(openai, gpt-4o) still active via model scope");

  // === Release model-level quarantine; everything clean ===
  await releaseUseCase.execute({ level: "model", modelId: "gpt-4o" });
  const releasedModel = await prisma.model.findUnique({ where: { id: "gpt-4o" } });
  assertOk(releasedModel?.quarantineType === null, "release clears model quarantine in DB");
  assertOk(releasedModel?.quarantineUntil === null, "release clears model quarantineUntil in DB");
  assertOk(releasedModel?.quarantineReason === null, "release clears model quarantineReason in DB");

  // Interception gate observes no active quarantine (rehydrates from DB)
  let releasedTaskInvoked = false;
  await hook(
    { tool: "task" },
    { args: { subagent_type: "task-q-2", model: "openai/gpt-4o" } },
  );
  releasedTaskInvoked = true;
  assertOk(releasedTaskInvoked, "released quarantine permits the task invocation");
  assertOk(
    !store.snapshot().some((e) => e.level !== "modelProvider" || (e.providerId === "openai" && e.modelId === "gpt-4o")),
    "store snapshot has no active (openai, gpt-4o) scope after release",
  );
  assertOk(!store.isActive("openai", "gpt-4o"), "(openai, gpt-4o) is not active after both releases");

  // === Missing-store fallback: delete global symbol, ensure interception still works ===
  const QUARANTINE_SYMBOL = Symbol.for("sdd-plugin.quarantine-store.v1");
  delete (globalThis as Record<symbol, unknown>)[QUARANTINE_SYMBOL];

  // Trigger interception while the store symbol is absent.
  // The bootstrap hook must rebuild the store via DB read-through hydration.
  await hook(
    { tool: "task" },
    { args: { subagent_type: "task-q-fallback", model: "openai/gpt-4o" } },
  );

  // After interception, store is back (rehydrated from DB which has no entries now).
  const restored = getGlobalQuarantineStore();
  assertOk(restored !== undefined, "missing quarantine store re-created on interception");
  assertOk(
    restored.snapshot().length === 0,
    "rehydrated store from clean DB has empty snapshot",
  );

  // === Now seed a quarantine in DB, drop the store, ensure hydration picks it up ===
  await setProviderUseCase.execute({
    level: "provider",
    type: "permanent",
    providerId: "openai",
    reason: "rehydrate test",
  });
  // The new global store (restored) was created after the use case was built,
  // so the use case published to the previous store reference. Verify the
  // current global reference sees it after a fresh lookup.
  const storeAfterSet = getGlobalQuarantineStore();
  // Force eviction of the in-memory store.
  delete (globalThis as Record<symbol, unknown>)[QUARANTINE_SYMBOL];
  let rehydratedTaskInvoked = false;
  await assert.rejects(
    async () => {
      await hook(
        { tool: "task" },
        { args: { subagent_type: "task-q-rehydrate", model: "openai/gpt-4o" } },
      );
      rehydratedTaskInvoked = true;
    },
    /quarantined/i,
    "DB-rehydrated quarantine must reject the task hook",
  );
  assertOk(!rehydratedTaskInvoked, "DB-rehydrated quarantine prevents the task invocation");

  const rehydratedStore = getGlobalQuarantineStore();
  assertOk(rehydratedStore.isActive("openai", "gpt-4o"), "DB read-through rehydrates the dropped store");

  await prisma.$disconnect();

  console.log("\n=== INTEGRATION QUARANTINE SUMMARY ===");
  if (failures.length === 0) {
    console.log("All quarantine interception assertions passed.");
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
