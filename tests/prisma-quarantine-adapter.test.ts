import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import path from "node:path";
import { PrismaModelRepositoryAdapter } from "../src/infrastructure/prisma/prisma-model-repository.adapter.js";

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
  });
  console.assert(pEntry.level === "provider", "Provider level returned");
  console.assert(pEntry.providerId === "openai", "Provider ID returned");
  console.assert(pEntry.type === "ttl", "Type ttl returned");

  // Verify in DB directly
  const pDb = await prisma.provider.findUnique({ where: { id: "openai" } });
  console.assert(pDb?.quarantineType === "ttl", "DB provider quarantineType updated");
  console.assert(pDb?.quarantineUntil?.getTime() === until.getTime(), "DB provider quarantineUntil updated");

  // 2. Set Quarantine - Model
  await adapter.setQuarantine({
    level: "model",
    modelId: "gpt-4o",
    type: "permanent",
  });
  const mDb = await prisma.model.findUnique({ where: { id: "gpt-4o" } });
  console.assert(mDb?.quarantineType === "permanent", "DB model quarantineType updated");
  console.assert(mDb?.quarantineUntil === null, "DB model quarantineUntil null for permanent");

  // 3. Set Quarantine - ModelProvider
  await adapter.setQuarantine({
    level: "modelProvider",
    providerId: "openai",
    modelId: "gpt-4o",
    type: "ttl",
    until,
  });
  const mpDb = await prisma.modelProvider.findFirst({ where: { providerId: "openai", modelId: "gpt-4o" } });
  console.assert(mpDb?.quarantineType === "ttl", "DB modelProvider quarantineType updated");

  // 4. List Quarantines
  const list = await adapter.listQuarantines();
  console.assert(list.length === 3, `Expected 3 quarantines, got ${list.length}`);

  // 5. Release Quarantine - clears both type and until
  await adapter.releaseQuarantine({ level: "provider", providerId: "openai" });
  const pDbAfter = await prisma.provider.findUnique({ where: { id: "openai" } });
  console.assert(pDbAfter?.quarantineType === null, "Release clears quarantineType");
  console.assert(pDbAfter?.quarantineUntil === null, "Release clears quarantineUntil");

  const listAfter = await adapter.listQuarantines();
  console.assert(listAfter.length === 2, "List length reduced after release");

  // 6. Concurrent same-target writes test
  const future1 = new Date(Date.now() + 10000);
  const future2 = new Date(Date.now() + 20000);
  await Promise.all([
    adapter.setQuarantine({ level: "model", modelId: "gpt-4o", type: "ttl", until: future1 }),
    adapter.setQuarantine({ level: "model", modelId: "gpt-4o", type: "ttl", until: future2 }),
  ]);
  const finalM = await prisma.model.findUnique({ where: { id: "gpt-4o" } });
  console.assert(finalM?.quarantineType === "ttl", "Concurrent writes leave valid state");

  await prisma.$disconnect();
  console.log("✅ All Prisma Quarantine Adapter tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});

