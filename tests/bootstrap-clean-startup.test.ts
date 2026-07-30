import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SddPlugin,
  disposeBootstrapPersistence,
} from "../src/bootstrap/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_KEYS = [
  "DATABASE_URL",
  "SDD_PLUGIN_DATA_DIR",
  "SDD_PLUGIN_DB_PATH",
  "SDD_PLUGIN_LEGACY_DB_PATH",
] as const;

function createSchemaDatabase(dbPath: string): void {
  const prismaCli = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");
  execFileSync(
    process.execPath,
    [prismaCli, "db", "push", "--accept-data-loss", "--url", `file:${dbPath}`],
    {
      env: { ...process.env, DATABASE_URL: `file:${dbPath}` },
      stdio: "ignore",
    },
  );
}

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function removeTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function run(): Promise<void> {
  console.log("--- model-route bootstrap clean startup ---");

  const env = snapshotEnv();
  const tmpDir = mkdtempSync(path.join(tmpdir(), "sdd-model-route-clean-startup-"));
  const dbPath = path.join(tmpDir, "opencode-models.db");

  try {
    process.env.SDD_PLUGIN_DB_PATH = dbPath;
    delete process.env.SDD_PLUGIN_DATA_DIR;
    delete process.env.SDD_PLUGIN_LEGACY_DB_PATH;
    delete process.env.DATABASE_URL;
    createSchemaDatabase(dbPath);

    const hooks = await SddPlugin({
      project: "model-route-clean-startup",
      directory: tmpDir,
      client: {},
    });

    assert.deepEqual(
      Object.keys(hooks).sort(),
      ["tool.execute.before"],
      "bootstrap must not register the obsolete config staging hook",
    );
    assert.equal(
      Object.hasOwn(hooks, "config"),
      false,
      "clean startup exposes no disabled-not-ready config callback",
    );

    const bootstrapSource = readFileSync(
      path.join(repoRoot, "src", "bootstrap", "index.ts"),
      "utf8",
    );
    assert.doesNotMatch(
      bootstrapSource,
      /model-route-config-hook|disabled-not-ready|ModelRouteConfigUnsupportedError|OpenCodeConfig/,
      "bootstrap import/wiring/logging contains no config-staging migration debt",
    );

    const obsoleteProductionFiles = [
      "src/infrastructure/opencode/model-route-config-hook.ts",
      "src/application/resolve-model-route/staging.ts",
      "src/application/resolve-model-route/readiness-canary.ts",
      "src/application/resolve-model-route/use-case.ts",
      "src/domain/model-routing/routed-host.ts",
    ];
    for (const relativePath of obsoleteProductionFiles) {
      assert.equal(
        existsSync(path.join(repoRoot, relativePath)),
        false,
        `${relativePath} must be removed from production imports/exports`,
      );
    }

    // The composition root applies connection PRAGMAs asynchronously. Let that
    // startup work settle before the test's explicit persistence disposal.
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    console.log("Clean startup/import/export assertions passed.");
  } finally {
    await disposeBootstrapPersistence();
    restoreEnv(env);
    await removeTempDir(tmpDir);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
