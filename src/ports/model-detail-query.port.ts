import type { BenchmarkScores } from "../domain/benchmark/benchmark-scores.js";
import type { PricingSnapshotLike } from "./model-repository.port.js";
import type { QuarantineType } from "../domain/model/quarantine.js";
import type { ProviderMetadata, ModelMetadata } from "../domain/model-detail/metadata.js";

export interface PersistedModelDetail {
  readonly providerId: string;
  readonly providerName: string;
  readonly providerSubscription: string | null;
  readonly providerIsBlocked: boolean;
  readonly providerQuarantineType: QuarantineType | null;
  readonly providerQuarantineUntil: Date | null;
  readonly providerMetadata?: ProviderMetadata;

  readonly modelId: string;
  readonly modelName: string;
  readonly benchmarks: BenchmarkScores | null;
  readonly modelQuarantineType: QuarantineType | null;
  readonly modelQuarantineUntil: Date | null;
  readonly modelMetadata?: ModelMetadata;

  readonly updatedAt?: Date;
  readonly metadataEnvelopeHash?: string | null;

  readonly modelProviderQuarantineType: QuarantineType | null;
  readonly modelProviderQuarantineUntil: Date | null;

  readonly pricing: PricingSnapshotLike | null;
}

export interface ModelDetailQueryPort {
  findModelDetail(providerId: string, modelId: string): Promise<PersistedModelDetail | null>;
}
