/**
 * Rev 2 — `ModelRouteTaskHook` natural-intent routing path.
 *
 * The prompt carries a WU1 trigger (no explicit grammar on subagent_type)
 * and the hook must route through the same selection flow as the
 * explicit-grammar path. Rev 2 effort extraction applies here too.
 *
 * Behavior contract:
 *  - The prompt is data; the canonical identity controls every gate.
 *  - The existing natural-intent path is preserved (alias-aware resolver).
 *  - The hook never reads, writes, or relies on `output.args.model`.
 *  - Effort defaults to "low"; the parser extracts `esfuerzo high` etc.
 *  - The variant fleet on disk carries the actual variant key; the
 *    dispatcher rewrites `subagent_type` to `<host>-<level>`.
 *  - No trigger in prompt -> byte-for-byte legacy passthrough, no audit.
 *  - The hook never mutates the disk (no generator, no manifest, no agent
 *    files, no lock, no journal).
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { ModelRouteTaskHook } from "../src/infrastructure/opencode/model-route-task-hook.js";
import { ModelRouteResolver } from "../src/domain/model-routing/model-route-resolver.js";
import { loadRouteWhitelist } from "../src/domain/model-routing/route-whitelist.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";
import { QuarantineStoreImpl } from "../src/infrastructure/runtime/quarantine-store.js";
import type { EffortLevelMapping } from "../src/domain/model-routing/effort-levels.js";
import { NATURAL_MODEL_ALIASES } from "../src/domain/model-routing/natural-model-aliases.js";

const PROVIDER = "openai";
const MODEL = "gpt-5.6";
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

function writeAgent(workspaceRoot: string, suffix: string, variantKey?: string): void {
  const agentPath = path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${suffix}.md`);
  mkdirSync(path.dirname(agentPath), { recursive: true });
  const variantLine = variantKey !== undefined ? `variant: ${variantKey}\n` : "";
  writeFileSync(
    agentPath,
    [
      "---",
      `description: Deterministic routed host for ${PROVIDER}/${MODEL}.`,
      "mode: subagent",
      "hidden: true",
      `model: ${PROVIDER}/${MODEL}`,
      variantLine,
      "permission:",
      "  task:",
      "    '*': deny",
      "---",
      "",
    ].join("\n"),
  );
}

function makeFixture(tmp: string, opts: { variants?: Partial<EffortLevelMapping>; writeVariants: boolean }): {
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

  // Seed quarantine store (empty by default).
  const quarantine = new QuarantineStoreImpl();

  // Default: base + canary.
  writeAgent(workspaceRoot, SUFFIX);
  if (opts.writeVariants) {
    for (const level of ["low", "medium", "high"] as const) {
      if (opts.variants?.[level]) writeAgent(workspaceRoot, `${SUFFIX}-${level}`, opts.variants[level]);
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
  warnings: string[];
}): ModelRouteTaskHook {
  const whitelist = loadRouteWhitelist(args.workspaceRoot);
  const resolver = new ModelRouteResolver(whitelist, NATURAL_MODEL_ALIASES);
  return new ModelRouteTaskHook({
    workspaceRoot: args.workspaceRoot,
    whitelist,
    variants: args.variants,
    resolver,
    quarantineStore: args.quarantine,
    audit: { path: args.auditPath },
    logger: {
      info: () => {},
      warn: (m: string) => args.warnings.push(m),
      error: (m: string) => args.warnings.push(`ERROR: ${m}`),
    },
    loadQuarantineEntries: async () => args.quarantine.snapshot(),
  });
}

async function run(): Promise<void> {
  console.log("--- natural-model-routing task hook (Rev 2) ---");

  // 1. Natural intent with explicit model trigger + no effort -> -low.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-natural-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "low", medium: "medium", high: "high" }, writeVariants: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: "general-purpose", prompt: "usando openai/gpt-5.6" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-low`, "natural intent default -> -low");
      assert.equal(output.args.prompt, "usando openai/gpt-5.6", "prompt bytes are untouched");
      console.log("  pass: natural intent + no effort -> -low");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 2. Natural intent + esfuerzo high -> -high.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-natural-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "low", medium: "medium", high: "high" }, writeVariants: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: "general-purpose", prompt: "usando openai/gpt-5.6 con esfuerzo high" } };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.subagent_type, `${HOST}-high`, "natural + esfuerzo high -> -high");
      console.log("  pass: natural + esfuerzo high -> -high");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 3. Natural intent + effort medium not exposed -> nearest (high).
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-natural-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "low", high: "high" }, writeVariants: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = { args: { subagent_type: "general-purpose", prompt: "usando openai/gpt-5.6 con esfuerzo medium" } };
      await hook.execute({ tool: "task" }, output);
      // Tie-break in nearestLevel prefers the higher level.
      assert.equal(output.args.subagent_type, `${HOST}-high`, "medium falls back to nearest (high)");
      const lines = readFileSync(fx.auditPath, "utf8").trim().split("\n");
      const entry = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
      assert.equal(entry["effortRequested"], "medium");
      assert.equal(entry["effortApplied"], "high");
      assert.equal(entry["effortFallbackReason"], "LEVEL_NOT_EXPOSED");
      console.log("  pass: natural + esfuerzo medium not exposed -> nearest + audit");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 4. Natural intent + no model trigger -> byte-for-byte passthrough.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-natural-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "low" }, writeVariants: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const legacy = { args: { subagent_type: "general-purpose", prompt: "please do something", model: "openai/gpt-4o" } };
      const snapshot = JSON.parse(JSON.stringify(legacy)) as typeof legacy;
      await hook.execute({ tool: "task" }, legacy);
      assert.deepEqual(legacy, snapshot, "natural path: no trigger -> passthrough");
      console.log("  pass: natural path + no trigger -> passthrough");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 5. args.model is never read or written by the natural path.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-natural-"));
    try {
      const fx = makeFixture(tmp, { variants: { low: "low" }, writeVariants: true });
      const hook = makeHook({ ...fx, warnings: fx.warnings });
      const output = {
        args: {
          subagent_type: "general-purpose",
          prompt: "usando openai/gpt-5.6",
          model: "should-not-be-used/foo",
        },
      };
      await hook.execute({ tool: "task" }, output);
      assert.equal(output.args.model, "should-not-be-used/foo", "args.model is NEVER read or relied on");
      console.log("  pass: args.model is untouched on the natural path");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log("All natural-model-routing task hook assertions passed!");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
