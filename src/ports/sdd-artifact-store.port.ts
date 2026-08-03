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
}
