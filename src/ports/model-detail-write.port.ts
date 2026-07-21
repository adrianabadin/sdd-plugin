import type { ProviderMetadata, ModelMetadata } from '../domain/model-detail/metadata.js';

export interface SaveModelDetailCommand {
  providerId: string;
  modelId: string;
  provider: {
    name: string;
    isBlocked: boolean;
    subscription: string | null;
    metadata: ProviderMetadata;
  };
  model: {
    name: string;
    benchmarks: {
      mmlu: number | null;
      humaneval: number | null;
      sweBench: number | null;
    };
    metadata: ModelMetadata;
  };
  pricing: {
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    cachedPerMillion: number | null;
    currency: string;
  } | null;
  expectedEnvelopeHash: string | null;
}

export interface ModelDetailWritePort {
  saveModelDetail(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date; envelopeHash: string }>;
}
