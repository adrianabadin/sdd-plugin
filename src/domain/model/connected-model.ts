import type { QuarantineType } from "./quarantine.js";

/**
 * Normalized snapshot of a Provider as exposed by an upstream SDK.
 *
 * Every field is optional because real SDKs return sparse objects:
 * a model may carry provider-level subscription but no provider-level
 * quarantine. The use case is responsible for translating this into
 * a ProviderData write with explicit undefined-vs-null semantics.
 */
export interface ProviderSnapshot {
  readonly subscription?: string | null | undefined;
  readonly isBlocked?: boolean | null | undefined;
  readonly quarantineType?: QuarantineType | null | undefined;
  readonly quarantineUntil?: Date | null | undefined;
}

/**
 * Normalized snapshot of a Model as exposed by an upstream SDK.
 */
export interface ModelSnapshot {
  readonly benchmarks?: {
    readonly mmlu?: number | null | undefined;
    readonly humaneval?: number | null | undefined;
    readonly sweBench?: number | null | undefined;
    readonly gpqa?: number | null | undefined;
    readonly math?: number | null | undefined;
    readonly bbh?: number | null | undefined;
    readonly mtBench?: number | null | undefined;
    readonly multineedle?: number | null | undefined;
  } | undefined;
  readonly quarantineType?: QuarantineType | null | undefined;
  readonly quarantineUntil?: Date | null | undefined;
}

/**
 * Normalized snapshot of Pricing as exposed by an upstream SDK.
 *
 * `effectiveFrom` defaults to "now" inside the SDK adapter so the
 * use case always receives a Date if any pricing field was provided.
 */
export interface PricingSnapshot {
  readonly inputPerMillion?: number | null | undefined;
  readonly outputPerMillion?: number | null | undefined;
  readonly cachedPerMillion?: number | null | undefined;
  readonly currency?: string | null | undefined;
  readonly effectiveFrom?: Date | null | undefined;
  readonly effectiveUntil?: Date | null | undefined;
}

/**
 * A single normalized row from the upstream SDK, already split into
 * provider/model/modelProvider/pricing domains.
 *
 * The SDK adapter is the only layer that knows how to map from the
 * raw SDK shape into this normalized form. After that, the use case
 * works exclusively against domain types and ports.
 */
export interface ConnectedModelInfo {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelName: string;

  readonly provider?: ProviderSnapshot | undefined;
  readonly model?: ModelSnapshot | undefined;

  readonly modelProviderQuarantineType?: QuarantineType | null | undefined;
  readonly modelProviderQuarantineUntil?: Date | null | undefined;

  readonly pricing?: PricingSnapshot | undefined;
}
