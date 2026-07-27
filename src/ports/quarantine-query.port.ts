import type { QuarantineEntry, QuarantineTarget } from "../domain/model/quarantine.js";

/**
 * Read-after-write view of a persisted quarantine.
 *
 * Mirrors the columns the use case needs to compare against the requested
 * draft after a write: level/target identifiers, type, until, and the
 * trimmed reason. `findQuarantine` returns `null` when the target has no
 * quarantine row; the use case treats that the same as a verifier failure
 * for the `set` path (do not publish) and as the expected outcome for the
 * `release` path.
 */
export interface PersistedQuarantine {
  readonly level: QuarantineEntry["level"];
  readonly providerId?: string;
  readonly modelId?: string;
  readonly type: QuarantineEntry["type"];
  readonly until: Date | null;
  readonly reason: string | null;
}

/**
 * Read-side port used by the quarantine use cases as an independent
 * readback verifier.
 *
 * Kept SEPARATE from `QuarantineWritePort` so the writer and the verifier
 * can be wired against independent Prisma connections (mirroring the
 * `SaveModelDetailUseCase` writer/verifier split). Adding `findQuarantine`
 * to `QuarantineWritePort` would defeat that independence and would couple
 * every write-side implementation to a read surface it does not own.
 */
export interface QuarantineQueryPort {
  findQuarantine(target: QuarantineTarget): Promise<PersistedQuarantine | null>;
}
