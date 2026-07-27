#!/usr/bin/env node
/**
 * Release-safety gate for tracked, staged, and untracked local artifacts.
 *
 * Exit codes:
 *   0 — no forbidden path can enter the package baseline
 *   1 — a forbidden path is already tracked, staged, or unignored
 */
import { execSync } from "node:child_process";

const FORBIDDEN_PATTERNS = [
  { pattern: /^\.env(?:$|\.)/i, label: ".env files" },
  { pattern: /^node_modules(?:\/|$)/i, label: "node_modules/" },
  { pattern: /^dist(?:\/|$)/i, label: "dist/ build output" },
  { pattern: /^\.planning(?:\/|$)/i, label: ".planning/ local state" },
  { pattern: /^\.pmc(?:\/|$)/i, label: ".pmc/ local state" },
  { pattern: /^\.mcp\.json$/i, label: ".mcp.json local configuration" },
  { pattern: /^\.opencode(?:\/|$)/i, label: ".opencode/ local state" },
  { pattern: /^\.atl(?:\/|$)/i, label: ".atl/ local state" },
  { pattern: /^opencode-models.*\.db(?:$|[-.])/i, label: "opencode-models*.db* artifacts" },
  { pattern: /^src\/generated\/prisma(?:\/|$)/i, label: "src/generated/prisma" },
  { pattern: /\.tsbuildinfo$/i, label: "*.tsbuildinfo" },
];

function git(command) {
  return execSync(command, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function splitNull(output) {
  return output.split("\0").filter(Boolean);
}

function isForbidden(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
  return FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(normalized));
}

function printEvidence({ tracked, staged, untracked }) {
  console.log(`  - Tracked paths scanned: ${tracked.length}`);
  console.log(`  - Staged additions/changes scanned: ${staged.length}`);
  console.log(`  - Untracked, unignored paths scanned: ${untracked.length}`);
  console.log(`  - Forbidden patterns enforced: ${FORBIDDEN_PATTERNS.length}`);
}

console.log("\n--- Release Safety Verification ---\n");

let trackedPaths;
let stagedPaths;
let untrackedPaths;
try {
  trackedPaths = splitNull(git("git ls-files -z"));
  stagedPaths = splitNull(git("git diff --cached --name-only --diff-filter=ACMR -z"));
  untrackedPaths = splitNull(git("git ls-files --others --exclude-standard -z"));
} catch (error) {
  console.error("Release-safety verification could not inspect the git index.");
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const failures = [];
for (const relativePath of trackedPaths) {
  if (isForbidden(relativePath)) failures.push(`TRACKED FORBIDDEN: ${relativePath}`);
}
for (const relativePath of stagedPaths) {
  if (isForbidden(relativePath)) failures.push(`STAGED FORBIDDEN: ${relativePath}`);
}
for (const relativePath of untrackedPaths) {
  if (isForbidden(relativePath)) failures.push(`UNTRACKED FORBIDDEN (NOT IGNORED): ${relativePath}`);
}

printEvidence({ tracked: trackedPaths, staged: stagedPaths, untracked: untrackedPaths });

if (failures.length === 0) {
  console.log("All release-safety checks passed.\n");
  process.exit(0);
}

console.error("Release-safety failures detected:");
for (const failure of failures) {
  console.error(`  - ${failure}`);
}
console.error("\nIgnore new local paths and remove already tracked local state from the index before release.");
process.exit(1);
