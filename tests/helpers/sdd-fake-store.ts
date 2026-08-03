/**
 * Shared in-memory fake for `SddArtifactStorePort`, used across the SDD suites.
 *
 * Models optimistic concurrency the way the real store does: every write
 * bumps a version; a write with `expectedVersion` whose value no longer
 * matches the current version rejects with `CheckpointConcurrencyError`.
 * Toggles (`dropNextArtifactWrite`, `dropNextCheckpointWrite`) simulate a
 * write that claims success but did not persist, so read-back coverage
 * (SS-9/SS-10) can be exercised without a real PMC round-trip.
 *
 * Extracted here because four suites each re-declared a subtly-different
 * copy; a single shared fake keeps the versioning contract consistent.
 */

import { CheckpointConcurrencyError } from "../../src/application/sdd/checkpoint.js";
import type {
  CheckpointRecord,
  CheckpointWriteResult,
  SddArtifactStorePort,
} from "../../src/ports/sdd-artifact-store.port.js";

export class SddFakeStore implements SddArtifactStorePort {
  public artifacts = new Map<string, string>();
  public checkpoints = new Map<string, { content: unknown; version: number }>();
  public nextVersion = 1;
  public dropNextArtifactWrite = false;
  public dropNextCheckpointWrite = false;
  /** Hook invoked at the start of each writeCheckpoint; can mutate state (OCC tests). */
  public onBeforeCheckpointWrite?: () => void;

  async writeArtifact(key: string, content: string): Promise<void> {
    if (this.dropNextArtifactWrite) {
      this.dropNextArtifactWrite = false;
      return;
    }
    this.artifacts.set(key, content);
  }

  async readArtifact(key: string): Promise<string | null> {
    return this.artifacts.get(key) ?? null;
  }

  async writeCheckpoint(key: string, content: unknown, expectedVersion?: number): Promise<CheckpointWriteResult> {
    this.onBeforeCheckpointWrite?.();
    if (this.dropNextCheckpointWrite) {
      this.dropNextCheckpointWrite = false;
      const current = this.checkpoints.get(key);
      return { version: current?.version ?? this.nextVersion };
    }
    const current = this.checkpoints.get(key);
    if (expectedVersion !== undefined && current && current.version !== expectedVersion) {
      throw new CheckpointConcurrencyError(
        `Checkpoint '${key}' version mismatch (expected ${expectedVersion}, found ${current.version}).`,
      );
    }
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content: JSON.parse(JSON.stringify(content)), version });
    return { version };
  }

  async readCheckpoint(key: string): Promise<CheckpointRecord | null> {
    const val = this.checkpoints.get(key);
    return val ? { content: JSON.parse(JSON.stringify(val.content)), version: val.version } : null;
  }

  /** Test helper: simulate a concurrent writer landing a new version of the record. */
  injectConcurrentWrite(key: string, content: unknown): void {
    const version = this.nextVersion++;
    this.checkpoints.set(key, { content: JSON.parse(JSON.stringify(content)), version });
  }
}
