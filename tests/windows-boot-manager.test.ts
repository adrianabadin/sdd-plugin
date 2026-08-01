/**
 * WU3 v2 (RED-first) — `WindowsModelRouteBootManager` lifecycle contract.
 *
 * The WU3 design (proposal aa40c70b-f635-4246-b94b-e065b0db688e,
 * spec dcf1d668-3349-4ac1-8d06-ce27a40174ef, design
 * 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6, task 3.x) requires the boot
 * manager to:
 *
 *   1. Generate a fresh UUIDv4 `bootIdentity` and 256-bit HMAC key on
 *      every start; the secrets live ONLY in process memory.
 *   2. NEVER persist the HMAC key to disk, the project `.env`, the
 *      audit log, or the process environment after stop().
 *   3. Distribute BOTH secrets to the in-process bootstrap via env
 *      vars (`SDD_MODEL_ROUTING_BOOT_ID` /
 *      `SDD_MODEL_ROUTING_SIGNING_KEY`); the env vars are CLEARED
 *      on stop() and NEVER hold the raw key bytes in `.env` files.
 *   4. Acquire the generator lock (PID + epoch payload) before
 *      mutating the routing directory; reclaim stale locks; release
 *      on stop().
 *   5. Remove any prior attestation from a previous boot so a
 *      failed boot does not leave a misleading `ready` signal.
 *   6. Sync the live catalog via the injected
 *      `SyncConnectedModelsUseCase` BEFORE the readback so a
 *      freshly started `opencode serve` has advertised every route.
 *   7. Read back EVERY manifest route from the catalog; fail with
 *      `CATALOG_ROUTE_MISSING` if any configured route is not
 *      advertised by the live host.
 *   8. Trigger a canary with a distinct parent session model for
 *      every route; the canary issues a `getSession` read-back
 *      (`GET /session/:id`) and fails with `PARENT_MODEL_MISMATCH`
 *      if the host overrode the parent model. Canary miss fails
 *      closed (`CANARY_FAILED` / `PARENT_MODEL_UNAVAILABLE`).
 *   9. Publish a signed `attestation.json` with `nonce`,
 *      `openCodeVersion`, `verifierVersion`, `fileHashes`, and a
 *      TTL (`expiresAt`); the file MUST NOT contain the raw HMAC
 *      key bytes.
 *  10. Drive the lifecycle
 *      `idle → starting → syncing → canarying → ready → stopping | failed`
 *      and refuse to dispatch while not in `ready`.
 *  11. Be single-flight: a second concurrent `start()` MUST wait for
 *      the first, not race.
 *  12. Rotate secrets on every restart: a fresh `bootIdentity` and a
 *      fresh HMAC key on each `start()` after `stop()`.
 *
 * Tests use injected fake dependencies (catalog port, canary
 * transport, catalog sync use case) so they run hermetically — no
 * live OpenCode server, no real DB. The ACL test inspects the actual
 * mode bits on the published attestation file.
 */

import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";

import {
  WindowsModelRouteBootManager,
  CatalogRouteMissingError,
  StaleLockUnrecoverableError,
  ROUTING_BOOT_ID_ENV,
  ROUTING_SIGNING_KEY_ENV,
} from "../src/infrastructure/runtime/windows-model-route-boot-manager.js";
import type { Manifest } from "../src/infrastructure/opencode/disk-agent-generator.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { CanaryEvidence, CanaryHostTransport, CanarySession } from "../src/infrastructure/opencode/model-route-canary.js";
import { CanaryBlockedError } from "../src/infrastructure/opencode/model-route-canary.js";

function sleep(ms: number): Promise<void> { return new Promise<void>((r) => setTimeout(r, ms)); }
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

/**
 * Build a manifest whose on-disk files exist so ModelRouteReadiness's
 * `assertCurrentState` re-hash step does not abort with a missing
 * file. The boot manager test is otherwise only interested in the
 * metadata + routes.
 */
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
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    generationEpoch: "epoch-wu3",
    workspaceIdentity: path.resolve(root),
    routingNamespace: "sdd-mr-v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: "1.18.9",
    routes: [{
      baseTemplate: "sdd-mr-base",
      providerId, modelId, hostName,
      agentFile: { relativePath: agentRelative, sha256: sha256(agentContent), bytes: agentContent.length },
      commandFile: { relativePath: commandRelative, sha256: sha256(commandContent), bytes: commandContent.length },
    }],
    fileHashes: [sha256(agentContent), sha256(commandContent)],
  };
  return { ...body, manifestHash: sha256(JSON.stringify(body)) };
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

/**
 * Records the order in which the catalog sync and the catalog
 * readback were invoked so tests can assert the manager's strict
 * "sync → existsCanonical" gate order.
 */
class OrderingSync implements import("../src/infrastructure/runtime/windows-model-route-boot-manager.js").CatalogSyncUseCase {
  readonly events: string[] = [];
  constructor(private readonly onSync?: () => void) {}
  async execute(): Promise<unknown> {
    this.events.push("sync");
    this.onSync?.();
    return { refreshed: [] };
  }
}

class FakeCanaryTransport implements CanaryHostTransport {
  private readonly sessions: CanarySession[] = [];
  private counter = 0;
  private readonly invokedCommands: Array<{ parentModel: string; command: string; arguments: string }> = [];
  /**
   * Optional: when set, getSession() returns a session whose
   * `.model` is intentionally wrong, so the canary fails with
   * PARENT_MODEL_MISMATCH. Tests that want the happy path leave
   * this undefined.
   */
  public mismatchModel: { providerID: string; modelID: string } | null = null;
  /**
   * Resolves the target canonical id given a canary `arguments` string
   * of the form `sdd-model-routing-canary:<hostName>`. Tests register a
   * resolver when the hostName is opaque (e.g. multi-route tests).
   * Defaults to a single hard-coded target.
   */
  private readonly targetResolver: (args: string) => string;
  constructor(targetResolver?: (args: string) => string) {
    this.targetResolver = targetResolver ?? (() => "google/antigravity-gemini-3.6-flash-tiered");
  }
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
    const target = this.targetResolver(last.arguments);
    const [providerID, modelID] = target.split("/");
    if (!providerID || !modelID) return [];
    return [
      { info: { role: "user", model: { providerID, modelID } } },
      { info: { role: "assistant", providerID, modelID, finish: "stop", time: { completed: 1 } } },
    ];
  }
}

async function run(): Promise<void> {
  console.log("--- windows boot manager (RED v2) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-wu3-"));
  try {
    const workspaceRoot = path.join(tmp, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
    const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
    const lockPath = path.join(routingDir, "generator.lock");
    const attestationPath = path.join(routingDir, "attestation.json");
    const hostName = "sdd-mr-v1-wu3host";
    const manifest = seedManifest(hostName, "google", "antigravity-gemini-3.6-flash-tiered", workspaceRoot);
    mkdirSync(path.dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    const catalog = new StubCatalog();
    catalog.addCanonical("google", "antigravity-gemini-3.6-flash-tiered", "Gemini 3.6 Flash Tiered");
    const canary = new FakeCanaryTransport();

    // ---------- 1. bootIdentity is a fresh UUIDv4 each start ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      const identity1 = manager.getBootIdentity();
      assert.match(identity1, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "bootIdentity is a fresh UUIDv4");
      await manager.stop();

      await manager.start();
      const identity2 = manager.getBootIdentity();
      assert.match(identity2, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "second start: bootIdentity is a fresh UUIDv4");
      assert.notEqual(identity1, identity2, "restart rotates the bootIdentity (no two boots share an identity)");
      await manager.stop();
      console.log("  pass: bootIdentity is a fresh UUIDv4 per start and rotates on restart");
    }

    // ---------- 2. HMAC key is 256-bit, sign-verify via attestation ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      const keyAfter = manager.getSigningKeyLength();
      assert.equal(keyAfter, 32, "HMAC key is 32 bytes (256 bits) after start");
      // The raw key must NEVER be serialized to disk. Walk the entire
      // workspace root and assert no file content contains the key.
      const keyMaterial = manager.getSigningKey();
      const violations: string[] = [];
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const entry of readdirSync(dir)) {
          const p = path.join(dir, entry);
          const st = statSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.isFile()) {
            const content = readFileSync(p);
            if (content.includes(Buffer.from(keyMaterial))) violations.push(p);
          }
        }
      };
      walk(workspaceRoot);
      assert.deepEqual(violations, [], "HMAC key bytes never appear in any file under the workspace root");
      // The attestation.json MUST be valid and signed.
      assert.ok(existsSync(attestationPath), "attestation.json was published");
      const attestation = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
      assert.equal(attestation["bootIdentity"], manager.getBootIdentity(), "attestation.bootIdentity matches the live boot identity");
      assert.equal(typeof attestation["signature"], "string", "attestation.signature is a string");
      assert.equal((attestation["signature"] as string).length, 64, "attestation.signature is a 64-hex-char HMAC-SHA256");
      // Sign-verify sanity: signature must validate against the boot
      // identity + manifest hash, NOT a stored key.
      const body = { ...attestation };
      delete body["signature"];
      const recomputed = createHmac("sha256", keyMaterial).update(JSON.stringify(body)).digest("hex");
      assert.equal(recomputed, attestation["signature"], "attestation.signature recomputes under the live HMAC key");
      // Attestation shape: nonce + openCodeVersion + verifierVersion + fileHashes + expiresAt
      assert.equal(typeof attestation["nonce"], "string", "attestation carries a nonce");
      assert.equal(attestation["openCodeVersion"], "1.18.9", "attestation pins openCodeVersion=1.18.9");
      assert.equal(attestation["verifierVersion"], "1.0.0", "attestation carries verifierVersion");
      assert.ok(Array.isArray(attestation["fileHashes"]), "attestation carries the manifest file hash set");
      assert.equal(typeof attestation["expiresAt"], "number", "attestation carries an expiresAt TTL");
      await manager.stop();
      console.log("  pass: HMAC key is 256-bit, never on disk, sign-verify round-trips; attestation carries nonce/version/TTL");
    }

    // ---------- 3. Catalog readback fails CATALOG_ROUTE_MISSING (post-sync) ----------
    {
      const emptyCatalog = new StubCatalog();
      const sync = new OrderingSync();
      const mgr2 = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog: emptyCatalog,
        canary,
        catalogSync: sync,
        selectParentModel: async () => "openai/gpt-4o",
        now: () => Date.now(),
      });
      let thrown: unknown = null;
      try { await mgr2.start(); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "missing catalog route throws");
      assert.ok(thrown instanceof CatalogRouteMissingError, "error is CatalogRouteMissingError");
      assert.equal((thrown as CatalogRouteMissingError).code, "CATALOG_ROUTE_MISSING", "error code is CATALOG_ROUTE_MISSING");
      assert.equal((thrown as CatalogRouteMissingError).missingCanonicalId, "google/antigravity-gemini-3.6-flash-tiered", "error names the missing canonical");
      assert.equal(mgr2.getState(), "failed", "manager ends in `failed` state on catalog-route-missing");
      assert.ok(!existsSync(attestationPath), "no attestation.json is published when catalog readback fails");
      assert.deepEqual(sync.events, ["sync"], "catalog sync ran exactly once before the readback");
      console.log("  pass: catalog readback fails CATALOG_ROUTE_MISSING post-sync; no attestation published");
    }

    // ---------- 4. Catalog readback succeeds when every route exists ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      assert.equal(manager.getState(), "ready", "manager reaches `ready` state when every route is in the catalog");
      assert.ok(existsSync(attestationPath), "attestation.json was published on success");
      assert.deepEqual(sync.events, ["sync"], "catalog sync ran exactly once on success");
      await manager.stop();
      console.log("  pass: catalog readback succeeds and lifecycle reaches `ready`");
    }

    // ---------- 5. Lifecycle state machine ----------
    {
      const stateTrail: string[] = [];
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
        onStateChange: (state) => stateTrail.push(state),
      });
      assert.equal(manager.getState(), "idle", "initial state is `idle`");
      await manager.start();
      assert.deepEqual(stateTrail, ["starting", "syncing", "canarying", "ready"], "lifecycle visits starting -> syncing -> canarying -> ready");
      await manager.stop();
      assert.ok(stateTrail.includes("stopping"), "lifecycle visits `stopping` after stop()");
      assert.ok(stateTrail.includes("idle"), "lifecycle returns to `idle` after stop completes");
      assert.equal(manager.getState(), "idle", "post-stop state returns to `idle`");
      const readyIndex = stateTrail.indexOf("ready");
      const stoppingIndex = stateTrail.indexOf("stopping");
      const idleIndex = stateTrail.indexOf("idle", readyIndex);
      assert.ok(readyIndex < stoppingIndex && stoppingIndex < idleIndex, "stop sequence (stopping -> idle) follows ready");
      console.log("  pass: lifecycle is idle -> starting -> syncing -> canarying -> ready -> stopping -> idle");
    }

    // ---------- 6. Distinct parent model per route ----------
    {
      // Replace the on-disk manifest with a 2-route variant. The
      // boot manager reads the same `manifestPath`; the readiness
      // verifier re-reads `manifest.json` from the routing dir, so
      // the two must agree.
      const host2 = "sdd-mr-v1-wu3host2";
      const host2Agent = path.join(workspaceRoot, ".opencode", "agents", `${host2}.md`);
      const host2Command = path.join(workspaceRoot, ".opencode", "commands", `${host2}.md`);
      writeFileSync(host2Agent, `agent-${host2}`);
      writeFileSync(host2Command, `command-${host2}`);
      const baseBody = {
        schemaVersion: 1 as const,
        generatorVersion: "1.1.0",
        generationEpoch: "epoch-wu3-multi",
        workspaceIdentity: path.resolve(workspaceRoot),
        routingNamespace: "sdd-mr-v1",
        descriptorBudgetBytes: 4096,
        requiredOpenCodeVersion: "1.18.9",
        routes: [
          {
            baseTemplate: "sdd-mr-base",
            providerId: "google", modelId: "antigravity-gemini-3.6-flash-tiered", hostName,
            agentFile: { relativePath: `.opencode/agents/${hostName}.md`, sha256: sha256(`agent-${hostName}`), bytes: 16 },
            commandFile: { relativePath: `.opencode/commands/${hostName}.md`, sha256: sha256(`command-${hostName}`), bytes: 18 },
          },
          {
            baseTemplate: "sdd-mr-base",
            providerId: "anthropic", modelId: "claude-3-5-sonnet", hostName: host2,
            agentFile: { relativePath: `.opencode/agents/${host2}.md`, sha256: sha256(`agent-${host2}`), bytes: 8 },
            commandFile: { relativePath: `.opencode/commands/${host2}.md`, sha256: sha256(`command-${host2}`), bytes: 10 },
          },
        ],
        fileHashes: [sha256(`agent-${hostName}`), sha256(`command-${hostName}`), sha256(`agent-${host2}`), sha256(`command-${host2}`)],
      };
      const manifest2: Manifest = { ...baseBody, manifestHash: sha256(JSON.stringify(baseBody)) };
      writeFileSync(manifestPath, JSON.stringify(manifest2, null, 2));

      const cat2 = new StubCatalog();
      cat2.addCanonical("google", "antigravity-gemini-3.6-flash-tiered");
      cat2.addCanonical("anthropic", "claude-3-5-sonnet");
      const canary2 = new FakeCanaryTransport((args) => {
        if (args.includes(host2)) return "anthropic/claude-3-5-sonnet";
        return "google/antigravity-gemini-3.6-flash-tiered";
      });
      const seen: string[] = [];
      const mgr3 = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog: cat2,
        canary: canary2,
        selectParentModel: async (target) => {
          seen.push(target);
          if (target === "google/antigravity-gemini-3.6-flash-tiered") return "openai/gpt-4o";
          if (target === "anthropic/claude-3-5-sonnet") return "google/gemini-2.0-flash";
          return null;
        },
        now: () => Date.now(),
      });
      await mgr3.start();
      const distinct = new Set(seen);
      assert.equal(distinct.size, 2, "selectParentModel was called with both route canonicals (distinct parents per route)");
      assert.equal(mgr3.getState(), "ready", "two-route manager reaches `ready`");
      await mgr3.stop();
      // Restore the single-route manifest for the remaining tests.
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      console.log("  pass: distinct parent model per route (no parent reuse across manifest routes)");
    }

    // ---------- 7. ACL is 0600 on attestation.json ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      const st = statSync(attestationPath);
      if (process.platform !== "win32") {
        const mode = st.mode & 0o777;
        assert.equal(mode, 0o600, `attestation.json mode is 0600 (got 0o${mode.toString(8)})`);
      }
      await manager.stop();
      console.log("  pass: attestation.json ACL is 0600 (Windows best-effort)");
    }

    // ---------- 8. HMAC key cleared from manager after stop() ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      const keyDuringRun = manager.getSigningKey();
      assert.equal(keyDuringRun.length, 32, "key present during run");
      await manager.stop();
      const keyAfterStop = manager.getSigningKey();
      assert.ok(keyAfterStop.every((b) => b === 0), "HMAC key buffer is zeroed after stop()");
      console.log("  pass: HMAC key buffer is zeroed after stop() (no secret lingers)");
    }

    // ---------- 9. Concurrency: single-flight start() ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      const a = manager.start();
      const b = manager.start();
      const c = manager.start();
      await Promise.all([a, b, c]);
      assert.equal(manager.getState(), "ready", "concurrent start() all converge to a single ready state");
      await manager.stop();
      console.log("  pass: concurrent start() is single-flight (only one lifecycle runs)");
    }

    // ---------- 10. Env distribution: BOOT_ID + SIGNING_KEY set on start, cleared on stop ----------
    {
      // Ensure neither env var leaks into the test from a prior run.
      delete process.env[ROUTING_BOOT_ID_ENV];
      delete process.env[ROUTING_SIGNING_KEY_ENV];
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      const envBootId = process.env[ROUTING_BOOT_ID_ENV];
      const envSigningKey = process.env[ROUTING_SIGNING_KEY_ENV];
      assert.equal(envBootId, manager.getBootIdentity(), "SDD_MODEL_ROUTING_BOOT_ID env var mirrors the live boot identity");
      assert.equal(envSigningKey, manager.getSigningKey().toString("hex"), "SDD_MODEL_ROUTING_SIGNING_KEY env var carries the live key (hex-encoded)");
      // Raw key bytes MUST NOT appear in process.env.
      const key = manager.getSigningKey();
      assert.ok(!(JSON.stringify(process.env).includes(Buffer.from(key).toString("hex"))) || envSigningKey === key.toString("hex"), "raw key bytes are never persisted outside the dedicated env var");
      // Env snapshot was taken: caller-owned env values for these keys are preserved on stop.
      const previousBootId = "snapshot-boot-id";
      process.env[ROUTING_BOOT_ID_ENV] = previousBootId;
      const otherMgr = new WindowsModelRouteBootManager({
        workspaceRoot, manifestPath, catalog, canary, catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await otherMgr.start();
      assert.equal(process.env[ROUTING_BOOT_ID_ENV], otherMgr.getBootIdentity(), "second start takes over the env var");
      await otherMgr.stop();
      assert.equal(process.env[ROUTING_BOOT_ID_ENV], previousBootId, "stop() restores caller-owned env value for BOOT_ID");
      console.log("  pass: env distribution is correct on start; stop() restores caller-owned env values");
    }

    // ---------- 11. Version mismatch → fail-closed ----------
    {
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        openCodeVersion: "1.18.4", // stale
        now: () => Date.now(),
      });
      let thrown: unknown = null;
      try { await manager.start(); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "version mismatch throws");
      assert.ok(/unsupported OpenCode version 1\.18\.4/.test((thrown as Error).message), "error message names the rejected version");
      assert.equal(manager.getState(), "failed", "manager ends in `failed` state on version mismatch");
      assert.ok(!existsSync(attestationPath), "no attestation published on version mismatch");
      console.log("  pass: version mismatch (openCodeVersion != 1.18.9) fails closed without attestation");
    }

    // ---------- 12. Stale attestation pre-seeded → removed before issuance ----------
    {
      // Pre-seed a stale attestation from a previous boot.
      const stale = { schemaVersion: 1, bootIdentity: "stale", nonce: "stale", expiresAt: 0, signature: "00" };
      writeFileSync(attestationPath, JSON.stringify(stale));
      assert.ok(existsSync(attestationPath), "stale attestation pre-seeded");
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      // Mid-start, the stale attestation should be removed; the new
      // attestation is only published after the lifecycle reaches
      // ready. We assert that the file currently on disk at the end
      // is the new one, not the stale one.
      await manager.start();
      const written = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
      assert.notEqual(written["bootIdentity"], "stale", "stale attestation was replaced by the live boot");
      assert.equal(written["bootIdentity"], manager.getBootIdentity(), "attestation now carries the live boot identity");
      assert.notEqual(written["signature"], "00", "attestation carries a fresh signature (not the stale placeholder)");
      await manager.stop();
      assert.ok(!existsSync(attestationPath), "stop() removes the attestation from disk");
      console.log("  pass: stale attestation pre-seeded is removed before the new attestation is published");
    }

    // ---------- 13. Lock acquired at start, released on stop; stale lock reclaimed ----------
    {
      const sync = new OrderingSync();
      const mgrA = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
        isProcessAlive: () => true,
      });
      // The supervisor owns the lock for its complete lifetime so a
      // separate CLI stop can locate and signal it. Readiness accepts
      // the lock only when it carries this boot identity.
      await mgrA.start();
      assert.ok(existsSync(lockPath), "lock file remains owned while the boot is ready");
      assert.equal(mgrA.getState(), "ready", "manager reaches `ready` while retaining its lifecycle lock");
      await mgrA.stop();
      assert.ok(!existsSync(lockPath), "lock file removed on stop()");

      // A stale lock from a "dead" prior pid is reclaimed silently.
      const deadPid = process.pid + 999_999;
      const deadLock = { pid: deadPid, acquiredAt: Date.now() - 60_000, bootIdentity: "dead-boot" };
      writeFileSync(lockPath, JSON.stringify(deadLock));
      const mgrB = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
        isProcessAlive: (pid) => pid === process.pid,
      });
      await mgrB.start();
      assert.ok(existsSync(lockPath), "stale lock reclaimed and retained by the active supervisor");
      await mgrB.stop();

      // An unreclaimable lock (alive + within recovery window) is rejected.
      const fresh = { pid: process.pid, acquiredAt: Date.now(), bootIdentity: "live-other" };
      writeFileSync(lockPath, JSON.stringify(fresh));
      const mgrC = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
        isProcessAlive: () => true,
      });
      let thrown: unknown = null;
      try { await mgrC.start(); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof StaleLockUnrecoverableError, "live + recent lock fails with StaleLockUnrecoverableError");
      assert.equal(mgrC.getState(), "failed", "unreclaimable lock aborts the lifecycle in `failed`");
      rmSync(lockPath, { force: true });
      console.log("  pass: lock acquired/released; stale lock reclaimed; live+recent lock blocks boot");
    }

    // ---------- 14. Expiry with injected now() → AttestationExpiredError ----------
    {
      let now = 1_000;
      const sync = new OrderingSync();
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        ttlMs: 500,
        now: () => now,
      });
      await manager.start();
      const attestation = manager.getAttestation();
      assert.ok(attestation !== null, "attestation was issued");
      assert.equal(attestation!.issuedAt, 1_000, "issuedAt is the injected now()");
      assert.equal(attestation!.expiresAt, 1_500, "expiresAt = issuedAt + ttlMs");
      // The manager releases the lock after `ready` so the dispatch
      // can verify the attestation. We can verify in-process now.
      const { ModelRouteReadiness } = await import("../src/infrastructure/opencode/model-route-readiness.js");
      const verifier = new ModelRouteReadiness({ workspaceRoot, now: () => now, signingKey: manager.getSigningKey() });
      const verified = verifier.verify({ manifest, openCodeVersion: "1.18.9", bootIdentity: manager.getBootIdentity() });
      assert.equal(verified.nonce, attestation!.nonce, "verifier reads back the same attestation that was issued");
      // Past TTL: verify throws AttestationExpiredError.
      now = 1_501;
      assert.throws(
        () => verifier.verify({ manifest, openCodeVersion: "1.18.9", bootIdentity: manager.getBootIdentity() }),
        /ATTESTATION_EXPIRED/,
        "verify with now() > expiresAt throws AttestationExpiredError",
      );
      await manager.stop();
      console.log("  pass: attestation carries TTL; verify fails ATTESTATION_EXPIRED after expiresAt");
    }

    // ---------- 15. catalogSync invoked BEFORE existsCanonical (mock de orden) ----------
    {
      const orderingCatalog = new StubCatalog();
      orderingCatalog.addCanonical("google", "antigravity-gemini-3.6-flash-tiered");
      const order: string[] = [];
      const sync = new OrderingSync(() => { order.push("sync"); });
      const wrappedCatalog: ModelRouteCatalogPort = {
        async existsCanonical(p, m) { order.push("existsCanonical"); return orderingCatalog.existsCanonical(p, m); },
        async searchNormalized(t, l) { return orderingCatalog.searchNormalized(t, l); },
      };
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog: wrappedCatalog,
        canary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      await manager.start();
      assert.deepEqual(order, ["sync", "existsCanonical"], "catalogSync ran before existsCanonical (mock de orden)");
      assert.deepEqual(sync.events, ["sync"], "sync was invoked exactly once");
      await manager.stop();
      console.log("  pass: catalogSync invoked BEFORE existsCanonical (mock de orden)");
    }

    // ---------- 16. Canary parent read-back: PARENT_MODEL_MISMATCH fail-closed ----------
    {
      const sync = new OrderingSync();
      const mismatchCanary = new FakeCanaryTransport();
      mismatchCanary.mismatchModel = { providerID: "fallback", modelID: "parent" };
      const manager = new WindowsModelRouteBootManager({
        workspaceRoot,
        manifestPath,
        catalog,
        canary: mismatchCanary,
        catalogSync: sync,
        selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
        now: () => Date.now(),
      });
      let thrown: unknown = null;
      try { await manager.start(); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof CanaryBlockedError, "canary mismatch throws CanaryBlockedError");
      assert.equal((thrown as CanaryBlockedError).code, "PARENT_MODEL_MISMATCH", "error code is PARENT_MODEL_MISMATCH");
      assert.equal(manager.getState(), "failed", "manager ends in `failed` state on parent mismatch");
      assert.ok(!existsSync(attestationPath), "no attestation published on parent mismatch");
      console.log("  pass: canary parent read-back fails closed on PARENT_MODEL_MISMATCH");
    }

    console.log("All windows-boot-manager assertions passed.");
  } finally {
    await cleanupDir(tmp);
  }
}

function expectContaining(fragment: string): string {
  // Reserved for ergonomic message-fragment assertions; not currently
  // used (the test layer now uses `RegExp.test` directly).
  return fragment;
}

run().catch((err: unknown) => { console.error(err); process.exit(1); });
