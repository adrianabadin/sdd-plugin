/**
 * WU2 (RED-first) — `ModelRouteTaskHook` natural-intent routing path.
 *
 * Behavior contract for the NEW path (subagent_type WITHOUT explicit
 * `model-route:v1|...` grammar, but prompt WITH a WU1 trigger):
 *
 *   1. The prompt is data; the canonical identity is what controls every
 *      gate. `output.args.prompt` is never mutated, never read into the
 *      routing decision, and is preserved byte-for-byte.
 *   2. The existing explicit-grammar path is unchanged: `model-route:v1|...`
 *      continues to route via the existing pipeline.
 *   3. The hook never reads, writes, or relies on `output.args.model` in
 *      the natural path. `args.model` is preserved byte-for-byte.
 *   4. The exact gate order is preserved: parse (prompt) -> resolve (with
 *      NATURAL_MODEL_ALIASES) -> quarantine -> readiness -> audit ->
 *      rewrite (only on success).
 *   5. Failures throw fail-closed errors BEFORE child creation with both
 *      Spanish and English actionable messages; for ambiguous candidates,
 *      the candidates are listed.
 *   6. The hook never mutates the disk (no generator, no manifest, no
 *      agent/command files, no lock, no journal).
 *   7. No trigger -> byte-for-byte legacy passthrough (no rewrites).
 *
 * Reference design: 41aa141d-1bbf-4cd0-aba7-63f82f83fbd6.
 */

import assert from "node:assert/strict";
import {
  closeSync,
  existsSync,
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
import { ModelRouteResolver, type ModelRouteAliasTable } from "../src/domain/model-routing/model-route-resolver.js";
import { NATURAL_MODEL_ALIASES } from "../src/domain/model-routing/natural-model-aliases.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";
import { parseModelRouteGrammar } from "../src/domain/model-routing/model-route-grammar.js";
import type { ModelRouteCatalogPort, RouteCandidate } from "../src/ports/model-route-catalog.port.js";

async function sleep(ms: number): Promise<void> { await new Promise<void>((r) => setTimeout(r, ms)); }
async function cleanupDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try { rmSync(dir, { recursive: true, force: true }); return; } catch { await sleep(50 * (attempt + 1)); }
  }
}

function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }

function writeStrict(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
  try {
    const fs = require("node:fs") as { chmodSync: (p: string, m: number) => void };
    fs.chmodSync(target, 0o600);
  } catch { /* Windows: chmod is best-effort. */ }
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
    generationEpoch: "epoch-natural",
    workspaceIdentity: path.resolve(root),
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
  const manifest = { ...body, manifestHash: sha256(JSON.stringify(body)) };
  writeFileSync(path.join(root, ".opencode", "sdd-model-routing", "manifest.json"), JSON.stringify(manifest, null, 2));
  const attestationPath = path.join(root, ".opencode", "sdd-model-routing", "attestation.json");
  const attestationBody = {
    schemaVersion: 1,
    verifierVersion: "1.0.0",
    openCodeVersion: "1.18.9",
    workspaceIdentity: path.resolve(root),
    generationEpoch: "epoch-natural",
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

function stubCatalog(known: ReadonlyArray<{ providerId: string; modelId: string; modelName?: string }>): ModelRouteCatalogPort {
  const set = new Set(known.map((c) => `${c.providerId}/${c.modelId}`));
  return {
    async existsCanonical(p, m) { return set.has(`${p}/${m}`); },
    async searchNormalized(_term, _limit) { return []; },
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

function existingSubdirs(root: string): string[] {
  try { return readdirSync(root); } catch { return []; }
}

async function run(): Promise<void> {
  console.log("--- natural-model-routing task hook (RED) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-natural-"));
  try {
    const workspaceRoot = path.join(tmp, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });
    const { hostName, attestationPath } = seedManifestWithOwnedFiles(
      workspaceRoot, "google", "antigravity-gemini-3.6-flash-tiered",
    );
    const auditPath = path.join(tmp, "audit-natural.jsonl");

    // Resolver with the verified WU1 alias table wired in.
    const resolver = new ModelRouteResolver(
      stubCatalog([{ providerId: "google", modelId: "antigravity-gemini-3.6-flash-tiered", modelName: "Gemini 3.6 Flash Tiered" }]),
      NATURAL_MODEL_ALIASES satisfies ModelRouteAliasTable,
    );
    const hook = makeHook({
      workspaceRoot,
      resolver,
      quarantineStore: new QuarantineStoreImpl(),
      auditPath,
    });

    // ---------- 1. Natural happy path: Spanish trigger + alias ----------
    {
      const prompt = "Generá un saludo usando Gemini Flash 3.6 Tiered";
      const output = {
        args: {
          subagent_type: "general-purpose",
          prompt,
          model: "should-not-be-used/foo",
        },
      };
      await hook.execute({ tool: "task" }, output);

      assert.equal(output.args.subagent_type, hostName, "natural happy: subagent_type rewritten to owned fixed host");
      assert.equal(output.args.prompt, prompt, "natural happy: prompt is preserved byte-for-byte (no mutation)");
      assert.equal(output.args.model, "should-not-be-used/foo", "natural happy: args.model is NEVER read or relied on for routing");
      assert.ok(parseModelRouteGrammar(output.args.subagent_type) === null, "natural happy: rewritten subagent_type is no longer a routing grammar");
      console.log("  pass: natural happy path rewrites subagent_type, preserves prompt byte-for-byte, never touches args.model");

      // Audit row should be a routing.natural.launch entry.
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      assert.equal(last["stage"], "routing.natural.launch", "natural happy: audit stage is routing.natural.launch");
      assert.equal(last["status"], "success", "natural happy: audit status is success");
      assert.equal(last["routedAgent"], hostName, "natural happy: audit routedAgent matches hostName");
      assert.equal(last["resolvedProviderId"], "google", "natural happy: audit resolvedProviderId is google");
      assert.equal(last["resolvedModelId"], "antigravity-gemini-3.6-flash-tiered", "natural happy: audit resolvedModelId");
      assert.equal(last["quarantineChecked"], true, "natural happy: audit quarantineChecked is true");
      assert.equal(last["trigger"], "usando", "natural happy: audit trigger label");
      assert.equal(last["requestedNaturalReference"], "Gemini Flash 3.6 Tiered", "natural happy: audit requestedNaturalReference");
      console.log("  pass: natural happy path emits routing.natural.launch audit with trigger + reference");
    }

    // ---------- 2. Diacritic-folded Spanish trigger (`cón el modelo`) ----------
    {
      // "cón" folds to "con" via NFKC + Spanish diacritic fold; the
      // trigger must match and the raw reference must come from the
      // raw prompt bytes (preserving capitalization). The WU1 alias
      // table is case-insensitive (Tier 2 lowercases the reference
      // before lookup), so the route succeeds and the subagent_type
      // is rewritten. The prompt itself must remain byte-for-byte
      // identical.
      const prompt = "Ejecutá cón el modelo Gemini Flash 3.6 Tiered";
      const output = { args: { subagent_type: "general-purpose", prompt } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, hostName, "diacritic fold: subagent_type rewritten via WU1 alias");
      assert.equal(output.args.prompt, prompt, "diacritic fold: prompt preserved byte-for-byte");
      console.log("  pass: diacritic-folded Spanish trigger matches; prompt preserved byte-for-byte");
    }

    // ---------- 3. Legacy passthrough: no trigger, no rewrite ----------
    {
      const prompt = "Just summarize this article";
      const output = { args: { subagent_type: "general-purpose", prompt, model: "openai/gpt-4o" } };
      const snapshot = JSON.parse(JSON.stringify(output)) as typeof output;
      await hook.execute({ tool: "task" }, output);
      assert.deepEqual(output, snapshot, "legacy passthrough: byte-for-byte unchanged when no trigger");
      assert.equal(output.args.subagent_type, "general-purpose", "legacy passthrough: subagent_type NOT rewritten");
      assert.equal(output.args.prompt, prompt, "legacy passthrough: prompt preserved");
      assert.equal(output.args.model, "openai/gpt-4o", "legacy passthrough: args.model preserved");
      console.log("  pass: legacy no-intent call is byte-for-byte unchanged");
    }

    // ---------- 4. Explicit route grammar compatibility (existing path) ----------
    {
      const explicitOutput = {
        args: {
          subagent_type: "model-route:v1|sdd-mr-base|google/antigravity-gemini-3.6-flash-tiered",
          prompt: "Run a task using model gpt-4o", // <-- prompt has a trigger, but grammar wins
        },
      };
      await hook.execute({ tool: "task" }, explicitOutput);
      assert.equal(explicitOutput.args.subagent_type, hostName, "explicit grammar: subagent_type rewritten by the existing pipeline");
      assert.equal(explicitOutput.args.prompt, "Run a task using model gpt-4o", "explicit grammar: prompt preserved byte-for-byte even if it has a trigger");
      console.log("  pass: explicit route grammar still works and wins over the natural path");
    }

    // ---------- 5. Malformed: empty reference -> fail-closed error ----------
    {
      const output = { args: { subagent_type: "general-purpose", prompt: "usando " } };
      let thrown: unknown = null;
      try { await hook.execute({ tool: "task" }, output); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "malformed empty ref: throws");
      const err = thrown as Error & { messageEs?: string; messageEn?: string; code?: string };
      assert.ok(typeof err.messageEs === "string" && err.messageEs.length > 0, "malformed empty ref: Spanish message present");
      assert.ok(typeof err.messageEn === "string" && err.messageEn.length > 0, "malformed empty ref: English message present");
      assert.ok(/[áéíóúñ]/i.test(err.messageEs ?? ""), "malformed empty ref: Spanish message contains an accented letter");
      assert.equal(output.args.subagent_type, "general-purpose", "malformed empty ref: subagent_type NOT rewritten");
      console.log("  pass: malformed empty reference -> fail-closed error with Spanish + English messages");
    }

    // ---------- 6. Unknown reference (no canonical) -> fail-closed ----------
    {
      const output = { args: { subagent_type: "general-purpose", prompt: "usando completely-unknown-model-xyz" } };
      let thrown: unknown = null;
      try { await hook.execute({ tool: "task" }, output); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "unknown ref: throws");
      const err = thrown as Error & { code?: string; messageEs?: string };
      assert.equal(err.code, "NATURAL_ROUTE_UNKNOWN", "unknown ref: code is NATURAL_ROUTE_UNKNOWN");
      assert.ok(
        /(cat[áa]logo|enrutamiento|modelo)/i.test(err.messageEs ?? ""),
        "unknown ref: Spanish message uses natural-language Spanish wording",
      );
      assert.equal(output.args.subagent_type, "general-purpose", "unknown ref: subagent_type NOT rewritten");
      console.log("  pass: unknown natural reference -> NATURAL_ROUTE_UNKNOWN fail-closed (Spanish + English)");
    }

    // ---------- 7. Ambiguous (multiple triggers) -> fail-closed ----------
    {
      const output = { args: { subagent_type: "general-purpose", prompt: "Usando Gemini y luego @model gpt-4o" } };
      let thrown: unknown = null;
      try { await hook.execute({ tool: "task" }, output); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "ambiguous: throws");
      const err = thrown as Error & { code?: string };
      assert.equal(err.code, "NATURAL_INTENT_AMBIGUOUS", "ambiguous: code is NATURAL_INTENT_AMBIGUOUS");
      assert.equal(output.args.subagent_type, "general-purpose", "ambiguous: subagent_type NOT rewritten");
      console.log("  pass: ambiguous natural reference -> NATURAL_INTENT_AMBIGUOUS fail-closed");
    }

    // ---------- 8. Quarantine blocks BEFORE rewrite ----------
    {
      const quarantineStore = new QuarantineStoreImpl();
      quarantineStore.publish({
        level: "modelProvider",
        providerId: "google",
        modelId: "antigravity-gemini-3.6-flash-tiered",
        type: "permanent",
        until: null,
        reason: "test-block-natural",
      });
      const hookQ = makeHook({
        workspaceRoot,
        resolver,
        quarantineStore,
        auditPath: path.join(tmp, "audit-natural-q.jsonl"),
      });
      const output = {
        args: { subagent_type: "general-purpose", prompt: "Generá un saludo usando Gemini Flash 3.6 Tiered" },
      };
      let thrown: unknown = null;
      try { await hookQ.execute({ tool: "task" }, output); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "quarantine blocks: throws");
      assert.ok(/quar/i.test((thrown as Error).message), "quarantine blocks: error mentions quarantine");
      assert.equal(output.args.subagent_type, "general-purpose", "quarantine blocks: subagent_type NOT rewritten");
      console.log("  pass: active quarantine blocks natural routing BEFORE rewrite");
    }

    // ---------- 9. Readiness blocks BEFORE rewrite ----------
    {
      rmSync(attestationPath, { force: true });
      const output = {
        args: { subagent_type: "general-purpose", prompt: "Generá un saludo usando Gemini Flash 3.6 Tiered" },
      };
      let thrown: unknown = null;
      try { await hook.execute({ tool: "task" }, output); } catch (e) { thrown = e; }
      assert.ok(thrown instanceof Error, "readiness blocks: throws");
      assert.ok(/ATTESTATION_(UNAVAILABLE|MISMATCH|EXPIRED)/.test((thrown as Error).message), "readiness blocks: error mentions attestation");
      assert.equal(output.args.subagent_type, "general-purpose", "readiness blocks: subagent_type NOT rewritten");
      console.log("  pass: missing attestation blocks natural routing BEFORE rewrite");

      // Restore for subsequent tests.
      const reloaded = JSON.parse(readFileSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json"), "utf8")) as { manifestHash: string };
      const restored = {
        schemaVersion: 1,
        verifierVersion: "1.0.0",
        openCodeVersion: "1.18.9",
        workspaceIdentity: path.resolve(workspaceRoot),
        generationEpoch: "epoch-natural",
        manifestHash: reloaded.manifestHash,
        fileHashes: [],
        bootIdentity: "boot-1",
        nonce: "nonce-1",
        issuedAt: Date.now() - 1000,
        expiresAt: Date.now() + 600_000,
        canaries: [],
      };
      // Reuse the verified fileHashes from the seeded manifest.
      const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json"), "utf8")) as { fileHashes: string[] };
      restored.fileHashes = [...manifest.fileHashes].sort();
      const signature = createHmac("sha256", "explicit-shared-key").update(JSON.stringify(restored)).digest("hex");
      writeFileSync(attestationPath, JSON.stringify({ ...restored, signature }, null, 2));
    }

    // ---------- 10. No disk mutation by the natural path ----------
    {
      const beforeDirs = existingSubdirs(workspaceRoot);
      const beforeLock = existsSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "generator.lock"));
      const output = {
        args: { subagent_type: "general-purpose", prompt: "Generá un saludo usando Gemini Flash 3.6 Tiered" },
      };
      await hook.execute({ tool: "task" }, output);
      const afterDirs = existingSubdirs(workspaceRoot);
      assert.deepEqual(afterDirs.sort(), beforeDirs.sort(), "natural path: no new directories created");
      assert.equal(beforeLock, existsSync(path.join(workspaceRoot, ".opencode", "sdd-model-routing", "generator.lock")), "natural path: no generator.lock created");
      console.log("  pass: natural path never mutates the disk");
    }

    // ---------- 11. args.model is never written by the natural path ----------
    {
      // Pre-condition: args.model is undefined (legacy field absent).
      const output = {
        args: { subagent_type: "general-purpose", prompt: "Generá un saludo usando Gemini Flash 3.6 Tiered" },
      };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.model, undefined, "natural path: args.model is NOT added when absent");
      assert.equal(output.args.subagent_type, hostName, "natural path: subagent_type rewritten");
      console.log("  pass: natural path never adds args.model");
    }

    // ---------- 12. Prompt identity: never echoed back into audit gate data ----------
    {
      // Audit logger must NOT receive the prompt as a free-form field.
      const lines = readFileSync(auditPath, "utf8").trim().split("\n");
      for (const line of lines) {
        const entry = JSON.parse(line) as Record<string, unknown>;
        assert.equal(entry["prompt"], undefined, "audit entry does not include the prompt");
        assert.equal(entry["rawPrompt"], undefined, "audit entry does not include a rawPrompt field");
      }
      console.log("  pass: audit entries never carry the raw prompt");
    }

    console.log("All natural-model-routing task hook assertions passed.");
  } finally {
    await cleanupDir(tmp);
  }
}

run().catch((err: unknown) => { console.error(err); process.exit(1); });
