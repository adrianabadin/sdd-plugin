/**
 * Shared model-routing test fixtures.
 *
 * Extracted from `tests/natural-routing-security-failures.test.ts`
 * (WU4 remediation D6 / S2) so the test file stays under the
 * 800-line review budget. Reused by the natural-routing security
 * suite, the WU3 v2 boot manager test, and (forward) any future
 * model-routing test that needs a hermetic hook / boot manager.
 *
 * Convention: the existing `tests/helpers/` folder already hosts
 * `init-child-runner.ts` and `temp-database.ts`; this file follows
 * the same `tests/helpers/*.ts` import path.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

import { hashHostName } from "../../src/domain/model-routing/model-route-host-naming.js";
import { ModelRouteTaskHook } from "../../src/infrastructure/opencode/model-route-task-hook.js";
import { ModelRouteResolver, type ModelRouteAliasTable } from "../../src/domain/model-routing/model-route-resolver.js";
import { NATURAL_MODEL_ALIASES } from "../../src/domain/model-routing/natural-model-aliases.js";
import { QuarantineStoreImpl } from "../../src/infrastructure/runtime/quarantine-store.js";
import { WindowsModelRouteBootManager } from "../../src/infrastructure/runtime/windows-model-route-boot-manager.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../../src/ports/model-route-catalog.port.js";
import type { CanaryHostTransport, CanarySession } from "../../src/infrastructure/opencode/model-route-canary.js";
import type { Manifest } from "../../src/infrastructure/opencode/disk-agent-generator.js";

// ---------------------------------------------------------------------------
// Generic fs / timing / crypto helpers
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> { return new Promise<void>((r) => setTimeout(r, ms)); }

export async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

export function sha256(value: string | Buffer): string { return createHash("sha256").update(value).digest("hex"); }

export function writeStrict(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

export function readAllLines(filePath: string): Array<Record<string, unknown>> {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Catalog + canary stubs
// ---------------------------------------------------------------------------

/** A hermetic `ModelRouteCatalogPort` that answers `existsCanonical` from an in-memory set. */
export function stubCatalog(known: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }>): ModelRouteCatalogPort & {
  searchNormalizedCalls: string[];
} {
  const set = new Set(known.map((c) => `${c.providerId}/${c.modelId}`));
  const searchNormalizedCalls: string[] = [];
  return {
    searchNormalizedCalls,
    async existsCanonical(p, m) { return set.has(`${p}/${m}`); },
    async searchNormalized(term, _limit) { searchNormalizedCalls.push(term); return []; },
  };
}

/** A `ModelRouteCatalogPort` with a `addCanonical()` builder for the boot manager tests. */
export class BootStubCatalog implements ModelRouteCatalogPort {
  private readonly known = new Set<string>();
  addCanonical(providerId: string, modelId: string): void {
    this.known.add(`${providerId}/${modelId}`);
  }
  async existsCanonical(providerId: string, modelId: string): Promise<boolean> {
    return this.known.has(`${providerId}/${modelId}`);
  }
  async searchNormalized(_term: string, _limit: number): Promise<ReadonlyArray<RouteCandidate>> { return []; }
}

/**
 * Hermetic canary transport: the WU4 fixture target is hard-coded
 * to `google/antigravity-gemini-3.6-flash-tiered`; the parent is
 * always `openai/gpt-4o`. `listChildren` returns `[]` BEFORE the
 * first `invokeCommand` and a fresh child ID after, so the canary's
 * `observable = after - before` diff is non-empty.
 */
export class BootStubCanary implements CanaryHostTransport {
  private counter = 0;
  private invokedCount = 0;
  private readonly invokedCommands: Array<{ arguments: string; parentModel: string }> = [];
  async createSession(_input: { parentModel: string }): Promise<CanarySession> {
    return { id: `sess-${this.counter++}`, model: { providerID: "openai", modelID: "gpt-4o" } };
  }
  async getSession(sessionId: string): Promise<CanarySession> { return { id: sessionId, model: { providerID: "openai", modelID: "gpt-4o" } }; }
  async invokeCommand(input: { sessionId: string; command: string; arguments: string; parentModel: string }): Promise<void> {
    this.invokedCount += 1;
    this.invokedCommands.push({ arguments: input.arguments, parentModel: input.parentModel });
  }
  async listChildren(_parentSessionId: string): Promise<ReadonlyArray<CanarySession>> {
    if (this.invokedCount === 0) return [];
    return [{ id: `child-of-${_parentSessionId}-${this.invokedCount}` }];
  }
  async listMessages(_childSessionId: string): Promise<ReadonlyArray<unknown>> {
    const last = this.invokedCommands[this.invokedCommands.length - 1];
    if (!last) return [];
    const target = "google/antigravity-gemini-3.6-flash-tiered";
    const [providerID, modelID] = target.split("/");
    if (!providerID || !modelID) return [];
    return [
      { info: { role: "user", model: { providerID, modelID } } },
      { info: { role: "assistant", providerID, modelID, finish: "stop", time: { completed: 1 } } },
    ];
  }
}

// ---------------------------------------------------------------------------
// Hook + boot manager builders
// ---------------------------------------------------------------------------

/** Build a `ModelRouteTaskHook` with hermetic defaults (bootIdentity + signing key from the WU2 test corpus). */
export function makeHook(opts: {
  workspaceRoot: string;
  resolver: ModelRouteResolver;
  quarantineStore: QuarantineStoreImpl;
  auditPath: string;
  bootIdentity?: string;
  signingKey?: string;
}): ModelRouteTaskHook {
  return new ModelRouteTaskHook({
    workspaceRoot: opts.workspaceRoot,
    manifestPath: path.join(opts.workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json"),
    bootIdentity: opts.bootIdentity ?? "boot-1",
    signingKey: opts.signingKey ?? "explicit-shared-key",
    resolver: opts.resolver,
    quarantineStore: opts.quarantineStore,
    audit: { path: opts.auditPath },
  });
}

/** Build a `WindowsModelRouteBootManager` with hermetic defaults. */
export function makeBootManager(root: string, manifestPath: string, opts: {
  catalog: ModelRouteCatalogPort;
  isProcessAlive?: (pid: number) => boolean;
  now?: () => number;
}): WindowsModelRouteBootManager {
  return new WindowsModelRouteBootManager({
    workspaceRoot: root,
    manifestPath,
    catalog: opts.catalog,
    canary: new BootStubCanary(),
    selectParentModel: async (target) => target === "google/antigravity-gemini-3.6-flash-tiered" ? "openai/gpt-4o" : null,
    isProcessAlive: opts.isProcessAlive ?? (() => false),
    now: opts.now,
  });
}

// ---------------------------------------------------------------------------
// Manifest + attestation seeding (unified: S2 fix)
// ---------------------------------------------------------------------------

interface BuildManifestArgs {
  providerId: string;
  modelId: string;
  workspaceRoot: string;
  generationEpoch?: string;
}

/** Internal: build the manifest body + write the agent/command files + return both the body and the hostName. */
function buildManifest(args: BuildManifestArgs): { hostName: string; body: Omit<Manifest, "manifestHash">; agentRelative: string; commandRelative: string } {
  const { providerId, modelId, workspaceRoot } = args;
  const hostName = hashHostName("sdd-mr-base", { providerId, modelId });
  const suffix = hostName.slice("sdd-mr-v1-".length);
  const agentRelative = path.join(".opencode", "agents", `sdd-mr-v1-${suffix}.md`);
  const commandRelative = path.join(".opencode", "commands", `sdd-mr-canary-v1-${suffix}.md`);
  const agentBody = `agent-${hostName}`;
  const commandBody = `command-${hostName}`;
  writeStrict(path.join(workspaceRoot, agentRelative), agentBody);
  writeStrict(path.join(workspaceRoot, commandRelative), commandBody);
  const body: Omit<Manifest, "manifestHash"> = {
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    generationEpoch: args.generationEpoch ?? "epoch-wu4",
    workspaceIdentity: path.resolve(workspaceRoot),
    routingNamespace: "sdd-mr-v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: "1.18.9",
    routes: [{
      baseTemplate: "sdd-mr-base",
      providerId, modelId, hostName,
      agentFile: { relativePath: agentRelative, sha256: sha256(agentBody), bytes: Buffer.byteLength(agentBody, "utf8") },
      commandFile: { relativePath: commandRelative, sha256: sha256(commandBody), bytes: Buffer.byteLength(commandBody, "utf8") },
    }],
    fileHashes: [sha256(agentBody), sha256(commandBody)],
  };
  return { hostName, body, agentRelative, commandRelative };
}

/** Seed a manifest + a signed attestation. Used by hook tests (sections 1-4, 8b). */
export function seedManifestAndAttestation(root: string, providerId: string, modelId: string, opts: { bootIdentity?: string; signingKey?: string; expiresAtMs?: number } = {}): { hostName: string; attestationPath: string; signingKey: Buffer } {
  const { hostName, body } = buildManifest({ providerId, modelId, workspaceRoot: root });
  mkdirSync(path.join(root, ".opencode", "sdd-model-routing"), { recursive: true });
  const manifest: Manifest = { ...body, manifestHash: sha256(JSON.stringify(body)) };
  writeFileSync(path.join(root, ".opencode", "sdd-model-routing", "manifest.json"), JSON.stringify(manifest, null, 2));
  const attestationPath = path.join(root, ".opencode", "sdd-model-routing", "attestation.json");
  const signingKey = opts.signingKey ? Buffer.from(opts.signingKey, "utf8") : Buffer.from("explicit-shared-key", "utf8");
  const attestationBody = {
    schemaVersion: 1 as const,
    verifierVersion: "1.0.0",
    openCodeVersion: "1.18.9",
    workspaceIdentity: path.resolve(root),
    generationEpoch: "epoch-wu4",
    manifestHash: manifest.manifestHash,
    fileHashes: [...manifest.fileHashes].sort(),
    bootIdentity: opts.bootIdentity ?? "boot-1",
    nonce: "nonce-wu4",
    issuedAt: Date.now() - 1000,
    expiresAt: opts.expiresAtMs ?? Date.now() + 600_000,
    canaries: [],
  };
  const signature = createHmac("sha256", signingKey).update(JSON.stringify(attestationBody)).digest("hex");
  writeFileSync(attestationPath, JSON.stringify({ ...attestationBody, signature }, null, 2));
  return { hostName, attestationPath, signingKey };
}

/** Seed a manifest for the boot manager (no attestation; the boot manager writes its own). Used by sections 5/6. */
export function seedBootManifest(workspaceRoot: string, providerId: string, modelId: string): { routingDir: string; manifestPath: string; hostName: string } {
  const { hostName, body } = buildManifest({ providerId, modelId, workspaceRoot });
  const routingDir = path.join(workspaceRoot, ".opencode", "sdd-model-routing");
  const manifestPath = path.join(routingDir, "manifest.json");
  const manifest: Manifest = { ...body, manifestHash: sha256(JSON.stringify(body)) };
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { routingDir, manifestPath, hostName };
}

// ---------------------------------------------------------------------------
// Convenience: resolver with the verified WU1 alias table
// ---------------------------------------------------------------------------

export function makeResolverWithAliases(known: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }>): ModelRouteResolver {
  return new ModelRouteResolver(stubCatalog(known), NATURAL_MODEL_ALIASES satisfies ModelRouteAliasTable);
}

/** Build a resolver with a custom catalog port (e.g. an empty catalog) and the verified WU1 aliases. */
export function makeResolverWithCatalog(catalog: ModelRouteCatalogPort): ModelRouteResolver {
  return new ModelRouteResolver(catalog, NATURAL_MODEL_ALIASES);
}

// ---------------------------------------------------------------------------
// Windowed file walker (used by section 5's on-disk key-byte scan)
// ---------------------------------------------------------------------------

export function walkForContent(dir: string, predicate: (buf: Buffer) => boolean): string[] {
  const violations: string[] = [];
  if (!existsSync(dir)) return violations;
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const p = path.join(current, entry);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        const content = readFileSync(p);
        if (content.length > 0 && predicate(content)) violations.push(p);
      }
    }
  };
  walk(dir);
  return violations;
}

// ---------------------------------------------------------------------------
// Independent-fd read (W3 durability assertion)
// ---------------------------------------------------------------------------

/** Open an independent descriptor over the audit file, read all bytes, close. */
export function readAllViaIndependentFd(filePath: string): Buffer {
  const fd = openSync(filePath, "r");
  try {
    const size = statSync(filePath).size;
    const buf = Buffer.alloc(size);
    let totalRead = 0;
    while (totalRead < size) {
      const n = readSync(fd, buf, totalRead, size - totalRead, totalRead);
      if (n === 0) break;
      totalRead += n;
    }
    return buf.subarray(0, totalRead);
  } finally { closeSync(fd); }
}
