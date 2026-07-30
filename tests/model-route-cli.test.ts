import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoCliEntry = path.join(repoRoot, "src", "cli", "model-route-agents.ts");

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
    const ok = runCli(workspaceRoot, routesPath);
    assert.equal(ok.code, 0, `CLI exits 0 on valid config (stderr=${ok.stderr})`);
    assert.match(ok.stdout, /generated=2|manifest=/, "CLI prints a short summary");

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

    // 3. The real project `.opencode/` MUST NOT have grown any owned route
    //    files because the CLI was given an isolated workspace.
    const realAgentsDir = path.join(repoRoot, ".opencode", "agents");
    if (existsSync(realAgentsDir)) {
      const realEntries = readdirSync(realAgentsDir);
      for (const entry of realEntries) {
        assert.ok(
          !entry.startsWith("sdd-mr-v1-"),
          `real project .opencode/agents must NOT contain ${entry} after isolated CLI run`,
        );
      }
    }
    const realRoutingDir = path.join(repoRoot, ".opencode", "sdd-model-routing");
    assert.equal(
      existsSync(realRoutingDir),
      false,
      "real project .opencode/sdd-model-routing must not exist after isolated CLI run",
    );

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

    console.log("All CLI assertions passed.");
  } finally {
    await cleanupDirAsync(workspaceRoot);
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});