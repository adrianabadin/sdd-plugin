/**
 * SDD Checkpoint application capability (WU9, tasks CP-1..CP-17).
 * Mid-phase resumability and progress tracking for apply and verify phases.
 *
 * See docs/superpowers/specs/2026-08-02-sdd-phase-agents-SPEC.md capability `sdd-checkpoint`.
 *
 * Optimistic concurrency (design §9.12, CP-16/CP-17): the durable write path
 * reads a record WITH its version, recomputes, and writes back supplying
 * that version as `expectedVersion`. The store rejects if the version on
 * disk changed (a concurrent writer landed first); the loop re-reads and
 * recomputes once, then surfaces `CheckpointConcurrencyError`. This is the
 * exact "read with version, write conditional on version unchanged" contract
 * the design names — a concurrent writer can never clobber silently.
 *
 * Read-back durability (design §2, §8.2 row 3, SS-10): every write path
 * re-reads what it just wrote and rejects if the bytes did not land. The
 * earlier implementation only verified read-back from a single test-only
 * helper; the four real writers (declareBatch, recordCompletion,
 * blockMidBatch, resumeBatch) now all pass through the same durable
 * write+verify primitive.
 */

import { isDeepStrictEqual } from "node:util";

import { changeArtifactKey } from "../../domain/sdd/sdd-keys.js";
import type { BlockedOn, Checkpoints, PhaseCheckpoint } from "../../domain/sdd/status.js";
import type {
  CheckpointRecord,
  SddArtifactStorePort,
} from "../../ports/sdd-artifact-store.port.js";
import type { SemanticGatewayPort } from "./semantic-gateway.js";

export class InvalidCheckpointPhaseError extends Error {
  readonly phase: string;
  constructor(phase: string) {
    super(`Checkpoint operation refused: phase '${phase}' is not 'apply' or 'verify'.`);
    this.name = "InvalidCheckpointPhaseError";
    this.phase = phase;
  }
}

export class CheckpointConcurrencyError extends Error {
  constructor(message = "Concurrent write conflict on checkpoint record after retry.") {
    super(message);
    this.name = "CheckpointConcurrencyError";
  }
}

/**
 * Raised when a checkpoint write's read-back does not match the bytes
 * written — the store accepted the write but it did not durably land (SS-10).
 */
export class CheckpointReadbackMismatchError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`Checkpoint '${key}' read-back did not match the bytes written; the write did not durably land.`);
    this.name = "CheckpointReadbackMismatchError";
    this.key = key;
  }
}

export interface CheckpointResult {
  readonly ok: boolean;
}

export interface StoredCheckpointData {
  checkpoints: Checkpoints;
  blockedOn?: BlockedOn;
}

export function defaultCheckpoints(): Checkpoints {
  return {
    apply: { completedIds: [], attemptCounts: {}, currentBatch: null },
    verify: { completedIds: [], attemptCounts: {}, currentBatch: null },
  };
}

function validatePhase(phase: string): "apply" | "verify" {
  if (phase !== "apply" && phase !== "verify") {
    throw new InvalidCheckpointPhaseError(phase);
  }
  return phase;
}

/**
 * Parses a raw checkpoint record (as read from the store) into the
 * `StoredCheckpointData` shape, defaulting any missing sub-fields so callers
 * never see a partial `PhaseCheckpoint`.
 */
function parseCheckpointRecord(raw: CheckpointRecord | null): StoredCheckpointData {
  if (!raw || !raw.content || typeof raw.content !== "object") {
    return { checkpoints: defaultCheckpoints() };
  }
  const obj = raw.content as Record<string, unknown>;
  const checkpointsObj = (obj.checkpoints && typeof obj.checkpoints === "object" ? obj.checkpoints : obj) as Record<string, unknown>;
  const apply = (checkpointsObj.apply as PhaseCheckpoint) ?? defaultCheckpoints().apply;
  const verify = (checkpointsObj.verify as PhaseCheckpoint) ?? defaultCheckpoints().verify;
  const checkpoints: Checkpoints = {
    apply: {
      completedIds: apply.completedIds ?? [],
      attemptCounts: apply.attemptCounts ?? {},
      currentBatch: apply.currentBatch ?? null,
    },
    verify: {
      completedIds: verify.completedIds ?? [],
      attemptCounts: verify.attemptCounts ?? {},
      currentBatch: verify.currentBatch ?? null,
    },
  };
  const blockedOn = (obj.blockedOn as BlockedOn) ?? undefined;
  return { checkpoints, ...(blockedOn ? { blockedOn } : {}) };
}

/** Reads the full Checkpoints structure (plus optional blockedOn) for a change */
export async function readCheckpointData(
  store: SddArtifactStorePort,
  projectRootHash: string,
  changeName: string,
): Promise<StoredCheckpointData> {
  const key = changeArtifactKey(projectRootHash, changeName, "checkpoints");
  const raw = await store.readCheckpoint(key);
  return parseCheckpointRecord(raw);
}

export async function readCheckpoints(
  store: SddArtifactStorePort,
  projectRootHash: string,
  changeName: string,
): Promise<Checkpoints> {
  const data = await readCheckpointData(store, projectRootHash, changeName);
  return data.checkpoints;
}

/**
 * Basic read-back verification primitive (SS-10). Accepts opaque checkpoint content.
 * Used directly by tests and by paths that need a one-shot durability check
 * without optimistic concurrency.
 */
export async function saveCheckpoint(
  store: SddArtifactStorePort,
  key: string,
  content: unknown,
): Promise<CheckpointResult> {
  await store.writeCheckpoint(key, content);
  const readBack = await store.readCheckpoint(key);
  return { ok: isDeepStrictEqual(readBack?.content ?? null, content) };
}

/**
 * Writes a `StoredCheckpointData` payload to the store, then reads it back
 * to confirm the bytes landed (SS-10). Throws
 * `CheckpointReadbackMismatchError` if the read-back does not match.
 *
 * `expectedVersion` (when supplied) is forwarded to the store as the
 * optimistic-concurrency gate; the store rejects with
 * `CheckpointConcurrencyError` on a version mismatch.
 */
async function writeAndVerifyCheckpoint(
  store: SddArtifactStorePort,
  key: string,
  payload: StoredCheckpointData,
  expectedVersion?: number,
): Promise<{ checkpoints: Checkpoints; version: number }> {
  const { version } = await store.writeCheckpoint(key, payload, expectedVersion);
  const readBack = await store.readCheckpoint(key);
  if (!readBack || !isDeepStrictEqual(readBack.content, payload)) {
    throw new CheckpointReadbackMismatchError(key);
  }
  return { checkpoints: payload.checkpoints, version };
}

/**
 * Writes checkpoint data with optimistic concurrency retry (CP-16, CP-17).
 * Reads the current record WITH its version, recomputes, writes back
 * supplying that version as `expectedVersion`. On a version-conflict reject
 * (a concurrent writer landed first), re-reads and recomputes once more;
 * a second conflict raises `CheckpointConcurrencyError`. The write is
 * always followed by a read-back durability check (SS-10).
 */
export async function writeCheckpointsDurable(
  store: SddArtifactStorePort,
  projectRootHash: string,
  changeName: string,
  updateFn: (current: Checkpoints, currentBlockedOn?: BlockedOn) => Checkpoints | StoredCheckpointData,
): Promise<Checkpoints> {
  const key = changeArtifactKey(projectRootHash, changeName, "checkpoints");

  for (let attempt = 1; attempt <= 2; attempt++) {
    const currentRecord = await store.readCheckpoint(key);
    const currentData = parseCheckpointRecord(currentRecord);
    const expectedVersion = currentRecord?.version ?? 0;

    const updated = updateFn(
      JSON.parse(JSON.stringify(currentData.checkpoints)),
      currentData.blockedOn ? JSON.parse(JSON.stringify(currentData.blockedOn)) : undefined,
    );

    let payload: StoredCheckpointData;
    if ("checkpoints" in updated) {
      payload = updated as StoredCheckpointData;
    } else {
      payload = {
        checkpoints: updated as Checkpoints,
        ...(currentData.blockedOn ? { blockedOn: currentData.blockedOn } : {}),
      };
    }

    try {
      const result = await writeAndVerifyCheckpoint(store, key, payload, expectedVersion);
      return result.checkpoints;
    } catch (err) {
      if (err instanceof CheckpointConcurrencyError) {
        if (attempt === 2) {
          throw new CheckpointConcurrencyError(
            `Concurrent write conflict on checkpoint for '${changeName}' persisted after retry.`,
          );
        }
        continue; // re-read and recompute with the now-current version
      }
      throw err; // read-back mismatch or storage error — not retryable as an OCC conflict
    }
  }
  throw new CheckpointConcurrencyError();
}

export interface DeclareBatchInput {
  store: SddArtifactStorePort;
  projectRootHash: string;
  changeName: string;
  phase: "apply" | "verify";
  totalIds: readonly string[];
  batchId?: string;
}

/** Declares a batch for apply or verify (CP-1, CP-2, CP-3, CP-4, CP-8, CP-9) */
export async function declareBatch(input: DeclareBatchInput): Promise<Checkpoints> {
  const phase = validatePhase(input.phase);

  return writeCheckpointsDurable(input.store, input.projectRootHash, input.changeName, (checkpoints) => {
    const pc = checkpoints[phase];
    const completedSet = new Set(pc.completedIds);

    // CP-8 & CP-9: Increment attempt count only for incomplete ids
    const attemptCounts = { ...pc.attemptCounts };
    for (const id of input.totalIds) {
      if (!completedSet.has(id)) {
        attemptCounts[id] = (attemptCounts[id] ?? 0) + 1;
      }
    }

    // CP-2 & CP-4: Replace currentBatch, preserve completedIds
    const remainingIds = input.totalIds.filter((id) => !completedSet.has(id));
    const batchId = input.batchId ?? `batch-${Date.now()}`;

    checkpoints[phase] = {
      completedIds: pc.completedIds,
      attemptCounts,
      currentBatch: {
        batchId,
        totalIds: [...input.totalIds],
        remainingIds,
        batchNotes: "",
      },
    };

    return checkpoints;
  });
}

export interface RecordCompletionInput {
  store: SddArtifactStorePort;
  projectRootHash: string;
  changeName: string;
  phase: "apply" | "verify";
  completedId: string;
  note?: string;
  semanticGateway?: SemanticGatewayPort;
}

/** Records completion of a single scenario id (CP-5, CP-6, CP-7, CP-12, CP-13) */
export async function recordCompletion(input: RecordCompletionInput): Promise<Checkpoints> {
  const phase = validatePhase(input.phase);

  // CP-12: batchNotes are distilled by the semantic gateway. When no gateway
  // is injected the raw executor note is NOT accumulated — storing the raw
  // note would contradict CP-12 (which says batchNotes is the distilled form)
  // and leak executor prose into a field meant for short, distilled deltas.
  let distilledNote = "";
  if (input.note && input.note.trim().length > 0 && input.semanticGateway) {
    distilledNote = await input.semanticGateway.distill(input.note);
  }

  return writeCheckpointsDurable(input.store, input.projectRootHash, input.changeName, (checkpoints) => {
    const pc = checkpoints[phase];

    // CP-5 & CP-6: Add to completedIds idempotently
    const completedIds = pc.completedIds.includes(input.completedId)
      ? pc.completedIds
      : [...pc.completedIds, input.completedId];

    // CP-5: Drop from remainingIds
    let currentBatch = pc.currentBatch;
    if (currentBatch) {
      const remainingIds = currentBatch.remainingIds.filter((id) => id !== input.completedId);
      let batchNotes = currentBatch.batchNotes;
      if (distilledNote) {
        batchNotes = batchNotes ? `${batchNotes}\n${distilledNote}` : distilledNote;
      }
      currentBatch = {
        ...currentBatch,
        remainingIds,
        batchNotes,
      };
    }

    checkpoints[phase] = {
      ...pc,
      completedIds,
      currentBatch,
    };

    return checkpoints;
  });
}

export interface BlockMidBatchInput {
  store: SddArtifactStorePort;
  projectRootHash: string;
  changeName: string;
  phase: "apply" | "verify";
  question: string;
  progressSummary: string;
  /** CP-15: the item the batch was working on when it blocked, so resume can put it first. */
  blockedItemId?: string;
}

export interface BlockedCheckpointsResult {
  checkpoints: Checkpoints;
  blockedOn: BlockedOn;
}

/** Blocks execution mid-batch on user input (CP-14) */
export async function blockMidBatch(input: BlockMidBatchInput): Promise<BlockedCheckpointsResult> {
  const phase = validatePhase(input.phase);
  const blockedOn: BlockedOn = {
    phase,
    question: input.question,
    progressSummary: input.progressSummary,
    ...(input.blockedItemId !== undefined ? { blockedItemId: input.blockedItemId } : {}),
  };

  // Goes through writeCheckpointsDurable for OCC + read-back, same as the
  // other mutating paths — earlier this wrote directly and skipped both.
  const checkpoints = await writeCheckpointsDurable(
    input.store,
    input.projectRootHash,
    input.changeName,
    (current, _currentBlockedOn) => ({ checkpoints: current, blockedOn }),
  );

  return { checkpoints, blockedOn };
}

export interface ResumeBatchInput {
  store: SddArtifactStorePort;
  projectRootHash: string;
  changeName: string;
  phase: "apply" | "verify";
  answer: string;
}

export interface ResumedCheckpointsResult {
  checkpoints: Checkpoints;
  blockedOn?: undefined;
}

/** Resumes a blocked batch with answer (CP-15) */
export async function resumeBatch(input: ResumeBatchInput): Promise<ResumedCheckpointsResult> {
  const phase = validatePhase(input.phase);

  const checkpoints = await writeCheckpointsDurable(
    input.store,
    input.projectRootHash,
    input.changeName,
    (currentCheckpoints, currentBlockedOn) => {
      const pc = currentCheckpoints[phase];

      if (pc.currentBatch && input.answer) {
        const addedNote = `Answer: ${input.answer}`;
        const batchNotes = pc.currentBatch.batchNotes ? `${pc.currentBatch.batchNotes}\n${addedNote}` : addedNote;

        // CP-15: "starting with the item that was blocked" — if the block
        // recorded which item it was working on, move that item to the front
        // of remainingIds so the resumed batch picks up exactly where it left off.
        let remainingIds = [...pc.currentBatch.remainingIds];
        const blockedItemId = currentBlockedOn?.blockedItemId;
        if (blockedItemId && remainingIds.includes(blockedItemId)) {
          remainingIds = [blockedItemId, ...remainingIds.filter((id) => id !== blockedItemId)];
        }

        pc.currentBatch = {
          ...pc.currentBatch,
          remainingIds,
          batchNotes,
        };
      }

      const payload: StoredCheckpointData = { checkpoints: currentCheckpoints };
      return payload;
    },
  );

  return { checkpoints };
}
