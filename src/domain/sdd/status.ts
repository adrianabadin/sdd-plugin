/**
 * Unified status schema types (design §4, spec capability `sdd-status-store`).
 * Pure types only — computation lives in `src/application/sdd/compute-status.ts`
 * and `src/application/sdd/compute-discovery-status.ts`.
 *
 * NOTE (WU2 scope): these types describe the SHAPE only. The actual
 * blocked/ready/all_done VALUE per `dependencies` row and the `nextRecommended`
 * derivation from the Dependency Graph are WU3 (RT-1..16). The dispatch-lock
 * acquire/release semantics for `inFlightPhase` are WU4. The checkpoint
 * WRITE path (batchId, totalIds, attemptCounts, the retry cap) is WU9 — this
 * file only defines the shape those work units read and write.
 */

export type ArtifactState = "missing" | "done";
export type ApplyProgressState = "missing" | "partial" | "done";
export type DependencyState = "blocked" | "ready" | "all_done";

/** The eight phase-valued `nextRecommended` values that get a `dependencies` row (SS-4). */
export const PHASE_DEPENDENCY_KEYS = [
  "explore",
  "propose",
  "spec",
  "design",
  "tasks",
  "apply",
  "verify",
  "archive",
] as const;

export type PhaseDependencyKey = (typeof PHASE_DEPENDENCY_KEYS)[number];

export type Dependencies = Record<PhaseDependencyKey, DependencyState>;

/**
 * Full-shape `nextRecommended` — a superset of the phase keys plus non-phase
 * routing values.
 *
 * `complete` is the terminal value: the cycle is finished and there is nothing
 * left to recommend. It exists because without it a fully-archived change had
 * to fall back to some phase name, and the orchestrator routes on this field
 * exclusively — so recommending `archive` on an already-archived change is an
 * instruction to archive it again, forever. Discovered during WU3 apply.
 */
export type FullNextRecommended =
  | "init"
  | "complete"
  | "explore"
  | "propose"
  | "spec"
  | "design"
  | "tasks"
  | "apply"
  | "verify"
  | "archive"
  | "resolve-blockers"
  | "select-change";

export interface Artifacts {
  explore: ArtifactState;
  proposal: ArtifactState;
  spec: ArtifactState;
  design: ArtifactState;
  tasks: ArtifactState;
  verifyReport: ArtifactState;
  archiveReport: ArtifactState;
  /** The one genuinely three-state artifact (SS-3) — computed from checkpoints, never asserted. */
  applyProgress: ApplyProgressState;
}

export interface CurrentBatch {
  batchId: string;
  totalIds: readonly string[];
  remainingIds: readonly string[];
  batchNotes: string;
}

export interface PhaseCheckpoint {
  /** Cumulative across every batch of this phase (WU9 owns the write path). */
  completedIds: readonly string[];
  attemptCounts: Readonly<Record<string, number>>;
  currentBatch: CurrentBatch | null;
}

export interface Checkpoints {
  apply: PhaseCheckpoint;
  verify: PhaseCheckpoint;
}

export interface BlockedOn {
  phase: string;
  question: string;
  progressSummary: string;
  /**
   * CP-15: the item the batch was working on when it blocked, so resume can
   * put it first in remainingIds ("starting with the item that was blocked").
   * Optional because not every block happens mid-item (e.g. a model-resolution
   * block at entry has no item id).
   */
  blockedItemId?: string;
}

/** Full status shape returned by `sdd_status` for a named change (SS-1). */
export interface SddStatus {
  changeName: string;
  projectRoot: string;
  status: "ok" | "blocked";
  artifacts: Artifacts;
  dependencies: Dependencies;
  nextRecommended: FullNextRecommended;
  /** Set by `sdd_compose_phase_prompt` (WU4 acquires), cleared by `sdd_save_artifact` (WU4 releases). */
  inFlightPhase: string | null;
  blockedReasons: readonly string[];
  allIds: readonly string[];
  checkpoints: Checkpoints;
  blockedOn?: BlockedOn;
}

/** `sdd_status` without a `changeName` is restricted to pre-change-selection answers (SS-5). */
export type DiscoveryNextRecommended = "init" | "select-change" | "sdd-new";

export interface DiscoveryChangeSummary {
  changeName: string;
  nextRecommended: FullNextRecommended;
}

export interface SddDiscoveryStatus {
  projectRoot: string;
  initialized: boolean;
  changes: readonly DiscoveryChangeSummary[];
  nextRecommended: DiscoveryNextRecommended;
}
