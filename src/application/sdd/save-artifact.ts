/**
 * `sdd_save_artifact` write-then-read-back durability check (SS-9, design §2,
 * §8.2 row 3). Read-back proves the bytes landed; it does not prove
 * correctness or protect against a concurrent writer.
 *
 * Also releases the dispatch lock (DL-4, design §4/§9.12): completion of
 * `sdd_save_artifact` always clears `inFlightPhase`, so the next
 * `sdd_compose_phase_prompt` can acquire it.
 *
 * NOTE (WU1/WU4 scope): this is the read-back-verification primitive plus the
 * lock-release wiring only. The `unexpectedWrites` worktree-fingerprint
 * comparison described in design §2/§7.2 belongs to WU8 and is intentionally
 * not implemented here.
 */

import type { SddArtifactStorePort } from "../../ports/sdd-artifact-store.port.js";
import {
  compareWorktreeFingerprints,
  isPhaseMutating,
  type WorktreeFingerprint,
} from "../../domain/sdd/worktree-fingerprint.js";
import { clearDispatchLock } from "./dispatch-lock.js";

export interface SaveArtifactOptions {
  readonly phase?: string;
  readonly baselineFingerprint?: WorktreeFingerprint;
  readonly currentFingerprint?: WorktreeFingerprint;
  readonly mutating?: boolean;
}

export interface SaveArtifactResult {
  readonly ok: boolean;
  readonly inFlightPhase: null;
  readonly unexpectedWrites?: boolean;
}

export async function saveArtifact(
  store: SddArtifactStorePort,
  key: string,
  content: string,
  currentInFlightPhase: string | null = null,
  options?: SaveArtifactOptions,
): Promise<SaveArtifactResult> {
  await store.writeArtifact(key, content);
  const readBack = await store.readArtifact(key);

  let unexpectedWrites: boolean | undefined = undefined;
  if (options?.baselineFingerprint && options?.currentFingerprint) {
    const mutating = options.mutating ?? (options.phase ? isPhaseMutating(options.phase) : false);
    const comparison = compareWorktreeFingerprints(options.baselineFingerprint, options.currentFingerprint, mutating);
    if (comparison.unexpectedWrites) {
      unexpectedWrites = true;
    }
  }

  return {
    ok: readBack === content,
    inFlightPhase: clearDispatchLock("completed"),
    ...(unexpectedWrites ? { unexpectedWrites: true } : {}),
  };
}
