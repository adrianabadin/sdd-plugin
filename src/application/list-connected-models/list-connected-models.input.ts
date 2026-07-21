import type { RefreshedModelEntry } from "../../domain/model/refreshed-model.js";
import type { RefreshTraceContext } from "../../ports/model-catalog.port.js";
import type {
  SyncConnectedModelsInput,
  SyncConnectedModelsResult,
} from "../sync-connected-models/sync-connected-models.input.js";

/**
 * Input port for the `ListConnectedModels` use case.
 *
 * The list use case is intentionally separate from the sync use case
 * so the caller can refresh + display independently (e.g. to refresh
 * the visible list from cached data without re-hitting the SDK).
 */
export interface ListConnectedModelsInput extends RefreshTraceContext {
  readonly refreshed: ReadonlyArray<RefreshedModelEntry>;
}

/**
 * Output of the `ListConnectedModels` use case: a summary string and
 * the count, mirroring the shape of the legacy `logger.info(...)` call.
 */
export interface ListConnectedModelsResult {
  readonly count: number;
  readonly summary: string;
}

// Re-export for callers that compose sync → list.
export type { SyncConnectedModelsInput, SyncConnectedModelsResult };
