import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DiskAgentGenerator,
  DiskSafetyError,
  ManifestInvalidError,
  PathTraversalDetectedError,
  RouteCapExceededError,
  RoutesConfigInvalidError,
  decodeRoutesConfig,
  encodeRoutesConfig,
} from "../src/infrastructure/opencode/disk-agent-generator.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SCHEMA_VERSION = 1 as const;
const GENERATOR_VERSION = "1.1.0";
const ROUTING_NAMESPACE_VERSION = "sdd-mr-v1";
const HARD_MAX_ROUTES = 24;
const FLEET_DEFAULT_CAP = 8;
const DESCRIPTOR_BUDGET_BYTES = 4 * 1024;
const MANIFEST_RELATIVE = path.join(".opencode", "sdd-model-routing", "manifest.json");

interface RouteFixture {
  baseTemplate: string;
  providerId: string;
  modelId: string;
}

function makeRoute(index: number, suffix = ""): RouteFixture {
  return {
    baseTemplate: `sdd-mr-base${suffix}`,
    providerId: `prov-${index}`,
    modelId: `model-${index}`,
  };
}

function makeRoutesConfig(routes: RouteFixture[], options: {
  cap?: number;
  sizeException?: { reason: string; approvedBy?: string; approvedAt?: string };
} = {}): string {
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    generatorVersion: GENERATOR_VERSION,
    cap: options.cap,
    sizeException: options.sizeException,
    routes,
  };
  return JSON.stringify(payload, null, 2);
}

function writeRoutesConfig(workspaceRoot: string, json: string): string {
  const configDir = path.join(workspaceRoot, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });
  const filePath = path.join(configDir, "routes.json");
  writeFileSync(filePath, json, "utf8");
  return filePath;
}

function sha256Hex(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf8")) as T;
}

function cleanupDir(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      // transient EBUSY/EPERM on Windows; back off
      const busy = require("node:fs").constants ?? {};
    }
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
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

function generate(workspaceRoot: string, routesConfigPath: string): ReturnType<DiskAgentGenerator["generate"]> {
  const generator = new DiskAgentGenerator({ workspaceRoot, routesConfigPath });
  return generator.generate();
}

interface ManifestFile {
  relativePath: string;
  sha256: string;
  bytes: number;
}

interface Manifest {
  schemaVersion: number;
  generatorVersion: string;
  generationEpoch: string;
  workspaceIdentity: string;
  routingNamespace: string;
  descriptorBudgetBytes: number;
  requiredOpenCodeVersion: string;
  routes: Array<{
    baseTemplate: string;
    providerId: string;
    modelId: string;
    hostName: string;
    agentFile: ManifestFile;
    commandFile: ManifestFile;
  }>;
  fileHashes: string[];
  manifestHash: string;
}

async function run(): Promise<void> {
  console.log("--- disk agent generator ---");

  // 1. decodeRoutesConfig: rejects malformed JSON
  assert.throws(
    () => decodeRoutesConfig("not-json"),
    RoutesConfigInvalidError,
    "malformed routes.json is rejected with typed error",
  );

  // 2. decodeRoutesConfig: rejects unsupported schema version
  assert.throws(
    () =>
      decodeRoutesConfig(
        JSON.stringify({
          schemaVersion: 2,
          generatorVersion: GENERATOR_VERSION,
          routes: [makeRoute(1)],
        }),
      ),
    RoutesConfigInvalidError,
    "future schema versions are rejected",
  );

  // 3. Routes must be a non-empty array
  assert.throws(
    () => decodeRoutesConfig(makeRoutesConfig([])),
    RoutesConfigInvalidError,
    "empty routes rejected",
  );

  // 4. Default cap is 8 — nine routes without exception are rejected
  const nineRoutes = Array.from({ length: 9 }, (_, i) => makeRoute(i + 1));
  assert.throws(
    () => decodeRoutesConfig(makeRoutesConfig(nineRoutes)),
    RouteCapExceededError,
    "9 routes with default cap are rejected as cap exceeded",
  );

  // 5. Nine routes WITH committed sizeException.reason are accepted
  const acceptedWithException = decodeRoutesConfig(
    makeRoutesConfig(nineRoutes, {
      sizeException: { reason: "tiered fleet needs 9 entries", approvedBy: "operator" },
    }),
  );
  assert.equal(acceptedWithException.sizeException?.reason.length, "tiered fleet needs 9 entries".length);
  assert.match(acceptedWithException.sizeException?.reason ?? "", /\S+/, "sizeException.reason is non-empty");

  // 6. 17 routes WITH committed sizeException.reason are accepted (hard max is 24)
  const seventeenRoutes = Array.from({ length: 17 }, (_, i) => makeRoute(i + 1));
  const acceptedSeventeen = decodeRoutesConfig(
    makeRoutesConfig(seventeenRoutes, {
      sizeException: { reason: "tiered fleet needs 17 entries", approvedBy: "operator" },
    }),
  );
  assert.equal(acceptedSeventeen.routes.length, 17, "17 routes accepted under hard max with sizeException");

  // 6a. 24 routes (new hard max) WITH sizeException are accepted
  const twentyFourRoutes = Array.from({ length: 24 }, (_, i) => makeRoute(i + 1));
  const acceptedTwentyFour = decodeRoutesConfig(
    makeRoutesConfig(twentyFourRoutes, {
      sizeException: { reason: "tiered fleet needs 24 entries", approvedBy: "operator" },
    }),
  );
  assert.equal(acceptedTwentyFour.routes.length, 24, "24 routes accepted at new hard max with sizeException");

  // 6b. >24 routes are ALWAYS rejected even with sizeException
  const twentyFiveRoutes = Array.from({ length: 25 }, (_, i) => makeRoute(i + 1));
  assert.throws(
    () =>
      decodeRoutesConfig(
        makeRoutesConfig(twentyFiveRoutes, {
          sizeException: { reason: "should not help", approvedBy: "operator" },
        }),
      ),
    RouteCapExceededError,
    "25 routes are rejected even with sizeException",
  );

  // 7. Default cap is exactly 8 when no cap provided
  const eightRoutes = Array.from({ length: 8 }, (_, i) => makeRoute(i + 1));
  const eightDecoded = decodeRoutesConfig(makeRoutesConfig(eightRoutes));
  assert.equal(eightDecoded.cap, FLEET_DEFAULT_CAP, "default cap is 8");

  // 8. Duplicate (providerId, modelId) is rejected
  assert.throws(
    () =>
      decodeRoutesConfig(
        makeRoutesConfig([
          makeRoute(1),
          { baseTemplate: "sdd-mr-base", providerId: "prov-1", modelId: "model-1" },
        ]),
      ),
    RoutesConfigInvalidError,
    "duplicate canonical pair is rejected",
  );

  // 9. baseTemplate must be non-empty
  assert.throws(
    () =>
      decodeRoutesConfig(
        makeRoutesConfig([{ baseTemplate: "", providerId: "p", modelId: "m" }]),
      ),
    RoutesConfigInvalidError,
    "empty baseTemplate rejected",
  );

  // 10. encodeRoutesConfig round-trip preserves intent
  const sample = decodeRoutesConfig(
    makeRoutesConfig([makeRoute(1), makeRoute(2)]),
  );
  const reencoded = JSON.parse(encodeRoutesConfig(sample));
  assert.equal(reencoded.schemaVersion, SCHEMA_VERSION);
  assert.equal(reencoded.routes.length, 2);
  assert.equal(reencoded.routes[0].providerId, "prov-1");

  // Now exercise the generator end-to-end in an isolated workspace.
  const workspaceRoot = mkdtempSync(path.join(tmpdir(), "sdd-disk-gen-"));
  try {
    const routesPath = writeRoutesConfig(workspaceRoot, makeRoutesConfig([
      makeRoute(1),
      makeRoute(2, "-b"),
      makeRoute(3, "-c"),
    ]));
    const result = await generate(workspaceRoot, routesPath);

    // 11. Generator creates exactly the expected owned files
    assert.equal(result.generated.length, 3, "three routes generate three agents + commands + manifest");

    for (const routeResult of result.generated) {
      const agentPath = path.join(workspaceRoot, routeResult.agentRelative);
      const commandPath = path.join(workspaceRoot, routeResult.commandRelative);
      assert.ok(existsSync(agentPath), `agent descriptor written: ${routeResult.agentRelative}`);
      assert.ok(existsSync(commandPath), `command descriptor written: ${routeResult.commandRelative}`);
    }

    // 12. Manifest is written and well-formed
    const manifestPath = path.join(workspaceRoot, MANIFEST_RELATIVE);
    assert.ok(existsSync(manifestPath), "manifest.json written");
    const manifest = readJson<Manifest>(manifestPath);

    assert.equal(manifest.schemaVersion, SCHEMA_VERSION);
    assert.equal(manifest.generatorVersion, GENERATOR_VERSION);
    assert.equal(manifest.routingNamespace, ROUTING_NAMESPACE_VERSION);
    assert.equal(manifest.descriptorBudgetBytes, DESCRIPTOR_BUDGET_BYTES);
    assert.equal(manifest.requiredOpenCodeVersion, "1.18.9", "manifest binds to OpenCode 1.18.9");
    assert.equal(manifest.routes.length, 3);
    assert.ok(manifest.generationEpoch.length > 0, "generation epoch present");
    assert.ok(manifest.workspaceIdentity.length > 0, "workspace identity present");
    assert.equal(manifest.fileHashes.length, 6, "file hashes for 3 agents + 3 commands (manifest hash is separate)");
    const sortedHashes = [...manifest.fileHashes].sort();
    assert.deepEqual(manifest.fileHashes, sortedHashes, "file hashes are sorted");

    // 13. Manifest hash matches sha256 of canonical JSON without the hash field
    const manifestForHash = { ...manifest, manifestHash: undefined };
    const expectedManifestHash = sha256Hex(JSON.stringify(manifestForHash));
    assert.equal(manifest.manifestHash, expectedManifestHash, "manifest hash matches sha256 of body");

    // 13b. A pre-1.18.9 manifest (requiredOpenCodeVersion=1.18.4) is rejected
    // by the readiness contract: its requiredOpenCodeVersion cannot equal
    // the runtime contract, so it must be regenerated before attestation.
    const staleManifest: Manifest = {
      ...manifest,
      requiredOpenCodeVersion: "1.18.4",
      generatorVersion: "1.0.0",
    };
    const staleBody = { ...staleManifest, manifestHash: undefined };
    const staleForHash = sha256Hex(JSON.stringify(staleBody));
    assert.notEqual(staleForHash, manifest.manifestHash, "1.18.4 manifest produces a distinct digest from 1.18.9");

    // 14. Each route's host name matches the deterministic hashHostName contract
    const { hashHostName } = await import("../src/domain/model-routing/model-route-host-naming.js");
    for (const route of manifest.routes) {
      const expected = hashHostName(route.baseTemplate, {
        providerId: route.providerId,
        modelId: route.modelId,
      });
      assert.equal(route.hostName, expected, `host name deterministic for ${route.providerId}/${route.modelId}`);
      assert.match(route.hostName, /^sdd-mr-v1-[a-f0-9]{16}$/);
    }

    // 15. Each agent descriptor is exactly the supported frontmatter + has model pinned
    for (const route of manifest.routes) {
      const agentBody = readFileSync(path.join(workspaceRoot, route.agentFile.relativePath), "utf8");
      const bytes = Buffer.byteLength(agentBody, "utf8");
      assert.ok(bytes <= DESCRIPTOR_BUDGET_BYTES, `agent descriptor within 4 KiB (${bytes})`);
      assert.match(agentBody, /^---/, "agent descriptor starts with frontmatter delimiter");
      assert.match(agentBody, /mode:\s*subagent/, "agent mode is subagent");
      assert.match(agentBody, /hidden:\s*true/, "agent hidden: true (subagent-only field)");
      assert.match(agentBody, new RegExp(`model:\\s*${route.providerId}/${route.modelId}\\b`), "agent model pinned");
      assert.match(agentBody, /permission:/, "agent permission block present");
      assert.match(agentBody, /task:/, "agent permission.task rule present");
      assert.match(agentBody, /["']?\*["']?:\s*deny/, "agent task wildcard deny present");
      assert.doesNotMatch(agentBody, /args\.model|args:.*model/, "agent descriptor must not reference args.model");
      // sha256 in manifest matches actual bytes
      assert.equal(route.agentFile.sha256, sha256Hex(agentBody), "agent file hash matches manifest");
      assert.equal(route.agentFile.bytes, bytes, "agent byte count recorded");

      const commandBody = readFileSync(path.join(workspaceRoot, route.commandFile.relativePath), "utf8");
      const commandBytes = Buffer.byteLength(commandBody, "utf8");
      assert.ok(commandBytes <= DESCRIPTOR_BUDGET_BYTES, `command descriptor within 4 KiB (${commandBytes})`);
      assert.match(commandBody, /^---/, "command descriptor starts with frontmatter delimiter");
      assert.match(commandBody, new RegExp(`agent:\\s*${route.hostName}\\b`), "command binds to routed agent");
      assert.match(commandBody, /subtask:\s*true/, "command uses subtask: true");
      assert.match(commandBody, /\$ARGUMENTS/, "command body uses $ARGUMENTS");
      assert.equal(route.commandFile.sha256, sha256Hex(commandBody), "command file hash matches manifest");
      assert.equal(route.commandFile.bytes, commandBytes, "command byte count recorded");
    }

    // 16. Re-running with the same config is idempotent (same epoch is preserved by default)
    const firstEpoch = manifest.generationEpoch;
    const second = await generate(workspaceRoot, routesPath);
    assert.equal(second.manifest.generationEpoch, firstEpoch, "epoch stable across idempotent runs");
    assert.deepEqual(second.manifest.fileHashes, manifest.fileHashes, "file hashes stable across idempotent runs");

    // 17. Modified owned file blocks cleanup: modify a route's files
    // THEN remove that route from config; the generator must refuse to
    // delete the modified owned file.
    const victimRoute = manifest.routes[1]!;
    const victimCommand = path.join(workspaceRoot, victimRoute.commandFile.relativePath);
    const victimAgent = path.join(workspaceRoot, victimRoute.agentFile.relativePath);
    const origAgentContent = readFileSync(victimAgent, "utf8");
    const origCommandContent = readFileSync(victimCommand, "utf8");
    writeFileSync(victimCommand, "USER EDIT -- outside generator\n", "utf8");
    writeFileSync(victimAgent, "USER EDIT -- outside generator\n", "utf8");
    const reducedRoutesPath = writeRoutesConfig(workspaceRoot, makeRoutesConfig([makeRoute(1)]));
    const blocked = await generate(workspaceRoot, reducedRoutesPath).catch((err: unknown) => err);
    assert.ok(blocked instanceof Error, "modified owned file aborts cleanup with typed error");
    assert.equal(
      (blocked as Error).name,
      "ModifiedOwnedFileError",
      "precise error class for modified-owned-file",
    );
    assert.match(
      (blocked as Error).message,
      /modified outside the generator/i,
      "error message explains the modified-owned-file condition",
    );
    // The modified files must still exist on disk after the abort
    assert.ok(existsSync(victimAgent), "modified agent left in place after abort");
    assert.ok(existsSync(victimCommand), "modified command left in place after abort");

    // Restore exact original content
    writeFileSync(victimAgent, origAgentContent, "utf8");
    writeFileSync(victimCommand, origCommandContent, "utf8");

    // 18. Stale cleanup: with the modified files restored, removal now works
    const reduced = await generate(workspaceRoot, reducedRoutesPath);
    assert.equal(reduced.generated.length, 1, "reduced fleet emits one route");
    for (const stale of manifest.routes.slice(1)) {
      const staleAgent = path.join(workspaceRoot, stale.agentFile.relativePath);
      const staleCommand = path.join(workspaceRoot, stale.commandFile.relativePath);
      assert.equal(existsSync(staleAgent), false, `stale agent deleted: ${stale.agentFile.relativePath}`);
      assert.equal(existsSync(staleCommand), false, `stale command deleted: ${stale.commandFile.relativePath}`);
    }
    const keptAgent = path.join(workspaceRoot, manifest.routes[0]!.agentFile.relativePath);
    assert.ok(existsSync(keptAgent), "kept route still present");

    // 19. Path traversal in workspace root is rejected
    const traversalWorkspace = path.join(workspaceRoot, "..", "traversal-attempt");
    mkdirSync(traversalWorkspace, { recursive: true });
    const traversalRoutesPath = writeRoutesConfig(traversalWorkspace, makeRoutesConfig([makeRoute(1)]));
    const traversalError = await generate(workspaceRoot, traversalRoutesPath).catch((err: unknown) => err);
    assert.ok(
      traversalError instanceof PathTraversalDetectedError ||
        traversalError instanceof RoutesConfigInvalidError,
      "path traversal / absolute workspace rejected",
    );

    // 20. Disk safety error class names are stable and meaningful
    const err = new PathTraversalDetectedError("test", "reason");
    assert.equal(err.name, "PathTraversalDetectedError");
    assert.equal(err.code, "PATH_TRAVERSAL_DETECTED");
    const safetyErr = new DiskSafetyError("test", "non-regular file in path component");
    assert.equal(safetyErr.name, "DiskSafetyError");
    assert.equal(safetyErr.code, "DISK_SAFETY_VIOLATION");
    const manifestErr = new ManifestInvalidError("test");
    assert.equal(manifestErr.name, "ManifestInvalidError");
    assert.equal(manifestErr.code, "MANIFEST_INVALID");

    // 21. Generator never leaves a stale lock file after a successful run
    const lockPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "generator.lock");
    assert.equal(existsSync(lockPath), false, "lock file released after successful run");

    // 22. Workspace contains ONLY owned-namespace files (no leaked artifacts)
    const ownedAgents = readdirSafe(path.join(workspaceRoot, ".opencode", "agents"));
    for (const entry of ownedAgents) {
      assert.ok(
        entry.startsWith("sdd-mr-v1-") && entry.endsWith(".md"),
        `only owned agent files present (got ${entry})`,
      );
    }
    const ownedCommands = readdirSafe(path.join(workspaceRoot, ".opencode", "commands"));
    for (const entry of ownedCommands) {
      assert.ok(
        entry.startsWith("sdd-mr-canary-v1-") && entry.endsWith(".md"),
        `only owned command files present (got ${entry})`,
      );
    }

    // 23. All-owned tamper verification occurs before any sweep/deletion, even for files being regenerated or deleted
    const tamperWS = mkdtempSync(path.join(tmpdir(), "sdd-mr-tamper-"));
    try {
      const routesConfigPath = writeRoutesConfig(tamperWS, makeRoutesConfig([makeRoute(1), makeRoute(2)]));
      const gen1 = new DiskAgentGenerator({ workspaceRoot: tamperWS, routesConfigPath });
      const res1 = await gen1.generate();
      assert.equal(res1.generated.length, 2);

      // Modify one of the owned files (e.g. agent 1)
      const agent1Path = path.join(tamperWS, res1.generated[0]!.agentRelative);
      writeFileSync(agent1Path, "# TAMPERED CONTENT", "utf8");

      // Re-run generation with the SAME routes (so the file path WOULD be regenerated)
      const gen2 = new DiskAgentGenerator({ workspaceRoot: tamperWS, routesConfigPath });
      await assert.rejects(
        async () => gen2.generate(),
        (err: Error) => err.name === "ModifiedOwnedFileError",
        "tampered owned file causes ModifiedOwnedFileError even when path will be regenerated",
      );

      // Delete one of the owned files (e.g. agent 2) and verify missing owned file failure
      const agent2Path = path.join(tamperWS, res1.generated[1]!.agentRelative);
      rmSync(agent2Path);
      const gen3 = new DiskAgentGenerator({ workspaceRoot: tamperWS, routesConfigPath });
      await assert.rejects(
        async () => gen3.generate(),
        (err: Error) => err.name === "ModifiedOwnedFileError",
        "deleted owned file causes ModifiedOwnedFileError pre-sweep",
      );
    } finally {
      await cleanupDirAsync(tamperWS);
    }

    // 24. In-memory config with empty routes creates empty manifest, while file path branch rejects empty routes array
    const emptyWS = mkdtempSync(path.join(tmpdir(), "sdd-mr-empty-"));
    try {
      const emptyConfig = {
        schemaVersion: 1 as const,
        generatorVersion: "1.1.0",
        cap: 8,
        sizeException: null,
        routes: [],
      };
      const inMemoryGen = new DiskAgentGenerator({ workspaceRoot: emptyWS, routesConfig: emptyConfig });
      const emptyRes = await inMemoryGen.generate();
      assert.equal(emptyRes.generated.length, 0);
      assert.equal(emptyRes.manifest.routes.length, 0);
      assert.equal(emptyRes.manifest.schemaVersion, 1);

      // File path branch still rejects empty routes array in routes.json
      const emptyFileConfigPath = writeRoutesConfig(emptyWS, makeRoutesConfig([]));
      const fileGen = new DiskAgentGenerator({ workspaceRoot: emptyWS, routesConfigPath: emptyFileConfigPath });
      await assert.rejects(
        async () => fileGen.generate(),
        (err: Error) => err.name === "RoutesConfigInvalidError",
        "routesConfigPath branch rejects empty routes array",
      );
    } finally {
      await cleanupDirAsync(emptyWS);
    }

    console.log("All disk agent generator assertions passed.");
  } finally {
    await cleanupDirAsync(workspaceRoot);
  }
}

function readdirSafe(dir: string): string[] {
  try {
    return require("node:fs").readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});