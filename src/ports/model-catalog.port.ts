import type { ConnectedModelInfo } from "../domain/model/connected-model.js";

/** Optional metadata shared by every boundary in one refresh cycle. */
export interface RefreshTraceContext {
  readonly correlationId?: string;
}

/**
 * Output port: query the upstream SDK for the models currently
 * connected to the running OpenCode session.
 *
 * The adapter normalizes whatever the SDK returns into the domain
 * `ConnectedModelInfo` shape; the use case never touches SDK types.
 */
export interface ModelCatalogPort {
  getConnectedModels(context?: RefreshTraceContext): Promise<ReadonlyArray<ConnectedModelInfo>>;
}
