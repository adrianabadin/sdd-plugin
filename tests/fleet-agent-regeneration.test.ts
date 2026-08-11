import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RegenerateFleetAgentsUseCase } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";
import { ModelRouteAuditLogger } from "../src/infrastructure/logging/model-route-audit.logger.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";

class MockCatalogPort implements ModelRouteCatalogPort {
  constructor(private connectedKeys: Set<string>) {}
  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return this.connectedKeys.has(`${providerId}:${modelId}`);
  }
  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    return [];
  }
}

class MockQuarantinePort implements QuarantineWritePort {
  constructor(private entries: QuarantineEntry[]) {}
  async setQuarantine(_cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
    throw new Error("Not implemented");
  }
  async releaseQuarantine(_target: QuarantineTarget): Promise<void> {
    throw new Error("Not implemented");
  }
  async listQuarantines(): Promise<QuarantineEntry[]> {
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
      { baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" },
      { baseTemplate: "general", providerId: "anthropic", modelId: "claude-3-5-sonnet" },
      { baseTemplate: "general", providerId: "google", modelId: "gemini-pro" },
    ],
  };

  writeFileSync(routesJsonPath, JSON.stringify(routesConfig, null, 2), "utf8");
  return { workspaceRoot: TEST_DIR, routesJsonPath };
}

test("regeneration orchestrates decode -> filter -> audit -> generate", async () => {
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  // Only gpt-4o and claude are connected; gemini is NOT_CONNECTED
  const catalog = new MockCatalogPort(new Set(["openai:gpt-4o", "anthropic:claude-3-5-sonnet"]));
  // claude is permanently quarantined at model level
  const quarantines: QuarantineEntry[] = [
    { level: "model", modelId: "claude-3-5-sonnet", type: "permanent", reason: "model offline" },
  ];
  const quarantine = new MockQuarantinePort(quarantines);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const useCase = new RegenerateFleetAgentsUseCase(catalog, quarantine, auditLogger);
  const res = await useCase.execute({ workspaceRoot });
  await auditLogger.close();

  // Only gpt-4o should be generated!
  assert.equal(res.generated.length, 1);
  assert.equal(res.generated[0].providerId, "openai");
  assert.equal(res.generated[0].modelId, "gpt-4o");

  assert.equal(res.excluded.length, 2);
  assert.equal(res.excluded[0].route.modelId, "claude-3-5-sonnet");
  assert.equal(res.excluded[0].reason, "PERMANENTLY_QUARANTINED");
  assert.equal(res.excluded[1].route.modelId, "gemini-pro");
  assert.equal(res.excluded[1].reason, "NOT_CONNECTED");

  // Verify on-disk artifacts
  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
  assert.ok(existsSync(manifestPath));
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.routes.length, 1);

  // Excluded models must NOT exist on disk
  const agentsDir = path.join(workspaceRoot, ".opencode", "agents");
  const agentFiles = readdirSync(agentsDir);
  assert.equal(agentFiles.length, 1);

  // Audit file must contain exactly 2 exclusion events
  const auditLines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(auditLines.length, 2);
  assert.equal(JSON.parse(auditLines[0]).stage, "generation.route.excluded");
  assert.equal(JSON.parse(auditLines[1]).stage, "generation.route.excluded");
});

test("cold-start empty catalog generates empty manifest and single generation.fleet.empty audit event with no detail", async () => {
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  const catalog = new MockCatalogPort(new Set()); // cold start: nothing connected
  const quarantine = new MockQuarantinePort([]);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const useCase = new RegenerateFleetAgentsUseCase(catalog, quarantine, auditLogger);
  const res = await useCase.execute({ workspaceRoot });
  await auditLogger.close();

  assert.equal(res.generated.length, 0);
  assert.equal(res.excluded.length, 3);
  assert.ok(typeof res.manifestHash === "string");

  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.routes.length, 0);

  const auditLines = readFileSync(logPath, "utf8").trim().split("\n");
  // 3 exclusion events + 1 empty fleet event
  assert.equal(auditLines.length, 4);
  const lastEvent = JSON.parse(auditLines[3]);
  assert.equal(lastEvent.stage, "generation.fleet.empty");
  assert.equal(lastEvent.status, "warning");
  assert.equal(lastEvent.excludedCount, 3);
  assert.equal("detail" in lastEvent, false);
});

test("audit append failure aborts before disk mutation", async () => {
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  const catalog = new MockCatalogPort(new Set());
  const quarantine = new MockQuarantinePort([]);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });
  await auditLogger.close(); // Closed audit logger throws error on append

  const useCase = new RegenerateFleetAgentsUseCase(catalog, quarantine, auditLogger);
  await assert.rejects(
    async () => useCase.execute({ workspaceRoot }),
    (err: Error) => err.name === "ModelRouteAuditLoggerError",
  );

  // Manifest must NOT have been written
  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
  assert.equal(existsSync(manifestPath), false);
});

test("excludeCanonicalIds forwards to filter and sweeps removed host files", async () => {
  const { workspaceRoot } = setupWorkspace();
  const logPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "routing.audit.jsonl");

  // All three routes connected, no quarantines: full fleet on first pass
  const catalog = new MockCatalogPort(
    new Set(["openai:gpt-4o", "anthropic:claude-3-5-sonnet", "google:gemini-pro"]),
  );
  const quarantine = new MockQuarantinePort([]);
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const useCase = new RegenerateFleetAgentsUseCase(catalog, quarantine, auditLogger);

  // Pass 1: generate the full fleet (no exclusions)
  const first = await useCase.execute({ workspaceRoot });
  assert.equal(first.generated.length, 3);
  const geminiAgentRelative = first.generated.find((g) => g.modelId === "gemini-pro")!.agentRelative;
  assert.equal(existsSync(path.join(workspaceRoot, geminiAgentRelative)), true);

  // Pass 2: exclude the gemini route via canary-blocked canonical id
  const second = await useCase.execute({
    workspaceRoot,
    excludeCanonicalIds: new Set(["google/gemini-pro"]),
  });
  await auditLogger.close();

  // Exclusion reached the filter: emitted fleet excludes the route
  assert.equal(second.generated.length, 2);
  assert.equal(second.generated.some((g) => g.modelId === "gemini-pro"), false);
  assert.equal(second.excluded.length, 1);
  assert.equal(second.excluded[0].route.modelId, "gemini-pro");
  assert.equal(second.excluded[0].reason, "CANARY_BLOCKED");

  // Exclusion reached the sweep: gemini host files removed, others regenerated
  assert.equal(existsSync(path.join(workspaceRoot, geminiAgentRelative)), false);
  assert.ok(second.sweptRelativePaths.includes(geminiAgentRelative));

  const agentsDir = path.join(workspaceRoot, ".opencode", "agents");
  assert.equal(readdirSync(agentsDir).length, 2);

  const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.routes.length, 2);
  assert.equal(manifest.routes.some((r: { modelId: string }) => r.modelId === "gemini-pro"), false);

  // Single exclusion event with the canary reason
  const auditLines = readFileSync(logPath, "utf8").trim().split("\n");
  assert.equal(auditLines.length, 1);
  assert.equal(JSON.parse(auditLines[0]).stage, "generation.route.excluded");
  assert.equal(JSON.parse(auditLines[0]).reason, "CANARY_BLOCKED");
});
