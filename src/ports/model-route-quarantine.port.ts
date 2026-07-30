/**
 * Read-side port for the deterministic model-routing quarantine adapter.
 *
 * Returns the complete active set of quarantines (provider/model/modelProvider)
 * so the routing gate can reconcile the global quarantine store without
 * touching the write-side surface. Identity-only projection: the port
 * exposes level, target identifiers, type, until, and reason — never
 * benchmark/pricing/subscription columns.
 *
 * Authoritative design: 0695919c-2264-4e0d-a3fb-f7d4190661fc.
 */

import type { QuarantineEntry } from "../domain/model/quarantine.js";

export interface ModelRouteQuarantinePort {
  listActive(now?: Date): Promise<ReadonlyArray<QuarantineEntry>>;
}
