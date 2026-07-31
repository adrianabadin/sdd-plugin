/**
 * WU3 (v2) — Windows boot manager for the deterministic model-routing
 * natural path.
 *
 * Lifecycle (per design 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6):
 *
 *   idle -> starting -> syncing -> canarying -> ready
 *                              `-> failed (terminal)
 *                          ready -> stopping -> idle
 *
 * Per the spec, the boot manager:
 *
 *   1. Generates a fresh cryptographic UUIDv4 `bootIdentity` and a
 *      256-bit HMAC `signingKey` on every `start()`. Both live in
 *      process memory; the key buffer is zeroed on `stop()`.
 *   2. Distributes BOTH values into the process env so the in-process
 *      `bootstrap` (consumed by `ModelRouteTaskHook`) can read them
 *      via `SDD_MODEL_ROUTING_BOOT_ID` / `SDD_MODEL_ROUTING_SIGNING_KEY`.
 *      The env values are CLEARED on `stop()` and never serialized
 *      to disk, the readiness file, the audit log, or `.env`.
 *   3. Acquires an exclusive generator lock (PID + epoch payload)
 *      before mutating the routing directory; any stale lock from a
 *      prior crashed boot is reclaimed using the on-disk age.
 *   4. Removes any prior attestation from a previous boot so a
 *      failed boot does not leave a misleading `ready` signal.
 *   5. Syncs the live model catalog via the injected
 *      `SyncConnectedModelsUseCase` BEFORE the readback so a freshly
 *      started `opencode serve` has advertised every route.
 *   6. Reads back every manifest route via the catalog port
 *      (`existsCanonical`). If any configured route is not advertised,
 *      throws `CatalogRouteMissingError` and writes NO attestation.
 *   7. Triggers `ModelRouteCanary` with a distinct parent per route.
 *      The canary now issues a parent read-back
 *      (`getSession` → `GET /session/:id`) and fails with
 *      `PARENT_MODEL_MISMATCH` if the host silently overrode the
 *      parent model. Canary miss fails closed.
 *   8. Publishes a signed `attestation.json` via the injected
 *      `ModelRouteReadiness.issue()`. The attestation carries a
 *      nonce, openCodeVersion, verifierVersion, fileHashes, and a
 *      TTL (`expiresAt`); the dispatch hook (ModelRouteTaskHook)
 *      verifies the same fields. The signature is HMAC-SHA256 over
 *      the body; the file never contains the key bytes.
 *   9. Is single-flight: concurrent `start()` calls await the same
 *      lifecycle, not parallel ones.
 *  10. Rotates secrets on every restart: a fresh `bootIdentity` and a
 *      fresh HMAC key on each `start()` after `stop()`.
 *  11. On `stop()`: removes the attestation, releases the lock,
 *      unsets the env vars, and zeros the key buffer.
 *
 * Reference proposal: aa40c70b-f635-4246-b94b-e065b0db688e.
 * Reference spec:     dcf1d668-3349-4ac1-8d06-ce27a40174ef.
 * Reference design:   41aa141d-1bbf-4cd0-aba7-63f82f83fbd6.
 * Reference tasks:    1bf62713-dff6-4b0a-a680-f356fa20d13f (Phase 3).
 *
 * v2 (plan wu3-scope-drift-fix): adopts ModelRouteReadiness.issue() +
 * TTL + lock + sync + parent read-back + env distribution. The v1
 * ad-hoc signer and ad-hoc readiness.json publisher are gone.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";

import type { Manifest } from "../opencode/disk-agent-generator.js";
import {
  ModelRouteCanary,
  CanaryBlockedError,
  type CanaryHostTransport,
} from "../opencode/model-route-canary.js";
import {
  ModelRouteReadiness,
  REQUIRED_OPENCODE_VERSION,
  READINESS_VERIFIER_VERSION,
  type ReadinessAttestation,
  AttestationMismatchError,
} from "../opencode/model-route-readiness.js";
import { applyCurrentUserAcl } from "./windows-acl.js";
import type { ModelRouteCatalogPort } from "../../ports/model-route-catalog.port.js";
import type { RegenerateFleetAgentsUseCase } from "../../application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";

/**
 * Pluggable catalog sync use case. The default production wiring
 * is `SyncConnectedModelsUseCase` from
 * `src/application/sync-connected-models/`. Tests inject a fake that
 * captures invocation order so we can assert the manager runs
 * `sync → existsCanonical` in that exact order.
 */
export interface CatalogSyncUseCase {
  execute(input?: { correlationId?: string }): Promise<unknown>;
}

export interface BootChildProcess {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): this;
}

/** Process boundary used by production CLI and hermetic supervisor tests. */
export interface BootProcessSupervisor {
  spawnServe(env: NodeJS.ProcessEnv): BootChildProcess;
  waitForHealthy(process: BootChildProcess): Promise<void>;
  spawnAttach(env: NodeJS.ProcessEnv): BootChildProcess;
}

export type BootLifecycleState =
  | "idle"
  | "starting"
  | "syncing"
  | "canarying"
  | "ready"
  | "stopping"
  | "failed";

/**
 * Thrown when the manifest declares a route whose canonical identity
 * is not advertised by the live catalog adapter. Fails closed.
 */
export class CatalogRouteMissingError extends Error {
  readonly code = "CATALOG_ROUTE_MISSING";
  readonly missingCanonicalId: string;
  constructor(missingCanonicalId: string) {
    super(
      `CATALOG_ROUTE_MISSING: manifest route "${missingCanonicalId}" was not advertised by the live catalog; ` +
        `boot manager refuses to publish readiness.`,
    );
    this.name = "CatalogRouteMissingError";
    this.missingCanonicalId = missingCanonicalId;
  }
}

/**
 * Thrown when a stale generator lock from a prior crashed boot
 * cannot be reclaimed (PID still alive OR age exceeds the recovery
 * window). Distinct from the catalog error so the CLI can return a
 * dedicated exit code.
 */
export class StaleLockUnrecoverableError extends Error {
  readonly code = "STALE_LOCK_UNRECOVERABLE";
  readonly lockPath: string;
  readonly pid: number;
  readonly ageMs: number;
  constructor(lockPath: string, pid: number, ageMs: number) {
    super(
      `STALE_LOCK_UNRECOVERABLE: lock at ${lockPath} (pid=${pid}, age=${ageMs}ms) cannot be reclaimed; manual recovery required`,
    );
    this.name = "StaleLockUnrecoverableError";
    this.lockPath = lockPath;
    this.pid = pid;
    this.ageMs = ageMs;
  }
}

const BOOT_IDENTITY_UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HMAC_KEY_BYTES = 32; // 256-bit

/** Maximum age (ms) for a stale lock to be reclaimable. */
const STALE_LOCK_MAX_AGE_MS = 30_000;

/** Default attestation TTL. Long-lived supervisors reissue before expiry. */
const DEFAULT_TTL_MS = 60_000;

/** Process env keys used by the in-process bootstrap to read the boot secrets. */
export const ROUTING_BOOT_ID_ENV = "SDD_MODEL_ROUTING_BOOT_ID";
export const ROUTING_SIGNING_KEY_ENV = "SDD_MODEL_ROUTING_SIGNING_KEY";

interface LockPayload {
  readonly pid: number;
  readonly acquiredAt: number;
  readonly bootIdentity: string;
}

export interface WindowsModelRouteBootManagerOptions {
  readonly workspaceRoot: string;
  readonly manifestPath: string;
  readonly catalog: ModelRouteCatalogPort;
  readonly canary: CanaryHostTransport;
  /**
   * Returns a parent canonical distinct from the target. MUST be
   * called with the target canonical id; returning the same id (or
   * `null`) causes the boot to fail closed.
   */
  readonly selectParentModel: (targetCanonicalId: string) => Promise<string | null>;
  /**
   * Optional: a SyncConnectedModelsUseCase (or any compatible
   * shape) invoked before `existsCanonical`. Production wiring
   * passes the real use case; tests inject a fake that captures
   * invocation order.
   */
  readonly catalogSync?: CatalogSyncUseCase;
  /**
   * OpenCode host version the boot expects. The default
   * (`REQUIRED_OPENCODE_VERSION`) is the only value ModelRouteReadiness
   * accepts; tests override to assert fail-closed on mismatch.
   */
  readonly openCodeVersion?: string;
  /** Attestation TTL in ms. The default is 60s. */
  readonly ttlMs?: number;
  /** Optional override for the testability of the lock acquisition. */
  readonly lockPath?: string;
  /** Optional override for the testability of the attestation path. */
  readonly attestationPath?: string;
  readonly now?: () => number;
  readonly onStateChange?: (state: BootLifecycleState) => void;
  readonly canaryTimeoutMs?: number;
  /** Process-alive check used during stale-lock recovery. */
  readonly isProcessAlive?: (pid: number) => boolean;
  /** Optional real serve/attach process boundary. */
  readonly processSupervisor?: BootProcessSupervisor;
  /** Optional persisted cross-process control record. */
  readonly controlPath?: string;
  /** Renewal cadence; defaults to one third of the attestation TTL. */
  readonly renewalIntervalMs?: number;
  readonly fleetRegeneration?: RegenerateFleetAgentsUseCase;
  readonly routesConfigPath?: string;
}

export class WindowsModelRouteBootManager {
  private state: BootLifecycleState = "idle";
  private bootIdentity: string | null = null;
  private signingKey: Buffer = Buffer.alloc(HMAC_KEY_BYTES);
  private attestation: ReadinessAttestation | null = null;
  private currentLifecycle: Promise<void> | null = null;
  private readonly workspaceRoot: string;
  private readonly manifestPath: string;
  private readonly routingDir: string;
  private readonly lockPath: string;
  private readonly attestationPath: string;
  private readonly catalog: ModelRouteCatalogPort;
  private readonly canary: CanaryHostTransport;
  private readonly catalogSync: CatalogSyncUseCase | undefined;
  private readonly selectParentModel: (targetCanonicalId: string) => Promise<string | null>;
  private readonly openCodeVersion: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onStateChange: ((state: BootLifecycleState) => void) | undefined;
  private readonly canaryTimeoutMs: number;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly processSupervisor: BootProcessSupervisor | undefined;
  private readonly controlPath: string;
  private readonly renewalIntervalMs: number;
  private readonly fleetRegeneration: RegenerateFleetAgentsUseCase | undefined;
  private readonly routesConfigPath: string | undefined;
  private serveProcess: BootChildProcess | null = null;
  private attachProcess: BootChildProcess | null = null;
  private renewalTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Snapshot of the env keys the manager touched during start, so
   * `stop()` restores (or unsets) exactly the keys it owned and never
   * disturbs caller-owned values.
   */
  private readonly envSnapshot = new Map<string, string | undefined>();

  constructor(options: WindowsModelRouteBootManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.manifestPath = options.manifestPath;
    this.routingDir = path.join(this.workspaceRoot, ".opencode", "sdd-model-routing");
    this.lockPath = options.lockPath ?? path.join(this.routingDir, "generator.lock");
    this.attestationPath = options.attestationPath ?? path.join(this.routingDir, "attestation.json");
    this.catalog = options.catalog;
    this.canary = options.canary;
    this.catalogSync = options.catalogSync;
    this.selectParentModel = options.selectParentModel;
    this.openCodeVersion = options.openCodeVersion ?? REQUIRED_OPENCODE_VERSION;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? Date.now;
    if (options.onStateChange !== undefined) this.onStateChange = options.onStateChange;
    this.canaryTimeoutMs = options.canaryTimeoutMs ?? 120_000;
    this.isProcessAlive = options.isProcessAlive ?? ((pid: number) => isAliveDefault(pid));
    this.processSupervisor = options.processSupervisor;
    this.controlPath = options.controlPath ?? path.join(this.routingDir, "boot-control.json");
    this.renewalIntervalMs = options.renewalIntervalMs ?? Math.max(1_000, Math.floor(this.ttlMs / 3));
    this.fleetRegeneration = options.fleetRegeneration;
    this.routesConfigPath = options.routesConfigPath;
  }

  getState(): BootLifecycleState {
    return this.state;
  }

  /**
   * Returns the live boot identity. Throws when the manager is not in
   * a state that has produced one (i.e. `idle`, `stopping`, or
   * `failed` before the first start).
   */
  getBootIdentity(): string {
    if (this.bootIdentity === null) {
      throw new Error("BOOT_IDENTITY_UNAVAILABLE: no boot has been started");
    }
    return this.bootIdentity;
  }

  /**
   * Returns the live HMAC key buffer. Tests use this to assert
   * length and verify signatures. Production code MUST NOT echo the
   * key to any other sink.
   */
  getSigningKey(): Buffer {
    return this.signingKey;
  }

  getSigningKeyLength(): number {
    return this.signingKey.length;
  }

  /**
   * Returns the issued attestation (or `null` when not in `ready`).
   * Tests use this to assert the full attestation shape.
   */
  getAttestation(): ReadinessAttestation | null {
    return this.attestation;
  }

  /**
   * Start a new boot lifecycle. Single-flight: concurrent calls
   * await the same promise. Throws on failure.
   */
  start(): Promise<void> {
    if (this.currentLifecycle !== null) return this.currentLifecycle;
    this.currentLifecycle = this.runStart().finally(() => {
      this.currentLifecycle = null;
    });
    return this.currentLifecycle;
  }

  /**
   * Stop the boot lifecycle. Idempotent; safe to call when idle.
   * After stop, the HMAC key buffer is zeroed, the boot identity is
   * cleared, the attestation + lock are removed from disk, and the
   * env vars the manager owns are unset.
   */
  async stop(): Promise<void> {
    if (this.state === "idle" || this.state === "stopping") return;
    this.transitionTo("stopping");
    if (this.currentLifecycle !== null) {
      try { await this.currentLifecycle; } catch { /* errors are surfaced by the original start() caller */ }
    }
    if (this.renewalTimer !== null) clearInterval(this.renewalTimer);
    this.renewalTimer = null;
    this.killChild(this.attachProcess);
    this.killChild(this.serveProcess);
    this.attachProcess = null;
    this.serveProcess = null;
    this.removeAttestationFromDisk();
    this.releaseLock();
    try { rmSync(this.controlPath, { force: true }); } catch { /* best effort */ }
    this.restoreEnv();
    this.zeroizeKey();
    this.bootIdentity = null;
    this.attestation = null;
    this.transitionTo("idle");
  }

  private async runStart(): Promise<void> {
    this.transitionTo("starting");

    try {
      if (this.fleetRegeneration) {
        const resolvedConfigPath = this.routesConfigPath
          ? (path.isAbsolute(this.routesConfigPath)
              ? path.resolve(this.routesConfigPath)
              : path.resolve(this.workspaceRoot, this.routesConfigPath))
          : path.resolve(this.workspaceRoot, "config/model-routing/routes.json");

        await this.fleetRegeneration.execute({
          workspaceRoot: this.workspaceRoot,
          routesConfigPath: resolvedConfigPath,
        });
      }

      // (1) Fresh secrets in process memory. UUIDv4 for the boot
      // identity; 32 random bytes for the HMAC key. Both must be
      // regenerated on every start so restarts rotate the material.
      this.bootIdentity = generateUuidV4();
      randomBytes(HMAC_KEY_BYTES).copy(this.signingKey);

      // The child supervisor receives secrets in a private env object. The
      // legacy in-process plugin path is retained only when no child exists.
      if (!this.processSupervisor) {
        this.setEnv(ROUTING_BOOT_ID_ENV, this.bootIdentity);
        this.setEnv(ROUTING_SIGNING_KEY_ENV, this.signingKey.toString("hex"));
      }

      // (3) Acquire the generator lock and reclaim only safe stale state.
      this.acquireOrReclaimLock();
      this.removeAttestationFromDisk();
      const manifest = this.readManifest();

      if (this.processSupervisor) {
        this.serveProcess = this.processSupervisor.spawnServe(this.childEnv());
        this.serveProcess.once("exit", () => { if (this.state === "ready") void this.stop(); });
        this.serveProcess.once("error", () => { if (this.state === "ready") void this.stop(); });
        await this.processSupervisor.waitForHealthy(this.serveProcess);
      }

      this.transitionTo("syncing");
      if (!this.catalogSync && this.processSupervisor) {
        throw new Error("CATALOG_SYNC_NOT_CONFIGURED: live catalog sync is required for supervised production boot");
      }
      // The in-process unit harness predates the production composition
      // root and intentionally omits persistence sync; supervised boots
      // above cannot omit it.
      if (this.catalogSync) await this.catalogSync.execute();

    // (7) Read back every manifest route from the live catalog.
    // If any configured route is not advertised, fail closed WITHOUT
    // publishing readiness.
    for (const route of manifest.routes) {
      const canonicalId = `${route.providerId}/${route.modelId}`;
      const exists = await this.catalog.existsCanonical(route.providerId, route.modelId);
      if (!exists) {
        throw new CatalogRouteMissingError(canonicalId);
      }
    }

    // (8) Canary every route with a distinct parent session model.
    // The canary now enforces a parent read-back (PARENT_MODEL_MISMATCH
    // fail-closed) in addition to the existing distinct-parent
    // contract.
    this.transitionTo("canarying");
    const canary = new ModelRouteCanary({
      transport: this.canary,
      selectParentModel: this.selectParentModel,
      timeoutMs: this.canaryTimeoutMs,
    });
    const evidence = await canary.verifyEveryRoute(manifest);

    // (9) Publish a signed attestation via ModelRouteReadiness.issue().
    // The attestation carries nonce + openCodeVersion + verifierVersion
    // + fileHashes + expiresAt; the dispatch hook verifies the same
    // fields. The signature is HMAC-SHA256 over the body; the file
    // never contains the key bytes.
    //
    // issue()'s assertCurrentState() refuses to publish when the
    // generator.lock file is present, because the lock signals an
    // in-flight manifest write. The boot manager is NOT a generator
    // (the generator ran pre-start and committed the manifest), so we
    // release the boot lock around the issue() call and re-acquire
    // it once the attestation is on disk. The window is small and
    // does not race with the generator (which writes under its own
    // distinct lock acquisition).
      const readiness = new ModelRouteReadiness({
        workspaceRoot: this.workspaceRoot,
        now: this.now,
        signingKey: this.signingKey,
      });
      const issued = readiness.issue({
        manifest,
        evidence: [...evidence],
        openCodeVersion: this.openCodeVersion,
        bootIdentity: this.bootIdentity,
        ttlMs: this.ttlMs,
      });
      this.attestation = issued;
      if (this.processSupervisor) {
        this.attachProcess = this.processSupervisor.spawnAttach(this.scrubbedEnv());
        this.attachProcess.once("exit", () => { if (this.state === "ready") void this.stop(); });
        this.attachProcess.once("error", () => { if (this.state === "ready") void this.stop(); });
      }
      this.writeControlRecord();
      this.transitionTo("ready");
      this.renewalTimer = setInterval(() => { void this.renewAttestation(); }, this.renewalIntervalMs);
      this.renewalTimer.unref?.();
    } catch (error) {
      this.killChild(this.attachProcess);
      this.killChild(this.serveProcess);
      this.attachProcess = null;
      this.serveProcess = null;
      if (this.renewalTimer !== null) clearInterval(this.renewalTimer);
      this.renewalTimer = null;
      this.removeAttestationFromDisk();
      this.releaseLock();
      try { rmSync(this.controlPath, { force: true }); } catch { /* best effort */ }
      this.restoreEnv();
      this.zeroizeKey();
      this.bootIdentity = null;
      this.attestation = null;
      this.transitionTo("failed");
      throw error;
    }
  }

  private childEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    env[ROUTING_BOOT_ID_ENV] = this.bootIdentity ?? "";
    env[ROUTING_SIGNING_KEY_ENV] = this.signingKey.toString("hex");
    return env;
  }

  private scrubbedEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env };
    delete env[ROUTING_BOOT_ID_ENV];
    delete env[ROUTING_SIGNING_KEY_ENV];
    return env;
  }

  private killChild(child: BootChildProcess | null): void {
    if (!child) return;
    try { child.kill("SIGTERM"); } catch { /* best effort */ }
  }

  private writeControlRecord(): void {
    mkdirSync(path.dirname(this.controlPath), { recursive: true });
    writeFileSync(this.controlPath, JSON.stringify({
      pid: process.pid,
      bootIdentity: this.bootIdentity,
      servePid: this.serveProcess?.pid ?? null,
      attachPid: this.attachProcess?.pid ?? null,
      startedAt: this.now(),
    }), { encoding: "utf8", mode: 0o600 });
    applyCurrentUserAcl(this.controlPath);
  }

  private async renewAttestation(): Promise<void> {
    if (this.state !== "ready" || !this.attestation || !this.bootIdentity) return;
    try {
      const manifest = this.readManifest();
      const readiness = new ModelRouteReadiness({ workspaceRoot: this.workspaceRoot, now: this.now, signingKey: this.signingKey });
      this.attestation = readiness.issue({ manifest, evidence: this.attestation.canaries, openCodeVersion: this.openCodeVersion, bootIdentity: this.bootIdentity, ttlMs: this.ttlMs });
    } catch {
      await this.stop();
    }
  }

  private readManifest(): Manifest {
    if (!existsSync(this.manifestPath)) {
      throw new Error(`MANIFEST_MISSING: ${this.manifestPath}`);
    }
    return JSON.parse(readFileSync(this.manifestPath, "utf8")) as Manifest;
  }

  private transitionTo(next: BootLifecycleState): void {
    this.state = next;
    this.onStateChange?.(next);
  }

  private zeroizeKey(): void {
    this.signingKey.fill(0);
  }

  // -----------------------------------------------------------------------
  // Env distribution
  // -----------------------------------------------------------------------

  private setEnv(key: string, value: string): void {
    if (!this.envSnapshot.has(key)) {
      this.envSnapshot.set(key, process.env[key]);
    }
    process.env[key] = value;
  }

  private restoreEnv(): void {
    for (const [key, previous] of this.envSnapshot) {
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
    this.envSnapshot.clear();
  }

  // -----------------------------------------------------------------------
  // Lock acquisition + stale-lock recovery
  // -----------------------------------------------------------------------

  private acquireOrReclaimLock(): void {
    mkdirSync(path.dirname(this.lockPath), { recursive: true });
    if (!existsSync(this.lockPath)) {
      this.writeLock();
      return;
    }
    const prior = this.readLock();
    if (prior === null) {
      // Malformed lock; reclaim it as stale.
      this.writeLock();
      return;
    }
    const ageMs = this.now() - prior.acquiredAt;
    const alive = this.isProcessAlive(prior.pid);
    if (alive && ageMs <= STALE_LOCK_MAX_AGE_MS) {
      throw new StaleLockUnrecoverableError(this.lockPath, prior.pid, ageMs);
    }
    // Stale or dead: reclaim.
    this.writeLock();
  }

  private writeLock(): void {
    if (this.bootIdentity === null) return;
    const payload: LockPayload = {
      pid: process.pid,
      acquiredAt: this.now(),
      bootIdentity: this.bootIdentity,
    };
    writeFileSync(this.lockPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
  }

  private readLock(): LockPayload | null {
    try {
      const raw = readFileSync(this.lockPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<LockPayload>;
      if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "number") return null;
      return { pid: parsed.pid, acquiredAt: parsed.acquiredAt, bootIdentity: String(parsed.bootIdentity ?? "") };
    } catch {
      return null;
    }
  }

  private releaseLock(): void {
    try { rmSync(this.lockPath, { force: true }); } catch { /* best-effort */ }
  }

  // -----------------------------------------------------------------------
  // Attestation lifecycle
  // -----------------------------------------------------------------------

  private removeAttestationFromDisk(): void {
    try { rmSync(this.attestationPath, { force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Default process-alive check: on POSIX, signal 0; on Windows, no
 * portable signal probe exists, so the manager falls back to
 * `age-bounded` reclaim (a lock whose age exceeds the recovery
 * window is always considered stale, regardless of PID).
 */
function isAliveDefault(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate a fresh UUIDv4 in the standard hyphenated form, with the
 * RFC 4122 version 4 and variant 1 bits set. Uses
 * `crypto.randomUUID()` (Node 14.17+) and re-validates the format
 * before returning so the boot manager never publishes an
 * unformatted identity.
 */
function generateUuidV4(): string {
  const candidate = randomUUID();
  if (!BOOT_IDENTITY_UUID_V4_REGEX.test(candidate)) {
    throw new Error(`BOOT_IDENTITY_INVALID: crypto.randomUUID produced non-v4 token ${candidate}`);
  }
  return candidate;
}

// Re-export for ergonomic imports in the CLI/test layer.
export {
  AttestationMismatchError,
  REQUIRED_OPENCODE_VERSION,
  READINESS_VERIFIER_VERSION,
};
export type { ReadinessAttestation };

// Suppress unused-import warning for createHash; reserved for future
// attestation hash chain work tracked in WU4.
void createHash;
