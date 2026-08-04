/**
 * Persistence port for SDD state. The only backend is PMC's `agent-memory-mcp`
 * (design §8 — "PMC as sole persistence + local-model backend"), reached
 * exclusively through structured MCP tool calls (SS-8). No adapter behind
 * this port may shell out to the `pmc` CLI or parse its stdout.
 *
 * Checkpoint reads/writes are versioned (design §9.12, CP-16/CP-17):
 * optimistic concurrency. A writer reads the current `version` alongside
 * the content, then writes back supplying that version as `expectedVersion`.
 * If the version on disk no longer matches (a concurrent writer landed
 * first), `writeCheckpoint` rejects with `CheckpointConcurrencyError` and
 * the caller re-reads and recomputes — never overwriting silently.
 */

/** A versioned checkpoint record as read from the store. */
export interface CheckpointRecord {
  readonly content: unknown;
  readonly version: number;
}

/** Result of a checkpoint write: the new version the store assigned. */
export interface CheckpointWriteResult {
  readonly version: number;
}

/** Durable, versioned state for one named SDD change in a project. */
export interface SddChangeStateLock {
  readonly phase: string;
}

/** Durable, versioned state for one named SDD change in a project. */
export interface SddChangeState {
  readonly projectRoot: string;
  readonly changeName: string;
  readonly artifactIndex: readonly string[];
  /** Public lock status; authorization credentials are never exposed. */
  readonly lock?: SddChangeStateLock;
  readonly baselineFingerprint?: string;
  /**
   * The change name that this durable state is currently BOUND to. Set by
   * the caller on acquire and held for the lifetime of the lock; cleared
   * on release / recover. Used by the project-init sentinel
   * (`__sdd_project_init_lock__`) to bind it to the change that acquired
   * it: a different change MUST NOT acquire, reclaim, or recover a
   * sentinel that is bound to someone else. For ordinary change states
   * this field is undefined — the change name is implicit in the durable
   * key.
   */
  readonly boundChangeName?: string;
  readonly version: number;
}

/** State content supplied for create or conditional update. */
export interface SddChangeStateInput {
  readonly projectRoot: string;
  readonly changeName: string;
  readonly artifactIndex: readonly string[];
  readonly baselineFingerprint?: string;
  /**
   * Bind this durable state to `boundChangeName` for the lifetime of the
   * lock. See `SddChangeState.boundChangeName` for the sentinel-binding
   * use case. Undefined for ordinary change states.
   */
  readonly boundChangeName?: string;
}

export class SddChangeStateVersionConflictError extends Error {
  readonly code = "SDD_CHANGE_STATE_VERSION_CONFLICT";

  constructor(projectRoot: string, changeName: string) {
    super(`SDD_CHANGE_STATE_VERSION_CONFLICT: '${changeName}' changed before its conditional write in '${projectRoot}'.`);
    this.name = "SddChangeStateVersionConflictError";
  }
}

/**
 * State writes happen before their separate discovery-index update. This error
 * preserves the committed state/version so callers can retry idempotently or
 * invoke `repairChangeStateIndex` after a transient index failure.
 */
export class SddChangeStateIndexPersistenceError extends Error {
  readonly code = "SDD_CHANGE_STATE_INDEX_PERSISTENCE_FAILED";

  constructor(
    readonly committedState: SddChangeState,
    readonly cause: unknown,
  ) {
    super(
      `SDD_CHANGE_STATE_INDEX_PERSISTENCE_FAILED: '${committedState.changeName}' committed at version ${committedState.version}, but its discovery index needs repair.`,
    );
    this.name = "SddChangeStateIndexPersistenceError";
  }
}

export class SddChangeStateLockConflictError extends Error {
  readonly code = "SDD_CHANGE_STATE_LOCK_CONFLICT";

  constructor(
    readonly heldLock: SddChangeStateLock | undefined,
    readonly requestedPhase: string,
  ) {
    super(
      heldLock === undefined
        ? "SDD_CHANGE_STATE_LOCK_CONFLICT: no lock is held by this runner."
        : `SDD_CHANGE_STATE_LOCK_CONFLICT: '${heldLock.phase}' is owned by another runner; cannot acquire '${requestedPhase}'.`,
    );
    this.name = "SddChangeStateLockConflictError";
  }
}

/**
 * Final-review finding #1 — the project-init sentinel is BOUND to the
 * change that acquired it. A different change trying to acquire, reclaim,
 * or recover a sentinel that is bound to another change receives this
 * error. The change name is surfaced publicly (not the owner token) so
 * the operator can attribute the conflict.
 */
export class SddChangeStateSentinelBindingConflictError extends Error {
  readonly code = "SDD_CHANGE_STATE_SENTINEL_BINDING_CONFLICT";

  constructor(
    readonly boundChangeName: string,
    readonly requestedChangeName: string,
  ) {
    super(
      `SDD_CHANGE_STATE_SENTINEL_BINDING_CONFLICT: sentinel is bound to '${boundChangeName}'; '${requestedChangeName}' cannot acquire or reclaim.`,
    );
    this.name = "SddChangeStateSentinelBindingConflictError";
  }
}

/**
 * DL-6: the explicit deliberate clear is a RECOVERY, not a timeout. The
 * recovered state has no lock; the audit record tells the caller exactly what
 * was cleared and why. No ownerToken is required — the whole point is that
 * the prior owner is gone and cannot authorize anything.
 */
export interface SddChangeStateLockRecovery {
  readonly changeName: string;
  readonly projectRoot: string;
  readonly recoveredAt: string;
  readonly reason: string;
  /** The lock that was held before recovery; undefined when no lock was held. */
  readonly priorLock: SddChangeStateLock | undefined;
}

/**
 * Typed durable change-state capability. It remains a persistence boundary:
 * application callers do not know the backing PMC or SQLite representation.
 */
export interface SddChangeStateStorePort {
  writeChangeState(state: SddChangeStateInput, expectedVersion: number): Promise<SddChangeState>;
  readChangeState(projectRoot: string, changeName: string): Promise<SddChangeState | null>;
  listChangeStates(projectRoot: string): Promise<readonly SddChangeState[]>;
  repairChangeStateIndex(projectRoot: string, changeName: string): Promise<SddChangeState>;
acquireChangeStateLock(
    projectRoot: string,
    changeName: string,
    requestedPhase: string,
    ownerToken: string,
    expectedVersion: number,
    boundChangeName?: string,
  ): Promise<SddChangeState>;
  renewChangeStateLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    expectedVersion: number,
  ): Promise<SddChangeState>;
  updateOwnedChangeState(
    state: SddChangeStateInput,
    ownerToken: string,
    expectedVersion: number,
  ): Promise<SddChangeState>;
  releaseChangeStateLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    expectedVersion: number,
  ): Promise<SddChangeState>;
  /**
   * SPEC DL-6 (reviewer finding #2) — owner-token re-verification primitive.
   * Reads the current durable state and confirms that:
   *   1. a lock is held,
   *   2. its owner token equals `ownerToken`.
   *
   * Phase validation is intentionally NOT done here — it is a
   * save-artifact-level concern (the artifact belongs to a specific phase)
   * and surfaces as `SDD_ARTIFACT_PHASE_MISMATCH` from the save path. Phase
   * belongs to the lock envelope; token rotation can be cross-phase.
   *
   * On success returns the locked public state (which never exposes the
   * owner token). On any mismatch — including the case where a concurrent
   * same-phase reclaim has replaced the owner token — throws
   * `SddChangeStateLockConflictError` so the caller can fail closed BEFORE
   * any artifact is written.
   *
   * This is the single function that lets a tool surface prove it still
   * owns the durable lock at the moment it is about to write; without it,
   * a stale in-memory `ownerTokens` map would let a displaced runner
   * persist artifacts against a lock it no longer holds.
   */
  verifyOwnedLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
  ): Promise<SddChangeState>;
/**
   * SPEC DL-6 — passive same-phase recovery. Atomically replaces the durable
   * lock ONLY when the held phase equals the requested phase, attaching a
   * fresh `newOwnerToken` so a restarted runner can resume its own phase
   * without leaking the previous (now-stale) owner token. When the held
   * phase differs, refuses with `SddChangeStateLockConflictError` — other
   * phases remain blocked. When no lock is held, behaves like a fresh
   * acquisition.
   *
   * The path is the one `sdd_compose_phase_prompt` falls through to when a
   * restarted tool surface re-dispatches the same phase that crashed.
   *
   * Final-review finding #1: when `expectedBoundChangeName` is supplied
   * (sentinel acquire / reclaim), the operation additionally requires
   * the durable state's `boundChangeName` to match. A different change
   * trying to acquire / reclaim a sentinel bound to someone else raises
   * `SddChangeStateSentinelBindingConflictError`.
   *
   * Final-review finding #3: on a retry triggered by an OCC conflict, the
   * implementation re-reads the durable state and uses THAT as the source
   * for `artifactIndex` and `baselineFingerprint`. This preserves any
   * concurrent mutations landed by other surfaces between the original
   * read and the retry, instead of silently overwriting them with stale
   * values captured at the original read.
   *
   * The optional `testHook` parameter is used ONLY by tests that need to
   * inject behavior between the initial read and the first write attempt
   * (the reviewer-finding #4 regression test). Production callers must
   * never supply it; passing a hook from production code would alter
   * observable behavior in production.
   */
  reclaimChangeStateLock(
    projectRoot: string,
    changeName: string,
    requestedPhase: string,
    newOwnerToken: string,
    expectedVersion: number,
    expectedBoundChangeName?: string,
    testHook?: { afterInitialRead?: () => Promise<void> },
  ): Promise<SddChangeState>;
  /**
   * SPEC DL-6 — explicit deliberate clear/recovery. No ownerToken is
   * supplied (or accepted): the prior owner is presumed unreachable.
   * Clears the durable lock unconditionally and returns an audit record
   * naming the cleared phase (if any), the caller-supplied reason, and a
   * server-side timestamp. NEVER invoked on a timer — it is the single
   * surface through which a stuck lock can be released.
   *
   * Final-review finding #1: when `expectedBoundChangeName` is supplied,
   * recovery is refused with `SddChangeStateSentinelBindingConflictError`
   * unless the durable state's `boundChangeName` matches. This prevents
   * recovery/clear for change A from clobbering a sentinel currently
   * bound to change B (a different live init).
   */
  recoverChangeStateLock(
    projectRoot: string,
    changeName: string,
    expectedVersion: number,
    reason: string,
    expectedBoundChangeName?: string,
  ): Promise<{ readonly state: SddChangeState; readonly audit: SddChangeStateLockRecovery }>;
  /**
   * Final-review finding #2 — atomic validation of init-round ownership.
   *
   * Reads BOTH the user change and the project-init sentinel in one
   * operation, validates that each lock is currently held by the supplied
   * owner token, AND validates the sentinel is bound to the user change.
   * Returns both validated states on success. Throws
   * `SddChangeStateLockConflictError` or
   * `SddChangeStateSentinelBindingConflictError` BEFORE the caller has any
   * opportunity to write the init-config checkpoint, so a stale init
   * runner whose local token map is out of date cannot cause a persisted
   * config mutation.
   */
  verifyInitRoundOwnership(
    projectRoot: string,
    userChangeName: string,
    sentinelChangeName: string,
    userOwnerToken: string,
    sentinelOwnerToken: string,
  ): Promise<{ readonly userState: SddChangeState; readonly sentinelState: SddChangeState }>;
}

export interface SddArtifactStorePort {
  writeArtifact(key: string, content: string): Promise<void>;
  readArtifact(key: string): Promise<string | null>;

  /**
   * Writes a checkpoint. When `expectedVersion` is supplied, the store MUST
   * reject with `CheckpointConcurrencyError` if the current version on disk
   * differs — this is the optimistic-concurrency gate (CP-16/CP-17). Omitting
   * `expectedVersion` is an unconditional write for paths that cannot compete
   * (e.g. fresh records); production callers of the durable write path must
   * always supply it.
   */
  writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult>;
  readCheckpoint(key: string): Promise<CheckpointRecord | null>;
  /**
   * Final-review finding #3 — atomic ownership + artifact persistence.
   *
   * Validates the durable owner of `changeName` against `ownerToken`,
   * writes `artifactContent` to `artifactKey`, reads it back for SS-9
   * durability, updates the durable change state to index `artifactName`
   * in `artifactIndex`, and releases the dispatch lock — all in one
   * atomic SQLite transaction. The OCC check on the state write ensures
   * that a concurrent reclaim landing between verify and commit cannot
   * leave a stale artifact: the conditional write fails, the
   * transaction rolls back, and the typed conflict surfaces.
   *
   * Lives on the artifact-store port (not the change-state port) so a
   * test fixture like `ArtifactFaultStore` can intercept the entire
   * atomic operation and exercise the failure paths. The default
   * implementation in `PmcSddArtifactStoreAdapter` is the real
   * SQLite-direct transactional path.
   */
  persistArtifactWithOwnership(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    artifactKey: string,
    artifactContent: string,
    artifactName: string,
  ): Promise<SddChangeState>;
}
