import type { PrismaClient } from "@prisma/client";

import type { ModelData } from "../../domain/model/model.js";
import type { ModelProviderData, UpsertedModelProvider } from "../../domain/model/model-provider.js";
import type { PricingData } from "../../domain/model/pricing.js";
import type { ProviderData } from "../../domain/model/provider.js";
import { BENCHMARK_FIELDS } from "../../domain/benchmark/benchmark-scores.js";
import type {
  ModelRepositoryPort,
  PricingSnapshotLike,
} from "../../ports/model-repository.port.js";
import type {
  ModelDetailQueryPort,
  PersistedModelDetail,
} from "../../ports/model-detail-query.port.js";
import type {
  ModelDetailWritePort,
  SaveModelDetailCommand,
} from "../../ports/model-detail-write.port.js";
import {
  parseProviderMetadata,
  serializeProviderMetadata,
  parseModelMetadata,
  serializeModelMetadata,
  computeEnvelopeHash,
} from "../../domain/model-detail/metadata.js";
import type { RefreshTraceContext } from "../../ports/model-catalog.port.js";
import type { ModelRefreshTraceLogger } from "../logging/model-refresh-trace.logger.js";
import type { QuarantineType } from "../../domain/model/quarantine.js";

/**
 * Adapter: implement `ModelRepositoryPort`, `ModelDetailQueryPort`, and `ModelDetailWritePort` against Prisma.
 */
export class PrismaModelRepositoryAdapter
  implements ModelRepositoryPort, ModelDetailQueryPort, ModelDetailWritePort
{
  private readonly trace: ModelRefreshTraceLogger | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    options: { trace?: ModelRefreshTraceLogger } = {},
  ) {
    this.trace = options.trace;
  }

  async saveModelDetail(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date; envelopeHash: string }> {
    const correlationId = this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "detail.save.start",
        status: "start",
        details: { providerId: cmd.providerId, modelId: cmd.modelId },
      });
    }

    try {
      const envelopeHash = computeEnvelopeHash(cmd.provider.metadata, cmd.model.metadata);
      const serializedProviderMeta = serializeProviderMetadata(cmd.provider.metadata);
      const serializedModelMeta = serializeModelMetadata(cmd.model.metadata);
      const now = new Date();

      const result = await this.prisma.$transaction(async (tx) => {
        // Optimistic check on envelope hash if client expected a specific baseline
        if (cmd.expectedEnvelopeHash !== null) {
          const currentProvider = await tx.provider.findUnique({
            where: { id: cmd.providerId },
            select: { metadataEnvelopeHash: true },
          });
          const currentModel = await tx.model.findUnique({
            where: { id: cmd.modelId },
            select: { metadataEnvelopeHash: true },
          });

          // Check if either entity has a different hash
          if (
            (currentProvider?.metadataEnvelopeHash && currentProvider.metadataEnvelopeHash !== cmd.expectedEnvelopeHash) ||
            (currentModel?.metadataEnvelopeHash && currentModel.metadataEnvelopeHash !== cmd.expectedEnvelopeHash)
          ) {
            throw new Error(`Conflict: persistent metadata envelope was modified by another operation.`);
          }
        }

        // 1. Update Provider
        const updatedProvider = await tx.provider.upsert({
          where: { id: cmd.providerId },
          update: {
            name: cmd.provider.name,
            subscription: cmd.provider.subscription,
            isBlocked: cmd.provider.isBlocked,
            metadata: serializedProviderMeta,
            metadataEnvelopeHash: envelopeHash,
            updatedAt: now,
          },
          create: {
            id: cmd.providerId,
            name: cmd.provider.name,
            subscription: cmd.provider.subscription,
            isBlocked: cmd.provider.isBlocked,
            metadata: serializedProviderMeta,
            metadataEnvelopeHash: envelopeHash,
            updatedAt: now,
          },
        });

        // 2. Update Model
        const updatedModel = await tx.model.upsert({
          where: { id: cmd.modelId },
          update: {
            name: cmd.model.name,
            mmlu: cmd.model.benchmarks.mmlu,
            humaneval: cmd.model.benchmarks.humaneval,
            sweBench: cmd.model.benchmarks.sweBench,
            metadata: serializedModelMeta,
            metadataEnvelopeHash: envelopeHash,
            updatedAt: now,
          },
          create: {
            id: cmd.modelId,
            name: cmd.model.name,
            mmlu: cmd.model.benchmarks.mmlu,
            humaneval: cmd.model.benchmarks.humaneval,
            sweBench: cmd.model.benchmarks.sweBench,
            metadata: serializedModelMeta,
            metadataEnvelopeHash: envelopeHash,
            updatedAt: now,
          },
        });

        // 3. Upsert ModelProvider link
        const mp = await tx.modelProvider.upsert({
          where: {
            modelId_providerId: {
              modelId: cmd.modelId,
              providerId: cmd.providerId,
            },
          },
          update: {},
          create: {
            modelId: cmd.modelId,
            providerId: cmd.providerId,
          },
        });

        // 4. Insert Pricing row if pricing details provided
        if (cmd.pricing) {
          // Close prior pricing validity
          await tx.modelProviderPricing.updateMany({
            where: { modelProviderId: mp.id, effectiveUntil: null },
            data: { effectiveUntil: now },
          });

          await tx.modelProviderPricing.create({
            data: {
              modelProviderId: mp.id,
              inputPerMillion: cmd.pricing.inputPerMillion,
              outputPerMillion: cmd.pricing.outputPerMillion,
              cachedPerMillion: cmd.pricing.cachedPerMillion,
              currency: cmd.pricing.currency || 'USD',
              effectiveFrom: now,
            },
          });
        }

        return { updatedAt: now, envelopeHash };
      });

      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "detail.save.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: { providerId: cmd.providerId, modelId: cmd.modelId, envelopeHash },
        });
      }

      return result;
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "detail.save.failure",
          durationMs: Date.now() - startedAt,
          details: { providerId: cmd.providerId, modelId: cmd.modelId },
          error,
        });
      }
      throw error;
    }
  }

  async upsertProvider(input: ProviderData, context: RefreshTraceContext = {}): Promise<void> {
    const correlationId = context.correlationId ?? this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "persistence.start",
        status: "start",
        details: { entity: "provider", id: input.id },
      });
    }
    try {
      await this.prisma.provider.upsert({
        where: { id: input.id },
        update: {
          name: input.name,
          ...setIfDefined("subscription", input.subscription),
          ...setIfDefined("isBlocked", input.isBlocked),
          ...setIfDefined("quarantineType", input.quarantineType),
          ...setIfDefined("quarantineUntil", input.quarantineUntil),
          updatedAt: new Date(),
        },
        create: {
          id: input.id,
          name: input.name,
          subscription: input.subscription ?? null,
          isBlocked: input.isBlocked ?? false,
          quarantineType: input.quarantineType ?? null,
          quarantineUntil: input.quarantineUntil ?? null,
        },
      });
      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "persistence.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: { entity: "provider", id: input.id },
        });
      }
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "persistence.failure",
          durationMs: Date.now() - startedAt,
          details: { entity: "provider", id: input.id },
          error,
        });
      }
      throw error;
    }
  }

  async upsertModel(input: ModelData, context: RefreshTraceContext = {}): Promise<void> {
    const correlationId = context.correlationId ?? this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "persistence.start",
        status: "start",
        details: { entity: "model", id: input.id },
      });
    }
    try {
      const updateBenchmarks = buildBenchmarkUpdate(input.benchmarks);
      const createBenchmarks = buildBenchmarkCreate(input.benchmarks);

      await this.prisma.model.upsert({
        where: { id: input.id },
        update: {
          name: input.name,
          ...updateBenchmarks,
          ...setIfDefined("quarantineType", input.quarantineType),
          ...setIfDefined("quarantineUntil", input.quarantineUntil),
          updatedAt: new Date(),
        },
        create: {
          id: input.id,
          name: input.name,
          ...createBenchmarks,
          quarantineType: input.quarantineType ?? null,
          quarantineUntil: input.quarantineUntil ?? null,
        },
      });
      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "persistence.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: { entity: "model", id: input.id },
        });
      }
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "persistence.failure",
          durationMs: Date.now() - startedAt,
          details: { entity: "model", id: input.id },
          error,
        });
      }
      throw error;
    }
  }

  async upsertModelProvider(
    input: ModelProviderData,
    context: RefreshTraceContext = {},
  ): Promise<UpsertedModelProvider> {
    const correlationId = context.correlationId ?? this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "persistence.start",
        status: "start",
        details: {
          entity: "modelProvider",
          modelId: input.modelId,
          providerId: input.providerId,
        },
      });
    }
    try {
      const mp = await this.prisma.modelProvider.upsert({
        where: {
          modelId_providerId: {
            modelId: input.modelId,
            providerId: input.providerId,
          },
        },
        update: {
          ...setIfDefined("quarantineType", input.quarantineType),
          ...setIfDefined("quarantineUntil", input.quarantineUntil),
        },
        create: {
          modelId: input.modelId,
          providerId: input.providerId,
          quarantineType: input.quarantineType ?? null,
          quarantineUntil: input.quarantineUntil ?? null,
        },
      });
      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "persistence.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: {
            entity: "modelProvider",
            modelId: input.modelId,
            providerId: input.providerId,
          },
        });
      }
      return { id: mp.id };
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "persistence.failure",
          durationMs: Date.now() - startedAt,
          details: {
            entity: "modelProvider",
            modelId: input.modelId,
            providerId: input.providerId,
          },
          error,
        });
      }
      throw error;
    }
  }

  async findLatestPricing(
    modelProviderId: string,
    _context: RefreshTraceContext = {},
  ): Promise<PricingSnapshotLike | null> {
    const latest = await this.prisma.modelProviderPricing.findFirst({
      where: { modelProviderId },
      orderBy: { effectiveFrom: "desc" },
    });
    if (!latest) return null;
    return {
      id: latest.id,
      inputPerMillion: latest.inputPerMillion,
      outputPerMillion: latest.outputPerMillion,
      cachedPerMillion: latest.cachedPerMillion,
      currency: latest.currency,
      effectiveFrom: latest.effectiveFrom,
      effectiveUntil: latest.effectiveUntil,
    };
  }

  async findModelDetail(
    providerId: string,
    modelId: string
  ): Promise<PersistedModelDetail | null> {
    const mp = await this.prisma.modelProvider.findUnique({
      where: {
        modelId_providerId: {
          modelId,
          providerId,
        },
      },
      include: {
        provider: true,
        model: true,
        pricing: {
          orderBy: { effectiveFrom: "desc" },
          take: 1,
        },
      },
    });

    if (!mp) {
      return null;
    }

    const latestPricingRecord = mp.pricing[0];
    const pricing: PricingSnapshotLike | null = latestPricingRecord
      ? {
          id: latestPricingRecord.id,
          inputPerMillion: latestPricingRecord.inputPerMillion,
          outputPerMillion: latestPricingRecord.outputPerMillion,
          cachedPerMillion: latestPricingRecord.cachedPerMillion,
          currency: latestPricingRecord.currency,
          effectiveFrom: latestPricingRecord.effectiveFrom,
          effectiveUntil: latestPricingRecord.effectiveUntil,
        }
      : null;

    return {
      providerId: mp.provider.id,
      providerName: mp.provider.name,
      providerSubscription: mp.provider.subscription,
      providerIsBlocked: mp.provider.isBlocked,
      providerQuarantineType: (mp.provider.quarantineType as QuarantineType) ?? null,
      providerQuarantineUntil: mp.provider.quarantineUntil,
      providerMetadata: parseProviderMetadata(mp.provider.metadata),
      modelId: mp.model.id,
      modelName: mp.model.name,
      benchmarks: {
        mmlu: mp.model.mmlu,
        humaneval: mp.model.humaneval,
        sweBench: mp.model.sweBench,
        gpqa: mp.model.gpqa,
        math: mp.model.math,
        bbh: mp.model.bbh,
        mtBench: mp.model.mtBench,
        multineedle: mp.model.multineedle,
      },
      modelQuarantineType: (mp.model.quarantineType as QuarantineType) ?? null,
      modelQuarantineUntil: mp.model.quarantineUntil,
      modelMetadata: parseModelMetadata(mp.model.metadata),
      updatedAt: mp.model.updatedAt,
      metadataEnvelopeHash: mp.model.metadataEnvelopeHash || mp.provider.metadataEnvelopeHash || null,
      modelProviderQuarantineType: (mp.quarantineType as QuarantineType) ?? null,
      modelProviderQuarantineUntil: mp.quarantineUntil,
      pricing,
    };
  }

  async upsertPricing(input: PricingData, context: RefreshTraceContext = {}): Promise<void> {
    const correlationId = context.correlationId ?? this.trace?.newCorrelationId() ?? "";
    const startedAt = Date.now();
    if (this.trace) {
      this.trace.trace({
        correlationId,
        stage: "persistence.start",
        status: "start",
        details: { entity: "pricing", modelProviderId: input.modelProviderId },
      });
    }
    try {
      // Prisma's update/create input shapes do not accept `undefined`
      // values when `exactOptionalPropertyTypes` is on. Coerce here.
      const data = {
        inputPerMillion: input.inputPerMillion ?? null,
        outputPerMillion: input.outputPerMillion ?? null,
        cachedPerMillion: input.cachedPerMillion ?? null,
        currency: input.currency ?? "USD",
        effectiveUntil: input.effectiveUntil ?? null,
      };

      const latest = await this.findLatestPricing(input.modelProviderId);
      if (latest && latest.effectiveFrom.getTime() === input.effectiveFrom.getTime()) {
        await this.prisma.modelProviderPricing.update({
          where: { id: latest.id },
          data,
        });
        if (this.trace) {
          this.trace.trace({
            correlationId,
            stage: "persistence.finish",
            status: "success",
            durationMs: Date.now() - startedAt,
            details: {
              entity: "pricing",
              modelProviderId: input.modelProviderId,
              mode: "update",
            },
          });
        }
        return;
      }
      await this.prisma.modelProviderPricing.create({
        data: {
          modelProviderId: input.modelProviderId,
          ...data,
          effectiveFrom: input.effectiveFrom,
        },
      });
      if (this.trace) {
        this.trace.trace({
          correlationId,
          stage: "persistence.finish",
          status: "success",
          durationMs: Date.now() - startedAt,
          details: {
            entity: "pricing",
            modelProviderId: input.modelProviderId,
            mode: "create",
          },
        });
      }
    } catch (error) {
      if (this.trace) {
        this.trace.error({
          correlationId,
          stage: "persistence.failure",
          durationMs: Date.now() - startedAt,
          details: { entity: "pricing", modelProviderId: input.modelProviderId },
          error,
        });
      }
      throw error;
    }
  }
}

/**
 * Build a partial update payload for Prisma: include the field only
 * when the caller actually provided a value (undefined = preserve).
 */
function setIfDefined<T>(key: string, value: T | null | undefined): Record<string, T | null> {
  return value === undefined ? {} : { [key]: value };
}

/**
 * Build the benchmark update payload: include only fields explicitly
 * provided in the value object. Omitted keys are left untouched by
 * Prisma's update.
 */
function buildBenchmarkUpdate(
  benchmarks: ModelData["benchmarks"],
): Record<string, number | null> {
  if (!benchmarks) return {};
  const out: Record<string, number | null> = {};
  for (const field of BENCHMARK_FIELDS) {
    const value = benchmarks[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

/**
 * Build the benchmark create payload: every known field must be
 * present in the create payload (Prisma requires all required fields),
 * so undefined values become null.
 */
function buildBenchmarkCreate(
  benchmarks: ModelData["benchmarks"],
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const field of BENCHMARK_FIELDS) {
    const value = benchmarks?.[field];
    out[field] = value === undefined ? null : value;
  }
  return out;
}