/**
 * Portable Bun test runner.
 *
 * npm scripts do not always inherit the shell PATH that exposes `bun`, so this
 * resolver checks, in order:
 *   1. an explicit BUN_BIN override,
 *   2. `bun` on PATH,
 *   3. the project's node_modules/.bin,
 *   4. the standard per-user Bun install directory (via os.homedir()).
 *
 * No developer-specific absolute path is hardcoded. When Bun cannot be found the
 * runner exits non-zero with an explicit environmental message instead of
 * silently skipping the gate.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isWindows = process.platform === "win32";
const exe = isWindows ? "bun.exe" : "bun";

function works(candidate) {
  if (!candidate) return false;
  const probe = spawnSync(candidate, ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function resolveBun() {
  if (process.env.BUN_BIN && works(process.env.BUN_BIN)) return process.env.BUN_BIN;
  if (works("bun")) return "bun";

  const candidates = [
    path.resolve("node_modules", ".bin", isWindows ? "bun.cmd" : "bun"),
    path.resolve("node_modules", ".bin", exe),
    path.join(os.homedir(), ".bun", "bin", exe),
    "/usr/local/bin/bun",
    "/opt/homebrew/bin/bun",
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && works(candidate)) return candidate;
  }
  return null;
}

const bun = resolveBun();

if (!bun) {
  console.error(
    [
      "ENVIRONMENT WARNING: Bun runtime not found.",
      "The Bun renderer gate could not run. Install Bun (https://bun.sh) or set BUN_BIN",
      "to the Bun executable. This gate is NOT reported as passing.",
    ].join("\n"),
  );
  process.exit(1);
}

const tests = process.argv.slice(2);
if (tests.length === 0) {
  console.error("No Bun test files supplied.");
  process.exit(1);
}

console.log(`Using Bun: ${bun}`);

for (const test of tests) {
  const result = spawnSync(bun, ["--conditions=browser", test], { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
