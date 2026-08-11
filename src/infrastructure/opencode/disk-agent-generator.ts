/**
 * Pre-start disk agent generator for deterministic model routing.
 *
 * Reads an explicit `config/model-routing/routes.json` whitelist and writes
 * the owned disk artifacts that the OpenCode 1.18.9 runtime picks up on
 *
 *   - `<workspaceRoot>/.opencode/agents/sdd-mr-v1-<hash>.md`
 *   - `<workspaceRoot>/.opencode/commands/sdd-mr-canary-v1-<hash>.md`
 *   - `<workspaceRoot>/.opencode/sdd-model-routing/manifest.json`
 *
 * Hard guarantees enforced here:
 *
 *   - Fleet default cap 8, hard max 32 (a committed `sizeException.reason`
 *     is required for 9..32 entries; >32 is rejected outright). The hard
 *     max is derived from ~20 connected models, one host per model (the
 *     permission-tier design was abandoned after a spike showed OpenCode's
 *     `permission` deny is bypassable via direct `pty_spawn`/`pty_write`),
 *     plus slack -> 24. Raised to 32 in 2026-08 to cover the 29-model
 *     benchmark whitelist (31 routes) without per-entry churn.
 *   - 4 KiB descriptor budget per generated file.
 *   - Canonical containment: every generated/inspected path is realpath
 *     resolved and asserted to live under the workspace root; absolute
 *     paths and `..` traversal are rejected.
 *   - Symlinks, junctions, and Windows reparse points are rejected at
 *     every path component.
 *   - Exclusive `wx` lock with PID + epoch payload, bounded stale recovery,
 *     same-directory temp + journaled backup swap that is compatible with
 *     Windows rename semantics, and fsync on every descriptor + the
 *     manifest.
 *   - Stale cleanup only deletes prior manifest-owned entries whose
 *     on-disk hashes still match; any unknown or modified file aborts
 *     cleanup with a precise error class.
 *   - Deterministic, collision-safe host naming via `hashHostName` from
 *     the Slice 1 surface; no `args.model` ever appears in the
 *     generated descriptors.
 *
 * Authoritative design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 * Spec: 1ab4a8ef-2004-4dd6-9721-4fd1e18eff2f.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

import { hashHostName, ROUTED_HOST_NAME_PREFIX } from "../../domain/model-routing/model-route-host-naming.js";
import { renderCanonicalRoutedAgentMarkdown } from "./routed-agent-definition.js";
import { resolveForeignAgentSources } from "./foreign-agent-sources.js";
import { scanForForeignAgentDefinitions, assertNoForeignAgentDefinitions } from "./foreign-agent-scan.js";
import { ForeignAgentDefinitionError } from "./foreign-agent-errors.js";
import { REQUIRED_OPENCODE_VERSION } from "./model-route-readiness.js";

// ============================================================================
// Constants
// ============================================================================

export const SCHEMA_VERSION = 1 as const;
export const GENERATOR_VERSION = "1.1.0";
export const ROUTING_NAMESPACE_VERSION = "sdd-mr-v1";
export const HARD_MAX_ROUTES = 32;
export const FLEET_DEFAULT_CAP = 8;
export const DESCRIPTOR_BUDGET_BYTES = 4 * 1024;
export const LOCK_STALE_AFTER_MS = 30_000;

export const ROUTING_RELATIVE_DIR = path.join(".opencode", "sdd-model-routing");
export const AGENTS_RELATIVE_DIR = path.join(".opencode", "agents");
export const COMMANDS_RELATIVE_DIR = path.join(".opencode", "commands");
export const MANIFEST_RELATIVE = path.join(ROUTING_RELATIVE_DIR, "manifest.json");
export const LOCK_RELATIVE = path.join(ROUTING_RELATIVE_DIR, "generator.lock");
export const JOURNAL_RELATIVE_DIR = path.join(ROUTING_RELATIVE_DIR, "journal");

export const ROUTE_AGENT_PREFIX = "sdd-mr-v1-";
export const ROUTE_COMMAND_PREFIX = "sdd-mr-canary-v1-";
const HASH_HEX_LENGTH = 16;

// ============================================================================
// Error taxonomy
// ============================================================================

export type GeneratorErrorCode =
  | "ROUTES_CONFIG_INVALID"
  | "ROUTE_CAP_EXCEEDED"
  | "PATH_TRAVERSAL_DETECTED"
  | "DISK_SAFETY_VIOLATION"
  | "GENERATOR_LOCK_ACTIVE"
  | "STALE_LOCK_UNRECOVERABLE"
  | "MANIFEST_INVALID"
  | "MODIFIED_OWNED_FILE"
  | "DESCRIPTOR_BUDGET_EXCEEDED"
  | "SWEEP_INCOMPLETE";

export class DiskAgentGeneratorError extends Error {
  readonly code: GeneratorErrorCode;
  readonly detail: string;
  constructor(code: GeneratorErrorCode, message: string, detail = "") {
    super(message);
    this.name = "DiskAgentGeneratorError";
    this.code = code;
    this.detail = detail;
  }
}

export class RoutesConfigInvalidError extends DiskAgentGeneratorError {
  constructor(detail: string) {
    super(
      "ROUTES_CONFIG_INVALID",
      `routes.json is invalid: ${detail}`,
      detail,
    );
    this.name = "RoutesConfigInvalidError";
  }
}

export class RouteCapExceededError extends DiskAgentGeneratorError {
  readonly actual: number;
  readonly cap: number;
  constructor(actual: number, cap: number) {
    super(
      "ROUTE_CAP_EXCEEDED",
      `routes.json declares ${actual} entries but fleet cap is ${cap}` +
        (cap === HARD_MAX_ROUTES ? "" : `; commit a sizeException.reason for 9..${HARD_MAX_ROUTES} entries`),
      `actual=${actual};cap=${cap}`,
    );
    this.name = "RouteCapExceededError";
    this.actual = actual;
    this.cap = cap;
  }
}

export class PathTraversalDetectedError extends DiskAgentGeneratorError {
  readonly path: string;
  readonly reason: string;
  constructor(p: string, reason: string) {
    super(
      "PATH_TRAVERSAL_DETECTED",
      `path "${p}" violates canonical containment (${reason})`,
      reason,
    );
    this.name = "PathTraversalDetectedError";
    this.path = p;
    this.reason = reason;
  }
}

export class DiskSafetyError extends DiskAgentGeneratorError {
  constructor(p: string, reason: string) {
    super(
      "DISK_SAFETY_VIOLATION",
      `path "${p}" failed disk safety check (${reason})`,
      reason,
    );
    this.name = "DiskSafetyError";
  }
}

export class GeneratorLockActiveError extends DiskAgentGeneratorError {
  readonly lockPath: string;
  readonly pid: number;
  readonly ageMs: number;
  constructor(lockPath: string, pid: number, ageMs: number) {
    super(
      "GENERATOR_LOCK_ACTIVE",
      `generator lock is held by pid=${pid} (age=${ageMs}ms) at ${lockPath}`,
      `pid=${pid};age=${ageMs}ms`,
    );
    this.name = "GeneratorLockActiveError";
    this.lockPath = lockPath;
    this.pid = pid;
    this.ageMs = ageMs;
  }
}

export class StaleLockUnrecoverableError extends DiskAgentGeneratorError {
  readonly lockPath: string;
  readonly pid: number;
  readonly ageMs: number;
  constructor(lockPath: string, pid: number, ageMs: number) {
    super(
      "STALE_LOCK_UNRECOVERABLE",
      `stale lock at ${lockPath} (pid=${pid}, age=${ageMs}ms) cannot be reclaimed`,
      `pid=${pid};age=${ageMs}ms`,
    );
    this.name = "StaleLockUnrecoverableError";
    this.lockPath = lockPath;
    this.pid = pid;
    this.ageMs = ageMs;
  }
}

export class ManifestInvalidError extends DiskAgentGeneratorError {
  constructor(detail: string) {
    super("MANIFEST_INVALID", `manifest invalid: ${detail}`, detail);
    this.name = "ManifestInvalidError";
  }
}

export class ModifiedOwnedFileError extends DiskAgentGeneratorError {
  readonly file: string;
  readonly expectedSha256: string;
  readonly actualSha256: string;
  constructor(file: string, expectedSha256: string, actualSha256: string) {
    super(
      "MODIFIED_OWNED_FILE",
      `owned file "${file}" was modified outside the generator (expected sha256=${expectedSha256}, got ${actualSha256}); refusing to delete`,
      `expected=${expectedSha256};actual=${actualSha256}`,
    );
    this.name = "ModifiedOwnedFileError";
    this.file = file;
    this.expectedSha256 = expectedSha256;
    this.actualSha256 = actualSha256;
  }
}

export class DescriptorBudgetExceededError extends DiskAgentGeneratorError {
  readonly bytes: number;
  readonly budget: number;
  constructor(bytes: number, budget: number) {
    super(
      "DESCRIPTOR_BUDGET_EXCEEDED",
      `generated descriptor is ${bytes} bytes, exceeding the ${budget} byte budget`,
      `bytes=${bytes};budget=${budget}`,
    );
    this.name = "DescriptorBudgetExceededError";
    this.bytes = bytes;
    this.budget = budget;
  }
}

export class SweepIncompleteError extends DiskAgentGeneratorError {
  readonly failedPath: string;
  constructor(failedPath: string, message = "sweep deletion failed") {
    super("SWEEP_INCOMPLETE", `sweep failed at "${failedPath}": ${message}`, failedPath);
    this.name = "SweepIncompleteError";
    this.failedPath = failedPath;
  }
}

// ============================================================================
// Routes config
// ============================================================================

export interface RouteEntry {
  readonly baseTemplate: string;
  readonly providerId: string;
  readonly modelId: string;
}

export interface SizeException {
  readonly reason: string;
  readonly approvedBy?: string;
  readonly approvedAt?: string;
}

export interface RoutesConfig {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generatorVersion: string;
  readonly cap: number;
  readonly sizeException: SizeException | null;
  readonly routes: ReadonlyArray<RouteEntry>;
}

export function decodeRoutesConfig(source: string | unknown): RoutesConfig {
  let raw: unknown;
  if (typeof source === "string") {
    try {
      raw = JSON.parse(source);
    } catch (err) {
      throw new RoutesConfigInvalidError(
        `routes.json is not valid JSON (${(err as Error).message})`,
      );
    }
  } else {
    raw = source;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RoutesConfigInvalidError("routes.json must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  if (obj["schemaVersion"] !== SCHEMA_VERSION) {
    throw new RoutesConfigInvalidError(
      `routes.json schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(obj["schemaVersion"])})`,
    );
  }
  if (typeof obj["generatorVersion"] !== "string" || obj["generatorVersion"].length === 0) {
    throw new RoutesConfigInvalidError("routes.json generatorVersion must be a non-empty string");
  }
  if (!Array.isArray(obj["routes"]) || obj["routes"].length === 0) {
    throw new RoutesConfigInvalidError("routes.json routes must be a non-empty array");
  }

  const declaredCap = typeof obj["cap"] === "number" ? obj["cap"] : FLEET_DEFAULT_CAP;
  if (!Number.isInteger(declaredCap) || declaredCap < 1) {
    throw new RoutesConfigInvalidError(`routes.json cap must be a positive integer (got ${declaredCap})`);
  }
  if (declaredCap > HARD_MAX_ROUTES) {
    throw new RouteCapExceededError(obj["routes"].length, declaredCap);
  }

  const sizeException = parseSizeException(obj["sizeException"]);

  const routes: RouteEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < obj["routes"].length; i += 1) {
    const entry = obj["routes"][i];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RoutesConfigInvalidError(`routes[${i}] must be an object`);
    }
    const e = entry as Record<string, unknown>;
    const baseTemplate = e["baseTemplate"];
    const providerId = e["providerId"];
    const modelId = e["modelId"];
    if (typeof baseTemplate !== "string" || baseTemplate.length === 0) {
      throw new RoutesConfigInvalidError(`routes[${i}].baseTemplate must be a non-empty string`);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(baseTemplate)) {
      throw new RoutesConfigInvalidError(
        `routes[${i}].baseTemplate "${baseTemplate}" must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}`,
      );
    }
    if (typeof providerId !== "string" || providerId.length === 0 || providerId.includes("/")) {
      throw new RoutesConfigInvalidError(
        `routes[${i}].providerId must be a non-empty string without "/"`,
      );
    }
    if (typeof modelId !== "string" || modelId.length === 0 || modelId.includes("/")) {
      throw new RoutesConfigInvalidError(
        `routes[${i}].modelId must be a non-empty string without "/"`,
      );
    }
    const key = `${providerId}/${modelId}`;
    if (seen.has(key)) {
      throw new RoutesConfigInvalidError(
        `routes[${i}] duplicates canonical pair (${key})`,
      );
    }
    seen.add(key);
    routes.push({ baseTemplate, providerId, modelId });
  }

  // Cap enforcement happens after we've validated the entries so the error
  // message can name the actual count.
  if (routes.length > HARD_MAX_ROUTES) {
    throw new RouteCapExceededError(routes.length, HARD_MAX_ROUTES);
  }
  if (routes.length > declaredCap) {
    if (routes.length > FLEET_DEFAULT_CAP && routes.length <= HARD_MAX_ROUTES && !sizeException) {
      throw new RouteCapExceededError(routes.length, declaredCap);
    }
    if (routes.length > declaredCap && routes.length <= HARD_MAX_ROUTES && !sizeException) {
      throw new RouteCapExceededError(routes.length, declaredCap);
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: obj["generatorVersion"] as string,
    cap: declaredCap,
    sizeException,
    routes,
  };
}

function parseSizeException(value: unknown): SizeException | null {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RoutesConfigInvalidError("routes.json sizeException must be an object when present");
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj["reason"] !== "string" || obj["reason"].trim().length === 0) {
    throw new RoutesConfigInvalidError("routes.json sizeException.reason must be a non-empty string");
  }
  const reason = obj["reason"].trim();
  const approvedBy = typeof obj["approvedBy"] === "string" ? obj["approvedBy"] : null;
  const approvedAt = typeof obj["approvedAt"] === "string" ? obj["approvedAt"] : null;
  if (approvedBy === null && approvedAt === null) {
    return { reason };
  }
  const out: { reason: string; approvedBy?: string; approvedAt?: string } = { reason };
  if (approvedBy !== null) out.approvedBy = approvedBy;
  if (approvedAt !== null) out.approvedAt = approvedAt;
  return out;
}

export function encodeRoutesConfig(config: RoutesConfig): string {
  const payload: Record<string, unknown> = {
    schemaVersion: config.schemaVersion,
    generatorVersion: config.generatorVersion,
    cap: config.cap,
    routes: config.routes,
  };
  if (config.sizeException) payload["sizeException"] = config.sizeException;
  return JSON.stringify(payload, null, 2);
}

// ============================================================================
// Path safety
// ============================================================================

function isWindows(): boolean {
  return process.platform === "win32";
}

interface CanonicalPath {
  readonly absolute: string;
  readonly caseFolded: string;
}

function canonicalizeExisting(p: string): CanonicalPath {
  // Realpath resolves symlinks. On Windows we still pass native: true to
  // get the canonical case as stored on disk.
  const absolute = path.resolve(p);
  let resolved: string;
  try {
    resolved = require("node:fs").realpathSync
      ? (require("node:fs").realpathSync(absolute) as string)
      : absolute;
  } catch {
    // Path may not exist yet (e.g. workspaceRoot on first run). Fall back
    // to path.resolve + case-fold normalization.
    resolved = absolute;
  }
  return { absolute: resolved, caseFolded: resolved.toLowerCase() };
}

function canonicalizeNonExisting(p: string): CanonicalPath {
  const absolute = path.resolve(p);
  return { absolute, caseFolded: absolute.toLowerCase() };
}

export interface SafeWorkspace {
  readonly root: string;
  readonly rootCaseFolded: string;
  readonly agentsDir: string;
  readonly commandsDir: string;
  readonly routingDir: string;
  readonly journalDir: string;
  readonly lockPath: string;
  readonly manifestPath: string;
}

export function assertWithinWorkspace(root: SafeWorkspace, target: string): string {
  const canon = canonicalizeNonExisting(target);
  if (!canon.absolute.startsWith(root.root + path.sep) && canon.absolute !== root.root) {
    throw new PathTraversalDetectedError(canon.absolute, "outside workspace root");
  }
  return canon.absolute;
}

function rejectSymlinksAtEveryComponent(p: string): void {
  let cursor = path.dirname(p);
  const segments: string[] = [];
  while (cursor && cursor !== path.dirname(cursor)) {
    segments.unshift(cursor);
    cursor = path.dirname(cursor);
  }
  for (const segment of segments) {
    let lst: ReturnType<typeof lstatSync>;
    try {
      lst = lstatSync(segment);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      let target = "";
      try {
        target = readlinkSync(segment);
      } catch {
        target = "<unreadable>";
      }
      throw new DiskSafetyError(segment, `symlink/junction/reparse point detected -> ${target}`);
    }
    if (isWindows()) {
      // On Windows, `lstat` reports `isSymbolicLink() === true` for both
      // file symlinks and directory junctions/reparse points. We keep the
      // explicit check above; the `reparse` semantic is folded in.
    }
    if (!lst.isDirectory() && !lst.isFile()) {
      throw new DiskSafetyError(segment, "non-regular file in path component");
    }
  }
}

export function prepareWorkspace(workspaceRoot: string): SafeWorkspace {
  const root = canonicalizeExisting(workspaceRoot);
  rejectSymlinksAtEveryComponent(root.absolute);
  mkdirSync(path.join(root.absolute, AGENTS_RELATIVE_DIR), { recursive: true });
  mkdirSync(path.join(root.absolute, COMMANDS_RELATIVE_DIR), { recursive: true });
  mkdirSync(path.join(root.absolute, ROUTING_RELATIVE_DIR), { recursive: true });
  mkdirSync(path.join(root.absolute, JOURNAL_RELATIVE_DIR), { recursive: true });
  return {
    root: root.absolute,
    rootCaseFolded: root.caseFolded,
    agentsDir: path.join(root.absolute, AGENTS_RELATIVE_DIR),
    commandsDir: path.join(root.absolute, COMMANDS_RELATIVE_DIR),
    routingDir: path.join(root.absolute, ROUTING_RELATIVE_DIR),
    journalDir: path.join(root.absolute, JOURNAL_RELATIVE_DIR),
    lockPath: path.join(root.absolute, LOCK_RELATIVE),
    manifestPath: path.join(root.absolute, MANIFEST_RELATIVE),
  };
}

// ============================================================================
// Hashing + manifest
// ============================================================================

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function safeReadFile(filePath: string): { exists: boolean; bytes: Buffer } {
  try {
    const buf = readFileSync(filePath);
    return { exists: true, bytes: buf };
  } catch {
    return { exists: false, bytes: Buffer.alloc(0) };
  }
}

export interface ManifestFileEntry {
  readonly relativePath: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface ManifestRouteEntry {
  readonly baseTemplate: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly hostName: string;
  readonly agentFile: ManifestFileEntry;
  readonly commandFile: ManifestFileEntry;
}

export interface Manifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly generatorVersion: string;
  readonly generationEpoch: string;
  readonly workspaceIdentity: string;
  readonly routingNamespace: string;
  readonly descriptorBudgetBytes: number;
  readonly requiredOpenCodeVersion: string;
  readonly routes: ReadonlyArray<ManifestRouteEntry>;
  readonly fileHashes: ReadonlyArray<string>;
  readonly manifestHash: string;
}

function buildManifest(opts: {
  epoch: string;
  workspaceIdentity: string;
  routes: ReadonlyArray<{
    baseTemplate: string;
    providerId: string;
    modelId: string;
    hostName: string;
    agentFile: ManifestFileEntry;
    commandFile: ManifestFileEntry;
  }>;
}): Manifest {
  const fileHashes = opts.routes
    .flatMap((r) => [r.agentFile.sha256, r.commandFile.sha256])
    .sort();
  // Compute the manifest hash over the body WITHOUT the manifestHash
  // field so on-disk round-trips and runtime verification agree.
  const body = {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    generationEpoch: opts.epoch,
    workspaceIdentity: opts.workspaceIdentity,
    routingNamespace: ROUTING_NAMESPACE_VERSION,
    descriptorBudgetBytes: DESCRIPTOR_BUDGET_BYTES,
    requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
    routes: opts.routes,
    fileHashes,
  };
  const manifestHash = sha256Hex(JSON.stringify(body));
  return { ...body, manifestHash };
}

// ============================================================================
// Templates
// ============================================================================

function buildCommandDescriptor(opts: {
  hostName: string;
  providerId: string;
  modelId: string;
}): string {
  const lines: string[] = [
    "---",
    `description: Canary dispatch for routed host ${opts.hostName} (${opts.providerId}/${opts.modelId}).`,
    `agent: ${opts.hostName}`,
    `model: ${opts.providerId}/${opts.modelId}`,
    "subtask: true",
    "---",
    "",
    `# sdd-mr-canary-${opts.hostName}`,
    "",
    "Canary invocation payload. The post-restart readiness harness calls this command with $ARGUMENTS",
    "to prove the routed subagent dispatches the canonical model end-to-end.",
    "",
    "$ARGUMENTS",
    "",
  ];
  return lines.join("\n");
}

// ============================================================================
// Lock + atomic swap
// ============================================================================

interface LockPayload {
  pid: number;
  acquiredAt: number;
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function readLockPayload(lockPath: string): LockPayload | null {
  const raw = safeReadFile(lockPath);
  if (!raw.exists) return null;
  try {
    const obj = JSON.parse(raw.bytes.toString("utf8")) as Partial<LockPayload>;
    if (typeof obj.pid !== "number" || typeof obj.acquiredAt !== "number") return null;
    return { pid: obj.pid, acquiredAt: obj.acquiredAt };
  } catch {
    return null;
  }
}

interface AcquiredLock {
  readonly path: string;
  release(): void;
}

function acquireExclusiveLock(lockPath: string, staleAfterMs: number): AcquiredLock {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const payload: LockPayload = { pid: process.pid, acquiredAt: Date.now() };
  const serialized = JSON.stringify(payload);
  let fd: number | null = null;
  try {
    fd = openSync(lockPath, "wx", 0o600);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "EEXIST") throw e;
    // Stale-lock recovery: prove the PID is dead AND the lock is old enough.
    const existing = readLockPayload(lockPath);
    const ageMs = existing ? Date.now() - existing.acquiredAt : Number.POSITIVE_INFINITY;
    const dead = existing ? !isPidAlive(existing.pid) : true;
    if (!existing || !dead || ageMs < staleAfterMs) {
      const pid = existing?.pid ?? -1;
      throw new GeneratorLockActiveError(lockPath, pid, Number.isFinite(ageMs) ? ageMs : -1);
    }
    // Reclaim: delete then retry once.
    try {
      unlinkSync(lockPath);
    } catch (reclaimErr) {
      throw new StaleLockUnrecoverableError(lockPath, existing?.pid ?? -1, ageMs);
    }
    try {
      fd = openSync(lockPath, "wx", 0o600);
    } catch (retryErr) {
      const re = retryErr as NodeJS.ErrnoException;
      throw new GeneratorLockActiveError(lockPath, existing?.pid ?? -1, ageMs);
    }
  }
  try {
    writeSync(fd!, serialized);
    fsyncSync(fd!);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  return {
    path: lockPath,
    release() {
      try {
        unlinkSync(lockPath);
      } catch {
        // Best-effort release; lock is short-lived.
      }
    },
  };
}

// fsync the parent directory so the rename survives a power loss on POSIX.
// On Windows, fsync on a directory handle is a no-op, so we wrap defensively.
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Not all platforms support directory fsync; ignore.
  }
}

// Atomic write: temp file in the SAME directory, fsync, journaled backup,
// rename, fsync parent directory. The journal keeps a `.bak` of the prior
// version so crash recovery can roll back to the last good manifest.
function atomicWriteDescriptor(opts: {
  finalPath: string;
  body: string;
  journalDir: string;
  budgetBytes: number;
}): { bytes: number; sha256: string } {
  const bytes = Buffer.byteLength(opts.body, "utf8");
  if (bytes > opts.budgetBytes) {
    throw new DescriptorBudgetExceededError(bytes, opts.budgetBytes);
  }
  const finalDir = path.dirname(opts.finalPath);
  mkdirSync(finalDir, { recursive: true });
  mkdirSync(opts.journalDir, { recursive: true });

  const baseName = path.basename(opts.finalPath);
  const tempPath = path.join(finalDir, `.${baseName}.${process.pid}.${Date.now()}.tmp`);
  const backupPath = path.join(opts.journalDir, `${baseName}.bak`);

  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, opts.body);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;

    // Move any prior final file into the journal as a single backup before
    // swapping the new content into place. This keeps a deterministic
    // rollback artifact under the routing dir.
    const prior = safeReadFile(opts.finalPath);
    if (prior.exists) {
      try {
        renameSync(opts.finalPath, backupPath);
      } catch (backupErr) {
        // Roll the temp aside and rethrow.
        try { unlinkSync(tempPath); } catch { /* ignore */ }
        throw backupErr;
      }
    }
    renameSync(tempPath, opts.finalPath);
    fsyncDir(finalDir);
    return { bytes, sha256: sha256Hex(opts.body) };
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ============================================================================
// Previous manifest read + stale cleanup
// ============================================================================

function readPreviousManifest(manifestPath: string): Manifest | null {
  const raw = safeReadFile(manifestPath);
  if (!raw.exists) return null;
  try {
    const parsed = JSON.parse(raw.bytes.toString("utf8")) as Manifest;
    if (
      typeof parsed.manifestHash !== "string" ||
      parsed.schemaVersion !== SCHEMA_VERSION
    ) {
      throw new ManifestInvalidError("previous manifest has wrong shape");
    }
    // Recompute the manifest hash over the body WITHOUT the manifestHash
    // field, matching how the generator builds the canonical form.
    const { manifestHash: _omitted, ...body } = parsed;
    const expected = sha256Hex(JSON.stringify(body));
    if (expected !== parsed.manifestHash) {
      throw new ManifestInvalidError("previous manifest hash mismatch (corruption)");
    }
    return parsed;
  } catch (err) {
    if (err instanceof ManifestInvalidError) throw err;
    throw new ManifestInvalidError(`previous manifest unreadable: ${(err as Error).message}`);
  }
}

function verifyOwnedFileUnchanged(opts: {
  absolutePath: string;
  expectedSha256: string;
}): void {
  const raw = safeReadFile(opts.absolutePath);
  if (!raw.exists) {
    throw new ModifiedOwnedFileError(opts.absolutePath, opts.expectedSha256, "<missing>");
  }
  const actual = sha256Hex(raw.bytes);
  if (actual !== opts.expectedSha256) {
    throw new ModifiedOwnedFileError(opts.absolutePath, opts.expectedSha256, actual);
  }
}

function safeUnlink(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    // best effort
  }
}

export interface SweepOptions {
  workspaceRoot: string;
  removeFile?: (absolutePath: string) => void;
}

export interface SweepResult {
  sweptRelativePaths: string[];
}

export function sweepOwnedFleetFiles(opts: SweepOptions): SweepResult {
  const workspace = prepareWorkspace(opts.workspaceRoot);
  const sweptRelativePaths: string[] = [];
  const remover = opts.removeFile ?? ((p: string) => unlinkSync(p));

  const checkAndSweepDir = (dirPath: string, relativeDir: string, prefix: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dirPath);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name.startsWith(prefix) && name.endsWith(".md")) {
        const fullPath = path.join(dirPath, name);
        const relPath = path.join(relativeDir, name);
        const lst = lstatSync(fullPath);
        if (lst.isSymbolicLink()) {
          throw new DiskSafetyError(fullPath, "symlink or junction detected in owned directory");
        }
        if (!lst.isFile()) {
          throw new DiskSafetyError(fullPath, "non-regular file detected in owned directory");
        }
        try {
          remover(fullPath);
          sweptRelativePaths.push(relPath);
        } catch (err) {
          throw new SweepIncompleteError(relPath, (err as Error).message);
        }
      }
    }
  };

  checkAndSweepDir(workspace.agentsDir, AGENTS_RELATIVE_DIR, ROUTE_AGENT_PREFIX);
  checkAndSweepDir(workspace.commandsDir, COMMANDS_RELATIVE_DIR, ROUTE_COMMAND_PREFIX);

  return { sweptRelativePaths };
}

// ============================================================================
// Public API
// ============================================================================

export type DiskAgentGeneratorOptions =
  | {
      readonly workspaceRoot: string;
      readonly routesConfigPath: string;
      readonly routesConfig?: never;
      readonly lockStaleAfterMs?: number;
      readonly additionalConfigRoots?: readonly string[];
    }
  | {
      readonly workspaceRoot: string;
      readonly routesConfigPath?: never;
      readonly routesConfig: RoutesConfig;
      readonly lockStaleAfterMs?: number;
      readonly additionalConfigRoots?: readonly string[];
    };

export interface GeneratedRoute {
  readonly baseTemplate: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly hostName: string;
  readonly agentRelative: string;
  readonly commandRelative: string;
}

export interface GenerateResult {
  readonly manifest: Manifest;
  readonly generated: ReadonlyArray<GeneratedRoute>;
  readonly sweptRelativePaths: ReadonlyArray<string>;
}

export class DiskAgentGenerator {
  private readonly workspace: SafeWorkspace;
  private readonly routesConfigPath: string | null;
  private readonly routesConfig: RoutesConfig | null;
  private readonly lockStaleAfterMs: number;
  private readonly additionalConfigRoots: readonly string[];

  constructor(options: DiskAgentGeneratorOptions) {
    this.workspace = prepareWorkspace(options.workspaceRoot);
    this.routesConfigPath = options.routesConfigPath ? path.resolve(options.routesConfigPath) : null;
    this.routesConfig = options.routesConfig ?? null;
    this.lockStaleAfterMs = options.lockStaleAfterMs ?? LOCK_STALE_AFTER_MS;
    this.additionalConfigRoots = options.additionalConfigRoots ?? [];
  }

  async generate(): Promise<GenerateResult> {
    let config: RoutesConfig;
    if (this.routesConfigPath !== null) {
      if (
        !this.routesConfigPath.startsWith(this.workspace.root + path.sep) &&
        this.routesConfigPath !== this.workspace.root
      ) {
        throw new PathTraversalDetectedError(
          this.routesConfigPath,
          "routes config path must live inside workspace root",
        );
      }
      const configJson = readFileSync(this.routesConfigPath, "utf8");
      config = decodeRoutesConfig(configJson);
    } else if (this.routesConfig !== null) {
      config = this.routesConfig;
    } else {
      throw new RoutesConfigInvalidError("no routes config provided");
    }

    const lock = acquireExclusiveLock(this.workspace.lockPath, this.lockStaleAfterMs);
    let released = false;
    const releaseOnce = (): void => {
      if (!released) {
        lock.release();
        released = true;
      }
    };

    try {
      const previous = readPreviousManifest(this.workspace.manifestPath);

      // Verify EVERY previously-owned file hash (REQ-4) before sweep/deletions
      if (previous) {
        for (const r of previous.routes) {
          verifyOwnedFileUnchanged({
            absolutePath: path.join(this.workspace.root, r.agentFile.relativePath),
            expectedSha256: r.agentFile.sha256,
          });
          verifyOwnedFileUnchanged({
            absolutePath: path.join(this.workspace.root, r.commandFile.relativePath),
            expectedSha256: r.commandFile.sha256,
          });
        }
      }

      // Assert no foreign agents (Task 7)
      const sources = resolveForeignAgentSources({
         workspaceRoot: this.workspace.root,
         additionalConfigRoots: this.additionalConfigRoots
      });
      assertNoForeignAgentDefinitions({
         workspaceRoot: this.workspace.root,
         sources,
         ownedAgentFiles: previous ? previous.routes.map(r => ({
            relativePath: r.agentFile.relativePath,
            sha256: r.agentFile.sha256
         })) : [],
         reservedPrefix: ROUTED_HOST_NAME_PREFIX
      });

      // Unconditional prefix-scoped sweep (REQ-5)
      const sweepRes = sweepOwnedFleetFiles({ workspaceRoot: this.workspace.root });

      // Build new manifest routes. Generate deterministic host names up
      // front so collisions (if any) surface as a typed error.
      const newHostNames = new Set<string>();
      const newRoutes: GeneratedRoute[] = config.routes.map((route) => {
        const hostName = hashHostName(route.baseTemplate, route);
        if (newHostNames.has(hostName)) {
          throw new RoutesConfigInvalidError(
            `host name collision for baseTemplate="${route.baseTemplate}" + canonical=${route.providerId}/${route.modelId}`,
          );
        }
        newHostNames.add(hostName);
        return {
          baseTemplate: route.baseTemplate,
          providerId: route.providerId,
          modelId: route.modelId,
          hostName,
          agentRelative: path.join(AGENTS_RELATIVE_DIR, `${ROUTE_AGENT_PREFIX}${extractHash(hostName)}.md`),
          commandRelative: path.join(COMMANDS_RELATIVE_DIR, `${ROUTE_COMMAND_PREFIX}${extractHash(hostName)}.md`),
        };
      });

      // Generate epoch and manifest body. Reuse the previous epoch if the
      // existing manifest is well-formed (idempotent runs keep the epoch
      // stable so downstream attestations don't churn).
      const epoch = previous?.generationEpoch ?? randomBytes(16).toString("hex");
      const workspaceIdentity = canonicalizeExisting(this.workspace.root).absolute;

      const manifestRoutes: ManifestRouteEntry[] = [];
      for (const route of newRoutes) {
        const agentBody = renderCanonicalRoutedAgentMarkdown({
          providerId: route.providerId,
          modelId: route.modelId,
          hostName: route.hostName,
          baseTemplate: route.baseTemplate,
        });
        const commandBody = buildCommandDescriptor({
          hostName: route.hostName,
          providerId: route.providerId,
          modelId: route.modelId,
        });
        const agentAbsolute = path.join(this.workspace.root, route.agentRelative);
        const commandAbsolute = path.join(this.workspace.root, route.commandRelative);
        const agentWrite = atomicWriteDescriptor({
          finalPath: agentAbsolute,
          body: agentBody,
          journalDir: this.workspace.journalDir,
          budgetBytes: DESCRIPTOR_BUDGET_BYTES,
        });
        const commandWrite = atomicWriteDescriptor({
          finalPath: commandAbsolute,
          body: commandBody,
          journalDir: this.workspace.journalDir,
          budgetBytes: DESCRIPTOR_BUDGET_BYTES,
        });
        manifestRoutes.push({
          baseTemplate: route.baseTemplate,
          providerId: route.providerId,
          modelId: route.modelId,
          hostName: route.hostName,
          agentFile: {
            relativePath: route.agentRelative,
            sha256: agentWrite.sha256,
            bytes: agentWrite.bytes,
          },
          commandFile: {
            relativePath: route.commandRelative,
            sha256: commandWrite.sha256,
            bytes: commandWrite.bytes,
          },
        });
      }

      const manifest = buildManifest({
        epoch,
        workspaceIdentity,
        routes: manifestRoutes,
      });

      // Commit manifest LAST. Any failure above leaves the previous
      // manifest authoritative.
      const manifestJson = JSON.stringify(manifest, null, 2);
      atomicWriteDescriptor({
        finalPath: this.workspace.manifestPath,
        body: manifestJson,
        journalDir: this.workspace.journalDir,
        budgetBytes: Number.POSITIVE_INFINITY,
      });

      // The manifest is authoritative after a successful commit; recovery
      // backups must not remain visible as an in-flight journal.
      rmSync(this.workspace.journalDir, { recursive: true, force: true });

      return {
        manifest,
        generated: newRoutes,
        sweptRelativePaths: sweepRes.sweptRelativePaths,
      };
    } finally {
      releaseOnce();
    }
  }
}

function extractHash(hostName: string): string {
  // hostName is `${ROUTED_HOST_NAME_PREFIX}${hex}` where hex is exactly 16
  // lowercase hex chars (see `hashHostName`). Strip the prefix and return
  // the suffix for the on-disk filename.
  return hostName.slice(ROUTED_HOST_NAME_PREFIX.length);
}

// `HASH_HEX_LENGTH` is exported only to keep the surface discoverable for
// downstream callers (Unit 4 attestation, Unit 5 hooks). It mirrors the
// `ROUTED_HOST_NAME_HEX_LENGTH` constant in the host-naming module.
export const HOST_HASH_HEX_LENGTH = HASH_HEX_LENGTH;
