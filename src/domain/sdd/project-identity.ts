/**
 * Project-root canonicalization (SDD Phase Agents design §2, §8.2 row 1).
 *
 * Every SDD MCP tool takes `projectRoot` explicitly and PMC's ambient/last-used
 * project state is never trusted. This module is the single place that turns
 * a caller-supplied path (relative, short-named, mixed-case, symlinked) into
 * a stable identity: an absolute realpath plus a hash derived from it.
 *
 * The hash MUST be identical for every filesystem-equivalent spelling of the
 * same directory (Windows 8.3 short names, drive-letter case, mixed case,
 * symlinks) so that keys namespaced by it (`sdd/{projectRootHash}/...`)
 * never fork into duplicate histories for the same project.
 */

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

export interface CanonicalProjectRoot {
  /** Absolute, symlink-resolved, OS-canonical path — kept readable for records (PI-4). */
  readonly canonicalPath: string;
  /** Stable identity hash, platform-normalized so path-spelling variants collapse (PI-2). */
  readonly projectRootHash: string;
}

/**
 * Resolves a caller-supplied project root (relative, `..`-containing, a
 * Windows short name, differently-cased, or a symlink) to its canonical
 * identity.
 */
export function canonicalizeProjectRoot(rawPath: string): CanonicalProjectRoot {
  const absolute = resolve(rawPath);
  // `realpathSync.native` resolves symlinks (PI-3) and, on Windows, resolves
  // 8.3 short names and normalizes to the filesystem's stored long-name case.
  const canonicalPath = realpathSync.native(absolute);
  const projectRootHash = hashCanonicalPath(canonicalPath);
  return { canonicalPath, projectRootHash };
}

function hashCanonicalPath(canonicalPath: string): string {
  // Windows filesystems are case-insensitive (even though case-preserving),
  // and drive letters may still surface with either case depending on the
  // caller. Fold to lower case before hashing so PI-2's variants collapse
  // to one hash regardless of what case the OS chose to report.
  const normalizedForHash = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
  return createHash("sha256").update(normalizedForHash, "utf8").digest("hex");
}
