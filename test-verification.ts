/**
 * Behavior verification harness.
 *
 * Drives the refactored use cases through the original scenarios:
 *  1. Initial sync with full metadata -> all fields persisted.
 *  2. Re-sync with omitted metadata  -> existing values preserved.
 *  3. Re-sync with partial pricing  -> missing fields carried over
 *                                       and a new pricing record created.
 *  4. New model with no pricing     -> no pricing record created.
 *
 * Run with `npx tsx test-verification.ts` (uses src/ directly via tsx).
 */
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { realpathSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { SyncConnectedModelsUseCase } from "./src/application/sync-connected-models/sync-connected-models.use-case.js";
import { OpenCodeModelCatalogAdapter } from "./src/infrastructure/opencode/opencode-model-catalog.adapter.js";
import { PrismaModelRepositoryAdapter } from "./src/infrastructure/prisma/prisma-model-repository.adapter.js";
import { BackgroundModelRefreshCoordinator } from "./src/application/background-model-refresh-coordinator.js";
import { SddPlugin } from "./src/bootstrap/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const productionDbPath = path.resolve(__dirname, "opencode-models.db");
const defaultTestDbPath = path.resolve(__dirname, "opencode-models.test.db");
const hasTestDatabaseOverride = process.env.TEST_DATABASE_URL !== undefined;
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? `file:${defaultTestDbPath}`;
const testDbPath = sqlitePathFromUrl(testDatabaseUrl);

assertTestDatabaseIsIsolated(testDbPath);
process.env.DATABASE_URL = testDatabaseUrl;
prepareTestDatabase(testDatabaseUrl, testDbPath, !hasTestDatabaseOverride);

const prismaAdapter = new PrismaLibSql({ url: testDatabaseUrl });
const prisma = new PrismaClient({ adapter: prismaAdapter });

function sqlitePathFromUrl(databaseUrl: string): string {
  if (!databaseUrl.startsWith("file:")) {
    throw new Error("TEST_DATABASE_URL must be a SQLite file: URL.");
  }

  const urlWithoutQuery = databaseUrl.split("?", 1)[0]!;
  try {
    return path.resolve(fileURLToPath(urlWithoutQuery));
  } catch {
    const relativePath = decodeURIComponent(urlWithoutQuery.slice("file:".length));
    if (!relativePath) {
      throw new Error("TEST_DATABASE_URL must identify a SQLite database file.");
    }
    return path.resolve(__dirname, relativePath);
  }
}

function canonicalPath(filePath: string): string {
  let resolvedPath = path.resolve(filePath);
  try {
    resolvedPath = realpathSync.native(resolvedPath);
  } catch {
    // The test database normally does not exist until Prisma creates it.
  }
  return process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
}

function assertTestDatabaseIsIsolated(candidatePath: string): void {
  if (canonicalPath(candidatePath) === canonicalPath(productionDbPath)) {
    throw new Error(
      "Refusing to run verification tests against opencode-models.db. " +
        "Set TEST_DATABASE_URL to a dedicated SQLite test database.",
    );
  }
}

function prepareTestDatabase(
  databaseUrl: string,
  databasePath: string,
  resetDefaultDatabase: boolean,
): void {
  if (resetDefaultDatabase) {
    for (const suffix of ["", "-journal", "-shm", "-wal"]) {
      rmSync(`${databasePath}${suffix}`, { force: true });
    }
  }

  const prismaCliPath = fileURLToPath(import.meta.resolve("prisma/build/index.js"));
  execFileSync(
    process.execPath,
    [
      prismaCliPath,
      "db",
      "push",
      "--schema",
      path.resolve(__dirname, "prisma", "schema.prisma"),
      "--url",
      databaseUrl,
    ],
    {
      cwd: __dirname,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: "inherit",
    },
  );
}

/**
 * Run a sync scenario against a mocked SDK client, then run the
 * provided assertion callback against the resulting DB state.
 */
async function runScenario(
  label: string,
  mock: { config: { providers: () => Promise<unknown> } },
  assertions: () => Promise<void>,
) {
  console.log(`\n--- ${label} ---`);
  const catalog = new OpenCodeModelCatalogAdapter(mock);
  const repository = new PrismaModelRepositoryAdapter(prisma);
  const useCase = new SyncConnectedModelsUseCase(catalog, repository);
  await useCase.execute({});
  await assertions();
}

async function runTests() {
  console.log("=== STARTING VERIFICATION TESTS ===");
  console.log(`Using isolated test database: ${testDbPath}`);

  // 1. Clean Database
  console.log("Cleaning database...");
  await prisma.modelProviderPricing.deleteMany({});
  await prisma.modelProvider.deleteMany({});
  await prisma.model.deleteMany({});
  await prisma.provider.deleteMany({});

  // Test 1: Initial sync with full metadata.
  await runScenario(
    "Test 1: Initial Sync with Full Metadata",
    {
      config: {
        providers: async () => ({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              subscription: "large",
              isBlocked: false,
              provider: {
                quarantineType: "permanent",
                quarantineUntil: new Date("2026-09-01T00:00:00.000Z"),
              },
              models: {
                "claude-3-5-sonnet": {
                  name: "Claude 3.5 Sonnet",
                  mmlu: 88.7,
                  humaneval: 92.0,
                  quarantineType: "ttl",
                  quarantineUntil: new Date("2026-08-01T00:00:00.000Z"),
                  model: {
                    quarantineType: "ttl",
                    quarantineUntil: new Date("2026-10-01T00:00:00.000Z"),
                  },
                  pricing: {
                    inputPerMillion: 3.0,
                    outputPerMillion: 15.0,
                    cachedPerMillion: 0.75,
                    currency: "USD",
                    effectiveFrom: new Date("2026-07-19T00:00:00.000Z"),
                  },
                },
              },
            },
          ]
        })
      },
    },
    async () => {
      const provider = await prisma.provider.findUnique({ where: { id: "anthropic" } });
      const model = await prisma.model.findUnique({ where: { id: "claude-3-5-sonnet" } });
      const mp = await prisma.modelProvider.findFirst({
        where: { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
        include: { pricing: true },
      });

      if (!provider || provider.subscription !== "large" || provider.quarantineType !== "permanent") {
        throw new Error("Provider metadata mismatch!");
      }
      if (!model || model.mmlu !== 88.7 || model.humaneval !== 92.0 || model.quarantineType !== "ttl") {
        throw new Error("Model metadata mismatch!");
      }
      if (!mp || mp.quarantineType !== "ttl" || mp.pricing.length !== 1) {
        throw new Error("ModelProvider or Pricing mismatch!");
      }
      const pricing1 = mp.pricing[0]!;
      if (
        pricing1.inputPerMillion !== 3.0 ||
        pricing1.outputPerMillion !== 15.0 ||
        pricing1.cachedPerMillion !== 0.75
      ) {
        throw new Error("Pricing values mismatch!");
      }
      console.log("Test 1 Passed: Initial Sync saved all fields correctly.");
    },
  );

  // Test 2: Re-sync with missing metadata; existing values preserved.
  await runScenario(
    "Test 2: Sync with Missing/Omitted Metadata (Must Preserve)",
    {
      config: {
        providers: async () => ({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "claude-3-5-sonnet": {
                  name: "Claude 3.5 Sonnet",
                },
              },
            },
          ]
        })
      },
    },
    async () => {
      const provider = await prisma.provider.findUnique({ where: { id: "anthropic" } });
      const model = await prisma.model.findUnique({ where: { id: "claude-3-5-sonnet" } });
      const mp = await prisma.modelProvider.findFirst({
        where: { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
        include: { pricing: true },
      });
      if (!provider || provider.subscription !== "large" || provider.quarantineType !== "permanent") {
        throw new Error("Provider metadata was not preserved!");
      }
      if (!model || model.mmlu !== 88.7 || model.humaneval !== 92.0 || model.quarantineType !== "ttl") {
        throw new Error("Model metadata was not preserved!");
      }
      if (!mp || mp.quarantineType !== "ttl" || mp.pricing.length !== 1) {
        throw new Error("ModelProvider or Pricing was not preserved!");
      }
      console.log("Test 2 Passed: Missing fields were preserved successfully.");
    },
  );

  // Test 3: Partial pricing — only inputPerMillion + effectiveFrom.
  await runScenario(
    "Test 3: Sync with Partial Pricing metadata (Must Carry Over)",
    {
      config: {
        providers: async () => ({
          providers: [
            {
              id: "anthropic",
              name: "Anthropic",
              models: {
                "claude-3-5-sonnet": {
                  name: "Claude 3.5 Sonnet",
                  pricing: {
                    inputPerMillion: 4.5,
                    effectiveFrom: new Date("2026-07-20T00:00:00.000Z"),
                  },
                },
              },
            },
          ]
        })
      },
    },
    async () => {
      const mp = await prisma.modelProvider.findFirst({
        where: { providerId: "anthropic", modelId: "claude-3-5-sonnet" },
        include: { pricing: { orderBy: { effectiveFrom: "desc" } } },
      });
      if (!mp || mp.pricing.length !== 2) {
        throw new Error(`Expected 2 pricing records, got ${mp?.pricing.length}`);
      }
      const latest = mp.pricing[0]!;
      if (latest.inputPerMillion !== 4.5) throw new Error("New input pricing was not applied!");
      if (latest.outputPerMillion !== 15.0 || latest.cachedPerMillion !== 0.75) {
        throw new Error("Omitted pricing fields were not preserved/carried over!");
      }
      console.log("Test 3 Passed: Partial pricing carried over old values successfully.");
    },
  );

  // Test 4: New model with no pricing.
  await runScenario(
    "Test 4: New Model with NO Pricing (Must Remain Null)",
    {
      config: {
        providers: async () => ({
          providers: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-4o": {
                  name: "GPT-4o",
                },
              },
            },
          ]
        })
      },
    },
    async () => {
      const mp = await prisma.modelProvider.findFirst({
        where: { providerId: "openai", modelId: "gpt-4o" },
        include: { pricing: true },
      });
      if (!mp) throw new Error("Failed to create openai/gpt-4o");
      if (mp.pricing.length !== 0) {
        throw new Error("Pricing was created for a model with no explicit pricing metadata!");
      }
      console.log("Test 4 Passed: Pricing remained empty/null.");
    },
  );

  // Test 5: Background Model Refresh Coordinator & Overlapping behavior
  await runCoordinatorTests();

  // Test 6: Hook returns before sync resolves & does not block
  await runHookTests();

  console.log("\n=== ALL VERIFICATION TESTS PASSED SUCCESSFULLY ===");
}

async function runCoordinatorTests() {
  console.log("\n--- Test 5: Background Model Refresh Coordinator & Hook Behavior ---");

  let resolveRefresh: (() => void) | null = null;
  let rejectRefresh: ((err: Error) => void) | null = null;
  let refreshCallCount = 0;

  const refreshFn = () => {
    refreshCallCount++;
    return new Promise<void>((resolve, reject) => {
      resolveRefresh = resolve;
      rejectRefresh = reject;
    });
  };

  const errorLogs: Array<{ message: string; error: unknown }> = [];
  const mockLogger = {
    error: (message: string, error: unknown) => {
      errorLogs.push({ message, error });
    },
  };

  const coordinator = new BackgroundModelRefreshCoordinator(refreshFn, mockLogger);

  // 1. Initial state
  if (coordinator.isInFlight()) {
    throw new Error("Coordinator should not be in flight initially!");
  }

  // 2. Trigger first refresh
  const promise1 = coordinator.trigger();
  if (!coordinator.isInFlight()) {
    throw new Error("Coordinator should be in flight after trigger!");
  }
  if (refreshCallCount !== 1) {
    throw new Error(`Expected refreshFn to be called 1 time, got ${refreshCallCount}`);
  }

  // 3. Trigger second refresh while first is in flight (overlapping)
  const promise2 = coordinator.trigger();
  if (promise1 !== promise2) {
    throw new Error("Expected overlapping triggers to share the same promise instance!");
  }
  if (refreshCallCount !== 1) {
    throw new Error(`Overlapping triggers should not start a new execution (call count should remain 1, got ${refreshCallCount})`);
  }

  // 4. Resolve the in-flight refresh
  if (!resolveRefresh) {
    throw new Error("resolveRefresh callback not set!");
  }
  (resolveRefresh as () => void)();
  await promise1;

  if (coordinator.isInFlight()) {
    throw new Error("Coordinator should not be in flight after resolution!");
  }

  // 5. Trigger a new refresh after the first has completed
  const promise3 = coordinator.trigger();
  if (!coordinator.isInFlight()) {
    throw new Error("Coordinator should be in flight after new trigger!");
  }
  if (refreshCallCount !== 2) {
    throw new Error(`Expected refreshFn to be called 2 times, got ${refreshCallCount}`);
  }

  // Resolve the third one to clean up
  if (!resolveRefresh) {
    throw new Error("resolveRefresh callback not set for second run!");
  }
  (resolveRefresh as () => void)();
  await promise3;

  // 6. Test background failure does not reject the trigger or crash
  const promise4 = coordinator.trigger();
  if (!rejectRefresh) {
    throw new Error("rejectRefresh callback not set!");
  }
  (rejectRefresh as (err: Error) => void)(new Error("Simulated background error"));
  
  // Await the promise4 which should resolve normally (since the coordinator catches its own errors)
  await promise4;
  
  if (coordinator.isInFlight()) {
    throw new Error("Coordinator should not be in flight after rejection!");
  }
  if (errorLogs.length !== 1 || !errorLogs[0]!.message.includes("Background refresh failed")) {
    throw new Error(`Expected coordinator to log background error, errorLogs: ${JSON.stringify(errorLogs)}`);
  }

  console.log("Test 5 Passed: Coordinator background and overlapping behavior verified successfully.");
}

async function runHookTests() {
  console.log("\n--- Test 6: Hook returns before sync resolves & does not block ---");
  
  // Set up mock client
  let resolveSDKCall: (() => void) | null = null;
  const mockClient = {
    config: {
      providers: async () => new Promise<any>((resolve) => {
        resolveSDKCall = () => resolve({ providers: [] });
      })
    }
  };

  // SddPlugin should return hooks immediately WITHOUT awaiting the sync/list
  const pluginPromise = SddPlugin({
    project: "test-project",
    client: mockClient,
    directory: "/test"
  });

  // Since we haven't resolved the SDK call yet, if the plugin was awaiting, it would block here.
  // We can race it or check if it resolves quickly.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Plugin init blocked on sync!")), 100));
  const pluginInstance = await Promise.race([pluginPromise, timeout]) as any;

  if (!pluginInstance || typeof pluginInstance["tool.execute.before"] !== "function") {
    throw new Error("Expected SddPlugin to return hook map");
  }

  // Now, test hook returns immediately without blocking
  let hookResolved = false;
  const hookPromise = pluginInstance["tool.execute.before"]({ tool: "task" }, { args: { subagent_type: "apply" } });
  
  hookPromise.then(() => {
    hookResolved = true;
  });

  // Sleep slightly to let the hook handler run. It should resolve immediately because it is backgrounded.
  await new Promise((resolve) => setTimeout(resolve, 20));

  if (!hookResolved) {
    throw new Error("Hook did not resolve immediately (blocked on sync)!");
  }

  // Now resolve the SDK call to let the background sync finish
  if (resolveSDKCall) {
    (resolveSDKCall as any)();
  }

  // Await the hook promise just to clean up (in case it didn't resolve, but we proved it did)
  await hookPromise;

  console.log("Test 6 Passed: Hook returns before sync resolves and does not block.");
}

runTests()
  .catch((err) => {
    console.error("Test execution failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
