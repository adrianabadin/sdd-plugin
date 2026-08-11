import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPrismaClient } from "../src/bootstrap/index.js";
import {
  classify,
  CANARY_FLEET_EMPTY_EXIT_CODE,
  CANARY_MANIFEST_MISMATCH_EXIT_CODE,
} from "../src/cli/model-route-boot.js";
import {
  CanaryFleetEmptyError,
  CanaryManifestMismatchError,
  WindowsModelRouteBootManager,
  type BootAuditPort,
} from "../src/infrastructure/runtime/windows-model-route-boot-manager.js";
import type { CanaryHostTransport, CanarySession } from "../src/infrastructure/opencode/model-route-canary.js";
import { REQUIRED_OPENCODE_VERSION } from "../src/infrastructure/opencode/model-route-readiness.js";
import { ModelRouteAuditLogger } from "../src/infrastructure/logging/model-route-audit.logger.js";
import { RegenerateFleetAgentsUseCase } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.use-case.js";
import type { GeneratedRoute, Manifest, ManifestRouteEntry } from "../src/infrastructure/opencode/disk-agent-generator.js";
import type { RegenerateFleetAgentsInput, RegenerateFleetAgentsOutput } from "../src/application/regenerate-fleet-agents/regenerate-fleet-agents.input.js";
import type { ExcludedRoute } from "../src/application/filter-fleet-routes/filter-fleet-routes.input.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../src/ports/quarantine-write.port.js";
import type { QuarantineEntry, QuarantineTarget } from "../src/domain/model/quarantine.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoCliEntry = path.join(repoRoot, "src", "cli", "model-route-agents.ts");
const bootCliEntry = path.join(repoRoot, "src", "cli", "model-route-boot.ts");
const tsxCliWin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

const NOW = 1_800_000_000_000;

const WU5_ROUTES: ReadonlyArray<{ hostName: string; providerId: string; modelId: string; parent: string; baseTemplate: string }> = [
  { hostName: "sdd-mr-v1-pf-a", providerId: "google", modelId: "antigravity-gemini-3.6-flash-tiered", parent: "anthropic/claude-haiku-4-5", baseTemplate: "sdd-mr-base" },
  { hostName: "sdd-mr-v1-pf-b", providerId: "anthropic", modelId: "claude-3-5-sonnet", parent: "google/gemini-2.0-flash", baseTemplate: "sdd-mr-base" },
  { hostName: "sdd-mr-v1-pf-c", providerId: "openai", modelId: "gpt-4o", parent: "openai/gpt-5.6-luna", baseTemplate: "sdd-mr-base" },
];

const WU5_CANONICAL_OF = (route: { providerId: string; modelId: string }): string => `${route.providerId}/${route.modelId}`;
const WU5_HOST_OF: Record<string, { providerId: string; modelId: string }> = Object.fromEntries(
  WU5_ROUTES.map((r) => [r.hostName, { providerId: r.providerId, modelId: r.modelId }]),
);

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

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
    const target = WU5_HOST_OF[hostName];
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
    return { level: cmd.level, providerId: cmd.providerId, modelId: cmd.modelId, type: cmd.type, until: cmd.until, reason: cmd.reason };
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

class ManifestRewriteRegeneration extends RegenerateFleetAgentsUseCase {
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
    const excludedIds = new Set<string>();
    for (const canonical of input.excludeCanonicalIds ?? []) {
      const route = this.allRoutes.find((r) => WU5_CANONICAL_OF(r) === canonical);
      if (!route) continue;
      excludedIds.add(canonical);
      rmSync(path.join(this.root, route.agentFile.relativePath), { force: true });
      rmSync(path.join(this.root, route.commandFile.relativePath), { force: true });
    }

    const excludedRoutes = this.allRoutes.filter((r) => excludedIds.has(WU5_CANONICAL_OF(r)));
    const excluded: ExcludedRoute[] = excludedRoutes.map((r) => ({
      route: { baseTemplate: r.baseTemplate, providerId: r.providerId, modelId: r.modelId, hostName: r.hostName },
      reason: "CANARY_BLOCKED",
      detail: `canary blocked ${WU5_CANONICAL_OF(r)}`,
    }));
    const routes = this.ignoreExclusionsNext
      ? [...this.allRoutes]
      : this.allRoutes.filter((r) => !excludedIds.has(WU5_CANONICAL_OF(r)));

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
      generationEpoch: "epoch-cli-regen",
      workspaceIdentity: path.resolve(this.root),
      routingNamespace: "sdd-mr-v1",
      descriptorBudgetBytes: 4096,
      requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
      routes,
      fileHashes: routes.flatMap((r) => [r.agentFile.sha256, r.commandFile.sha256]).sort(),
    };
    writeManifest(this.root, { ...body, manifestHash: sha256(JSON.stringify(body)) });

    return {
      generated,
      excluded,
      manifestHash: sha256(JSON.stringify(body)),
      sweptRelativePaths: excludedRoutes.flatMap((r) => [r.agentFile.relativePath, r.commandFile.relativePath]),
    };
  }
}

function makeBootHarness(root: string, failTargets: ReadonlySet<string>) {
  const routes = WU5_ROUTES;
  const entries = writeRouteFiles(root, routes);
  const manifestPath = writeManifest(root, buildManifest(root, entries, "epoch-cli-seed"));

  const catalog = new StubCatalog();
  for (const route of routes) catalog.addCanonical(route.providerId, route.modelId);

  const transport = new SelectiveFailCanaryTransport(failTargets);
  const quarantine = new RecordingQuarantine();
  const audit = new RecordingAudit();
  const parentByTarget = new Map(routes.map((r) => [WU5_CANONICAL_OF(r), r.parent]));
  const auditLogger = new ModelRouteAuditLogger({ path: path.join(root, ".opencode", "sdd-model-routing", "routing.audit.jsonl") });
  const regeneration = new ManifestRewriteRegeneration(catalog, quarantine, auditLogger, root, entries);

  const manager = new WindowsModelRouteBootManager({
    workspaceRoot: root,
    manifestPath,
    catalog,
    canary: transport,
    selectParentModel: async (target) => parentByTarget.get(target) ?? null,
    fleetRegeneration: regeneration,
    quarantine,
    audit,
    now: () => NOW,
  });

  return { manager, quarantine, audit };
}

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

function runBootCli(subcommand: "start" | "stop" | "status", workspaceRoot: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsxCliWin, bootCliEntry, subcommand, workspaceRoot],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

function seedStatusWorkspace(entries: ReadonlyArray<Record<string, unknown>>): string {
  const root = mkdtempSync(path.join(tmpdir(), "sdd-mr-cli-boot-status-"));
  const routingDir = path.join(root, ".opencode", "sdd-model-routing");
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(path.join(routingDir, "attestation.json"), JSON.stringify({ bootIdentity: "boot-status-cli", expiresAt: 1234567890 }));
  writeFileSync(path.join(routingDir, "generator.lock"), JSON.stringify({ pid: 1, bootIdentity: "boot-status-cli" }));
  if (entries.length > 0) {
    writeFileSync(
      path.join(routingDir, "routing.audit.jsonl"),
      `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
      "utf8",
    );
  }
  return root;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function cleanupDirAsync(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await sleep(50 * (attempt + 1));
    }
  }
}

function writeConfig(workspaceRoot: string, json: string): string {
  const configDir = path.join(workspaceRoot, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, "routes.json");
  writeFileSync(filePath, json, "utf8");
  return filePath;
}

function runCli(workspaceRoot: string, routesConfigPath: string): { stdout: string; stderr: string; code: number } {
  // Execute the CLI via tsx against an isolated workspace. The CLI MUST
  // accept a workspace root and routes config path so verification never
  // touches the real project `.opencode/` directory. On Windows we use
  // the tsx binary path directly because the .cmd shim needs shell
  // expansion that breaks execFileSync arg handling.
  const tsxBinWin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const tsxBin = process.platform === "win32" ? tsxBinWin : path.join(repoRoot, "node_modules", ".bin", "tsx");
  try {
    const stdout = execFileSync(
      process.execPath,
      [tsxBin, repoCliEntry, workspaceRoot, routesConfigPath],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        cwd: repoRoot,
      },
    );
    return { stdout, stderr: "", code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : "",
      stderr: typeof e.stderr === "string" ? e.stderr : "",
      code: typeof e.status === "number" ? e.status : 1,
    };
  }
}

async function run(): Promise<void> {
  console.log("--- model-route disk generator CLI ---");

  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "sdd-mr-cli-"));
  try {
    // 1. CLI is exposed at the expected source path
    assert.ok(existsSync(repoCliEntry), `CLI entry exists at ${repoCliEntry}`);

    // 2. Happy path: CLI generates owned files for a valid config in an
    //    isolated workspace and NEVER touches the project root `.opencode`.
    // Seed connected routes into persistent catalog for happy path test
    const prisma = getPrismaClient();
    await prisma.provider.upsert({ where: { id: "prov-cli-1" }, update: {}, create: { id: "prov-cli-1", name: "Provider 1" } });
    await prisma.provider.upsert({ where: { id: "prov-cli-2" }, update: {}, create: { id: "prov-cli-2", name: "Provider 2" } });
    await prisma.model.upsert({ where: { id: "model-cli-1" }, update: { quarantineType: null, quarantineReason: null, quarantineUntil: null }, create: { id: "model-cli-1", name: "Model 1" } });
    await prisma.model.upsert({ where: { id: "model-cli-2" }, update: { quarantineType: null, quarantineReason: null, quarantineUntil: null }, create: { id: "model-cli-2", name: "Model 2" } });
    await prisma.modelProvider.upsert({
      where: { modelId_providerId: { modelId: "model-cli-1", providerId: "prov-cli-1" } },
      update: {},
      create: { providerId: "prov-cli-1", modelId: "model-cli-1" },
    });
    await prisma.modelProvider.upsert({
      where: { modelId_providerId: { modelId: "model-cli-2", providerId: "prov-cli-2" } },
      update: {},
      create: { providerId: "prov-cli-2", modelId: "model-cli-2" },
    });

    const routesPath = writeConfig(
      workspaceRoot,
      JSON.stringify(
        {
          schemaVersion: 1,
          generatorVersion: "1.0.0",
          cap: 8,
          routes: [
            { baseTemplate: "sdd-mr-base", providerId: "prov-cli-1", modelId: "model-cli-1" },
            { baseTemplate: "sdd-mr-base", providerId: "prov-cli-2", modelId: "model-cli-2" },
          ],
        },
        null,
        2,
      ),
    );
    // 3. The real project `.opencode/` MUST NOT have been modified by the
    //    isolated CLI run (owned route files must be untouched, and the
    //    routing directory must not have been created or altered).
    const realAgentsDir = path.join(repoRoot, ".opencode", "agents");
    const realRoutingDir = path.join(repoRoot, ".opencode", "sdd-model-routing");
    const snapshotReal = (): string => {
      const parts: string[] = [];
      for (const dir of [realAgentsDir, realRoutingDir, path.join(repoRoot, ".opencode", "commands")]) {
        if (!existsSync(dir)) {
          parts.push(`${dir}=<absent>`);
          continue;
        }
        const entries = readdirSync(dir)
          .filter((e) => e.startsWith("sdd-mr-"))
          .sort()
          .map((e) => `${e}:${readFileSync(path.join(dir, e), "utf8").length}`);
        parts.push(`${dir}=[${entries.join(",")}]`);
      }
      return parts.join("|");
    };
    const realBefore = snapshotReal();
    const okBefore = runCli(workspaceRoot, routesPath);
    assert.equal(okBefore.code, 0, `CLI exits 0 on valid config (stderr=${okBefore.stderr})`);
    assert.match(okBefore.stdout, /generated=\d+ excluded=\d+ manifest=/, "CLI prints summary with generated and excluded counts");
    const realAfter = snapshotReal();
    assert.equal(
      realAfter,
      realBefore,
      "real project .opencode must be untouched after isolated CLI run",
    );

    // Manifest, agents, and commands are all present in the isolated workspace
    const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
    assert.ok(existsSync(manifestPath), "CLI writes manifest in isolated workspace");
    const agents = readdirSync(path.join(workspaceRoot, ".opencode", "agents"));
    const commands = readdirSync(path.join(workspaceRoot, ".opencode", "commands"));
    assert.equal(agents.length, 2, "CLI writes two agent descriptors");
    assert.equal(commands.length, 2, "CLI writes two command descriptors");
    for (const a of agents) {
      assert.ok(a.startsWith("sdd-mr-v1-") && a.endsWith(".md"), `agent ${a} matches owned prefix`);
    }
    for (const c of commands) {
      assert.ok(c.startsWith("sdd-mr-canary-v1-") && c.endsWith(".md"), `command ${c} matches owned prefix`);
    }

    // 4. Cap-exceeded config is rejected with a typed CLI exit code and a
    //    non-empty stderr message that names the cap class.
    const capConfigPath = writeConfig(
      workspaceRoot,
      JSON.stringify(
        {
          schemaVersion: 1,
          generatorVersion: "1.0.0",
          routes: Array.from({ length: 9 }, (_, i) => ({
            baseTemplate: `sdd-mr-base-${i}`,
            providerId: `p${i}`,
            modelId: `m${i}`,
          })),
        },
        null,
        2,
      ),
    );
    const capResult = runCli(workspaceRoot, capConfigPath);
    assert.notEqual(capResult.code, 0, "CLI exits non-zero on cap exceeded");
    assert.match(capResult.stderr, /cap|RouteCapExceededError|ROUTE_CAP_EXCEEDED/, "cap error class reported");

    // 5. Malformed config produces a precise error
    const malformedPath = writeConfig(workspaceRoot, "not json at all");
    const malformedResult = runCli(workspaceRoot, malformedPath);
    assert.notEqual(malformedResult.code, 0, "CLI exits non-zero on malformed config");
    assert.match(
      malformedResult.stderr,
      /RoutesConfigInvalidError|ROUTES_CONFIG_INVALID|valid JSON/,
      "malformed config error class reported",
    );

    // 6. Out-of-workspace routes config is rejected with path-traversal error
    const outsideWorkspace = path.join(tmpdir(), `sdd-mr-cli-outside-${Date.now()}`);
    mkdirSync(outsideWorkspace, { recursive: true });
    const outsideConfig = path.join(outsideWorkspace, "routes.json");
    writeFileSync(
      outsideConfig,
      JSON.stringify({
        schemaVersion: 1,
        generatorVersion: "1.0.0",
        routes: [{ baseTemplate: "sdd-mr-base", providerId: "p", modelId: "m" }],
      }),
      "utf8",
    );
    const outsideResult = runCli(workspaceRoot, outsideConfig);
    assert.notEqual(outsideResult.code, 0, "CLI rejects out-of-workspace routes config");
    assert.match(
      outsideResult.stderr,
      /path-traversal|inside workspace root|PathTraversalDetectedError/,
      "path-traversal error reported",
    );

    // ------------------------------------------------------------------
    // WU5 — bootstrap CLI surface (src/cli/model-route-boot.ts)
    // ------------------------------------------------------------------

    // 7. Ready line is a single line owned by the boot manager and carries
    //    proven/configured + blocked counts on a partial fleet.
    {
      const bootRoot = mkdtempSync(path.join(tmpdir(), "sdd-mr-cli-boot-"));
      const h = makeBootHarness(bootRoot, new Set(["openai/gpt-4o"]));
      try {
        const stdoutLines = await withCapturedStdout(async () => {
          await h.manager.start();
        });
        const readyLines = stdoutLines.filter((l) => l.startsWith("boot: state=ready"));
        assert.equal(readyLines.length, 1, "manager prints exactly one ready line (single source of truth)");
        assert.match(readyLines[0]!, /bootIdentity=[0-9a-f-]{36}/, "ready line carries the boot identity");
        assert.match(readyLines[0]!, /routes=2\/3 blocked=1/, "ready line reports proven/configured + blocked counts");
      } finally {
        try { await h.manager.stop(); } catch { /* best-effort */ }
        await cleanupDirAsync(bootRoot);
      }
    }

    // 8. CANARY_FLEET_EMPTY classifies to exit 9 with a diagnostic message;
    //    CANARY_MANIFEST_MISMATCH classifies to its documented code; the
    //    transport-level CANARY_* path keeps exit 4.
    {
      const bootRoot = mkdtempSync(path.join(tmpdir(), "sdd-mr-cli-boot-"));
      const h = makeBootHarness(bootRoot, new Set(WU5_ROUTES.map(WU5_CANONICAL_OF)));
      try {
        let thrown: unknown = null;
        try { await h.manager.start(); } catch (error) { thrown = error; }
        assert.ok(thrown instanceof CanaryFleetEmptyError, "whole-fleet failure throws CanaryFleetEmptyError");
        const classified = classify(thrown);
        assert.equal(classified.code, CANARY_FLEET_EMPTY_EXIT_CODE, "CANARY_FLEET_EMPTY maps to exit 9");
        assert.equal(classified.code, 9, "exit 9 is the documented CANARY_FLEET_EMPTY code");
        assert.match(classified.message, /CANARY_FLEET_EMPTY/, "exit-9 message names the error class");
        assert.match(classified.message, /blocked=3/, "exit-9 message reports the blocked count");

        const mismatch = classify(new CanaryManifestMismatchError(["sdd-mr-v1-pf-a"], ["sdd-mr-v1-pf-a", "sdd-mr-v1-pf-b"]));
        assert.equal(mismatch.code, CANARY_MANIFEST_MISMATCH_EXIT_CODE, "CANARY_MANIFEST_MISMATCH maps to its documented exit code");
        assert.match(mismatch.message, /CANARY_MANIFEST_MISMATCH/, "mismatch message names the error class");
        assert.equal(mismatch.message.includes("sdd-mr-v1-pf-b"), true, "mismatch message surfaces the differing host set");
      } finally {
        await cleanupDirAsync(bootRoot);
      }
    }

    // 9. `status` lists blocked hosts with reasons derived from the audit log.
    {
      const statusRoot = seedStatusWorkspace([
        {
          stage: "boot.route.canary_blocked",
          hostName: "sdd-mr-v1-pf-c",
          targetCanonicalId: "openai/gpt-4o",
          code: "CHILD_SESSION_MISSING",
          message: "no new child created for sdd-mr-v1-pf-c",
          attempts: 2,
          ts: 100,
        },
        {
          stage: "boot.route.canary_blocked",
          hostName: "sdd-mr-v1-pf-b",
          targetCanonicalId: "anthropic/claude-3-5-sonnet",
          code: "CANARY_TIMEOUT",
          message: "operation exceeded 300000ms",
          attempts: 2,
          ts: 100,
        },
      ]);
      try {
        const result = runBootCli("status", statusRoot);
        assert.equal(result.code, 0, `status exits 0 on a valid workspace (stderr=${result.stderr})`);
        assert.match(result.stdout, /boot: state=ready bootIdentity=boot-status-cli expiresAt=1234567890 lock=held blocked=2/, "status line reports the blocked count");
        assert.match(result.stdout, /blocked host=sdd-mr-v1-pf-c canonical=openai\/gpt-4o code=CHILD_SESSION_MISSING/, "status lists the blocked host with its canary code");
        assert.ok(result.stdout.includes("no new child created for sdd-mr-v1-pf-c"), "status lists the blocked host with its reason");
        assert.match(result.stdout, /blocked host=sdd-mr-v1-pf-b canonical=anthropic\/claude-3-5-sonnet code=CANARY_TIMEOUT/, "status lists the second blocked host");
      } finally {
        await cleanupDirAsync(statusRoot);
      }
    }

    // 10. `status` reports blocked=0 when the audit log has no blocked routes.
    {
      const statusRoot = seedStatusWorkspace([]);
      try {
        const result = runBootCli("status", statusRoot);
        assert.equal(result.code, 0, "status exits 0 without blocked audit entries");
        assert.match(result.stdout, /blocked=0/, "status reports blocked=0 when nothing is blocked");
        assert.doesNotMatch(result.stdout, /blocked host=/, "no per-host blocked lines when nothing is blocked");
      } finally {
        await cleanupDirAsync(statusRoot);
      }
    }

    console.log("All CLI assertions passed.");
  } finally {
    await cleanupDirAsync(workspaceRoot);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});