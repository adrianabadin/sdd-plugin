import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { createProductionBootComponents } from "../src/cli/model-route-boot.js";
import { RegenerateFleetAgentsUseCase } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";

const TEST_DIR = path.resolve("./scratch/test-boot-composition");

test("production composition root builds real regeneration stack and closes resources", async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  const components = createProductionBootComponents(TEST_DIR);

  assert.ok(components.manager);
  assert.ok(components.prisma);
  assert.ok(components.auditLogger);
  assert.ok(components.fleetRegeneration instanceof RegenerateFleetAgentsUseCase);
  assert.equal(
    components.routesConfigPath,
    path.resolve(TEST_DIR, "config/model-routing/routes.json"),
  );

  // Close resources
  await components.auditLogger.close();
  await components.prisma.$disconnect();
});
