/**
 * PMC key-namespace shapes for SDD state (design §2, spec `sdd-status-store`
 * "PMC keys follow the declared namespace shapes").
 *
 * All keys are namespaced by `projectRootHash` (see `project-identity.ts`),
 * never by a human-typed project name, per §8.2 row 1.
 */

/** SS-11: `sdd/{projectRootHash}/{changeName}/{artifact}` */
export function changeArtifactKey(projectRootHash: string, changeName: string, artifact: string): string {
  return `sdd/${projectRootHash}/${changeName}/${artifact}`;
}

/** SS-12: `sdd/{projectRootHash}/specs/{capability}` */
export function consolidatedSpecKey(projectRootHash: string, capability: string): string {
  return `sdd/${projectRootHash}/specs/${capability}`;
}

/** `sdd-init/{projectRootHash}` (design §2, §6) — included for callers building the init key. */
export function initConfigKey(projectRootHash: string): string {
  return `sdd-init/${projectRootHash}`;
}

/** `sdd-health/{projectRootHash}` (design §8.2, spec `sdd-entry-flow`) */
export function sddHealthKey(projectRootHash: string): string {
  return `sdd-health/${projectRootHash}`;
}

/**
 * `sdd-project/{projectRootHash}` (spec `sdd-project-identity`, "records
 * carry the readable path alongside the hash" — PI-4). One fixed record per
 * project identity, holding the readable `canonicalPath` next to the hash
 * that namespaces every other SDD key, so a moved project's history can be
 * located by hash and confirmed by eye rather than silently orphaned.
 */
export function projectRecordKey(projectRootHash: string): string {
  return `sdd-project/${projectRootHash}`;
}

