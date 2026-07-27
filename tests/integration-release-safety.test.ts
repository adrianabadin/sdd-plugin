/**
 * Task 7 Integration Test — Release safety: test DB isolation + staged artifact protection.
 *
 * Acceptance scenarios (design.md):
 *   - "Use the shared database-path resolver; tests MUST use isolated test
 *      databases."
 *   - "Confirm .env, production databases, node_modules, dist, and generated
 *      artifacts are not staged."
 *
 * Contract under test:
 *   - Each integration test points `SDD_PLUGIN_DB_PATH` at a unique file so
 *     concurrent tests cannot trample each other.
 *   - The shared `resolveDatabasePath()` honors `SDD_PLUGIN_DB_PATH` first,
 *     then falls back to `<repo>/opencode-models.db` (production DB).
 *   - Tests MUST NOT touch the production fallback when the override is set.
 *   - `.gitignore` excludes `.env`, production DBs, `node_modules/`, `dist/`,
 *     generated Prisma client, and incremental build state.
 *   - `git check-ignore` confirms forbidden paths are ignored.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, statSync, unlinkSync, readFileSync } from "node:fs";

import { resolveDatabasePath } from "../src/infrastructure/runtime/database-path.js";

console.log("--- Task 7 Integration: Release Safety (DB isolation + staged artifacts) ---");

const failures: string[] = [];

function assertOk(condition: unknown, message: string): void {
  if (!condition) {
    failures.push(message);
    console.error("  FAIL: " + message);
  } else {
    console.log("  pass: " + message);
  }
}

function run() {
  // === Shared resolver honors env override ===
  const testDbName = `opencode-models.test-isolation-${randomUUID()}.db`;
  const testDbPath = path.resolve(testDbName);
  process.env.SDD_PLUGIN_DB_PATH = testDbPath;
  const resolved = resolveDatabasePath();
  assertOk(resolved === testDbPath, "resolver returns SDD_PLUGIN_DB_PATH when set");

  // === Resolver falls back to platform default / repo DB when env not set ===
  const previousEnv = process.env.SDD_PLUGIN_DB_PATH;
  delete process.env.SDD_PLUGIN_DB_PATH;
  const fallback = resolveDatabasePath();
  assertOk(path.isAbsolute(fallback) && fallback.endsWith('opencode-models.db'), `resolver fallback is absolute opencode-models.db path (got ${fallback})`);
  if (previousEnv !== undefined) process.env.SDD_PLUGIN_DB_PATH = previousEnv;
  else process.env.SDD_PLUGIN_DB_PATH = testDbPath;

  // === Three parallel test DBs are independent files ===
  const dbPaths = [
    path.resolve(`opencode-models.test-iso-a-${randomUUID()}.db`),
    path.resolve(`opencode-models.test-iso-b-${randomUUID()}.db`),
    path.resolve(`opencode-models.test-iso-c-${randomUUID()}.db`),
  ];
  for (const db of dbPaths) {
    process.env.SDD_PLUGIN_DB_PATH = db;
    process.env.DATABASE_URL = `file:${db}`;
    execSync("npx prisma db push --accept-data-loss", { stdio: "ignore" });
    assertOk(existsSync(db), `test DB created at ${path.basename(db)}`);
  }
  const uniqueInodes = new Set<string>();
  for (const db of dbPaths) uniqueInodes.add(`${statSync(db).ino}-${statSync(db).dev}`);
  assertOk(uniqueInodes.size === dbPaths.length, "each test DB is an independent file");

  // === Production DB is NOT mutated when override is active ===
  const prodDbPath = path.resolve("opencode-models.db");
  const prodExistedBefore = existsSync(prodDbPath);
  const prodMtimeBefore = prodExistedBefore ? statSync(prodDbPath).mtimeMs : 0;
  process.env.SDD_PLUGIN_DB_PATH = dbPaths[0];
  process.env.DATABASE_URL = `file:${dbPaths[0]}`;
  execSync("npx prisma db push --accept-data-loss", { stdio: "ignore" });
  const prodMtimeAfter = existsSync(prodDbPath) ? statSync(prodDbPath).mtimeMs : 0;
  assertOk(prodExistedBefore === existsSync(prodDbPath), "production DB existence unchanged after test push");
  assertOk(prodMtimeBefore === prodMtimeAfter, "production DB mtime unchanged after test push");

  // === Test DBs can be deleted independently ===
  for (const db of dbPaths) {
    if (existsSync(db)) unlinkSync(db);
    assertOk(!existsSync(db), `test DB ${path.basename(db)} deleted cleanly`);
  }
  delete process.env.SDD_PLUGIN_DB_PATH;

  // === .gitignore contains all required ignore patterns ===
  const gitignorePath = path.resolve(".gitignore");
  assertOk(existsSync(gitignorePath), ".gitignore exists");
  const gitignore = readFileSync(gitignorePath, "utf8");
  const requiredPatterns: Array<{ pattern: RegExp; label: string }> = [
    { pattern: /^\/?\.env(\s|$|\.)/m, label: ".env files" },
    { pattern: /^node_modules\/?$/m, label: "node_modules/" },
    { pattern: /^dist\/?$/m, label: "dist/" },
    { pattern: /^\/?opencode-models\.db(\s|$|-)/m, label: "opencode-models.db production" },
    { pattern: /^\/?opencode-models\.test(\.|\-|\*)/m, label: "opencode-models.test db variants" },
    { pattern: /\/?src\/generated\/prisma/m, label: "src/generated/prisma" },
    { pattern: /\*\.tsbuildinfo/m, label: "*.tsbuildinfo" },
    { pattern: /^\/?\.planning\/?$/m, label: ".planning/ local state" },
    { pattern: /^\/?\.pmc\/?$/m, label: ".pmc/ local state" },
    { pattern: /^\/?\.mcp\.json$/m, label: ".mcp.json local configuration" },
    { pattern: /^\/?\.opencode\/?$/m, label: ".opencode/ local state" },
    { pattern: /^\/?\.atl\/?$/m, label: ".atl/ local state" },
    { pattern: /^\/?opencode-models\*\.db\*$/m, label: "all opencode-models*.db* artifacts" },
  ];
  for (const { pattern, label } of requiredPatterns) {
    assertOk(pattern.test(gitignore), `.gitignore ignores ${label}`);
  }

  // === git check-ignore confirms forbidden paths are ignored ===
  const envPath = path.resolve(".env");
  let createdEnv = false;
  if (!existsSync(envPath)) {
    // create .gitignore-style ignore requires the file to exist for some check-ignore
    // versions, but gitignore pattern alone is sufficient on modern git. Try both.
  }
  const forbiddenPaths = [
    path.resolve(".env"),
    path.resolve("dist"),
    path.resolve("node_modules"),
    path.resolve("opencode-models.db"),
    path.resolve(".planning"),
    path.resolve(".pmc"),
    path.resolve(".mcp.json"),
    path.resolve(".opencode"),
    path.resolve(".atl"),
    path.resolve("opencode-models-smoke.db"),
  ];
  for (const file of forbiddenPaths) {
    try {
      const out = execSync(`git check-ignore --no-index -v "${file}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      assertOk(out.length > 0, `git check-ignore reports ${path.basename(file) || file} is ignored`);
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string };
      assertOk(false, `git check-ignore did NOT ignore ${file} (status=${e.status})`);
    }
  }
  void createdEnv; // placeholder if we later need to clean up

  // === git status --short shows no untracked FORBIDDEN path ===
  const status = execSync("git status --short", { encoding: "utf8" });
  const untrackedPaths = status
    .split("\n")
    .filter((line) => line.startsWith("??"))
    .map((line) => line.substring(3).trim().replace(/^"(.*)"$/, "$1"));
  const forbiddenSubstrings = [
    "dist/",
    "node_modules/",
    ".env",
    ".planning/",
    ".pmc/",
    ".mcp.json",
    ".opencode/",
    ".atl/",
    "opencode-models",
  ];
  const forbiddenHits = untrackedPaths.filter((p) => forbiddenSubstrings.some((sub) => p.includes(sub)));
  assertOk(
    forbiddenHits.length === 0,
    `git status shows no untracked forbidden paths (forbidden hits: ${JSON.stringify(forbiddenHits)})`,
  );

  // === git status --ignored lists dist/, node_modules/, opencode-models.db* ===
  const statusIgnored = execSync("git status --short --ignored", { encoding: "utf8" });
  const ignoredHits = statusIgnored.split("\n").filter((line) => line.startsWith("!!")).map((line) => line.substring(3).trim());
  assertOk(ignoredHits.some((p) => p === "dist" || p.startsWith("dist/")), "dist/ is listed under ignored paths");
  assertOk(ignoredHits.some((p) => p === "node_modules" || p.startsWith("node_modules/")), "node_modules/ is listed under ignored paths");
  assertOk(ignoredHits.some((p) => p.startsWith("opencode-models.db")), "opencode-models.db* is listed under ignored paths");

  // === .atl hygiene (PR4) — .atl MUST be ignored and NOT tracked.
  const atlDir = path.resolve(".atl");
  assertOk(existsSync(atlDir) && statSync(atlDir).isDirectory(), `.atl/ exists locally at ${atlDir}`);
  // `git ls-files --error-unmatch` exits non-zero when the path is not tracked,
  // which is the GREEN state we want. Catch the non-zero exit and treat it
  // as success.
  let gitLsFilesAtl = "";
  try {
    gitLsFilesAtl = execSync("git ls-files --error-unmatch .atl", { encoding: "utf8" }).trim();
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const msg = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    if (e.status === 1 && /did not match any file/.test(msg)) {
      gitLsFilesAtl = "";
    } else {
      throw err;
    }
  }
  assertOk(
    gitLsFilesAtl.length === 0,
    `.atl MUST NOT appear in the Git index (got: ${JSON.stringify(gitLsFilesAtl)})`,
  );
  const gitCheckIgnoreAtl = execSync("git check-ignore -v .atl", { encoding: "utf8" }).trim();
  assertOk(
    gitCheckIgnoreAtl.length > 0,
    `.atl MUST be matched by a .gitignore rule (got: ${JSON.stringify(gitCheckIgnoreAtl)})`,
  );
  // Local files MUST remain on disk after the PR4 index-only untrack.
  assertOk(existsSync(atlDir), ".atl/ directory still present on disk after index-only untrack");

  // === Package contents MUST remain dist-only / local-state-free. ===
  const packageJsonRaw = readFileSync(path.resolve("package.json"), "utf8");
  const packageJson = JSON.parse(packageJsonRaw) as {
    files?: string[];
    name?: string;
    version?: string;
  };
  assertOk(
    Array.isArray(packageJson.files) &&
      packageJson.files.every((entry) => entry === "dist/" || entry === "dist"),
    `package.json "files" allowlist MUST be dist-only (got: ${JSON.stringify(packageJson.files)})`,
  );

  console.log("\n=== INTEGRATION RELEASE SAFETY SUMMARY ===");
  if (failures.length === 0) {
    console.log("All release-safety assertions passed.");
    process.exit(0);
  } else {
    console.error(failures.length + " assertion(s) failed.");
    process.exit(1);
  }
}

run();
