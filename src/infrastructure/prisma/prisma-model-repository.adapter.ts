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
import type { RefreshTraceContext } from "../../ports/model-catalog.port.js";
import type { ModelRefreshTraceLogger } from "../logging/model-refresh-trace.logger.js";

/**
 * Adapter: implement the `ModelRepositoryPort` against Prisma.
 *
 * This module is the ONLY place that imports `@prisma/client`. The
 * domain and use case layers see only port interfaces and domain
 * types.
 *
 * Trace instrumentation: the optional `ModelRefreshTraceLogger`
 * receives `persistence.start` / `persistence.finish` /
 * `persistence.failure` events on every write. When the logger is
 * absent the adapter behaves exactly as before — no I/O, no
 * overhead. Adapters are the only place that may import the trace
 * logger because they are the only layer that knows how a particular
 * persistence sink reports its result counts.
 */
export class PrismaModelRepositoryAdapter implements ModelRepositoryPort {
  private readonly trace: ModelRefreshTraceLogger | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    options: { trace?: ModelRefreshTraceLogger } = {},
  ) {
    this.trace = options.trace;
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