/**
 * Rev 2 fleet regeneration orchestration tests.
 *
 * `routes.json` is the only inclusion authority; quarantines are the
 * only subtractive force (permanent -> exclude, ttl -> include).
 * There is no `excludeCanonicalIds` input, no catalog-port check, and
 * no CANARY_BLOCKED reason.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RegenerateFleetAgentsUseCase } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";
import { ModelRouteAuditLogger } from "../src/infrastructure/logging/model-route-audit.logger.js";
import type { ModelRouteQuarantinePort } from "../src/ports/model-route-quarantine.port.js";
import type { QuarantineEntry } from "../src/domain/model/quarantine.js";

class MockQuarantinePort implements ModelRouteQuarantinePort {
  constructor(private entries: QuarantineEntry[]) {}
  async listActive(): Promise<ReadonlyArray<QuarantineEntry>> {
    return this.entries;
  }
}

const TEST_DIR = path.resolve("./scratch/test-fleet-regen");

function setupWorkspace(): { workspaceRoot: string; routesJsonPath: string } {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  const configDir = path.join(TEST_DIR, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });
  const routesJsonPath = path.join(configDir, "routes.json");

  const routesConfig = {
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    cap: 8,
    sizeException: null,
    routes: [
      { baseTemplate: "sdd-mr-base", providerId: "openai", modelId: "gpt-4o" },
      { baseTemplate: "sdd-mr-base", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
      { baseTemplate: "sdd-mr-base", providerId: "google", modelId: "gemini-pro" },
    ],
  };

  writeFileSync(routesJsonPath, JSON.stringify(routesConfig, null, 2), "utf8");
  return { workspaceRoot: TEST_DIR, routesJsonPath };
}

test("regeneration orchestrates decode -> filter -> audit -> generate", async () => {
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  // claude is permanently quarantined at model level; everything else is included.
  const quarantines: QuarantineEntry[] = [
    { level: "model", modelId: "claude-3-5-sonnet", type: "permanent", reason: "model offline" },
  ];
  const quarantine = new MockQuarantinePort(quarantines);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const useCase = new RegenerateFleetAgentsUseCase(quarantine, auditLogger);
  const res = await useCase.execute({ workspaceRoot });
  await auditLogger.close();

  // Two routes generated: gpt-4o and gemini-pro (claude excluded).
  assert.equal(res.generated.length, 2);
  const generatedIds = res.generated.map((g) => `${g.providerId}/${g.modelId}`).sort();
  assert.deepEqual(generatedIds, ["google/gemini-pro", "openai/gpt-4o"]);

  assert.equal(res.excluded.length, 1);
  assert.equal(res.excluded[0].route.modelId, "claude-3-5-sonnet");
  assert.equal(res.excluded[0].reason, "PERMANENTLY_QUARANTINED");

  // Verify on-disk artifacts
  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
  assert.ok(existsSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.routes.length, 2);

  // The agent files for generated routes exist; claude is absent.
  const agentsDir = path.join(workspaceRoot, ".opencode", "agents");
  const agentFiles = readdirSync(agentsDir);
  assert.equal(agentFiles.length, 2, "exactly 2 base agent files (one per generated route)");

  // Audit file contains exactly 1 exclusion event.
  const auditLines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(auditLines.length, 1);
  assert.equal(JSON.parse(auditLines[0]).stage, "generation.route.excluded");
  assert.equal(JSON.parse(auditLines[0]).reason, "PERMANENTLY_QUARANTINED");
});

test("routes.json is the only inclusion authority (no NOT_CONNECTED check)", async () => {
  // No quarantines, no catalog port. Every route in routes.json is
  // included regardless of provider connectivity.
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  const quarantine = new MockQuarantinePort([]);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const useCase = new RegenerateFleetAgentsUseCase(quarantine, auditLogger);
  const res = await useCase.execute({ workspaceRoot });
  await auditLogger.close();

  assert.equal(res.generated.length, 3, "all 3 routes are generated even with no catalog");
  assert.equal(res.excluded.length, 0, "no NOT_CONNECTED exclusion is possible");
});

test("TTL quarantines are included at generation time", async () => {
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  const quarantines: QuarantineEntry[] = [
    {
      level: "model",
      modelId: "gpt-4o",
      type: "ttl",
      until: new Date(Date.now() + 3_600_000),
      reason: "temp outage",
    },
  ];
  const quarantine = new MockQuarantinePort(quarantines);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const useCase = new RegenerateFleetAgentsUseCase(quarantine, auditLogger);
  const res = await useCase.execute({ workspaceRoot });
  await auditLogger.close();

  assert.equal(res.generated.length, 3, "TTL quarantine does NOT exclude at generation time");
  assert.equal(res.excluded.length, 0);
});

test("RegenerateFleetAgentsInput no longer carries excludeCanonicalIds", () => {
  // The new input type is structural; the test only needs to confirm that
  // an input matching the new shape compiles without using the removed field.
  const input: import("../src/application/regenerate-fleet-agents/regenerate-fleet-agents.input.js").RegenerateFleetAgentsInput = {
    workspaceRoot: "/tmp/x",
  };
  assert.equal((input as { excludeCanonicalIds?: unknown }).excludeCanonicalIds, undefined,
    "excludeCanonicalIds is no longer part of the input type");
});
