import assert from "node:assert/strict";
import { BootStubCanary, type CanarySession } from "./helpers/model-routing-fixtures.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  WindowsModelRouteBootManager,
  ROUTING_BOOT_ID_ENV,
  ROUTING_SIGNING_KEY_ENV,
  type BootChildProcess,
  type BootProcessSupervisor,
} from "../src/infrastructure/runtime/windows-model-route-boot-manager.js";
import { ModelRouteAuditLogger } from "../src/infrastructure/logging/model-route-audit.logger.js";
import { RegenerateFleetAgentsUseCase } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";
import type { CanaryHostTransport } from "../src/infrastructure/opencode/model-route-canary.js";

class MockCatalog implements ModelRouteCatalogPort {
  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return providerId === "openai" && modelId === "gpt-4o";
  }
  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    return [];
  }
}

class MockQuarantine implements QuarantineWritePort {
  async setQuarantine(_cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
    throw new Error("Not implemented");
  }
  async releaseQuarantine(_target: QuarantineTarget): Promise<void> {
    throw new Error("Not implemented");
  }
  async listQuarantines(): Promise<QuarantineEntry[]> {
    return [];
  }
}

class CustomCanary extends BootStubCanary {
  override async createSession(input: { parentModel: string }): Promise<CanarySession> {
    const [providerID, modelID] = input.parentModel.split("/");
    return { id: "parent-sess-1", model: { providerID: providerID!, modelID: modelID! } };
  }
  override async getSession(sessionId: string): Promise<CanarySession> {
    return { id: sessionId, model: { providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered" } };
  }
  override async listMessages(): Promise<ReadonlyArray<unknown>> {
    return [
      { info: { role: "user", model: { providerID: "openai", modelID: "gpt-4o" } } },
      { info: { role: "assistant", providerID: "openai", modelID: "gpt-4o", finish: "stop", time: { completed: 1 } } },
    ];
  }
}

const TEST_DIR = path.resolve("./scratch/test-boot-ordering");

function setupTestEnv() {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  const configDir = path.join(TEST_DIR, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });

  const routesConfig = {
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    cap: 8,
    sizeException: null,
    routes: [{ baseTemplate: "general", providerId: "openai", modelId: "gpt-4o" }],
  };
  writeFileSync(path.join(configDir, "routes.json"), JSON.stringify(routesConfig, null, 2), "utf8");
}

test("boot ordering: regeneration runs before secrets, lifecycle lock, and spawn", async () => {
  setupTestEnv();
  const catalog = new MockCatalog();
  const quarantine = new MockQuarantine();
  const logPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "routing.audit.jsonl");
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  const eventOrder: string[] = [];

  class TrackingRegenerationUseCase extends RegenerateFleetAgentsUseCase {
    override async execute(input: Parameters<RegenerateFleetAgentsUseCase["execute"]>[0]) {
      eventOrder.push("regeneration.execute");
      const generatorLockPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "generator.lock");
      assert.equal(existsSync(generatorLockPath), false, "generator lock must be released before next phase");
      return super.execute(input);
    }
  }

  const trackingRegen = new TrackingRegenerationUseCase(catalog, quarantine, auditLogger);

  const bootManager = new WindowsModelRouteBootManager({
    workspaceRoot: TEST_DIR,
    manifestPath: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "manifest.json"),
    catalog,
    canary: new CustomCanary(),
    selectParentModel: async () => "google/antigravity-gemini-3.6-flash-tiered",
    fleetRegeneration: trackingRegen,
    onStateChange: (state) => {
      eventOrder.push(`state:${state}`);
    },
  });

  await bootManager.start();
  await auditLogger.close();

  assert.equal(eventOrder[0], "state:starting");
  assert.equal(eventOrder[1], "regeneration.execute");
  assert.equal(bootManager.getState(), "ready");

  await bootManager.stop();
});

test("regeneration failure transitions to failed, no secrets exposed, no lifecycle lock", async () => {
  setupTestEnv();
  const catalog = new MockCatalog();
  const quarantine = new MockQuarantine();
  const logPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "routing.audit.jsonl");
  const auditLogger = new ModelRouteAuditLogger({ path: logPath });

  class FailingRegenerationUseCase extends RegenerateFleetAgentsUseCase {
    override async execute(): Promise<never> {
      throw new Error("REGENERATION_FAILED_TEST");
    }
  }

  const failingRegen = new FailingRegenerationUseCase(catalog, quarantine, auditLogger);

  const bootManager = new WindowsModelRouteBootManager({
    workspaceRoot: TEST_DIR,
    manifestPath: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "manifest.json"),
    catalog,
    canary: new CustomCanary(),
    selectParentModel: async () => "google/antigravity-gemini-3.6-flash-tiered",
    fleetRegeneration: failingRegen,
  });

  await assert.rejects(
    async () => bootManager.start(),
    (err: Error) => err.message === "REGENERATION_FAILED_TEST",
  );

  assert.equal(bootManager.getState(), "failed");
  assert.equal(process.env["SDD_MODEL_ROUTING_BOOT_ID"], undefined);
  assert.equal(process.env["SDD_MODEL_ROUTING_SIGNING_KEY"], undefined);

  const attestationPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "attestation.json");
  assert.equal(existsSync(attestationPath), false);
});

test("supervised boot exposes routing secrets to the dispatching OpenCode process", async () => {
  setupTestEnv();
  delete process.env[ROUTING_BOOT_ID_ENV];
  delete process.env[ROUTING_SIGNING_KEY_ENV];

  const catalog = new MockCatalog();
  const quarantine = new MockQuarantine();
  const auditLogger = new ModelRouteAuditLogger({
    path: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "routing.audit.jsonl"),
  });
  const child: BootChildProcess = {
    kill: () => true,
    once: () => child,
  };
  const supervisor: BootProcessSupervisor = {
    spawnServe: () => child,
    waitForHealthy: async () => undefined,
    spawnAttach: () => child,
  };
  const catalogSync = { execute: async () => undefined };

  const manager = new WindowsModelRouteBootManager({
    workspaceRoot: TEST_DIR,
    manifestPath: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "manifest.json"),
    catalog,
    canary: new CustomCanary(),
    catalogSync,
    processSupervisor: supervisor,
    selectParentModel: async () => "google/antigravity-gemini-3.6-flash-tiered",
    fleetRegeneration: new RegenerateFleetAgentsUseCase(catalog, quarantine, auditLogger),
    routesConfigPath: path.join(TEST_DIR, "config", "model-routing", "routes.json"),
  });

  await manager.start();
  assert.equal(process.env[ROUTING_BOOT_ID_ENV], manager.getBootIdentity());
  assert.equal(process.env[ROUTING_SIGNING_KEY_ENV], manager.getSigningKey().toString("hex"));
  await manager.stop();
  await auditLogger.close();
});

/** Build the standard supervised manager used by the preflight ordering tests. */
function buildPreflightHarness(supervisorOverrides: Partial<BootProcessSupervisor>) {
  const catalog = new MockCatalog();
  const quarantine = new MockQuarantine();
  const auditLogger = new ModelRouteAuditLogger({
    path: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "routing.audit.jsonl"),
  });
  const child: BootChildProcess = { kill: () => true, once: () => child };
  const calls: string[] = [];

  const supervisor: BootProcessSupervisor = {
    preflight: async () => { calls.push("preflight"); },
    spawnServe: () => { calls.push("spawnServe"); return child; },
    waitForHealthy: async () => { calls.push("waitForHealthy"); },
    spawnAttach: () => { calls.push("spawnAttach"); return child; },
    ...supervisorOverrides,
  };

  const manager = new WindowsModelRouteBootManager({
    workspaceRoot: TEST_DIR,
    manifestPath: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "manifest.json"),
    catalog,
    canary: new CustomCanary(),
    catalogSync: { execute: async () => undefined },
    processSupervisor: supervisor,
    selectParentModel: async () => "google/antigravity-gemini-3.6-flash-tiered",
    fleetRegeneration: new RegenerateFleetAgentsUseCase(catalog, quarantine, auditLogger),
    routesConfigPath: path.join(TEST_DIR, "config", "model-routing", "routes.json"),
  });

  return { manager, auditLogger, calls };
}

test("supervised boot probes the port before spawning its serve child", async () => {
  setupTestEnv();
  const { manager, auditLogger, calls } = buildPreflightHarness({});

  await manager.start();
  try {
    assert.deepEqual(
      calls.slice(0, 3),
      ["preflight", "spawnServe", "waitForHealthy"],
      "the port probe must run before the serve child is spawned",
    );
  } finally {
    await manager.stop();
    await auditLogger.close();
  }
});

test("a failed port preflight aborts the boot without spawning serve or publishing readiness", async () => {
  setupTestEnv();
  const { manager, auditLogger, calls } = buildPreflightHarness({
    preflight: async () => {
      calls.push("preflight");
      throw new Error("OPENCODE_PORT_IN_USE: 127.0.0.1:4096 is already accepting connections");
    },
  });

  try {
    await assert.rejects(() => manager.start(), /OPENCODE_PORT_IN_USE/);
    assert.equal(calls.includes("spawnServe"), false, "serve must not be spawned after a failed preflight");
    assert.equal(calls.includes("spawnAttach"), false, "attach must not be spawned after a failed preflight");

    const attestationPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "attestation.json");
    assert.equal(existsSync(attestationPath), false, "a failed preflight must not publish readiness");
  } finally {
    await auditLogger.close();
  }
});

test("routing readiness contract matches the installed OpenCode runtime", async () => {
  const { REQUIRED_OPENCODE_VERSION } = await import(
    "../src/infrastructure/opencode/model-route-readiness.js"
  );
  assert.equal(REQUIRED_OPENCODE_VERSION, "1.18.16");
});
