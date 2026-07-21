/**
 * Canonical representation of a Pricing record attached to a ModelProvider.
 *
 * Pricing is point-in-time: a `effectiveFrom` is required and an optional
 * `effectiveUntil` may mark a price as superseded. The use case decides
 * whether to update the latest record or create a new one.
 */
export interface PricingData {
  readonly modelProviderId: string;

  readonly inputPerMillion?: number | null | undefined;
  readonly outputPerMillion?: number | null | undefined;
  readonly cachedPerMillion?: number | null | undefined;
  readonly currency?: string | undefined;

  /**
   * Defaults to `new Date()` in the use case when the source does not
   * provide a value, so the repository always sees a concrete Date.
   */
  readonly effectiveFrom: Date;
  readonly effectiveUntil?: Date | null | undefined;
}
