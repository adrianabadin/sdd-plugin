/**
 * `agent-memory-mcp`-backed implementation of `SddArtifactStorePort` (SS-8).
 *
 * This adapter talks exclusively to the injected `McpToolClientPort` — it
 * never imports `node:child_process`, never shells out to the `pmc` CLI,
 * and never parses stdout text. All values in/out are structured JSON, per
 * design §8.2 row 5.
 *
 * Checkpoint versioning (design §9.12, CP-16/CP-17): the store/recall tool
 * contract carries a `version` field. `writeCheckpoint` passes
 * `expectedVersion` through; a mismatch surfaces as
 * `CheckpointConcurrencyError` so the durable write loop re-reads and
 * recomputes instead of clobbering a concurrent writer.
 */

import { CheckpointConcurrencyError } from "../../application/sdd/checkpoint.js";
import { canonicalizeProjectRoot } from "../../domain/sdd/project-identity.js";
import { changeStateIndexKey, changeStateKey } from "../../domain/sdd/sdd-keys.js";
import type { McpToolClientPort } from "../../ports/mcp-tool-client.port.js";
import type {
  CheckpointRecord,
  CheckpointWriteResult,
  SddChangeState,
  SddChangeStateInput,
  SddChangeStateLock,
  SddChangeStateStorePort,
  SddArtifactStorePort,
} from "../../ports/sdd-artifact-store.port.js";
import {
  SddChangeStateIndexPersistenceError,
  SddChangeStateLockConflictError,
  SddChangeStateSentinelBindingConflictError,
  SddChangeStateVersionConflictError,
} from "../../ports/sdd-artifact-store.port.js";

const STORE_TOOL = "pmc-agent-memory_store";
const RECALL_TOOL = "pmc-agent-memory_recall";

/** Bounded OCC retries prevent a hot index from spinning indefinitely. */
export const CHANGE_STATE_INDEX_MAX_RETRIES = 3;

interface ArtifactRecallResult {
  readonly content: string | null;
}

interface CheckpointRecallResult {
  readonly content: unknown | null;
  readonly version: number;
}

interface CheckpointStoreResult {
  readonly version: number;
  /** Present when the store rejected the write due to a version mismatch. */
  readonly conflict?: boolean;
}

interface ChangeStateIndex {
  readonly changeNames: readonly string[];
}

/** Credentials remain in the persisted record and are never projected publicly. */
interface StoredSddChangeStateLock {
  readonly phase: string;
  readonly ownerToken: string;
}

interface StoredSddChangeStateInput extends SddChangeStateInput {
  readonly lock?: StoredSddChangeStateLock;
}

interface StoredSddChangeState extends StoredSddChangeStateInput {
  readonly version: number;
}

interface ChangeStateIdentity {
  readonly projectRoot: string;
  readonly stateKey: string;
  readonly indexKey: string;
}

export class PmcSddArtifactStoreAdapter implements SddArtifactStorePort, SddChangeStateStorePort {
  constructor(private readonly mcp: McpToolClientPort) {}

  async writeArtifact(key: string, content: string): Promise<void> {
    await this.mcp.callTool(STORE_TOOL, { key, content, kind: "artifact" });
  }

  async readArtifact(key: string): Promise<string | null> {
    const result = await this.mcp.callTool<ArtifactRecallResult>(RECALL_TOOL, { key, kind: "artifact" });
    return result.content;
  }

  async writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult> {
    const result = await this.mcp.callTool<CheckpointStoreResult>(STORE_TOOL, {
      key,
      content,
      kind: "checkpoint",
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    if (result.conflict) {
      throw new CheckpointConcurrencyError(
        `Checkpoint '${key}' version mismatch: a concurrent writer landed first.`,
      );
    }
    return { version: result.version };
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const result = await this.mcp.callTool<CheckpointRecallResult>(RECALL_TOOL, { key, kind: "checkpoint" });
    if (result.content === null) return null;
    return { content: result.content, version: result.version };
  }

  async writeChangeState(state: SddChangeStateInput, expectedVersion: number): Promise<SddChangeState> {
    return this.toPublicState(await this.writeStoredChangeState(state, expectedVersion));
  }

  private async writeStoredChangeState(
    state: StoredSddChangeStateInput,
    expectedVersion: number,
  ): Promise<StoredSddChangeState> {
    const identity = this.resolveChangeStateIdentity(state.projectRoot, state.changeName);
    const content = this.changeStateContent(state, identity.projectRoot);
    const result = await this.mcp.callTool<CheckpointStoreResult>(STORE_TOOL, {
      key: identity.stateKey,
      content,
      kind: "sdd-change-state",
      expectedVersion,
    });
    if (result.conflict) {
      if (expectedVersion === 0) {
        const existing = await this.readStoredChangeState(identity.projectRoot, state.changeName);
        if (existing !== null && this.matchesChangeStateInput(existing, content)) {
          return this.repairStoredChangeStateIndex(identity.projectRoot, state.changeName);
        }
      }
      throw new SddChangeStateVersionConflictError(identity.projectRoot, state.changeName);
    }

    // State creation and index persistence are separate conditional records.
    // Reconcile on every successful write so a prior exhausted index conflict
    // cannot leave an otherwise durable state permanently undiscoverable.
    const committedState = { ...content, version: result.version };
    try {
      await this.addToChangeIndex(identity.indexKey, state.changeName);
      return committedState;
    } catch (error) {
      throw new SddChangeStateIndexPersistenceError(this.toPublicState(committedState), error);
    }
  }

  async readChangeState(projectRoot: string, changeName: string): Promise<SddChangeState | null> {
    const storedState = await this.readStoredChangeState(projectRoot, changeName);
    return storedState === null ? null : this.toPublicState(storedState);
  }

  private async readStoredChangeState(projectRoot: string, changeName: string): Promise<StoredSddChangeState | null> {
    const identity = this.resolveChangeStateIdentity(projectRoot, changeName);
    const result = await this.mcp.callTool<CheckpointRecallResult>(RECALL_TOOL, {
      key: identity.stateKey,
      kind: "sdd-change-state",
    });
    if (result.content === null) return null;
    return this.decodeChangeState(result.content, result.version, identity.projectRoot, changeName);
  }

  async listChangeStates(projectRoot: string): Promise<readonly SddChangeState[]> {
    const { canonicalPath: canonicalProjectRoot, projectRootHash } = canonicalizeProjectRoot(projectRoot);
    const result = await this.mcp.callTool<CheckpointRecallResult>(RECALL_TOOL, {
      key: changeStateIndexKey(projectRootHash),
      kind: "sdd-change-state-index",
    });
    const index = this.decodeChangeStateIndex(result.content);
    const states = await Promise.all(
      index.changeNames.map((changeName) => this.readChangeState(canonicalProjectRoot, changeName)),
    );
    return states
      .filter((state): state is SddChangeState => state !== null)
      .sort((left, right) => left.changeName.localeCompare(right.changeName));
  }

  async repairChangeStateIndex(projectRoot: string, changeName: string): Promise<SddChangeState> {
    return this.toPublicState(await this.repairStoredChangeStateIndex(projectRoot, changeName));
  }

  private async repairStoredChangeStateIndex(
    projectRoot: string,
    changeName: string,
  ): Promise<StoredSddChangeState> {
    const identity = this.resolveChangeStateIdentity(projectRoot, changeName);
    const state = await this.readStoredChangeState(identity.projectRoot, changeName);
    if (state === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state to repair.`);
    }
    try {
      await this.addToChangeIndex(identity.indexKey, changeName);
      return state;
    } catch (error) {
      throw new SddChangeStateIndexPersistenceError(this.toPublicState(state), error);
    }
  }

async acquireChangeStateLock(
    projectRoot: string,
    changeName: string,
    requestedPhase: string,
    ownerToken: string,
    expectedVersion: number,
    boundChangeName?: string,
  ): Promise<SddChangeState> {
    const current = await this.readStoredChangeState(projectRoot, changeName);
    if (current === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state.`);
    }
    // Final-review finding #1 — sentinel-binding check. When the caller
    // is acquiring the project-init sentinel for `boundChangeName`, the
    // sentinel must be unbound (no live init for any other change) OR
    // already bound to this same change (post-crash resume). Any other
    // binding is a typed conflict that names the bound change publicly.
    if (
      boundChangeName !== undefined &&
      current.boundChangeName !== undefined &&
      current.boundChangeName !== boundChangeName
    ) {
      throw new SddChangeStateSentinelBindingConflictError(current.boundChangeName, boundChangeName);
    }
    if (current.lock !== undefined) {
      throw new SddChangeStateLockConflictError(this.publicLock(current.lock), requestedPhase);
    }
    try {
      return this.toPublicState(await this.writeStoredChangeState(
        {
          ...this.changeStateInput(current),
          lock: { phase: requestedPhase, ownerToken },
          ...(boundChangeName !== undefined ? { boundChangeName } : {}),
        },
        expectedVersion,
      ));
    } catch (error) {
      if (error instanceof SddChangeStateVersionConflictError) {
        const latest = await this.readStoredChangeState(projectRoot, changeName);
        if (latest?.lock !== undefined && latest.lock.ownerToken !== ownerToken) {
          throw new SddChangeStateLockConflictError(this.publicLock(latest.lock), requestedPhase);
        }
      }
      throw error;
    }
  }

  async renewChangeStateLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    expectedVersion: number,
  ): Promise<SddChangeState> {
    const current = await this.requireOwnedLock(projectRoot, changeName, ownerToken, "renew");
    return this.toPublicState(await this.writeStoredChangeState(this.changeStateInput(current), expectedVersion));
  }

async updateOwnedChangeState(
    state: SddChangeStateInput,
    ownerToken: string,
    expectedVersion: number,
  ): Promise<SddChangeState> {
    const current = await this.requireOwnedLock(state.projectRoot, state.changeName, ownerToken, "update");
    // Conditional spread under exactOptionalPropertyTypes: `current.lock`
    // is provably defined after requireOwnedLock, but TS doesn't carry the
    // narrowing across the helper, so we narrow inline rather than widening
    // the StoredSddChangeStateInput type or weakening tsconfig. Preserve
    // `boundChangeName` so a sentinel's binding survives a content update.
    return this.toPublicState(await this.writeStoredChangeState(
      {
        ...state,
        ...(current.lock !== undefined ? { lock: current.lock } : {}),
        ...(current.boundChangeName !== undefined ? { boundChangeName: current.boundChangeName } : {}),
      },
      expectedVersion,
    ));
  }

async releaseChangeStateLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    expectedVersion: number,
  ): Promise<SddChangeState> {
    const current = await this.requireOwnedLock(projectRoot, changeName, ownerToken, "release");
    const { lock: _lock, ...unlockedState } = this.changeStateInput(current);
    return this.toPublicState(await this.writeStoredChangeState(unlockedState, expectedVersion));
  }

  async verifyOwnedLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
  ): Promise<SddChangeState> {
    // Reviewer finding #2 — re-verify the durable owner at the moment the
    // caller is about to write. A displaced/revoked tool surface whose
    // in-memory token map still says it owns the lock MUST be refused here,
    // before any artifact write is attempted. The check uses the latest
    // durable read so a concurrent reclaim is detected.
    const current = await this.readStoredChangeState(projectRoot, changeName);
    if (current === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state.`);
    }
    if (current.lock === undefined || current.lock.ownerToken !== ownerToken) {
      throw new SddChangeStateLockConflictError(
        current.lock === undefined ? undefined : { phase: current.lock.phase },
        current.lock?.phase ?? "save",
      );
    }
    return this.toPublicState(current);
  }

  async verifyInitRoundOwnership(
    projectRoot: string,
    userChangeName: string,
    sentinelChangeName: string,
    userOwnerToken: string,
    sentinelOwnerToken: string,
  ): Promise<{ readonly userState: SddChangeState; readonly sentinelState: SddChangeState }> {
    // Final-review finding #2 — atomically validate BOTH the user change
    // and the bound project-init sentinel. Each port-level ownership check
    // is performed against the latest durable read; a stale runner whose
    // in-memory token map is out of date is refused with the typed
    // conflict BEFORE any caller can write the init-config checkpoint.
    const userState = await this.readStoredChangeState(projectRoot, userChangeName);
    if (userState === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${userChangeName}' has no durable state.`);
    }
    if (userState.lock === undefined || userState.lock.ownerToken !== userOwnerToken) {
      throw new SddChangeStateLockConflictError(
        userState.lock === undefined ? undefined : { phase: userState.lock.phase },
        userState.lock?.phase ?? "init-config",
      );
    }
    const sentinelState = await this.readStoredChangeState(projectRoot, sentinelChangeName);
    if (sentinelState === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${sentinelChangeName}' has no durable state.`);
    }
    if (sentinelState.lock === undefined || sentinelState.lock.ownerToken !== sentinelOwnerToken) {
      throw new SddChangeStateLockConflictError(
        sentinelState.lock === undefined ? undefined : { phase: sentinelState.lock.phase },
        sentinelState.lock?.phase ?? "init-config",
      );
    }
    // Final-review finding #1 — the sentinel binding must match the user
    // change attempting the config save. A different live init holding the
    // sentinel is a typed binding conflict.
    if (sentinelState.boundChangeName !== undefined && sentinelState.boundChangeName !== userChangeName) {
      throw new SddChangeStateSentinelBindingConflictError(sentinelState.boundChangeName, userChangeName);
    }
    return { userState: this.toPublicState(userState), sentinelState: this.toPublicState(sentinelState) };
  }

  async persistArtifactWithOwnership(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    artifactKey: string,
    artifactContent: string,
    artifactName: string,
  ): Promise<SddChangeState> {
    // Final-review finding #3 — atomic ownership + artifact persistence.
    //
    // The previous flow (verify -> writeArtifact -> updateOwnedChangeState
    // -> releaseChangeStateLock) had a verify-then-write TOCTOU window: a
    // concurrent same-phase reclaim landing between verify and write would
    // leak a stale artifact. We close that window by wrapping the entire
    // sequence in a single SQLite transaction:
    //   1. read durable state and verify the owner token,
    //   2. write the artifact,
    //   3. read it back for SS-9 durability,
    //   4. conditionally update durable state to index the artifact and
    //      clear the lock, using the version observed in step 1.
    //
    // A concurrent reclaim that lands between step 1 and step 4 will
    // advance the durable version, so step 4's OCC check fails. The
    // transaction rolls back: the artifact write is undone by SQLite
    // (BEGIN ... ROLLBACK discards the row insert), the read-back sees
    // the original (pre-insert) value, and the typed conflict surfaces
    // to the caller. There is no path that persists the artifact without
    // first proving ownership holds at commit time.
    //
    // Requires the SQLite-direct adapter (which provides
    // `runInTransactionSync`). The test fakes do not implement this
    // method because the test scenarios for this primitive all run
    // against a real SqliteMcpToolClient; the sdd-tools integration test
    // that exercises `sdd_save_artifact` already uses one.
    const sqliteMcp = this.mcp as unknown as { runInTransactionSync?: <T>(work: () => T) => T };
    if (typeof sqliteMcp.runInTransactionSync !== "function") {
      throw new Error("SDD_PERSIST_ATOMIC_UNAVAILABLE: persistArtifactWithOwnership requires the SQLite-direct adapter.");
    }
    return sqliteMcp.runInTransactionSync<SddChangeState>(() => {
      // Synchronous read of the current durable state — node:sqlite is
      // synchronous so this executes inline. The result is captured
      // into the closure for the verification + state-update below.
      const current = this.readStoredChangeStateSync(projectRoot, changeName);
      if (current === null) {
        throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state.`);
      }
      if (current.lock === undefined || current.lock.ownerToken !== ownerToken) {
        throw new SddChangeStateLockConflictError(
          current.lock === undefined ? undefined : { phase: current.lock.phase },
          current.lock?.phase ?? "save",
        );
      }
      const nextArtifactIndex = current.artifactIndex.includes(artifactName)
        ? [...current.artifactIndex]
        : [...current.artifactIndex, artifactName];
      const nextContent: StoredSddChangeStateInput = {
        projectRoot: current.projectRoot,
        changeName: current.changeName,
        artifactIndex: nextArtifactIndex,
        ...(current.baselineFingerprint !== undefined ? { baselineFingerprint: current.baselineFingerprint } : {}),
        ...(current.boundChangeName !== undefined ? { boundChangeName: current.boundChangeName } : {}),
        // Lock envelope cleared: artifact save always releases the dispatch
        // lock (DL-4). The stored `lock` field is therefore absent in the
        // post-commit envelope.
      };
      const writeResult = this.writeCheckpointSync(artifactKey, artifactContent, undefined);
      void writeResult;
      const readBack = this.readArtifactSync(artifactKey);
      if (readBack !== artifactContent) {
        throw new Error(`SS-9 read-back mismatch on '${artifactKey}'.`);
      }
      // Conditional update under expectedVersion from step 1. If a
      // concurrent reclaim landed during the transaction, the OCC
      // check fails and the transaction rolls back.
      const committed = this.writeStoredChangeStateSync(nextContent, current.version);
      return this.toPublicState(committed);
    });
  }

  /**
   * Synchronous read of the stored change state. Mirrors
   * `readStoredChangeState` but returns directly from `node:sqlite` (no
   * await) so it can be used inside `runInTransactionSync`.
   */
  private readStoredChangeStateSync(projectRoot: string, changeName: string): StoredSddChangeState | null {
    const identity = this.resolveChangeStateIdentity(projectRoot, changeName);
    const sqliteMcp = this.mcp as unknown as {
      rawCall?: <T>(toolName: string, args: Readonly<Record<string, unknown>>) => T;
    };
    if (typeof sqliteMcp.rawCall !== "function") {
      throw new Error("SDD_PERSIST_ATOMIC_UNAVAILABLE: synchronous read requires the SQLite-direct adapter.");
    }
    const result = sqliteMcp.rawCall<CheckpointRecallResult>(RECALL_TOOL, {
      key: identity.stateKey,
      kind: "sdd-change-state",
    });
    if (result.content === null) return null;
    return this.decodeChangeState(result.content, result.version, identity.projectRoot, changeName);
  }

  /**
   * Synchronous write of a checkpoint (artifact or state) for use inside
   * `runInTransactionSync`. Mirrors `writeCheckpoint` but is synchronous.
   */
  private writeCheckpointSync(key: string, content: unknown, expectedVersion?: number): CheckpointWriteResult {
    const sqliteMcp = this.mcp as unknown as {
      rawCall?: <T>(toolName: string, args: Readonly<Record<string, unknown>>) => T;
    };
    if (typeof sqliteMcp.rawCall !== "function") {
      throw new Error("SDD_PERSIST_ATOMIC_UNAVAILABLE: synchronous write requires the SQLite-direct adapter.");
    }
    const result = sqliteMcp.rawCall<CheckpointStoreResult>(STORE_TOOL, {
      key,
      content,
      kind: "checkpoint",
      ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    });
    if (result.conflict) {
      throw new CheckpointConcurrencyError(
        `Checkpoint '${key}' version mismatch: a concurrent writer landed first.`,
      );
    }
    return { version: result.version };
  }

  /**
   * Synchronous read of an artifact. Mirrors `readArtifact` but is
   * synchronous.
   */
  private readArtifactSync(key: string): string | null {
    const sqliteMcp = this.mcp as unknown as {
      rawCall?: <T>(toolName: string, args: Readonly<Record<string, unknown>>) => T;
    };
    if (typeof sqliteMcp.rawCall !== "function") {
      throw new Error("SDD_PERSIST_ATOMIC_UNAVAILABLE: synchronous read requires the SQLite-direct adapter.");
    }
    const result = sqliteMcp.rawCall<ArtifactRecallResult>(RECALL_TOOL, { key, kind: "artifact" });
    return result.content;
  }

  /**
   * Synchronous write of the stored change state. Mirrors
   * `writeStoredChangeState` but is synchronous.
   */
  private writeStoredChangeStateSync(state: StoredSddChangeStateInput, expectedVersion: number): StoredSddChangeState {
    const identity = this.resolveChangeStateIdentity(state.projectRoot, state.changeName);
    const content = this.changeStateContent(state, identity.projectRoot);
    const sqliteMcp = this.mcp as unknown as {
      rawCall?: <T>(toolName: string, args: Readonly<Record<string, unknown>>) => T;
    };
    if (typeof sqliteMcp.rawCall !== "function") {
      throw new Error("SDD_PERSIST_ATOMIC_UNAVAILABLE: synchronous write requires the SQLite-direct adapter.");
    }
    const result = sqliteMcp.rawCall<CheckpointStoreResult>(STORE_TOOL, {
      key: identity.stateKey,
      content,
      kind: "sdd-change-state",
      expectedVersion,
    });
    if (result.conflict) {
      throw new SddChangeStateVersionConflictError(identity.projectRoot, state.changeName);
    }
    const committedState = { ...content, version: result.version };
    try {
      this.addToChangeIndexSync(identity.indexKey, state.changeName);
      return committedState;
    } catch (error) {
      throw new SddChangeStateIndexPersistenceError(this.toPublicState(committedState), error);
    }
  }

  /**
   * Synchronous index append for use inside `runInTransactionSync`.
   */
  private addToChangeIndexSync(indexKey: string, changeName: string): void {
    const sqliteMcp = this.mcp as unknown as {
      rawCall?: <T>(toolName: string, args: Readonly<Record<string, unknown>>) => T;
    };
    if (typeof sqliteMcp.rawCall !== "function") {
      throw new Error("SDD_PERSIST_ATOMIC_UNAVAILABLE: synchronous write requires the SQLite-direct adapter.");
    }
    for (let attempt = 0; attempt < CHANGE_STATE_INDEX_MAX_RETRIES; attempt += 1) {
      const current = sqliteMcp.rawCall<CheckpointRecallResult>(RECALL_TOOL, {
        key: indexKey,
        kind: "sdd-change-state-index",
      });
      const index = this.decodeChangeStateIndex(current.content);
      if (index.changeNames.includes(changeName)) return;
      const result = sqliteMcp.rawCall<CheckpointStoreResult>(STORE_TOOL, {
        key: indexKey,
        content: { changeNames: [...index.changeNames, changeName].sort() },
        kind: "sdd-change-state-index",
        expectedVersion: current.version,
      });
      if (!result.conflict) return;
    }
    throw new Error(`SDD_CHANGE_STATE_INDEX_CONFLICT: unable to add '${changeName}' after concurrent updates.`);
  }

  async reclaimChangeStateLock(
    projectRoot: string,
    changeName: string,
    requestedPhase: string,
    newOwnerToken: string,
    expectedVersion: number,
    expectedBoundChangeName?: string,
    testHook?: { afterInitialRead?: () => Promise<void> },
  ): Promise<SddChangeState> {
    // SPEC DL-6 — passive same-phase recovery. Replaces the durable owner
    // token with the supplied one ONLY when the held phase equals the
    // requested phase. A different phase still raises the typed conflict so
    // unrelated runners remain blocked. When the durable state shows no lock
    // at all, behaves like a fresh acquisition.
    //
    // Final-review finding #1 — sentinel-binding check. When
    // `expectedBoundChangeName` is supplied, the sentinel must be unbound
    // OR already bound to this same change. A different binding is a
    // typed conflict that names the bound change publicly.
    let source = await this.readStoredChangeState(projectRoot, changeName);
    // Final-review finding #4 — test-only hook. Invoked exactly once
    // after the initial read and BEFORE the first write attempt, so the
    // regression test can inject a concurrent mutation into the
    // OCC-conflict window. Production callers never pass this; the hook
    // is intentionally absent from the type's surface area when callers
    // don't opt in.
    if (testHook?.afterInitialRead) {
      await testHook.afterInitialRead();
    }
    if (source === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state.`);
    }
    if (
      expectedBoundChangeName !== undefined &&
      source.boundChangeName !== undefined &&
      source.boundChangeName !== expectedBoundChangeName
    ) {
      throw new SddChangeStateSentinelBindingConflictError(source.boundChangeName, expectedBoundChangeName);
    }
    if (source.lock === undefined) {
      // No lock held — fall through to the same write shape as a fresh acquire
      // so the caller receives a uniform post-condition.
      return this.toPublicState(await this.writeStoredChangeState(
        {
          ...this.changeStateInput(source),
          lock: { phase: requestedPhase, ownerToken: newOwnerToken },
          ...(expectedBoundChangeName !== undefined ? { boundChangeName: expectedBoundChangeName } : {}),
        },
        expectedVersion,
      ));
    }
    if (source.lock.phase !== requestedPhase) {
      throw new SddChangeStateLockConflictError({ phase: source.lock.phase }, requestedPhase);
    }
    // Final-review finding #3 — each retry uses the FRESHLY READ latest
    // state as its source. A concurrent writer landing between our read
    // and our write may have updated `artifactIndex` or
    // `baselineFingerprint`; using the original snapshot would silently
    // overwrite those mutations and lose work. The `source` variable is
    // reassigned on every retry.
    let attemptVersion = expectedVersion;
    for (let attempt = 0; attempt < CHANGE_STATE_INDEX_MAX_RETRIES; attempt += 1) {
      try {
        return this.toPublicState(await this.writeStoredChangeState(
          {
            ...this.changeStateInput(source),
            lock: { phase: requestedPhase, ownerToken: newOwnerToken },
            ...(expectedBoundChangeName !== undefined ? { boundChangeName: expectedBoundChangeName } : {}),
          },
          attemptVersion,
        ));
      } catch (error) {
        if (!(error instanceof SddChangeStateVersionConflictError)) throw error;
        const latest = await this.readStoredChangeState(projectRoot, changeName);
        if (latest === null) {
          throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' vanished during reclaim.`);
        }
        // Re-check the sentinel binding on each retry — a concurrent
        // writer could have rebound the sentinel to a different change.
        if (
          expectedBoundChangeName !== undefined &&
          latest.boundChangeName !== undefined &&
          latest.boundChangeName !== expectedBoundChangeName
        ) {
          throw new SddChangeStateSentinelBindingConflictError(latest.boundChangeName, expectedBoundChangeName);
        }
        // Re-read defensively — a concurrent writer may have replaced the
        // lock with one for a DIFFERENT phase, in which case reclaim must
        // still refuse. Only when the held phase still matches do we retry,
        // AND we adopt `latest` as the new source so any concurrent
        // mutations to `artifactIndex` or `baselineFingerprint` survive.
        if (latest.lock === undefined || latest.lock.phase !== requestedPhase) {
          throw new SddChangeStateLockConflictError(
            latest.lock === undefined ? undefined : { phase: latest.lock.phase },
            requestedPhase,
          );
        }
        source = latest;
        attemptVersion = latest.version;
      }
    }
    throw new Error(`SDD_CHANGE_STATE_VERSION_CONFLICT: reclaim of '${changeName}' exhausted retries.`);
  }

  async recoverChangeStateLock(
    projectRoot: string,
    changeName: string,
    expectedVersion: number,
    reason: string,
    expectedBoundChangeName?: string,
  ): Promise<{ readonly state: SddChangeState; readonly audit: import("../../ports/sdd-artifact-store.port.js").SddChangeStateLockRecovery }> {
    // SPEC DL-6 — explicit deliberate clear. The reason is supplied by the
    // caller and preserved verbatim in the audit record; the prior owner is
    // presumed unreachable, so no ownerToken is requested. The audit
    // timestamp is generated server-side so a clock-skewed client cannot lie
    // about when the recovery happened.
    //
    // Final-review finding #1 — sentinel-binding check. When
    // `expectedBoundChangeName` is supplied, recovery is refused with a
    // typed conflict unless the durable state's `boundChangeName` matches.
    // This prevents recovery/clear for change A from clobbering a sentinel
    // currently bound to change B (a different live init).
    const current = await this.readStoredChangeState(projectRoot, changeName);
    if (current === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state.`);
    }
    if (
      expectedBoundChangeName !== undefined &&
      current.boundChangeName !== undefined &&
      current.boundChangeName !== expectedBoundChangeName
    ) {
      throw new SddChangeStateSentinelBindingConflictError(current.boundChangeName, expectedBoundChangeName);
    }
    const priorLock = current.lock === undefined ? undefined : { phase: current.lock.phase };
    const { lock: _lock, boundChangeName: _bound, ...unlockedState } = this.changeStateInput(current);
    const cleared = await this.writeStoredChangeState(unlockedState, expectedVersion);
    return {
      state: this.toPublicState(cleared),
      audit: {
        changeName,
        projectRoot: cleared.projectRoot,
        recoveredAt: new Date().toISOString(),
        reason,
        priorLock,
      },
    };
  }

  private resolveChangeStateIdentity(projectRoot: string, changeName: string): ChangeStateIdentity {
    const { canonicalPath, projectRootHash } = canonicalizeProjectRoot(projectRoot);
    return {
      projectRoot: canonicalPath,
      stateKey: changeStateKey(projectRootHash, changeName),
      indexKey: changeStateIndexKey(projectRootHash),
    };
  }

private changeStateContent(state: StoredSddChangeStateInput, projectRoot: string): StoredSddChangeStateInput {
    return {
      projectRoot,
      changeName: state.changeName,
      artifactIndex: [...state.artifactIndex],
      ...(state.lock !== undefined ? { lock: { ...state.lock } } : {}),
      ...(state.baselineFingerprint !== undefined ? { baselineFingerprint: state.baselineFingerprint } : {}),
      // boundChangeName only meaningful for sentinel-like states; preserve
      // it through every write so a same-phase reclaim or release does not
      // accidentally drop the binding while the lock is still alive.
      ...(state.boundChangeName !== undefined ? { boundChangeName: state.boundChangeName } : {}),
    };
  }

  private changeStateInput(state: StoredSddChangeState): StoredSddChangeStateInput {
    const { version: _version, ...input } = state;
    return input;
  }

  private decodeChangeState(
    content: unknown,
    version: number,
    projectRoot: string,
    changeName: string,
  ): StoredSddChangeState {
    if (!this.isChangeStateInput(content) || content.projectRoot !== projectRoot || content.changeName !== changeName) {
      throw new Error(`SDD_CHANGE_STATE_INVALID: '${changeName}' contains an invalid durable state.`);
    }
    return { ...content, artifactIndex: [...content.artifactIndex], version };
  }

private isChangeStateInput(content: unknown): content is StoredSddChangeStateInput {
    if (typeof content !== "object" || content === null) return false;
    const state = content as Record<string, unknown>;
    return (
      typeof state.projectRoot === "string" &&
      typeof state.changeName === "string" &&
      Array.isArray(state.artifactIndex) &&
      state.artifactIndex.every((artifact) => typeof artifact === "string") &&
      (state.lock === undefined || this.isChangeStateLock(state.lock)) &&
      (state.baselineFingerprint === undefined || typeof state.baselineFingerprint === "string") &&
      (state.boundChangeName === undefined || typeof state.boundChangeName === "string")
    );
  }

  private isChangeStateLock(lock: unknown): lock is StoredSddChangeStateLock {
    if (typeof lock !== "object" || lock === null) return false;
    const candidate = lock as Record<string, unknown>;
    return typeof candidate.phase === "string" && typeof candidate.ownerToken === "string";
  }

  private matchesChangeStateInput(state: StoredSddChangeState, input: StoredSddChangeStateInput): boolean {
    return (
      state.projectRoot === input.projectRoot &&
      state.changeName === input.changeName &&
      state.baselineFingerprint === input.baselineFingerprint &&
      state.artifactIndex.length === input.artifactIndex.length &&
      state.artifactIndex.every((artifact, index) => artifact === input.artifactIndex[index]) &&
      state.lock?.phase === input.lock?.phase &&
      state.lock?.ownerToken === input.lock?.ownerToken
    );
  }

  private async requireOwnedLock(
    projectRoot: string,
    changeName: string,
    ownerToken: string,
    operation: "renew" | "update" | "release",
  ): Promise<StoredSddChangeState> {
    const current = await this.readStoredChangeState(projectRoot, changeName);
    if (current === null) {
      throw new Error(`SDD_CHANGE_STATE_NOT_FOUND: '${changeName}' has no durable state.`);
    }
if (current.lock === undefined || current.lock.ownerToken !== ownerToken) {
      throw new SddChangeStateLockConflictError(
        current.lock === undefined ? undefined : { phase: current.lock.phase },
        operation,
      );
    }
    return current;
  }

private toPublicState(state: StoredSddChangeState): SddChangeState {
    return {
      projectRoot: state.projectRoot,
      changeName: state.changeName,
      artifactIndex: [...state.artifactIndex],
      // Inlined conditional spread + narrowed `publicLock` keeps the build
      // green under exactOptionalPropertyTypes without weakening tsconfig.
      ...(state.lock !== undefined ? { lock: { phase: state.lock.phase } } : {}),
      ...(state.baselineFingerprint !== undefined ? { baselineFingerprint: state.baselineFingerprint } : {}),
      // Final-review finding #1 — surface the sentinel binding publicly so
      // operators can attribute a conflict to the bound change. The owner
      // token is NOT exposed; only the changeName itself.
      ...(state.boundChangeName !== undefined ? { boundChangeName: state.boundChangeName } : {}),
      version: state.version,
    };
  }

private publicLock(lock: StoredSddChangeStateLock): SddChangeStateLock {
    // Narrowed overload: callers only invoke this after checking the lock is
    // defined, so the signature accepts a present lock and returns a present
    // public lock. Under exactOptionalPropertyTypes this lets `toPublicState`
    // build a result object whose `lock?` field is set, never left as `undefined`.
    return { phase: lock.phase };
  }

  private async addToChangeIndex(indexKey: string, changeName: string): Promise<void> {
    for (let attempt = 0; attempt < CHANGE_STATE_INDEX_MAX_RETRIES; attempt += 1) {
      const current = await this.mcp.callTool<CheckpointRecallResult>(RECALL_TOOL, {
        key: indexKey,
        kind: "sdd-change-state-index",
      });
      const index = this.decodeChangeStateIndex(current.content);
      if (index.changeNames.includes(changeName)) return;

      const result = await this.mcp.callTool<CheckpointStoreResult>(STORE_TOOL, {
        key: indexKey,
        content: { changeNames: [...index.changeNames, changeName].sort() },
        kind: "sdd-change-state-index",
        expectedVersion: current.version,
      });
      if (!result.conflict) return;
    }
    throw new Error(`SDD_CHANGE_STATE_INDEX_CONFLICT: unable to add '${changeName}' after concurrent updates.`);
  }

  private decodeChangeStateIndex(content: unknown | null): ChangeStateIndex {
    if (content === null) return { changeNames: [] };
    if (typeof content !== "object" || content === null) {
      throw new Error("SDD_CHANGE_STATE_INDEX_INVALID: durable change index is invalid.");
    }
    const changeNames = (content as Record<string, unknown>).changeNames;
    if (!Array.isArray(changeNames) || !changeNames.every((name) => typeof name === "string")) {
      throw new Error("SDD_CHANGE_STATE_INDEX_INVALID: durable change index is invalid.");
    }
    return { changeNames };
  }
}
