/**
 * RED-first — persisted routing handshake contract.
 *
 * The supervisor distributes boot credentials (bootIdentity + HMAC
 * signing key) through process env vars, which only reach the
 * supervisor process itself and its supervised `opencode serve`
 * child. An interactive OpenCode started outside the supervisor
 * never inherits them, so deterministic routing fails closed with
 * ROUTING_NOT_CONFIGURED even while a healthy supervisor is running.
 *
 * The persisted handshake closes that gap:
 *
 *   1. On `ready`, the boot manager writes
 *      `.opencode/sdd-model-routing/handshake.json` containing the
 *      bootIdentity, the hex-encoded signing key, the supervisor pid,
 *      and an issuedAt epoch. The file is mode 0o600 and ACL'd to the
 *      current user, same as boot-control.json.
 *   2. The handshake is removed on stop(), on a failed start, and a
 *      stale handshake from a previous boot is removed at the start
 *      of every new boot (before the fresh one is published).
 *   3. `readRoutingHandshake(workspaceRoot)` is the consumer-side
 *      read path used by the bootstrap resolvers when the env vars
 *      are absent. It returns null (fail closed) when the file is
 *      missing, corrupt, has an invalid key shape, or when its
 *      bootIdentity does not match the live attestation — a stale
 *      handshake from a dead supervisor must never sign anything.
 *   4. `stopModelRouteSupervisor` removes the handshake artifact
 *      alongside attestation/lock/control when a handshakePath is
 *      provided.
 */

import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

import { WindowsModelRouteBootManager } from "../src/infrastructure/runtime/windows-model-route-boot-manager.js";
import {
  readRoutingHandshake,
  ROUTING_HANDSHAKE_FILENAME,
} from "../src/infrastructure/runtime/model-route-handshake.js";
import type { Manifest } from "../src/infrastructure/opencode/disk-agent-generator.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { CanaryHostTransport, CanarySession } from "../src/infrastructure/opencode/model-route-canary.js";
import { REQUIRED_OPENCODE_VERSION } from "../src/infrastructure/opencode/model-route-readiness.js";

function sleep(ms: number): Promise<void> { return new Promise<void>((r) => setTimeout(r, ms)); }
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function seedManifest(hostName: string, providerId: string, modelId: string, root: string): Manifest {
  const agentRelative = `.opencode/agents/${hostName}.md`;
  const commandRelative = `.opencode/commands/${hostName}.md`;
  const agentContent = `agent-${hostName}`;
  const commandContent = `command-${hostName}`;
  mkdirSync(path.join(root, ".opencode", "agents"), { recursive: true });
  mkdirSync(path.join(root, ".opencode", "commands"), { recursive: true });
  writeFileSync(path.join(root, agentRelative), agentContent);
  writeFileSync(path.join(root, commandRelative), commandContent);
  const body = {
    schemaVersion: 1 as const,
    generatorVersion: "1.0.0",
    generationEpoch: new Date().toISOString(),
    workspaceIdentity: path.resolve(root),
    routingNamespace: "v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
    routes: [{
      baseTemplate: "sdd-mr-base",
      providerId, modelId, hostName,
      agentFile: { relativePath: agentRelative, sha256: sha256(agentContent), bytes: agentContent.length },
      commandFile: { relativePath: commandRelative, sha256: sha256(commandContent), bytes: commandContent.length },
    }],
    fileHashes: [sha256(agentContent), sha256(commandContent)],
  };
  return { ...body, manifestHash: sha256(JSON.stringify(body)) } as Manifest;
}

class StubCatalog implements ModelRouteCatalogPort {
  private readonly known = new Set<string>();
  private readonly rows: RouteCandidate[] = [];
  addCanonical(providerId: string, modelId: string, modelName?: string): void {
    this.known.add(`${providerId}/${modelId}`);
    this.rows.push({ providerId, modelId, modelName: modelName ?? modelId });
  }
  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return this.known.has(`${providerId}/${modelId}`);
  }
  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> {
    return [...this.rows];
  }
}

class OrderingSync {
  async execute(): Promise<unknown> {
    return { refreshed: [] };
  }
}

class FakeCanaryTransport implements CanaryHostTransport {
  private readonly sessions: CanarySession[] = [];
  private counter = 0;
  private readonly invokedCommands: Array<{ parentModel: string; command: string; arguments: string }> = [];
  public mismatchModel: { providerID: string; modelID: string } | null = null;
  async createSession(input: { parentModel: string }): Promise<CanarySession> {
    const id = `sess-${this.counter++}`;
    if (this.mismatchModel) {
      const session: CanarySession = { id, model: this.mismatchModel };
      this.sessions.push(session);
      return session;
    }
    const [providerID, modelID] = input.parentModel.split("/");
    const session: CanarySession = providerID && modelID
      ? { id, model: { providerID, modelID } }
      : { id };
    this.sessions.push(session);
    return session;
  }
  async getSession(sessionId: string): Promise<CanarySession> {
    const found = this.sessions.find((s) => s.id === sessionId);
    if (!found) throw new Error(`unknown session ${sessionId}`);
    return found;
  }
  async invokeCommand(input: { sessionId: string; command: string; arguments: string; parentModel: string }): Promise<void> {
    this.invokedCommands.push({ parentModel: input.parentModel, command: input.command, arguments: input.arguments });
  }
  async listChildren(parentSessionId: string): Promise<ReadonlyArray<CanarySession>> {
    if (this.invokedCommands.length === 0) return [];
    const lastCall = this.invokedCommands[this.invokedCommands.length - 1]!;
    return [{ id: `child-of-${parentSessionId}-call-${this.invokedCommands.length}-${lastCall.command}` }];
  }
  async listMessages(_childSessionId: string): Promise<ReadonlyArray<unknown>> {
    const last = this.invokedCommands[this.invokedCommands.length - 1];
    if (!last) return [];
    return [
      { info: { role: "user", model: { providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered" } } },
      { info: { role: "assistant", providerID: "google", modelID: "antigravity-gemini-3.6-flash-tiered", finish: "stop", time: { completed: 1 } } },
    ];
  }
}

interface BootFixture {
  readonly workspaceRoot: string;
  readonly routingDir: string;
  readonly manifestPath: string;
  readonly handshakePath: string;
  readonly attestationPath: string;
  readonly catalog: StubCatalog;
  readonly canary: FakeCanaryTransport;
}

function seedBootFixture(root: string): BootFixture {
  const workspaceRoot = path.join(root, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
  const manifestPath = path.join(routingDir, "manifest.json");
  const hostName = "sdd-mr-v1-handshakehost";
  const manifest = seedManifest(hostName, "google", "antigravity-gemini-3.6-flash-tiered", workspaceRoot);
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const catalog = new StubCatalog();
  catalog.addCanonical("google", "antigravity-gemini-3.6-flash-tiered", "Gemini 3.6 Flash Tiered");
  return {
    workspaceRoot,
    routingDir,
    manifestPath,
    handshakePath: path.join(routingDir, ROUTING_HANDSHAKE_FILENAME),
    attestationPath: path.join(routingDir, "attestation.json"),
    catalog,
    canary: new FakeCanaryTransport(),
  };
}

function buildManager(fixture: BootFixture): WindowsModelRouteBootManager {
  return new WindowsModelRouteBootManager({
    workspaceRoot: fixture.workspaceRoot,
    manifestPath: fixture.manifestPath,
    catalog: fixture.catalog,
    canary: fixture.canary,
    catalogSync: new OrderingSync(),
    selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
    now: () => Date.now(),
  });
}

async function run(): Promise<void> {
  console.log("--- model route handshake (RED) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-handshake-"));
  try {
    // ---------- 1. handshake.json is published when the boot reaches ready ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case1"));
      const manager = buildManager(fixture);
      await manager.start();
      assert.equal(manager.getState(), "ready", "manager reaches ready");
      assert.ok(existsSync(fixture.handshakePath), "handshake.json exists while the supervisor is ready");
      const parsed = JSON.parse(readFileSync(fixture.handshakePath, "utf8")) as Record<string, unknown>;
      assert.equal(parsed["bootIdentity"], manager.getBootIdentity(), "handshake carries the live bootIdentity");
      assert.match(String(parsed["signingKey"]), /^[0-9a-f]{64}$/i, "handshake carries the hex-encoded 256-bit signing key");
      assert.equal(parsed["pid"], process.pid, "handshake identifies the supervisor pid");
      assert.equal(typeof parsed["issuedAt"], "number", "handshake carries an issuedAt epoch");
      await manager.stop();
      console.log("  pass: handshake.json is published on ready with identity, key, pid, issuedAt");
    }

    // ---------- 2. stop() removes the handshake ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case2"));
      const manager = buildManager(fixture);
      await manager.start();
      assert.ok(existsSync(fixture.handshakePath), "handshake exists before stop");
      await manager.stop();
      assert.ok(!existsSync(fixture.handshakePath), "handshake.json is removed on stop()");
      console.log("  pass: stop() removes the handshake artifact");
    }

    // ---------- 3. a failed start removes any stale handshake and publishes none ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case3"));
      writeFileSync(fixture.handshakePath, JSON.stringify({
        bootIdentity: "stale-boot",
        signingKey: "ab".repeat(32),
        pid: 1,
        issuedAt: 1,
      }));
      fixture.canary.mismatchModel = { providerID: "evil", modelID: "wrong" };
      const manager = buildManager(fixture);
      await assert.rejects(manager.start(), "canary mismatch fails the boot");
      assert.ok(!existsSync(fixture.handshakePath), "failed start leaves no handshake on disk");
      console.log("  pass: failed start clears the stale handshake and publishes nothing");
    }

    // ---------- 4. restart reuses the STABLE persisted secrets ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case4"));
      const first = buildManager(fixture);
      await first.start();
      const firstIdentity = first.getBootIdentity();
      await first.stop();
      const second = buildManager(fixture);
      await second.start();
      const parsed = JSON.parse(readFileSync(fixture.handshakePath, "utf8")) as Record<string, unknown>;
      assert.equal(second.getBootIdentity(), firstIdentity, "restart reuses the persisted bootIdentity (no per-boot rotation)");
      assert.equal(parsed["bootIdentity"], second.getBootIdentity(), "handshake reflects the stable boot");
      await second.stop();
      console.log("  pass: restart reuses the stable persisted secrets");
    }

    // ---------- 5. readRoutingHandshake resolves a consistent pair ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case5"));
      const manager = buildManager(fixture);
      await manager.start();
      const resolved = readRoutingHandshake(fixture.workspaceRoot);
      assert.ok(resolved !== null, "handshake resolves while the supervisor is ready");
      assert.equal(resolved.bootIdentity, manager.getBootIdentity());
      assert.match(resolved.signingKey, /^[0-9a-f]{64}$/i);
      await manager.stop();
      console.log("  pass: readRoutingHandshake returns the live credentials");
    }

    // ---------- 6. readRoutingHandshake fails closed after stop() ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case6"));
      const manager = buildManager(fixture);
      await manager.start();
      await manager.stop();
      assert.equal(readRoutingHandshake(fixture.workspaceRoot), null, "no handshake is resolvable once the supervisor stopped");
      console.log("  pass: readRoutingHandshake fails closed after stop");
    }

    // ---------- 7. readRoutingHandshake rejects a bootIdentity that does not match the attestation ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case7"));
      const manager = buildManager(fixture);
      await manager.start();
      writeFileSync(fixture.handshakePath, JSON.stringify({
        bootIdentity: "00000000-0000-4000-8000-000000000000",
        signingKey: "cd".repeat(32),
        pid: 1,
        issuedAt: 1,
      }));
      assert.equal(readRoutingHandshake(fixture.workspaceRoot), null, "mismatched bootIdentity is rejected");
      await manager.stop();
      console.log("  pass: readRoutingHandshake rejects a stale/mismatched bootIdentity");
    }

    // ---------- 8. readRoutingHandshake rejects corrupt and missing artifacts ----------
    {
      const fixture = seedBootFixture(path.join(tmp, "case8"));
      const manager = buildManager(fixture);
      await manager.start();
      const valid = readFileSync(fixture.handshakePath, "utf8");

      writeFileSync(fixture.handshakePath, "{not-json");
      assert.equal(readRoutingHandshake(fixture.workspaceRoot), null, "corrupt handshake JSON is rejected");

      writeFileSync(fixture.handshakePath, JSON.stringify({ bootIdentity: "x", signingKey: "not-hex" }));
      assert.equal(readRoutingHandshake(fixture.workspaceRoot), null, "invalid key shape is rejected");

      writeFileSync(fixture.handshakePath, valid);
      rmSync(fixture.attestationPath, { force: true });
      assert.equal(readRoutingHandshake(fixture.workspaceRoot), null, "missing attestation is rejected");
      await manager.stop();
      console.log("  pass: readRoutingHandshake rejects corrupt JSON, bad key shape, and missing attestation");
    }
  } finally {
    await cleanupDir(tmp);
  }

  console.log("model route handshake: all scenarios passed");
}

await run();
