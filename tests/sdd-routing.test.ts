/**
 * WU3 — RT-1..RT-18: the Dependency Graph derivation (RED-first).
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability
 * `sdd-routing`.
 */

import assert from "node:assert/strict";

import { assembleStatus } from "../src/application/sdd/compute-status.js";
import {
  computeDependencies,
  type ComputeDependenciesInput,
} from "../src/application/sdd/compute-dependencies.js";
import { computeNextRecommended } from "../src/application/sdd/compute-next-recommended.js";
import { PHASE_DEPENDENCY_KEYS, type Checkpoints } from "../src/domain/sdd/status.js";

function baseDeps(overrides: Partial<ComputeDependenciesInput> = {}): ComputeDependenciesInput {
  return {
    explore: "missing",
    proposal: "missing",
    spec: "missing",
    design: "missing",
    tasks: "missing",
    applyProgress: "missing",
    verifyReport: "missing",
    archiveReport: "missing",
    verifyReportHasUnresolvedCritical: false,
    ...overrides,
  };
}

const FULL_CYCLE_DONE: Partial<ComputeDependenciesInput> = {
  explore: "done",
  proposal: "done",
  spec: "done",
  design: "done",
  tasks: "done",
  applyProgress: "done",
  verifyReport: "done",
};

async function runTests(): Promise<void> {
  console.log("--- sdd-routing (RED-first) ---");

  // RT-1: the entry phase is ready when no upstream artifact precedes it.
  {
    const deps = computeDependencies(baseDeps());
    assert.equal(deps.explore, "ready", "RT-1 explore is ready with no upstream artifact");
  }
  console.log("  pass: RT-1 entry phase is ready with no upstream");

  // RT-2: the entry phase becomes all_done once its artifact exists.
  {
    const deps = computeDependencies(baseDeps({ explore: "done" }));
    assert.equal(deps.explore, "all_done", "RT-2 explore is all_done once done");
  }
  console.log("  pass: RT-2 entry phase all_done once its artifact exists");

  // RT-3: propose is blocked until explore is done.
  {
    const deps = computeDependencies(baseDeps());
    assert.equal(deps.propose, "blocked", "RT-3 propose blocked while explore missing");
  }
  console.log("  pass: RT-3 propose blocked until explore done");

  // RT-4: propose is ready once explore is done.
  {
    const deps = computeDependencies(baseDeps({ explore: "done" }));
    assert.equal(deps.propose, "ready", "RT-4 propose ready once explore done");
  }
  console.log("  pass: RT-4 propose ready once explore done");

  // RT-5: spec and design are blocked while proposal is missing.
  {
    const deps = computeDependencies(baseDeps({ explore: "done" }));
    assert.equal(deps.spec, "blocked", "RT-5 spec blocked while proposal missing");
    assert.equal(deps.design, "blocked", "RT-5 design blocked while proposal missing");
  }
  console.log("  pass: RT-5 spec and design blocked while proposal missing");

  // RT-6: spec is ready once proposal is done.
  {
    const deps = computeDependencies(baseDeps({ explore: "done", proposal: "done" }));
    assert.equal(deps.spec, "ready", "RT-6 spec ready once proposal done");
  }
  console.log("  pass: RT-6 spec ready once proposal done");

  // RT-7: a phase whose own artifact exists is all_done.
  {
    const deps = computeDependencies(baseDeps({ explore: "done", proposal: "done", spec: "done" }));
    assert.equal(deps.spec, "all_done", "RT-7 spec all_done once its own artifact exists");
  }
  console.log("  pass: RT-7 phase all_done once its own artifact exists");

  // RT-8: tasks is blocked with only one of spec/design done (AND fan-in).
  {
    const deps = computeDependencies(
      baseDeps({ explore: "done", proposal: "done", spec: "done", design: "missing" }),
    );
    assert.equal(deps.tasks, "blocked", "RT-8 tasks blocked when only spec is done (fan-in AND, not OR)");
  }
  console.log("  pass: RT-8 tasks blocked with only one of spec/design done");

  // RT-9: apply is ready once tasks is done.
  {
    const deps = computeDependencies(
      baseDeps({ explore: "done", proposal: "done", spec: "done", design: "done", tasks: "done" }),
    );
    assert.equal(deps.apply, "ready", "RT-9 apply ready once tasks done, applyProgress missing");
  }
  console.log("  pass: RT-9 apply ready once tasks done");

  // RT-10: verify is blocked while applyProgress is partial.
  {
    const deps = computeDependencies(
      baseDeps({
        explore: "done",
        proposal: "done",
        spec: "done",
        design: "done",
        tasks: "done",
        applyProgress: "partial",
      }),
    );
    assert.equal(deps.verify, "blocked", "RT-10 verify blocked while applyProgress is partial");
  }
  console.log("  pass: RT-10 verify blocked while applyProgress partial");

  // RT-11: nextRecommended picks the earliest ready phase, tiebroken by graph order.
  {
    const deps = computeDependencies(baseDeps({ explore: "done", proposal: "done" }));
    assert.equal(deps.spec, "ready", "RT-11 precondition: spec is ready");
    assert.equal(deps.design, "ready", "RT-11 precondition: design is ready");
    const next = computeNextRecommended({ dependencies: deps, blockedReasons: [] });
    assert.equal(next, "spec", "RT-11 spec precedes design in graph order when both are ready");
  }
  console.log("  pass: RT-11 earliest ready phase wins the tiebreak");

  // RT-12: non-empty blockedReasons routes to resolve-blockers.
  {
    const deps = computeDependencies(baseDeps());
    const next = computeNextRecommended({ dependencies: deps, blockedReasons: ["stuck on s5"] });
    assert.equal(next, "resolve-blockers", "RT-12 non-empty blockedReasons routes to resolve-blockers");
  }
  console.log("  pass: RT-12 blockedReasons outrank phase recommendations");

  // RT-13: an attempt-cap block sets status:blocked and nextRecommended:resolve-blockers
  // together, from the SAME production path (`assembleStatus`) — not two
  // functions fed the same array by hand. `assembleStatus` derives the
  // attempt-cap blockedReasons itself (from checkpoints.attemptCounts) and
  // must feed that same derived array into `computeNextRecommended`, never
  // trust a caller-supplied `nextRecommended` that could disagree with it.
  {
    const emptyCheckpoint = { completedIds: [], attemptCounts: {}, currentBatch: null };
    const checkpoints: Checkpoints = {
      apply: { completedIds: [], attemptCounts: { s5: 3 }, currentBatch: null },
      verify: emptyCheckpoint,
    };
    const status = assembleStatus({
      changeName: "attempt-cap-change",
      projectRoot: "/repo/attempt-cap-change",
      artifactContents: {
        explore: null,
        proposal: null,
        spec: null,
        design: null,
        tasks: null,
        verifyReport: null,
        archiveReport: null,
      },
      allIds: ["s5"],
      checkpoints,
      inFlightPhase: null,
      blockedReasons: [],
    });
    assert.equal(status.status, "blocked", "RT-13 status is blocked");
    assert.equal(
      status.nextRecommended,
      "resolve-blockers",
      "RT-13 nextRecommended is resolve-blockers, derived from the SAME blockedReasons assembleStatus computed for status:blocked",
    );
  }
  console.log("  pass: RT-13 attempt-cap block yields blocked + resolve-blockers together, from assembleStatus itself");

  // RT-14: a completed cycle yields dependencies.archive: ready and nextRecommended: archive.
  {
    const deps = computeDependencies(baseDeps(FULL_CYCLE_DONE));
    assert.equal(deps.archive, "ready", "RT-14 archive ready after a completed cycle");
    const next = computeNextRecommended({ dependencies: deps, blockedReasons: [] });
    assert.equal(next, "archive", "RT-14 nextRecommended is archive after a completed cycle");
  }
  console.log("  pass: RT-14 completed cycle recommends archive");

  // RT-15: an unresolved CRITICAL blocks archive, and there is no override.
  {
    const deps = computeDependencies(baseDeps({ ...FULL_CYCLE_DONE, verifyReportHasUnresolvedCritical: true }));
    assert.equal(deps.archive, "blocked", "RT-15 unresolved CRITICAL blocks archive");
    assert.equal(
      computeDependencies.length,
      1,
      "RT-15 computeDependencies exposes no second (override) argument of any kind",
    );
  }
  console.log("  pass: RT-15 unresolved CRITICAL blocks archive with no override path");

  // RT-15b (C-4): an unresolved CRITICAL, driven THROUGH assembleStatus (the
  // production path the orchestrator reads), must make status/nextRecommended/
  // blockedReasons agree in ONE computation. The earlier implementation
  // forwarded verifyReportHasUnresolvedCritical only to computeDependencies
  // (making archive blocked) but did NOT push a blockedReason — so
  // computeStatusFlag returned "ok", computeNextRecommended returned
  // "resolve-blockers" (nothing ready, nothing all_done), and blockedReasons
  // was empty: a three-way disagreement. The orchestrator routes on
  // nextRecommended exclusively, so "resolve-blockers" with status "ok" and
  // no stated reason is incoherent. assembleStatus must now push a reason.
  {
    const emptyCheckpoint = { completedIds: [], attemptCounts: {}, currentBatch: null };
    const checkpoints: Checkpoints = { apply: emptyCheckpoint, verify: emptyCheckpoint };
    const status = assembleStatus({
      changeName: "critical-finding-change",
      projectRoot: "/repo/critical-finding-change",
      artifactContents: {
        explore: "done",
        proposal: "done",
        spec: "done",
        design: "done",
        tasks: "done",
        verifyReport: "done",
        archiveReport: null,
      },
      allIds: [],
      checkpoints,
      inFlightPhase: null,
      blockedReasons: [],
      verifyReportHasUnresolvedCritical: true,
    });
    assert.equal(status.status, "blocked", "RT-15b status is blocked when a CRITICAL is unresolved");
    assert.equal(
      status.nextRecommended,
      "resolve-blockers",
      "RT-15b nextRecommended is resolve-blockers, derived from the SAME blockedReasons that made status blocked",
    );
    assert.ok(
      status.blockedReasons.length > 0,
      "RT-15b blockedReasons is non-empty — the reason is pushed in the same computation that reads it",
    );
    assert.ok(
      status.blockedReasons.some((r) => /CRITICAL/i.test(r)),
      "RT-15b the pushed reason names the unresolved CRITICAL",
    );
  }
  console.log("  pass: RT-15b an unresolved CRITICAL drives status/nextRecommended/blockedReasons in agreement, from assembleStatus");

  // RT-16: incomplete tasks (completedIds not covering allIds -> applyProgress partial) block archive.
  {
    const deps = computeDependencies(baseDeps({ ...FULL_CYCLE_DONE, applyProgress: "partial" }));
    assert.equal(deps.archive, "blocked", "RT-16 incomplete tasks block archive");
  }
  console.log("  pass: RT-16 incomplete tasks block archive");

  // RT-17: a fully finished cycle (every row all_done, no blockers) recommends
  // `complete`, never a phase name. Recommending a phase (e.g. `archive`) here
  // is an instruction to re-run it forever, since the orchestrator routes on
  // this field exclusively and an already-archived change never stops being
  // `all_done` — this was a real infinite-archive-loop bug.
  {
    const deps = computeDependencies(baseDeps({ ...FULL_CYCLE_DONE, archiveReport: "done" }));
    for (const phase of Object.keys(deps) as Array<keyof typeof deps>) {
      assert.equal(deps[phase], "all_done", `RT-17 precondition: ${phase} is all_done`);
    }
    const next = computeNextRecommended({ dependencies: deps, blockedReasons: [] });
    assert.equal(next, "complete", "RT-17 a finished cycle recommends complete, never a phase name");
    for (const phase of PHASE_DEPENDENCY_KEYS) {
      assert.notEqual(next, phase, `RT-17 nextRecommended is never the phase name '${phase}'`);
    }
  }
  console.log("  pass: RT-17 a fully finished cycle recommends complete, not a phase name");

  // RT-18: nothing ready, nothing blocked, and the cycle is not finished — an
  // internally-inconsistent dependency set. Route to resolve-blockers so a
  // human looks, rather than silently picking a phase for a state that
  // shouldn't be reachable.
  {
    // `computeDependencies` always makes the entry phase (`explore`) either
    // `ready` or `all_done` by construction (RT-1), so it can never itself
    // produce the "nothing ready, nothing all_done" shape RT-18 targets.
    // That shape is still a value `computeNextRecommended` must handle
    // defensively for any caller that hands it an internally-inconsistent
    // `Dependencies` object — every row `blocked` is neither `ready` (RT-11's
    // loop finds nothing) nor an `all_done` full cycle (RT-17).
    const inconsistentDeps = {
      explore: "blocked",
      propose: "blocked",
      spec: "blocked",
      design: "blocked",
      tasks: "blocked",
      apply: "blocked",
      verify: "blocked",
      archive: "blocked",
    } as const;
    const next = computeNextRecommended({ dependencies: inconsistentDeps, blockedReasons: [] });
    assert.equal(
      next,
      "resolve-blockers",
      "RT-18 nothing ready, nothing blocked-with-reason, cycle unfinished -> resolve-blockers",
    );
  }
  console.log("  pass: RT-18 an internally-inconsistent dependency set routes to resolve-blockers");

  console.log("All sdd-routing tests passed.");
}

runTests().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
