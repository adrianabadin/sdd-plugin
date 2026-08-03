/**
 * WU3 — RT-1..RT-10, RT-15, RT-16: the Dependency Graph derivation (design §4,
 * spec capability `sdd-routing`).
 *
 * The graph is linear with one fork-then-join at `tasks`:
 *   explore -> propose -> spec || design -> tasks -> apply -> verify -> archive
 * `spec` and `design` are both unblocked by `proposal` alone (parallel,
 * neither depends on the other). `tasks` requires BOTH (a fan-in AND).
 *
 * This is the real source of each `dependencies` row's VALUE. The earlier
 * `buildDependencyRowsPlaceholder` in compute-status.ts no longer exists —
 * `sdd-status-schema.test.ts` (SS-4) was repointed to assert the row SET
 * against this function directly, so a dropped row here fails SS-4 for real
 * instead of against a stub that could silently drift from production.
 */

import type {
  ApplyProgressState,
  ArtifactState,
  Dependencies,
  DependencyState,
  PhaseDependencyKey,
} from "../../domain/sdd/status.js";
import { PHASE_DEPENDENCY_KEYS } from "../../domain/sdd/status.js";

export interface ComputeDependenciesInput {
  explore: ArtifactState;
  proposal: ArtifactState;
  spec: ArtifactState;
  design: ArtifactState;
  tasks: ArtifactState;
  applyProgress: ApplyProgressState;
  verifyReport: ArtifactState;
  archiveReport: ArtifactState;
  /**
   * RT-15: whether `verifyReport` carries an unresolved CRITICAL finding.
   * WU3 scope note: the actual verify-report shape/parsing (severity levels,
   * resolution markers) is owned by whichever future work unit produces that
   * artifact — not yet designed. This boolean is the minimal contract WU3
   * needs to gate archive; the caller is responsible for deriving it.
   */
  verifyReportHasUnresolvedCritical: boolean;
}

/** A phase's row: `all_done` if its own artifact exists, else `ready`/`blocked` by whether its gate is open. */
function deriveGate(gateOpen: boolean, ownArtifact: ArtifactState): DependencyState {
  if (ownArtifact === "done") return "all_done";
  return gateOpen ? "ready" : "blocked";
}

/**
 * RT-1..RT-10, RT-15, RT-16.
 *
 * Deliberately takes exactly one argument: there is no second "override"
 * parameter, config flag, or optional escape hatch anywhere in this
 * signature. RT-15 requires that the archive gate has NO override — the
 * absence of a second parameter is the enforcement mechanism, not a comment
 * promising callers will behave.
 */
export function computeDependencies(input: ComputeDependenciesInput): Dependencies {
  const rows = {} as Record<PhaseDependencyKey, DependencyState>;
  for (const key of PHASE_DEPENDENCY_KEYS) {
    rows[key] = "blocked";
  }
  // RT-1/RT-2: explore has no upstream artifact dependency (entry phase).
  rows.explore = deriveGate(true, input.explore);
  // RT-3/RT-4: propose unblocks once explore is done.
  rows.propose = deriveGate(input.explore === "done", input.proposal);
  // RT-5/RT-6/RT-7: spec and design are parallel, both unblocked by proposal alone.
  rows.spec = deriveGate(input.proposal === "done", input.spec);
  rows.design = deriveGate(input.proposal === "done", input.design);
  // RT-8: tasks is a fan-in AND — both spec and design must be done, not either.
  rows.tasks = deriveGate(input.spec === "done" && input.design === "done", input.tasks);
  // RT-9: apply unblocks once tasks is done. Its own "artifact" is applyProgress
  // (three-state), so all_done tracks applyProgress === "done", not a fourth artifact.
  rows.apply = deriveGate(input.tasks === "done", input.applyProgress === "done" ? "done" : "missing");
  // RT-10: verify unblocks only once applyProgress is fully done (not partial, not missing).
  rows.verify = deriveGate(input.applyProgress === "done", input.verifyReport);
  // RT-14/RT-15/RT-16: the archive gate has no override. Readiness requires the
  // full cycle done, apply's checkpoints covering allIds (applyProgress "done"),
  // verify done, and no unresolved CRITICAL in the verify report.
  const archiveReady =
    input.explore === "done" &&
    input.proposal === "done" &&
    input.spec === "done" &&
    input.design === "done" &&
    input.tasks === "done" &&
    input.applyProgress === "done" &&
    input.verifyReport === "done" &&
    !input.verifyReportHasUnresolvedCritical;
  rows.archive = deriveGate(archiveReady, input.archiveReport);
  return rows;
}
