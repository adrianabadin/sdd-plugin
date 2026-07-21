import type { RefreshedModelEntry } from "../../domain/model/refreshed-model.js";
import type { RefreshTraceContext } from "../../ports/model-catalog.port.js";

/**
 * Input port for the `SyncConnectedModels` use case. Correlation
 * metadata is optional so existing callers retain the same behavior.
 */
export interface SyncConnectedModelsInput extends RefreshTraceContext {}

/**
 * Output of the `SyncConnectedModels` use case: the rows that
 * were upserted, ready to be consumed by the list/notifier use case.
 */
export interface SyncConnectedModelsResult {
  readonly refreshed: ReadonlyArray<RefreshedModelEntry>;
}
