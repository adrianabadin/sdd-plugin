/**
 * WU8 — WF-1 through WF-9: Worktree fingerprint domain primitives.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-worktree-fingerprint`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§7.1, §7.2).
 */

/**
 * Declared per-phase mutating table (design §7.2, WF-8, WF-9).
 * Deterministic: no LLM judgment about whether a phase is mutating.
 */
export const PHASE_MUTATING_TABLE: Record<string, boolean> = {
  "sdd-init": false,
  "sdd-explore": false,
  "sdd-propose": false,
  "sdd-spec": false,
  "sdd-design": false,
  "sdd-tasks": false,
  "sdd-apply": true,
  "sdd-verify": true,
  "sdd-archive": false,
};

export function isPhaseMutating(phase: string): boolean {
  return PHASE_MUTATING_TABLE[phase] ?? false;
}

export interface FileWalkEntry {
  readonly size: number;
  readonly mtimeMs: number;
}

export interface WorktreeFingerprint {
  readonly isGit: boolean;
  readonly headSha?: string | null;
  readonly porcelainStatus?: string;
  readonly fileWalk?: Record<string, FileWalkEntry>;
  /**
   * True when the git probe itself failed (e.g. `git status` threw) and the
   * `porcelainStatus` is therefore NOT a trustworthy "clean tree" signal —
   * it is the empty default of a failed capture. The comparison must treat
   * a probe failure as "could not verify" rather than "nothing changed", so
   * a silent git failure in a NON-mutating phase cannot degrade the guard
   * into a no-op (the earlier code read `porcelainStatus: ""` as "clean").
   */
  readonly gitProbeFailed?: boolean;
}

export interface FingerprintComparisonResult {
  readonly unexpectedWrites?: boolean;
}

/**
 * Compare compose-time baseline fingerprint with save-time current fingerprint (WF-1 to WF-7).
 * If mutating is true, returns empty result (unexpectedWrites absent, WF-6).
 * If mutating is false, detects HEAD sha changes (WF-4), porcelain status changes (WF-1..WF-3, WF-5),
 * or fileWalk changes in non-git projects (WF-7).
 */
export function compareWorktreeFingerprints(
  baseline: WorktreeFingerprint,
  current: WorktreeFingerprint,
  mutating: boolean,
): FingerprintComparisonResult {
  // WF-6: A mutating phase's changes are expected, not reported
  if (mutating) {
    return {};
  }

  if (baseline.isGit && current.isGit) {
    // If either side's git probe failed, porcelainStatus is an empty default,
    // not a "clean tree" reading. Treat that as an unexpected write: a
    // non-mutating phase that could not measure its tree cannot be cleared.
    // (The earlier comparison read a failed `porcelainStatus: ""` as "clean",
    // silently degrading the guard when git misbehaved.)
    if (baseline.gitProbeFailed || current.gitProbeFailed) {
      return { unexpectedWrites: true };
    }

    // WF-4: A commit made during the phase is detected via HEAD sha
    const headChanged = baseline.headSha !== current.headSha;

    // WF-1, WF-2, WF-3, WF-5: Porcelain status diff against baseline
    const statusChanged = baseline.porcelainStatus !== current.porcelainStatus;

    if (headChanged || statusChanged) {
      return { unexpectedWrites: true };
    }
    return {};
  }

  // WF-7: A non-git project falls back to a (relpath, size, mtime) walk
  if (!baseline.isGit && !current.isGit) {
    const baseWalk = baseline.fileWalk ?? {};
    const currWalk = current.fileWalk ?? {};

    const baseKeys = Object.keys(baseWalk).sort();
    const currKeys = Object.keys(currWalk).sort();

    if (baseKeys.length !== currKeys.length) {
      return { unexpectedWrites: true };
    }

    for (const key of baseKeys) {
      const baseFile = baseWalk[key];
      const currFile = currWalk[key];

      if (!currFile || !baseFile) {
        return { unexpectedWrites: true };
      }

      if (baseFile.size !== currFile.size || baseFile.mtimeMs !== currFile.mtimeMs) {
        return { unexpectedWrites: true };
      }
    }

    return {};
  }

  // If git status changed between git vs non-git
  return { unexpectedWrites: true };
}
