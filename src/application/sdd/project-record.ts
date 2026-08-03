/**
 * PI-4 — records carry the readable canonical path alongside the hash (design
 * §2, §8.2 row 1; spec capability `sdd-project-identity`, "records carry the
 * readable path alongside the hash").
 *
 * `canonicalizeProjectRoot` produces `{ canonicalPath, projectRootHash }` but
 * nothing previously persisted that pairing anywhere — every other SDD key is
 * namespaced ONLY by `projectRootHash` (`sdd/{projectRootHash}/...`), so a
 * project that moved on disk had no way to recover which human-readable path
 * a given hash used to point at. This module is the one fixed record per
 * project identity that closes that gap: write it once (idempotently) at
 * `sdd-project/{projectRootHash}`, read it back to resolve a hash to a
 * readable path.
 */

import { projectRecordKey } from "../../domain/sdd/sdd-keys.js";
import type { CanonicalProjectRoot } from "../../domain/sdd/project-identity.js";
import type { SddArtifactStorePort } from "../../ports/sdd-artifact-store.port.js";

export interface ProjectRecord {
  readonly canonicalPath: string;
  readonly projectRootHash: string;
}

/**
 * Writes (or re-writes, idempotently) the project record for a canonicalized
 * project root. Safe to call on every `projectRoot`-taking tool invocation —
 * the record's shape never changes for a given `projectRootHash`.
 */
export async function registerProjectRoot(
  store: SddArtifactStorePort,
  canonical: CanonicalProjectRoot,
): Promise<void> {
  const record: ProjectRecord = {
    canonicalPath: canonical.canonicalPath,
    projectRootHash: canonical.projectRootHash,
  };
  await store.writeArtifact(projectRecordKey(canonical.projectRootHash), JSON.stringify(record));
}

/**
 * Reads back a previously-registered project record by hash. Returns `null`
 * if no record was ever written for that hash (e.g. a hash typed by hand, or
 * a project that was never resolved through `canonicalizeProjectRoot` +
 * `registerProjectRoot`).
 */
export async function readProjectRecord(
  store: SddArtifactStorePort,
  projectRootHash: string,
): Promise<ProjectRecord | null> {
  const raw = await store.readArtifact(projectRecordKey(projectRootHash));
  if (raw === null) return null;
  const parsed = JSON.parse(raw) as ProjectRecord;
  return parsed;
}
