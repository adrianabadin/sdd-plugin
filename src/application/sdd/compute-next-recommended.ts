/**
 * WU3 — RT-11..RT-14: `nextRecommended` derivation from the Dependency Graph
 * (design §4, spec capability `sdd-routing`).
 *
 * When multiple phases are simultaneously `ready`, the earliest in graph
 * order wins: explore | propose | spec | design | tasks | apply | verify |
 * archive (`PHASE_DEPENDENCY_KEYS` already carries this order).
 *
 * Blockers always outrank phase recommendations (RT-12, RT-13): a non-empty
 * `blockedReasons` routes to `resolve-blockers` regardless of what the
 * Dependency Graph says, and this function and `computeStatusFlag` both read
 * the same `blockedReasons` value so the `status: blocked` /
 * `nextRecommended: resolve-blockers` pairing is produced by one shared input
 * in the same computation, never one without the other.
 */

import { PHASE_DEPENDENCY_KEYS, type Dependencies, type FullNextRecommended } from "../../domain/sdd/status.js";

export interface ComputeNextRecommendedInput {
  dependencies: Dependencies;
  blockedReasons: readonly string[];
}

export function computeNextRecommended(input: ComputeNextRecommendedInput): FullNextRecommended {
  // RT-12/RT-13: blockers outrank every phase recommendation.
  if (input.blockedReasons.length > 0) return "resolve-blockers";

  // RT-11: earliest ready phase in graph order wins the tiebreak.
  for (const phase of PHASE_DEPENDENCY_KEYS) {
    if (input.dependencies[phase] === "ready") return phase;
  }

  // RT-17: the whole cycle is finished — nothing left to recommend.
  // Returning a phase name here would be an instruction to re-run it, and
  // since the orchestrator routes on this field exclusively, returning
  // `archive` for an already-archived change is an archive-forever loop.
  if (PHASE_DEPENDENCY_KEYS.every((phase) => input.dependencies[phase] === "all_done")) {
    return "complete";
  }

  // RT-18: nothing is ready, nothing is blocked, and the cycle is not
  // finished — the dependency rows are internally inconsistent. Route to
  // `resolve-blockers` so a human looks, rather than silently picking a
  // phase and pretending the state is coherent.
  return "resolve-blockers";
}
