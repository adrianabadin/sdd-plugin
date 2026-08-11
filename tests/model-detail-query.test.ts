import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../src/generated/prisma/client.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaModelRepositoryAdapter } from "../src/infrastructure/prisma/prisma-model-repository.adapter.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testDbPath = path.resolve(__dirname, "../opencode-models.test.db");
const testDatabaseUrl = `file:${testDbPath}`;

async function runModelDetailQueryTests(): Promise<void> {
  console.log("\n--- Model Detail Query Port & Adapter Test ---");

  const prismaAdapter = new PrismaLibSql({ url: testDatabaseUrl });
  const prisma = new PrismaClient({ adapter: prismaAdapter });
  const adapter = new PrismaModelRepositoryAdapter(prisma);

  // Setup test data in DB
  const providerId = "test-query-provider";
  const modelId = "test-query-model";

  await adapter.upsertProvider({
    id: providerId,
    name: "Query Provider Test",
    isBlocked: true,
    subscription: "medium",
  });

  await adapter.upsertModel({
    id: modelId,
    name: "Query Model Test",
    benchmarks: {
      mmlu: 82.5,
      humaneval: 78.0,
    },
  });

  const mp = await adapter.upsertModelProvider({
    providerId,
    modelId,
  });

  await adapter.upsertPricing({
    modelProviderId: mp.id,
    inputPerMillion: 3.5,
    outputPerMillion: 14.0,
    cachedPerMillion: 1.75,
    currency: "USD",
    effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  });

  // Query existing detail
  const detail = await adapter.findModelDetail(providerId, modelId);
  console.log(`  pass: findModelDetail returns non-null for stored model: ${detail !== null}`);
  if (!detail) throw new Error("Expected detail to be found");

  console.log(`  pass: detail providerName matches: ${detail.providerName === "Query Provider Test"}`);
  console.log(`  pass: detail isBlocked matches: ${detail.providerIsBlocked === true}`);
  console.log(`  pass: detail subscription matches: ${detail.providerSubscription === "medium"}`);
  console.log(`  pass: detail modelName matches: ${detail.modelName === "Query Model Test"}`);
  console.log(`  pass: detail benchmark mmlu matches: ${detail.benchmarks?.mmlu === 82.5}`);
  console.log(`  pass: detail pricing inputPerMillion matches: ${detail.pricing?.inputPerMillion === 3.5}`);

  // Query non-existent detail
  const nonExistent = await adapter.findModelDetail("non-existent-prov", "non-existent-mod");
  console.log(`  pass: findModelDetail returns null for non-existent model: ${nonExistent === null}`);

  await prisma.$disconnect();

  console.log("\n=== MODEL DETAIL QUERY TEST SUMMARY ===");
  console.log("All model detail query assertions passed.");
}

runModelDetailQueryTests().catch((err) => {
  console.error("Model detail query test failed:", err);
  process.exit(1);
});
