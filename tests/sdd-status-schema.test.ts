/**
 * WU2 — SS-1, SS-2, SS-3, SS-4, SS-7: unified status schema (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability
 * `sdd-status-store`.
 */

import assert from "node:assert/strict";

import { PHASE_DEPENDENCY_KEYS } from "../src/domain/sdd/status.js";
import {
  assembleStatus,
  computeApplyProgress,
  computeArtifactState,
  computeStatusFlag,
  type AssembleStatusInput,
} from "../src/application/sdd/compute-status.js";
import { computeDependencies } from "../src/application/sdd/compute-dependencies.js";

function emptyCheckpoints(completedIds: readonly string[] = []) {
  return {
    apply: { completedIds, attemptCounts: {}, currentBatch: null },
    verify: { completedIds: [], attemptCounts: {}, currentBatch: null },
  };
}

function baseInput(overrides: Partial<AssembleStatusInput> = {}): AssembleStatusInput {
  return {
    changeName: "add-widget",
    projectRoot: "/repo/project",
    artifactContents: {
      explore: null,
      proposal: null,
      spec: null,
      design: null,
      tasks: null,
      verifyReport: null,
      archiveReport: null,
    },
    allIds: [],
    checkpoints: emptyCheckpoints(),
    inFlightPhase: null,
    blockedReasons: [],
    ...overrides,
  };
}

async function runTests(): Promise<void> {
  console.log("--- sdd-status-schema (RED-first) ---");

  // SS-1: full shape includes every declared field.
  {
    const result = assembleStatus(baseInput());
    const declaredFields = [
      "changeName",
      "projectRoot",
      "status",
      "artifacts",
      "dependencies",
      "nextRecommended",
      "blockedReasons",
      "allIds",
      "checkpoints",
      "inFlightPhase",
    ];
    for (const field of declaredFields) {
      assert.ok(field in result, `SS-1 full shape includes field '${field}'`);
    }
  }
  console.log("  pass: SS-1 full shape includes every declared field");

  // SS-2: stored artifacts are exactly missing or done, never partial.
  {
    assert.equal(computeArtifactState(null), "missing", "SS-2 no content is missing");
    assert.equal(computeArtifactState("some content"), "done", "SS-2 any content is done");
  }
  console.log("  pass: SS-2 artifacts are two-state, never partial");

  // SS-3: applyProgress computed from checkpoints across all three states.
  {
    assert.equal(computeApplyProgress(["s1", "s2", "s3"], []), "missing", "SS-3 empty completedIds is missing");
    assert.equal(computeApplyProgress(["s1", "s2", "s3"], ["s1", "s2"]), "partial", "SS-3 partial coverage is partial");
    assert.equal(
      computeApplyProgress(["s1", "s2", "s3"], ["s1", "s2", "s3"]),
      "done",
      "SS-3 completedIds superset of allIds is done",
    );
    assert.equal(
      computeApplyProgress(["s1", "s2"], ["s1", "s2", "s3"]),
      "done",
      "SS-3 completedIds strictly a superset (extra id) is still done",
    );
  }
  console.log("  pass: SS-3 applyProgress computed across missing/partial/done");

  // SS-4: dependencies has a row for each of the eight phase-valued recommendations.
  // Asserted against the REAL derivation (WU3's `computeDependencies`), not a
  // placeholder: pointing this at a stub made SS-4 a false green — the real
  // function could drop a row and this test would still pass.
  {
    const dependencies = computeDependencies({
      explore: "missing", proposal: "missing", spec: "missing", design: "missing",
      tasks: "missing", applyProgress: "missing", verifyReport: "missing",
      archiveReport: "missing", verifyReportHasUnresolvedCritical: false,
    });
    const actualKeys = Object.keys(dependencies).sort();
    const expectedKeys = [...PHASE_DEPENDENCY_KEYS].sort();
    assert.deepEqual(actualKeys, expectedKeys, "SS-4 dependencies has exactly the eight phase rows");
  }
  console.log("  pass: SS-4 dependencies has a row for every phase-valued recommendation");

  // SS-7: status is blocked iff blockedReasons is non-empty or blockedOn is present.
  {
    assert.equal(computeStatusFlag([]), "ok", "SS-7 no reasons, no blockedOn -> ok");
    assert.equal(computeStatusFlag(["stuck on s5"]), "blocked", "SS-7 non-empty blockedReasons -> blocked");
    assert.equal(
      computeStatusFlag([], { phase: "propose", question: "which approach?", progressSummary: "explored two options" }),
      "blocked",
      "SS-7 blockedOn present with empty reasons -> blocked",
    );
    assert.equal(
      computeStatusFlag(
        ["stuck on s5"],
        { phase: "propose", question: "which approach?", progressSummary: "explored two options" },
      ),
      "blocked",
      "SS-7 both reasons and blockedOn present -> blocked",
    );
  }
  console.log("  pass: SS-7 status blocked iff blockedReasons non-empty or blockedOn present");

  console.log("All sdd-status-schema tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
