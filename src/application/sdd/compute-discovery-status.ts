/**
 * WU2 — SS-5, SS-6: the discovery shape (`sdd_status` without a `changeName`)
 * (design §4, spec capability `sdd-status-store`).
 *
 * NOTE (WU2 scope): this is discovery-level routing only — the answers
 * meaningful before a change is selected (`init | select-change | sdd-new`).
 * It is distinct from the per-change Dependency Graph derivation (WU3,
 * RT-1..16), which decides each `dependencies` row and the full-shape
 * `nextRecommended` for an already-selected change.
 */

import type { DiscoveryChangeSummary, DiscoveryNextRecommended, SddDiscoveryStatus } from "../../domain/sdd/status.js";

// SS-5/SS-6: init when uninitialized; otherwise sdd-new (no changes yet) or
// select-change (one or more existing changes) — discovery-level routing only.
export function computeDiscoveryNextRecommended(
  initialized: boolean,
  changes: readonly DiscoveryChangeSummary[],
): DiscoveryNextRecommended {
  if (!initialized) return "init";
  return changes.length === 0 ? "sdd-new" : "select-change";
}

export function assembleDiscoveryStatus(
  projectRoot: string,
  initialized: boolean,
  changes: readonly DiscoveryChangeSummary[],
): SddDiscoveryStatus {
  return {
    projectRoot,
    initialized,
    changes,
    nextRecommended: computeDiscoveryNextRecommended(initialized, changes),
  };
}
