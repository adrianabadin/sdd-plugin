/**
 * WU3 — partial-fleet boot readiness (planresolucion.md §3.3).
 *
 * The boot manager replaces the single `verifyEveryRoute` canary call
 * with `verifyRoutes`, then:
 *
 *   1. Fails closed with CANARY_FLEET_EMPTY when NOTHING is proven
 *      (a lone blocked route in a single-route fleet rethrows the
 *      CanaryBlockedError so the pre-WU3 contract stays intact).
 *   2. Audits `boot.route.canary_blocked` once per blocked route.
 *   3. Quarantines each blocked route (modelProvider, TTL 15 min,
 *      `reason: "canary <CODE>"`).
 *   4. Releases the generator lock, regenerates the fleet EXCLUDING
 *      the blocked canonicals, re-reads the manifest, and fails
 *      closed with CANARY_MANIFEST_MISMATCH when the regenerated
 *      host set differs from the proven canary host set.
 *   5. Issues the attestation with ONLY the proven evidence, re-acquires
 *      the lock, writes the control record + handshake, and reaches
 *      `ready` with `routes=<proven>/<configured> blocked=<n>`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  WindowsModelRouteBootManager,
  ROUTING_BOOT_ID_ENV,
  ROUTING_SIGNING_KEY_ENV,
  CANARY_QUARANTINE_TTL_MS,
  CanaryFleetEmptyError,
  CanaryManifestMismatchError,
  type BootAuditPort,
} from "../src/infrastructure/runtime/windows-model-route-boot-manager.js";
import {
  CanaryBlockedError,
  type CanaryHostTransport,
  type CanarySession,
} from "../src/infrastructure/opencode/model-route-canary.js";
import { REQUIRED_OPENCODE_VERSION } from "../src/infrastructure/opencode/model-route-readiness.js";
import { ModelRouteAuditLogger } from "../src/infrastructure/logging/model-route-audit.logger.js";
import { RegenerateFleetAgentsUseCase } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";
import type { GeneratedRoute, Manifest, ManifestRouteEntry } from "../src/infrastructure/opencode/disk-agent-generator.js";
import type { RegenerateFleetAgentsInput, RegenerateFleetAgentsOutput } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.input.js";
import type { ExcludedRoute } from "../src/application/filter-fleet-routes/filter-fleet-routes.input.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";

const TEST_DIR = path.resolve("./scratch/test-boot-partial-fleet");
const NOW = 1_800_000_000_000;

// ---------------------------------------------------------------------------
// Routes under test
// ---------------------------------------------------------------------------

const ROUTES: ReadonlyArray<{ hostName: string; providerId: string; modelId: string; parent: string; baseTemplate: string }> = [
  { hostName: "sdd-mr-v1-pf-a", providerId: "google", modelId: "antigravity-gemini-3.6-flash-tiered", parent: "anthropic/claude-haiku-4-5", baseTemplate: "sdd-mr-base" },
  { hostName: "sdd-mr-v1-pf-b", providerId: "anthropic", modelId: "claude-3-5-sonnet", parent: "google/gemini-2.0-flash", baseTemplate: "sdd-mr-base" },
  { hostName: "sdd-mr-v1-pf-c", providerId: "openai", modelId: "gpt-4o", parent: "openai/gpt-5.6-luna", baseTemplate: "sdd-mr-base" },
];

const CANONICAL_OF = (route: { providerId: string; modelId: string }): string => `${route.providerId}/${route.modelId}`;
const HOST_OF: Record<string, { providerId: string; modelId: string }> = Object.fromEntries(
  ROUTES.map((r) => [r.hostName, { providerId: r.providerId, modelId: r.modelId }]),
);

// ---------------------------------------------------------------------------
// fs / crypto helpers
// ---------------------------------------------------------------------------

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function setupTestEnv(): void {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
}

function clearRoutingEnv(): void {
  delete process.env[ROUTING_BOOT_ID_ENV];
  delete process.env[ROUTING_SIGNING_KEY_ENV];
}

/** Write the agent/command files and return the manifest route entries. */
function writeRouteFiles(root: string, routes: ReadonlyArray<{ hostName: string; providerId: string; modelId: string; baseTemplate: string }>): ManifestRouteEntry[] {
  return routes.map((route) => {
    const agentRelative = path.join(".opencode", "agents", `${route.hostName}.md`);
    const commandRelative = path.join(".opencode", "commands", `${route.hostName}.md`);
    const agentContent = `agent-${route.hostName}`;
    const commandContent = `command-${route.hostName}`;
    mkdirSync(path.dirname(path.join(root, agentRelative)), { recursive: true });
    mkdirSync(path.dirname(path.join(root, commandRelative)), { recursive: true });
    writeFileSync(path.join(root, agentRelative), agentContent);
    writeFileSync(path.join(root, commandRelative), commandContent);
    return {
      baseTemplate: route.baseTemplate,
      providerId: route.providerId,
      modelId: route.modelId,
      hostName: route.hostName,
      agentFile: { relativePath: agentRelative, sha256: sha256(agentContent), bytes: Buffer.byteLength(agentContent, "utf8") },
      commandFile: { relativePath: commandRelative, sha256: sha256(commandContent), bytes: Buffer.byteLength(commandContent, "utf8") },
    };
  });
}

function buildManifest(root: string, entries: ReadonlyArray<ManifestRouteEntry>, generationEpoch: string): Manifest {
  const body: Omit<Manifest, "manifestHash"> = {
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    generationEpoch,
    workspaceIdentity: path.resolve(root),
    routingNamespace: "sdd-mr-v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
    routes: [...entries],
    fileHashes: entries.flatMap((r) => [r.agentFile.sha256, r.commandFile.sha256]).sort(),
  };
  return { ...body, manifestHash: sha256(JSON.stringify(body)) };
}

function writeManifest(root: string, manifest: Manifest): string {
  const manifestPath = path.join(root, ".opencode", "sdd-model-routing", "manifest.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return manifestPath;
}

function readManifest(root: string): Manifest {
  return JSON.parse(readFileSync(path.join(root, ".opencode", "sdd-model-routing", "manifest.json"), "utf8")) as Manifest;
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------

class StubCatalog implements ModelRouteCatalogPort {
  private readonly known = new Set<string>();
  addCanonical(providerId: string, modelId: string): void {
    this.known.add(`${providerId}/${modelId}`);
  }
  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return this.known.has(`${providerId}/${modelId}`);
  }
  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    return [];
  }
}

/**
 * Canary transport that blocks routes whose canonical id is in
 * `failTargets`: `listChildren` returns `[]` for them, so the canary
 * fails with CHILD_SESSION_MISSING after `1 + retries` attempts.
 * Every other route is proven with target-identity messages.
 */
class SelectiveFailCanaryTransport implements CanaryHostTransport {
  private counter = 0;
  private readonly sessions: CanarySession[] = [];
  private readonly targetByParent = new Map<string, { providerId: string; modelId: string }>();
  private readonly targetByChild = new Map<string, { providerId: string; modelId: string }>();

  constructor(private readonly failTargets: ReadonlySet<string>) {}

  async createSession(input: { parentModel: string }): Promise<CanarySession> {
    const [providerID, modelID] = input.parentModel.split("/");
    const session: CanarySession = { id: `sess-${this.counter++}`, model: { providerID: providerID!, modelID: modelID! } };
    this.sessions.push(session);
    return session;
  }

  async getSession(sessionId: string): Promise<CanarySession> {
    return this.sessions.find((s) => s.id === sessionId) ?? { id: sessionId };
  }

  async invokeCommand(input: { sessionId: string; command: string; arguments: string; parentModel: string }): Promise<void> {
    const hostName = input.arguments.slice("sdd-model-routing-canary:".length);
    const target = HOST_OF[hostName];
    if (target) this.targetByParent.set(input.sessionId, target);
  }

  async listChildren(parentSessionId: string): Promise<ReadonlyArray<CanarySession>> {
    const target = this.targetByParent.get(parentSessionId);
    if (target && this.failTargets.has(`${target.providerId}/${target.modelId}`)) return [];
    const child: CanarySession = { id: `child-${parentSessionId}-${this.counter++}` };
    if (target) this.targetByChild.set(child.id, target);
    return [child];
  }

  async listMessages(childSessionId: string): Promise<ReadonlyArray<unknown>> {
    const target = this.targetByChild.get(childSessionId);
    if (!target) return [];
    return [
      { info: { role: "user", model: { providerID: target.providerId, modelID: target.modelId } } },
      { info: { role: "assistant", providerID: target.providerId, modelID: target.modelId, finish: "stop", time: { completed: 1 } } },
    ];
  }
}

class RecordingQuarantine implements QuarantineWritePort {
  readonly commands: SetQuarantineCommand[] = [];
  async setQuarantine(cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
    this.commands.push(cmd);
    return {
      level: cmd.level,
      providerId: cmd.providerId,
      modelId: cmd.modelId,
      type: cmd.type,
      until: cmd.until,
      reason: cmd.reason,
    };
  }
  async releaseQuarantine(_target: QuarantineTarget): Promise<void> { /* noop */ }
  async listQuarantines(): Promise<QuarantineEntry[]> { return []; }
}

class RecordingAudit implements BootAuditPort {
  readonly entries: Array<Record<string, unknown>> = [];
  async append(entry: Record<string, unknown>): Promise<void> {
    this.entries.push(entry);
  }
}

/**
 * Regeneration fake: extends the real nominal use case (private fields)
 * and overrides execute() to rewrite the manifest on disk, sweeping the
 * excluded routes' agent/command files. `ignoreExclusionsNext` forces
 * the full fleet to be written once (host-set mismatch scenario).
 */
class PartialFleetRegeneration extends RegenerateFleetAgentsUseCase {
  readonly calls: Array<{ excludeCanonicalIds?: ReadonlySet<string> }> = [];
  ignoreExclusionsNext = false;

  constructor(
    catalog: ModelRouteCatalogPort,
    quarantine: QuarantineWritePort,
    auditLogger: ModelRouteAuditLogger,
    private readonly root: string,
    private readonly allRoutes: ReadonlyArray<ManifestRouteEntry>,
  ) {
    super(catalog, quarantine, auditLogger);
  }

  override async execute(input: RegenerateFleetAgentsInput): Promise<RegenerateFleetAgentsOutput> {
    this.calls.push({ excludeCanonicalIds: input.excludeCanonicalIds });

    const excludedIds = new Set<string>();
    for (const canonical of input.excludeCanonicalIds ?? []) {
      const route = this.allRoutes.find((r) => CANONICAL_OF(r) === canonical);
      if (!route) continue;
      excludedIds.add(canonical);
      rmSync(path.join(this.root, route.agentFile.relativePath), { force: true });
      rmSync(path.join(this.root, route.commandFile.relativePath), { force: true });
    }

    const excludedRoutes = this.allRoutes.filter((r) => excludedIds.has(CANONICAL_OF(r)));
    const excluded: ExcludedRoute[] = excludedRoutes.map((r) => ({
      route: { baseTemplate: r.baseTemplate, providerId: r.providerId, modelId: r.modelId, hostName: r.hostName },
      reason: "CANARY_BLOCKED",
      detail: `canary blocked ${CANONICAL_OF(r)}`,
    }));
    const routes = this.ignoreExclusionsNext
      ? [...this.allRoutes]
      : this.allRoutes.filter((r) => !excludedIds.has(CANONICAL_OF(r)));

    const generated: GeneratedRoute[] = routes.map((r) => ({
      baseTemplate: r.baseTemplate,
      providerId: r.providerId,
      modelId: r.modelId,
      hostName: r.hostName,
      agentRelative: r.agentFile.relativePath,
      commandRelative: r.commandFile.relativePath,
    }));

    const body: Omit<Manifest, "manifestHash"> = {
      schemaVersion: 1,
      generatorVersion: "1.1.0",
      generationEpoch: "epoch-pf-regen",
      workspaceIdentity: path.resolve(this.root),
      routingNamespace: "sdd-mr-v1",
      descriptorBudgetBytes: 4096,
      requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
      routes,
      fileHashes: routes.flatMap((r) => [r.agentFile.sha256, r.commandFile.sha256]).sort(),
    };
    const manifestHash = sha256(JSON.stringify(body));
    writeManifest(this.root, { ...body, manifestHash });

    return {
      generated,
      excluded,
      manifestHash,
      sweptRelativePaths: excludedRoutes.flatMap((r) => [r.agentFile.relativePath, r.commandFile.relativePath]),
    };
  }
}

/** Capture stdout written while `fn` runs (ready-line assertion). */
async function withCapturedStdout(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    lines.push(String(chunk));
    return originalWrite(chunk as never, ...(rest as never[]));
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Boot harness
// ---------------------------------------------------------------------------

function makeHarness(opts: { failTargets: ReadonlySet<string>; routes?: ReadonlyArray<{ hostName: string; providerId: string; modelId: string; parent: string; baseTemplate: string }> }) {
  const routes = opts.routes ?? ROUTES;
  const entries = writeRouteFiles(TEST_DIR, routes);
  const manifest = buildManifest(TEST_DIR, entries, "epoch-pf-seed");
  const manifestPath = writeManifest(TEST_DIR, manifest);

  const catalog = new StubCatalog();
  for (const route of routes) catalog.addCanonical(route.providerId, route.modelId);

  const transport = new SelectiveFailCanaryTransport(opts.failTargets);
  const quarantine = new RecordingQuarantine();
  const audit = new RecordingAudit();
  const parentByTarget = new Map(routes.map((r) => [CANONICAL_OF(r), r.parent]));
  const auditLogger = new ModelRouteAuditLogger({ path: path.join(TEST_DIR, ".opencode", "sdd-model-routing", "routing.audit.jsonl") });
  const regeneration = new PartialFleetRegeneration(catalog, quarantine, auditLogger, TEST_DIR, entries);

  const manager = new WindowsModelRouteBootManager({
    workspaceRoot: TEST_DIR,
    manifestPath,
    catalog,
    canary: transport,
    selectParentModel: async (target) => parentByTarget.get(target) ?? null,
    fleetRegeneration: regeneration,
    quarantine,
    audit,
    now: () => NOW,
  });

  return { manager, catalog, transport, quarantine, audit, regeneration, manifestPath };
}

async function stopQuietly(manager: WindowsModelRouteBootManager): Promise<void> {
  try { await manager.stop(); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

test("S1: partial fleet reaches ready with proven evidence, regenerated manifest, re-acquired lock, and handshake", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const h = makeHarness({ failTargets: new Set(["openai/gpt-4o"]) });

  const stdoutLines = await withCapturedStdout(async () => {
    await h.manager.start();
  });

  try {
    assert.equal(h.manager.getState(), "ready", "manager reaches ready with a partial fleet");

    // Regeneration ran twice: full fleet first, then excluding the blocked route.
    assert.equal(h.regeneration.calls.length, 2, "regeneration runs once per fleet rewrite");
    assert.equal(h.regeneration.calls[0]!.excludeCanonicalIds, undefined, "first regeneration excludes nothing");
    assert.ok(h.regeneration.calls[1]!.excludeCanonicalIds, "second regeneration carries exclusions");
    assert.equal(h.regeneration.calls[1]!.excludeCanonicalIds!.size, 1, "exactly one canonical excluded");
    assert.ok(h.regeneration.calls[1]!.excludeCanonicalIds!.has("openai/gpt-4o"), "blocked canonical is excluded");

    // On-disk manifest was reduced to the two proven routes.
    const diskManifest = readManifest(TEST_DIR);
    assert.equal(diskManifest.routes.length, 2, "regenerated manifest keeps only proven routes");
    const diskIds = diskManifest.routes.map((r) => CANONICAL_OF(r)).sort();
    assert.deepEqual(diskIds, ["anthropic/claude-3-5-sonnet", "google/antigravity-gemini-3.6-flash-tiered"]);
    assert.equal(diskManifest.generationEpoch, "epoch-pf-regen", "attestation binds the regenerated epoch");

    // Attestation covers exactly the two proven routes.
    const attestationPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "attestation.json");
    assert.ok(existsSync(attestationPath), "attestation published");
    const attestation = readJson(attestationPath) as { canaries: Array<{ hostName: string; targetCanonicalId: string }>; manifestHash: string; generationEpoch: string };
    assert.equal(attestation.canaries.length, 2, "attestation carries only proven canaries");
    assert.deepEqual(attestation.canaries.map((c) => c.hostName).sort(), ["sdd-mr-v1-pf-a", "sdd-mr-v1-pf-b"]);
    assert.ok(!attestation.canaries.some((c) => c.targetCanonicalId === "openai/gpt-4o"), "blocked route never appears in the attestation");
    assert.equal(attestation.manifestHash, diskManifest.manifestHash, "attestation binds the regenerated manifest hash");
    assert.equal(attestation.generationEpoch, "epoch-pf-regen", "attestation binds the regenerated epoch");

    // Lock was re-acquired with the live boot identity.
    const lockPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "generator.lock");
    assert.ok(existsSync(lockPath), "generator lock re-acquired after regeneration");
    const lock = readJson(lockPath) as { bootIdentity: string };
    assert.equal(lock.bootIdentity, h.manager.getBootIdentity(), "lock belongs to the live boot");

    // Handshake published.
    const handshakePath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "handshake.json");
    assert.ok(existsSync(handshakePath), "handshake published");
    const handshake = readJson(handshakePath) as { bootIdentity: string };
    assert.equal(handshake.bootIdentity, h.manager.getBootIdentity(), "handshake binds the live boot identity");

    // Env distribution is live.
    assert.equal(process.env[ROUTING_BOOT_ID_ENV], h.manager.getBootIdentity(), "boot id env live while ready");

    // Ready line.
    const readyLine = stdoutLines.find((l) => l.startsWith("boot: state=ready"));
    assert.ok(readyLine, `ready line printed (got ${JSON.stringify(stdoutLines)})`);
    assert.match(readyLine!, /bootIdentity=[0-9a-f-]{36}/, "ready line carries the boot identity");
    assert.match(readyLine!, /routes=2\/3 blocked=1/, "ready line reports proven/configured + blocked counts");
  } finally {
    await stopQuietly(h.manager);
  }

  assert.equal(process.env[ROUTING_BOOT_ID_ENV], undefined, "stop() clears the boot id env var");
  assert.equal(process.env[ROUTING_SIGNING_KEY_ENV], undefined, "stop() clears the signing key env var");
  clearRoutingEnv();
});

test("S2: blocked route is quarantined modelProvider/ttl for CANARY_QUARANTINE_TTL_MS with reason canary <CODE>", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const h = makeHarness({ failTargets: new Set(["openai/gpt-4o"]) });
  await h.manager.start();

  try {
    assert.equal(h.quarantine.commands.length, 1, "exactly one quarantine record for the blocked route");
    const cmd = h.quarantine.commands[0]!;
    assert.equal(cmd.level, "modelProvider", "quarantine level is modelProvider");
    assert.equal(cmd.providerId, "openai", "provider id split before the first slash");
    assert.equal(cmd.modelId, "gpt-4o", "model id split after the first slash");
    assert.equal(cmd.type, "ttl", "quarantine type is ttl");
    assert.ok(cmd.until, "ttl quarantine carries an expiry");
    assert.equal(cmd.until!.getTime() - NOW, CANARY_QUARANTINE_TTL_MS, "expiry is now + CANARY_QUARANTINE_TTL_MS");
    assert.equal(cmd.reason, "canary CHILD_SESSION_MISSING", "reason surfaces the canary code");
  } finally {
    await stopQuietly(h.manager);
  }
  clearRoutingEnv();
});

test("S3: boot.route.canary_blocked audit entry per blocked route with full failure detail", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const h = makeHarness({ failTargets: new Set(["openai/gpt-4o"]) });
  await h.manager.start();

  try {
    assert.equal(h.audit.entries.length, 1, "one audit entry for the blocked route");
    const entry = h.audit.entries[0]!;
    assert.equal(entry["stage"], "boot.route.canary_blocked", "audit stage is boot.route.canary_blocked");
    assert.equal(entry["hostName"], "sdd-mr-v1-pf-c", "audit entry names the blocked host");
    assert.equal(entry["targetCanonicalId"], "openai/gpt-4o", "audit entry names the blocked canonical");
    assert.equal(entry["code"], "CHILD_SESSION_MISSING", "audit entry carries the canary code");
    assert.equal(entry["attempts"], 2, "audit entry reports the retried attempt count");
    assert.ok(typeof entry["message"] === "string" && (entry["message"] as string).length > 0, "audit entry carries the canary message");
  } finally {
    await stopQuietly(h.manager);
  }
  clearRoutingEnv();
});

test("S4: whole-fleet failure fails closed with CANARY_FLEET_EMPTY and no side effects", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const h = makeHarness({ failTargets: new Set(ROUTES.map(CANONICAL_OF)) });

  let thrown: unknown = null;
  try { await h.manager.start(); } catch (error) { thrown = error; }

  assert.ok(thrown instanceof CanaryFleetEmptyError, "whole-fleet failure throws CanaryFleetEmptyError");
  assert.equal((thrown as CanaryFleetEmptyError).code, "CANARY_FLEET_EMPTY", "error code is CANARY_FLEET_EMPTY");
  assert.equal(h.manager.getState(), "failed", "manager ends in failed state");
  assert.equal(h.regeneration.calls.length, 1, "no second regeneration happens on fleet-empty");
  assert.equal(h.quarantine.commands.length, 0, "no quarantine on fleet-empty");
  assert.equal(h.audit.entries.length, 0, "no audit on fleet-empty");

  const routingDir = path.join(TEST_DIR, ".opencode", "sdd-model-routing");
  assert.ok(!existsSync(path.join(routingDir, "attestation.json")), "no attestation published");
  assert.ok(!existsSync(path.join(routingDir, "handshake.json")), "no handshake published");
  assert.ok(!existsSync(path.join(routingDir, "generator.lock")), "lock released");
  assert.equal(process.env[ROUTING_BOOT_ID_ENV], undefined, "boot id env cleared");
  assert.equal(process.env[ROUTING_SIGNING_KEY_ENV], undefined, "signing key env cleared");
});

test("S5: regenerated manifest host set mismatch fails closed with CANARY_MANIFEST_MISMATCH", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const h = makeHarness({ failTargets: new Set(["openai/gpt-4o"]) });
  h.regeneration.ignoreExclusionsNext = true;

  let thrown: unknown = null;
  try { await h.manager.start(); } catch (error) { thrown = error; }

  assert.ok(thrown instanceof CanaryManifestMismatchError, "host-set mismatch throws CanaryManifestMismatchError");
  assert.equal((thrown as CanaryManifestMismatchError).code, "CANARY_MANIFEST_MISMATCH", "error code is CANARY_MANIFEST_MISMATCH");
  assert.equal(h.manager.getState(), "failed", "manager ends in failed state");
  assert.equal(h.regeneration.calls.length, 2, "mismatch surfaces after the exclusion regeneration");

  const routingDir = path.join(TEST_DIR, ".opencode", "sdd-model-routing");
  assert.ok(!existsSync(path.join(routingDir, "attestation.json")), "no attestation published on mismatch");
  assert.ok(!existsSync(path.join(routingDir, "handshake.json")), "no handshake published on mismatch");
  assert.ok(!existsSync(path.join(routingDir, "generator.lock")), "lock released on mismatch");
  assert.equal(process.env[ROUTING_BOOT_ID_ENV], undefined, "boot id env cleared");
  assert.equal(process.env[ROUTING_SIGNING_KEY_ENV], undefined, "signing key env cleared");
});

test("S6: no blocked routes keeps today's single-regeneration, full-fleet behavior", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const h = makeHarness({ failTargets: new Set() });

  const stdoutLines = await withCapturedStdout(async () => {
    await h.manager.start();
  });

  try {
    assert.equal(h.manager.getState(), "ready", "full fleet reaches ready");
    assert.equal(h.regeneration.calls.length, 1, "regeneration runs exactly once");
    assert.equal(h.quarantine.commands.length, 0, "no quarantine when nothing is blocked");
    assert.equal(h.audit.entries.length, 0, "no audit when nothing is blocked");

    const lockPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "generator.lock");
    assert.ok(existsSync(lockPath), "lock retained through issue()");
    const lock = readJson(lockPath) as { bootIdentity: string };
    assert.equal(lock.bootIdentity, h.manager.getBootIdentity(), "lock belongs to the live boot");

    const attestationPath = path.join(TEST_DIR, ".opencode", "sdd-model-routing", "attestation.json");
    const attestation = readJson(attestationPath) as { canaries: Array<{ hostName: string }> };
    assert.equal(attestation.canaries.length, 3, "attestation covers the full fleet");

    const readyLine = stdoutLines.find((l) => l.startsWith("boot: state=ready"));
    assert.ok(readyLine, "ready line printed");
    assert.match(readyLine!, /routes=3\/3 blocked=0/, "ready line reports a full fleet");
  } finally {
    await stopQuietly(h.manager);
  }
  clearRoutingEnv();
});

test("S7: single-route fleet failure still throws CanaryBlockedError (never CANARY_FLEET_EMPTY)", async () => {
  setupTestEnv();
  clearRoutingEnv();
  const singleRoute = [ROUTES[2]!];
  const h = makeHarness({ failTargets: new Set(["openai/gpt-4o"]), routes: singleRoute });

  let thrown: unknown = null;
  try { await h.manager.start(); } catch (error) { thrown = error; }

  assert.ok(thrown instanceof CanaryBlockedError, "single-route fleet failure throws CanaryBlockedError");
  assert.equal((thrown as CanaryBlockedError).code, "CHILD_SESSION_MISSING", "original canary code preserved");
  assert.equal(h.manager.getState(), "failed", "manager ends in failed state");
  assert.equal(h.regeneration.calls.length, 1, "no regeneration for a failed single-route fleet");
  assert.equal(h.quarantine.commands.length, 0, "no quarantine on the single-route rethrow path");
  assert.equal(h.audit.entries.length, 0, "no audit on the single-route rethrow path");

  const routingDir = path.join(TEST_DIR, ".opencode", "sdd-model-routing");
  assert.ok(!existsSync(path.join(routingDir, "attestation.json")), "no attestation published");
  assert.equal(process.env[ROUTING_BOOT_ID_ENV], undefined, "boot id env cleared");
  assert.equal(process.env[ROUTING_SIGNING_KEY_ENV], undefined, "signing key env cleared");
});
