import type { ModelDetailWritePort, SaveModelDetailCommand } from '../../ports/model-detail-write.port.js';
import type { ModelConfigRegistry, EffectiveModelConfig } from '../../infrastructure/runtime/model-config-registry.js';
import { validateDraft } from '../../domain/model-detail/detail-validation.js';
import { type ProviderMetadata, type ModelMetadata, computeEnvelopeHash } from '../../domain/model-detail/metadata.js';
import type { DetailDraft } from '../../tui/model-detail-view.js';

import type { ModelDetailQueryPort } from '../../ports/model-detail-query.port.js';

/**
 * Typed result of a durable Save.
 *
 * The spec requires the verifier to be the source of truth on whether the
 * committed state agrees with what the caller requested:
 *
 *   - `verified` — the verifier readback matched the write. The runtime
 *     registry MAY publish and the TUI MAY swap its baseline/draft.
 *   - `committed-unverified` — the write committed durably, but the verifier
 *     returned either a mismatch or `null`. The runtime registry MUST NOT
 *     publish and the TUI MUST NOT swap baseline/draft. The result carries
 *     the mismatches (or a guidance string for the null case) plus the
 *     persisted identifiers (envelopeHash, updatedAt) so the caller can
 *     surface a truthful fix-forward warning.
 *
 * Pre-commit failures (validation, conflict) and infrastructure failures
 * (verifier connection lost) still throw — only mismatches/null AFTER a
 * durable commit become the typed outcome.
 */
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
    gpqa: number | null;
    math: number | null;
    bbh: number | null;
    mtBench: number | null;
    multineedle: number | null;
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
  outcome: 'verified' | 'committed-unverified';
  /** Wall-clock timestamp of the durable commit (always present). */
  updatedAt: Date;
  /** Envelope hash the write produced (always present). */
  envelopeHash: string;
  /** Field-level mismatches detected by the verifier (committed-unverified only). */
  mismatches?: string[];
  /** Human-readable fix-forward guidance (committed-unverified only). */
  guidance?: string;
  /** Publish-failure notice on verified outcome (rare; registry.publish threw). */
  warning?: string;
}

export class SaveModelDetailUseCase {
  constructor(
    private writePort: ModelDetailWritePort,
    private registry: ModelConfigRegistry,
    private verifierQueryPort: ModelDetailQueryPort,
  ) {}

  async execute(input: SaveModelDetailInput): Promise<SaveModelDetailResult> {
    // 1. Domain revalidation
    const requiredBenchmarkKeys = ['mmlu', 'humaneval', 'sweBench', 'gpqa', 'math', 'bbh', 'mtBench', 'multineedle'] as const;
    for (const key of requiredBenchmarkKeys) {
      if (!(key in input.benchmarks)) {
        throw new Error(`Validation failed: missing required benchmark field '${key}'`);
      }
    }
    const draft: DetailDraft = {
      providerId: input.providerId,
      modelId: input.modelId,
      providerName: input.providerName,
      modelName: input.modelId === input.modelId ? input.modelName : input.modelName,
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
        gpqa: input.benchmarks.gpqa,
        math: input.benchmarks.math,
        bbh: input.benchmarks.bbh,
        mtBench: input.benchmarks.mtBench,
        multineedle: input.benchmarks.multineedle,
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

    // 2b. Independent Read-After-Write Verification. A durable commit was
    //     already produced; the verifier is the only source of truth on
    //     whether the committed state matches what the caller requested.
    if (!this.verifierQueryPort) {
      throw new Error("Verification failed: Verifier query port is required for durable save.");
    }
    const persisted = await this.verifierQueryPort.findModelDetail(input.providerId, input.modelId);

    // === Helper for numeric equality with null handling ===
    const eqNum = (a: number | null | undefined, b: number | null | undefined) => {
      if (a === null || a === undefined) return b === null || b === undefined;
      if (b === null || b === undefined) return false;
      return Math.abs(a - b) < 0.0001;
    };

    const mismatches: string[] = [];
    if (!persisted) {
      // Null readback after a durable commit: surface as committed-unverified
      // with a guidance string. The caller can decide how to render.
      return {
        outcome: 'committed-unverified',
        updatedAt: saveResult.updatedAt,
        envelopeHash: saveResult.envelopeHash,
        mismatches: [],
        guidance:
          'The save committed durably, but the read-after-write verifier returned no record. Re-run verification, or restore the destination from backup before further edits.',
      };
    }

    if (persisted.providerName !== input.providerName) mismatches.push(`providerName: expected ${input.providerName}, got ${persisted.providerName}`);
    if (persisted.providerIsBlocked !== input.isBlocked) mismatches.push(`isBlocked: expected ${input.isBlocked}, got ${persisted.providerIsBlocked}`);
    if ((persisted.providerSubscription ?? null) !== (input.subscription ?? null)) mismatches.push(`subscription: expected ${input.subscription}, got ${persisted.providerSubscription}`);

    // Provider metadata: the JSON-serialized representation must round-trip.
    const expectedProviderMetaJson = JSON.stringify(providerMetadata);
    if ((persisted.providerMetadata as unknown) === undefined) {
      mismatches.push('providerMetadata: missing in readback');
    } else if (JSON.stringify(persisted.providerMetadata) !== expectedProviderMetaJson) {
      mismatches.push(`providerMetadata: expected ${expectedProviderMetaJson}, got ${JSON.stringify(persisted.providerMetadata)}`);
    }

    if (persisted.modelName !== input.modelName) mismatches.push(`modelName: expected ${input.modelName}, got ${persisted.modelName}`);

    // Model metadata: same round-trip requirement.
    const expectedModelMetaJson = JSON.stringify(modelMetadata);
    if ((persisted.modelMetadata as unknown) === undefined) {
      mismatches.push('modelMetadata: missing in readback');
    } else if (JSON.stringify(persisted.modelMetadata) !== expectedModelMetaJson) {
      mismatches.push(`modelMetadata: expected ${expectedModelMetaJson}, got ${JSON.stringify(persisted.modelMetadata)}`);
    }

    // Envelope hash: must equal the value the write produced.
    if ((persisted.metadataEnvelopeHash ?? null) !== saveResult.envelopeHash) {
      mismatches.push(`envelopeHash: expected ${saveResult.envelopeHash}, got ${persisted.metadataEnvelopeHash ?? '<null>'}`);
    }

    const b = persisted.benchmarks ?? {
      mmlu: null,
      humaneval: null,
      sweBench: null,
      gpqa: null,
      math: null,
      bbh: null,
      mtBench: null,
      multineedle: null,
    };
    if (!eqNum(b.mmlu, input.benchmarks.mmlu)) mismatches.push(`mmlu: expected ${input.benchmarks.mmlu}, got ${b.mmlu}`);
    if (!eqNum(b.humaneval, input.benchmarks.humaneval)) mismatches.push(`humaneval: expected ${input.benchmarks.humaneval}, got ${b.humaneval}`);
    if (!eqNum(b.sweBench, input.benchmarks.sweBench)) mismatches.push(`sweBench: expected ${input.benchmarks.sweBench}, got ${b.sweBench}`);
    if (!eqNum(b.gpqa, input.benchmarks.gpqa)) mismatches.push(`gpqa: expected ${input.benchmarks.gpqa}, got ${b.gpqa}`);
    if (!eqNum(b.math, input.benchmarks.math)) mismatches.push(`math: expected ${input.benchmarks.math}, got ${b.math}`);
    if (!eqNum(b.bbh, input.benchmarks.bbh)) mismatches.push(`bbh: expected ${input.benchmarks.bbh}, got ${b.bbh}`);
    if (!eqNum(b.mtBench, input.benchmarks.mtBench)) mismatches.push(`mtBench: expected ${input.benchmarks.mtBench}, got ${b.mtBench}`);
    if (!eqNum(b.multineedle, input.benchmarks.multineedle)) mismatches.push(`multineedle: expected ${input.benchmarks.multineedle}, got ${b.multineedle}`);

    if (input.pricing) {
      if (!persisted.pricing) {
        mismatches.push(`pricing: expected pricing snapshot, got null`);
      } else {
        if (!eqNum(persisted.pricing.inputPerMillion, input.pricing.inputPerMillion)) mismatches.push(`inputPerMillion: expected ${input.pricing.inputPerMillion}, got ${persisted.pricing.inputPerMillion}`);
        if (!eqNum(persisted.pricing.outputPerMillion, input.pricing.outputPerMillion)) mismatches.push(`outputPerMillion: expected ${input.pricing.outputPerMillion}, got ${persisted.pricing.outputPerMillion}`);
        if (!eqNum(persisted.pricing.cachedPerMillion, input.pricing.cachedPerMillion)) mismatches.push(`cachedPerMillion: expected ${input.pricing.cachedPerMillion}, got ${persisted.pricing.cachedPerMillion}`);
        if (persisted.pricing.currency !== input.pricing.currency) mismatches.push(`currency: expected ${input.pricing.currency}, got ${persisted.pricing.currency}`);
      }
    } else {
      // Pricing null is a first-class input: the durable state must agree
      // by also showing null. A stale active row from a prior save would
      // violate this invariant.
      if (persisted.pricing !== null) {
        mismatches.push(
          `pricing: expected null (close-all semantics), got ${JSON.stringify(persisted.pricing)}`,
        );
      }
    }

    if (mismatches.length > 0) {
      // The save committed durably but the verifier disagrees. Return a
      // typed committed-unverified result with the mismatches so the
      // caller can render a truthful fix-forward warning. We MUST NOT
      // publish to the runtime registry in this branch.
      return {
        outcome: 'committed-unverified',
        updatedAt: saveResult.updatedAt,
        envelopeHash: saveResult.envelopeHash,
        mismatches,
        guidance:
          'The save committed durably, but the read-after-write verifier disagrees with the requested values. Treat the committed state as authoritative; reconcile against the caller\u2019s intent before further edits, and consider restoring from backup.',
      };
    }

    // 3. Publish to process-wide runtime registry (verified only).
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
    } catch {
      warning = 'Saved to database, but live runtime application failed.';
    }

    return {
      outcome: 'verified',
      updatedAt: saveResult.updatedAt,
      envelopeHash: saveResult.envelopeHash,
      ...(warning ? { warning } : {}),
    };
  }
}