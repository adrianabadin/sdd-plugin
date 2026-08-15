/**
 * Aggregate runner for the durable-persistence suite.
 *
 * `a && b && c` stops at the first failure, which hides how many gates are
 * actually broken and lets later files silently never run. This runner executes
 * EVERY file, accumulates results, and prints an explicit reached/passed/failed
 * summary so a green claim cannot be made while a file was skipped.
 *
 * Bun-gated files are run via scripts/run-bun-tests.mjs so they execute
 * regardless of npm-path availability; if Bun is missing, the runner exits
 * non-zero and the file is reported as blocked-with-reason, never silently
 * passed.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Files that need `dist/` to exist are marked so the runner can explain skips.
 *
 * `runner: "node"` (default) runs under tsx on the current Node binary.
 * `runner: "bun"` runs through the portable Bun runner, which exits non-zero
 * if Bun is missing; the runner itself produces a "blocked" record rather
 * than silently skipping the file.
 */
const SUITE = [
  { file: "tests/runtime-database-path.test.ts" },
  { file: "tests/c1-legacy-discovery.test.ts" },
  { file: "tests/c3-schema-readiness.test.ts" },
  { file: "tests/schema-ddl-drift.test.ts" },
  { file: "tests/c4-verifier-required.test.ts" },
  { file: "tests/c6-prisma-cleanup.test.ts" },
  { file: "tests/quarantine-reconcile.test.ts" },
  { file: "tests/c6-bootstrap-cleanup.test.ts" },
  { file: "tests/c9-ctrls-buffer.test.ts" },
  { file: "tests/prisma-dependency-versions.test.ts" },
  { file: "tests/error-normalization.test.ts" },
  { file: "tests/all-benchmarks-contract.test.ts" },
  { file: "tests/prisma-write-adapter.test.ts" },
  { file: "tests/read-after-write-verification.test.ts" },
  { file: "tests/use-case-save-model-detail.test.ts" },
  { file: "tests/full-contract-readback.test.ts" },
  { file: "tests/concurrent-initialization.test.ts" },
  { file: "tests/schema-structural-compat.test.ts" },
  { file: "tests/per-connection-pragmas.test.ts" },
  { file: "tests/awaitable-cleanup.test.ts" },
  { file: "tests/pragma-and-null-semantics.test.ts" },
  { file: "tests/runtime-additive-migration.test.ts" },
  { file: "tests/persistence-unavailable-state.test.ts", runner: "bun" },
  { file: "tests/bun-readiness.test.ts", runner: "bun" },
  { file: "tests/bun-plugin-entry.test.ts", runner: "bun", needsDist: true },
  { file: "tests/built-tui-persistence.test.ts", needsDist: true },
  { file: "tests/dist-firstrun-probe.test.ts", needsDist: true },
  { file: "tests/c9-ctrls-save.bun.test.ts", runner: "bun" },
  { file: "tests/rapid-pricing-saves.test.ts" },
{ file: "tests/sqlite-contention.test.ts" },
  { file: "tests/sqlite-mcp-tool-client-occ.test.ts" },
  { file: "tests/sdd-change-state.test.ts" },
  { file: "tests/sdd-skill-registry.test.ts" },
  { file: "tests/sdd-tools.integration.test.ts" },
  { file: "tests/persistence-guard.test.ts" },
];

const distTui = path.resolve("dist", "tui.js");
const distExists = fs.existsSync(distTui);
const bunRunner = path.resolve("scripts", "run-bun-tests.mjs");
const bunRunnerExists = fs.existsSync(bunRunner);

const results = [];

function runBunEntry(file) {
  if (!bunRunnerExists) {
    console.error(`\n### BLOCKED: ${file} (requires ${bunRunner} - Bun runner not present)`);
    results.push({ file, status: "blocked" });
    return;
  }
  console.log(`\n### RUN (bun): ${file}`);
  const run = spawnSync(process.execPath, [bunRunner, file], {
    stdio: "inherit",
  });
  results.push({ file, status: run.status === 0 ? "passed" : "failed" });
}

for (const entry of SUITE) {
  const { file, needsDist, runner = "node" } = entry;

  if (!fs.existsSync(path.resolve(file))) {
    results.push({ file, status: "missing" });
    console.error(`\n### MISSING: ${file}`);
    continue;
  }

  if (needsDist && !distExists) {
    results.push({ file, status: "blocked" });
    console.error(`\n### BLOCKED: ${file} (requires dist/tui.js — run "npm run build" first)`);
    continue;
  }

  if (runner === "bun") {
    runBunEntry(file);
    continue;
  }

  console.log(`\n### RUN: ${file}`);
  const run = spawnSync(process.execPath, ["--import", "tsx", path.resolve(file)], {
    stdio: "inherit",
  });
  results.push({ file, status: run.status === 0 ? "passed" : "failed" });
}

const passed = results.filter((r) => r.status === "passed");
const blocked = results.filter((r) => r.status === "blocked");
const failed = results.filter((r) => r.status !== "passed" && r.status !== "blocked");

console.log("\n=== PERSISTENCE SUITE SUMMARY ===");
console.log(`files declared: ${SUITE.length}`);
console.log(`files reached:  ${results.length}`);
console.log(`passed:         ${passed.length}`);
console.log(`blocked:        ${blocked.length}`);
console.log(`failed:         ${failed.length}`);
for (const result of results) {
  console.log(`  [${result.status.toUpperCase()}] ${result.file}`);
}

if (failed.length > 0 || blocked.length > 0) {
  console.error(`\n${failed.length + blocked.length} persistence gate(s) did not pass cleanly.`);
  process.exit(1);
}

console.log("\nAll persistence gates passed.");
