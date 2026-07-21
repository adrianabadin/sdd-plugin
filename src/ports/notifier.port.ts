import type { RefreshedModelEntry } from "../domain/model/refreshed-model.js";
import type { RefreshTraceContext } from "./model-catalog.port.js";

/**
 * Output port: surface the list of connected models to the user.
 *
 * Implementations may write to OpenCode's `client.app.log`, the
 * system console, or any other sink; the use case does not care.
 */
export interface NotifierPort {
  showModels(
    models: ReadonlyArray<RefreshedModelEntry>,
    context?: RefreshTraceContext,
  ): Promise<void> | void;
}
