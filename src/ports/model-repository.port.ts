import type { RefreshTraceContext } from "./model-catalog.port.js";
import type {
  PricingData,
} from "../domain/model/pricing.js";
import type {
  ProviderData,
} from "../domain/model/provider.js";
import type {
  ModelData,
} from "../domain/model/model.js";
import type {
  ModelProviderData,
  UpsertedModelProvider,
} from "../domain/model/model-provider.js";

/**
 * Output port: persist the normalized model/provider/pricing tree.
 *
 * Implementations MUST honor the "preserve missing fields" semantics
 * encoded by the use case:
 * - A field omitted from `ProviderData` / `ModelData` / `ModelProviderData`
 *   must NOT be overwritten in storage.
 * - A field set to `null` MUST overwrite existing data with NULL.
 * - A field set to a value MUST overwrite existing data with that value.
 *
 * Implementations MUST treat `effectiveFrom` as the canonical version
 * key for pricing: if the latest pricing record shares the same
 * effectiveFrom, update it in place; otherwise create a new record.
 */
export interface ModelRepositoryPort {
  upsertProvider(input: ProviderData, context?: RefreshTraceContext): Promise<void>;
  upsertModel(input: ModelData, context?: RefreshTraceContext): Promise<void>;
  upsertModelProvider(
    input: ModelProviderData,
    context?: RefreshTraceContext,
  ): Promise<UpsertedModelProvider>;

  /**
   * Read the most recent pricing record for a given ModelProvider,
   * or null when no pricing exists yet.
   */
  findLatestPricing(
    modelProviderId: string,
    context?: RefreshTraceContext,
  ): Promise<PricingSnapshotLike | null>;

  /**
   * Insert or update a pricing record. Implementations decide
   * insert-vs-update by comparing `effectiveFrom` against the
   * existing latest record (see contract above).
   */
  upsertPricing(input: PricingData, context?: RefreshTraceContext): Promise<void>;
}

/**
 * Minimal view of a stored pricing record used by the use case to
 * carry forward omitted fields and to decide update-vs-insert.
 * Defined here so the domain layer does not need to depend on
 * any persistence types.
 */
export interface PricingSnapshotLike {
  readonly id: string;
  readonly inputPerMillion: number | null;
  readonly outputPerMillion: number | null;
  readonly cachedPerMillion: number | null;
  readonly currency: string | null;
  readonly effectiveFrom: Date;
  readonly effectiveUntil: Date | null;
}
