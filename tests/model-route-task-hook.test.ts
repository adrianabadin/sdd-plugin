/**
 * Unit 5 (RED) — `tool.execute.before` task hook interception tests.
 *
 * Required behavior:
 *  - ONLY `subagent_type` parsed against the declared `model-route:v1|base|reference`
 *    grammar is treated as a routing request.
 *  - `args.model` is NEVER read, NEVER written, NEVER relied on for routing.
 *  - Non-prefixed legacy `subagent_type` (e.g. `task-1`, `general-purpose`)
 *    is passed through byte-for-byte unchanged. The existing hydration +
 *    quarantine gate remains intact for those calls.
 *  - Routing pipeline (in order):
 *      1. parse  → ParsedModelRouteV1
 *      2. resolve → CanonicalModelId (throws on 0/>1)
 *      3. quarantine reconciliation → isActive → throw
 *      4. readiness attestation (manifest/file/lock/journal/version/workspace)
 *      5. synchronous audit append
 *      6. rewrite `subagent_type` to the owned fixed host
 *      7. exit the hook (engine invokes TaskTool with the rewritten args)
 *  - Any failure throws before child creation. No substitution, no retry,
 *    no fallback, no silent fallback to `args.model`.
 *  - The hook MUST NOT mutate the disk (`prepareWorkspace`, generator,
 *    manifest). All disk writes belong to the pre-start generator.
 */

import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";

import { ModelRouteTaskHook } from "../src/infrastructure/opencode/model-route-task-hook.js";
import {
  TaskHookBootIdentityMissingError,
  TaskHookSigningKeyMissingError,
} from "../src/infrastructure/opencode/model-route-task-hook.js";
import {
  parseModelRouteGrammar,
} from "../src/domain/model-routing/model-route-grammar.js";
import { ModelRouteResolver } from "../src/domain/model-routing/model-route-resolver.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";
import { REQUIRED_OPENCODE_VERSION } from "../src/infrastructure/opencode/model-route-readiness.js";

async function sleep(ms: number): Promise<void> { await new Promise<void>((r) => setTimeout(r, ms)); }
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

function writeStrict(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
  chmod(target, 0o600);
}

function chmod(target: string, mode: number): void {
  try {
    const fs = require("node:fs") as { chmodSync: (p: string, m: number) => void };
    fs.chmodSync(target, mode);
  } catch {
    // Windows: chmod is best-effort.
  }
}

function seedManifestWithOwnedFiles(root: string, providerId: string, modelId: string): {
  hostName: string;
  attestationPath: string;
} {
  const hostName = hashHostName("sdd-mr-base", { providerId, modelId });
  const suffix = hostName.slice("sdd-mr-v1-".length);
  const agentRelative = path.join(".opencode", "agents", `sdd-mr-v1-${suffix}.md`);
  const commandRelative = path.join(".opencode", "commands", `sdd-mr-canary-v1-${suffix}.md`);
  const agentBody = `agent-${hostName}`;
  const commandBody = `command-${hostName}`;
  writeStrict(path.join(root, agentRelative), agentBody);
  writeStrict(path.join(root, commandRelative), commandBody);
  mkdirSync(path.join(root, ".opencode", "sdd-model-routing"), { recursive: true });
  const body = {
    schemaVersion: 1,
    generatorVersion: "1.1.0",
    generationEpoch: "epoch-hook",
    workspaceIdentity: path.resolve(root),
    routingNamespace: "sdd-mr-v1",
    descriptorBudgetBytes: 4096,
    requiredOpenCodeVersion: REQUIRED_OPENCODE_VERSION,
    routes: [{
      baseTemplate: "sdd-mr-base",
      providerId, modelId, hostName,
      agentFile: { relativePath: agentRelative, sha256: sha256(agentBody), bytes: Buffer.byteLength(agentBody, "utf8") },
      commandFile: { relativePath: commandRelative, sha256: sha256(commandBody), bytes: Buffer.byteLength(commandBody, "utf8") },
    }],
    fileHashes: [sha256(agentBody), sha256(commandBody)],
  };
  const manifest = { ...body, manifestHash: sha256(JSON.stringify(body)) };
  writeFileSync(path.join(root, ".opencode", "sdd-model-routing", "manifest.json"), JSON.stringify(manifest, null, 2));
  const attestationPath = path.join(root, ".opencode", "sdd-model-routing", "attestation.json");
  const attestationBody = {
    schemaVersion: 1,
    verifierVersion: "1.0.0",
    openCodeVersion: REQUIRED_OPENCODE_VERSION,
    workspaceIdentity: path.resolve(root),
    generationEpoch: "epoch-hook",
    manifestHash: manifest.manifestHash,
    fileHashes: [...manifest.fileHashes].sort(),
    bootIdentity: "boot-1",
    nonce: "nonce-1",
    issuedAt: Date.now() - 1000,
    expiresAt: Date.now() + 600_000,
    canaries: [],
  };
  const signature = createHmac("sha256", "explicit-shared-key").update(JSON.stringify(attestationBody)).digest("hex");
  writeFileSync(attestationPath, JSON.stringify({ ...attestationBody, signature }, null, 2));
  return { hostName, attestationPath };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function emptyResolverPort(): import("../src/ports/model-route-catalog.port.js").ModelRouteCatalogPort {
  return {
    async existsCanonical() { return false; },
    async searchNormalized() { return []; },
  };
}

function stubResolverPort(providerId: string, modelId: string): import("../src/ports/model-route-catalog.port.js").ModelRouteCatalogPort {
  return {
    async existsCanonical(p: string, m: string) {
      return (p === providerId && m === modelId) || (p === "openai" && m === "gpt-4o");
    },
    async searchNormalized(_term: string, _limit: number) {
      return [
        { providerId, modelId, modelName: modelId },
        { providerId: "openai", modelId: "gpt-4o", modelName: "GPT-4o" },
      ];
    },
  };
}

function makeHook(opts: {
  workspaceRoot: string;
  resolver: ModelRouteResolver;
  quarantineStore: QuarantineStoreImpl;
  auditPath: string;
}): ModelRouteTaskHook {
  return new ModelRouteTaskHook({
    workspaceRoot: opts.workspaceRoot,
    manifestPath: path.join(opts.workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json"),
    bootIdentity: "boot-1",
    signingKey: "explicit-shared-key",
    resolver: opts.resolver,
    quarantineStore: opts.quarantineStore,
    audit: { path: opts.auditPath },
  });
}

async function run(): Promise<void> {
  console.log("--- model-route task hook (RED) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
  try {
    const workspaceRoot = path.join(tmp, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const { hostName, attestationPath } = seedManifestWithOwnedFiles(workspaceRoot, "google", "antigravity-gemini-3.6-flash-tiered");

    const auditPath = path.join(tmp, "audit.jsonl");
    const validAttestation = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
    const hook = makeHook({
      workspaceRoot,
      resolver: new ModelRouteResolver(stubResolverPort("google", "antigravity-gemini-3.6-flash-tiered"), new Map()),
      quarantineStore: new QuarantineStoreImpl(),
      auditPath,
    });

    // 1. Routing pipeline rewrite happy path.
    const output = {
      args: {
        subagent_type: "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered",
        // Legacy field carried intentionally; the hook must NOT alter
        // it and must NOT consult it for routing.
        model: "should-not-be-used/foo",
      },
    };
    await hook.execute({ tool: "task" }, output);
    assert.equal(output.args.subagent_type, hostName, "subagent_type rewritten to owned fixed host");
    assert.equal(output.args.model, "should-not-be-used/foo", "args.model is NEVER read or relied on for routing; preserved unchanged");
    assert.ok(parseModelRouteGrammar(output.args.subagent_type) === null, "rewritten subagent_type is no longer a routing grammar");
    console.log("  pass: routing pipeline rewrites subagent_type to owned fixed host");

    const auditLines = readFileSync(auditPath, "utf8").trim().split("\n");
    const entry = JSON.parse(auditLines[auditLines.length - 1]!) as Record<string, unknown>;
    assert.equal(entry["stage"], "routing.launch");
    assert.equal(entry["status"], "success");
    assert.equal(entry["routedAgent"], hostName);
    assert.equal(entry["resolvedProviderId"], "google");
    assert.equal(entry["resolvedModelId"], "antigravity-gemini-3.6-flash-tiered");
    assert.equal(entry["quarantineChecked"], true);
    console.log("  pass: synchronous audit emitted for routing.launch");

    // 2. Non-prefixed legacy call is BYTE-FOR-BYTE unchanged.
    const legacyOutput = { args: { subagent_type: "general-purpose", prompt: "do something", model: "openai/gpt-4o" } };
    const snapshot = JSON.parse(JSON.stringify(legacyOutput)) as typeof legacyOutput;
    await hook.execute({ tool: "task" }, legacyOutput);
    assert.deepEqual(legacyOutput, snapshot, "legacy non-prefixed call is byte-for-byte unchanged");
    console.log("  pass: non-prefixed legacy call is byte-for-byte unchanged");

    // 3. Malformed routing grammar throws; no disk mutation.
    const malformedOutput = { args: { subagent_type: "model-route:v2|base|ref" } };
    await assert.rejects(
      async () => hook.execute({ tool: "task" }, malformedOutput),
      /version|UNSUPPORTED_VERSION/i,
      "unsupported version is rejected before resolution",
    );
    const auditAfter = readFileSync(auditPath, "utf8").trim().split("\n");
    const errorEntries = auditAfter.map((line) => JSON.parse(line) as Record<string, unknown>).filter((e) => e["status"] === "error");
    assert.equal(errorEntries.length, 1, "routing.blocked audit emitted for malformed grammar");
    assert.equal(errorEntries[0]?.["errorClass"], "ModelRouteGrammarError");
    console.log("  pass: malformed reserved grammar throws and emits routing.blocked audit");

    // 4. Quarantine reconciliation blocks before rewrite.
    const quarantineStore = new QuarantineStoreImpl();
    quarantineStore.publish({
      level: "modelProvider",
      providerId: "google",
      modelId: "antigravity-gemini-3.6-flash-tiered",
      type: "permanent",
      until: null,
      reason: "test-block",
    });
    const hookQuarantined = makeHook({
      workspaceRoot,
      resolver: new ModelRouteResolver(stubResolverPort("google", "antigravity-gemini-3.6-flash-tiered"), new Map()),
      quarantineStore,
      auditPath: path.join(tmp, "audit-q.jsonl"),
    });
    const quarantinedOutput = { args: { subagent_type: "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered" } };
    await assert.rejects(
      async () => hookQuarantined.execute({ tool: "task" }, quarantinedOutput),
      /quarantined|ACTIVE_QUARANTINE/i,
      "active quarantine blocks before rewrite",
    );
    assert.equal(
      quarantinedOutput.args.subagent_type,
"model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered",
      "subagent_type is NOT rewritten when quarantine blocks",
    );
    console.log("  pass: active quarantine blocks before rewrite and leaves subagent_type unchanged");

    // 5. Missing/expired attestation blocks.
    rmSync(attestationPath, { force: true });
    const freshOutput = { args: { subagent_type: "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered" } };
    await assert.rejects(
      async () => hook.execute({ tool: "task" }, freshOutput),
      /ATTESTATION_(UNAVAILABLE|MISMATCH|EXPIRED)/,
      "missing attestation blocks before rewrite",
    );
    assert.equal(freshOutput.args.subagent_type, "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered", "no rewrite when attestation missing");

    writeFileSync(attestationPath, JSON.stringify({ ...validAttestation, expiresAt: Date.now() - 1 }, null, 2));
    const expiredOutput = { args: { subagent_type: "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered" } };
    await assert.rejects(
      async () => hook.execute({ tool: "task" }, expiredOutput),
      /ATTESTATION_EXPIRED/,
      "expired attestation blocks before rewrite",
    );
    console.log("  pass: missing/expired attestation blocks before rewrite");

    // 6. Hook MUST NOT mutate the disk.
    writeFileSync(attestationPath, JSON.stringify(validAttestation, null, 2));
    const beforeDirs = existingSubdirs(workspaceRoot);
    const beforeLock = existsSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "generator.lock"));
    const runningOutput = { args: { subagent_type: "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered" } };
    await hook.execute({ tool: "task" }, runningOutput);
    const afterDirs = existingSubdirs(workspaceRoot);
    assert.deepEqual(afterDirs.sort(), beforeDirs.sort(), "hook does not create new directories");
    assert.equal(beforeLock, existsSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "generator.lock")), "hook does not write generator.lock");
    console.log("  pass: hook never mutates the disk (no runtime generation)");

    // 7. Zero-rank resolution throws (no silent fallback to args.model).
    const emptyResolver = new ModelRouteResolver(emptyResolverPort(), new Map());
    const emptyHook = makeHook({
      workspaceRoot,
      resolver: emptyResolver,
      quarantineStore: new QuarantineStoreImpl(),
      auditPath: path.join(tmp, "audit-empty.jsonl"),
    });
    const emptyOutput = {
      args: {
        subagent_type: "model-route:v1|sdd-mr-base|nonexistent/model",
        model: "fallback/different",
      },
    };
    await assert.rejects(
      async () => emptyHook.execute({ tool: "task" }, emptyOutput),
      /RouteUnknownError|0 candidates/i,
      "zero-match resolution throws (no fallback to args.model)",
    );
    assert.equal(emptyOutput.args.subagent_type, "model-route:v1|sdd-mr-base|nonexistent/model", "zero-match does not rewrite subagent_type");
    assert.equal(emptyOutput.args.model, "fallback/different", "args.model is preserved verbatim even on routing failure");
    console.log("  pass: zero-match resolution throws (no silent fallback to args.model)");

    // 8. Off-fleet canonical rejected (no implicit fleet expansion).
    const offFleetOutput = { args: { subagent_type: "model-route:v1|sdd-mr-base|openai/gpt-4o" } };
    await assert.rejects(
      async () => hook.execute({ tool: "task" }, offFleetOutput),
      /RoutedAgentUnavailableError|not in.*manifest|not in fleet|off[- ]?fleet/i,
      "off-fleet canonical rejected",
    );
    console.log("  pass: off-fleet canonical is rejected (no implicit fleet expansion)");

    // 9. Unit 6: explicit boot identity and HMAC signing key are required.
    // "boot-default", callID-derived boot, and "deterministic-key" / random
    // signing keys are all rejected so the runtime cannot certify itself.
    const baseResolver = new ModelRouteResolver(stubResolverPort("google", "antigravity-gemini-3.6-flash-tiered"), new Map());
    const baseQuarantineStore = new QuarantineStoreImpl();
    assert.throws(
      () => new ModelRouteTaskHook({
        workspaceRoot,
        bootIdentity: "boot-default",
        signingKey: "explicit-shared-key",
        resolver: baseResolver,
        quarantineStore: baseQuarantineStore,
        audit: { path: auditPath },
      }),
      TaskHookBootIdentityMissingError,
      "boot-default is rejected as a missing/insecure boot identity",
    );
    assert.throws(
      () => new ModelRouteTaskHook({
        workspaceRoot,
        signingKey: "explicit-shared-key",
        resolver: baseResolver,
        quarantineStore: baseQuarantineStore,
        audit: { path: auditPath },
        // bootIdentity intentionally omitted to assert required field
      } as unknown as import("../src/infrastructure/opencode/model-route-task-hook.js").ModelRouteTaskHookOptions),
      TaskHookBootIdentityMissingError,
      "missing bootIdentity is rejected",
    );
    assert.throws(
      () => new ModelRouteTaskHook({
        workspaceRoot,
        bootIdentity: "boot-1",
        resolver: baseResolver,
        quarantineStore: baseQuarantineStore,
        audit: { path: auditPath },
        // signingKey intentionally omitted to assert required field
      } as unknown as import("../src/infrastructure/opencode/model-route-task-hook.js").ModelRouteTaskHookOptions),
      TaskHookSigningKeyMissingError,
      "missing signingKey is rejected",
    );
    assert.throws(
      () => new ModelRouteTaskHook({
        workspaceRoot,
        bootIdentity: "boot-1",
        signingKey: "deterministic-key",
        resolver: baseResolver,
        quarantineStore: baseQuarantineStore,
        audit: { path: auditPath },
      }),
      TaskHookSigningKeyMissingError,
      "the legacy 'deterministic-key' literal is rejected",
    );
    assert.throws(
      () => new ModelRouteTaskHook({
        workspaceRoot,
        bootIdentity: "",
        signingKey: "explicit-shared-key",
        resolver: baseResolver,
        quarantineStore: baseQuarantineStore,
        audit: { path: auditPath },
      }),
      TaskHookBootIdentityMissingError,
      "empty bootIdentity is rejected",
    );
    console.log("  pass: explicit boot identity and HMAC signing key are required (no default/random/callID fallbacks)");

    console.log("All task hook assertions passed.");
  } finally {
    await cleanupDir(tmp);
  }
}

function existingSubdirs(root: string): string[] {
  try {
    return readdirSync(root);
  } catch {
    return [];
  }
}

run().catch((err: unknown) => { console.error(err); process.exit(1); });
