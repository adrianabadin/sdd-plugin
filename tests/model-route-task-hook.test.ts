/**
 * RED — Model-routing `tool.execute.before` hook contract for Rev 2.
 *
 * routes.json + quarantine + variant snapshot are the only inputs.
 * No attestation, no manifest, no boot identity, no signing key, no
 * OpenCode version check. The hook must work in a plain OpenCode session
 * that knows nothing about the routing infrastructure.
 *
 * Two paths converge on the same selection:
 *   A. Explicit-grammar `model-route:v1|sdd-mr-base|<modelRef>[|<effort>]`
 *   B. Natural-intent prompt trigger (with optional effort)
 *
 * Selection (after parse + resolve + quarantine reconcile):
 *   1. lookup hostName in whitelist (else ROUTE_NOT_WHITELISTED)
 *   2. read variant mapping for the canonical id
 *   3. resolve requested level (default low) against the mapping
 *      - mapping empty     -> base agent + MODEL_HAS_NO_VARIANTS warning
 *      - level not exposed -> nearest available + LEVEL_NOT_EXPOSED
 *   4. confirm target .md exists on disk (else ROUTED_AGENT_UNAVAILABLE)
 *   5. rewrite args.subagent_type
 *   6. append best-effort audit entry
 *
 * `args.model` is NEVER read or written. Prompt bytes are NEVER mutated.
 * No natural trigger + no grammar trigger -> byte-for-byte passthrough,
 * no audit entry.
 */

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ModelRouteTaskHook,
  RouteNotWhitelistedError,
  RoutedAgentUnavailableError,
  QuarantinedModelError,
} from "../src/infrastructure/opencode/model-route-task-hook.js";
import { ModelRouteResolver } from "../src/domain/model-routing/model-route-resolver.js";
import { loadRouteWhitelist } from "../src/domain/model-routing/route-whitelist.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";
import type { EffortLevelMapping } from "../src/domain/model-routing/effort-levels.js";

const PROVIDER = "openai";
const MODEL = "gpt-5.6-sol";
const HOST = hashHostName("sdd-mr-base", { providerId: PROVIDER, modelId: MODEL });
const SUFFIX = HOST.slice("sdd-mr-v1-".length);

function makeRoutesConfig(dir: string): void {
  const configDir = path.join(dir, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, "routes.json"),
    JSON.stringify({
      schemaVersion: 1,
      generatorVersion: "1.1.0",
      cap: 32,
      routes: [{ baseTemplate: "sdd-mr-base", providerId: PROVIDER, modelId: MODEL }],
    }),
  );
}

function writeAgent(workspaceRoot: string, suffix: string): void {
  const agentPath = path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${suffix}.md`);
  mkdirSync(path.dirname(agentPath), { recursive: true });
  writeFileSync(
    agentPath,
    [
      "---",
      `description: Deterministic routed host for ${PROVIDER}/${MODEL}.`,
      "mode: subagent",
      "hidden: true",
      `model: ${PROVIDER}/${MODEL}`,
      ...(suffix.includes("-") && suffix !== HOST.slice("sdd-mr-v1-".length)
        ? [`variant: ${suffix.split("-").pop()}`]
        : []),
      "permission:",
      "  task:",
      "    '*': deny",
      "---",
      "",
    ].join("\n"),
  );
}

interface MakeOpts {
  variants?: Partial<EffortLevelMapping>;
  quarantined?: { type: "permanent" | "ttl"; reason?: string; ttlMs?: number };
  includeLogger?: boolean;
  auditSinkThrows?: boolean;
  writeVariantAgents?: boolean;
  skipAgentFiles?: boolean;
}

function makeFixture(tmp: string, opts: MakeOpts = {}): {
  workspaceRoot: string;
  auditPath: string;
  variants: Map<string, { levels: Partial<EffortLevelMapping> }>;
  warnings: string[];
  quarantine: QuarantineStoreImpl;
} {
  const workspaceRoot = path.join(tmp, "workspace");
  mkdirSync(workspaceRoot, { recursive: true });
  makeRoutesConfig(workspaceRoot);
  const auditPath = path.join(tmp, "audit.jsonl");

  // Seed quarantine if requested.
  const quarantine = new QuarantineStoreImpl();
  if (opts.quarantined) {
    const until = opts.quarantined.type === "ttl"
      ? new Date(Date.now() + (opts.quarantined.ttlMs ?? 3_600_000))
      : undefined;
    quarantine.publish({
      level: "model",
      modelId: MODEL,
      type: opts.quarantined.type,
      until,
      reason: opts.quarantined.reason ?? `${opts.quarantined.type} block`,
    });
  }

  // Default: write the base agent only. With `writeVariantAgents: true`,
  // also write the per-level agents.
  if (!opts.skipAgentFiles) {
    writeAgent(workspaceRoot, SUFFIX);
    if (opts.writeVariantAgents) {
      for (const level of ["low", "medium", "high"] as const) {
        if (opts.variants?.[level]) writeAgent(workspaceRoot, `${SUFFIX}-${level}`);
      }
    }
  }

  const variants = new Map<string, { levels: Partial<EffortLevelMapping> }>();
  if (opts.variants) {
    variants.set(`${PROVIDER}/${MODEL}`, { levels: opts.variants });
  }

  return { workspaceRoot, auditPath, variants, warnings: [], quarantine };
}

function makeHook(args: {
  workspaceRoot: string;
  variants: Map<string, { levels: Partial<EffortLevelMapping> }>;
  quarantine: QuarantineStoreImpl;
  auditPath: string;
  auditSinkThrows?: boolean;
  warnings: string[];
}): ModelRouteTaskHook {
  const whitelist = loadRouteWhitelist(args.workspaceRoot);
  const resolver = new ModelRouteResolver(whitelist, new Map());
  return new ModelRouteTaskHook({
    workspaceRoot: args.workspaceRoot,
    whitelist,
    variants: args.variants,
    resolver,
    quarantineStore: args.quarantine,
    audit: { path: args.auditPath },
    logger: {
      info: () => {},
      warn: (msg: string) => args.warnings.push(msg),
      error: (msg: string) => args.warnings.push(`ERROR: ${msg}`),
    },
    loadQuarantineEntries: async () => {
      return args.quarantine.snapshot();
    },
  });
}

async function run(): Promise<void> {
  console.log("--- model-route task hook (RED) ---");

  // 1. Whitelisted + no effort mentioned -> -low (default), prompt+model unchanged.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high", high: "max" }, writeVariantAgents: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = {
        args: {
          subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}`,
          prompt: "hello world",
          model: "should-not-be-used/foo",
        },
      };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-low`, "default effort -> -low");
      assert.equal(output.args.prompt, "hello world", "prompt bytes are untouched");
      assert.equal(output.args.model, "should-not-be-used/foo", "args.model is never touched");
      console.log("  pass: default effort -> -low, prompt+model unchanged");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 2. Whitelisted + effort high + variants present -> -high.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high", high: "max" }, writeVariantAgents: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}|high`, prompt: "x" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-high`, "grammar 4th segment selects -high");
      console.log("  pass: grammar 4th segment high -> -high");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 3. Whitelisted + effort medium + model has only 2 levels -> nearest available.
  //    Audit records effortFallbackReason: "LEVEL_NOT_EXPOSED". Dispatch is NOT blocked.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high", high: "max" }, writeVariantAgents: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}|medium`, prompt: "x" } };
      await hook.execute({ tool: "task" }, output);
      // nearest(medium, { low, high }) -> high
      assert.equal(output.args.subagent_type, `${HOST}-high`, "medium falls back to nearest available (high)");
      const lines = readFileSync(fx.auditPath, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      assert.equal(entry["effortRequested"], "medium", "audit records the requested level");
      assert.equal(entry["effortApplied"], "high", "audit records the applied level");
      assert.equal(entry["effortFallbackReason"], "LEVEL_NOT_EXPOSED", "audit records the fallback reason");
      console.log("  pass: medium not exposed -> nearest, audit carries fallback reason");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 4. Whitelisted + effort + model has NO variants -> base agent, warning logged, audit fallback.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: {}, writeVariantAgents: false });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}|high`, prompt: "x" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, HOST, "no variants -> base agent, no -high suffix");
      assert.ok(
        fx.warnings.some((m) => /no effort variants/.test(m)),
        "a warning is logged when the model exposes no variants",
      );
      const lines = readFileSync(fx.auditPath, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      assert.equal(entry["effortRequested"], "high");
      assert.equal(entry["effortApplied"], null);
      assert.equal(entry["effortFallbackReason"], "MODEL_HAS_NO_VARIANTS");
      console.log("  pass: no variants -> base + warning + MODEL_HAS_NO_VARIANTS audit");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 5. Not whitelisted -> ROUTE_NOT_WHITELISTED, args unchanged.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp);
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: "model-route:v1|sdd-mr-base|no-such/model", prompt: "x" } };
      await assert.rejects(
        () => hook.execute({ tool: "task" }, output),
        (err: unknown) => err instanceof RouteNotWhitelistedError,
      );
      assert.equal(output.args.subagent_type, "model-route:v1|sdd-mr-base|no-such/model",
        "args.subagent_type is untouched when routing is rejected");
      console.log("  pass: not whitelisted -> ROUTE_NOT_WHITELISTED, no rewrite");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 6. Whitelisted but TTL-quarantined -> QuarantinedModelError with the reason.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { quarantined: { type: "ttl", reason: "rate limit", ttlMs: 60_000 }, writeVariantAgents: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}`, prompt: "x" } };
      await assert.rejects(
        () => hook.execute({ tool: "task" }, output),
        (err: unknown) => err instanceof QuarantinedModelError && /rate limit/.test(err.message),
      );
      console.log("  pass: TTL quarantine -> QuarantinedModelError with reason");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 7. Whitelisted, quarantine expired -> routes normally to -low.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, {
        quarantined: { type: "ttl", reason: "expired", ttlMs: -10_000 },
        variants: { low: "low", medium: "medium", high: "high" },
        writeVariantAgents: true,
      });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}`, prompt: "x" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-low`, "expired quarantine does not block dispatch");
      console.log("  pass: expired TTL quarantine -> dispatch proceeds");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 8. Whitelisted but target .md (including -low) absent -> RoutedAgentUnavailableError.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high" }, writeVariantAgents: false });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}`, prompt: "x" } };
      await assert.rejects(
        () => hook.execute({ tool: "task" }, output),
        (err: unknown) => err instanceof RoutedAgentUnavailableError,
      );
      console.log("  pass: missing agent file -> RoutedAgentUnavailableError");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 9. No grammar + no natural trigger -> byte-for-byte passthrough, no audit.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp);
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const legacy = { args: { subagent_type: "general-purpose", prompt: "do something", model: "openai/gpt-4o" } };
      const snapshot = JSON.parse(JSON.stringify(legacy)) as typeof legacy;
      await hook.execute({ tool: "task" }, legacy);
      assert.deepEqual(legacy, snapshot, "legacy non-prefixed call is byte-for-byte unchanged");
      try {
        readFileSync(fx.auditPath, "utf8");
        assert.fail("audit file should not exist for a legacy passthrough");
      } catch (e) {
        assert.match((e as NodeJS.ErrnoException).code ?? "", /ENOENT/, "no audit file is written");
      }
      console.log("  pass: no grammar + no natural trigger -> passthrough, no audit");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 10. Grammar 4-segment form -> -high.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high", high: "max" }, writeVariantAgents: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}|high`, prompt: "x" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-high`, "grammar 4th segment -> -high");
      console.log("  pass: grammar 4-segment form -> -high");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 11. Audit sink throws -> dispatch still rewrites subagent_type.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high", high: "max" }, writeVariantAgents: true });
      // Force the audit append to throw by pointing the file at a
      // pre-existing directory. `openSync(<dir>, "a")` raises EISDIR,
      // so every audit call fails — the dispatch must still rewrite.
      const badAuditPath = path.join(tmp, "audit-as-dir");
      mkdirSync(badAuditPath, { recursive: true });
      const whitelist = loadRouteWhitelist(fx.workspaceRoot);
      const resolver = new ModelRouteResolver(whitelist, new Map());
      const hook = new ModelRouteTaskHook({
        workspaceRoot: fx.workspaceRoot,
        whitelist,
        variants: fx.variants,
        resolver,
        quarantineStore: fx.quarantine,
        audit: { path: badAuditPath },
        logger: {
          info: () => {},
          warn: (msg: string) => fx.warnings.push(msg),
          error: (msg: string) => fx.warnings.push(`ERROR: ${msg}`),
        },
        loadQuarantineEntries: async () => fx.quarantine.snapshot(),
      });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}|high`, prompt: "x" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-high`, "rewrite happens even when audit throws");
      assert.ok(
        fx.warnings.some((m) => m.startsWith("ERROR:") && /audit append failed/.test(m)),
        "the audit failure is logged as an error",
      );
      console.log("  pass: audit sink throws -> rewrite still happens, failure logged");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 12. The hook writes nothing to disk except the audit line.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-hook-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "high", high: "max" }, writeVariantAgents: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: `model-route:v1|sdd-mr-base|${PROVIDER}/${MODEL}|high`, prompt: "x" } };
      const before = existsSync(fx.auditPath) ? readFileSync(fx.auditPath, "utf8").length : 0;
      await hook.execute({ tool: "task" }, output);
      const after = existsSync(fx.auditPath) ? readFileSync(fx.auditPath, "utf8").length : 0;
      assert.ok(after > before, "audit line appended (size grew)");
      // Snapshot the agents dir before; assert it has the same files after.
      const agentsDir = path.join(fx.workspaceRoot, ".opencode", "agents");
      const beforeAgents = readdirSync(agentsDir).filter((f) => f.startsWith("sdd-mr-v1-")).sort();
      await hook.execute({ tool: "task" }, output);
      const afterAgents = readdirSync(agentsDir).filter((f) => f.startsWith("sdd-mr-v1-")).sort();
      assert.deepEqual(afterAgents, beforeAgents, "the hook did not touch the agents directory");
      console.log("  pass: only the audit line was appended; agents dir untouched");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log("All model-route task hook assertions passed!");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
