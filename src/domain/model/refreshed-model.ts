/**
 * Lightweight DTO returned by the sync use case and consumed by the
 * notifier. Carries just enough information to render the
 * "connected models" log line; intentionally avoids leaking DB ids
 * or benchmark detail into the notifier.
 */
export interface RefreshedModelEntry {
  readonly providerId: string;
  readonly modelId: string;
  readonly pricingInfo?: string | undefined;
}
