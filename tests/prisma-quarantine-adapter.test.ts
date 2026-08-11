import assert from "node:assert/strict";

import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import { PrismaModelRepositoryAdapter } from "../src/infrastructure/prisma/prisma-model-repository.adapter.js";
import type { QuarantineTarget } from "../src/domain/model/quarantine.js";

async function runTests() {
  console.log("--- Prisma Quarantine Adapter Integration Tests ---");

  const dbPath = path.resolve("opencode-models.test.db");
  const prismaAdapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter: prismaAdapter });
  const adapter = new PrismaModelRepositoryAdapter(prisma);

  // Setup fixtures
  await prisma.modelProviderPricing.deleteMany({});
  await prisma.modelProvider.deleteMany({});
  await prisma.model.deleteMany({});
  await prisma.provider.deleteMany({});

  await prisma.provider.create({
    data: { id: "openai", name: "OpenAI" },
  });
  await prisma.provider.create({
    data: { id: "anthropic", name: "Anthropic" },
  });
  await prisma.model.create({
    data: { id: "gpt-4o", name: "GPT-4o" },
  });
  await prisma.modelProvider.create({
    data: { providerId: "openai", modelId: "gpt-4o" },
  });

  // 1. Set Quarantine - Provider
  const until = new Date("2026-12-31T23:59:59.000Z");
  const pEntry = await adapter.setQuarantine({
    level: "provider",
    providerId: "openai",
    type: "ttl",
    until,
    reason: "  provider-wide outage  ",
  });
  assert(pEntry.level === "provider", "Provider level returned");
  assert(pEntry.providerId === "openai", "Provider ID returned");
  assert(pEntry.type === "ttl", "Type ttl returned");
  assert(pEntry.reason === "provider-wide outage", "Provider entry returns trimmed reason");

  // Verify in DB directly
  const pDb = await prisma.provider.findUnique({ where: { id: "openai" } });
  assert(pDb?.quarantineType === "ttl", "DB provider quarantineType updated");
  assert(pDb?.quarantineUntil?.getTime() === until.getTime(), "DB provider quarantineUntil updated");
  assert(
    pDb?.quarantineReason === "provider-wide outage",
    "DB provider quarantineReason stored (trimmed)",
  );

  // 2. Set Quarantine - Model
  await adapter.setQuarantine({
    level: "model",
    modelId: "gpt-4o",
    type: "permanent",
    reason: "deprecated model",
  });
  const mDb = await prisma.model.findUnique({ where: { id: "gpt-4o" } });
  assert(mDb?.quarantineType === "permanent", "DB model quarantineType updated");
  assert(mDb?.quarantineUntil === null, "DB model quarantineUntil null for permanent");
  assert(
    mDb?.quarantineReason === "deprecated model",
    "DB model quarantineReason stored (trimmed)",
  );

  // 3. Set Quarantine - ModelProvider
  await adapter.setQuarantine({
    level: "modelProvider",
    providerId: "openai",
    modelId: "gpt-4o",
    type: "ttl",
    until,
    reason: "specific provider degradation",
  });
  const mpDb = await prisma.modelProvider.findFirst({ where: { providerId: "openai", modelId: "gpt-4o" } });
  assert(mpDb?.quarantineType === "ttl", "DB modelProvider quarantineType updated");
  assert(
    mpDb?.quarantineReason === "specific provider degradation",
    "DB modelProvider quarantineReason stored (trimmed)",
  );

  // 4. List Quarantines (must include reason)
  const list = await adapter.listQuarantines();
  assert(list.length === 3, `Expected 3 quarantines, got ${list.length}`);
  const listedProvider = list.find((entry) => entry.level === "provider" && entry.providerId === "openai");
  assert(
    listedProvider?.reason === "provider-wide outage",
    "List reports persisted reason for provider entry",
  );
  const listedModel = list.find((entry) => entry.level === "model" && entry.modelId === "gpt-4o");
  assert(
    listedModel?.reason === "deprecated model",
    "List reports persisted reason for model entry",
  );
  const listedConnection = list.find((entry) => entry.level === "modelProvider");
  assert(
    listedConnection?.reason === "specific provider degradation",
    "List reports persisted reason for connection entry",
  );

  // 4b. findQuarantine exact result for matching target
  const foundProvider = await adapter.findQuarantine({
    level: "provider",
    providerId: "openai",
  });
  assert(foundProvider !== null, "findQuarantine returns a non-null entry for the persisted provider target");
  assert(foundProvider?.type === "ttl", "findQuarantine returns the persisted type");
  assert(
    foundProvider?.reason === "provider-wide outage",
    "findQuarantine returns the persisted reason",
  );

  // 4c. findQuarantine returns null for unrelated target
  const foundAbsent = await adapter.findQuarantine({
    level: "provider",
    providerId: "anthropic",
  });
  assert(foundAbsent === null, "findQuarantine returns null for a target that has no quarantine row");

  // 4d. findQuarantine returns null after release
  await adapter.releaseQuarantine({ level: "provider", providerId: "openai" });
  const afterReleaseProvider = await adapter.findQuarantine({
    level: "provider",
    providerId: "openai",
  });
  assert(
    afterReleaseProvider === null,
    "findQuarantine returns null after the matching quarantine has been released",
  );
  const pDbAfter = await prisma.provider.findUnique({ where: { id: "openai" } });
  assert(pDbAfter?.quarantineType === null, "Release clears quarantineType");
  assert(pDbAfter?.quarantineUntil === null, "Release clears quarantineUntil");
  assert(
    pDbAfter?.quarantineReason === null,
    "Release clears quarantineReason (no leftover text)",
  );

  // 4e. findQuarantine exact result for modelProvider after release of unrelated row
  const foundModelProvider = await adapter.findQuarantine({
    level: "modelProvider",
    providerId: "openai",
    modelId: "gpt-4o",
  });
  assert(
    foundModelProvider !== null && foundModelProvider.reason === "specific provider degradation",
    "findQuarantine still returns the matching modelProvider row when the provider row was released",
  );

  const listAfter = await adapter.listQuarantines();
  assert(listAfter.length === 2, "List length reduced after release");

  // 5. Idempotent update/extension: set again with new reason and TTL
  const newUntil = new Date(Date.now() + 30 * 60 * 1000);
  const extended = await adapter.setQuarantine({
    level: "modelProvider",
    providerId: "openai",
    modelId: "gpt-4o",
    type: "ttl",
    until: newUntil,
    reason: "extended outage",
  });
  assert(extended.reason === "extended outage", "Extension returns the new reason");
  const mpAfter = await prisma.modelProvider.findFirst({
    where: { providerId: "openai", modelId: "gpt-4o" },
  });
  assert(
    mpAfter?.quarantineReason === "extended outage",
    "Idempotent update overwrites the prior reason",
  );
  assert(
    mpAfter?.quarantineUntil?.getTime() === newUntil.getTime(),
    "Idempotent update extends the TTL",
  );
  const finalCount = await prisma.modelProvider.count({
    where: { providerId: "openai", modelId: "gpt-4o", quarantineType: { not: null } },
  });
  assert(
    finalCount === 1,
    "Idempotent set must not produce duplicate rows for the same target",
  );

  // 6. Concurrent same-target writes test (idempotent under contention)
  const future1 = new Date(Date.now() + 10000);
  const future2 = new Date(Date.now() + 20000);
  await Promise.all([
    adapter.setQuarantine({ level: "model", modelId: "gpt-4o", type: "ttl", until: future1, reason: "race-1" }),
    adapter.setQuarantine({ level: "model", modelId: "gpt-4o", type: "ttl", until: future2, reason: "race-2" }),
  ]);
  const finalM = await prisma.model.findUnique({ where: { id: "gpt-4o" } });
  assert(finalM?.quarantineType === "ttl", "Concurrent writes leave valid state");
  assert(
    finalM?.quarantineReason === "race-1" || finalM?.quarantineReason === "race-2",
    "Concurrent writes leave a valid trimmed reason",
  );

  // 7. findQuarantine on ModelProvider after concurrent updates
  const foundModel = await adapter.findQuarantine({ level: "model", modelId: "gpt-4o" });
  assert(
    foundModel !== null && (foundModel.reason === "race-1" || foundModel.reason === "race-2"),
    "findQuarantine returns the persisted reason after concurrent writes",
  );

  // 8. Touch-quarantine type guard: ensures target union is honored on readback
  const targetForReadback: QuarantineTarget = {
    level: "modelProvider",
    providerId: "openai",
    modelId: "gpt-4o",
  };
  const readbackAfterExtension = await adapter.findQuarantine(targetForReadback);
  assert(
    readbackAfterExtension?.reason === "extended outage",
    "findQuarantine honors level/providerId/modelId tuple after extension",
  );

  await prisma.$disconnect();
  console.log("✅ All Prisma Quarantine Adapter tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

