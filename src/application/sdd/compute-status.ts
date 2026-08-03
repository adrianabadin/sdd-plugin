/**
 * WU2 — SS-1, SS-2, SS-3, SS-4, SS-7: unified status computation for a named
 * change (design §4, spec capability `sdd-status-store`).
 *
 * NOTE (WU2/WU3 remediation — C-2): `dependencies` row VALUES
 * (blocked/ready/all_done) come from WU3's `computeDependencies`, and
 * `nextRecommended` is derived by calling WU3's `computeNextRecommended`
 * directly inside `assembleStatus`, fed the SAME `dependencies` and
 * `blockedReasons` this function already computed. It is deliberately NOT a
 * caller-supplied input: a passthrough let `status: blocked` and
 * `nextRecommended` disagree (an attempt-cap block returning `blocked` while
 * still recommending the very phase that hit the cap), since nothing forced
 * the two to be derived from one shared source in one computation. The
 * dispatch-lock acquire/release for `inFlightPhase` is WU4 — this module only
 * carries the value through. The checkpoint WRITE path is WU9 — this module
 * only reads `checkpoints.apply.completedIds` to derive `applyProgress`.
 */

import {
  type ApplyProgressState,
  type ArtifactState,
  type BlockedOn,
  type Checkpoints,
  type SddStatus,
} from "../../domain/sdd/status.js";
import { computeDependencies } from "./compute-dependencies.js";
import { computeNextRecommended } from "./compute-next-recommended.js";

// SS-2: an artifact blob either exists or it doesn't — no "partial" state.
export function computeArtifactState(content: string | null): ArtifactState {
  return content === null ? "missing" : "done";
}

// SS-3: computed from checkpoints, not asserted. Three states over `allIds` vs
// `checkpoints.apply.completedIds` (design §4: done iff completedIds ⊇ allIds).
export function computeApplyProgress(allIds: readonly string[], completedIds: readonly string[]): ApplyProgressState {
  if (completedIds.length === 0) return "missing";
  const completed = new Set(completedIds);
  const coversAll = allIds.every((id) => completed.has(id));
  return coversAll ? "done" : "partial";
}

// SS-7: blocked iff blockedReasons is non-empty or blockedOn is present, ok otherwise.
export function computeStatusFlag(blockedReasons: readonly string[], blockedOn?: BlockedOn): "ok" | "blocked" {
  return blockedReasons.length > 0 || blockedOn !== undefined ? "blocked" : "ok";
}

export interface AssembleStatusInput {
  changeName: string;
  projectRoot: string;
  artifactContents: {
    explore: string | null;
    proposal: string | null;
    spec: string | null;
    design: string | null;
    tasks: string | null;
    verifyReport: string | null;
    archiveReport: string | null;
  };
  allIds: readonly string[];
  checkpoints: Checkpoints;
  inFlightPhase: string | null;
  blockedReasons: readonly string[];
  blockedOn?: BlockedOn;
  /**
   * RT-15: whether `artifactContents.verifyReport` carries an unresolved
   * CRITICAL finding — see `ComputeDependenciesInput` for why this stays a
   * caller-supplied boolean rather than parsed here. Optional/defaults to
   * `false` so WU2 callers that predate the archive gate keep compiling.
   */
  verifyReportHasUnresolvedCritical?: boolean;
}

export function assembleStatus(input: AssembleStatusInput): SddStatus {
  const artifacts = {
    explore: computeArtifactState(input.artifactContents.explore),
    proposal: computeArtifactState(input.artifactContents.proposal),
    spec: computeArtifactState(input.artifactContents.spec),
    design: computeArtifactState(input.artifactContents.design),
    tasks: computeArtifactState(input.artifactContents.tasks),
    verifyReport: computeArtifactState(input.artifactContents.verifyReport),
    archiveReport: computeArtifactState(input.artifactContents.archiveReport),
    applyProgress: computeApplyProgress(input.allIds, input.checkpoints.apply.completedIds),
  };

  const dependencies = computeDependencies({
    explore: artifacts.explore,
    proposal: artifacts.proposal,
    spec: artifacts.spec,
    design: artifacts.design,
    tasks: artifacts.tasks,
    applyProgress: artifacts.applyProgress,
    verifyReport: artifacts.verifyReport,
    archiveReport: artifacts.archiveReport,
    verifyReportHasUnresolvedCritical: input.verifyReportHasUnresolvedCritical ?? false,
  });

  const blockedReasons = [...input.blockedReasons];

  // RT-15 / C-4: an unresolved CRITICAL in the verify report blocks archive
  // (computeDependencies already makes `archive` blocked). But that alone is
  // not enough: the orchestrator routes EXCLUSIVELY on `nextRecommended`,
  // and `computeNextRecommended` only returns `resolve-blockers` when
  // `blockedReasons` is non-empty. Without pushing a reason here,
  // `status` stayed `ok` while `nextRecommended` was `resolve-blockers` AND
  // `blockedReasons` was empty — a three-way disagreement. Pushing the reason
  // here makes `computeStatusFlag` (which reads blockedReasons) and
  // `computeNextRecommended` (which reads the SAME blockedReasons) both flip
  // in this one computation, so status/nextRecommended/blockedReasons can
  // never disagree.
  if (input.verifyReportHasUnresolvedCritical) {
    const criticalReason = "Verify report has unresolved CRITICAL findings; archive blocked until resolved";
    if (!blockedReasons.includes(criticalReason)) {
      blockedReasons.push(criticalReason);
    }
  }

  const attemptCap = 3;
  const phases = ["apply", "verify"] as const;
  for (const phase of phases) {
    const pc = input.checkpoints?.[phase];
    if (pc?.attemptCounts) {
      const completed = new Set(pc.completedIds);
      for (const [id, count] of Object.entries(pc.attemptCounts)) {
        if (count >= attemptCap && !completed.has(id)) {
          const reason = `Scenario '${id}' exceeded maximum retry attempts (${count} attempts)`;
          if (!blockedReasons.includes(reason)) {
            blockedReasons.push(reason);
          }
        }
      }
    }
  }

  // RT-13: `nextRecommended` MUST be derived from the same `blockedReasons`
  // (including the attempt-cap reasons just appended above) that
  // `computeStatusFlag` uses for `status`, in this same computation — never a
  // caller-supplied value that could silently disagree with `status`.
  const nextRecommended = computeNextRecommended({ dependencies, blockedReasons });

  return {
    changeName: input.changeName,
    projectRoot: input.projectRoot,
    status: computeStatusFlag(blockedReasons, input.blockedOn),
    artifacts,
    dependencies,
    nextRecommended,
    inFlightPhase: input.inFlightPhase,
    blockedReasons,
    allIds: input.allIds,
    checkpoints: input.checkpoints,
    ...(input.blockedOn !== undefined ? { blockedOn: input.blockedOn } : {}),
  };
}
