/**
 * Rev 2 CLI tests: the pre-start generator (`model-route-agents.ts`)
 * runs with a plain `routes.json` whitelist and writes the variant
 * fleet + manifest. The boot-CLI exit-code cases are gone (the
 * supervisor stack is deleted).
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoCliEntry = path.join(repoRoot, "src", "cli", "model-route-agents.ts");
const tsxCliWin = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");

function routesConfig(dir: string, models: Array<{ providerId: string; modelId: string }>): string {
  const configDir = path.join(dir, "config", "model-routing");
  mkdirSync(configDir, { recursive: true });
  const routesPath = path.join(configDir, "routes.json");
  writeFileSync(
    routesPath,
    JSON.stringify({
      schemaVersion: 1,
      generatorVersion: "1.1.0",
      cap: 32,
      routes: models.map((m) => ({ baseTemplate: "sdd-mr-base", ...m })),
    }),
  );
  return routesPath;
}

function variantsSnapshot(dir: string, snapshot: Record<string, { levels: Record<string, string> }>): void {
  const routingDir = path.join(dir, ".opencode", "sdd-model-routing");
  mkdirSync(routingDir, { recursive: true });
  writeFileSync(path.join(routingDir, "variants.json"), JSON.stringify(snapshot, null, 2));
}

async function runCli(workspaceRoot: string, routesPath: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const stdout = execFileSync("node", [tsxCliWin, repoCliEntry, workspaceRoot, routesPath], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

async function run(): Promise<void> {
  console.log("--- model-route CLI (Rev 2 generator) ---");

  const tmp = mkdtempSync(path.join(tmpdir(), "sdd-mr-cli-"));
  try {
    const workspaceRoot = path.join(tmp, "ws");
    mkdirSync(workspaceRoot, { recursive: true });
    const routesPath = routesConfig(workspaceRoot, [
      { providerId: "openai", modelId: "gpt-5.6" },
      { providerId: "anthropic", modelId: "claude-opus-5" },
    ]);
    variantsSnapshot(workspaceRoot, {
      "openai/gpt-5.6": { levels: { low: "low", medium: "medium", high: "high" } },
      "anthropic/claude-opus-5": { levels: { low: "high", high: "max" } },
    });

    const result = await runCli(workspaceRoot, routesPath);
    assert.equal(result.code, 0, `CLI exit code; stderr=${result.stderr}`);

    // Manifest is written.
    const manifestPath = path.join(workspaceRoot, ".opencode", "sdd-model-routing", "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest is written");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { routes: unknown[] };
    assert.equal(manifest.routes.length, 2, "manifest declares both routes");

    // Variant fleet is on disk.
    const agentsDir = path.join(workspaceRoot, ".opencode", "agents");
    const files = readdirSync(agentsDir);
    const sddFiles = files.filter((f) => f.startsWith("sdd-mr-v1-"));
    // openai/gpt-5.6 -> 4 files (base + -low + -medium + -high)
    // anthropic/claude-opus-5 -> 3 files (base + -low + -high)
    assert.equal(sddFiles.length, 7, "variant fleet has 7 base+suffixed files (4+3)");

    // One canary command per model.
    const commandsDir = path.join(workspaceRoot, ".opencode", "commands");
    const commands = readdirSync(commandsDir).filter((f) => f.startsWith("sdd-mr-canary-v1-"));
    assert.equal(commands.length, 2, "exactly one canary command per model");

    console.log("  pass: generator CLI writes manifest + variant fleet + canaries");
    console.log("All model-route CLI assertions passed!");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

run().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
