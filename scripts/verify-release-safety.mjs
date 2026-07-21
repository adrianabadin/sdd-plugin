#!/usr/bin/env node
/**
 * scripts/verify-release-safety.mjs
 *
 * Task 7 release-safety gate for CI.
 *
 * Verifies that the current git working tree does NOT accidentally stage
 * forbidden artifacts (env files, production databases, build outputs,
 * dependencies, generated client). This script is a defense-in-depth check
 * that complements `.gitignore` and the integration test suite.
 *
 * Exit codes:
 *   0  — clean tree, no forbidden staged or untracked artifacts
 *   1  — one or more forbidden paths were found (fail CI)
 *
 * Usage:
 *   node scripts/verify-release-safety.mjs
 *   npm run verify:release-safety
 */
import { execSync } from "node:child_process";

const FORBIDDEN_PATTERNS = [
  { pattern: /^\/?\.env(\s|$|\.)/i, label: ".env files" },
  { pattern: /^node_modules\/?$/i, label: "node_modules/" },
  { pattern: /^dist\/?$/i, label: "dist/ build output" },
  { pattern: /^\/?opencode-models\.db(\s|$|-)/i, label: "opencode-models.db production" },
  { pattern: /^opencode-models\.test.*\.db/i, label: "opencode-models.test-*.db test DBs" },
  { pattern: /\/?src\/generated\/prisma/i, label: "src/generated/prisma" },
  { pattern: /\*\.tsbuildinfo/i, label: "*.tsbuildinfo" },
];

function git(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (err) {
    return "";
  }
}

function isIgnored(path) {
  try {
    execSync(`git check-ignore -v "${path}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return true;
  } catch {
    return false;
  }
}

function listPaths() {
  const status = git("git status --short --untracked-files=all");
  return status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      // Format: "XY <path>" where XY is the status code (2 chars)
      const trimmed = line.trim();
      const code = trimmed.substring(0, 2);
      const path = trimmed.substring(3).trim();
      // Strip surrounding quotes git may add
      return { code, path: path.replace(/^"(.*)"$/, "$1") };
    });
}

function isForbidden(relativePath) {
  return FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(relativePath));
}

console.log("\n--- Release Safety Verification ---\n");

const tracked = listPaths();
const failures = [];

const stagedChanges = tracked.filter(({ code }) => /^[AMDR]/.test(code));
const stagedAdditions = stagedChanges.filter(({ code }) => /^A/.test(code) || code.includes("M"));

for (const { code, path } of stagedAdditions) {
  if (isForbidden(path)) {
    failures.push(`STAGED FORBIDDEN: ${code} ${path}`);
  }
}

const untracked = tracked.filter(({ code }) => code === "??");
const untrackedForbidden = untracked.filter(({ path }) => isForbidden(path));
for (const { path } of untrackedForbidden) {
  if (!isIgnored(path)) {
    failures.push(`UNTRACKED FORBIDDEN (NOT IGNORED): ${path}`);
  }
}

if (failures.length === 0) {
  console.log("All release-safety checks passed.");
  console.log(`  - Staged changes scanned: ${stagedAdditions.length}`);
  console.log(`  - Untracked paths scanned: ${untracked.length}`);
  console.log(`  - Forbidden patterns enforced: ${FORBIDDEN_PATTERNS.length}`);
  console.log("");
  process.exit(0);
} else {
  console.error("Release-safety failures detected:");
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  console.error("");
  console.error("Move these paths into .gitignore or remove them before committing.");
  process.exit(1);
}