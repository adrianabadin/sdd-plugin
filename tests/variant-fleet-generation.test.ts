/**
 * RED — variant fleet generation: for each route, emit a base agent plus
 * one agent per normalized effort level exposed by the model, and a single
 * canary command. Stale suffixed agents are swept.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { DiskAgentGenerator } from "../src/infrastructure/opencode/disk-agent-generator.js";
import type { EffortLevelMapping } from "../src/domain/model-routing/effort-levels.js";
import { hashHostName } from "../src/domain/model-routing/model-route-host-naming.js";

function routesConfigPath(dir: string): string {
  return path.join(dir, "config", "model-routing", "routes.json");
}

function routesConfig(dir: string, models: Array<{ providerId: string; modelId: string }>): void {
  const configDir = path.join(dir, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    routesConfigPath(dir),
    JSON.stringify({
      schemaVersion: 1,
      generatorVersion: "1.1.0",
      cap: 32,
      routes: models.map((m) => ({ baseTemplate: "sdd-mr-base", ...m })),
    }),
  );
}

function makeGen(workspaceRoot: string): DiskAgentGenerator {
  return new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
}

function writeVariantsSnapshot(
  dir: string,
  snapshot: Record<string, { levels: Partial<EffortLevelMapping> }>,
): void {
  const routingDir = path.join(dir, ".opencode", "sdd-model-routing");
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(path.join(routingDir, "variants.json"), JSON.stringify(snapshot, null, 2));
}

function readAgent(workspaceRoot: string, fileName: string): string {
  return readFileSync(path.join(workspaceRoot, ".opencode", "agents", fileName), "utf8");
}

async function run(): Promise<void> {
  console.log("--- variant fleet generation (RED) ---");

  // 1. 3 variants -> base + -low + -medium + -high.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      routesConfig(workspaceRoot, [{ providerId: "openai", modelId: "gpt-5.6" }]);
      writeVariantsSnapshot(workspaceRoot, { "openai/gpt-5.6": { levels: { low: "minimal", medium: "medium", high: "high" } } });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();
      const hash = hashHostName("sdd-mr-base", { providerId: "openai", modelId: "gpt-5.6" }).slice("sdd-mr-v1-".length);
      for (const suffix of ["", "-low", "-medium", "-high"]) {
        assert.ok(existsSync(path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${hash}${suffix}.md`)),
          `file for suffix "${suffix}" exists`);
      }
      // Frontmatter carries the actual variant key.
      const lowAgent = readAgent(workspaceRoot, `sdd-mr-v1-${hash}-low.md`);
      assert.match(lowAgent, /^variant: minimal$/m, "low agent declares variant: minimal");
      const highAgent = readAgent(workspaceRoot, `sdd-mr-v1-${hash}-high.md`);
      assert.match(highAgent, /^variant: high$/m, "high agent declares variant: high");
      console.log("  pass: 3 variants -> base + low/medium/high with correct variant keys");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 2. 2 variants -> base + -low + -high (no -medium).
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      routesConfig(workspaceRoot, [{ providerId: "anthropic", modelId: "claude-opus-5" }]);
      writeVariantsSnapshot(workspaceRoot, { "anthropic/claude-opus-5": { levels: { low: "high", high: "max" } } });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();
      const hash = hashHostName("sdd-mr-base", { providerId: "anthropic", modelId: "claude-opus-5" }).slice("sdd-mr-v1-".length);
      for (const suffix of ["", "-low", "-high"]) {
        assert.ok(existsSync(path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${hash}${suffix}.md`)),
          `file for suffix "${suffix}" exists`);
      }
      assert.ok(!existsSync(path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${hash}-medium.md`)),
        "no -medium agent for 2-variant model");
      console.log("  pass: 2 variants -> base + low/high, no medium");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 3. 0 variants -> base only.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      routesConfig(workspaceRoot, [{ providerId: "google", modelId: "gemini-flash" }]);
      writeVariantsSnapshot(workspaceRoot, { "google/gemini-flash": {} });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();
      const hash = hashHostName("sdd-mr-base", { providerId: "google", modelId: "gemini-flash" }).slice("sdd-mr-v1-".length);
      assert.ok(existsSync(path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${hash}.md`)),
        "base agent exists");
      for (const suffix of ["-low", "-medium", "-high"]) {
        assert.ok(!existsSync(path.join(workspaceRoot, ".opencode", "agents", `sdd-mr-v1-${hash}${suffix}.md`)),
          `no ${suffix} agent for 0-variant model`);
      }
      console.log("  pass: 0 variants -> base only");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 4. Frontmatter shape: model, mode: subagent, hidden: true, permission.task.'*': deny.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      routesConfig(workspaceRoot, [{ providerId: "openai", modelId: "gpt-5.6" }]);
      writeVariantsSnapshot(workspaceRoot, { "openai/gpt-5.6": { levels: { low: "low", medium: "medium", high: "high" } } });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();
      const hash = hashHostName("sdd-mr-base", { providerId: "openai", modelId: "gpt-5.6" }).slice("sdd-mr-v1-".length);
      for (const suffix of ["", "-low", "-medium", "-high"]) {
        const body = readAgent(workspaceRoot, `sdd-mr-v1-${hash}${suffix}.md`);
        assert.match(body, /^model: openai\/gpt-5.6$/m, `${suffix || "(base)"} declares model`);
        assert.match(body, /^mode: subagent$/m, `${suffix || "(base)"} declares mode: subagent`);
        assert.match(body, /^hidden: true$/m, `${suffix || "(base)"} declares hidden: true`);
        assert.match(body, /^permission:$/m, `${suffix || "(base)"} declares permission block`);
        assert.match(body, /^\s{2}task:$/m, `${suffix || "(base)"} declares permission.task`);
        assert.match(body, /^\s{4}'\*': deny$/m, `${suffix || "(base)"} declares task deny`);
      }
      console.log("  pass: every generated file has the right frontmatter shape");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 5. Only ONE canary command per model.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      routesConfig(workspaceRoot, [{ providerId: "openai", modelId: "gpt-5.6" }]);
      writeVariantsSnapshot(workspaceRoot, { "openai/gpt-5.6": { low: "low", medium: "medium", high: "high" } });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();
      const hash = hashHostName("sdd-mr-base", { providerId: "openai", modelId: "gpt-5.6" }).slice("sdd-mr-v1-".length);
      const commands = readdirSync(path.join(workspaceRoot, ".opencode", "commands"))
        .filter((f) => f.startsWith(`sdd-mr-canary-v1-${hash}`));
      assert.equal(commands.length, 1, "exactly one canary command per model");
      assert.equal(commands[0], `sdd-mr-canary-v1-${hash}.md`, "canary is base hash, no suffix");
      console.log("  pass: exactly one base-only canary command per model");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 6. Sweep removes stale variant files of removed routes.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      // Pre-seed a stale suffixed file for a route we will NOT include in the new run.
      const staleHash = "deadbeefdeadbeef";
      const agentsDir = path.join(workspaceRoot, ".opencode", "agents");
      mkdirSync(agentsDir, { recursive: true });
      writeFileSync(path.join(agentsDir, `sdd-mr-v1-${staleHash}-low.md`), "stale");
      writeFileSync(path.join(agentsDir, `sdd-mr-v1-${staleHash}-high.md`), "stale");

      routesConfig(workspaceRoot, [{ providerId: "openai", modelId: "gpt-5.6" }]);
      writeVariantsSnapshot(workspaceRoot, { "openai/gpt-5.6": { levels: { low: "low", high: "high" } } });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();

      assert.ok(!existsSync(path.join(agentsDir, `sdd-mr-v1-${staleHash}-low.md`)), "stale -low swept");
      assert.ok(!existsSync(path.join(agentsDir, `sdd-mr-v1-${staleHash}-high.md`)), "stale -high swept");
      console.log("  pass: stale suffixed variant files are swept");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  // 7. variants.json is written next to the manifest.
  {
    const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-gen-"));
    try {
      const workspaceRoot = path.join(tmp, "ws");
      mkdirSync(workspaceRoot, { recursive: true });
      routesConfig(workspaceRoot, [{ providerId: "openai", modelId: "gpt-5.6" }]);
      writeVariantsSnapshot(workspaceRoot, { "openai/gpt-5.6": { levels: { low: "low", high: "high" } } });
      const gen = new DiskAgentGenerator({ workspaceRoot, routesConfigPath: routesConfigPath(workspaceRoot) });
      await gen.run();
      const variantsPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "variants.json");
      assert.ok(existsSync(variantsPath), "variants.json is written next to the manifest");
      const body = JSON.parse(readFileSync(variantsPath, "utf8")) as Record<string, unknown>;
      assert.ok("openai/gpt-5.6" in body, "snapshot is persisted keyed by canonical id");
      console.log("  pass: variants.json is written and keyed by canonical id");
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  console.log("All variant-fleet-generation assertions passed!");
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
