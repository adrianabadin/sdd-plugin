/**
 * WU8 — WF-1 through WF-9: Worktree fingerprint application primitives.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-worktree-fingerprint`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§7.1, §7.2).
 */

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { FileWalkEntry, WorktreeFingerprint } from "../../domain/sdd/worktree-fingerprint.js";

export interface CaptureFingerprintOptions {
  /** Optional custom command runner for testing git execution */
  readonly execFn?: (cmd: string, cwd: string) => string;
}

function defaultExecFn(cmd: string, cwd: string): string {
  return childProcess.execSync(cmd, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Capture a worktree fingerprint for a given projectRoot directory (WF-1..WF-7).
 * Uses git status --porcelain=v1 -uall if git repo, otherwise falls back to fileWalk.
 */
export async function captureWorktreeFingerprint(
  projectRoot: string,
  options?: CaptureFingerprintOptions,
): Promise<WorktreeFingerprint> {
  const exec = options?.execFn ?? defaultExecFn;

  try {
    const isGitOut = exec("git rev-parse --is-inside-work-tree", projectRoot).trim();
    if (isGitOut === "true") {
      let headSha: string | null = null;
      try {
        headSha = exec("git rev-parse HEAD", projectRoot).trim();
      } catch {
        headSha = null;
      }

      let porcelainStatus = "";
      let gitProbeFailed = false;
      try {
        porcelainStatus = exec("git status --porcelain=v1 -uall", projectRoot).trim();
      } catch {
        // git status failed — porcelainStatus stays "" but that is NOT a
        // "clean tree" reading. Mark the probe as failed so the comparison
        // treats this as unverifiable instead of silently clean.
        porcelainStatus = "";
        gitProbeFailed = true;
      }

      return {
        isGit: true,
        headSha,
        porcelainStatus,
        gitProbeFailed,
      };
    }
  } catch {
    // Non-git directory or git command unavailable
  }

  // Non-git fallback: filesystem walk (WF-7)
  const fileWalk: Record<string, FileWalkEntry> = {};

  function walk(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist") {
        continue;
      }
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(fullPath);
          const relPath = path.relative(projectRoot, fullPath).replace(/\\/g, "/");
          fileWalk[relPath] = {
            size: stat.size,
            mtimeMs: Math.floor(stat.mtimeMs),
          };
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  if (fs.existsSync(projectRoot)) {
    walk(projectRoot);
  }

  return {
    isGit: false,
    fileWalk,
  };
}
