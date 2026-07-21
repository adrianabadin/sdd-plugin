import type { ModelDetailWritePort, SaveModelDetailCommand } from '../../ports/model-detail-write.port.js';
import type { ModelConfigRegistry, EffectiveModelConfig } from '../../infrastructure/runtime/model-config-registry.js';
import { validateDraft } from '../../domain/model-detail/detail-validation.js';
import { type ProviderMetadata, type ModelMetadata, computeEnvelopeHash } from '../../domain/model-detail/metadata.js';
import type { DetailDraft } from '../../tui/model-detail-view.js';

export interface SaveModelDetailInput {
  providerId: string;
  modelId: string;
  providerName: string;
  modelName: string;
  isBlocked: boolean;
  subscription: string | null;
  planName: string | null;
  periodicCost: number | null;
  includedUsage: number | null;
  overageRate: number | null;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  capabilities: string[];
  benchmarks: {
    mmlu: number | null;
    humaneval: number | null;
    sweBench: number | null;
  };
  pricing: {
    inputPerMillion: number | null;
    outputPerMillion: number | null;
    cachedPerMillion: number | null;
    currency: string;
  } | null;
  expectedEnvelopeHash: string | null;
}

export interface SaveModelDetailResult {
  success: boolean;
  updatedAt: Date;
  envelopeHash: string;
  warning?: string;
}

export class SaveModelDetailUseCase {
  constructor(
    private writePort: ModelDetailWritePort,
    private registry: ModelConfigRegistry,
  ) {}

  async execute(input: SaveModelDetailInput): Promise<SaveModelDetailResult> {
    // 1. Domain revalidation
    const draft: DetailDraft = {
      providerId: input.providerId,
      modelId: input.modelId,
      providerName: input.providerName,
      modelName: input.modelName,
      isBlocked: input.isBlocked,
      subscriptionTier: input.subscription,
      subscription: input.subscription,
      subscriptionEnabled: Boolean(input.subscription),
      planName: input.planName,
      periodicCost: input.periodicCost,
      includedUsage: input.includedUsage,
      overageRate: input.overageRate,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      capabilities: {
        vision: input.capabilities.includes("vision"),
        tools: input.capabilities.includes("tools"),
        reasoning: input.capabilities.includes("reasoning"),
      },
      benchmarks: {
        mmlu: input.benchmarks.mmlu,
        humaneval: input.benchmarks.humaneval,
        sweBench: input.benchmarks.sweBench,
        gpqa: null,
        math: null,
        bbh: null,
        mtBench: null,
        multineedle: null,
      },
      inputPerMillion: input.pricing?.inputPerMillion ?? null,
      outputPerMillion: input.pricing?.outputPerMillion ?? null,
      cachedPerMillion: input.pricing?.cachedPerMillion ?? null,
      currency: input.pricing?.currency ?? 'USD',
    };

    const validation = validateDraft(draft);
    if (!validation.isValid) {
      const errMap = validation.errors ?? {};
      const firstErr = Object.values(errMap).find(Boolean) ?? validation.errorSummary ?? "invalid";
      throw new Error(`Validation failed: ${firstErr}`);
    }

    const providerMetadata: ProviderMetadata = {
      version: 1,
      planName: input.planName,
      periodicCost: input.periodicCost,
      includedUsage: input.includedUsage,
      overageRate: input.overageRate,
    };

    const modelMetadata: ModelMetadata = {
      version: 1,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      capabilities: input.capabilities,
    };

    const command: SaveModelDetailCommand = {
      providerId: input.providerId,
      modelId: input.modelId,
      provider: {
        name: input.providerName,
        isBlocked: input.isBlocked,
        subscription: input.subscription,
        metadata: providerMetadata,
      },
      model: {
        name: input.modelName,
        benchmarks: input.benchmarks,
        metadata: modelMetadata,
      },
      pricing: input.pricing,
      expectedEnvelopeHash: input.expectedEnvelopeHash,
    };

    // 2. Transactional persistence
    const saveResult = await this.writePort.saveModelDetail(command);

    // 3. Publish to process-wide runtime registry
    const effectiveConfig: EffectiveModelConfig = {
      providerId: input.providerId,
      modelId: input.modelId,
      contextWindow: input.contextWindow,
      maxOutputTokens: input.maxOutputTokens,
      capabilities: input.capabilities,
      inputPerMillion: input.pricing?.inputPerMillion ?? null,
      outputPerMillion: input.pricing?.outputPerMillion ?? null,
      cachedPerMillion: input.pricing?.cachedPerMillion ?? null,
      currency: input.pricing?.currency ?? 'USD',
      isBlocked: input.isBlocked,
      subscription: input.subscription,
      metadataEnvelopeHash: saveResult.envelopeHash,
    };

    let warning: string | undefined;
    try {
      this.registry.publish(effectiveConfig);
    } catch (err) {
      warning = 'Saved to database, but live runtime application failed.';
    }

    return {
      success: true,
      updatedAt: saveResult.updatedAt,
      envelopeHash: saveResult.envelopeHash,
      ...(warning ? { warning } : {}),
    };
  }
}
