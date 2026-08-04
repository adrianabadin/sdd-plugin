/**
 * WU8 — WF-1 through WF-9: Worktree fingerprint unit tests.
 * Specs from docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md (`sdd-worktree-fingerprint`).
 * Design from docs/superpowers/specs/2026-08-01-sdd-phase-agents-design.md (§7.1, §7.2).
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  PHASE_MUTATING_TABLE,
  isPhaseMutating,
  compareWorktreeFingerprints,
  type WorktreeFingerprint,
} from "../src/domain/sdd/worktree-fingerprint.js";
import { captureWorktreeFingerprint } from "../src/application/sdd/worktree-fingerprint.js";
import { composePhasePrompt } from "../src/application/sdd/prompt-composition.js";
import { saveArtifact } from "../src/application/sdd/save-artifact.js";
import type { CheckpointRecord, CheckpointWriteResult, SddArtifactStorePort } from "../src/ports/sdd-artifact-store.port.js";

function createMockStore(): SddArtifactStorePort & { storage: Map<string, string> } {
  const storage = new Map<string, string>();
  return {
    storage,
    async writeArtifact(key: string, content: string): Promise<void> {
      storage.set(key, content);
    },
    async readArtifact(key: string): Promise<string | null> {
      return storage.get(key) ?? null;
    },
    async writeCheckpoint(_key: string, _content: unknown): Promise<CheckpointWriteResult> {
      return { version: 1 };
    },
    async readCheckpoint(_key: string): Promise<CheckpointRecord | null> {
      return null;
    },
    /** Final-review finding #3 — stub for the atomic persist seam. */
    async persistArtifactWithOwnership(): Promise<never> {
      throw new Error("FakeStore.persistArtifactWithOwnership is not exercised by these tests");
    },
  };
}

async function runTests(): Promise<void> {
  console.log("--- sdd-worktree-fingerprint (WU8 tasks WF-1 to WF-9) ---");

  // WF-1: An unchanged tree yields no unexpectedWrites
  {
    const baseline: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "",
    };
    const current: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "",
    };

    const res = compareWorktreeFingerprints(baseline, current, false);
    assert.equal("unexpectedWrites" in res, false, "WF-1: unexpectedWrites is absent on unchanged tree");
  }
  console.log("  pass: WF-1 unchanged tree yields no unexpectedWrites");

  // WF-2: A non-mutating phase that modified a tracked file is reported
  {
    const baseline: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "",
    };
    const current: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: " M src/index.ts\n",
    };

    const res = compareWorktreeFingerprints(baseline, current, false);
    assert.equal(res.unexpectedWrites, true, "WF-2: unexpectedWrites reported when tracked file modified");
  }
  console.log("  pass: WF-2 non-mutating phase modified tracked file reported");

  // WF-3: A newly created untracked file is detected (--porcelain=v1 -uall)
  {
    const baseline: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "",
    };
    const current: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "?? newfile.ts\n",
    };

    const res = compareWorktreeFingerprints(baseline, current, false);
    assert.equal(res.unexpectedWrites, true, "WF-3: untracked file detected via porcelain status");
  }
  console.log("  pass: WF-3 newly created untracked file detected");

  // WF-4: A commit made during the phase is detected via HEAD sha
  {
    const baseline: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "",
    };
    const current: WorktreeFingerprint = {
      isGit: true,
      headSha: "def5678",
      porcelainStatus: "",
    };

    const res = compareWorktreeFingerprints(baseline, current, false);
    assert.equal(res.unexpectedWrites, true, "WF-4: commit detected via HEAD sha change");
  }
  console.log("  pass: WF-4 commit made during phase detected via HEAD sha");

  // WF-5: A dirty baseline yields no false positive (delta against compose-time snapshot)
  {
    const baseline: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: " M existing-dirty-file.ts\n",
    };
    const current: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: " M existing-dirty-file.ts\n",
    };

    const res = compareWorktreeFingerprints(baseline, current, false);
    assert.equal("unexpectedWrites" in res, false, "WF-5: unexpectedWrites absent when dirty state unchanged");
  }
  console.log("  pass: WF-5 dirty baseline yields no false positive");

  // WF-6: A mutating phase's changes are not reported
  {
    const baseline: WorktreeFingerprint = {
      isGit: true,
      headSha: "abc1234",
      porcelainStatus: "",
    };
    const current: WorktreeFingerprint = {
      isGit: true,
      headSha: "def5678",
      porcelainStatus: " M src/index.ts\n?? newfile.ts\n",
    };

    const res = compareWorktreeFingerprints(baseline, current, true);
    assert.equal("unexpectedWrites" in res, false, "WF-6: unexpectedWrites absent for mutating phase");
  }
  console.log("  pass: WF-6 mutating phase changes not reported");

  // WF-7: A non-git project falls back to a (relpath, size, mtime_ns) walk and still functions
  {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdd-non-git-test-"));
    try {
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "hello");
      const fp1 = await captureWorktreeFingerprint(tempDir);
      assert.equal(fp1.isGit, false, "WF-7: non-git repo detected as isGit=false");
      assert.ok(fp1.fileWalk, "WF-7: fileWalk populated");
      assert.ok("file1.txt" in fp1.fileWalk, "WF-7: file1.txt in fileWalk");

      // File modified
      fs.writeFileSync(path.join(tempDir, "file1.txt"), "hello world modification");
      const fp2 = await captureWorktreeFingerprint(tempDir);

      const res = compareWorktreeFingerprints(fp1, fp2, false);
      assert.equal(res.unexpectedWrites, true, "WF-7: non-git file change detected via fileWalk");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
  console.log("  pass: WF-7 non-git project falls back to filesystem walk");

  // WF-gitProbeFailed (silent-degrade remediation): when `git status` itself
  // throws, the fingerprint must NOT read as a clean tree. The earlier code
  // caught the failure and left `porcelainStatus: ""`, which the comparison
  // treated as "nothing changed" — silently disabling the guard in a
  // non-mutating phase. Now the fingerprint carries `gitProbeFailed: true`
  // and the comparison treats that as an unexpected write.
  {
    const failingExec = (_cmd: string, _cwd: string): string => {
      throw new Error("git status failed (not a git repo / git unavailable)");
    };
    // First call (rev-parse --is-inside-work-tree) must return "true" so we
    // reach the porcelain branch; a single execFn that succeeds once then
    // fails reproduces the scenario.
    let callCount = 0;
    const mixedExec = (cmd: string, cwd: string): string => {
      callCount++;
      if (cmd.startsWith("git rev-parse --is-inside-work-tree")) return "true\n";
      if (cmd.startsWith("git rev-parse HEAD")) return "abc123\n";
      // git status --porcelain fails
      return failingExec(cmd, cwd);
    };
    const fp = await captureWorktreeFingerprint("/repo", { execFn: mixedExec });
    assert.equal(fp.isGit, true, "WF-gitProbeFailed fingerprint is still git (rev-parse succeeded)");
    assert.equal(fp.gitProbeFailed, true, "WF-gitProbeFailed fingerprint marks the probe as failed");
    assert.equal(fp.porcelainStatus, "", "WF-gitProbeFailed porcelainStatus is the empty default, not a clean reading");

    // The comparison must treat a probe failure as an unexpected write in a
    // non-mutating phase, NOT as a clean tree.
    const baseline: WorktreeFingerprint = { isGit: true, headSha: "abc123", porcelainStatus: "" };
    const res = compareWorktreeFingerprints(baseline, fp, false);
    assert.equal(res.unexpectedWrites, true, "WF-gitProbeFailed a failed probe is reported, not silently clean");
  }
  console.log("  pass: WF-gitProbeFailed a failed git probe is marked and reported, not read as clean");

  // WF-8: mutating comes from the declared per-phase table
  {
    const expectedTable: Record<string, boolean> = {
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

    for (const [phase, expectedMutating] of Object.entries(expectedTable)) {
      assert.equal(
        isPhaseMutating(phase),
        expectedMutating,
        `WF-8: isPhaseMutating("${phase}") should be ${expectedMutating}`,
      );
      assert.equal(
        PHASE_MUTATING_TABLE[phase],
        expectedMutating,
        `WF-8: PHASE_MUTATING_TABLE["${phase}"] should be ${expectedMutating}`,
      );
    }

    // Verify composePhasePrompt returns mutating from table. A skillResolver is
    // injected so the apply phase's mapped skills resolve (the default resolver
    // returns null and would throw UnresolvableSkillError — which is the
    // correct production behavior, but this test is about the mutating flag).
    const resultInit = composePhasePrompt({ phase: "sdd-init", modelReference: "m1", skillResolver: () => "/skills/x" });
    assert.equal(resultInit.mutating, false, "WF-8: composePhasePrompt returns mutating: false for sdd-init");

    const resultApply = composePhasePrompt({ phase: "sdd-apply", modelReference: "m1", skillResolver: () => "/skills/x" });
    assert.equal(resultApply.mutating, true, "WF-8: composePhasePrompt returns mutating: true for sdd-apply");
  }
  console.log("  pass: WF-8 mutating comes from declared per-phase table");

  // WF-9: sdd-verify is mutating: true
  {
    assert.equal(isPhaseMutating("sdd-verify"), true, "WF-9: sdd-verify is mutating: true");
    const resultVerify = composePhasePrompt({ phase: "sdd-verify", modelReference: "m1", skillResolver: () => "/skills/x" });
    assert.equal(resultVerify.mutating, true, "WF-9: composePhasePrompt returns mutating: true for sdd-verify");
  }
  console.log("  pass: WF-9 sdd-verify is mutating: true");

  // Integration with saveArtifact test
  {
    const store = createMockStore();
    const baseline: WorktreeFingerprint = { isGit: true, headSha: "h1", porcelainStatus: "" };
    const currentDirty: WorktreeFingerprint = { isGit: true, headSha: "h1", porcelainStatus: " M file.ts\n" };

    // Non-mutating phase with dirty current fingerprint -> unexpectedWrites: true
    const resWrite = await saveArtifact(store, "key1", "content1", null, {
      phase: "sdd-spec",
      baselineFingerprint: baseline,
      currentFingerprint: currentDirty,
    });
    assert.equal(resWrite.ok, true);
    assert.equal(resWrite.unexpectedWrites, true, "saveArtifact reports unexpectedWrites for non-mutating phase");

    // Mutating phase with dirty current fingerprint -> unexpectedWrites absent
    const resMutating = await saveArtifact(store, "key2", "content2", null, {
      phase: "sdd-apply",
      baselineFingerprint: baseline,
      currentFingerprint: currentDirty,
    });
    assert.equal(resMutating.ok, true);
    assert.equal("unexpectedWrites" in resMutating, false, "saveArtifact omits unexpectedWrites for mutating phase");
  }
  console.log("  pass: saveArtifact integration with worktree fingerprint");

  console.log("\nAll 10 sdd-worktree-fingerprint (WU8) tests passed successfully!");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
