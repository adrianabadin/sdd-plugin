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
import type { QuarantineType, QuarantineEntry, QuarantineTarget } from "../../domain/model/quarantine.js";
import type { QuarantineWritePort, SetQuarantineCommand } from "../../ports/quarantine-write.port.js";
import type { QuarantineQueryPort, PersistedQuarantine } from "../../ports/quarantine-query.port.js";

/**
 * Adapter: implement `ModelRepositoryPort`, `ModelDetailQueryPort`, `ModelDetailWritePort`, `QuarantineWritePort`, and `QuarantineQueryPort` against Prisma.
 */
export class PrismaModelRepositoryAdapter
  implements ModelRepositoryPort, ModelDetailQueryPort, ModelDetailWritePort, QuarantineWritePort, QuarantineQueryPort
{
  private readonly trace: ModelRefreshTraceLogger | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    options: { trace?: ModelRefreshTraceLogger } = {},
  ) {
    this.trace = options.trace;
  }

  /**
   * Bounded in-flight gate for saveModelDetail.
   *
   * If another save is already executing, the second caller awaits the
   * first's completion rather than racing it. Pricing history uses a
   * millisecond `now`, so overlapping transactions would otherwise pile
   * onto the same timestamp and produce a non-deterministic active row.
   *
   * The gate chain is one-deep per instance: sequential calls run in
   * order, never concurrently. This is the simplest contract that
   * preserves determinism; a more elaborate per-model queueing would be
   * overkill for the current call patterns.
   */
  private saveChain: Promise<unknown> = Promise.resolve();

  async saveModelDetail(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date; envelopeHash: string }> {
    const previous = this.saveChain;
    let release: () => void = () => undefined;
    this.saveChain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await this.runSave(cmd);
    } finally {
      release();
    }
  }

  /**
   * Per-instance monotonically-increasing timestamp counter.
   *
   * `effectiveFrom` is stored at millisecond resolution. When many saves
   * arrive in the same millisecond we still need strictly increasing
   * timestamps so the readback's ORDER BY effectiveFrom DESC, id DESC is
   * unambiguous. The counter feeds the `now` value used for both the
   * provider/model `updatedAt` and the pricing row's `effectiveFrom`.
   */
  private monotonicNowMs: number = 0;
  private nextNow(): number {
    const candidate = Date.now();
    this.monotonicNowMs = candidate > this.monotonicNowMs ? candidate : this.monotonicNowMs + 1;
    return this.monotonicNowMs;
  }

  private async runSave(cmd: SaveModelDetailCommand): Promise<{ updatedAt: Date; envelopeHash: string }> {
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
      const now = new Date(this.nextNow());

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
            gpqa: cmd.model.benchmarks.gpqa,
            math: cmd.model.benchmarks.math,
            bbh: cmd.model.benchmarks.bbh,
            mtBench: cmd.model.benchmarks.mtBench,
            multineedle: cmd.model.benchmarks.multineedle,
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
            gpqa: cmd.model.benchmarks.gpqa,
            math: cmd.model.benchmarks.math,
            bbh: cmd.model.benchmarks.bbh,
            mtBench: cmd.model.benchmarks.mtBench,
            multineedle: cmd.model.benchmarks.multineedle,
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

        // 4. Pricing truthfulness.
        //
        // The Save contract must close any active pricing row regardless of
        // whether new pricing data was provided:
        //   - pricing: <obj>   -> close active row, then insert the new row.
        //   - pricing: null    -> close the active row; durable state now has
        //                       no active pricing and registry publish must
        //                       also reflect that (pricing = null).
        //
        // Leaving stale rows active while the runtime reports null would
        // split the save contract, so we always normalize here.
        await tx.modelProviderPricing.updateMany({
          where: { modelProviderId: mp.id, effectiveUntil: null },
          data: { effectiveUntil: now },
        });

        if (cmd.pricing) {
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
        // Latest pricing is the active row (effectiveUntil IS NULL), ordered by
        // effectiveFrom desc with id desc as a stable tiebreaker. The include
        // filter ensures stale rows are never returned to readers.
        pricing: {
          where: { effectiveUntil: null },
          orderBy: [
            { effectiveFrom: "desc" },
            { id: "desc" },
          ],
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

  async setQuarantine(cmd: SetQuarantineCommand): Promise<QuarantineEntry> {
    const until = cmd.type === "ttl" && cmd.until ? cmd.until : null;
    // Persist the trimmed non-empty reason or NULL; the use case is
    // expected to have validated non-emptiness, but we re-trim defensively
    // so a stray whitespace-only value never lands in storage.
    const reason =
      typeof cmd.reason === "string" && cmd.reason.trim().length > 0
        ? cmd.reason.trim()
        : null;
    await this.prisma.$transaction(async (tx) => {
      if (cmd.level === "provider") {
        if (!cmd.providerId) throw new Error("providerId required for provider quarantine");
        await tx.provider.update({
          where: { id: cmd.providerId },
          data: { quarantineType: cmd.type, quarantineUntil: until, quarantineReason: reason },
        });
      } else if (cmd.level === "model") {
        if (!cmd.modelId) throw new Error("modelId required for model quarantine");
        await tx.model.update({
          where: { id: cmd.modelId },
          data: { quarantineType: cmd.type, quarantineUntil: until, quarantineReason: reason },
        });
      } else if (cmd.level === "modelProvider") {
        if (!cmd.providerId || !cmd.modelId)
          throw new Error("providerId and modelId required for connection quarantine");
        await tx.modelProvider.update({
          where: { modelId_providerId: { modelId: cmd.modelId, providerId: cmd.providerId } },
          data: { quarantineType: cmd.type, quarantineUntil: until, quarantineReason: reason },
        });
      }
    });
    const entry: QuarantineEntry = {
      level: cmd.level,
      type: cmd.type,
      until,
      reason,
    };
    if (cmd.providerId !== undefined) entry.providerId = cmd.providerId;
    if (cmd.modelId !== undefined) entry.modelId = cmd.modelId;
    return entry;
  }

  async releaseQuarantine(target: QuarantineTarget): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      if (target.level === "provider") {
        if (!target.providerId) throw new Error("providerId required to release provider quarantine");
        await tx.provider.update({
          where: { id: target.providerId },
          data: { quarantineType: null, quarantineUntil: null, quarantineReason: null },
        });
      } else if (target.level === "model") {
        if (!target.modelId) throw new Error("modelId required to release model quarantine");
        await tx.model.update({
          where: { id: target.modelId },
          data: { quarantineType: null, quarantineUntil: null, quarantineReason: null },
        });
      } else if (target.level === "modelProvider") {
        if (!target.providerId || !target.modelId)
          throw new Error("providerId and modelId required to release connection quarantine");
        await tx.modelProvider.update({
          where: { modelId_providerId: { modelId: target.modelId, providerId: target.providerId } },
          data: { quarantineType: null, quarantineUntil: null, quarantineReason: null },
        });
      }
    });
  }

  async listQuarantines(): Promise<QuarantineEntry[]> {
    const [providers, models, modelProviders] = await Promise.all([
      this.prisma.provider.findMany({
        where: { quarantineType: { not: null } },
      }),
      this.prisma.model.findMany({
        where: { quarantineType: { not: null } },
      }),
      this.prisma.modelProvider.findMany({
        where: { quarantineType: { not: null } },
      }),
    ]);

    const result: QuarantineEntry[] = [];
    for (const p of providers) {
      if (p.quarantineType) {
        result.push({
          level: "provider",
          providerId: p.id,
          type: p.quarantineType as QuarantineType,
          until: p.quarantineUntil,
          reason: p.quarantineReason ?? null,
        });
      }
    }
    for (const m of models) {
      if (m.quarantineType) {
        result.push({
          level: "model",
          modelId: m.id,
          type: m.quarantineType as QuarantineType,
          until: m.quarantineUntil,
          reason: m.quarantineReason ?? null,
        });
      }
    }
    for (const mp of modelProviders) {
      if (mp.quarantineType) {
        result.push({
          level: "modelProvider",
          providerId: mp.providerId,
          modelId: mp.modelId,
          type: mp.quarantineType as QuarantineType,
          until: mp.quarantineUntil,
          reason: mp.quarantineReason ?? null,
        });
      }
    }
    return result;
  }

  /**
   * Independent readback of a single quarantine row by target tuple.
   * Returns `null` when the target has no quarantine row (release already
   * cleared it, or it was never set). The use case treats `null` as a
   * verification failure on the `set` path and as the expected outcome
   * on the `release` path.
   */
  async findQuarantine(target: QuarantineTarget): Promise<PersistedQuarantine | null> {
    if (target.level === "provider") {
      if (!target.providerId) return null;
      const row = await this.prisma.provider.findUnique({
        where: { id: target.providerId },
        select: { id: true, quarantineType: true, quarantineUntil: true, quarantineReason: true },
      });
      if (!row || !row.quarantineType) return null;
      return {
        level: "provider",
        providerId: row.id,
        type: row.quarantineType as QuarantineType,
        until: row.quarantineUntil ?? null,
        reason: row.quarantineReason ?? null,
      };
    }
    if (target.level === "model") {
      if (!target.modelId) return null;
      const row = await this.prisma.model.findUnique({
        where: { id: target.modelId },
        select: { id: true, quarantineType: true, quarantineUntil: true, quarantineReason: true },
      });
      if (!row || !row.quarantineType) return null;
      return {
        level: "model",
        modelId: row.id,
        type: row.quarantineType as QuarantineType,
        until: row.quarantineUntil ?? null,
        reason: row.quarantineReason ?? null,
      };
    }
    // modelProvider
    if (!target.providerId || !target.modelId) return null;
    const row = await this.prisma.modelProvider.findUnique({
      where: { modelId_providerId: { modelId: target.modelId, providerId: target.providerId } },
      select: { providerId: true, modelId: true, quarantineType: true, quarantineUntil: true, quarantineReason: true },
    });
    if (!row || !row.quarantineType) return null;
    return {
      level: "modelProvider",
      providerId: row.providerId,
      modelId: row.modelId,
      type: row.quarantineType as QuarantineType,
      until: row.quarantineUntil ?? null,
      reason: row.quarantineReason ?? null,
    };
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