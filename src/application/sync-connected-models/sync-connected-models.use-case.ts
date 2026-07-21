import type { ConnectedModelInfo } from "../../domain/model/connected-model.js";
import type { RefreshedModelEntry } from "../../domain/model/refreshed-model.js";
import type {
  ModelCatalogPort,
  ModelRepositoryPort,
} from "../../ports/index.js";
import type {
  SyncConnectedModelsInput,
  SyncConnectedModelsResult,
} from "./sync-connected-models.input.js";

/**
 * Use case: pull the current connected-model list from the SDK and
 * upsert each Provider/Model/ModelProvider/Pricing row into storage,
 * preserving every field the SDK did not mention.
 *
 * Dependencies are injected via constructor (pure DI); the use case
 * itself contains zero infrastructure references.
 */
export class SyncConnectedModelsUseCase {
  constructor(
    private readonly catalog: ModelCatalogPort,
    private readonly repository: ModelRepositoryPort,
  ) {}

  async execute(input: SyncConnectedModelsInput = {}): Promise<SyncConnectedModelsResult> {
    const connected = await this.catalog.getConnectedModels(input);
    const refreshed: RefreshedModelEntry[] = [];

    for (const entry of connected) {
      const mp = await this.syncOne(entry, input);
      refreshed.push(mp);
    }

    return { refreshed };
  }

  private async syncOne(
    entry: ConnectedModelInfo,
    context: SyncConnectedModelsInput,
  ): Promise<RefreshedModelEntry> {
    // Provider snapshot
    await this.repository.upsertProvider({
      id: entry.providerId,
      name: entry.providerId,
      subscription: entry.provider?.subscription,
      isBlocked: entry.provider?.isBlocked,
      quarantineType: entry.provider?.quarantineType,
      quarantineUntil: entry.provider?.quarantineUntil,
    }, context);

    // Model snapshot
    await this.repository.upsertModel({
      id: entry.modelId,
      name: entry.modelName,
      benchmarks: entry.model?.benchmarks,
      quarantineType: entry.model?.quarantineType,
      quarantineUntil: entry.model?.quarantineUntil,
    }, context);

    // ModelProvider link
    const link = await this.repository.upsertModelProvider({
      modelId: entry.modelId,
      providerId: entry.providerId,
      quarantineType: entry.modelProviderQuarantineType,
      quarantineUntil: entry.modelProviderQuarantineUntil,
    }, context);

    // Pricing (only when the SDK mentioned any pricing-related field)
    const pricingString = await this.syncPricing(entry, link.id, context);

    return {
      providerId: entry.providerId,
      modelId: entry.modelId,
      pricingInfo: pricingString,
    };
  }

  private async syncPricing(
    entry: ConnectedModelInfo,
    modelProviderId: string,
    context: SyncConnectedModelsInput,
  ): Promise<string | undefined> {
    const snapshot = entry.pricing;
    if (snapshot === undefined) return undefined;

    const latest = await this.repository.findLatestPricing(modelProviderId, context);

    const inputPerMillion = pickValue<number>(
      snapshot.inputPerMillion,
      latest?.inputPerMillion ?? null,
    );
    const outputPerMillion = pickValue<number>(
      snapshot.outputPerMillion,
      latest?.outputPerMillion ?? null,
    );
    const cachedPerMillion = pickValue<number>(
      snapshot.cachedPerMillion,
      latest?.cachedPerMillion ?? null,
    );
    const currency = pickValue<string>(
      snapshot.currency,
      latest?.currency ?? null,
    ) ?? "USD";
    const effectiveFrom =
      snapshot.effectiveFrom instanceof Date
        ? snapshot.effectiveFrom
        : latest
          ? latest.effectiveFrom
          : new Date();
    const effectiveUntil = pickValue<Date>(
      snapshot.effectiveUntil,
      latest?.effectiveUntil ?? null,
    );

    await this.repository.upsertPricing({
      modelProviderId,
      inputPerMillion,
      outputPerMillion,
      cachedPerMillion,
      currency,
      effectiveFrom,
      effectiveUntil,
    }, context);

    return (
      `Pricing: input=$${formatNumber(inputPerMillion)}/M, ` +
      `output=$${formatNumber(outputPerMillion)}/M, ` +
      `cached=$${formatNumber(cachedPerMillion)}/M (${currency})`
    );
  }
}

/**
 * Resolve the effective value for a pricing field:
 * - If the snapshot has a non-undefined value, use it (null is a
 *   legitimate "explicitly cleared" signal).
 * - Otherwise, if there is a stored latest value, carry it forward.
 * - Otherwise, the field stays null.
 */
function pickValue<T>(
  snapshotValue: T | null | undefined,
  latestValue: T | null,
): T | null {
  if (snapshotValue !== undefined) return snapshotValue;
  return latestValue;
}

function formatNumber(value: number | null): string {
  return value === null ? "null" : String(value);
}
